import { describe, expect, it } from 'vitest';

import {
  ROBLOX_SNAPSHOT_VERSION,
  compileWorldSpecToRobloxManifest,
  hashRobloxSnapshot,
  planRobloxChangeSet,
  simulateRobloxChangeSet,
  stringifyRobloxManifest,
  type RobloxSnapshot,
} from '@worldwright/roblox-compiler';
import {
  validateWorldSpec,
  type WorldEntity,
  type WorldRelationship,
  type WorldSpec,
} from '@worldwright/worldspec';

import { validateArchitecturePlan } from '../src/directive-validation.js';
import { emitArchitectureWorldSpec } from '../src/emit-worldspec.js';
import { planArchitectureWorldSpec } from '../src/planner.js';
import { extractArchitectureSourceProfile } from '../src/source-profile.js';
import { clone, loadMansionProgram } from './helpers.js';

const FLOOR_COUNT = 3;
const ROOMS_PER_FLOOR = 12;

function directive(entity: WorldEntity): Record<string, unknown> {
  return entity.attributes['worldwright.architecture'] as Record<string, unknown>;
}

function createScaleProgram(): WorldSpec {
  const source = loadMansionProgram();
  const building = clone(source.entities.find((entity) => entity.id === 'mansion-cliffwatch')!);
  const floorTemplate = source.entities.find((entity) => entity.id === 'floor-ground')!;
  const roomTemplate = source.entities.find((entity) => entity.id === 'foyer-grand')!;
  const stair = clone(source.entities.find((entity) => entity.id === 'stair-main')!);
  const ancestors = source.entities.filter((entity) =>
    ['world', 'region', 'parcel'].includes(entity.kind),
  );

  source.project.id = 'project-architecture-scale';
  source.project.name = 'Architecture Planner Scale Program';
  source.project.seed = 90210;
  source.intent.summary =
    'Exercise the bounded planner with three floors and twelve rooms per floor.';

  const buildingDirective = directive(building);
  buildingDirective.footprint = { width: 240, depth: 110 };
  buildingDirective.corridorAxis = 'x';

  const floors: WorldEntity[] = [];
  const rooms: WorldEntity[] = [];
  const relationships: WorldRelationship[] = [];
  for (let level = 0; level < FLOOR_COUNT; level += 1) {
    const floor = clone(floorTemplate);
    floor.id = `scale-floor-${level}`;
    floor.name = `Scale Floor ${level}`;
    floor.parentId = building.id;
    directive(floor).level = level;
    floors.push(floor);

    for (let roomIndex = 0; roomIndex < ROOMS_PER_FLOOR; roomIndex += 1) {
      const room = clone(roomTemplate);
      const roomId = `scale-room-${level}-${String(roomIndex).padStart(2, '0')}`;
      room.id = roomId;
      room.name = `Scale Room ${level}-${roomIndex}`;
      room.parentId = floor.id;
      room.tags = ['room', roomIndex < 6 ? 'public' : 'private'];
      const roomDirective = directive(room);
      roomDirective.minimumArea = 480;
      roomDirective.preferredArea = 1_800;
      roomDirective.maximumArea = 4_000;
      roomDirective.minimumSpan = 10;
      roomDirective.maximumAspectRatio = 4;
      roomDirective.zone = roomIndex < 6 ? 'public' : 'private';
      roomDirective.isEntrance = level === 0 && roomIndex === 0;
      roomDirective.doorWidth = 5;
      roomDirective.windows = { minimum: 1, preferred: 2 };
      rooms.push(room);
    }

    const roomId = (roomIndex: number): string =>
      `scale-room-${level}-${String(roomIndex).padStart(2, '0')}`;
    relationships.push(
      {
        id: `scale-required-${level}`,
        type: 'adjacent_to',
        sourceId: roomId(0),
        targetId: roomId(1),
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
      },
      {
        id: `scale-preferred-${level}`,
        type: 'adjacent_to',
        sourceId: roomId(2),
        targetId: roomId(3),
        directed: false,
        attributes: {
          'worldwright.architecture': {
            schemaVersion: '0.1.0',
            mode: 'adjacency',
            requirement: 'preferred',
            connection: 'near',
            weight: 60,
          },
        },
      },
      {
        id: `scale-avoid-${level}`,
        type: 'adjacent_to',
        sourceId: roomId(4),
        targetId: roomId(5),
        directed: false,
        attributes: {
          'worldwright.architecture': {
            schemaVersion: '0.1.0',
            mode: 'adjacency',
            requirement: 'avoid',
            connection: 'none',
            weight: 100,
          },
        },
      },
    );
  }

  directive(stair).floorIds = floors.map((floor) => floor.id);
  source.entities = [...ancestors, building, ...floors, stair, ...rooms];
  source.relationships = relationships;
  source.constraints = [];
  source.locks = [];
  source.budgets.limits = { instances: 20_000 };
  return source;
}

describe('bounded planner scale and stack safety', () => {
  it('runs 36 rooms across three floors through extraction, planning, emission, compilation, reconciliation, and simulation', () => {
    const source = createScaleProgram();
    const sourceBefore = structuredClone(source);
    expect(validateWorldSpec(source).valid).toBe(true);

    const profile = extractArchitectureSourceProfile(source);
    expect(profile.valid).toBe(true);
    if (!profile.valid) return;
    expect(profile.value.floors).toHaveLength(FLOOR_COUNT);
    expect(profile.value.floors.every((floor) => floor.rooms.length === ROOMS_PER_FLOOR)).toBe(
      true,
    );

    const planning = planArchitectureWorldSpec(source);
    if (!planning.success) {
      throw new Error(
        `Scale planning failed: ${planning.diagnostics
          .map((entry) => `${entry.code} ${entry.path}: ${entry.message}`)
          .join('; ')}`,
      );
    }
    expect(planning.success).toBe(true);
    expect(source).toEqual(sourceBefore);
    expect(validateArchitecturePlan(planning.plan).valid).toBe(true);
    expect(planning.plan.metrics).toMatchObject({
      floorCount: FLOOR_COUNT,
      roomCount: FLOOR_COUNT * ROOMS_PER_FLOOR,
      requiredAdjacencyTotal: FLOOR_COUNT,
      requiredAdjacencySatisfied: FLOOR_COUNT,
      avoidedAdjacencyTotal: FLOOR_COUNT,
      avoidedAdjacencySatisfied: FLOOR_COUNT,
      stairRunCount: FLOOR_COUNT - 1,
      allRoomsReachable: true,
    });

    const emission = emitArchitectureWorldSpec(source, planning.plan);
    expect(emission.success).toBe(true);
    if (!emission.success) return;
    expect(validateWorldSpec(emission.worldSpec).valid).toBe(true);
    const compilation = compileWorldSpecToRobloxManifest(emission.worldSpec);
    expect(compilation.success).toBe(true);
    if (!compilation.success) return;
    expect(stringifyRobloxManifest(compilation.manifest)).toBe(
      stringifyRobloxManifest(emission.manifest),
    );

    const snapshot: RobloxSnapshot = {
      schemaVersion: ROBLOX_SNAPSHOT_VERSION,
      projectId: compilation.manifest.source.projectId,
      target: compilation.manifest.target,
      nodes: [],
      unmanagedRoots: [],
    };
    const changeSet = planRobloxChangeSet(snapshot, compilation.manifest);
    expect(changeSet.success).toBe(true);
    if (!changeSet.success) return;
    const simulation = simulateRobloxChangeSet(snapshot, changeSet.changeSet);
    expect(simulation.success).toBe(true);
    if (!simulation.success) return;
    expect(hashRobloxSnapshot(simulation.snapshot)).toBe(
      changeSet.changeSet.preconditions.resultSnapshotHash,
    );
  }, 30_000);
});
