import { BaseTool } from './base-tool.js';
import { z } from 'zod';
import { ValidationError } from '../errors/handlers.js';
import { AGGREGATION_LIMITS, calculateTermsSize } from '../utils/aggregation-limits.js';
import { FIELD_CONSTANTS } from '../utils/field-constants.js';
import { StandardResponse } from './types.js';

const MetricFilterSchema = z.object({
  metric: z.enum(['account_count', 'visit_count', 'provider_rating', 'patient_rating', 'avg_call_duration', 'unique_providers', 'unique_patients', 'provider_rating_count', 'patient_rating_count']),
  min: z.number().optional(),
  max: z.number().optional(),
}).refine(
  (data) => {
    return data.min !== undefined || data.max !== undefined;
  },
  {
    message: 'At least one of min or max must be specified for each metric filter',
  }
);

const FindEntitiesByMetricArgsSchema = z.object({
  entityType: z.enum(['group', 'account']).describe('Type of entity to find: "group" to find groups, "account" to find accounts'),
  metric: z.enum(['account_count', 'visit_count', 'provider_rating', 'patient_rating', 'avg_call_duration', 'unique_providers', 'unique_patients', 'provider_rating_count', 'patient_rating_count']).optional().describe('Single metric to filter by (deprecated: use metrics array for multiple filters). Supported: account_count (groups only), visit_count, provider_rating, patient_rating, avg_call_duration, unique_providers, unique_patients, provider_rating_count, patient_rating_count'),
  min: z.number().optional().describe('Minimum value for the metric when using single metric (deprecated: use metrics array)'),
  max: z.number().optional().describe('Maximum value for the metric when using single metric (deprecated: use metrics array)'),
  metrics: z.array(MetricFilterSchema).optional().describe('Array of metric filters. Use this for filtering by multiple metrics simultaneously. Each filter can have min and/or max values.'),
  startDate: z.string().optional().describe('Start date in ISO format (YYYY-MM-DD) or date math (e.g., "now-30d", "now-1y"). Defaults to "now-1y"'),
  endDate: z.string().optional().describe('End date in ISO format (YYYY-MM-DD) or date math (e.g., "now"). Defaults to "now"'),
  subscription: z.enum(['Enterprise', 'Premium', 'FVC', 'BVC', 'Plus']).optional().describe('Optional subscription tier to filter by'),
  group: z.string().optional().describe('Optional group name to filter by (only valid when entityType="account")'),
  limit: z.number().int().min(1).max(500).optional().default(10).describe('Maximum number of results to return (default: 10, max: 500)'),
}).strict().refine(
  (data) => {
    // Either use single metric (for backward compatibility) or metrics array, but not both
    const hasSingleMetric = data.metric !== undefined;
    const hasMetricsArray = data.metrics !== undefined && data.metrics.length > 0;

    if (!hasSingleMetric && !hasMetricsArray) {
      return false;
    }
    if (hasSingleMetric && hasMetricsArray) {
      return false;
    }
    return true;
  },
  {
    message: 'Must specify either metric (single) or metrics (array), but not both',
  }
).refine(
  (data) => {
    // If using single metric, at least one of min/max must be specified
    if (data.metric !== undefined) {
      return data.min !== undefined || data.max !== undefined;
    }
    return true; // Metrics array validation is handled by MetricFilterSchema
  },
  {
    message: 'When using single metric, at least one of min or max must be specified',
  }
).refine(
  (data) => {
    // Validate entityType and metrics compatibility
    const metricsToCheck = data.metrics || (data.metric ? [{ metric: data.metric }] : []);

    for (const metricFilter of metricsToCheck) {
      const metric = metricFilter.metric;
      if (data.entityType === 'group' && metric === 'account_count') {
        continue; // Groups can use account_count
      }
      if (data.entityType === 'account' && metric === 'account_count') {
        return false; // Accounts cannot use account_count
      }
      // All other metrics work for both entityTypes
    }
    return true;
  },
  {
    message: 'Invalid metric for entityType: account_count can only be used with entityType="group". All other metrics work for both entityTypes.',
  }
);

export interface MetricFilter {
  metric: 'account_count' | 'visit_count' | 'provider_rating' | 'patient_rating' | 'avg_call_duration' | 'unique_providers' | 'unique_patients' | 'provider_rating_count' | 'patient_rating_count';
  min?: number;
  max?: number;
}

export type FindEntitiesByMetricArgs = z.infer<typeof FindEntitiesByMetricArgsSchema>;

export interface EntityMetricResult {
  entity: string;
  metric_value: number;
  visit_count?: number;
  account_count?: number;
  provider_rating?: number;
  patient_rating?: number;
  avg_call_duration?: number;
  unique_providers?: number;
  unique_patients?: number;
  provider_rating_count?: number;
  patient_rating_count?: number;
}

export type FindEntitiesByMetricResult = StandardResponse<{
  entityType: string;
  metric: string;
  min?: number;
  max?: number;
  metrics?: MetricFilter[];
  results: EntityMetricResult[];
  total_found: number;
}>;

export class FindEntitiesByMetricTool extends BaseTool<typeof FindEntitiesByMetricArgsSchema, FindEntitiesByMetricResult> {
  constructor(elasticsearch: any, logger: any) {
    super(elasticsearch, logger, 'find_entities_by_metric');
  }

  get schema() {
    return FindEntitiesByMetricArgsSchema;
  }

  protected async run(args: FindEntitiesByMetricArgs): Promise<FindEntitiesByMetricResult> {
    const { startIso: startDateIso, endIso: endDateIso, start: startDate, end: endDate } =
      this.resolveTimeRange(args.startDate, args.endDate, 'now-1y', 'now');

    // Safeguard: cap limit at 500
    const limit = Math.min(args.limit || 500);

    // Normalize to metrics array (for backward compatibility with single metric)
    const metricsToCompute: MetricFilter[] = args.metrics || (args.metric ? [{
      metric: args.metric,
      min: args.min,
      max: args.max,
    }] : []);

    this.logger.info('Finding entities by metric', {
      entityType: args.entityType,
      metricsCount: metricsToCompute.length,
      metrics: metricsToCompute.map(m => m.metric),
      startDate,
      endDate,
      subscription: args.subscription,
      group: args.group,
      limit,
      originalLimit: args.limit,
    });

    const client = this.elasticsearch.getClient();

    const index = FIELD_CONSTANTS.index;
    const timeField = FIELD_CONSTANTS.timeField;
    const testVisitField = FIELD_CONSTANTS.testVisitField;
    const accountField = FIELD_CONSTANTS.accountField;
    const groupField = FIELD_CONSTANTS.groupField;
    const subscriptionField = FIELD_CONSTANTS.subscriptionField;
    const providerField = FIELD_CONSTANTS.providerField;
    const patientField = FIELD_CONSTANTS.patientField;
    const providerRatingField = FIELD_CONSTANTS.providerRatingField;
    const patientRatingField = FIELD_CONSTANTS.patientRatingField;
    const callDurationField = FIELD_CONSTANTS.callDurationField;
    const meetingBasedField = FIELD_CONSTANTS.meetingBasedField;

    const filters: any[] = [
      {
        range: {
          [timeField]: {
            gte: startDate,
            lt: endDate,
          },
        },
      },
      {
        term: {
          [testVisitField]: 'No',
        },
      },
      {
        bool: {
          should: [
            { exists: { field: callDurationField } },
            { term: { [meetingBasedField]: false } },
          ],
          minimum_should_match: 1,
        },
      },
    ];

    if (args.subscription) {
      filters.push({
        term: {
          [subscriptionField]: args.subscription,
        },
      });
    }

    if (args.group) {
      if (args.entityType !== 'account') {
        // This should be caught by BaseTool/Zod really, but logic exists here
        throw new ValidationError('group filter can only be used when entityType="account"');
      }
      filters.push({
        term: {
          [groupField]: args.group,
        },
      });
    }

    const groupingField = args.entityType === 'group' ? groupField : accountField;
    const aggregationName = args.entityType === 'group' ? 'by_group' : 'by_account';

    const metricAggs: Record<string, any> = {};

    for (const metricFilter of metricsToCompute) {
      const metric = metricFilter.metric;

      if (metric === 'account_count') {
        metricAggs.unique_accounts = {
          cardinality: { field: accountField },
        };
      } else if (metric === 'visit_count') {
        metricAggs.visit_count = {
          value_count: { field: timeField },
        };
      } else if (metric === 'provider_rating') {
        metricAggs.avg_provider_rating = {
          avg: { field: providerRatingField },
        };
      } else if (metric === 'patient_rating') {
        metricAggs.avg_patient_rating = {
          avg: { field: patientRatingField },
        };
      } else if (metric === 'avg_call_duration') {
        metricAggs.avg_call_duration = {
          avg: { field: callDurationField },
        };
      } else if (metric === 'unique_providers') {
        metricAggs.unique_providers = {
          cardinality: { field: providerField },
        };
      } else if (metric === 'unique_patients') {
        metricAggs.unique_patients = {
          cardinality: { field: patientField },
        };
      } else if (metric === 'provider_rating_count') {
        metricAggs.provider_rating_count = {
          value_count: { field: providerRatingField },
        };
      } else if (metric === 'patient_rating_count') {
        metricAggs.patient_rating_count = {
          value_count: { field: patientRatingField },
        };
      }
    }

    if (!metricAggs.visit_count) {
      metricAggs.visit_count = {
        value_count: { field: timeField },
      };
    }

    const aggs: any = {
      [aggregationName]: {
        terms: {
          field: groupingField,
          size: calculateTermsSize(limit, 3, AGGREGATION_LIMITS.MAX), // Safeguard: Get more to account for filtering
        },
        aggs: metricAggs,
      },
    };

    const query = {
      index,
      size: 0,
      body: {
        track_total_hits: false,
        query: {
          bool: {
            filter: filters,
          },
        },
        aggs,
      },
    };

    this.logger.debug('Executing query', { query: JSON.stringify(query, null, 2) });

    const response = await client.search(query);
    const responseAggs = response.aggregations as any;

    const buckets = responseAggs?.[aggregationName]?.buckets || [];

    const getMetricValueFromBucket = (bucket: any, metric: string): number | null => {
      switch (metric) {
        case 'account_count':
          return bucket.unique_accounts?.value ?? null;
        case 'visit_count':
          return bucket.visit_count?.value ?? null;
        case 'provider_rating':
          return bucket.avg_provider_rating?.value ?? null;
        case 'patient_rating':
          return bucket.avg_patient_rating?.value ?? null;
        case 'avg_call_duration':
          return bucket.avg_call_duration?.value ?? null;
        case 'unique_providers':
          return bucket.unique_providers?.value ?? null;
        case 'unique_patients':
          return bucket.unique_patients?.value ?? null;
        case 'provider_rating_count':
          return bucket.provider_rating_count?.value ?? null;
        case 'patient_rating_count':
          return bucket.patient_rating_count?.value ?? null;
        default:
          return null;
      }
    };

    const results: EntityMetricResult[] = buckets
      .map((bucket: any) => {
        const entity = bucket.key as string;

        const metricValues: Record<string, number | null> = {};
        for (const metricFilter of metricsToCompute) {
          const value = getMetricValueFromBucket(bucket, metricFilter.metric);
          metricValues[metricFilter.metric] = value;
        }

        const visitCount = bucket.visit_count?.value || 0;

        const result: EntityMetricResult = {
          entity,
          metric_value: 0, // Will be set based on first metric
          visit_count: Math.round(visitCount),
        };

        if (metricValues.account_count !== null) {
          result.account_count = Math.round(metricValues.account_count);
        }
        if (metricValues.provider_rating !== null) {
          result.provider_rating = Math.round(metricValues.provider_rating * 100) / 100;
        }
        if (metricValues.patient_rating !== null) {
          result.patient_rating = Math.round(metricValues.patient_rating * 100) / 100;
        }
        if (metricValues.avg_call_duration !== null) {
          result.avg_call_duration = Math.round(metricValues.avg_call_duration * 100) / 100;
        }
        if (metricValues.unique_providers !== null) {
          result.unique_providers = Math.round(metricValues.unique_providers);
        }
        if (metricValues.unique_patients !== null) {
          result.unique_patients = Math.round(metricValues.unique_patients);
        }
        if (metricValues.provider_rating_count !== null) {
          result.provider_rating_count = Math.round(metricValues.provider_rating_count);
        }
        if (metricValues.patient_rating_count !== null) {
          result.patient_rating_count = Math.round(metricValues.patient_rating_count);
        }

        const firstMetric = metricsToCompute[0]?.metric;
        if (firstMetric && metricValues[firstMetric] !== null) {
          const value = metricValues[firstMetric]!;
          result.metric_value = (firstMetric === 'visit_count' || firstMetric === 'account_count' ||
            firstMetric === 'unique_providers' || firstMetric === 'unique_patients' ||
            firstMetric === 'provider_rating_count' || firstMetric === 'patient_rating_count')
            ? Math.round(value)
            : Math.round(value * 100) / 100;
        } else {
          result.metric_value = visitCount;
        }

        return { result, metricValues };
      })
      .filter(({ metricValues }: { metricValues: Record<string, number | null> }) => {
        for (const metricFilter of metricsToCompute) {
          const value = metricValues[metricFilter.metric];
          if (value === null || value === undefined) {
            return false; // Skip if metric value is missing
          }

          if (metricFilter.min !== undefined && value < metricFilter.min) {
            return false;
          }
          if (metricFilter.max !== undefined && value > metricFilter.max) {
            return false;
          }
        }
        return true;
      })
      .map(({ result }: { result: EntityMetricResult }) => result);

    const firstMetric = metricsToCompute[0]?.metric;
    const isCountMetric = firstMetric === 'account_count' || firstMetric === 'visit_count' ||
      firstMetric === 'unique_providers' || firstMetric === 'unique_patients' ||
      firstMetric === 'provider_rating_count' || firstMetric === 'patient_rating_count';

    results.sort((a, b) => {
      if (isCountMetric) {
        return b.metric_value - a.metric_value; // Descending for counts (highest first)
      } else {
        return a.metric_value - b.metric_value; // Ascending for ratings (lowest/worst first)
      }
    });

    const limitedResults = results.slice(0, limit);

    this.logger.info('Successfully found entities by metric', {
      entityType: args.entityType,
      metricsCount: metricsToCompute.length,
      totalFound: limitedResults.length,
    });

    return this.buildResponse({
      entityType: args.entityType,
      metric: args.metric || metricsToCompute.map(m => m.metric).join(','),
      min: args.min,
      max: args.max,
      metrics: metricsToCompute,
      total_found: limitedResults.length,
      results: limitedResults
    }, {
      description: `Found ${limitedResults.length} ${args.entityType}s by metric(s) from ${startDateIso} to ${endDateIso}`,
      arguments: args,
      time: {
        start: startDateIso,
        end: endDateIso
      },
      visualization: {
        type: 'table',
        title: `Entities by Metric (${args.entityType})`,
        description: `${startDateIso.split('T')[0]} to ${endDateIso.split('T')[0]}`,
        xAxisLabel: args.entityType,
        yAxisLabel: 'Metric Value'
      }
    });
  }
}
