import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { loadConfig, ServerConfig } from './config.js';
import { Logger } from './logger.js';
import { ElasticsearchManager } from './elasticsearch/client.js';
import { ErrorHandler } from './errors/handlers.js';
import {
  GetIndexFieldsTool,
  TopChangeTool,
  PeriodSummaryTool,
  GetPlatformBreakdownTool,
  GetRatingDistributionTool,
  GetVisitTrendsTool,
  GetUsageSummaryTool,
  FindEntitiesByMetricTool,
} from './tools/index.js';

export class ElasticMCPServer {
  private server: Server;
  private config: ServerConfig;
  private logger: Logger;
  private elasticsearch: ElasticsearchManager;
  private errorHandler: ErrorHandler;
  private isShuttingDown = false;

  private getIndexFieldsTool: GetIndexFieldsTool;
  private topChangeTool: TopChangeTool;
  private periodSummaryTool: PeriodSummaryTool;
  private getPlatformBreakdownTool: GetPlatformBreakdownTool;
  private getRatingDistributionTool: GetRatingDistributionTool;
  private getVisitTrendsTool: GetVisitTrendsTool;
  private getUsageSummaryTool: GetUsageSummaryTool;
  private findEntitiesByMetricTool: FindEntitiesByMetricTool;

  constructor() {
    this.config = loadConfig();
    this.logger = new Logger(this.config.logging.level, this.config.logging.format);
    this.errorHandler = new ErrorHandler(this.logger);
    this.elasticsearch = new ElasticsearchManager(this.config.elasticsearch, this.logger);

    this.server = new Server(
      {
        name: this.config.name,
        version: this.config.version,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.getIndexFieldsTool = new GetIndexFieldsTool(this.elasticsearch, this.logger);
    this.topChangeTool = new TopChangeTool(this.elasticsearch, this.logger);
    this.periodSummaryTool = new PeriodSummaryTool(this.elasticsearch, this.logger);
    this.getPlatformBreakdownTool = new GetPlatformBreakdownTool(this.elasticsearch, this.logger);
    this.getRatingDistributionTool = new GetRatingDistributionTool(this.elasticsearch, this.logger);
    this.getVisitTrendsTool = new GetVisitTrendsTool(this.elasticsearch, this.logger);
    this.getUsageSummaryTool = new GetUsageSummaryTool(this.elasticsearch, this.logger);
    this.findEntitiesByMetricTool = new FindEntitiesByMetricTool(this.elasticsearch, this.logger);

    this.setupHandlers();
    this.setupGracefulShutdown();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      this.logger.debug('Received list tools request');
      
      return {
        tools: [
          {
            name: 'get_index_fields',
            description: 'Get all fields from an Elasticsearch index with optional filtering by field name and type. Use this tool when you need to discover available fields, their types, and correct field names before constructing queries. This is especially useful when unsure about field names or when looking for fields with specific types (e.g., keyword fields for exact matches or text fields for full-text search). ⚠️ IMPORTANT: Do NOT specify the index parameter unless the user explicitly requests fields from a different index. The tool defaults to "stats-*" which covers all standard indices. Only include the index parameter if the user specifically mentions a different index name.',
            inputSchema: {
              type: 'object',
              properties: {
                index: {
                  type: 'string',
                  description: 'Index name or pattern (supports wildcards like stats-*). Defaults to "stats-*" if not specified. Only specify if you need fields from a different index.',
                  default: 'stats-*',
                },
                fieldFilter: {
                  type: 'string',
                  description: 'Filter fields by name (case-insensitive partial match)',
                },
                typeFilter: {
                  type: 'string',
                  description: 'Filter fields by type (e.g., "text", "keyword", "long", "date")',
                },
                includeNested: {
                  type: 'boolean',
                  description: 'Include nested fields in the results',
                  default: true,
                },
              },
              required: [],
              additionalProperties: false,
            },
          },
          {
            name: 'top_change',
            description: 'Find top N accounts or groups with highest visit/usage increase or decrease between two consecutive time periods. Returns items ranked by change with current period count, previous period count, absolute change, and percentage change. The previous period is automatically calculated to match the duration of the current period, ending where the current period starts. Supports filtering by subscription tier.',
            inputSchema: {
              type: 'object',
              properties: {
                groupBy: {
                  type: 'string',
                  enum: ['account', 'group'],
                  description: 'Group by: "account" to find top accounts by visit change, "group" to find top groups by visit change',
                },
                direction: {
                  type: 'string',
                  enum: ['increase', 'decrease'],
                  description: 'Direction: "increase" for highest growth, "decrease" for highest decline',
                },
                topN: {
                  type: 'number',
                  minimum: 1,
                  maximum: 50,
                  default: 5,
                  description: 'Number of top items to return (default: 5, max: 50)',
                },
                startDate: {
                  type: 'string',
                  description: 'Start date for current period in ISO format (YYYY-MM-DD) or date math (e.g., "now-30d", "now-1y"). Defaults to "now-30d"',
                },
                endDate: {
                  type: 'string',
                  description: 'End date for current period in ISO format (YYYY-MM-DD) or date math (e.g., "now"). Defaults to "now"',
                },
                subscription: {
                  type: 'string',
                  enum: ['Enterprise', 'Premium', 'FVC', 'BVC', 'Plus'],
                  description: 'Optional subscription tier to filter by',
                },
              },
              required: ['groupBy', 'direction'],
              additionalProperties: false,
            },
          },
          {
            name: 'get_subscription_breakdown',
            description: 'Compare subscription tiers (Enterprise, Premium, FVC, BVC, Plus) across a time period. Always returns metrics grouped by subscription tier with per-tier breakdown (visits, accounts, providers, patients, ratings, call duration) plus totals.',
            inputSchema: {
              type: 'object',
              properties: {
                startDate: {
                  type: 'string',
                  description: 'Start date in ISO format (YYYY-MM-DD) or date math (e.g., "now-30d", "now-1y"). Defaults to "now-30d"',
                },
                endDate: {
                  type: 'string',
                  description: 'End date in ISO format (YYYY-MM-DD) or date math (e.g., "now"). Defaults to "now"',
                },
              },
              required: [],
              additionalProperties: false,
            },
          },
          {
            name: 'get_platform_breakdown',
            description: 'Get breakdown of top N platforms or platform versions by usage over a time period, can optionally be filtered by account or group. Supports both provider and patient roles. Returns top N items (default 10) plus "Other" category if needed, with metrics per item including visit counts, unique accounts/providers/patients, ratings, and call duration.',
            inputSchema: {
              type: 'object',
              properties: {
                role: {
                  type: 'string',
                  enum: ['provider', 'patient'],
                  description: 'Role: "provider" for provider platforms/versions, "patient" for patient platforms/versions',
                },
                breakdownType: {
                  type: 'string',
                  enum: ['platform', 'version'],
                  description: 'Breakdown type: "platform" for platform breakdown (Web/iOS/Android), "version" for platform version breakdown',
                },
                topN: {
                  type: 'number',
                  minimum: 1,
                  maximum: 100,
                  default: 10,
                  description: 'Number of top items to return (default: 10, max: 100). Recommended: do not set over 10.',
                },
                startDate: {
                  type: 'string',
                  description: 'Start date. Format: ISO date (YYYY-MM-DD) or date math (now-30d, now-1y). Default: now-30d.',
                },
                endDate: {
                  type: 'string',
                  description: 'End date. Format: ISO date (YYYY-MM-DD) or date math (now). Default: now.',
                },
                account: {
                  type: 'string',
                  description: 'Optional account name to filter data to',
                },
                group: {
                  type: 'string',
                  description: 'Optional group name to filter data to',
                },
              },
              required: ['role', 'breakdownType'],
              additionalProperties: false,
            },
          },
          {
            name: 'get_rating_distribution',
            description: 'Get rating distribution (histogram) for provider and/or patient ratings over a time period. Returns rating buckets with counts and percentages, plus statistics (average, min, max, total count). Supports grouping by subscription, account, or group for comparative analysis.',
            inputSchema: {
              type: 'object',
              properties: {
                ratingType: {
                  type: 'string',
                  enum: ['provider', 'patient', 'both'],
                  description: 'Type of rating to analyze: "provider", "patient", or "both"',
                },
                bucketSize: {
                  type: 'number',
                  minimum: 1,
                  maximum: 5,
                  default: 1,
                  description: 'Rating bucket size (default: 1, e.g., 1 = 1-2, 2-3, 3-4, etc.)',
                },
                startDate: {
                  type: 'string',
                  description: 'Start date. Format: ISO date (YYYY-MM-DD) or date math (now-30d, now-1y). Default: now-30d.',
                },
                endDate: {
                  type: 'string',
                  description: 'End date. Format: ISO date (YYYY-MM-DD) or date math (now). Default: now.',
                },
                account: {
                  type: 'string',
                  description: 'Optional account name to filter by',
                },
                group: {
                  type: 'string',
                  description: 'Optional group name to filter by',
                },
                subscription: {
                  type: 'string',
                  enum: ['Enterprise', 'Premium', 'FVC', 'BVC', 'Plus'],
                  description: 'Optional subscription tier to filter by',
                },
                groupBy: {
                  type: 'string',
                  enum: ['none', 'subscription', 'account', 'group'],
                  default: 'none',
                  description: 'Optional grouping dimension (default: none). When set, returns separate distributions for each group value.',
                },
              },
              required: ['ratingType'],
              additionalProperties: false,
            },
          },
          {
            name: 'get_visit_trends',
            description: 'Get visit/usage count trends over time (daily, weekly, or monthly intervals) with optional grouping by subscription, account, or group. Returns time series data points with visit counts and unique counts (accounts, providers, patients) per period.',
            inputSchema: {
              type: 'object',
              properties: {
                interval: {
                  type: 'string',
                  enum: ['daily', 'weekly', 'monthly'],
                  description: 'Time interval for trends: "weekly"(recommended max 12 weeks), or "monthly" (recommended max 12 months)',
                },
                startDate: {
                  type: 'string',
                  description: 'Start date in ISO format (YYYY-MM-DD) or date math (e.g., "now-14d", "now-12w", "now-12M"). Recommended: "now-14d" for daily, "now-12w" for weekly, "now-12M" for monthly. Defaults to "now-180d" (6 months).',
                },
                endDate: {
                  type: 'string',
                  description: 'End date in ISO format (YYYY-MM-DD) or date math (e.g., "now"). Defaults to "now"',
                },
                groupBy: {
                  type: 'string',
                  enum: ['none', 'subscription', 'account', 'group'],
                  default: 'none',
                  description: 'Optional grouping dimension (default: none)',
                },
                account: {
                  type: 'string',
                  description: 'Optional account name to filter by',
                },
                group: {
                  type: 'string',
                  description: 'Optional group name to filter by',
                },
                subscription: {
                  type: 'string',
                  enum: ['Enterprise', 'Premium', 'FVC', 'BVC', 'Plus'],
                  description: 'Optional subscription tier to filter by',
                },
              },
              required: ['interval'],
              additionalProperties: false,
            },
          },
          {
            name: 'get_usage_summary',
            description: 'Get usage summary for a time period, can optionally be filtered by account, group, or subscription. Returns visits, unique counts, ratings, call duration plus distribution breakdowns (subscription tiers, provider platforms, patient platforms).',
            inputSchema: {
              type: 'object',
              properties: {
                startDate: {
                  type: 'string',
                  description: 'Start date. Format: ISO date (YYYY-MM-DD) or date math (now-30d, now-1y). Default: now-30d.',
                },
                endDate: {
                  type: 'string',
                  description: 'End date. Format: ISO date (YYYY-MM-DD) or date math (now). Default: now.',
                },
                account: {
                  type: 'string',
                  description: 'FILTER: Optional account name to filter data to',
                },
                group: {
                  type: 'string',
                  description: 'FILTER: Optional group name to filter data to',
                },
                subscription: {
                  type: 'string',
                  description: 'FILTER: Optional subscription tier to filter data to',
                  enum: ['Enterprise', 'Premium', 'FVC', 'BVC', 'Plus'],
                },
                groupBy: {
                  type: 'string',
                  enum: ['none', 'subscription', 'account', 'group'],
                  default: 'none',
                  description: 'GROUP: Dimension to split/group results by (e.g., "account" to see summaries per account, "group" to see per group)',
                },
              },
              required: [],
              additionalProperties: false,
            },
          },
          {
            name: 'find_entities_by_metric',
            description: 'Find groups or accounts filtered by metrics. Supports single metric (legacy) or multiple metrics (recommended). Available metrics: account_count (groups only), visit_count, provider_rating, patient_rating, avg_call_duration, unique_providers, unique_patients, provider_rating_count, patient_rating_count. Can filter accounts by group. Returns entities matching ALL criteria with their metric values.',
            inputSchema: {
              type: 'object',
              properties: {
                entityType: {
                  type: 'string',
                  enum: ['group', 'account'],
                  description: 'Type of entity to find: "group" to find groups, "account" to find accounts',
                },
                metric: {
                  type: 'string',
                  enum: ['account_count', 'visit_count', 'provider_rating', 'patient_rating', 'avg_call_duration', 'unique_providers', 'unique_patients', 'provider_rating_count', 'patient_rating_count'],
                  description: 'Single metric to filter by (use metrics array for multiple filters). Available: account_count (groups only), visit_count, provider_rating, patient_rating, avg_call_duration, unique_providers, unique_patients, provider_rating_count, patient_rating_count',
                },
                min: {
                  type: 'number',
                  description: 'Minimum value when using single metric (use metrics array for multiple filters)',
                },
                max: {
                  type: 'number',
                  description: 'Maximum value when using single metric (use metrics array for multiple filters)',
                },
                metrics: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      metric: {
                        type: 'string',
                        enum: ['account_count', 'visit_count', 'provider_rating', 'patient_rating', 'avg_call_duration', 'unique_providers', 'unique_patients', 'provider_rating_count', 'patient_rating_count'],
                        description: 'Metric name',
                      },
                      min: {
                        type: 'number',
                        description: 'Minimum value (inclusive)',
                      },
                      max: {
                        type: 'number',
                        description: 'Maximum value (inclusive)',
                      },
                    },
                    required: ['metric'],
                    additionalProperties: false,
                  },
                  description: 'Array of metric filters. Use this for filtering by multiple metrics simultaneously. Each filter requires metric and at least one of min/max.',
                },
                startDate: {
                  type: 'string',
                  description: 'Start date in ISO format (YYYY-MM-DD) or date math (e.g., "now-30d", "now-1y"). Defaults to "now-1y"',
                },
                endDate: {
                  type: 'string',
                  description: 'End date in ISO format (YYYY-MM-DD) or date math (e.g., "now"). Defaults to "now"',
                },
                subscription: {
                  type: 'string',
                  enum: ['Enterprise', 'Premium', 'FVC', 'BVC', 'Plus'],
                  description: 'Optional subscription tier to filter by',
                },
                group: {
                  type: 'string',
                  description: 'Optional group name to filter by (only valid when entityType="account")',
                },
                limit: {
                  type: 'number',
                  minimum: 1,
                  maximum: 500,
                  default: 10,
                  description: 'Maximum number of results to return (default: 10, max: 500). Recommended: do not set over 10.',
                },
              },
              required: ['entityType'],
              additionalProperties: false,
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      
      this.logger.info('Tool call received', {
        toolName: name,
        hasArgs: !!args,
      });

      try {
        // Don't check connection status - let the actual API calls handle connection errors
        // Connection checks often fail with limited permissions unnecessarily

        let result: unknown;
        
        switch (name) {
          case 'get_index_fields':
            result = await this.getIndexFieldsTool.execute(args);
            break;
          case 'top_change':
            result = await this.topChangeTool.execute(args);
            break;
          case 'get_subscription_breakdown':
            result = await this.periodSummaryTool.execute(args);
            break;
          case 'get_platform_breakdown':
            result = await this.getPlatformBreakdownTool.execute(args);
            break;
          case 'get_rating_distribution':
            result = await this.getRatingDistributionTool.execute(args);
            break;
          case 'get_visit_trends':
            result = await this.getVisitTrendsTool.execute(args);
            break;
          case 'get_usage_summary':
            result = await this.getUsageSummaryTool.execute(args);
            break;
          case 'find_entities_by_metric':
            result = await this.findEntitiesByMetricTool.execute(args);
            break;
          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorResponse = this.errorHandler.handleError(error, 'call-tool');
        this.logger.error('Tool call failed', {
          toolName: name,
          error: errorResponse.error,
        });

        return {
          content: [
            {
              type: 'text',
              text: `Error: ${errorResponse.error.message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (): Promise<void> => {
      if (this.isShuttingDown) {
        return;
      }

      this.isShuttingDown = true;
      this.logger.info('Graceful shutdown initiated');

      try {
        await this.elasticsearch.shutdown();
        this.logger.info('Elasticsearch manager shut down');
      } catch (error) {
        this.logger.error('Error during Elasticsearch shutdown', {}, error as Error);
      }

      this.logger.info('Server shutdown complete');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    process.on('uncaughtException', (error) => {
      this.logger.error('Uncaught exception', {}, error);
      shutdown().catch(() => process.exit(1));
    });

    process.on('unhandledRejection', (reason) => {
      this.logger.error('Unhandled rejection', {
        reason: String(reason),
      });
      shutdown().catch(() => process.exit(1));
    });
  }

  async start(): Promise<void> {
    try {
      this.logger.info('Starting Elastic MCP Server', {
        version: this.config.version,
        logLevel: this.config.logging.level,
      });

      await this.elasticsearch.initialize();
      this.logger.info('Elasticsearch connection established');

      const transport = new StdioServerTransport();
      await this.server.connect(transport);

      this.logger.info('MCP server started successfully');
    } catch (error) {
      this.logger.error('Failed to start server', {}, error as Error);
      throw error;
    }
  }
}

export default ElasticMCPServer;