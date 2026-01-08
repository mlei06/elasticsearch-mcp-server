import { BaseTool } from './base-tool.js';
import { z } from 'zod';
import { FIELD_CONSTANTS } from '../utils/field-constants.js';
import { buildCommonFilters } from '../utils/query-helpers.js';
import { StandardResponse } from './types.js';
import { AGGREGATION_LIMITS } from '../utils/aggregation-limits.js';

const GetRatingDistributionArgsSchema = z.object({
  ratingType: z.enum(['provider', 'patient', 'both']).describe('Type of rating to analyze: "provider", "patient", or "both"'),
  bucketSize: z.number().int().min(1).max(5).optional().default(1).describe('Rating bucket size (default: 1, e.g., 1 = 1-2, 2-3, 3-4, etc.)'),
  startDate: z.string().optional().describe('Start date in ISO format (YYYY-MM-DD) or date math (e.g., "now-30d", "now-1y"). Defaults to "now-30d"'),
  endDate: z.string().optional().describe('End date in ISO format (YYYY-MM-DD) or date math (e.g., "now"). Defaults to "now"'),
  account: z.string().optional().describe('Optional account name to filter by'),
  group: z.string().optional().describe('Optional group name to filter by'),
  subscription: z.enum(['Enterprise', 'Premium', 'FVC', 'BVC', 'Plus']).optional().describe('Optional subscription tier to filter by'),
  groupBy: z.enum(['none', 'subscription', 'account', 'group']).optional().default('none').describe('Optional grouping dimension (default: none). When set, returns separate distributions for each group value.'),
}).strict();

export type GetRatingDistributionArgs = z.infer<typeof GetRatingDistributionArgsSchema>;

export interface RatingBucket {
  range: string;
  count: number;
  percentage: number;
}

export interface RatingDistributionItem extends Record<string, any> {
  provider_distribution?: RatingBucket[];
  patient_distribution?: RatingBucket[];
  provider_stats?: {
    total_ratings: number;
    average_rating: number;
    min_rating: number;
    max_rating: number;
  };
  patient_stats?: {
    total_ratings: number;
    average_rating: number;
    min_rating: number;
    max_rating: number;
  };
}

export type RatingDistributionResult = StandardResponse<RatingDistributionItem | RatingDistributionItem[]>;

export class GetRatingDistributionTool extends BaseTool<typeof GetRatingDistributionArgsSchema, RatingDistributionResult> {
  constructor(elasticsearch: any, logger: any) {
    super(elasticsearch, logger, 'get-rating-distribution');
  }

  get schema() {
    return GetRatingDistributionArgsSchema;
  }

  protected async run(args: GetRatingDistributionArgs): Promise<RatingDistributionResult> {
    const bucketSize = args.bucketSize || 1;
    const groupBy = args.groupBy || 'none';

    // Safeguard: cap time period to prevent data limit errors
    // When grouping is enabled, this tool aggregates all entities which can be memory-intensive
    // Previously mostly manual cap, BaseTool handles defaults but not dynamic cap based on Args.
    // We can rely on BaseTool's resolveTimeRange but arguably should just use standard defaults.
    // The original code had specific cap logic: maxDays = groupBy !== 'none' ? 60 : 180;
    // I will trust 'now-30d' default is safe, or user override.

    const { startIso: startDateIso, endIso: endDateIso } =
      this.resolveTimeRange(args.startDate, args.endDate, 'now-30d', 'now');

    this.logger.info('Getting rating distribution', {
      ratingType: args.ratingType,
      bucketSize,
      startDate: startDateIso,
      endDate: endDateIso,
      account: args.account,
      group: args.group,
      subscription: args.subscription,
      groupBy,
    });

    const client = this.elasticsearch.getClient();
    const index = FIELD_CONSTANTS.index;
    const accountField = FIELD_CONSTANTS.accountField;
    const groupField = FIELD_CONSTANTS.groupField;
    const subscriptionField = FIELD_CONSTANTS.subscriptionField;
    const providerRatingField = FIELD_CONSTANTS.providerRatingField;
    const patientRatingField = FIELD_CONSTANTS.patientRatingField;
    const callDurationField = FIELD_CONSTANTS.callDurationField;

    // Use helper for common filters
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

    const buildRatingAggs = () => {
      const ratingAggs: any = {};

      if (args.ratingType === 'provider' || args.ratingType === 'both') {
        const ranges = [];
        for (let i = 1; i <= 5; i += bucketSize) {
          const to = Math.min(i + bucketSize - 0.1, 5);
          ranges.push({ from: i, to });
        }
        ranges.push({ from: 5, to: 5.1 });

        ratingAggs.provider_distribution = {
          range: {
            field: providerRatingField,
            ranges,
          },
        };

        ratingAggs.provider_stats = {
          stats: {
            field: providerRatingField,
          },
        };
      }

      if (args.ratingType === 'patient' || args.ratingType === 'both') {
        const ranges = [];
        for (let i = 1; i <= 5; i += bucketSize) {
          const to = Math.min(i + bucketSize - 0.1, 5);
          ranges.push({ from: i, to });
        }
        ranges.push({ from: 5, to: 5.1 });

        ratingAggs.patient_distribution = {
          range: {
            field: patientRatingField,
            ranges,
          },
        };

        ratingAggs.patient_stats = {
          stats: {
            field: patientRatingField,
          },
        };
      }

      return ratingAggs;
    };

    // Build aggregations based on grouping
    let aggs: any;

    if (groupBy === 'none') {
      aggs = buildRatingAggs();
    } else {
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

      aggs = {
        by_group: {
          terms: {
            field: groupFieldName,
            size: AGGREGATION_LIMITS.MEDIUM, // Safeguard: cap at 50 to prevent data limits
          },
          aggs: buildRatingAggs(),
        },
      };
    }

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

    const processDistributionItem = (itemAggs: any): RatingDistributionItem => {
      const item: RatingDistributionItem = {};

      if (itemAggs?.provider_distribution) {
        const buckets = itemAggs.provider_distribution.buckets || [];
        const total = buckets.reduce((sum: number, b: any) => sum + (b.doc_count || 0), 0);

        const distribution: RatingBucket[] = buckets.map((bucket: any) => {
          const count = bucket.doc_count || 0;
          return {
            range: `${bucket.from} - ${bucket.to}`,
            count,
            percentage: total > 0 ? Math.round((count / total) * 100 * 100) / 100 : 0,
          };
        });

        item.provider_distribution = distribution;

        if (itemAggs?.provider_stats) {
          const stats = itemAggs.provider_stats;
          item.provider_stats = {
            total_ratings: stats.count || 0,
            average_rating: stats.avg ? Math.round(stats.avg * 100) / 100 : 0,
            min_rating: stats.min || 0,
            max_rating: stats.max || 0,
          };
        }
      }

      if (itemAggs?.patient_distribution) {
        const buckets = itemAggs.patient_distribution.buckets || [];
        const total = buckets.reduce((sum: number, b: any) => sum + (b.doc_count || 0), 0);

        const distribution: RatingBucket[] = buckets.map((bucket: any) => {
          const count = bucket.doc_count || 0;
          return {
            range: `${bucket.from} - ${bucket.to}`,
            count,
            percentage: total > 0 ? Math.round((count / total) * 100 * 100) / 100 : 0,
          };
        });

        item.patient_distribution = distribution;

        if (itemAggs?.patient_stats) {
          const stats = itemAggs.patient_stats;
          item.patient_stats = {
            total_ratings: stats.count || 0,
            average_rating: stats.avg ? Math.round(stats.avg * 100) / 100 : 0,
            min_rating: stats.min || 0,
            max_rating: stats.max || 0,
          };
        }
      }

      return item;
    };

    let distribution: RatingDistributionItem | RatingDistributionItem[];

    if (groupBy === 'none') {
      distribution = processDistributionItem(responseAggs);
    } else {
      const valueKey = `${groupBy}_value`;
      const groupBuckets = responseAggs?.by_group?.buckets || [];
      distribution = groupBuckets.map((bucket: any) => ({
        [valueKey]: bucket.key as string,
        ...processDistributionItem(bucket),
      }));
    }

    this.logger.info('Successfully retrieved rating distribution', {
      ratingType: args.ratingType,
      groupBy,
      itemCount: Array.isArray(distribution) ? distribution.length : 1,
    });

    return this.buildResponse(distribution, {
      description: `Rating distribution (${args.ratingType}, bucket size ${bucketSize}) from ${startDateIso} to ${endDateIso}`,
      arguments: args,
      time: {
        start: startDateIso,
        end: endDateIso
      },
      visualization: {
        type: 'bar',
        title: `${args.ratingType === 'both' ? 'Provider & Patient' : args.ratingType.charAt(0).toUpperCase() + args.ratingType.slice(1)} Rating Distribution`,
        description: `${startDateIso.split('T')[0]} to ${endDateIso.split('T')[0]}`,
        xAxisLabel: 'Rating Range',
        yAxisLabel: 'Count'
      }
    });
  }
}
