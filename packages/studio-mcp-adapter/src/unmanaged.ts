import { hashCanonicalJson, type JsonValue } from './json.js';
import type { StudioRawUnmanagedRoot } from './types.js';

export interface DerivedUnmanagedRoot {
  readonly snapshotId: string;
  readonly parentNodeId: string;
  readonly name: string;
}

export function deriveUnmanagedRoot(raw: Readonly<StudioRawUnmanagedRoot>): DerivedUnmanagedRoot {
  const descriptor = {
    parentEntityId: raw.parentEntityId,
    className: raw.className,
    name: raw.name,
    structuralPath: raw.structuralPath,
    ordinal: raw.ordinal,
  } as const;
  return {
    snapshotId: `unmanaged-${hashCanonicalJson(descriptor as JsonValue)}`,
    parentNodeId: raw.parentEntityId,
    name: raw.name,
  };
}
