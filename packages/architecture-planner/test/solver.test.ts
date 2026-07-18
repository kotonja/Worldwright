import { describe, expect, it } from 'vitest';

import { evaluateLayoutAdjacencies } from '../src/adjacency.js';
import { createGlobalCandidates } from '../src/candidate.js';
import { calculateSolvedLayoutScore, evaluateSolvedLayout } from '../src/evaluation.js';
import { planArchitectureWorldSpec } from '../src/planner.js';
import {
  ARCHITECTURE_FLOOR_CANDIDATE_LIMIT,
  ARCHITECTURE_GLOBAL_COMBINATION_LIMIT,
  ARCHITECTURE_SOLVER_BEAM_WIDTH,
  solveArchitectureLayout,
} from '../src/solver.js';
import { extractArchitectureSourceProfile } from '../src/source-profile.js';
import { clone, loadMansionProgram } from './helpers.js';

function mansionProfile() {
  const result = extractArchitectureSourceProfile(loadMansionProgram());
  if (!result.valid) throw new Error('Mansion fixture profile must be valid.');
  return result.value;
}

describe('bounded deterministic architecture solver', () => {
  it('enumerates documented global alternatives in stable signature order', () => {
    const candidates = createGlobalCandidates(mansionProfile());
    expect(candidates.length).toBeGreaterThanOrEqual(4);
    expect(candidates.map((candidate) => candidate.signature)).toEqual(
      [...candidates.map((candidate) => candidate.signature)].sort(),
    );
    expect(new Set(candidates.map((candidate) => candidate.corridorAxis))).toEqual(
      new Set(['x', 'z']),
    );
    expect(new Set(candidates.map((candidate) => candidate.stairSide))).toEqual(
      new Set(['negative', 'positive']),
    );
    expect(ARCHITECTURE_SOLVER_BEAM_WIDTH).toBe(256);
    expect(ARCHITECTURE_FLOOR_CANDIDATE_LIMIT).toBeLessThanOrEqual(ARCHITECTURE_SOLVER_BEAM_WIDTH);
    expect(ARCHITECTURE_GLOBAL_COMBINATION_LIMIT).toBe(512);
  });

  it('solves the mansion program twice to exactly the same complete layout', () => {
    const profile = mansionProfile();
    const before = structuredClone(profile);
    const first = solveArchitectureLayout(profile);
    const second = solveArchitectureLayout(profile);
    expect(first.success).toBe(true);
    expect(second).toEqual(first);
    expect(profile).toEqual(before);
    if (!first.success) return;

    const roomIds = first.layout.floors.flatMap((floor) => floor.rooms.map((room) => room.roomId));
    expect(roomIds).toHaveLength(13);
    expect(new Set(roomIds).size).toBe(roomIds.length);
    expect(first.layout.floors).toHaveLength(2);
    expect(first.layout.floors.every((floor) => floor.stairCoreCells !== undefined)).toBe(true);
    expect(first.layout.floors[0]?.stairCoreCells).toEqual(first.layout.floors[1]?.stairCoreCells);
    const accessLaneCells = profile.building.defaultDoorWidth / profile.building.gridSize;
    const wallCells = profile.building.interiorWallThickness / profile.building.gridSize;
    for (const floor of first.layout.floors) {
      const core = floor.stairCoreCells;
      const side = first.layout.stairSide;
      expect(core).toBeDefined();
      expect(side).toBeDefined();
      if (core === undefined || side === undefined) continue;
      const corridor = floor.corridorCells;
      const observedLane =
        first.layout.corridorAxis === 'x'
          ? side === 'negative'
            ? corridor.z - wallCells - (core.z + core.depth)
            : core.z - (corridor.z + corridor.depth + wallCells)
          : side === 'negative'
            ? corridor.x - wallCells - (core.x + core.width)
            : core.x - (corridor.x + corridor.width + wallCells);
      expect(observedLane).toBe(accessLaneCells);
    }
    expect(
      first.layout.floors
        .flatMap((floor) => floor.rooms)
        .every(
          (room) =>
            Number.isSafeInteger(room.rectangleCells.x) &&
            Number.isSafeInteger(room.rectangleCells.z) &&
            Number.isSafeInteger(room.rectangleCells.width) &&
            Number.isSafeInteger(room.rectangleCells.depth),
        ),
    ).toBe(true);
  });

  it('independently re-evaluates the selected layout without hard errors', () => {
    const profile = mansionProfile();
    const result = solveArchitectureLayout(profile);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const evaluation = evaluateSolvedLayout(profile, result.layout);
    expect(evaluation.valid).toBe(true);
    expect(evaluation.diagnostics.every((entry) => entry.severity !== 'error')).toBe(true);
    expect(evaluation.score).toEqual(result.layout.score);
    expect(evaluation.adjacency.requiredSatisfied).toBe(evaluation.adjacency.requiredTotal);
    expect(evaluation.adjacency.avoidedSatisfied).toBe(evaluation.adjacency.avoidedTotal);
  });

  it('is stable when unrelated source arrays are reordered', () => {
    const source = loadMansionProgram();
    const reordered = clone(source);
    reordered.entities.reverse();
    reordered.relationships.reverse();
    const firstProfile = extractArchitectureSourceProfile(source);
    const secondProfile = extractArchitectureSourceProfile(reordered);
    expect(firstProfile.valid).toBe(true);
    expect(secondProfile.valid).toBe(true);
    if (!firstProfile.valid || !secondProfile.valid) return;
    const first = solveArchitectureLayout(firstProfile.value);
    const second = solveArchitectureLayout(secondProfile.value);
    expect(first).toEqual(second);
  });

  it('solves bounded one-floor and three-floor variants', () => {
    const oneFloor = loadMansionProgram();
    const upperIds = new Set(
      oneFloor.entities
        .filter((entity) => entity.id === 'floor-upper' || entity.parentId === 'floor-upper')
        .map((entity) => entity.id),
    );
    oneFloor.entities = oneFloor.entities.filter(
      (entity) => !upperIds.has(entity.id) && entity.id !== 'stair-main',
    );
    oneFloor.relationships = oneFloor.relationships.filter(
      (relationship) =>
        !upperIds.has(relationship.sourceId) && !upperIds.has(relationship.targetId),
    );
    const oneProfile = extractArchitectureSourceProfile(oneFloor);
    expect(oneProfile.valid).toBe(true);
    if (oneProfile.valid) {
      const solved = solveArchitectureLayout(oneProfile.value);
      expect(solved.success).toBe(true);
      if (solved.success) {
        expect(solved.layout.floors).toHaveLength(1);
        expect(solved.layout.stairSide).toBeUndefined();
      }
    }

    const threeFloor = loadMansionProgram();
    const upperFloor = threeFloor.entities.find((entity) => entity.id === 'floor-upper')!;
    const thirdFloor = clone(upperFloor);
    thirdFloor.id = 'floor-third';
    thirdFloor.name = 'Third Floor';
    (thirdFloor.attributes['worldwright.architecture'] as Record<string, unknown>).level = 2;
    threeFloor.entities.push(thirdFloor);
    for (const upperRoom of threeFloor.entities.filter(
      (entity) => entity.parentId === 'floor-upper',
    )) {
      const thirdRoom = clone(upperRoom);
      thirdRoom.id = `third-${upperRoom.id}`;
      thirdRoom.name = `Third ${upperRoom.name}`;
      thirdRoom.parentId = thirdFloor.id;
      (thirdRoom.attributes['worldwright.architecture'] as Record<string, unknown>).isEntrance =
        false;
      threeFloor.entities.push(thirdRoom);
    }
    const stair = threeFloor.entities.find((entity) => entity.id === 'stair-main')!;
    (stair.attributes['worldwright.architecture'] as Record<string, unknown>).floorIds = [
      'floor-ground',
      'floor-upper',
      'floor-third',
    ];
    const threeProfile = extractArchitectureSourceProfile(threeFloor);
    expect(threeProfile.valid).toBe(true);
    if (threeProfile.valid) {
      const solved = solveArchitectureLayout(threeProfile.value);
      expect(solved.success).toBe(true);
      if (solved.success) expect(solved.layout.floors).toHaveLength(3);
    }
  });

  it('honors forced x and z corridor axes and exposes the deterministic odd-cell split', () => {
    const forcedX = loadMansionProgram();
    const buildingX = forcedX.entities.find((entity) => entity.id === 'mansion-cliffwatch')!;
    (buildingX.attributes['worldwright.architecture'] as Record<string, unknown>).corridorAxis =
      'x';
    const xProfile = extractArchitectureSourceProfile(forcedX);
    expect(xProfile.valid).toBe(true);
    if (xProfile.valid) {
      const solved = solveArchitectureLayout(xProfile.value);
      expect(solved.success).toBe(true);
      if (solved.success) expect(solved.layout.corridorAxis).toBe('x');
    }

    const forcedZ = loadMansionProgram();
    const buildingZ = forcedZ.entities.find((entity) => entity.id === 'mansion-cliffwatch')!;
    const zDirective = buildingZ.attributes['worldwright.architecture'] as Record<string, unknown>;
    zDirective.corridorAxis = 'z';
    zDirective.footprint = { width: 90, depth: 160 };
    const zProfile = extractArchitectureSourceProfile(forcedZ);
    expect(zProfile.valid).toBe(true);
    if (zProfile.valid) {
      const solved = solveArchitectureLayout(zProfile.value);
      expect(solved.success).toBe(true);
      if (solved.success) expect(solved.layout.corridorAxis).toBe('z');
    }

    const oddSplit = mansionProfile();
    oddSplit.building.footprint.depth = 91;
    const splits = createGlobalCandidates(oddSplit)
      .filter((candidate) => candidate.corridorAxis === 'x')
      .map((candidate) => [candidate.negativeBandDepthCells, candidate.positiveBandDepthCells]);
    expect(splits).toContainEqual([37, 38]);
    expect(splits).toContainEqual([38, 37]);
  });

  it('never lets a seed tie-break alter the primary score', () => {
    const profile = mansionProfile();
    const solved = solveArchitectureLayout(profile);
    expect(solved.success).toBe(true);
    if (!solved.success) return;
    const lowSeed = calculateSolvedLayoutScore(profile, solved.layout, 1);
    const highSeed = calculateSolvedLayoutScore(profile, solved.layout, 9_000_000);
    expect({ ...lowSeed, seedTieBreak: 0 }).toEqual({ ...highSeed, seedTieBreak: 0 });
    expect(lowSeed.total).toBe(highSeed.total);
  });

  it('rejects required-near layouts beyond the exact deterministic distance threshold', () => {
    const baselineProfile = mansionProfile();
    const baseline = solveArchitectureLayout(baselineProfile);
    expect(baseline.success).toBe(true);
    if (!baseline.success) return;

    const source = loadMansionProgram();
    const relationship = source.relationships.find(
      (entry) => entry.id === 'relationship-foyer-dining-near',
    )!;
    relationship.targetId = 'primary-bedroom';
    const directive = relationship.attributes['worldwright.architecture'] as Record<
      string,
      unknown
    >;
    directive.requirement = 'required';
    const requiredNearProfile = extractArchitectureSourceProfile(source);
    expect(requiredNearProfile.valid).toBe(true);
    if (!requiredNearProfile.valid) return;

    const evaluation = evaluateLayoutAdjacencies(requiredNearProfile.value, baseline.layout);
    const corridorLengthCells =
      baseline.layout.corridorAxis === 'x'
        ? baseline.layout.floors[0]!.corridorCells.width
        : baseline.layout.floors[0]!.corridorCells.depth;
    const nearThresholdTwiceCells = 2 * Math.max(1, Math.floor(corridorLengthCells / 2));
    const resolved = evaluation.resolved.find((entry) => entry.relationshipId === relationship.id)!;
    expect(resolved.centroidDistanceTwiceCells).toBeGreaterThan(nearThresholdTwiceCells);
    expect(resolved.satisfied).toBe(false);
    expect(evaluation.valid).toBe(false);
    expect(evaluation.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'architecture.required_adjacency_unsatisfied',
        relatedId: relationship.id,
      }),
    );
    expect(solveArchitectureLayout(requiredNearProfile.value).success).toBe(false);
    expect(planArchitectureWorldSpec(source).success).toBe(false);
  });

  it('fails an impossible required-divider graph visibly', () => {
    const source = loadMansionProgram();
    for (const [suffix, targetId] of [
      ['kitchen', 'kitchen-service'],
      ['drawing', 'drawing-room'],
    ] as const) {
      source.relationships.push({
        id: `relationship-foyer-required-${suffix}`,
        type: 'adjacent_to',
        sourceId: 'foyer-grand',
        targetId,
        directed: false,
        attributes: {
          'worldwright.architecture': {
            schemaVersion: '0.1.0',
            mode: 'adjacency',
            requirement: 'required',
            connection: 'door',
            weight: 100,
          },
        },
      });
    }
    const profile = extractArchitectureSourceProfile(source);
    expect(profile.valid).toBe(true);
    if (!profile.valid) return;
    const solved = solveArchitectureLayout(profile.value);
    expect(solved.success).toBe(false);
    expect(solved.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'architecture.infeasible' }),
    );
  });
});
