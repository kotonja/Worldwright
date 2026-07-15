import type {
  ArchitectureBuildingDirective,
  ArchitectureEntityDirective,
  ArchitectureFloorDirective,
  ArchitectureRoomDirective,
  ArchitectureStairDirective,
} from './entity-directive-schema.js';
import type {
  ArchitectureCirculationEdge,
  ArchitectureCorridorSpace,
  ArchitectureFloorPlan,
  ArchitectureLandingGeometry,
  ArchitectureOpening,
  ArchitecturePlan,
  ArchitecturePlanBuilding,
  ArchitectureRectangle,
  ArchitectureRoomSpace,
  ArchitectureSpace,
  ArchitectureStairHallSpace,
  ArchitectureStairRun,
  ArchitectureWall,
} from './plan-schema.js';
import type { ArchitectureRelationshipDirective } from './relationship-directive-schema.js';
import { compareCodePoints, stringifyCanonicalJson, type JsonValue } from './json.js';

function number(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function normalizeRectangle(input: Readonly<ArchitectureRectangle>): ArchitectureRectangle {
  return {
    x: number(input.x),
    z: number(input.z),
    width: number(input.width),
    depth: number(input.depth),
  };
}

function normalizeBuildingDirective(
  input: Readonly<ArchitectureBuildingDirective>,
): ArchitectureBuildingDirective {
  return {
    schemaVersion: input.schemaVersion,
    mode: 'building',
    topology: 'double_loaded_spine',
    footprint: { width: number(input.footprint.width), depth: number(input.footprint.depth) },
    origin: { x: number(input.origin.x), y: number(input.origin.y), z: number(input.origin.z) },
    yawDegrees: input.yawDegrees,
    gridSize: number(input.gridSize),
    corridorAxis: input.corridorAxis,
    entranceEnd: input.entranceEnd,
    floorToFloorHeight: number(input.floorToFloorHeight),
    defaultClearHeight: number(input.defaultClearHeight),
    exteriorWallThickness: number(input.exteriorWallThickness),
    interiorWallThickness: number(input.interiorWallThickness),
    slabThickness: number(input.slabThickness),
    corridorWidth: number(input.corridorWidth),
    defaultDoorWidth: number(input.defaultDoorWidth),
    defaultDoorHeight: number(input.defaultDoorHeight),
    defaultWindowWidth: number(input.defaultWindowWidth),
    defaultWindowHeight: number(input.defaultWindowHeight),
    defaultWindowSillHeight: number(input.defaultWindowSillHeight),
    openingEndClearance: number(input.openingEndClearance),
    materials: {
      exteriorWall: input.materials.exteriorWall,
      interiorWall: input.materials.interiorWall,
      floor: input.materials.floor,
      stair: input.materials.stair,
      window: input.materials.window,
    },
    colors: {
      exteriorWall: { ...input.colors.exteriorWall },
      interiorWall: { ...input.colors.interiorWall },
      floor: { ...input.colors.floor },
      stair: { ...input.colors.stair },
      window: { ...input.colors.window },
    },
    windowTransparency: number(input.windowTransparency),
  };
}

function normalizeFloorDirective(
  input: Readonly<ArchitectureFloorDirective>,
): ArchitectureFloorDirective {
  return {
    schemaVersion: input.schemaVersion,
    mode: 'floor',
    level: number(input.level),
    clearHeight: number(input.clearHeight),
  };
}

function normalizeRoomDirective(
  input: Readonly<ArchitectureRoomDirective>,
): ArchitectureRoomDirective {
  return {
    schemaVersion: input.schemaVersion,
    mode: 'room',
    minimumArea: number(input.minimumArea),
    preferredArea: number(input.preferredArea),
    maximumArea: number(input.maximumArea),
    minimumSpan: number(input.minimumSpan),
    maximumAspectRatio: number(input.maximumAspectRatio),
    zone: input.zone,
    isEntrance: input.isEntrance,
    ...(input.doorWidth === undefined ? {} : { doorWidth: number(input.doorWidth) }),
    windows: {
      minimum: number(input.windows.minimum),
      preferred: number(input.windows.preferred),
    },
  };
}

function normalizeStairDirective(
  input: Readonly<ArchitectureStairDirective>,
): ArchitectureStairDirective {
  return {
    schemaVersion: input.schemaVersion,
    mode: 'stair',
    floorIds: [...input.floorIds],
    coreWidth: number(input.coreWidth),
    coreLength: number(input.coreLength),
    preferredSide: input.preferredSide,
    position: 'rear',
    maximumRiserHeight: number(input.maximumRiserHeight),
    minimumTreadDepth: number(input.minimumTreadDepth),
  };
}

export function normalizeArchitectureEntityDirective(
  input: Readonly<ArchitectureEntityDirective>,
): ArchitectureEntityDirective {
  switch (input.mode) {
    case 'building':
      return normalizeBuildingDirective(input);
    case 'floor':
      return normalizeFloorDirective(input);
    case 'room':
      return normalizeRoomDirective(input);
    case 'stair':
      return normalizeStairDirective(input);
  }
}

export function normalizeArchitectureRelationshipDirective(
  input: Readonly<ArchitectureRelationshipDirective>,
): ArchitectureRelationshipDirective {
  return {
    schemaVersion: input.schemaVersion,
    mode: 'adjacency',
    requirement: input.requirement,
    connection: input.connection,
    weight: number(input.weight),
  } as ArchitectureRelationshipDirective;
}

function normalizePlanBuilding(
  input: Readonly<ArchitecturePlanBuilding>,
): ArchitecturePlanBuilding {
  return {
    topology: 'double_loaded_spine',
    outerFootprint: normalizeRectangle(input.outerFootprint),
    interiorEnvelope: normalizeRectangle(input.interiorEnvelope),
    localOrigin: 'footprint_center',
    worldOrigin: {
      x: number(input.worldOrigin.x),
      y: number(input.worldOrigin.y),
      z: number(input.worldOrigin.z),
    },
    yawDegrees: input.yawDegrees,
    gridSize: number(input.gridSize),
    corridorAxis: input.corridorAxis,
    entranceEnd: input.entranceEnd,
    floorToFloorHeight: number(input.floorToFloorHeight),
    defaultClearHeight: number(input.defaultClearHeight),
    exteriorWallThickness: number(input.exteriorWallThickness),
    interiorWallThickness: number(input.interiorWallThickness),
    slabThickness: number(input.slabThickness),
    corridorWidth: number(input.corridorWidth),
    defaultDoorWidth: number(input.defaultDoorWidth),
    defaultDoorHeight: number(input.defaultDoorHeight),
    defaultWindowWidth: number(input.defaultWindowWidth),
    defaultWindowHeight: number(input.defaultWindowHeight),
    defaultWindowSillHeight: number(input.defaultWindowSillHeight),
    openingEndClearance: number(input.openingEndClearance),
    materials: { ...input.materials },
    colors: {
      exteriorWall: { ...input.colors.exteriorWall },
      interiorWall: { ...input.colors.interiorWall },
      floor: { ...input.colors.floor },
      stair: { ...input.colors.stair },
      window: { ...input.colors.window },
    },
    windowTransparency: number(input.windowTransparency),
  };
}

function sortIds(ids: readonly string[]): string[] {
  return [...ids].sort(compareCodePoints);
}

function normalizeFloor(input: Readonly<ArchitectureFloorPlan>): ArchitectureFloorPlan {
  return {
    id: input.id,
    level: number(input.level),
    finishedFloorElevation: number(input.finishedFloorElevation),
    clearHeight: number(input.clearHeight),
    footprint: normalizeRectangle(input.footprint),
    corridor: normalizeRectangle(input.corridor),
    ...(input.stairCore === undefined ? {} : { stairCore: normalizeRectangle(input.stairCore) }),
    spaceIds: sortIds(input.spaceIds),
    wallIds: sortIds(input.wallIds),
    openingIds: sortIds(input.openingIds),
    stairRunIds: sortIds(input.stairRunIds),
  };
}

function normalizeRoomSpace(input: Readonly<ArchitectureRoomSpace>): ArchitectureRoomSpace {
  return {
    id: input.id,
    type: 'room',
    floorId: input.floorId,
    rectangle: normalizeRectangle(input.rectangle),
    zone: input.zone,
    isEntrance: input.isEntrance,
    provenance: input.provenance,
    corridorDoorOpeningId: input.corridorDoorOpeningId,
    exteriorWallIds: sortIds(input.exteriorWallIds),
    clearArea: number(input.clearArea),
    aspectRatio: number(input.aspectRatio),
  };
}

function normalizeCorridorSpace(
  input: Readonly<ArchitectureCorridorSpace>,
): ArchitectureCorridorSpace {
  return {
    id: input.id,
    type: 'corridor',
    floorId: input.floorId,
    rectangle: normalizeRectangle(input.rectangle),
  };
}

function normalizeStairHallSpace(
  input: Readonly<ArchitectureStairHallSpace>,
): ArchitectureStairHallSpace {
  return {
    id: input.id,
    type: 'stair_hall',
    floorId: input.floorId,
    rectangle: normalizeRectangle(input.rectangle),
    sourceStairRouteId: input.sourceStairRouteId,
  };
}

function normalizeSpace(input: Readonly<ArchitectureSpace>): ArchitectureSpace {
  switch (input.type) {
    case 'room':
      return normalizeRoomSpace(input);
    case 'corridor':
      return normalizeCorridorSpace(input);
    case 'stair_hall':
      return normalizeStairHallSpace(input);
  }
}

function normalizeWall(input: Readonly<ArchitectureWall>): ArchitectureWall {
  return {
    id: input.id,
    floorId: input.floorId,
    kind: input.kind,
    axis: input.axis,
    constant: number(input.constant),
    start: number(input.start),
    end: number(input.end),
    thickness: number(input.thickness),
    height: number(input.height),
    ...(input.firstSpaceId === undefined ? {} : { firstSpaceId: input.firstSpaceId }),
    ...(input.secondSpaceId === undefined ? {} : { secondSpaceId: input.secondSpaceId }),
    ...(input.exterior === undefined ? {} : { exterior: true as const }),
    openingIds: sortIds(input.openingIds),
  };
}

function normalizeOpening(input: Readonly<ArchitectureOpening>): ArchitectureOpening {
  return {
    id: input.id,
    floorId: input.floorId,
    wallId: input.wallId,
    type: input.type,
    offset: number(input.offset),
    width: number(input.width),
    bottom: number(input.bottom),
    height: number(input.height),
    sourceId: input.sourceId,
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
  };
}

function normalizeLanding(
  input: Readonly<ArchitectureLandingGeometry>,
): ArchitectureLandingGeometry {
  return {
    lower: normalizeRectangle(input.lower),
    upper: normalizeRectangle(input.upper),
  };
}

function normalizeStairRun(input: Readonly<ArchitectureStairRun>): ArchitectureStairRun {
  return {
    id: input.id,
    sourceStairRouteId: input.sourceStairRouteId,
    fromFloorId: input.fromFloorId,
    toFloorId: input.toFloorId,
    core: normalizeRectangle(input.core),
    direction: input.direction,
    stepCount: number(input.stepCount),
    riserHeight: number(input.riserHeight),
    treadDepth: number(input.treadDepth),
    clearWidth: number(input.clearWidth),
    landing: normalizeLanding(input.landing),
  };
}

function normalizeCirculationEdge(
  input: Readonly<ArchitectureCirculationEdge>,
): ArchitectureCirculationEdge {
  return {
    id: input.id,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    traversal: input.traversal,
  };
}

/** Returns a canonical, deeply independent Architecture Plan value. */
export function normalizeArchitecturePlan(input: Readonly<ArchitecturePlan>): ArchitecturePlan {
  return {
    schemaVersion: input.schemaVersion,
    plannerVersion: input.plannerVersion,
    source: {
      worldSpecSchemaVersion: input.source.worldSpecSchemaVersion,
      projectId: input.source.projectId,
      worldSpecHash: input.source.worldSpecHash,
      buildingEntityId: input.source.buildingEntityId,
    },
    building: normalizePlanBuilding(input.building),
    floors: input.floors
      .map((floor) => normalizeFloor(floor))
      .sort((left, right) => left.level - right.level || compareCodePoints(left.id, right.id)),
    spaces: input.spaces
      .map((space) => normalizeSpace(space))
      .sort((left, right) => compareCodePoints(left.id, right.id)),
    walls: input.walls
      .map((wall) => normalizeWall(wall))
      .sort((left, right) => compareCodePoints(left.id, right.id)),
    openings: input.openings
      .map((opening) => normalizeOpening(opening))
      .sort((left, right) => compareCodePoints(left.id, right.id)),
    stairRuns: input.stairRuns
      .map((run) => normalizeStairRun(run))
      .sort((left, right) => compareCodePoints(left.id, right.id)),
    circulationEdges: input.circulationEdges
      .map((edge) => normalizeCirculationEdge(edge))
      .sort((left, right) => compareCodePoints(left.id, right.id)),
    metrics: {
      floorCount: number(input.metrics.floorCount),
      roomCount: number(input.metrics.roomCount),
      grossOuterArea: number(input.metrics.grossOuterArea),
      clearRoomArea: number(input.metrics.clearRoomArea),
      corridorArea: number(input.metrics.corridorArea),
      stairArea: number(input.metrics.stairArea),
      clearAreaEfficiency: number(input.metrics.clearAreaEfficiency),
      requiredAdjacencyTotal: number(input.metrics.requiredAdjacencyTotal),
      requiredAdjacencySatisfied: number(input.metrics.requiredAdjacencySatisfied),
      preferredAdjacencyTotal: number(input.metrics.preferredAdjacencyTotal),
      preferredAdjacencySatisfied: number(input.metrics.preferredAdjacencySatisfied),
      avoidedAdjacencyTotal: number(input.metrics.avoidedAdjacencyTotal),
      avoidedAdjacencySatisfied: number(input.metrics.avoidedAdjacencySatisfied),
      maximumRoomAspectRatio: number(input.metrics.maximumRoomAspectRatio),
      doorCount: number(input.metrics.doorCount),
      windowCount: number(input.metrics.windowCount),
      stairRunCount: number(input.metrics.stairRunCount),
      allRoomsReachable: input.metrics.allRoomsReachable,
      estimatedGeneratedWorldSpecEntityCount: number(
        input.metrics.estimatedGeneratedWorldSpecEntityCount,
      ),
      estimatedPrimitiveCount: number(input.metrics.estimatedPrimitiveCount),
    },
    score: {
      total: number(input.score.total),
      areaDeviation: number(input.score.areaDeviation),
      aspectRatio: number(input.score.aspectRatio),
      preferredAdjacency: number(input.score.preferredAdjacency),
      preferredWindows: number(input.score.preferredWindows),
      nearDistance: number(input.score.nearDistance),
      zoneOrdering: number(input.score.zoneOrdering),
      seedTieBreak: number(input.score.seedTieBreak),
    },
  };
}

export function stringifyArchitecturePlan(input: Readonly<ArchitecturePlan>): string {
  return stringifyCanonicalJson(normalizeArchitecturePlan(input) as unknown as JsonValue);
}
