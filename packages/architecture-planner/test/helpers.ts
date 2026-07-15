import { readFileSync } from 'node:fs';

import { validateWorldSpec, type WorldEntity, type WorldSpec } from '@worldwright/worldspec';

import type {
  ArchitectureBuildingDirective,
  ArchitectureEntityDirective,
  ArchitectureFloorDirective,
  ArchitectureRoomDirective,
  ArchitectureStairDirective,
} from '../src/entity-directive-schema.js';
import type {
  ArchitectureCorridorSpace,
  ArchitectureOpening,
  ArchitecturePlan,
  ArchitectureRectangle,
  ArchitectureRoomSpace,
  ArchitectureStairHallSpace,
  ArchitectureWall,
} from '../src/plan-schema.js';
import { validateArchitecturePlan } from '../src/directive-validation.js';

const fixtureUrl = new URL(
  '../fixtures/input/cliffwatch-mansion-program.worldspec.json',
  import.meta.url,
);
const planFixtureUrl = new URL(
  '../fixtures/plans/cliffwatch-mansion.architecture-plan.json',
  import.meta.url,
);

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function loadMansionProgram(): WorldSpec {
  const input: unknown = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
  const result = validateWorldSpec(input);
  if (!result.valid) throw new Error('The checked-in mansion program fixture is invalid.');
  return result.value;
}

export function loadMansionPlan(): ArchitecturePlan {
  const input: unknown = JSON.parse(readFileSync(planFixtureUrl, 'utf8'));
  const result = validateArchitecturePlan(input);
  if (!result.valid)
    throw new Error('The checked-in mansion Architecture Plan fixture is invalid.');
  return result.value;
}

export function entityById(source: WorldSpec, id: string): WorldEntity {
  const entity = source.entities.find((entry) => entry.id === id);
  if (entity === undefined) throw new Error(`Missing fixture entity ${id}.`);
  return entity;
}

export function architectureDirective(source: WorldSpec, id: string): ArchitectureEntityDirective {
  const value = entityById(source, id).attributes['worldwright.architecture'];
  if (value === undefined) throw new Error(`Missing fixture architecture directive ${id}.`);
  return value as ArchitectureEntityDirective;
}

export function buildingDirective(source = loadMansionProgram()): ArchitectureBuildingDirective {
  return architectureDirective(source, 'mansion-cliffwatch') as ArchitectureBuildingDirective;
}

export function floorDirective(source = loadMansionProgram()): ArchitectureFloorDirective {
  return architectureDirective(source, 'floor-ground') as ArchitectureFloorDirective;
}

export function roomDirective(source = loadMansionProgram()): ArchitectureRoomDirective {
  return architectureDirective(source, 'foyer-grand') as ArchitectureRoomDirective;
}

export function stairDirective(source = loadMansionProgram()): ArchitectureStairDirective {
  return architectureDirective(source, 'stair-main') as ArchitectureStairDirective;
}

export function makeRoomSpace(
  id: string,
  floorId: string,
  rectangle: Readonly<ArchitectureRectangle>,
  overrides: Partial<ArchitectureRoomSpace> = {},
): ArchitectureRoomSpace {
  return {
    id,
    type: 'room',
    floorId,
    rectangle: { ...rectangle },
    zone: 'public',
    isEntrance: false,
    provenance: 'invented',
    corridorDoorOpeningId: `archgen-opening-${id}`,
    exteriorWallIds: [`archgen-exterior-${id}`],
    clearArea: rectangle.width * rectangle.depth,
    aspectRatio:
      Math.max(rectangle.width, rectangle.depth) / Math.min(rectangle.width, rectangle.depth),
    ...overrides,
  };
}

export function makeCorridorSpace(
  id: string,
  floorId: string,
  rectangle: Readonly<ArchitectureRectangle>,
): ArchitectureCorridorSpace {
  return { id, type: 'corridor', floorId, rectangle: { ...rectangle } };
}

export function makeStairHallSpace(
  id: string,
  floorId: string,
  rectangle: Readonly<ArchitectureRectangle>,
  sourceStairRouteId = 'stair-main',
): ArchitectureStairHallSpace {
  return {
    id,
    type: 'stair_hall',
    floorId,
    rectangle: { ...rectangle },
    sourceStairRouteId,
  };
}

export function makeWall(overrides: Partial<ArchitectureWall> = {}): ArchitectureWall {
  return {
    id: 'archgen-wall-test',
    floorId: 'floor-ground',
    kind: 'divider',
    axis: 'x',
    constant: 0,
    start: 0,
    end: 20,
    thickness: 1,
    height: 10,
    firstSpaceId: 'room-a',
    secondSpaceId: 'room-b',
    openingIds: [],
    ...overrides,
  };
}

export function makeOpening(overrides: Partial<ArchitectureOpening> = {}): ArchitectureOpening {
  return {
    id: 'archgen-opening-test',
    floorId: 'floor-ground',
    wallId: 'archgen-wall-test',
    type: 'door',
    offset: 5,
    width: 4,
    bottom: 0,
    height: 7,
    sourceId: 'room-a',
    fromNodeId: 'room-a',
    toNodeId: 'room-b',
    ...overrides,
  };
}

export function makeMinimalPlan(): ArchitecturePlan {
  const room = makeRoomSpace('room-a', 'floor-ground', {
    x: -9,
    z: -9,
    width: 18,
    depth: 4,
  });
  const corridor = makeCorridorSpace('archgen-corridor-floor-ground', 'floor-ground', {
    x: -9,
    z: -4,
    width: 18,
    depth: 8,
  });
  const corridorWall = makeWall({
    id: 'archgen-wall-corridor',
    kind: 'corridor',
    constant: -4.5,
    start: -9,
    end: 9,
    firstSpaceId: room.id,
    secondSpaceId: corridor.id,
    openingIds: [room.corridorDoorOpeningId],
  });
  const exteriorWall: ArchitectureWall = {
    id: room.exteriorWallIds[0]!,
    floorId: 'floor-ground',
    kind: 'exterior',
    axis: 'x',
    constant: -9.5,
    start: -9,
    end: 9,
    thickness: 1,
    height: 10,
    firstSpaceId: room.id,
    exterior: true,
    openingIds: [],
  };
  const door = makeOpening({
    id: room.corridorDoorOpeningId,
    wallId: corridorWall.id,
    offset: 6.5,
    width: 5,
    height: 9,
    fromNodeId: room.id,
    toNodeId: corridor.id,
  });
  return {
    schemaVersion: '0.1.0',
    plannerVersion: '0.1.0',
    source: {
      worldSpecSchemaVersion: '0.1.0',
      projectId: 'minimal-project',
      worldSpecHash: 'a'.repeat(64),
      buildingEntityId: 'building-main',
    },
    building: {
      topology: 'double_loaded_spine',
      outerFootprint: { x: -10, z: -10, width: 20, depth: 20 },
      interiorEnvelope: { x: -9, z: -9, width: 18, depth: 18 },
      localOrigin: 'footprint_center',
      worldOrigin: { x: 0, y: 0, z: 0 },
      yawDegrees: 0,
      gridSize: 1,
      corridorAxis: 'x',
      entranceEnd: 'negative',
      floorToFloorHeight: 12,
      defaultClearHeight: 10,
      exteriorWallThickness: 1,
      interiorWallThickness: 1,
      slabThickness: 1,
      corridorWidth: 8,
      defaultDoorWidth: 5,
      defaultDoorHeight: 9,
      defaultWindowWidth: 4,
      defaultWindowHeight: 5,
      defaultWindowSillHeight: 3,
      openingEndClearance: 1,
      materials: {
        exteriorWall: 'Slate',
        interiorWall: 'SmoothPlastic',
        floor: 'WoodPlanks',
        stair: 'Wood',
        window: 'Glass',
      },
      colors: {
        exteriorWall: { r: 70, g: 70, b: 70 },
        interiorWall: { r: 180, g: 180, b: 180 },
        floor: { r: 100, g: 70, b: 50 },
        stair: { r: 90, g: 60, b: 40 },
        window: { r: 150, g: 190, b: 215 },
      },
      windowTransparency: 0.45,
    },
    floors: [
      {
        id: 'floor-ground',
        level: 0,
        finishedFloorElevation: 0,
        clearHeight: 10,
        footprint: { x: -10, z: -10, width: 20, depth: 20 },
        corridor: { ...corridor.rectangle },
        spaceIds: [room.id, corridor.id],
        wallIds: [corridorWall.id, exteriorWall.id],
        openingIds: [door.id],
        stairRunIds: [],
      },
    ],
    spaces: [room, corridor],
    walls: [corridorWall, exteriorWall],
    openings: [door],
    stairRuns: [],
    circulationEdges: [
      {
        id: 'archgen-circulation-room-a',
        sourceType: 'opening',
        sourceId: door.id,
        fromNodeId: room.id,
        toNodeId: corridor.id,
        traversal: 'door',
      },
    ],
    metrics: {
      floorCount: 1,
      roomCount: 1,
      grossOuterArea: 400,
      clearRoomArea: 72,
      corridorArea: 144,
      stairArea: 0,
      clearAreaEfficiency: 0.18,
      requiredAdjacencyTotal: 0,
      requiredAdjacencySatisfied: 0,
      preferredAdjacencyTotal: 0,
      preferredAdjacencySatisfied: 0,
      avoidedAdjacencyTotal: 0,
      avoidedAdjacencySatisfied: 0,
      maximumRoomAspectRatio: 4.5,
      doorCount: 1,
      windowCount: 0,
      stairRunCount: 0,
      allRoomsReachable: true,
      estimatedGeneratedWorldSpecEntityCount: 8,
      estimatedPrimitiveCount: 4,
    },
    score: {
      total: 0,
      areaDeviation: 0,
      aspectRatio: 0,
      preferredAdjacency: 0,
      preferredWindows: 0,
      nearDistance: 0,
      zoneOrdering: 0,
      seedTieBreak: 0,
    },
  };
}
