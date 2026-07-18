import { describe, expect, it } from 'vitest';

import { planAndEmitArchitectureWorldSpec } from '@worldwright/architecture-planner';
import type { WorldEntity, WorldSpec } from '@worldwright/worldspec';

import { buildPassRun } from '../scripts/generate-fixtures.js';
import { evaluatePlaytestRun } from '../src/critic/evaluate.js';
import { stringifyCriticReport } from '../src/critic/hashing.js';
import { buildPlaytestPlan } from '../src/plan/planner.js';
import { validatePlaytestPlanAgainstSources } from '../src/plan/trusted.js';
import { stringifyPlaytestRunReport } from '../src/run/hashing.js';
import { validatePlaytestRunReportAgainstPlan } from '../src/run/validate.js';
import { readJson } from './helpers.js';

async function buildScaleSource(): Promise<WorldSpec> {
  const source = await readJson<WorldSpec>(
    new URL(
      '../../architecture-planner/fixtures/input/cliffwatch-mansion-program.worldspec.json',
      import.meta.url,
    ),
  );
  const floorUpper = source.entities.find((entity) => entity.id === 'floor-upper');
  const roomTemplate = source.entities.find((entity) => entity.id === 'foyer-grand');
  if (floorUpper === undefined || roomTemplate === undefined)
    throw new Error('Scale fixture templates are missing.');
  const floorTop: WorldEntity = {
    ...floorUpper,
    id: 'floor-top',
    name: 'Top Floor',
    attributes: {
      'worldwright.architecture': {
        schemaVersion: '0.1.0',
        mode: 'floor',
        level: 2,
        clearHeight: 17,
      },
    },
  };
  const floorIds = ['floor-ground', 'floor-upper', 'floor-top'] as const;
  const rooms: WorldEntity[] = Array.from({ length: 36 }, (_, index) => {
    const floorId = floorIds[Math.floor(index / 12)] ?? 'floor-top';
    return {
      ...roomTemplate,
      id: `scale-room-${String(index + 1).padStart(2, '0')}`,
      name: `Scale Room ${String(index + 1)}`,
      parentId: floorId,
      tags: ['room', index === 0 ? 'entrance' : 'scale'],
      attributes: {
        'worldwright.architecture': {
          schemaVersion: '0.1.0',
          mode: 'room',
          minimumArea: 180,
          preferredArea: 360,
          maximumArea: 1_000,
          minimumSpan: 12,
          maximumAspectRatio: 4,
          zone: index < 12 ? 'public' : index < 24 ? 'service' : 'private',
          isEntrance: index === 0,
          windows: { minimum: 0, preferred: 0 },
        },
      },
    };
  });
  const entities = source.entities
    .filter((entity) => entity.kind !== 'room')
    .map((entity): WorldEntity => {
      if (entity.id === 'mansion-cliffwatch') {
        const directive = entity.attributes['worldwright.architecture'];
        if (directive === null || typeof directive !== 'object' || Array.isArray(directive))
          throw new Error('Building directive is missing.');
        return {
          ...entity,
          attributes: {
            'worldwright.architecture': {
              ...directive,
              footprint: { width: 160, depth: 90 },
              defaultDoorWidth: 7,
            },
          },
        };
      }
      if (entity.id !== 'stair-main') return entity;
      return {
        ...entity,
        attributes: {
          'worldwright.architecture': {
            schemaVersion: '0.1.0',
            mode: 'stair',
            floorIds: [...floorIds],
            coreWidth: 14,
            coreLength: 24,
            preferredSide: 'auto',
            position: 'rear',
            maximumRiserHeight: 1,
            minimumTreadDepth: 1,
          },
        },
      };
    });
  return {
    ...source,
    project: { ...source.project, id: 'project-scale-three-floor', name: 'Scale Pipeline' },
    entities: [...entities, floorTop, ...rooms],
    relationships: [],
    constraints: [],
    locks: [],
    budgets: {
      ...source.budgets,
      limits: { ...source.budgets.limits, instances: 5_000 },
    },
  };
}

describe('bounded three-floor scale pipeline', () => {
  it('plans 36 rooms and two stair runs deterministically without route inflation or mutation', async () => {
    const source = await buildScaleSource();
    const before = JSON.stringify(source);
    const pipeline = planAndEmitArchitectureWorldSpec(source);
    expect(
      pipeline.success,
      pipeline.success ? undefined : JSON.stringify(pipeline.diagnostics),
    ).toBe(true);
    expect(JSON.stringify(source)).toBe(before);
    if (!pipeline.success) return;
    const planBefore = JSON.stringify(pipeline.plan);
    const manifestBefore = JSON.stringify(pipeline.manifest);
    const first = buildPlaytestPlan(pipeline.plan, pipeline.manifest);
    const second = buildPlaytestPlan(pipeline.plan, pipeline.manifest);
    expect(first.valid, first.valid ? undefined : JSON.stringify(first.diagnostics)).toBe(true);
    expect(second).toEqual(first);
    expect(JSON.stringify(pipeline.plan)).toBe(planBefore);
    expect(JSON.stringify(pipeline.manifest)).toBe(manifestBefore);
    if (!first.valid) return;
    expect(first.value.requiredCoverage.rooms.count).toBe(36);
    expect(first.value.requiredCoverage.floors.count).toBe(3);
    expect(first.value.requiredCoverage.stairRuns.count).toBe(2);
    expect(first.value.checkpoints.length).toBeLessThanOrEqual(128);
    expect(first.value.segments.length).toBeLessThanOrEqual(256);
    const visited = new Set(
      first.value.segments.flatMap((segment) => [segment.fromCheckpointId, segment.toCheckpointId]),
    );
    expect(first.value.requiredCoverage.checkpoints.ids.every((id) => visited.has(id))).toBe(true);
    expect(
      validatePlaytestPlanAgainstSources(first.value, pipeline.plan, pipeline.manifest).valid,
    ).toBe(true);
    const middleHallCheckpoints = first.value.checkpoints.filter(
      (checkpoint) => checkpoint.type === 'stair_hall' && checkpoint.level === 1,
    );
    expect(middleHallCheckpoints).toHaveLength(2);
    expect(
      new Set(
        middleHallCheckpoints.flatMap((checkpoint) =>
          checkpoint.type === 'stair_hall' ? [checkpoint.stairRunId] : [],
        ),
      ).size,
    ).toBe(2);
    const playtestPlanBefore = JSON.stringify(first.value);
    const run = buildPassRun(first.value);
    const repeatedRun = buildPassRun(first.value);
    expect(stringifyPlaytestRunReport(repeatedRun)).toBe(stringifyPlaytestRunReport(run));
    expect(validatePlaytestRunReportAgainstPlan(first.value, run).valid).toBe(true);
    const runBefore = JSON.stringify(run);
    const critic = evaluatePlaytestRun(first.value, run);
    const repeatedCritic = evaluatePlaytestRun(first.value, repeatedRun);
    expect(critic.valid, critic.valid ? undefined : JSON.stringify(critic.diagnostics)).toBe(true);
    expect(repeatedCritic.valid).toBe(true);
    if (!critic.valid || !repeatedCritic.valid) return;
    expect(critic.value.status).toBe('pass');
    expect(critic.value.findings).toEqual([]);
    expect(stringifyCriticReport(repeatedCritic.value)).toBe(stringifyCriticReport(critic.value));
    expect(JSON.stringify(first.value)).toBe(playtestPlanBefore);
    expect(JSON.stringify(run)).toBe(runBefore);
  }, 30_000);
});
