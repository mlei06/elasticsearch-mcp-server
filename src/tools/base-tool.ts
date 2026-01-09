import { z } from 'zod';
import { ElasticsearchManager } from '../elasticsearch/client.js';
import { Logger } from '../logger.js';
import { StandardResponse } from './types.js';
import { resolveDate } from '../utils/date-math.js';
import { ValidationError, ElasticsearchError } from '../errors/handlers.js';
import { zodToMcpToolSchema, ToolDefinition } from '../utils/schema-converter.js';

export abstract class BaseTool<TArgs extends z.ZodTypeAny, TResult> {
    protected elasticsearch: ElasticsearchManager;
    protected logger: Logger;
    public readonly toolName: string;

    constructor(elasticsearch: ElasticsearchManager, logger: Logger, toolName: string) {
        this.elasticsearch = elasticsearch;
        this.logger = logger.child({ tool: toolName });
        this.toolName = toolName;
    }

    abstract get schema(): TArgs;
    abstract get description(): string;

    get toolDefinition(): ToolDefinition {
        return {
            name: this.toolName,
            description: this.description,
            inputSchema: zodToMcpToolSchema(this.schema as any),
        };
    }

    protected abstract run(args: z.output<TArgs>): Promise<TResult>;

    async execute(args: unknown): Promise<TResult> {
        try {
            const validatedArgs = this.schema.parse(args);
            return await this.run(validatedArgs);
        } catch (error) {
            if (error instanceof Error && error.name === 'ZodError') {
                throw new ValidationError(`Invalid arguments for ${this.toolName}`, {
                    details: error.message,
                });
            }

            if (error instanceof ValidationError || error instanceof ElasticsearchError) {
                throw error;
            }

            this.logger.error(`Failed to execute ${this.toolName}`, {}, error as Error);

            // Check if this is a ResponseError from Elasticsearch client
            if (error && typeof error === 'object' && 'body' in error) {
                throw ElasticsearchError.fromResponseError(error, this.toolName, args);
            }

            throw new ElasticsearchError(
                `Failed to execute ${this.toolName}`,
                error as Error,
                { args }
            );
        }
    }

    protected resolveTimeRange(
        startDate: string | undefined,
        endDate: string | undefined,
        defaultStart: string = 'now-30d',
        defaultEnd: string = 'now'
    ): { startIso: string; endIso: string, start: string, end: string } {
        const start = startDate || defaultStart;
        const end = endDate || defaultEnd;

        const resolvedStart = resolveDate(start);
        const resolvedEnd = resolveDate(end);

        return {
            startIso: resolvedStart.toISOString(),
            endIso: resolvedEnd.toISOString(),
            start,
            end
        };
    }

    protected buildResponse<TData>(
        data: TData,
        meta: {
            description?: string;
            time?: {
                start: string;
                end: string;
                interval?: string;
                previousStart?: string;
                previousEnd?: string;
            };
            visualization: {
                type: StandardResponse<TData>['meta']['visualization']['type'];
                title: string;
                description?: string;
                xAxisLabel?: string;
                yAxisLabel?: string;
            };
        }
    ): StandardResponse<TData> {
        // Auto-generate description if not provided
        if (!meta.visualization.description && meta.time) {
            meta.visualization.description = `${meta.time.start.split('T')[0]} to ${meta.time.end.split('T')[0]}`;
        }

        return {
            data,
            meta: {
                tool: this.toolName,
                description: meta.description || `Results from ${this.toolName}`,
                time: meta.time || { start: '', end: '' },
                visualization: meta.visualization
            }
        };
    }
}
