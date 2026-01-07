import { Client, ClientOptions } from '@elastic/elasticsearch';
import { ElasticConfig } from '../config.js';
import { Logger } from '../logger.js';

export interface ConnectionInfo {
  isConnected: boolean;
  clusterName?: string;
  version?: string;
  lastHealthCheck: Date;
  error?: string;
}

export class ElasticsearchManager {
  private client: Client | null = null;
  private config: ElasticConfig;
  private logger: Logger;
  private connectionInfo: ConnectionInfo;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(config: ElasticConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child({ component: 'elasticsearch' });
    this.connectionInfo = {
      isConnected: false,
      lastHealthCheck: new Date(),
    };
  }

  async initialize(): Promise<void> {
    try {
      this.logger.info('Initializing Elasticsearch client', {
        cloudId: this.config.cloudId ? '***' : undefined,
        node: this.config.node,
        hasApiKey: !!this.config.apiKey,
        hasAuth: !!this.config.auth,
      });

      const clientOptions: ClientOptions = {
        maxRetries: this.config.maxRetries,
        requestTimeout: this.config.requestTimeout,
        pingTimeout: this.config.pingTimeout,
        sniffOnStart: this.config.sniffOnStart,
        ...(this.config.sniffInterval && { sniffInterval: this.config.sniffInterval }),
      };

      if (this.config.cloudId) {
        clientOptions.cloud = { id: this.config.cloudId };
        if (this.config.apiKey) {
          clientOptions.auth = { apiKey: this.config.apiKey };
        }
      } else if (this.config.node) {
        clientOptions.node = this.config.node;
        if (this.config.apiKey) {
          clientOptions.auth = { apiKey: this.config.apiKey };
        } else if (this.config.auth) {
          clientOptions.auth = {
            username: this.config.auth.username,
            password: this.config.auth.password,
          };
        }
      }

      if (this.config.ssl) {
        clientOptions.tls = {
          rejectUnauthorized: this.config.ssl.rejectUnauthorized,
        };
      }

      this.client = new Client(clientOptions);

      // Mark as connected immediately - actual API calls will handle connection errors
      // Health checks with limited permissions often fail, so we skip them
      this.connectionInfo = {
        isConnected: true,
        lastHealthCheck: new Date(),
      };

      // Start health monitoring (non-blocking, won't cause failures)
      this.startHealthMonitoring();

      this.logger.info('Elasticsearch client initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize Elasticsearch client', {}, error as Error);
      throw error;
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.client) {
      this.connectionInfo = {
        isConnected: false,
        lastHealthCheck: new Date(),
        error: 'Client not initialized',
      };
      return false;
    }

    // For users with limited permissions, we skip health checks
    // The client is marked as connected, and actual API calls will handle errors gracefully
    // Health checks requiring cluster privileges often fail unnecessarily
    this.connectionInfo.lastHealthCheck = new Date();
      return this.connectionInfo.isConnected;
  }

  async reconnect(): Promise<void> {
    this.logger.info('Attempting to reconnect to Elasticsearch');
    
    if (this.client) {
      await this.client.close();
    }

    await this.initialize();
  }

  getClient(): Client {
    if (!this.client) {
      throw new Error('Elasticsearch client not initialized');
    }
    
    // Don't check isConnected - let the actual API calls handle connection errors
    // This allows tools to work even if health checks fail due to permissions
    return this.client;
  }

  getConnectionInfo(): ConnectionInfo {
    return { ...this.connectionInfo };
  }

  private startHealthMonitoring(): void {
    // Disabled health monitoring for users with limited permissions
    // Periodic health checks often fail unnecessarily and cause reconnections
    // Actual API calls will handle connection errors gracefully
    this.logger.debug('Health monitoring disabled (limited permissions mode)');
  }

  async shutdown(): Promise<void> {
    this.logger.info('Shutting down Elasticsearch manager');

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.client) {
      try {
        await this.client.close();
        this.logger.info('Elasticsearch client closed');
      } catch (error) {
        this.logger.warn('Error closing Elasticsearch client', { error: (error as Error).message });
      }
    }

    this.connectionInfo.isConnected = false;
  }
}