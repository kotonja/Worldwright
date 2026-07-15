import { isDeepStrictEqual } from 'node:util';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface JsonCompatibilityIssue {
  readonly path: string;
  readonly reason: string;
}

export function compareCodePoints(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCodePoint = left.codePointAt(leftIndex)!;
    const rightCodePoint = right.codePointAt(rightIndex)!;
    if (leftCodePoint < rightCodePoint) return -1;
    if (leftCodePoint > rightCodePoint) return 1;
    leftIndex += leftCodePoint > 0xffff ? 2 : 1;
    rightIndex += rightCodePoint > 0xffff ? 2 : 1;
  }
  if (leftIndex < left.length) return 1;
  if (rightIndex < right.length) return -1;
  return 0;
}

export function escapePointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

export function appendPointer(path: string, segment: string): string {
  return `${path}/${escapePointerSegment(segment)}`;
}

function inspectValue(
  value: unknown,
  path: string,
  activeObjects: WeakSet<object>,
): JsonCompatibilityIssue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return undefined;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? undefined : { path, reason: 'numbers must be finite' };
  }
  if (typeof value === 'undefined') return { path, reason: 'undefined is not permitted' };
  if (typeof value === 'bigint') return { path, reason: 'BigInt is not permitted' };
  if (typeof value === 'symbol') return { path, reason: 'symbols are not permitted' };
  if (typeof value === 'function') return { path, reason: 'functions are not permitted' };

  if (activeObjects.has(value)) {
    return { path, reason: 'cyclic references are not permitted' };
  }
  activeObjects.add(value);

  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return { path, reason: 'array subclasses are not plain JSON arrays' };
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        return { path, reason: 'symbol-keyed properties are not permitted' };
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
          return {
            path: appendPointer(path, name),
            reason: 'custom array properties are not permitted',
          };
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        const childPath = appendPointer(path, String(index));
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined) {
          return { path: childPath, reason: 'sparse array holes are not permitted' };
        }
        if (!('value' in descriptor)) {
          return { path: childPath, reason: 'accessor properties are not permitted' };
        }
        const issue = inspectValue(descriptor.value, childPath, activeObjects);
        if (issue !== undefined) return issue;
      }
      return undefined;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { path, reason: 'class instances and built-in objects are not permitted' };
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return { path, reason: 'symbol-keyed properties are not permitted' };
    }
    for (const key of Object.getOwnPropertyNames(value).sort(compareCodePoints)) {
      const childPath = appendPointer(path, key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable) {
        return { path: childPath, reason: 'non-enumerable properties are not permitted' };
      }
      if (!('value' in descriptor)) {
        return { path: childPath, reason: 'accessor properties are not permitted' };
      }
      const issue = inspectValue(descriptor.value, childPath, activeObjects);
      if (issue !== undefined) return issue;
    }
    return undefined;
  } finally {
    activeObjects.delete(value);
  }
}

export function inspectJsonCompatibility(value: unknown): JsonCompatibilityIssue | undefined {
  return inspectValue(value, '', new WeakSet<object>());
}

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

export function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function canonicalizeJsonValue(value: JsonValue): JsonValue {
  if (typeof value === 'number') return Object.is(value, -0) ? 0 : value;
  if (value === null || typeof value !== 'object') return value;
  if (isJsonArray(value)) return value.map((item) => canonicalizeJsonValue(item));

  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort(compareCodePoints)) {
    result[key] = canonicalizeJsonValue(value[key]!);
  }
  return result;
}

export function stringifyCanonicalJson(value: JsonValue): string {
  return `${JSON.stringify(canonicalizeJsonValue(value), null, 2)}\n`;
}
