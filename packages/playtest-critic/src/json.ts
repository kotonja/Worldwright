export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonCompatibilityFailure {
  readonly path: string;
  readonly reason: string;
}

export function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if ('value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function inspect(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): JsonCompatibilityFailure | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined;
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? undefined
      : { path, reason: 'non-finite numbers are not permitted' };
  }
  if (typeof value !== 'object')
    return { path, reason: `${typeof value} values are not permitted` };
  const object = value as object;
  if (ancestors.has(object)) return { path, reason: 'cyclic objects are not permitted' };
  const prototype = Object.getPrototypeOf(object) as unknown;
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    return { path, reason: 'class instances and custom prototypes are not permitted' };
  }
  if (Object.getOwnPropertySymbols(object).length > 0) {
    return { path, reason: 'symbol-keyed properties are not permitted' };
  }
  ancestors.add(object);
  try {
    if (Array.isArray(value)) {
      for (const key of Object.getOwnPropertyNames(value)) {
        if (key === 'length') continue;
        const index = Number(key);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          String(index) !== key ||
          index >= value.length
        ) {
          return {
            path: `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
            reason: 'custom array properties are not permitted',
          };
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        const childPath = `${path}/${index}`;
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined) {
          return { path: childPath, reason: 'sparse arrays are not permitted' };
        }
        if (!descriptor.enumerable || !('value' in descriptor)) {
          return {
            path: childPath,
            reason: 'accessors and non-enumerable properties are not permitted',
          };
        }
        const failure = inspect(descriptor.value, childPath, ancestors);
        if (failure !== undefined) return failure;
      }
      return undefined;
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      const childPath = `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      if (!descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
        return {
          path: childPath,
          reason: 'accessors and non-enumerable properties are not permitted',
        };
      }
      const failure = inspect(descriptor.value, childPath, ancestors);
      if (failure !== undefined) return failure;
    }
    return undefined;
  } finally {
    ancestors.delete(object);
  }
}

export function inspectJsonCompatibility(value: unknown): JsonCompatibilityFailure | undefined {
  try {
    return inspect(value, '', new Set());
  } catch {
    return { path: '', reason: 'the value could not be safely inspected' };
  }
}

export function canonicalizeJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return canonicalNumber(value);
  if (Array.isArray(value)) return value.map((item) => canonicalizeJsonValue(item));
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort(compareCodePoints))
    result[key] = canonicalizeJsonValue(value[key]!);
  return result;
}

export function stringifyCanonicalJson(value: JsonValue): string {
  return `${JSON.stringify(canonicalizeJsonValue(value), null, 2)}\n`;
}
