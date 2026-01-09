import { BaseTool } from './base-tool.js';
import { z } from 'zod';
import { ElasticsearchManager } from '../elasticsearch/client.js';
import { Logger } from '../logger.js';

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

export class GetIndexFieldsTool extends BaseTool<typeof GetIndexFieldsArgsSchema, GetIndexFieldsResult> {
  constructor(elasticsearch: ElasticsearchManager, logger: Logger) {
    super(elasticsearch, logger, 'elastic_get_index_fields');
  }

  get schema() {
    return GetIndexFieldsArgsSchema;
  }

  get description() {
    return 'Get all fields from an Elasticsearch index with optional filtering by field name and type. Use this tool when you need to discover available fields, their types, and correct field names before constructing queries. This is especially useful when unsure about field names or when looking for fields with specific types (e.g., keyword fields for exact matches or text fields for full-text search). ⚠️ IMPORTANT: Do NOT specify the index parameter unless the user explicitly requests fields from a different index. The tool defaults to "stats-*" which covers all standard indices.';
  }

  protected async run(args: z.output<typeof GetIndexFieldsArgsSchema>): Promise<GetIndexFieldsResult> {
    const index = args.index || 'stats-*';

    this.logger.info('Getting index fields', {
      index,
      fieldFilter: args.fieldFilter,
      includeNested: args.includeNested,
    });

    const client = this.elasticsearch.getClient();

    const response = await client.indices.getMapping({
      index,
    });

    const fields: FieldInfo[] = [];
    const fieldFilterLower = args.fieldFilter?.toLowerCase();
    const typeFilterLower = args.typeFilter?.toLowerCase();

    for (const [, indexMapping] of Object.entries(response)) {
      const properties = (indexMapping as any).mappings?.properties || {};
      this.extractFields(
        properties,
        fields,
        '',
        args.includeNested ?? true,
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
