import { ElasticsearchManager } from '../elasticsearch/client.js';
import { Logger } from '../logger.js';
import { z } from 'zod';
import { ValidationError, ElasticsearchError } from '../errors/handlers.js';

const GetIndexFieldsArgsSchema = z.object({
  index: z.string().min(1).default('stats-*').describe('Index name or pattern (supports wildcards like stats-*). Defaults to "stats-*" if not specified. Only specify if you need fields from a different index.'),
  fieldFilter: z.string().optional().describe('Filter fields by name (case-insensitive partial match)'),
  typeFilter: z.string().optional().describe('Filter fields by type (e.g., "text", "keyword", "long", "date")'),
  includeNested: z.boolean().default(true).describe('Include nested fields in the results'),
}).strict();

export interface GetIndexFieldsArgs {
  index?: string;
  fieldFilter?: string;
  typeFilter?: string;
  includeNested?: boolean;
}

export interface FieldInfo {
  name: string;
  type: string;
  path: string;
}

export interface GetIndexFieldsResult {
  index: string;
  fields: FieldInfo[];
  total: number;
}

export class GetIndexFieldsTool {
  private elasticsearch: ElasticsearchManager;
  private logger: Logger;

  constructor(elasticsearch: ElasticsearchManager, logger: Logger) {
    this.elasticsearch = elasticsearch;
    this.logger = logger.child({ tool: 'get-index-fields' });
  }

  async execute(args: unknown): Promise<GetIndexFieldsResult> {
    try {
      const validatedArgs = GetIndexFieldsArgsSchema.parse(args);
      
      const index = validatedArgs.index || 'stats-*';
      
      this.logger.info('Getting index fields', {
        index,
        fieldFilter: validatedArgs.fieldFilter,
        typeFilter: validatedArgs.typeFilter,
        includeNested: validatedArgs.includeNested,
      });

      const client = this.elasticsearch.getClient();

      const response = await client.indices.getMapping({
        index,
      });

      const fields: FieldInfo[] = [];
      const fieldFilterLower = validatedArgs.fieldFilter?.toLowerCase();
      const typeFilterLower = validatedArgs.typeFilter?.toLowerCase();

      for (const [, indexMapping] of Object.entries(response)) {
        const properties = indexMapping.mappings?.properties || {};
        this.extractFields(
          properties,
          fields,
          '',
          validatedArgs.includeNested ?? true,
          fieldFilterLower,
          typeFilterLower
        );
      }

      fields.sort((a, b) => a.path.localeCompare(b.path));

      this.logger.info('Successfully retrieved index fields', {
        index,
        count: fields.length,
      });

      return {
        index,
        fields,
        total: fields.length,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'ZodError') {
        throw new ValidationError('Invalid arguments for get_index_fields', {
          details: error.message,
        });
      }

      if (error instanceof ValidationError) {
        throw error;
      }

      this.logger.error('Failed to get index fields', {}, error as Error);
      throw new ElasticsearchError(
        'Failed to get index fields from Elasticsearch',
        error as Error,
        { args }
      );
    }
  }

  private extractFields(
    properties: Record<string, any>,
    fields: FieldInfo[],
    prefix: string,
    includeNested: boolean,
    fieldFilter?: string,
    typeFilter?: string
  ): void {
    for (const [fieldName, fieldMapping] of Object.entries(properties)) {
      const fullPath = prefix ? `${prefix}.${fieldName}` : fieldName;
      const fieldType = fieldMapping.type || 'object';

      if (fieldFilter && !fullPath.toLowerCase().includes(fieldFilter)) {
        if (fieldMapping.properties && includeNested) {
          this.extractFields(
            fieldMapping.properties,
            fields,
            fullPath,
            includeNested,
            fieldFilter,
            typeFilter
          );
        }
        continue;
      }

      if (typeFilter && fieldType.toLowerCase() !== typeFilter) {
        if (fieldMapping.properties && includeNested) {
          this.extractFields(
            fieldMapping.properties,
            fields,
            fullPath,
            includeNested,
            fieldFilter,
            typeFilter
          );
        }
        continue;
      }

      if (fieldType && fieldType !== 'object' && fieldType !== 'nested') {
        fields.push({
          name: fieldName,
          type: fieldType,
          path: fullPath,
        });
      }

      if (fieldMapping.properties && includeNested) {
        this.extractFields(
          fieldMapping.properties,
          fields,
          fullPath,
          includeNested,
          fieldFilter,
          typeFilter
        );
      }
    }
  }
}

