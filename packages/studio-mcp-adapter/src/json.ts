import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { compareCodePoints } from './diagnostics.js';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface JsonCompatibilityIssue {
  readonly path: string;
  readonly reason: string;
}

function pointer(path: string, segment: string): string {
  return `${path}/${segment.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function inspect(
  value: unknown,
  path: string,
  active: WeakSet<object>,
): JsonCompatibilityIssue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? undefined : { path, reason: 'numbers must be finite' };
  }
  if (typeof value === 'undefined') return { path, reason: 'undefined is not permitted' };
  if (typeof value === 'bigint') return { path, reason: 'BigInt is not permitted' };
  if (typeof value === 'symbol') return { path, reason: 'symbols are not permitted' };
  if (typeof value === 'function') return { path, reason: 'functions are not permitted' };
  if (active.has(value)) return { path, reason: 'cyclic references are not permitted' };
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return { path, reason: 'array subclasses are not permitted' };
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        return { path, reason: 'symbol properties are not permitted' };
      }
      for (const name of Object.getOwnPropertyNames(value)) {
        if (name === 'length') continue;
        const index = Number(name);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          String(index) !== name ||
          index >= value.length
        ) {
          return { path: pointer(path, name), reason: 'custom array properties are not permitted' };
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        const childPath = pointer(path, String(index));
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined)
          return { path: childPath, reason: 'sparse arrays are not permitted' };
        if (!descriptor.enumerable)
          return { path: childPath, reason: 'non-enumerable properties are not permitted' };
        if (!('value' in descriptor))
          return { path: childPath, reason: 'accessors are not permitted' };
        const issue = inspect(descriptor.value, childPath, active);
        if (issue !== undefined) return issue;
      }
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { path, reason: 'class instances and built-in objects are not permitted' };
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return { path, reason: 'symbol properties are not permitted' };
    }
    for (const key of Object.getOwnPropertyNames(value).sort(compareCodePoints)) {
      const childPath = pointer(path, key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable) {
        return { path: childPath, reason: 'non-enumerable properties are not permitted' };
      }
      if (!('value' in descriptor))
        return { path: childPath, reason: 'accessors are not permitted' };
      const issue = inspect(descriptor.value, childPath, active);
      if (issue !== undefined) return issue;
    }
    return undefined;
  } finally {
    active.delete(value);
  }
}

export function inspectJsonCompatibility(value: unknown): JsonCompatibilityIssue | undefined {
  try {
    return inspect(value, '', new WeakSet<object>());
  } catch {
    return { path: '', reason: 'the value could not be safely inspected' };
  }
}

export function canonicalizeJsonValue(value: JsonValue): JsonValue {
  if (typeof value === 'number') return Object.is(value, -0) ? 0 : value;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => canonicalizeJsonValue(entry));
  const output: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort(compareCodePoints)) {
    output[key] = canonicalizeJsonValue((value as Readonly<Record<string, JsonValue>>)[key]!);
  }
  return output;
}

export function stringifyCanonicalJson(value: JsonValue): string {
  return `${JSON.stringify(canonicalizeJsonValue(value), null, 2)}\n`;
}

export function hashCanonicalJson(value: JsonValue): string {
  return createHash('sha256').update(stringifyCanonicalJson(value), 'utf8').digest('hex');
}

export function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

export function cloneJson<T>(value: T): T {
  return structuredClone(value);
}
