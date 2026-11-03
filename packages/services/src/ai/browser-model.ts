import { z } from 'zod';
import { generateText, jsonSchema, Output, type JSONSchema7 } from 'ai';
import type { BrowserModelRequestSchema } from './browser-schemas';
import { evidenceBudgetTokens, getInferenceModel } from './models/inference';
import { browserModelRequestSchema } from './browser-schemas';

const allowedSchemaKeywords = new Set([
  '$schema',
  'title',
  'description',
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'additionalProperties',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'format',
  'pattern',
]);
const allowedSchemaTypes = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);
const supportedStringPatterns = new Set([
  z.toJSONSchema(z.iso.date()).pattern,
  z.toJSONSchema(z.iso.datetime({ offset: true })).pattern,
  '^\\d{2}:\\d{2}(?::\\d{2})?$',
  '^\\d+-\\d+$',
]);
const maximumSchemaDepth = 7;
const maximumSchemaNodes = 400;
const maximumOutputDepth = 8;
const maximumOutputBytes = 80_000;

type JsonSchemaNode = Record<string, unknown> | boolean;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const normalizeSchema = (value: unknown): void => {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(normalizeSchema);
    return;
  }
  const node = value as Record<string, unknown>;
  const intersectionTypes = Array.isArray(node.allOf)
    ? [
        ...new Set(
          node.allOf.flatMap((child) =>
            isPlainRecord(child) && typeof child.type === 'string'
              ? [child.type]
              : [],
          ),
        ),
      ]
    : [];
  // Zod's JSON-schema roundtrip adds empty intersections to formatted strings.
  if (
    Array.isArray(node.allOf) &&
    node.allOf.every(
      (child) =>
        isPlainRecord(child) &&
        Object.entries(child).every(
          ([key, field]) =>
            key === 'type' && field === (node.type ?? intersectionTypes[0]),
        ),
    ) &&
    intersectionTypes.length <= 1
  ) {
    if (node.type === undefined && intersectionTypes.length)
      node.type = intersectionTypes[0];
    delete node.allOf;
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === 'properties' && isPlainRecord(child))
      Object.values(child).forEach(normalizeSchema);
    else if (key === 'items' || key === 'anyOf' || key === 'oneOf')
      normalizeSchema(child);
  }
};

const validateSchemaDefinition = (schema: unknown) => {
  let nodeCount = 0;
  const visit = (node: unknown, depth: number): node is JsonSchemaNode => {
    nodeCount += 1;
    if (nodeCount > maximumSchemaNodes || depth > maximumSchemaDepth)
      return false;
    if (typeof node === 'boolean') return true;
    if (!isPlainRecord(node)) return false;
    if (Object.keys(node).some((key) => !allowedSchemaKeywords.has(key)))
      return false;
    if (
      (typeof node.title === 'string' && node.title.length > 100) ||
      (typeof node.description === 'string' && node.description.length > 1000)
    )
      return false;
    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (
        types.length === 0 ||
        types.length > 4 ||
        types.some(
          (type) => typeof type !== 'string' || !allowedSchemaTypes.has(type),
        )
      )
        return false;
    }
    if (
      node.format !== undefined &&
      !['uri', 'date', 'date-time'].includes(String(node.format))
    )
      return false;
    // Only application-generated date/time patterns may reach regex evaluation.
    if (
      node.pattern !== undefined &&
      !supportedStringPatterns.has(String(node.pattern))
    )
      return false;
    if (node.properties !== undefined) {
      if (
        !isPlainRecord(node.properties) ||
        Object.keys(node.properties).length > 80
      )
        return false;
      for (const child of Object.values(node.properties))
        if (!visit(child, depth + 1)) return false;
    }
    if (node.required !== undefined) {
      if (
        !Array.isArray(node.required) ||
        node.required.length > 80 ||
        node.required.some(
          (name) =>
            typeof name !== 'string' ||
            !isPlainRecord(node.properties) ||
            !(name in node.properties),
        )
      )
        return false;
    }
    if (node.items !== undefined && !visit(node.items, depth + 1)) return false;
    for (const key of ['anyOf', 'oneOf'] as const) {
      if (node[key] === undefined) continue;
      if (
        !Array.isArray(node[key]) ||
        node[key].length === 0 ||
        node[key].length > 8 ||
        !node[key].every((child) => visit(child, depth + 1))
      )
        return false;
    }
    if (
      node.additionalProperties !== undefined &&
      typeof node.additionalProperties !== 'boolean'
    )
      return false;
    for (const key of [
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
    ] as const) {
      const value = node[key];
      if (
        value !== undefined &&
        (!Number.isInteger(value) ||
          Number(value) < 0 ||
          Number(value) > (key.endsWith('Items') ? 200 : 20_000))
      )
        return false;
    }
    for (const key of [
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
    ] as const) {
      const value = node[key];
      if (value !== undefined && typeof value !== 'number') return false;
    }
    if (node.enum !== undefined) {
      if (!Array.isArray(node.enum) || node.enum.length > 100) return false;
    }
    if (node.const !== undefined && JSON.stringify(node.const).length > 10_000)
      return false;
    return true;
  };

  let serialized: string;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    return false;
  }
  return (
    serialized.length <= 20_000 &&
    visit(schema, 0) &&
    isPlainRecord(schema) &&
    schema.type === 'object'
  );
};

const matchesType = (value: unknown, type: string) => {
  switch (type) {
    case 'object':
      return isPlainRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
  }
};

const matchesSchema = (
  value: unknown,
  schema: JsonSchemaNode,
  depth = 0,
): boolean => {
  if (depth > maximumOutputDepth) return false;
  if (typeof schema === 'boolean') return schema;
  if (
    schema.type !== undefined &&
    !(Array.isArray(schema.type)
      ? schema.type.some((type) => matchesType(value, String(type)))
      : matchesType(value, String(schema.type)))
  )
    return false;
  if (
    schema.enum !== undefined &&
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))
  )
    return false;
  if (
    schema.const !== undefined &&
    JSON.stringify(schema.const) !== JSON.stringify(value)
  )
    return false;
  if (
    Array.isArray(schema.anyOf) &&
    !schema.anyOf.some((item) =>
      matchesSchema(value, item as JsonSchemaNode, depth + 1),
    )
  )
    return false;
  if (
    Array.isArray(schema.oneOf) &&
    schema.oneOf.filter((item) =>
      matchesSchema(value, item as JsonSchemaNode, depth + 1),
    ).length !== 1
  )
    return false;
  if (Array.isArray(value)) {
    if (
      value.length > 200 ||
      (typeof schema.minItems === 'number' && value.length < schema.minItems) ||
      (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
    )
      return false;
    if (
      schema.items !== undefined &&
      !value.every((item) =>
        matchesSchema(item, schema.items as JsonSchemaNode, depth + 1),
      )
    )
      return false;
  }
  if (typeof value === 'string') {
    if (
      typeof schema.pattern === 'string' &&
      !new RegExp(schema.pattern).test(value)
    )
      return false;
    if (schema.format === 'uri' && !z.url().safeParse(value).success)
      return false;
    if (schema.format === 'date' && !z.iso.date().safeParse(value).success)
      return false;
    if (
      schema.format === 'date-time' &&
      !z.iso.datetime({ offset: true }).safeParse(value).success
    )
      return false;
    if (
      value.length > 20_000 ||
      (typeof schema.minLength === 'number' &&
        value.length < schema.minLength) ||
      (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
    )
      return false;
  }
  if (typeof value === 'number') {
    if (
      (typeof schema.minimum === 'number' && value < schema.minimum) ||
      (typeof schema.maximum === 'number' && value > schema.maximum) ||
      (typeof schema.exclusiveMinimum === 'number' &&
        value <= schema.exclusiveMinimum) ||
      (typeof schema.exclusiveMaximum === 'number' &&
        value >= schema.exclusiveMaximum)
    )
      return false;
  }
  if (isPlainRecord(value) && isPlainRecord(schema.properties)) {
    const properties = schema.properties;
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some((name) => typeof name !== 'string' || !(name in value)))
      return false;
    if (
      schema.additionalProperties === false &&
      Object.keys(value).some((key) => !(key in properties))
    )
      return false;
    for (const [key, childSchema] of Object.entries(properties)) {
      if (
        key in value &&
        !matchesSchema(value[key], childSchema as JsonSchemaNode, depth + 1)
      )
        return false;
    }
  }
  return true;
};

export const generateBrowserModel = async (
  input: unknown,
  signal: AbortSignal,
) => {
  signal.throwIfAborted();
  const parsed = browserModelRequestSchema.safeParse(input);
  if (!parsed.success)
    throw new Error('The Stagehand browser request uses unsupported content.');
  const request: BrowserModelRequestSchema = parsed.data;
  request.responseFormat.schema = structuredClone(
    request.responseFormat.schema,
  );
  normalizeSchema(request.responseFormat.schema);
  if (!validateSchemaDefinition(request.responseFormat.schema)) {
    throw new Error('The Stagehand browser response schema is unsupported.');
  }
  const schema = request.responseFormat.schema as JSONSchema7;
  const { output } = await generateText({
    model: getInferenceModel(),
    ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
    messages: request.messages.map((message) => ({
      role: message.role,
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => part.text).join(''),
    })),
    output: Output.object({
      schema: jsonSchema(schema, {
        validate: (value) =>
          matchesSchema(value, schema as JsonSchemaNode)
            ? { success: true, value }
            : {
                success: false,
                error: new Error(
                  'The generated response did not match its schema.',
                ),
              },
      }),
      name: request.responseFormat.name,
      ...(request.responseFormat.description
        ? { description: request.responseFormat.description }
        : {}),
    }),
    temperature: 0,
    reasoning: 'low',
    maxOutputTokens: evidenceBudgetTokens,
    abortSignal: signal,
    maxRetries: 0,
    telemetry: { isEnabled: false },
  });
  signal.throwIfAborted();
  if (
    !matchesSchema(output, schema as JsonSchemaNode) ||
    JSON.stringify(output).length > maximumOutputBytes
  )
    throw new Error('The generated browser response did not match its schema.');
  const text = JSON.stringify(output);
  return {
    role: 'assistant' as const,
    content: { type: 'text' as const, text },
    outputFormat: 'json_schema' as const,
    structuredContent: output,
  };
};
