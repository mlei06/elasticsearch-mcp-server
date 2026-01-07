import { ElasticsearchManager } from '../elasticsearch/client.js';
import { Logger } from '../logger.js';
import { z } from 'zod';
import { ValidationError, ElasticsearchError } from '../errors/handlers.js';
import { AGGREGATION_LIMITS } from '../utils/aggregation-limits.js';
import { FIELD_CONSTANTS } from '../utils/field-constants.js';

const GetUsageSummaryArgsSchema = z.object({
  startDate: z.string().optional().describe('Start date in ISO format (YYYY-MM-DD) or date math (e.g., "now-30d", "now-1y"). Defaults to "now-30d"'),
  endDate: z.string().optional().describe('End date in ISO format (YYYY-MM-DD) or date math (e.g., "now"). Defaults to "now"'),
  account: z.string().optional().describe('Optional account name to filter by'),
  group: z.string().optional().describe('Optional group name to filter by'),
  subscription: z.string().optional().describe('Optional subscription tier to filter by'),
  groupBy: z.enum(['none', 'subscription', 'account', 'group']).optional().default('none').describe('Optional grouping dimension (default: none). When set, returns separate summaries for each group value.'),
}).strict();

export interface GetUsageSummaryArgs {
  startDate?: string;
  endDate?: string;
  account?: string;
  group?: string;
  subscription?: string;
  groupBy?: 'none' | 'subscription' | 'account' | 'group';
}

export interface UsageSummaryItem extends Record<string, any> {
  total_visits: number;
  unique_accounts: number;
  unique_groups: number;
  unique_providers: number;
  unique_patients: number;
  avg_call_duration_seconds: number | null;
  total_call_duration_hours: number | null;
  provider_rating_count: number;
  avg_provider_rating: number | null;
  patient_rating_count: number;
  avg_patient_rating: number | null;
  subscription_distribution: Array<{ subscription: string; count: number; percentage: number }>;
  provider_platform_distribution: Array<{ platform: string; count: number; percentage: number }>;
  patient_platform_distribution: Array<{ platform: string; count: number; percentage: number }>;
}

export interface UsageSummaryResult {
  period: string;
  startDate: string;
  endDate: string;
  groupBy: string;
  summary: UsageSummaryItem | UsageSummaryItem[];
}

export class GetUsageSummaryTool {
  private elasticsearch: ElasticsearchManager;
  private logger: Logger;

  constructor(elasticsearch: ElasticsearchManager, logger: Logger) {
    this.elasticsearch = elasticsearch;
    this.logger = logger.child({ tool: 'get-usage-summary' });
  }

  async execute(args: unknown): Promise<UsageSummaryResult> {
    try {
      const validatedArgs = GetUsageSummaryArgsSchema.parse(args);
      let startDate = validatedArgs.startDate || 'now-30d';
      let endDate = validatedArgs.endDate || 'now';
      const groupBy = validatedArgs.groupBy || 'none';
      
      this.logger.info('Getting usage summary', {
        startDate,
        endDate,
        account: validatedArgs.account,
        group: validatedArgs.group,
        subscription: validatedArgs.subscription,
        groupBy,
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
      const providerPlatformField = FIELD_CONSTANTS.providerPlatformField;
      const patientPlatformField = FIELD_CONSTANTS.patientPlatformField;
      const callDurationField = FIELD_CONSTANTS.callDurationField;
      const providerRatingField = FIELD_CONSTANTS.providerRatingField;
      const patientRatingField = FIELD_CONSTANTS.patientRatingField;
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

      const buildSummaryAggs = () => ({
        total_visits: {
          value_count: { field: timeField },
        },
        unique_accounts: {
          cardinality: { field: accountField },
        },
        unique_groups: {
          cardinality: { field: groupField },
        },
        unique_providers: {
          cardinality: { field: providerField },
        },
        unique_patients: {
          cardinality: { field: patientField },
        },
        avg_call_duration: {
          avg: { field: callDurationField },
        },
        sum_call_duration: {
          sum: { field: callDurationField },
        },
        provider_rating_count: {
          value_count: { field: providerRatingField },
        },
        avg_provider_rating: {
          avg: { field: providerRatingField },
        },
        patient_rating_count: {
          value_count: { field: patientRatingField },
        },
        avg_patient_rating: {
          avg: { field: patientRatingField },
        },
        subscription_distribution: {
          terms: {
            field: subscriptionField,
            size: AGGREGATION_LIMITS.MEDIUM,
          },
        },
        provider_platform_distribution: {
          terms: {
            field: providerPlatformField,
            size: AGGREGATION_LIMITS.MEDIUM,
          },
        },
        patient_platform_distribution: {
          terms: {
            field: patientPlatformField,
            size: AGGREGATION_LIMITS.MEDIUM,
          },
        },
      });

      let aggs: any;

      if (groupBy === 'none') {
        aggs = buildSummaryAggs();
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
            aggs: buildSummaryAggs(),
          },
        };
      }

      const query = {
        index,
        size: 0,
        body: {
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

      const processSummaryItem = (itemAggs: any): UsageSummaryItem => {
        const totalVisits = itemAggs?.total_visits?.value || 0;

        const subscriptionBuckets = itemAggs?.subscription_distribution?.buckets || [];
        const subscriptionDistribution = subscriptionBuckets.map((bucket: any) => ({
          subscription: bucket.key as string,
          count: bucket.doc_count || 0,
          percentage: totalVisits > 0 ? Math.round((bucket.doc_count / totalVisits) * 100 * 100) / 100 : 0,
        }));

        const providerPlatformBuckets = itemAggs?.provider_platform_distribution?.buckets || [];
        const providerPlatformDistribution = providerPlatformBuckets.map((bucket: any) => ({
          platform: bucket.key as string,
          count: bucket.doc_count || 0,
          percentage: totalVisits > 0 ? Math.round((bucket.doc_count / totalVisits) * 100 * 100) / 100 : 0,
        }));

        const patientPlatformBuckets = itemAggs?.patient_platform_distribution?.buckets || [];
        const patientPlatformDistribution = patientPlatformBuckets.map((bucket: any) => ({
          platform: bucket.key as string,
          count: bucket.doc_count || 0,
          percentage: totalVisits > 0 ? Math.round((bucket.doc_count / totalVisits) * 100 * 100) / 100 : 0,
        }));

        const avgCallDuration = itemAggs?.avg_call_duration?.value || null;
        const sumCallDuration = itemAggs?.sum_call_duration?.value || null;
        const totalCallDurationHours = sumCallDuration ? Math.round((sumCallDuration / 3600) * 100) / 100 : null;

        return {
          total_visits: totalVisits,
          unique_accounts: itemAggs?.unique_accounts?.value || 0,
          unique_groups: itemAggs?.unique_groups?.value || 0,
          unique_providers: itemAggs?.unique_providers?.value || 0,
          unique_patients: itemAggs?.unique_patients?.value || 0,
          avg_call_duration_seconds: avgCallDuration ? Math.round(avgCallDuration * 100) / 100 : null,
          total_call_duration_hours: totalCallDurationHours,
          provider_rating_count: itemAggs?.provider_rating_count?.value || 0,
          avg_provider_rating: itemAggs?.avg_provider_rating?.value ? Math.round(itemAggs.avg_provider_rating.value * 100) / 100 : null,
          patient_rating_count: itemAggs?.patient_rating_count?.value || 0,
          avg_patient_rating: itemAggs?.avg_patient_rating?.value ? Math.round(itemAggs.avg_patient_rating.value * 100) / 100 : null,
          subscription_distribution: subscriptionDistribution,
          provider_platform_distribution: providerPlatformDistribution,
          patient_platform_distribution: patientPlatformDistribution,
        };
      };

      let summary: UsageSummaryItem | UsageSummaryItem[];

      if (groupBy === 'none') {
        summary = processSummaryItem(responseAggs);
      } else {
        const valueKey = `${groupBy}_value`;
        const groupBuckets = responseAggs?.by_group?.buckets || [];
        summary = groupBuckets.map((bucket: any) => ({
          [valueKey]: bucket.key as string,
          ...processSummaryItem(bucket),
        }));
      }

      this.logger.info('Successfully retrieved usage summary', {
        groupBy,
        itemCount: Array.isArray(summary) ? summary.length : 1,
      });

      return {
        period: `${startDate} to ${endDate}`,
        startDate,
        endDate,
        groupBy,
        summary,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'ZodError') {
        throw new ValidationError('Invalid arguments for get_usage_summary', {
          details: error.message,
        });
      }

      if (error instanceof ValidationError) {
        throw error;
      }

      this.logger.error('Failed to get usage summary', {}, error as Error);
      throw new ElasticsearchError(
        'Failed to get usage summary from Elasticsearch',
        error as Error,
        { args }
      );
    }
  }
}

