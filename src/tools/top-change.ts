import { BaseTool } from './base-tool.js';
import { z } from 'zod';
import { FIELD_CONSTANTS } from '../utils/field-constants.js';
import { buildCommonFilters } from '../utils/query-helpers.js';
import { StandardResponse } from './types.js';

const TopChangeArgsSchema = z.object({
  groupBy: z.enum([
    'account',
    'group',
    'provider_platform',
    'patient_platform',
    'provider_platform_version',
    'patient_platform_version'
  ]).describe('Group by: "account", "group", "provider_platform", "patient_platform", "provider_platform_version", or "patient_platform_version"'),
  direction: z.enum(['increase', 'decrease']).describe('Direction: "increase" for highest growth, "decrease" for highest decline'),
  topN: z.number().int().min(1).max(50).default(1).describe('Number of top items to return (default: 5, max: 50)'),
  startDate: z.string().optional().describe('Start date for current period in ISO format (YYYY-MM-DD) or date math (e.g., "now-30d", "now-1y"). Defaults to "now-1w"'),
  endDate: z.string().optional().describe('End date for current period in ISO format (YYYY-MM-DD) or date math (e.g., "now"). Defaults to "now"'),
  subscription: z.enum(['Enterprise', 'Premium', 'FVC', 'BVC', 'Plus']).optional().describe('Optional subscription tier to filter by'),
}).strict();

export type TopChangeArgs = z.infer<typeof TopChangeArgsSchema>;

export interface ChangeInfo {
  item: string;
  current_period_count: number;
  previous_period_count: number;
  change: number;
  change_percent: number;
}

export type TopChangeResult = StandardResponse<{
  items: ChangeInfo[];
  total: number;
  groupBy: string;
  direction: string;
}>;

export class TopChangeTool extends BaseTool<typeof TopChangeArgsSchema, TopChangeResult> {
  constructor(elasticsearch: any, logger: any) {
    super(elasticsearch, logger, 'elastic_top_change');
  }

  get schema() {
    return TopChangeArgsSchema;
  }

  get description() {
    return 'Find highest visit/usage increase or decrease in top N items (accounts, groups, platforms). Returns items ranked by change with current period count, previous period count, absolute change, and percentage change. The previous period is automatically calculated to match the duration of the current period, ending where the current period starts. Supports filtering by subscription tier.';
  }

  protected async run(args: TopChangeArgs): Promise<TopChangeResult> {
    const topN = args.topN || 5;
    const { startIso: currentPeriodStartIso, endIso: currentPeriodEndIso } =
      this.resolveTimeRange(args.startDate, args.endDate, 'now-1w', 'now');

    // Calculate previous period
    const currentStartDate = new Date(currentPeriodStartIso);
    const currentEndDate = new Date(currentPeriodEndIso);
    const durationMs = currentEndDate.getTime() - currentStartDate.getTime();
    const previousEndDate = new Date(currentStartDate.getTime());
    const previousStartDate = new Date(previousEndDate.getTime() - durationMs);

    const previousPeriodStartIso = previousStartDate.toISOString();
    const previousPeriodEndIso = previousEndDate.toISOString();

    this.logger.info('Getting top items by visit change', {
      groupBy: args.groupBy,
      direction: args.direction,
      topN,
      currentPeriodStart: currentPeriodStartIso,
      currentPeriodEnd: currentPeriodEndIso,
      previousPeriodStart: previousPeriodStartIso,
      previousPeriodEnd: previousPeriodEndIso,
      durationMs,
      subscription: args.subscription,
    });

    const client = this.elasticsearch.getClient();
    const index = FIELD_CONSTANTS.index;
    const timeField = FIELD_CONSTANTS.timeField;

    let groupingField: string;
    let aggregationName: string;

    switch (args.groupBy) {
      case 'account':
        groupingField = FIELD_CONSTANTS.accountField;
        aggregationName = 'by_account';
        break;
      case 'group':
        groupingField = FIELD_CONSTANTS.groupField;
        aggregationName = 'by_group';
        break;
      case 'provider_platform':
        groupingField = FIELD_CONSTANTS.providerPlatformField;
        aggregationName = 'by_provider_platform';
        break;
      case 'patient_platform':
        groupingField = FIELD_CONSTANTS.patientPlatformField;
        aggregationName = 'by_patient_platform';
        break;
      case 'provider_platform_version':
        groupingField = FIELD_CONSTANTS.providerPlatformVersionField;
        aggregationName = 'by_provider_platform_version';
        break;
      case 'patient_platform_version':
        groupingField = FIELD_CONSTANTS.patientPlatformVersionField;
        aggregationName = 'by_patient_platform_version';
        break;
    }

    const sortOrder = args.direction === 'increase' ? 'desc' : 'asc';

    // Base filters mostly cover the time range for the "overall" query context?
    // Actually TopChange is tricky because it needs data from BOTH periods to aggregate correctly if we filter at query level.
    // The original implementation filtered to `gte: previousPeriodStartIso, lt: currentPeriodEndIso`
    // Our `buildCommonFilters` assumes a single range.

    // Manually building filters here as it's a special case (spanning 2 periods)
    const filters = buildCommonFilters({
      startDate: previousPeriodStartIso,
      endDate: currentPeriodEndIso,
      subscription: args.subscription,
      excludeTestVisits: true
    });

    // Special: Exclude empty grouping field (original implementation did this)
    filters.push({
      exists: { field: groupingField }
    });

    const query = {
      index,
      size: 0,
      body: {
        track_total_hits: false,
        query: {
          bool: {
            filter: filters,
            must_not: [
              { term: { [groupingField]: '' } }
            ],
          },
        },
        aggs: {
          [aggregationName]: {
            terms: {
              field: groupingField,
              size: topN * 2,
              exclude: '',
            },
            aggs: {
              current_period: {
                filter: {
                  range: {
                    [timeField]: {
                      gte: currentPeriodStartIso,
                      lt: currentPeriodEndIso,
                    },
                  },
                },
              },
              previous_period: {
                filter: {
                  range: {
                    [timeField]: {
                      gte: previousPeriodStartIso,
                      lt: previousPeriodEndIso,
                    },
                  },
                },
              },
              visit_delta: {
                bucket_script: {
                  buckets_path: {
                    current: 'current_period._count',
                    previous: 'previous_period._count',
                  },
                  script: 'params.current - params.previous',
                },
              },
              top_results: {
                bucket_sort: {
                  sort: [{ visit_delta: { order: sortOrder } }],
                  size: topN,
                },
              },
            },
          },
        },
      },
    };

    this.logger.debug('Executing query', { query: JSON.stringify(query, null, 2) });
    const response = await client.search(query);

    const items: ChangeInfo[] = [];
    const aggregation = (response.aggregations as any)?.[aggregationName];
    const buckets = aggregation?.buckets || [];

    for (const bucket of buckets) {
      const item = bucket.key as string;
      if (!item || item.trim() === '') continue;

      const currentPeriod = bucket.current_period as any;
      const previousPeriod = bucket.previous_period as any;
      const visitDelta = bucket.visit_delta as any;

      const currentCount = currentPeriod?.doc_count || 0;
      const previousCount = previousPeriod?.doc_count || 0;
      const change = visitDelta?.value || 0;
      const changePercent =
        previousCount > 0 ? ((change / previousCount) * 100).toFixed(2) : (currentCount > 0 ? 100 : 0);

      items.push({
        item,
        current_period_count: currentCount,
        previous_period_count: previousCount,
        change,
        change_percent: parseFloat(changePercent.toString()),
      });
    }

    this.logger.info('Successfully retrieved top items', {
      groupBy: args.groupBy,
      direction: args.direction,
      count: items.length,
    });

    return this.buildResponse({
      items,
      total: items.length,
      groupBy: args.groupBy,
      direction: args.direction
    }, {
      description: `Top ${items.length} ${args.groupBy}s by ${args.direction} in visits from ${currentPeriodStartIso} to ${currentPeriodEndIso} (vs. previous period)`,

      time: {
        start: currentPeriodStartIso,
        end: currentPeriodEndIso,
        previousStart: previousPeriodStartIso,
        previousEnd: previousPeriodEndIso
      },
      visualization: {
        type: 'table',
        title: `Top Visit ${args.direction === 'increase' ? 'Growth' : 'Decline'} by ${args.groupBy}`,
        description: `${currentPeriodStartIso.split('T')[0]} to ${currentPeriodEndIso.split('T')[0]} vs previous period`,
        xAxisLabel: args.groupBy,
        yAxisLabel: 'Change in Visits'
      }
    });
  }
}
