function freezeObject(value: object, seen: WeakSet<object>): void {
  if (seen.has(value)) return;
  seen.add(value);

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) continue;
    const child: unknown = descriptor.value;
    if (child !== null && (typeof child === 'object' || typeof child === 'function')) {
      freezeObject(child, seen);
    }
  }

  Object.freeze(value);
}

/** Recursively freezes a public contract descriptor, including symbol-keyed metadata. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    freezeObject(value, new WeakSet<object>());
  }
  return value;
}
