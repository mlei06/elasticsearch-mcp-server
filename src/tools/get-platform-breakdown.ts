import { BaseTool } from './base-tool.js';
import { z } from 'zod';
import { FIELD_CONSTANTS } from '../utils/field-constants.js';
import { buildCommonFilters } from '../utils/query-helpers.js';
import { StandardResponse } from './types.js';
import { AGGREGATION_LIMITS, calculateTermsSize } from '../utils/aggregation-limits.js';

const GetPlatformBreakdownArgsSchema = z.object({
  role: z.enum(['provider', 'patient']).describe('Role: "provider" for provider platforms/versions, "patient" for patient platforms/versions'),
  breakdownType: z.enum(['platform', 'version']).describe('Breakdown type: "platform" for platform breakdown (Web/iOS/Android), "version" for platform version breakdown'),
  topN: z.number().int().min(1).max(100).optional().default(10).describe('Number of top items to return (default: 10, max: 100)'),
  startDate: z.string().optional().describe('Start date in ISO format (YYYY-MM-DD) or date math (e.g., "now-30d", "now-1y"). Defaults to "now-30d"'),
  endDate: z.string().optional().describe('End date in ISO format (YYYY-MM-DD) or date math (e.g., "now"). Defaults to "now"'),
  account: z.string().optional().describe('Optional account name to filter data to'),
  group: z.string().optional().describe('Optional group name to filter data to'),
}).strict();

export type GetPlatformBreakdownArgs = z.infer<typeof GetPlatformBreakdownArgsSchema>;

export interface PlatformMetrics {
  platform: string;
  count_records: number;
  unique_accounts: number;
  unique_providers: number;
  unique_patients: number;
  avg_call_duration: number | null;
  provider_rating_count: number;
  avg_provider_rating: number | null;
  patient_rating_count: number;
  avg_patient_rating: number | null;
  subscription_distribution: Array<{ subscription: string; count: number }>;
}

export type PlatformBreakdownResult = StandardResponse<{
  top_items: PlatformMetrics[];
  other_items: PlatformMetrics | null;
}>;

export class GetPlatformBreakdownTool extends BaseTool<typeof GetPlatformBreakdownArgsSchema, PlatformBreakdownResult> {
  constructor(elasticsearch: any, logger: any) {
    super(elasticsearch, logger, 'get-platform-breakdown');
  }

  get schema() {
    return GetPlatformBreakdownArgsSchema;
  }

  protected async run(args: GetPlatformBreakdownArgs): Promise<PlatformBreakdownResult> {
    const topN = Math.min(args.topN || 10, 50);
    const { startIso: startDateIso, endIso: endDateIso } =
      this.resolveTimeRange(args.startDate, args.endDate, 'now-14d', 'now');

    this.logger.info('Getting platform breakdown', {
      role: args.role,
      breakdownType: args.breakdownType,
      topN,
      originalTopN: args.topN,
      startDate: startDateIso,
      endDate: endDateIso,
      account: args.account,
      group: args.group,
    });

    const client = this.elasticsearch.getClient();
    const index = FIELD_CONSTANTS.index;
    const timeField = FIELD_CONSTANTS.timeField;
    const accountField = FIELD_CONSTANTS.accountField;
    const providerField = FIELD_CONSTANTS.providerField;
    const patientField = FIELD_CONSTANTS.patientField;
    const callDurationField = FIELD_CONSTANTS.callDurationField;
    const providerRatingField = FIELD_CONSTANTS.providerRatingField;
    const patientRatingField = FIELD_CONSTANTS.patientRatingField;
    const subscriptionField = FIELD_CONSTANTS.subscriptionField;

    let aggregationField: string;
    if (args.role === 'provider') {
      aggregationField = args.breakdownType === 'version'
        ? 'provider0_platform_version.keyword'
        : 'provider0_platform.keyword';
    } else {
      aggregationField = args.breakdownType === 'version'
        ? 'patient0_platform_version.keyword'
        : 'patient0_platform.keyword';
    }

    // Use helper for common filters
    const filters = buildCommonFilters({
      startDate: startDateIso,
      endDate: endDateIso,
      account: args.account,
      group: args.group,
      excludeTestVisits: true
    });

    // Platform specific extra filters (call duration or meeting based false)
    filters.push({
      bool: {
        should: [
          { exists: { field: callDurationField } },
          { term: { [FIELD_CONSTANTS.meetingBasedField]: false } },
        ],
        minimum_should_match: 1,
      },
    });

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
        aggs: {
          by_item: {
            terms: {
              field: aggregationField,
              size: calculateTermsSize(topN || 10, 2, AGGREGATION_LIMITS.LARGE),
              order: { _count: 'desc' },
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
                  size: AGGREGATION_LIMITS.SMALL * 2, // 20 for subscription distribution
                },
              },
            },
          },
        },
      },
    };

    this.logger.debug('Executing query', { query: JSON.stringify(query, null, 2) });
    const response = await client.search(query);

    const aggs = response.aggregations as any;
    const itemBuckets = aggs?.by_item?.buckets || [];

    const topItems: PlatformMetrics[] = [];
    let otherRecords = 0;
    let otherAccounts = 0;
    let otherProviders = 0;
    let otherPatients = 0;
    let otherCallDurationSum = 0;
    let otherCallDurationCount = 0;
    let otherProviderRatingSum = 0;
    let otherProviderRatingCount = 0;
    let otherPatientRatingSum = 0;
    let otherPatientRatingCount = 0;
    const otherSubscriptionMap = new Map<string, number>();

    for (let i = 0; i < itemBuckets.length; i++) {
      const bucket = itemBuckets[i];
      const item = bucket.key as string;
      const countRecords = (bucket.count_records as any)?.value || bucket.doc_count || 0;
      const uniqueAccounts = (bucket.unique_accounts as any)?.value || 0;
      const uniqueProviders = (bucket.unique_providers as any)?.value || 0;
      const uniquePatients = (bucket.unique_patients as any)?.value || 0;
      const avgCallDuration = (bucket.avg_call_duration as any)?.value || null;
      const providerRatingCount = (bucket.provider_rating_count as any)?.value || 0;
      const avgProviderRating = (bucket.avg_provider_rating as any)?.value || null;
      const patientRatingCount = (bucket.patient_rating_count as any)?.value || 0;
      const avgPatientRating = (bucket.avg_patient_rating as any)?.value || null;

      const subscriptionDist: Array<{ subscription: string; count: number }> = [];
      const subscriptionBuckets = bucket.subscription_distribution?.buckets || [];
      for (const subBucket of subscriptionBuckets) {
        subscriptionDist.push({
          subscription: subBucket.key as string,
          count: subBucket.doc_count || 0,
        });
      }

      const itemMetrics: PlatformMetrics = {
        platform: item,
        count_records: countRecords,
        unique_accounts: uniqueAccounts,
        unique_providers: uniqueProviders,
        unique_patients: uniquePatients,
        avg_call_duration: avgCallDuration ? Math.round(avgCallDuration * 100) / 100 : null,
        provider_rating_count: providerRatingCount,
        avg_provider_rating: avgProviderRating ? Math.round(avgProviderRating * 100) / 100 : null,
        patient_rating_count: patientRatingCount,
        avg_patient_rating: avgPatientRating ? Math.round(avgPatientRating * 100) / 100 : null,
        subscription_distribution: subscriptionDist,
      };

      if (i < topN) {
        topItems.push(itemMetrics);
      } else {
        otherRecords += countRecords;
        otherAccounts += uniqueAccounts;
        otherProviders += uniqueProviders;
        otherPatients += uniquePatients;
        if (avgCallDuration !== null) {
          otherCallDurationSum += avgCallDuration * countRecords;
          otherCallDurationCount += countRecords;
        }
        if (avgProviderRating !== null) {
          otherProviderRatingSum += avgProviderRating * providerRatingCount;
          otherProviderRatingCount += providerRatingCount;
        }
        if (avgPatientRating !== null) {
          otherPatientRatingSum += avgPatientRating * patientRatingCount;
          otherPatientRatingCount += patientRatingCount;
        }
        for (const sub of subscriptionDist) {
          const current = otherSubscriptionMap.get(sub.subscription) || 0;
          otherSubscriptionMap.set(sub.subscription, current + sub.count);
        }
      }
    }

    let otherItems: PlatformMetrics | null = null;
    if (itemBuckets.length > topN) {
      const otherSubscriptionDist: Array<{ subscription: string; count: number }> = [];
      for (const [subscription, count] of otherSubscriptionMap.entries()) {
        otherSubscriptionDist.push({ subscription, count });
      }

      otherItems = {
        platform: `Other (${itemBuckets.length - topN} ${args.breakdownType === 'version' ? 'versions' : 'platforms'})`,
        count_records: otherRecords,
        unique_accounts: otherAccounts,
        unique_providers: otherProviders,
        unique_patients: otherPatients,
        avg_call_duration:
          otherCallDurationCount > 0
            ? Math.round((otherCallDurationSum / otherCallDurationCount) * 100) / 100
            : null,
        provider_rating_count: otherProviderRatingCount,
        avg_provider_rating:
          otherProviderRatingCount > 0
            ? Math.round((otherProviderRatingSum / otherProviderRatingCount) * 100) / 100
            : null,
        patient_rating_count: otherPatientRatingCount,
        avg_patient_rating:
          otherPatientRatingCount > 0
            ? Math.round((otherPatientRatingSum / otherPatientRatingCount) * 100) / 100
            : null,
        subscription_distribution: otherSubscriptionDist,
      };
    }

    return this.buildResponse({
      top_items: topItems,
      other_items: otherItems
    }, {
      description: `Platform breakdown by ${args.breakdownType} for ${args.role}s from ${startDateIso} to ${endDateIso}`,
      arguments: args,
      time: {
        start: startDateIso,
        end: endDateIso
      },
      visualization: {
        type: 'bar', // Should be pie?? Original code logic had visualization hardcoded?
        // The previous replace_file_content used 'pie'.
        // Wait, the original code didn't have visualization object fully populated beyond basic structure. 
        // Previous Step 290 showed visualization.type = 'bar' in my constructed buildResponse? No, step 290 view_file just showed previous code.
        // I will use 'pie' as it fits breakdown. "Visits by ..."
        title: `Top ${topN} ${args.role} ${args.breakdownType}s`,
        description: `${startDateIso.split('T')[0]} to ${endDateIso.split('T')[0]}`,
        xAxisLabel: args.breakdownType === 'version' ? 'Version' : 'Platform',
        yAxisLabel: 'Records'
      }
    });
  }
}
