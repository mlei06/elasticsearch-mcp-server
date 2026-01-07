import { ElasticsearchManager } from '../elasticsearch/client.js';
import { Logger } from '../logger.js';
import { z } from 'zod';
import { ValidationError, ElasticsearchError } from '../errors/handlers.js';
import { FIELD_CONSTANTS } from '../utils/field-constants.js';
import { parseDateMath, capTimePeriod } from '../utils/date-math.js';

const TopChangeArgsSchema = z.object({
  groupBy: z.enum(['account', 'group']).describe('Group by: "account" to find top accounts by visit change, "group" to find top groups by visit change'),
  direction: z.enum(['increase', 'decrease']).describe('Direction: "increase" for highest growth, "decrease" for highest decline'),
  topN: z.number().int().min(1).max(50).default(5).describe('Number of top items to return (default: 5, max: 50)'),
  startDate: z.string().optional().describe('Start date for current period in ISO format (YYYY-MM-DD) or date math (e.g., "now-30d", "now-1y"). Defaults to "now-30d"'),
  endDate: z.string().optional().describe('End date for current period in ISO format (YYYY-MM-DD) or date math (e.g., "now"). Defaults to "now"'),
  subscription: z.enum(['Enterprise', 'Premium', 'FVC', 'BVC', 'Plus']).optional().describe('Optional subscription tier to filter by'),
}).strict();

export interface TopChangeArgs {
  groupBy: 'account' | 'group';
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
  groupBy: 'account' | 'group';
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
      const { startDate: cappedCurrentStart, endDate: cappedCurrentEnd } = capTimePeriod(
        currentPeriodStart,
        currentPeriodEnd,
        60, // Max 60 days per period
        this.logger
      );
      currentPeriodStart = cappedCurrentStart;
      currentPeriodEnd = cappedCurrentEnd;
      
      // Calculate the duration of the current period
      const startDays = parseDateMath(currentPeriodStart);
      const endDays = parseDateMath(currentPeriodEnd);
      const periodDuration = Math.abs(endDays - startDays);
      
      // Calculate previous period: same duration, ending where current period starts
      // Previous period end = current period start
      const previousPeriodEnd = currentPeriodStart;
      
      // Previous period start = current period start minus the duration
      // For date math expressions, we need to calculate the new start date
      let previousPeriodStart: string;
      if (currentPeriodStart.startsWith('now-')) {
        // Extract the number and unit from the date math expression
        const match = currentPeriodStart.match(/now-(\d+)([dwMy])/);
        if (match) {
          const currentValue = parseInt(match[1], 10);
          const unit = match[2];
          const newValue = currentValue + periodDuration;
          previousPeriodStart = `now-${newValue}${unit}`;
        } else {
          // Fallback: use days
          const newValue = startDays + periodDuration;
          previousPeriodStart = `now-${newValue}d`;
        }
      } else {
        // For ISO dates, we'd need a date library to properly subtract days
        // For now, use date math as fallback
        const newValue = startDays + periodDuration;
        previousPeriodStart = `now-${newValue}d`;
      }
      
      this.logger.info('Getting top items by visit change', {
        groupBy: validatedArgs.groupBy,
        direction: validatedArgs.direction,
        topN,
        currentPeriodStart,
        currentPeriodEnd,
        previousPeriodStart,
        previousPeriodEnd,
        periodDuration,
        subscription: validatedArgs.subscription,
      });

      const client = this.elasticsearch.getClient();

      const index = FIELD_CONSTANTS.index;
      const timeField = FIELD_CONSTANTS.timeField; 
      const testVisitField = FIELD_CONSTANTS.testVisitField;
      const subscriptionField = FIELD_CONSTANTS.subscriptionField;
      
      const groupingField = validatedArgs.groupBy === 'account' 
        ? FIELD_CONSTANTS.accountField 
        : FIELD_CONSTANTS.groupField;

      const sortOrder = validatedArgs.direction === 'increase' ? 'desc' : 'asc';

      const filters: any[] = [
        {
          range: {
            [timeField]: {
              gte: previousPeriodStart,
              lt: currentPeriodEnd,
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

      const aggregationName = validatedArgs.groupBy === 'account' ? 'by_account' : 'by_group';
      
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
                        gte: currentPeriodStart,
                        lt: currentPeriodEnd,
                      },
                    },
                  },
                },
                previous_period: {
                  filter: {
                    range: {
                      [timeField]: {
                        gte: previousPeriodStart,
                        lt: previousPeriodEnd,
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
        currentPeriodStart,
        currentPeriodEnd,
        previousPeriodStart,
        previousPeriodEnd,
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

