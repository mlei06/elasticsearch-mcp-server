
import { z } from 'zod';

export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, any>;
        required: string[];
        additionalProperties: boolean;
    };
}

/**
 * Converts a Zod schema to an MCP-compatible JSON schema for tool inputs.
 * Takes metadata from .describe() and validation constraints.
 */
export function zodToMcpToolSchema(schema: z.ZodObject<any> | z.ZodEffects<any>): ToolDefinition['inputSchema'] {
    // Unwrap effects (refinements/transforms) to get the underlying object schema
    let effectiveSchema: z.ZodTypeAny = schema;
    while (effectiveSchema instanceof z.ZodEffects) {
        effectiveSchema = effectiveSchema._def.schema;
    }

    if (!(effectiveSchema instanceof z.ZodObject)) {
        throw new Error(`Tool schema must be a ZodObject or ZodEffects wrapping a ZodObject. Got: ${effectiveSchema.constructor.name}`);
    }

    const shape = effectiveSchema.shape;
    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
        const fieldSchema = value as z.ZodTypeAny; // Helper cast
        const description = fieldSchema.description;

        // Determine type and constraints
        let type = 'string'; // default
        let enumValues: string[] | undefined;
        let minimum: number | undefined;
        let maximum: number | undefined;
        let defaultVal: any | undefined;
        let items: any | undefined;

        // Unwrap optional/default to get inner type
        let innerSchema = fieldSchema;
        let isOptional = false;

        // Handle Optional/Default wrappers loop
        while (innerSchema instanceof z.ZodOptional || innerSchema instanceof z.ZodDefault) {
            if (innerSchema instanceof z.ZodOptional) {
                isOptional = true;
                innerSchema = innerSchema.unwrap();
            } else if (innerSchema instanceof z.ZodDefault) {
                isOptional = true; // Defaults are effectively optional inputs
                defaultVal = innerSchema._def.defaultValue();
                innerSchema = innerSchema.removeDefault();
            }
        }

        // Inspect inner type
        if (innerSchema instanceof z.ZodString) {
            type = 'string';
        } else if (innerSchema instanceof z.ZodNumber) {
            type = 'number';
            if (innerSchema.minValue !== null) minimum = innerSchema.minValue;
            if (innerSchema.maxValue !== null) maximum = innerSchema.maxValue;
            // Int check? (Zod doesn't expose easily without checking checks array)
        } else if (innerSchema instanceof z.ZodBoolean) {
            type = 'boolean';
        } else if (innerSchema instanceof z.ZodEnum) {
            type = 'string';
            enumValues = innerSchema._def.values;
        } else if (innerSchema instanceof z.ZodArray) {
            type = 'array';
            // Simplified array handling (assuming object array for now based on known usage)
            if (innerSchema.element instanceof z.ZodObject) {
                items = {
                    type: 'object',
                    properties: zodToMcpToolSchema(innerSchema.element).properties,
                    required: zodToMcpToolSchema(innerSchema.element).required,
                    additionalProperties: false
                };
            } else {
                // Fallback for primitive arrays if needed, though mostly unused in current tools
                items = { type: 'string' };
            }
        }

        if (!isOptional) {
            required.push(key);
        }

        properties[key] = {
            type,
            description,
            ...(enumValues && { enum: enumValues }),
            ...(minimum !== undefined && { minimum }),
            ...(maximum !== undefined && { maximum }),
            ...(defaultVal !== undefined && { default: defaultVal }),
            ...(items && { items })
        };
    }

    return {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
    };
}
