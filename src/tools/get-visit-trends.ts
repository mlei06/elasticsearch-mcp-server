import { BaseTool } from './base-tool.js';
import { z } from 'zod';
import { FIELD_CONSTANTS } from '../utils/field-constants.js';
import { buildCommonFilters } from '../utils/query-helpers.js';
import { StandardResponse } from './types.js';
import { AGGREGATION_LIMITS } from '../utils/aggregation-limits.js';

const GetVisitTrendsArgsSchema = z.object({
  interval: z.enum(['daily', 'weekly', 'monthly', 'yearly']).default('weekly').describe('Time interval for trends: "daily", "weekly", "monthly", or "yearly" (default: weekly)'),
  startDate: z.string().optional().describe('Start date in ISO format (YYYY-MM-DD) or date math (e.g., "now-30d", "now-1y"). Defaults to "now-30d" (1 month)'),
  endDate: z.string().optional().describe('End date in ISO format (YYYY-MM-DD) or date math (e.g., "now"). Defaults to "now"'),
  groupBy: z.enum(['none', 'subscription', 'account', 'group']).optional().default('none').describe('Optional grouping dimension (default: none)'),
  account: z.string().optional().describe('Optional account name to filter by'),
  group: z.string().optional().describe('Optional group name to filter by'),
  subscription: z.enum(['Enterprise', 'Premium', 'FVC', 'BVC', 'Plus']).optional().describe('Optional subscription tier to filter by'),
}).strict();

export type GetVisitTrendsArgs = z.infer<typeof GetVisitTrendsArgsSchema>;

export interface TrendDataPoint {
  date: string;
  count: number;
  unique_accounts?: number;
  unique_providers?: number;
  unique_patients?: number;
}

export interface GroupedTrendData extends Record<string, any> {
  data_points: TrendDataPoint[];
}

export type VisitTrendsResult = StandardResponse<TrendDataPoint[] | GroupedTrendData[]>;

export class GetVisitTrendsTool extends BaseTool<typeof GetVisitTrendsArgsSchema, VisitTrendsResult> {
  constructor(elasticsearch: any, logger: any) {
    super(elasticsearch, logger, 'elastic_get_visit_trends');
  }

  get schema() {
    return GetVisitTrendsArgsSchema;
  }

  get description() {
    return 'Get visit/usage count trends over time (daily, weekly, monthly, or yearly intervals) with optional grouping by subscription, account, or group. Returns time series data points with visit counts and unique counts (accounts, providers, patients) per period.';
  }

  protected async run(args: GetVisitTrendsArgs): Promise<VisitTrendsResult> {
    const interval = args.interval || 'weekly';
    const groupBy = args.groupBy || 'none';

    const { startIso: startDateIso, endIso: endDateIso } =
      this.resolveTimeRange(args.startDate, args.endDate, 'now-30d', 'now');

    this.logger.info('Getting visit trends', {
      interval,
      startDate: startDateIso,
      endDate: endDateIso,
      groupBy,
      account: args.account,
      group: args.group,
      subscription: args.subscription,
    });

    const client = this.elasticsearch.getClient();
    const index = FIELD_CONSTANTS.index;
    const timeField = FIELD_CONSTANTS.timeField;
    const accountField = FIELD_CONSTANTS.accountField;
    const groupField = FIELD_CONSTANTS.groupField;
    const subscriptionField = FIELD_CONSTANTS.subscriptionField;
    const providerField = FIELD_CONSTANTS.providerField;
    const patientField = FIELD_CONSTANTS.patientField;
    const callDurationField = FIELD_CONSTANTS.callDurationField;

    // Common filters
    const filters = buildCommonFilters({
      startDate: startDateIso,
      endDate: endDateIso,
      account: args.account,
      group: args.group,
      subscription: args.subscription,
      excludeTestVisits: true
    });

    // Extra filter
    filters.push({
      bool: {
        should: [
          { exists: { field: callDurationField } },
          { term: { [FIELD_CONSTANTS.meetingBasedField]: false } },
        ],
        minimum_should_match: 1,
      },
    });

    let calendarInterval: string;
    switch (interval) {
      case 'daily':
        calendarInterval = 'day';
        break;
      case 'weekly':
        calendarInterval = 'week';
        break;
      case 'monthly':
        calendarInterval = 'month';
        break;
      case 'yearly':
        calendarInterval = 'year';
        break;
      default:
        calendarInterval = 'week';
    }

    const aggs: any = {
      trends_over_time: {
        date_histogram: {
          field: timeField,
          calendar_interval: calendarInterval,
          min_doc_count: 0,
          extended_bounds: {
            min: startDateIso,
            max: endDateIso,
          },
        },
        aggs: {
          unique_accounts: {
            cardinality: { field: accountField },
          },
          unique_providers: {
            cardinality: { field: providerField },
          },
          unique_patients: {
            cardinality: { field: patientField },
          },
        },
      },
    };

    if (groupBy !== 'none') {
      let groupFieldName: string;
      switch (groupBy) {
        case 'subscription':
          groupFieldName = subscriptionField;
          break;
        case 'account':
          groupFieldName = accountField;
          break;
        case 'group':
          groupFieldName = groupField;
          break;
        default:
          groupFieldName = subscriptionField;
      }

      aggs.by_group = {
        terms: {
          field: groupFieldName,
          size: AGGREGATION_LIMITS.MEDIUM, // Safeguard: cap at 50 to prevent data limits
        },
        aggs: {
          trends_over_time: {
            date_histogram: {
              field: timeField,
              calendar_interval: calendarInterval,
              min_doc_count: 0,
              extended_bounds: {
                min: startDateIso,
                max: endDateIso,
              },
            },
            aggs: {
              unique_accounts: {
                cardinality: { field: accountField },
              },
              unique_providers: {
                cardinality: { field: providerField },
              },
              unique_patients: {
                cardinality: { field: patientField },
              },
            },
          },
        },
      };
    }

    const query = {
      index,
      size: 0,
      filter_path: 'aggregations',
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

    let trends: TrendDataPoint[] | GroupedTrendData[] = [];
    let totalVisits = 0;

    if (groupBy === 'none') {
      const buckets = responseAggs?.trends_over_time?.buckets || [];
      trends = buckets.map((bucket: any) => {
        const count = bucket.doc_count || 0;
        totalVisits += count;
        return {
          date: bucket.key_as_string || new Date(bucket.key).toISOString(),
          count,
          unique_accounts: (bucket.unique_accounts as any)?.value || 0,
          unique_providers: (bucket.unique_providers as any)?.value || 0,
          unique_patients: (bucket.unique_patients as any)?.value || 0,
        };
      });
    } else {
      const valueKey = `${groupBy}_value`;
      const groupBuckets = responseAggs?.by_group?.buckets || [];
      trends = groupBuckets.map((groupBucket: any) => {
        const groupValue = groupBucket.key as string;
        const trendBuckets = groupBucket.trends_over_time?.buckets || [];
        const dataPoints = trendBuckets.map((bucket: any) => {
          const count = bucket.doc_count || 0;
          totalVisits += count;
          return {
            date: bucket.key_as_string || new Date(bucket.key).toISOString(),
            count,
            unique_accounts: (bucket.unique_accounts as any)?.value || 0,
            unique_providers: (bucket.unique_providers as any)?.value || 0,
            unique_patients: (bucket.unique_patients as any)?.value || 0,
          };
        });

        return {
          [valueKey]: groupValue,
          data_points: dataPoints,
        };
      });
    }

    this.logger.info('Successfully retrieved visit trends', {
      interval,
      totalVisits,
      dataPoints: trends.length,
    });

    return this.buildResponse(trends, {
      description: `Visit trends (${interval}) from ${startDateIso} to ${endDateIso}${groupBy !== 'none' ? ` grouped by ${groupBy}` : ''}`,

      time: {
        start: startDateIso,
        end: endDateIso,
        interval
      },
      visualization: {
        type: 'line',
        title: `Visit Trends (${interval}) (${startDateIso.split('T')[0]} to ${endDateIso.split('T')[0]})`,
        description: `${startDateIso.split('T')[0]} to ${endDateIso.split('T')[0]}`,
        xAxisLabel: 'Date',
        yAxisLabel: 'Visits'
      }
    });
  }
}
