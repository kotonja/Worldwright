import { describe, expect, it } from 'vitest';

import { emitArchitectureWorldSpec } from '../src/emit-worldspec.js';
import { evaluateArchitecturePlan } from '../src/plan-evaluation.js';
import type {
  ArchitectureCirculationEdge,
  ArchitectureOpening,
  ArchitecturePlan,
  ArchitectureRoomSpace,
  ArchitectureStairRun,
  ArchitectureWall,
} from '../src/plan-schema.js';
import { loadMansionPlan, loadMansionProgram } from './helpers.js';

type PlanMutation = (plan: ArchitecturePlan) => void;

function room(plan: ArchitecturePlan): ArchitectureRoomSpace {
  const value = plan.spaces.find((space): space is ArchitectureRoomSpace => space.type === 'room');
  if (value === undefined) throw new Error('Mansion plan has no room.');
  return value;
}

function wall(plan: ArchitecturePlan): ArchitectureWall {
  const value = plan.walls.find((entry) => entry.kind === 'corridor');
  if (value === undefined) throw new Error('Mansion plan has no corridor wall.');
  return value;
}

function opening(plan: ArchitecturePlan): ArchitectureOpening {
  const value = plan.openings.find((entry) => entry.type === 'door');
  if (value === undefined) throw new Error('Mansion plan has no door opening.');
  return value;
}

function circulationEdge(plan: ArchitecturePlan): ArchitectureCirculationEdge {
  const value = plan.circulationEdges.find((entry) => entry.sourceType === 'opening');
  if (value === undefined) throw new Error('Mansion plan has no opening circulation edge.');
  return value;
}

function stairRun(plan: ArchitecturePlan): ArchitectureStairRun {
  const value = plan.stairRuns[0];
  if (value === undefined) throw new Error('Mansion plan has no stair run.');
  return value;
}

const tamperCases: readonly (readonly [string, PlanMutation])[] = [
  [
    'floor footprint',
    (plan) => {
      plan.floors[0]!.footprint.x += plan.building.gridSize;
    },
  ],
  [
    'floor corridor',
    (plan) => {
      plan.floors[0]!.corridor.x += plan.building.gridSize;
    },
  ],
  [
    'floor stair core',
    (plan) => {
      const core = plan.floors[0]!.stairCore;
      if (core === undefined) throw new Error('Ground floor has no stair core.');
      core.x += plan.building.gridSize;
    },
  ],
  [
    'room zone',
    (plan) => {
      const value = room(plan);
      value.zone = value.zone === 'public' ? 'private' : 'public';
    },
  ],
  [
    'room provenance',
    (plan) => {
      const value = room(plan);
      value.provenance = value.provenance === 'observed' ? 'inferred' : 'observed';
    },
  ],
  [
    'room corridor-door reference',
    (plan) => {
      const value = room(plan);
      const replacement = plan.openings.find(
        (entry) => entry.type === 'door' && entry.id !== value.corridorDoorOpeningId,
      );
      if (replacement === undefined) throw new Error('Mansion plan has no replacement door.');
      value.corridorDoorOpeningId = replacement.id;
    },
  ],
  [
    'room exterior-wall references',
    (plan) => {
      const value = room(plan);
      const replacement = plan.walls.find(
        (entry) => entry.exterior === true && !value.exteriorWallIds.includes(entry.id),
      );
      if (replacement === undefined)
        throw new Error('Mansion plan has no replacement exterior wall.');
      value.exteriorWallIds = [replacement.id];
    },
  ],
  [
    'wall geometry',
    (plan) => {
      wall(plan).constant += plan.building.gridSize;
    },
  ],
  [
    'wall metadata',
    (plan) => {
      wall(plan).kind = 'divider';
    },
  ],
  [
    'wall opening references',
    (plan) => {
      wall(plan).openingIds = [];
    },
  ],
  [
    'opening geometry',
    (plan) => {
      opening(plan).offset += plan.building.gridSize;
    },
  ],
  [
    'opening source',
    (plan) => {
      opening(plan).sourceId = plan.source.buildingEntityId;
    },
  ],
  [
    'opening endpoints',
    (plan) => {
      const value = opening(plan);
      [value.fromNodeId, value.toNodeId] = [value.toNodeId, value.fromNodeId];
    },
  ],
  [
    'circulation source',
    (plan) => {
      const value = circulationEdge(plan);
      const replacement = plan.openings.find((entry) => entry.id !== value.sourceId);
      if (replacement === undefined) throw new Error('Mansion plan has no replacement opening.');
      value.sourceId = replacement.id;
    },
  ],
  [
    'circulation endpoints',
    (plan) => {
      const value = circulationEdge(plan);
      [value.fromNodeId, value.toNodeId] = [value.toNodeId, value.fromNodeId];
    },
  ],
  [
    'circulation traversal',
    (plan) => {
      circulationEdge(plan).traversal = 'open';
    },
  ],
  [
    'stair source',
    (plan) => {
      stairRun(plan).sourceStairRouteId = plan.source.buildingEntityId;
    },
  ],
  [
    'stair direction',
    (plan) => {
      const value = stairRun(plan);
      value.direction = value.direction === 'positive_x' ? 'negative_x' : 'positive_x';
    },
  ],
  [
    'stair step count',
    (plan) => {
      stairRun(plan).stepCount += 1;
    },
  ],
  [
    'stair riser height',
    (plan) => {
      stairRun(plan).riserHeight += 0.25;
    },
  ],
  [
    'stair tread depth',
    (plan) => {
      stairRun(plan).treadDepth += 0.25;
    },
  ],
  [
    'stair clear width',
    (plan) => {
      stairRun(plan).clearWidth -= 1;
    },
  ],
  [
    'stair landing',
    (plan) => {
      stairRun(plan).landing.lower.x += plan.building.gridSize;
    },
  ],
  [
    'estimated generated entity count',
    (plan) => {
      plan.metrics.estimatedGeneratedWorldSpecEntityCount += 1;
    },
  ],
  [
    'estimated primitive count',
    (plan) => {
      plan.metrics.estimatedPrimitiveCount += 1;
    },
  ],
  [
    'score total',
    (plan) => {
      plan.score.total += 1;
    },
  ],
  ...(
    [
      'areaDeviation',
      'aspectRatio',
      'preferredAdjacency',
      'preferredWindows',
      'nearDistance',
      'zoneOrdering',
    ] as const
  ).map((field): readonly [string, PlanMutation] => [
    `score ${field}`,
    (plan) => {
      plan.score[field] += 1;
      plan.score.total += 1;
    },
  ]),
  [
    'score seed tie break',
    (plan) => {
      plan.score.seedTieBreak += 1;
    },
  ],
];

describe('adversarial Architecture Plan evaluation and emission', () => {
  it('accepts the untampered checked-in plan through both trust boundaries', () => {
    const source = loadMansionProgram();
    const plan = loadMansionPlan();
    expect(evaluateArchitecturePlan(source, plan).valid).toBe(true);
    expect(emitArchitectureWorldSpec(source, plan).success).toBe(true);
  });

  it.each(tamperCases)('rejects tampered %s', (_label, mutate) => {
    const source = loadMansionProgram();
    const plan = loadMansionPlan();
    mutate(plan);
    const sourceBefore = JSON.stringify(source);
    const planBefore = JSON.stringify(plan);

    const evaluation = evaluateArchitecturePlan(source, plan);
    expect(evaluation.valid).toBe(false);
    expect(evaluation.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'architecture.plan_invalid', severity: 'error' }),
    );

    const emission = emitArchitectureWorldSpec(source, plan);
    expect(emission.success).toBe(false);
    expect(emission.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'architecture.plan_invalid', severity: 'error' }),
    );
    expect(JSON.stringify(source)).toBe(sourceBefore);
    expect(JSON.stringify(plan)).toBe(planBefore);
  });
});
