import { compareCodePoints } from '../json.js';
import type { CriticFinding, CriticReport } from './contract-schema.js';

function clone<T>(value: Readonly<T>): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function compareCriticFindings(
  left: Readonly<CriticFinding>,
  right: Readonly<CriticFinding>,
): number {
  return (
    (left.severity === right.severity ? 0 : left.severity === 'error' ? -1 : 1) ||
    compareCodePoints(left.category, right.category) ||
    (left.relatedFloorLevel === undefined
      ? right.relatedFloorLevel === undefined
        ? 0
        : 1
      : right.relatedFloorLevel === undefined
        ? -1
        : left.relatedFloorLevel - right.relatedFloorLevel) ||
    compareCodePoints(left.relatedSourceIds[0] ?? '', right.relatedSourceIds[0] ?? '') ||
    compareCodePoints(left.code, right.code) ||
    compareCodePoints(left.id, right.id)
  );
}

export function normalizeCriticReport(input: Readonly<CriticReport>): CriticReport {
  const value = clone(input);
  return {
    ...value,
    source: { ...value.source },
    findings: value.findings
      .map((finding) => ({
        ...finding,
        relatedSourceIds: [...finding.relatedSourceIds].sort(compareCodePoints),
        relatedCheckpointIds: [...finding.relatedCheckpointIds].sort(compareCodePoints),
        relatedSegmentIds: [...finding.relatedSegmentIds].sort(compareCodePoints),
        evidenceIds: [...finding.evidenceIds].sort(compareCodePoints),
      }))
      .sort(compareCriticFindings),
    metrics: { ...value.metrics },
    evidenceCompleteness: { ...value.evidenceCompleteness },
  };
}
