import { compareCodePoints } from '../json.js';
import type { PlaytestPlan, PlaytestRequiredCoverage } from './contract-schema.js';

function clone<T>(value: Readonly<T>): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeCoverage(coverage: Readonly<PlaytestRequiredCoverage>): PlaytestRequiredCoverage {
  const dimension = (value: Readonly<{ ids: readonly string[]; count: number }>) => ({
    ids: [...value.ids].sort(compareCodePoints),
    count: value.count,
  });
  return {
    rooms: dimension(coverage.rooms),
    floors: dimension(coverage.floors),
    corridors: dimension(coverage.corridors),
    stairRuns: dimension(coverage.stairRuns),
    openings: dimension(coverage.openings),
    checkpoints: dimension(coverage.checkpoints),
    segments: dimension(coverage.segments),
  };
}

export function normalizePlaytestPlan(input: Readonly<PlaytestPlan>): PlaytestPlan {
  const value = clone(input);
  return {
    schemaVersion: value.schemaVersion,
    criticVersion: value.criticVersion,
    source: { ...value.source },
    agent: { ...value.agent },
    setup: { ...value.setup, worldPosition: { ...value.setup.worldPosition } },
    checkpoints: value.checkpoints
      .map((checkpoint) => ({
        ...checkpoint,
        localPosition: { ...checkpoint.localPosition },
        worldPosition: { ...checkpoint.worldPosition },
      }))
      .sort((left, right) => compareCodePoints(left.id, right.id)),
    segments: value.segments
      .map((segment) => ({ ...segment }))
      .sort(
        (left, right) => left.sequence - right.sequence || compareCodePoints(left.id, right.id),
      ),
    captureCheckpoints: [...value.captureCheckpoints],
    requiredCoverage: normalizeCoverage(value.requiredCoverage),
    limits: { ...value.limits },
  };
}
