import { ElasticsearchManager } from '../elasticsearch/client.js';
import { Logger } from '../logger.js';
import { z } from 'zod';
import { ValidationError, ElasticsearchError } from '../errors/handlers.js';
import { FIELD_CONSTANTS } from '../utils/field-constants.js';

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

export interface GetUsageLeaderboardArgs {
    entityType: 'account' | 'group' | 'provider_platform' | 'patient_platform' | 'provider_platform_version' | 'patient_platform_version';
    mode: 'top_n' | 'specific';
    limit?: number;
    entityValue?: string;
    startDate?: string;
    endDate?: string;
    subscription?: string;
    orderBy?: 'visit_count' | 'unique_accounts' | 'unique_groups' | 'unique_providers' | 'unique_patients';
}

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

export interface GetUsageLeaderboardResult {
    entityType: string;
    mode: string;
    startDate: string;
    endDate: string;
    orderBy: string;
    results: EntityUsageMetrics[];
}

export class GetUsageLeaderboardTool {
    private elasticsearch: ElasticsearchManager;
    private logger: Logger;

    constructor(elasticsearch: ElasticsearchManager, logger: Logger) {
        this.elasticsearch = elasticsearch;
        this.logger = logger.child({ tool: 'get-usage-leaderboard' });
    }

    async execute(args: unknown): Promise<GetUsageLeaderboardResult> {
        try {
            const validatedArgs = GetUsageLeaderboardArgsSchema.parse(args);
            const limit = validatedArgs.limit || 10;
            const startDate = validatedArgs.startDate || 'now-30d';
            const endDate = validatedArgs.endDate || 'now';
            const orderBy = validatedArgs.orderBy || 'visit_count';

            this.logger.info('Executing usage leaderboard', {
                entityType: validatedArgs.entityType,
                mode: validatedArgs.mode,
                limit,
                orderBy,
                entityValue: validatedArgs.entityValue,
            });

            const client = this.elasticsearch.getClient();
            const index = FIELD_CONSTANTS.index;
            const timeField = FIELD_CONSTANTS.timeField;

            // Determine field name based on entity type
            let fieldName: string;
            switch (validatedArgs.entityType) {
                case 'account': fieldName = FIELD_CONSTANTS.accountField; break;
                case 'group': fieldName = FIELD_CONSTANTS.groupField; break;
                case 'provider_platform': fieldName = FIELD_CONSTANTS.providerPlatformField; break;
                case 'patient_platform': fieldName = FIELD_CONSTANTS.patientPlatformField; break;
                case 'provider_platform_version': fieldName = FIELD_CONSTANTS.providerPlatformVersionField; break;
                case 'patient_platform_version': fieldName = FIELD_CONSTANTS.patientPlatformVersionField; break;
                default: throw new Error(`Unknown entity type: ${validatedArgs.entityType}`);
            }

            // Build filters
            const filters: any[] = [
                { range: { [timeField]: { gte: startDate, lt: endDate } } },
                { term: { [FIELD_CONSTANTS.testVisitField]: 'No' } },
                { exists: { field: fieldName } }, // Ensure entity field exists
                { bool: { must_not: { term: { [fieldName]: '' } } } } // Exclude empty values
            ];

            if (validatedArgs.subscription) {
                filters.push({ term: { [FIELD_CONSTANTS.subscriptionField]: validatedArgs.subscription } });
            }

            // If specific mode, add specific filter
            if (validatedArgs.mode === 'specific' && validatedArgs.entityValue) {
                filters.push({ term: { [fieldName]: validatedArgs.entityValue } });
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
                // Sort by the sub-aggregation (metricsAggs keys)
                // For 'visit_count' we could also use 'total_visits' but _count is more standard/efficient for doc count
                // For distinct counts, use the metric name directly
                order = { [orderBy]: 'desc' };
            }

            let aggs: any;
            if (validatedArgs.mode === 'specific') {
                // For specific mode, we can just aggregate at the top level, 
                // BUT to keep return format consistent, let's group by the term (which will be just one bucket)
                aggs = {
                    by_entity: {
                        terms: { field: fieldName, size: 1 },
                        aggs: metricsAggs
                    }
                };
            } else {
                // Top N
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

            return {
                entityType: validatedArgs.entityType,
                mode: validatedArgs.mode,
                startDate,
                endDate,
                orderBy,
                results
            };

        } catch (error) {
            if (error instanceof Error && error.name === 'ZodError') {
                throw new ValidationError('Invalid arguments', { details: error.message });
            }
            throw new ElasticsearchError('Failed to get usage leaderboard', error as Error, { args });
        }
    }
}
