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
  GetUsageProfileTool,
  FindEntitiesByMetricTool,
  GetUsageLeaderboardTool,
} from './tools/index.js';
import { BaseTool } from './tools/base-tool.js';

export class ElasticMCPServer {
  private server: Server;
  private config: ServerConfig;
  private logger: Logger;
  private elasticsearch: ElasticsearchManager;
  private errorHandler: ErrorHandler;
  private isShuttingDown = false;

  private tools: Map<string, BaseTool<any, any>> = new Map();

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

    this.initializeTools();
    this.setupHandlers();
    this.setupGracefulShutdown();
  }

  private initializeTools(): void {
    const tools = [
      new GetIndexFieldsTool(this.elasticsearch, this.logger),
      new TopChangeTool(this.elasticsearch, this.logger),
      new PeriodSummaryTool(this.elasticsearch, this.logger),
      new GetPlatformBreakdownTool(this.elasticsearch, this.logger),
      new GetRatingDistributionTool(this.elasticsearch, this.logger),
      new GetVisitTrendsTool(this.elasticsearch, this.logger),
      new GetUsageProfileTool(this.elasticsearch, this.logger),
      new FindEntitiesByMetricTool(this.elasticsearch, this.logger),
      new GetUsageLeaderboardTool(this.elasticsearch, this.logger),
    ];

    for (const tool of tools) {
      this.tools.set(tool.toolName, tool);
    }
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      this.logger.debug('Received list tools request');

      const toolDefinitions = Array.from(this.tools.values()).map(
        (tool) => tool.toolDefinition
      );

      return {
        tools: toolDefinitions,
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      this.logger.info('Tool call received', {
        toolName: name,
        hasArgs: !!args,
      });

      try {
        const tool = this.tools.get(name);

        if (!tool) {
          throw new Error(`Unknown tool: ${name}`);
        }

        const result = await tool.execute(args);

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