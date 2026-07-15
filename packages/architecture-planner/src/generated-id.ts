import { sha256Hex } from './hashing.js';

export const ARCHITECTURE_GENERATED_ID_PREFIX = 'archgen-' as const;
export const ARCHITECTURE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
export const ARCHITECTURE_IDENTIFIER_MAX_LENGTH = 128;

export class ArchitectureGeneratedIdError extends Error {
  readonly code = 'architecture.generated_id_collision' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ArchitectureGeneratedIdError';
  }
}

export function isReservedArchitectureId(id: string): boolean {
  return id.startsWith(ARCHITECTURE_GENERATED_ID_PREFIX);
}

function readableSegment(part: string): string {
  const normalized = part
    .toLowerCase()
    .replaceAll('_', '-')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-+/gu, '-');
  return normalized || 'value';
}

function trimReadablePrefix(value: string, maximumLength: number): string {
  const trimmed = value.slice(0, maximumLength).replace(/-+$/u, '');
  return trimmed.length === 0 ? 'archgen-value' : trimmed;
}

function withHash(readable: string, digest: string, hashLength: number): string {
  const suffix = `-${digest.slice(0, hashLength)}`;
  const prefix = trimReadablePrefix(readable, ARCHITECTURE_IDENTIFIER_MAX_LENGTH - suffix.length);
  return `${prefix}${suffix}`;
}

/**
 * Creates a readable deterministic WorldSpec-safe ID from semantic parts.
 * Callers pass the IDs already allocated in their complete output namespace.
 */
export function createGeneratedId(
  parts: readonly string[],
  usedIds: ReadonlySet<string> = new Set<string>(),
): string {
  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    throw new ArchitectureGeneratedIdError(
      'Generated architecture IDs require at least one non-empty semantic part.',
    );
  }

  const logicalKey = JSON.stringify(parts);
  const digest = sha256Hex(logicalKey);
  const readable = `${ARCHITECTURE_GENERATED_ID_PREFIX}${parts
    .map((part) => readableSegment(part))
    .join('-')}`;
  const lossless = parts.every((part) => ARCHITECTURE_IDENTIFIER_PATTERN.test(part));

  let candidate =
    readable.length <= ARCHITECTURE_IDENTIFIER_MAX_LENGTH && lossless
      ? readable
      : withHash(readable, digest, 16);
  if (!usedIds.has(candidate)) return candidate;

  for (const hashLength of [16, 24, 32, 40, 48, 56, 64] as const) {
    candidate = withHash(readable, digest, hashLength);
    if (!usedIds.has(candidate)) return candidate;
  }

  throw new ArchitectureGeneratedIdError(
    'A generated architecture ID could not be made unique within the bounded SHA-256 namespace.',
  );
}
