import { createHash } from 'node:crypto';

import { compareCodePoints } from '../json.js';
import type { CriticFindingCode } from './contract-schema.js';

export interface CriticFindingIdentity {
  readonly code: CriticFindingCode;
  readonly relatedFloorLevel?: number;
  readonly relatedSourceIds?: readonly string[];
  readonly relatedCheckpointIds?: readonly string[];
  readonly relatedSegmentIds?: readonly string[];
  readonly evidenceIds?: readonly string[];
}

function sorted(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort(compareCodePoints);
}

export function deriveCriticFindingId(identity: Readonly<CriticFindingIdentity>): string {
  const tuple = JSON.stringify([
    identity.code,
    identity.relatedFloorLevel ?? null,
    sorted(identity.relatedSourceIds),
    sorted(identity.relatedCheckpointIds),
    sorted(identity.relatedSegmentIds),
    sorted(identity.evidenceIds),
  ]);
  return `critic-finding-${createHash('sha256').update(tuple, 'utf8').digest('hex').slice(0, 20)}`;
}
