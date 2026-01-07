import { ElasticsearchManager } from '../elasticsearch/client.js';
import { Logger } from '../logger.js';
import { z } from 'zod';
import { ValidationError, ElasticsearchError } from '../errors/handlers.js';
import { AGGREGATION_LIMITS } from '../utils/aggregation-limits.js';
import { FIELD_CONSTANTS } from '../utils/field-constants.js';

const GetVisitTrendsArgsSchema = z.object({
  interval: z.enum(['daily', 'weekly', 'monthly']).describe('Time interval for trends: "daily", "weekly", or "monthly"'),
  startDate: z.string().optional().describe('Start date in ISO format (YYYY-MM-DD) or date math (e.g., "now-180d", "now-1y"). Defaults to "now-180d" (6 months)'),
  endDate: z.string().optional().describe('End date in ISO format (YYYY-MM-DD) or date math (e.g., "now"). Defaults to "now"'),
  groupBy: z.enum(['none', 'subscription', 'account', 'group']).optional().default('none').describe('Optional grouping dimension (default: none)'),
  account: z.string().optional().describe('Optional account name to filter by'),
  group: z.string().optional().describe('Optional group name to filter by'),
  subscription: z.enum(['Enterprise', 'Premium', 'FVC', 'BVC', 'Plus']).optional().describe('Optional subscription tier to filter by'),
}).strict();

export interface GetVisitTrendsArgs {
  interval: 'daily' | 'weekly' | 'monthly';
  startDate?: string;
  endDate?: string;
  groupBy?: 'none' | 'subscription' | 'account' | 'group';
  account?: string;
  group?: string;
  subscription?: 'Enterprise' | 'Premium' | 'FVC' | 'BVC' | 'Plus';
}

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

export interface VisitTrendsResult {
  interval: string;
  period: string;
  startDate: string;
  endDate: string;
  trends: TrendDataPoint[] | GroupedTrendData[];
  total_visits: number;
  average_per_period: number;
}

export class GetVisitTrendsTool {
  private elasticsearch: ElasticsearchManager;
  private logger: Logger;

  constructor(elasticsearch: ElasticsearchManager, logger: Logger) {
    this.elasticsearch = elasticsearch;
    this.logger = logger.child({ tool: 'get-visit-trends' });
  }

  async execute(args: unknown): Promise<VisitTrendsResult> {
    try {
      const validatedArgs = GetVisitTrendsArgsSchema.parse(args);
      let startDate = validatedArgs.startDate || 'now-180d';
      const endDate = validatedArgs.endDate || 'now';
      const groupBy = validatedArgs.groupBy || 'none';
      
      // Calculate estimated buckets for logging
      const parseDateMathDays = (dateMath: string): number => {
        const match = dateMath.match(/now-(\d+)([dwMy])/i);
        if (!match) return 90;
        const value = parseInt(match[1], 10);
        const unit = match[2].toLowerCase();
        switch (unit) {
          case 'd': return value;
          case 'w': return value * 7;
          case 'm': return value * 30;
          case 'y': return value * 365;
          default: return value;
        }
      };
      
      const calculateBuckets = (interval: string, daysDiff: number): number => {
        switch (interval) {
          case 'daily': return Math.ceil(daysDiff);
          case 'weekly': return Math.ceil(daysDiff / 7);
          case 'monthly': return Math.ceil(daysDiff / 30);
          default: return daysDiff;
        }
      };
      
      const estimatedDays = parseDateMathDays(startDate);
      const estimatedBuckets = calculateBuckets(validatedArgs.interval, estimatedDays);
      
      this.logger.info('Getting visit trends', {
        interval: validatedArgs.interval,
        startDate,
        endDate,
        groupBy,
        estimatedBuckets,
        account: validatedArgs.account,
        group: validatedArgs.group,
        subscription: validatedArgs.subscription,
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
      const callDurationField = FIELD_CONSTANTS.callDurationField;
      const meetingBasedField = FIELD_CONSTANTS.meetingBasedField;

      // Build filters
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

      if (validatedArgs.account) {
        filters.push({
          term: {
            [accountField]: validatedArgs.account,
          },
        });
      }

      if (validatedArgs.group) {
        filters.push({
          term: {
            [groupField]: validatedArgs.group,
          },
        });
      }

      if (validatedArgs.subscription) {
        filters.push({
          term: {
            [subscriptionField]: validatedArgs.subscription,
          },
        });
      }

      let calendarInterval: string;
      switch (validatedArgs.interval) {
        case 'daily':
          calendarInterval = 'day';
          break;
        case 'weekly':
          calendarInterval = 'week';
          break;
        case 'monthly':
          calendarInterval = 'month';
          break;
        default:
          calendarInterval = 'day';
      }

      const aggs: any = {
        trends_over_time: {
          date_histogram: {
            field: timeField,
            calendar_interval: calendarInterval,
            min_doc_count: 0,
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

      const averagePerPeriod = trends.length > 0 
        ? (groupBy === 'none' 
          ? Math.round((totalVisits / (trends as TrendDataPoint[]).length) * 100) / 100
          : Math.round((totalVisits / trends.length) * 100) / 100)
        : 0;

      this.logger.info('Successfully retrieved visit trends', {
        interval: validatedArgs.interval,
        totalVisits,
        dataPoints: trends.length,
      });

      return {
        interval: validatedArgs.interval,
        period: `${startDate} to ${endDate}`,
        startDate,
        endDate,
        trends,
        total_visits: totalVisits,
        average_per_period: averagePerPeriod,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'ZodError') {
        throw new ValidationError('Invalid arguments for get_visit_trends', {
          details: error.message,
        });
      }

      if (error instanceof ValidationError) {
        throw error;
      }

      this.logger.error('Failed to get visit trends', {}, error as Error);
      throw new ElasticsearchError(
        'Failed to get visit trends from Elasticsearch',
        error as Error,
        { args }
      );
    }
  }
}

