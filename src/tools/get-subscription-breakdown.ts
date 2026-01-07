import { ElasticsearchManager } from '../elasticsearch/client.js';
import { Logger } from '../logger.js';
import { z } from 'zod';
import { ValidationError, ElasticsearchError } from '../errors/handlers.js';
import { AGGREGATION_LIMITS } from '../utils/aggregation-limits.js';
import { FIELD_CONSTANTS } from '../utils/field-constants.js';

const PeriodSummaryArgsSchema = z.object({
  startDate: z.string().optional().describe('Start date in ISO format (YYYY-MM-DD) or date math (e.g., "now-30d", "now-1y"). Defaults to "now-30d"'),
  endDate: z.string().optional().describe('End date in ISO format (YYYY-MM-DD) or date math (e.g., "now"). Defaults to "now"'),
}).strict();

export interface PeriodSummaryArgs {
  startDate?: string;
  endDate?: string;
}

export interface SubscriptionMetrics {
  subscription: string;
  count_records: number;
  unique_accounts: number;
  unique_providers: number;
  unique_patients: number;
  avg_call_duration: number | null;
  avg_provider_rating: number | null;
  provider_rating_count: number;
  avg_patient_rating: number | null;
  patient_rating_count: number;
}

export interface PeriodSummaryResult {
  startDate: string;
  endDate: string;
  subscriptions: SubscriptionMetrics[];
  total_records: number;
  total_unique_accounts: number;
  total_unique_providers: number;
  total_unique_patients: number;
}

export class PeriodSummaryTool {
  private elasticsearch: ElasticsearchManager;
  private logger: Logger;

  constructor(elasticsearch: ElasticsearchManager, logger: Logger) {
    this.elasticsearch = elasticsearch;
    this.logger = logger.child({ tool: 'get-subscription-breakdown' });
  }

  async execute(args: unknown): Promise<PeriodSummaryResult> {
    try {
      const validatedArgs = PeriodSummaryArgsSchema.parse(args);
      
      let startDate = validatedArgs.startDate || 'now-30d';
      let endDate = validatedArgs.endDate || 'now';
      
      this.logger.info('Getting subscription breakdown', {
        startDate,
        endDate,
      });

      const client = this.elasticsearch.getClient();

      const index = FIELD_CONSTANTS.index;
      const timeField = FIELD_CONSTANTS.timeField;
      const testVisitField = FIELD_CONSTANTS.testVisitField;
      const subscriptionField = FIELD_CONSTANTS.subscriptionField;
      const accountField = FIELD_CONSTANTS.accountField;
      const providerField = FIELD_CONSTANTS.providerField;
      const patientField = FIELD_CONSTANTS.patientField;
      const callDurationField = FIELD_CONSTANTS.callDurationField;
      const providerRatingField = FIELD_CONSTANTS.providerRatingField;
      const patientRatingField = FIELD_CONSTANTS.patientRatingField;
      const meetingBasedField = FIELD_CONSTANTS.meetingBasedField;

      const query = {
        index,
        size: 0,
        body: {
          query: {
            bool: {
              filter: [
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
              ],
            },
          },
          aggs: {
            by_subscription: {
              terms: {
                field: subscriptionField,
                size: AGGREGATION_LIMITS.MEDIUM,
              },
              aggs: {
                count_records: {
                  value_count: { field: timeField },
                },
                unique_accounts: {
                  cardinality: { field: accountField },
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
                avg_provider_rating: {
                  avg: { field: providerRatingField },
                },
                provider_rating_count: {
                  value_count: { field: providerRatingField },
                },
                avg_patient_rating: {
                  avg: { field: patientRatingField },
                },
                patient_rating_count: {
                  value_count: { field: patientRatingField },
                },
              },
            },
          },
        },
      };

      this.logger.debug('Executing query', { query: JSON.stringify(query, null, 2) });

      const response = await client.search(query);

      const subscriptions: SubscriptionMetrics[] = [];
      const bySubscriptionAgg = response.aggregations?.by_subscription as any;
      const buckets = bySubscriptionAgg?.buckets || [];

      let totalRecords = 0;
      let totalUniqueAccounts = 0;
      let totalUniqueProviders = 0;
      let totalUniquePatients = 0;

      for (const bucket of buckets) {
        const subscription = bucket.key as string;
        const countRecords = bucket.count_records?.value || 0;
        const uniqueAccounts = bucket.unique_accounts?.value || 0;
        const uniqueProviders = bucket.unique_providers?.value || 0;
        const uniquePatients = bucket.unique_patients?.value || 0;
        const avgCallDuration = bucket.avg_call_duration?.value || null;
        const avgProviderRating = bucket.avg_provider_rating?.value || null;
        const providerRatingCount = bucket.provider_rating_count?.value || 0;
        const avgPatientRating = bucket.avg_patient_rating?.value || null;
        const patientRatingCount = bucket.patient_rating_count?.value || 0;

        subscriptions.push({
          subscription,
          count_records: countRecords,
          unique_accounts: uniqueAccounts,
          unique_providers: uniqueProviders,
          unique_patients: uniquePatients,
          avg_call_duration: avgCallDuration ? Math.round(avgCallDuration * 100) / 100 : null,
          avg_provider_rating: avgProviderRating ? Math.round(avgProviderRating * 100) / 100 : null,
          provider_rating_count: providerRatingCount,
          avg_patient_rating: avgPatientRating ? Math.round(avgPatientRating * 100) / 100 : null,
          patient_rating_count: patientRatingCount,
        });

        totalRecords += countRecords;
        totalUniqueAccounts += uniqueAccounts;
        totalUniqueProviders += uniqueProviders;
        totalUniquePatients += uniquePatients;
      }

      // Note: Total unique counts are approximations (sum of per-subscription uniques).
      // For exact totals, would need top-level aggregations, but per-subscription counts are accurate.

      this.logger.info('Successfully retrieved subscription breakdown', {
        subscriptionCount: subscriptions.length,
        totalRecords,
      });

      return {
        startDate,
        endDate,
        subscriptions,
        total_records: totalRecords,
        total_unique_accounts: totalUniqueAccounts,
        total_unique_providers: totalUniqueProviders,
        total_unique_patients: totalUniquePatients,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'ZodError') {
        throw new ValidationError('Invalid arguments for get_subscription_breakdown', {
          details: error.message,
        });
      }

      if (error instanceof ValidationError) {
        throw error;
      }

      this.logger.error('Failed to get period summary', {}, error as Error);
      throw new ElasticsearchError(
        'Failed to get period summary from Elasticsearch',
        error as Error,
        { args }
      );
    }
  }
}

