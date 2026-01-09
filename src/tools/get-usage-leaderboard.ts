import { BaseTool } from './base-tool.js';
import { z } from 'zod';
import { FIELD_CONSTANTS } from '../utils/field-constants.js';
import { buildCommonFilters } from '../utils/query-helpers.js';
import { StandardResponse } from './types.js';

const GetUsageLeaderboardArgsSchema = z.object({
    entityType: z.enum([
        'account',
        'group',
        'provider_platform',
        'patient_platform',
        'provider_platform_version',
        'patient_platform_version',
    ]).describe('Type of entity to analyze'),
    mode: z.enum(['top_n', 'specific']).describe('Mode: "top_n" to find top entities by usage, "specific" to get usage for a specific entity'),
    limit: z.number().int().min(1).max(50).optional().default(10).describe('Max number of results (for top_n mode, default 10)'),
    entityValue: z.string().optional().describe('Specific entity name (required if mode is "specific")'),
    startDate: z.string().optional().describe('Start date (ISO or date math, default: now-30d)'),
    endDate: z.string().optional().describe('End date (ISO or date math, default: now)'),
    subscription: z.enum(['Enterprise', 'Premium', 'FVC', 'BVC', 'Plus']).optional().describe('Optional subscription filter'),
    orderBy: z.enum(['visit_count', 'unique_accounts', 'unique_groups', 'unique_providers', 'unique_patients']).default('visit_count').describe('Metric to order top N entities by (default: visit_count)'),
}).refine(data => {
    if (data.mode === 'specific' && !data.entityValue) {
        return false;
    }
    return true;
}, {
    message: "entityValue is required when mode is 'specific'",
    path: ['entityValue']
});

export type GetUsageLeaderboardArgs = z.infer<typeof GetUsageLeaderboardArgsSchema>;

export interface EntityUsageMetrics {
    entity: string;
    total_visits: number;
    unique_accounts: number;
    unique_groups: number;
    unique_providers: number;
    unique_patients: number;
    avg_patient_rating: number | null;
    avg_provider_rating: number | null;
    avg_call_duration: number | null;
}

export type GetUsageLeaderboardResult = StandardResponse<EntityUsageMetrics[]>;

export class GetUsageLeaderboardTool extends BaseTool<typeof GetUsageLeaderboardArgsSchema, GetUsageLeaderboardResult> {
    constructor(elasticsearch: any, logger: any) {
        super(elasticsearch, logger, 'elastic_get_usage_leaderboard');
    }

    get schema() {
        return GetUsageLeaderboardArgsSchema;
    }

    get description() {
        return 'Generate a ranked leaderboard of accounts, groups, or platforms based on a specific metric (e.g., "top 10 providers by visit count" or "top 5 groups by unique patients"). Best for identifying high-usage entities or outliers. Returns key metrics like visits, unique counts, ratings, and duration.';
    }

    protected async run(args: GetUsageLeaderboardArgs): Promise<GetUsageLeaderboardResult> {
        const limit = args.limit || 3;
        const orderBy = args.orderBy || 'visit_count';
        const { startIso: startDateIso, endIso: endDateIso } =
            this.resolveTimeRange(args.startDate, args.endDate, 'now-2w', 'now');

        this.logger.info('Executing usage leaderboard', {
            entityType: args.entityType,
            mode: args.mode,
            limit,
            orderBy,
            entityValue: args.entityValue,
        });

        const client = this.elasticsearch.getClient();
        const index = FIELD_CONSTANTS.index;
        const timeField = FIELD_CONSTANTS.timeField;

        // Determine field name based on entity type
        let fieldName: string;
        switch (args.entityType) {
            case 'account': fieldName = FIELD_CONSTANTS.accountField; break;
            case 'group': fieldName = FIELD_CONSTANTS.groupField; break;
            case 'provider_platform': fieldName = FIELD_CONSTANTS.providerPlatformField; break;
            case 'patient_platform': fieldName = FIELD_CONSTANTS.patientPlatformField; break;
            case 'provider_platform_version': fieldName = FIELD_CONSTANTS.providerPlatformVersionField; break;
            case 'patient_platform_version': fieldName = FIELD_CONSTANTS.patientPlatformVersionField; break;
            default: throw new Error(`Unknown entity type: ${args.entityType}`);
        }

        // Build filters using shared helper
        const filters = buildCommonFilters({
            startDate: startDateIso,
            endDate: endDateIso,
            subscription: args.subscription,
            excludeTestVisits: true
        });

        // Add tool-specific filters
        filters.push({ exists: { field: fieldName } });
        filters.push({ bool: { must_not: { term: { [fieldName]: '' } } } });

        // If specific mode, add specific filter
        if (args.mode === 'specific' && args.entityValue) {
            filters.push({ term: { [fieldName]: args.entityValue } });
        }

        // Build Aggregations
        const metricsAggs = {
            total_visits: { value_count: { field: timeField } },
            unique_accounts: { cardinality: { field: FIELD_CONSTANTS.accountField } },
            unique_groups: { cardinality: { field: FIELD_CONSTANTS.groupField } },
            unique_providers: { cardinality: { field: FIELD_CONSTANTS.providerField } },
            unique_patients: { cardinality: { field: FIELD_CONSTANTS.patientField } },
            avg_patient_rating: { avg: { field: FIELD_CONSTANTS.patientRatingField } },
            avg_provider_rating: { avg: { field: FIELD_CONSTANTS.providerRatingField } },
            avg_call_duration: { avg: { field: FIELD_CONSTANTS.callDurationField } }
        };

        let order: Record<string, 'asc' | 'desc'>;
        if (orderBy === 'visit_count') {
            order = { _count: 'desc' };
        } else {
            order = { [orderBy]: 'desc' };
        }

        let aggs: any;
        if (args.mode === 'specific') {
            aggs = {
                by_entity: {
                    terms: { field: fieldName, size: 1 },
                    aggs: metricsAggs
                }
            };
        } else {
            aggs = {
                by_entity: {
                    terms: {
                        field: fieldName,
                        size: limit,
                        order: order
                    },
                    aggs: metricsAggs
                }
            };
        }

        const query = {
            index,
            size: 0,
            body: {
                query: { bool: { filter: filters } },
                aggs
            }
        };

        const response = await client.search(query);
        const buckets = (response.aggregations as any)?.by_entity?.buckets || [];

        const results: EntityUsageMetrics[] = buckets.map((bucket: any) => ({
            entity: bucket.key,
            total_visits: bucket.doc_count,
            unique_accounts: bucket.unique_accounts.value,
            unique_groups: bucket.unique_groups.value,
            unique_providers: bucket.unique_providers.value,
            unique_patients: bucket.unique_patients.value,
            avg_patient_rating: bucket.avg_patient_rating.value ? Math.round(bucket.avg_patient_rating.value * 100) / 100 : null,
            avg_provider_rating: bucket.avg_provider_rating.value ? Math.round(bucket.avg_provider_rating.value * 100) / 100 : null,
            avg_call_duration: bucket.avg_call_duration.value ? Math.round(bucket.avg_call_duration.value * 100) / 100 : null,
        }));

        return this.buildResponse(results, {
            description: `${args.mode === 'top_n' ? `Top ${limit}` : 'Specific'} ${args.entityType} by ${orderBy} from ${startDateIso} to ${endDateIso}`,

            time: {
                start: startDateIso,
                end: endDateIso
            },
            visualization: {
                type: 'table',
                title: `${args.mode === 'top_n' ? `Top ${limit}` : 'Specific'} ${args.entityType} Usage`,
                description: `${startDateIso.split('T')[0]} to ${endDateIso.split('T')[0]}`,
                xAxisLabel: args.entityType,
                yAxisLabel: orderBy
            }
        });
    }
}
