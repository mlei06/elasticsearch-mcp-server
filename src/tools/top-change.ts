import { ElasticsearchManager } from '../elasticsearch/client.js';
import { Logger } from '../logger.js';
import { z } from 'zod';
import { ValidationError, ElasticsearchError } from '../errors/handlers.js';
import { FIELD_CONSTANTS } from '../utils/field-constants.js';
import { resolveDate } from '../utils/date-math.js';

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
  topN: z.number().int().min(1).max(50).default(5).describe('Number of top items to return (default: 5, max: 50)'),
  startDate: z.string().optional().describe('Start date for current period in ISO format (YYYY-MM-DD) or date math (e.g., "now-30d", "now-1y"). Defaults to "now-30d"'),
  endDate: z.string().optional().describe('End date for current period in ISO format (YYYY-MM-DD) or date math (e.g., "now"). Defaults to "now"'),
  subscription: z.enum(['Enterprise', 'Premium', 'FVC', 'BVC', 'Plus']).optional().describe('Optional subscription tier to filter by'),
}).strict();

export interface TopChangeArgs {
  groupBy: 'account' | 'group' | 'provider_platform' | 'patient_platform' | 'provider_platform_version' | 'patient_platform_version';
  direction: 'increase' | 'decrease';
  topN?: number;
  startDate?: string;
  endDate?: string;
  subscription?: 'Enterprise' | 'Premium' | 'FVC' | 'BVC' | 'Plus';
}

export interface ChangeInfo {
  item: string;
  current_period_count: number;
  previous_period_count: number;
  change: number;
  change_percent: number;
}

export interface TopChangeResult {
  currentPeriodStart: string;
  currentPeriodEnd: string;
  previousPeriodStart: string;
  previousPeriodEnd: string;
  groupBy: 'account' | 'group' | 'provider_platform' | 'patient_platform' | 'provider_platform_version' | 'patient_platform_version';
  direction: 'increase' | 'decrease';
  items: ChangeInfo[];
  total: number;
}

export class TopChangeTool {
  private elasticsearch: ElasticsearchManager;
  private logger: Logger;

  constructor(elasticsearch: ElasticsearchManager, logger: Logger) {
    this.elasticsearch = elasticsearch;
    this.logger = logger.child({ tool: 'top-change' });
  }

  async execute(args: unknown): Promise<TopChangeResult> {
    try {
      const validatedArgs = TopChangeArgsSchema.parse(args);
      const topN = validatedArgs.topN || 5;
      let currentPeriodStart = validatedArgs.startDate || 'now-30d';
      let currentPeriodEnd = validatedArgs.endDate || 'now';

      // This tool aggregates ALL accounts/groups before sorting, making it memory-intensive.
      // Cap the current period to prevent data limit errors.
      //const { startDate: cappedCurrentStart, endDate: cappedCurrentEnd } = capTimePeriod(
      //  currentPeriodStart,
      //  currentPeriodEnd,
      //  60, // Max 60 days per period
      //  this.logger
      //);
      //currentPeriodStart = cappedCurrentStart;
      //currentPeriodEnd = cappedCurrentEnd;

      // Calculate absolute dates for the current period
      const currentStart = resolveDate(currentPeriodStart);
      const currentEnd = resolveDate(currentPeriodEnd);

      // Calculate duration in milliseconds
      const durationMs = currentEnd.getTime() - currentStart.getTime();

      // Calculate previous period: strictly distinct, immediately preceding current period
      // Previous End = Current Start
      const previousEnd = new Date(currentStart.getTime());
      // Previous Start = Previous End - Duration
      const previousStart = new Date(previousEnd.getTime() - durationMs);

      // Format as ISO strings for Elasticsearch
      const currentPeriodStartIso = currentStart.toISOString();
      const currentPeriodEndIso = currentEnd.toISOString();
      const previousPeriodStartIso = previousStart.toISOString();
      const previousPeriodEndIso = previousEnd.toISOString();

      this.logger.info('Getting top items by visit change', {
        groupBy: validatedArgs.groupBy,
        direction: validatedArgs.direction,
        topN,
        currentPeriodStart: currentPeriodStartIso,
        currentPeriodEnd: currentPeriodEndIso,
        previousPeriodStart: previousPeriodStartIso,
        previousPeriodEnd: previousPeriodEndIso,
        durationMs,
        subscription: validatedArgs.subscription,
      });

      const client = this.elasticsearch.getClient();

      const index = FIELD_CONSTANTS.index;
      const timeField = FIELD_CONSTANTS.timeField;
      const testVisitField = FIELD_CONSTANTS.testVisitField;
      const subscriptionField = FIELD_CONSTANTS.subscriptionField;

      let groupingField: string;
      let aggregationName: string;

      switch (validatedArgs.groupBy) {
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

      const sortOrder = validatedArgs.direction === 'increase' ? 'desc' : 'asc';

      const filters: any[] = [
        {
          range: {
            [timeField]: {
              gte: previousPeriodStartIso,
              lt: currentPeriodEndIso,
            },
          },
        },
        {
          exists: {
            field: groupingField,
          },
        },
      ];

      if (validatedArgs.subscription) {
        filters.push({
          term: {
            [subscriptionField]: validatedArgs.subscription,
          },
        });
      }

      // aggregationName is already set above

      const query = {
        index,
        size: 0,
        body: {
          track_total_hits: false,
          query: {
            bool: {
              filter: filters,
              must_not: [
                {
                  term: {
                    [testVisitField]: 'Yes',
                  },
                },
                // Exclude empty group/account names
                {
                  term: {
                    [groupingField]: '',
                  },
                },
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
                    sort: [
                      {
                        visit_delta: {
                          order: sortOrder,
                        },
                      },
                    ],
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
      const aggregation = response.aggregations?.[aggregationName] as any;
      const buckets = aggregation?.buckets || [];

      for (const bucket of buckets) {
        const item = bucket.key as string;

        if (!item || item.trim() === '') {
          continue;
        }

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
        groupBy: validatedArgs.groupBy,
        direction: validatedArgs.direction,
        count: items.length,
      });

      return {
        currentPeriodStart: currentPeriodStartIso,
        currentPeriodEnd: currentPeriodEndIso,
        previousPeriodStart: previousPeriodStartIso,
        previousPeriodEnd: previousPeriodEndIso,
        groupBy: validatedArgs.groupBy,
        direction: validatedArgs.direction,
        items,
        total: items.length,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'ZodError') {
        throw new ValidationError('Invalid arguments for top_change', {
          details: error.message,
        });
      }

      if (error instanceof ValidationError) {
        throw error;
      }

      this.logger.error('Failed to get top items by change', {}, error as Error);
      throw new ElasticsearchError(
        'Failed to get top items by visit change from Elasticsearch',
        error as Error,
        { args }
      );
    }
  }
}

