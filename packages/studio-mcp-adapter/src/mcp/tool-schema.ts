import { Buffer } from 'node:buffer';

import { inspectJsonCompatibility } from '../json.js';

export interface DiscoveredMcpTool {
  readonly name: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

const MAX_TOOL_SCHEMA_DEPTH = 32;
const MAX_TOOL_SCHEMA_NODES = 16_384;
const MAX_TOOL_SCHEMA_STRING_BYTES = 1024 * 1024;
const MAX_TOOL_SCHEMA_COLLECTION_SIZE = 1024;
const SCHEMA_ANNOTATION_KEYS = new Set([
  '$comment',
  '$id',
  '$schema',
  'default',
  'deprecated',
  'description',
  'examples',
  'readOnly',
  'title',
  'writeOnly',
]);

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isWithinToolSchemaBudget(value: unknown): boolean {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let stringBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_TOOL_SCHEMA_NODES || current.depth > MAX_TOOL_SCHEMA_DEPTH) return false;
    if (typeof current.value === 'string') {
      stringBytes += Buffer.byteLength(current.value, 'utf8');
      if (stringBytes > MAX_TOOL_SCHEMA_STRING_BYTES) return false;
      continue;
    }
    if (current.value === null || typeof current.value !== 'object') continue;
    if (seen.has(current.value)) return false;
    seen.add(current.value);
    const names = Object.getOwnPropertyNames(current.value);
    if (names.length > MAX_TOOL_SCHEMA_COLLECTION_SIZE + 1) return false;
    for (const name of names) {
      if (name === 'length' && Array.isArray(current.value)) continue;
      stringBytes += Buffer.byteLength(name, 'utf8');
      if (stringBytes > MAX_TOOL_SCHEMA_STRING_BYTES) return false;
      const descriptor = Object.getOwnPropertyDescriptor(current.value, name);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        return false;
      }
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  return true;
}

export function readStudioMcpToolListEnvelope(value: unknown): readonly unknown[] | undefined {
  if (
    !isWithinToolSchemaBudget(value) ||
    inspectJsonCompatibility(value) !== undefined ||
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'tools') ||
    !Array.isArray(value.tools)
  ) {
    return undefined;
  }
  return value.tools;
}

export function readDiscoveredTools(value: unknown): readonly DiscoveredMcpTool[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length > 512 ||
    !isWithinToolSchemaBudget(value) ||
    inspectJsonCompatibility(value) !== undefined
  ) {
    return undefined;
  }

  const tools: DiscoveredMcpTool[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !isRecord(entry.inputSchema)) {
      return undefined;
    }
    if (entry.name.length === 0 || entry.name.length > 128 || entry.inputSchema.type !== 'object') {
      return undefined;
    }
    tools.push({ name: entry.name, inputSchema: entry.inputSchema });
  }
  return tools;
}

export function objectSchemaProperties(
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  const properties = schema.properties;
  return properties === undefined ? {} : isRecord(properties) ? properties : undefined;
}

export function objectSchemaRequires(
  schema: Readonly<Record<string, unknown>>,
  propertyName: string,
): boolean {
  return isStringArray(schema.required) && schema.required.includes(propertyName);
}

export function objectSchemaHasSupportedEnvelope(
  schema: Readonly<Record<string, unknown>>,
): boolean {
  const allowed = new Set([
    ...SCHEMA_ANNOTATION_KEYS,
    'additionalProperties',
    'properties',
    'required',
    'type',
  ]);
  return (
    hasOnlyKeys(schema, allowed) &&
    schema.type === 'object' &&
    (schema.additionalProperties === undefined ||
      typeof schema.additionalProperties === 'boolean') &&
    (schema.properties === undefined || isRecord(schema.properties)) &&
    (schema.required === undefined || isStringArray(schema.required))
  );
}

export function schemaAcceptsString(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.type === 'string' && hasOnlyKeys(value, new Set([...SCHEMA_ANNOTATION_KEYS, 'type']))
  );
}

export function schemaAcceptsExactString(value: unknown, expected: string): boolean {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    ...SCHEMA_ANNOTATION_KEYS,
    'const',
    'enum',
    'maxLength',
    'minLength',
    'pattern',
    'type',
  ]);
  if (
    !hasOnlyKeys(value, allowed) ||
    (value.type !== undefined && value.type !== 'string') ||
    (value.type === undefined && value.const === undefined && value.enum === undefined)
  ) {
    return false;
  }
  if (value.const !== undefined && value.const !== expected) return false;
  if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.includes(expected))) {
    return false;
  }
  if (
    value.minLength !== undefined &&
    (!Number.isSafeInteger(value.minLength) || expected.length < (value.minLength as number))
  ) {
    return false;
  }
  if (
    value.maxLength !== undefined &&
    (!Number.isSafeInteger(value.maxLength) || expected.length > (value.maxLength as number))
  ) {
    return false;
  }
  if (value.pattern !== undefined) {
    if (typeof value.pattern !== 'string') return false;
    try {
      if (!new RegExp(value.pattern, 'u').test(expected)) return false;
    } catch {
      return false;
    }
  }
  return value.type === 'string' || value.const === expected || Array.isArray(value.enum);
}
