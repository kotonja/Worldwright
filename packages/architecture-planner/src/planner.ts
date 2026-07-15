import type { WorldSpec } from '@worldwright/worldspec';
import type { RobloxManifest } from '@worldwright/roblox-compiler';

import { evaluateLayoutAdjacencies } from './adjacency.js';
import {
  gridRectangleToLocalStuds,
  type ArchitectureGridRectangle,
  type SolvedLayout,
} from './candidate.js';
import { buildCirculationEdges, evaluateCirculation } from './circulation.js';
import {
  architectureDiagnostic,
  hasArchitectureErrors,
  sortArchitectureDiagnostics,
  type ArchitectureDiagnostic,
} from './diagnostics.js';
import { validateArchitecturePlan } from './directive-validation.js';
import {
  ArchitectureEmissionCapacityError,
  countArchitectureEmissionEntities,
  emitArchitectureWorldSpec,
} from './emit-worldspec.js';
import { ArchitectureGeneratedIdError, createGeneratedId } from './generated-id.js';
import { hashSourceWorldSpec } from './hashing.js';
import { normalizeArchitecturePlan } from './normalize.js';
import { buildOpenings, type DoorAdjacencyRequirement } from './openings.js';
import {
  ARCHITECTURE_PLANNER_VERSION,
  ARCHITECTURE_PLAN_VERSION,
  type ArchitectureFloorPlan,
  type ArchitectureOpening,
  type ArchitecturePlan,
  type ArchitecturePlanMetrics,
  type ArchitectureRectangle,
  type ArchitectureRoomSpace,
  type ArchitectureSpace,
  type ArchitectureStairHallSpace,
  type ArchitectureStairRun,
  type ArchitectureWall,
} from './plan-schema.js';
import {
  extractArchitectureSourceProfile,
  type ArchitectureSourceFloor,
  type ArchitectureSourceProfile,
} from './source-profile.js';
import { solveArchitectureLayout } from './solver.js';
import { buildStairRuns } from './stairs.js';
import { buildLogicalWalls } from './walls.js';
import { evaluateArchitecturePlan } from './plan-evaluation.js';

export interface ArchitecturePlanningSuccess {
  readonly success: true;
  readonly plan: ArchitecturePlan;
  readonly diagnostics: readonly ArchitectureDiagnostic[];
}

export interface ArchitecturePlanningFailure {
  readonly success: false;
  readonly diagnostics: readonly ArchitectureDiagnostic[];
}

export type ArchitecturePlanningResult = ArchitecturePlanningSuccess | ArchitecturePlanningFailure;

export type ArchitecturePlanAndEmissionResult =
  | {
      readonly success: true;
      readonly plan: ArchitecturePlan;
      readonly worldSpec: WorldSpec;
      readonly manifest: RobloxManifest;
      readonly architecturePlanHash: string;
      readonly diagnostics: readonly ArchitectureDiagnostic[];
    }
  | ArchitecturePlanningFailure;

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortAndDeduplicateDiagnostics(
  diagnostics: readonly ArchitectureDiagnostic[],
): ArchitectureDiagnostic[] {
  const sorted = sortArchitectureDiagnostics(diagnostics);
  return sorted.filter((entry, index) => {
    const previous = sorted[index - 1];
    return (
      previous === undefined ||
      entry.path !== previous.path ||
      entry.code !== previous.code ||
      entry.severity !== previous.severity ||
      entry.message !== previous.message ||
      entry.relatedId !== previous.relatedId
    );
  });
}

function sourceIdentifiers(source: WorldSpec): Set<string> {
  return new Set([
    source.project.id,
    ...source.references.map((value) => value.id),
    ...source.entities.map((value) => value.id),
    ...source.relationships.map((value) => value.id),
    ...source.constraints.map((value) => value.id),
    ...source.locks.map((value) => value.id),
  ]);
}

function nextGeneratedId(parts: readonly string[], used: Set<string>): string {
  const id = createGeneratedId(parts, used);
  used.add(id);
  return id;
}

function outerFootprint(profile: ArchitectureSourceProfile): ArchitectureRectangle {
  return {
    x: -profile.building.footprint.width / 2,
    z: -profile.building.footprint.depth / 2,
    width: profile.building.footprint.width,
    depth: profile.building.footprint.depth,
  };
}

function interiorEnvelope(profile: ArchitectureSourceProfile): ArchitectureRectangle {
  const outer = outerFootprint(profile);
  return {
    x: outer.x + profile.building.exteriorWallThickness,
    z: outer.z + profile.building.exteriorWallThickness,
    width: outer.width - 2 * profile.building.exteriorWallThickness,
    depth: outer.depth - 2 * profile.building.exteriorWallThickness,
  };
}

function localRectangle(
  profile: ArchitectureSourceProfile,
  layout: SolvedLayout,
  rectangle: ArchitectureGridRectangle,
): ArchitectureRectangle {
  return gridRectangleToLocalStuds(
    rectangle,
    layout.outerWidthCells,
    layout.outerDepthCells,
    profile.building.gridSize,
  );
}

function stairHallCellRectangle(
  profile: ArchitectureSourceProfile,
  layout: SolvedLayout,
  floorIndex: number,
): ArchitectureGridRectangle | undefined {
  const floor = layout.floors[floorIndex];
  if (
    floor?.stairCoreCells === undefined ||
    layout.stairSide === undefined ||
    profile.stair === undefined
  ) {
    return undefined;
  }
  const wallCells = profile.building.interiorWallThickness / profile.building.gridSize;
  const corridor = floor.corridorCells;
  if (layout.corridorAxis === 'x') {
    const depth =
      layout.stairSide === 'negative'
        ? layout.negativeBandDepthCells
        : layout.positiveBandDepthCells;
    const z =
      layout.stairSide === 'negative'
        ? corridor.z - wallCells - depth
        : corridor.z + corridor.depth + wallCells;
    return {
      x: floor.stairCoreCells.x,
      z,
      width: floor.stairCoreCells.width,
      depth,
    };
  }
  const width =
    layout.stairSide === 'negative' ? layout.negativeBandDepthCells : layout.positiveBandDepthCells;
  const x =
    layout.stairSide === 'negative'
      ? corridor.x - wallCells - width
      : corridor.x + corridor.width + wallCells;
  return {
    x,
    z: floor.stairCoreCells.z,
    width,
    depth: floor.stairCoreCells.depth,
  };
}

interface BuiltFloorGeometry {
  readonly sourceFloor: ArchitectureSourceFloor;
  readonly floor: ArchitectureFloorPlan;
  readonly spaces: readonly ArchitectureSpace[];
  readonly walls: readonly ArchitectureWall[];
  readonly openings: readonly ArchitectureOpening[];
}

function roomSpacesWithPlaceholders(
  profile: ArchitectureSourceProfile,
  layout: SolvedLayout,
  sourceFloor: ArchitectureSourceFloor,
  floorIndex: number,
  usedIds: ReadonlySet<string>,
): ArchitectureRoomSpace[] {
  const solvedFloor = layout.floors[floorIndex]!;
  const sourceRoomById = new Map(sourceFloor.rooms.map((room) => [room.entity.id, room] as const));
  return solvedFloor.rooms
    .map((placement): ArchitectureRoomSpace => {
      const sourceRoom = sourceRoomById.get(placement.roomId)!;
      return {
        id: placement.roomId,
        type: 'room',
        floorId: sourceFloor.entity.id,
        rectangle: localRectangle(profile, layout, placement.rectangleCells),
        zone: sourceRoom.directive.zone,
        isEntrance: sourceRoom.directive.isEntrance,
        provenance: sourceRoom.entity.provenance.classification,
        // Wall/opening construction replaces these deterministic non-output placeholders.
        corridorDoorOpeningId: createGeneratedId(
          ['pending', 'corridor-door', placement.roomId],
          usedIds,
        ),
        exteriorWallIds: [],
        clearArea: placement.clearArea,
        aspectRatio: placement.aspectRatio,
      };
    })
    .sort((left, right) => compareCodePoints(left.id, right.id));
}

function doorAdjacenciesForFloor(
  profile: ArchitectureSourceProfile,
  layout: SolvedLayout,
  floor: ArchitectureSourceFloor,
): DoorAdjacencyRequirement[] {
  const roomIds = new Set(floor.rooms.map((room) => room.entity.id));
  const directlyAdjacent = new Set(
    evaluateLayoutAdjacencies(profile, layout)
      .resolved.filter((value) => value.directlyAdjacent)
      .map((value) => value.relationshipId),
  );
  return profile.adjacencies
    .filter(
      (value) =>
        value.directive.connection === 'door' &&
        roomIds.has(value.relationship.sourceId) &&
        roomIds.has(value.relationship.targetId) &&
        directlyAdjacent.has(value.relationship.id),
    )
    .map((value) => ({
      relationshipId: value.relationship.id,
      fromRoomId: value.relationship.sourceId,
      toRoomId: value.relationship.targetId,
      requirement: value.directive.requirement === 'required' ? 'required' : 'preferred',
      connection: 'door',
    }));
}

function buildFloorGeometry(
  profile: ArchitectureSourceProfile,
  layout: SolvedLayout,
  sourceFloor: ArchitectureSourceFloor,
  floorIndex: number,
  exteriorEntranceNodeId: string,
  usedIds: Set<string>,
  diagnostics: ArchitectureDiagnostic[],
): BuiltFloorGeometry {
  const solvedFloor = layout.floors[floorIndex]!;
  const roomSpaces = roomSpacesWithPlaceholders(profile, layout, sourceFloor, floorIndex, usedIds);
  const corridorId = nextGeneratedId(['corridor', sourceFloor.entity.id], usedIds);
  const corridor: ArchitectureSpace = {
    id: corridorId,
    type: 'corridor',
    floorId: sourceFloor.entity.id,
    rectangle: localRectangle(profile, layout, solvedFloor.corridorCells),
  };
  const stairHallCells = stairHallCellRectangle(profile, layout, floorIndex);
  const stairHall: ArchitectureStairHallSpace | undefined =
    stairHallCells === undefined || profile.stair === undefined
      ? undefined
      : {
          id: nextGeneratedId(
            ['stair-hall', profile.stair.entity.id, sourceFloor.entity.id],
            usedIds,
          ),
          type: 'stair_hall',
          floorId: sourceFloor.entity.id,
          rectangle: localRectangle(profile, layout, stairHallCells),
          sourceStairRouteId: profile.stair.entity.id,
        };
  const spacesBeforeWalls: ArchitectureSpace[] = [
    ...roomSpaces,
    corridor,
    ...(stairHall === undefined ? [] : [stairHall]),
  ];

  const wallBuild = buildLogicalWalls({
    floorId: sourceFloor.entity.id,
    spaces: spacesBeforeWalls,
    interiorEnvelope: interiorEnvelope(profile),
    corridorAxis: layout.corridorAxis,
    exteriorWallThickness: profile.building.exteriorWallThickness,
    interiorWallThickness: profile.building.interiorWallThickness,
    wallHeight: sourceFloor.directive.clearHeight,
    usedIds,
  });
  for (const wall of wallBuild.walls) usedIds.add(wall.id);

  const openingBuild = buildOpenings({
    floorId: sourceFloor.entity.id,
    spaces: spacesBeforeWalls,
    walls: wallBuild.walls,
    roomRequirements: sourceFloor.rooms.map((room) => ({
      roomId: room.entity.id,
      doorWidth: room.directive.doorWidth ?? profile.building.defaultDoorWidth,
      minimumWindows: room.directive.windows.minimum,
      preferredWindows: room.directive.windows.preferred,
    })),
    doorAdjacencies: doorAdjacenciesForFloor(profile, layout, sourceFloor),
    ...(sourceFloor.rooms.some((room) => room.directive.isEntrance)
      ? {
          entranceRoomId: sourceFloor.rooms.find((room) => room.directive.isEntrance)!.entity.id,
        }
      : {}),
    exteriorEntranceNodeId,
    corridorAxis: layout.corridorAxis,
    entranceEnd: profile.building.entranceEnd,
    defaultDoorWidth: profile.building.defaultDoorWidth,
    defaultDoorHeight: profile.building.defaultDoorHeight,
    defaultWindowWidth: profile.building.defaultWindowWidth,
    defaultWindowHeight: profile.building.defaultWindowHeight,
    defaultWindowSillHeight: profile.building.defaultWindowSillHeight,
    openingEndClearance: profile.building.openingEndClearance,
    usedIds,
  });
  for (const opening of openingBuild.openings) usedIds.add(opening.id);
  for (const warning of openingBuild.warnings) {
    diagnostics.push(
      architectureDiagnostic(warning.code, '/spaces', warning.message, warning.roomId, 'warning'),
    );
  }

  const spaces: ArchitectureSpace[] = spacesBeforeWalls.map((space) => {
    if (space.type !== 'room') return space;
    const corridorDoorOpeningId = openingBuild.corridorDoorIds[space.id];
    if (corridorDoorOpeningId === undefined) {
      throw new Error(`Room ${space.id} did not receive a corridor door.`);
    }
    return {
      ...space,
      corridorDoorOpeningId,
      exteriorWallIds: [...(wallBuild.roomExteriorWallIds[space.id] ?? [])],
    };
  });
  const floor: ArchitectureFloorPlan = {
    id: sourceFloor.entity.id,
    level: sourceFloor.directive.level,
    finishedFloorElevation:
      profile.building.origin.y + sourceFloor.directive.level * profile.building.floorToFloorHeight,
    clearHeight: sourceFloor.directive.clearHeight,
    footprint: outerFootprint(profile),
    corridor: corridor.rectangle,
    ...(solvedFloor.stairCoreCells === undefined
      ? {}
      : { stairCore: localRectangle(profile, layout, solvedFloor.stairCoreCells) }),
    spaceIds: spaces.map((space) => space.id).sort(compareCodePoints),
    wallIds: openingBuild.walls.map((wall) => wall.id).sort(compareCodePoints),
    openingIds: openingBuild.openings.map((opening) => opening.id).sort(compareCodePoints),
    stairRunIds: [],
  };
  return {
    sourceFloor,
    floor,
    spaces,
    walls: openingBuild.walls,
    openings: openingBuild.openings,
  };
}

function planMetrics(
  profile: ArchitectureSourceProfile,
  layout: SolvedLayout,
  spaces: readonly ArchitectureSpace[],
  openings: readonly ArchitectureOpening[],
  stairRuns: readonly ArchitectureStairRun[],
  allRoomsReachable: boolean,
  estimatedGeneratedWorldSpecEntityCount: number,
  estimatedPrimitiveCount: number,
): ArchitecturePlanMetrics {
  const rooms = spaces.filter((space): space is ArchitectureRoomSpace => space.type === 'room');
  const corridors = spaces.filter((space) => space.type === 'corridor');
  const stairHalls = spaces.filter((space) => space.type === 'stair_hall');
  const adjacency = evaluateLayoutAdjacencies(profile, layout);
  const grossOuterArea =
    profile.building.footprint.width * profile.building.footprint.depth * profile.floors.length;
  const clearRoomArea = rooms.reduce((total, room) => total + room.clearArea, 0);
  const corridorArea = corridors.reduce(
    (total, corridor) => total + corridor.rectangle.width * corridor.rectangle.depth,
    0,
  );
  const stairArea = stairHalls.reduce(
    (total, stairHall) => total + stairHall.rectangle.width * stairHall.rectangle.depth,
    0,
  );
  return {
    floorCount: profile.floors.length,
    roomCount: rooms.length,
    grossOuterArea,
    clearRoomArea,
    corridorArea,
    stairArea,
    clearAreaEfficiency: grossOuterArea === 0 ? 0 : clearRoomArea / grossOuterArea,
    requiredAdjacencyTotal: adjacency.requiredTotal,
    requiredAdjacencySatisfied: adjacency.requiredSatisfied,
    preferredAdjacencyTotal: adjacency.preferredTotal,
    preferredAdjacencySatisfied: adjacency.preferredSatisfied,
    avoidedAdjacencyTotal: adjacency.avoidedTotal,
    avoidedAdjacencySatisfied: adjacency.avoidedSatisfied,
    maximumRoomAspectRatio: rooms.reduce((maximum, room) => Math.max(maximum, room.aspectRatio), 1),
    doorCount: openings.filter((opening) => opening.type === 'door').length,
    windowCount: openings.filter((opening) => opening.type === 'window').length,
    stairRunCount: stairRuns.length,
    allRoomsReachable,
    estimatedGeneratedWorldSpecEntityCount,
    estimatedPrimitiveCount,
  };
}

/**
 * Reconstructs the complete deterministic plan for an already-solved layout.
 *
 * This is intentionally separate from the public planner orchestration so source-bound plan
 * evaluation can perform a fresh solve and reconstruction without recursively invoking the
 * planner entry point.
 */
export function reconstructArchitecturePlanFromSolvedLayout(
  profile: ArchitectureSourceProfile,
  layout: SolvedLayout,
  diagnostics: ArchitectureDiagnostic[],
): ArchitecturePlan {
  const usedIds = sourceIdentifiers(profile.source);
  const exteriorEntranceNodeId = nextGeneratedId(
    ['exterior-entrance', profile.buildingEntity.id],
    usedIds,
  );
  const builtFloors = profile.floors.map((floor, index) =>
    buildFloorGeometry(profile, layout, floor, index, exteriorEntranceNodeId, usedIds, diagnostics),
  );
  const spaces = builtFloors.flatMap((built) => [...built.spaces]);
  const walls = builtFloors.flatMap((built) => [...built.walls]);
  const openings = builtFloors.flatMap((built) => [...built.openings]);

  const stairRuns =
    profile.stair === undefined || builtFloors[0]?.floor.stairCore === undefined
      ? []
      : buildStairRuns({
          sourceStairRouteId: profile.stair.entity.id,
          floors: builtFloors.map((built) => ({
            floorId: built.floor.id,
            level: built.floor.level,
            finishedFloorElevation: built.floor.finishedFloorElevation,
          })),
          core: builtFloors[0].floor.stairCore,
          corridorAxis: layout.corridorAxis,
          maximumRiserHeight: profile.stair.directive.maximumRiserHeight,
          minimumTreadDepth: profile.stair.directive.minimumTreadDepth,
          usedIds,
        });
  for (const run of stairRuns) usedIds.add(run.id);

  const floors = builtFloors.map((built) => ({
    ...built.floor,
    stairRunIds: stairRuns
      .filter((run) => run.fromFloorId === built.floor.id || run.toFloorId === built.floor.id)
      .map((run) => run.id)
      .sort(compareCodePoints),
  }));
  const circulationEdges = buildCirculationEdges({
    openings,
    stairRuns,
    spaces,
    usedIds,
  });
  for (const edge of circulationEdges) usedIds.add(edge.id);
  const circulation = evaluateCirculation(exteriorEntranceNodeId, spaces, circulationEdges);
  if (!circulation.allRoomsReachable || !circulation.allRequiredNodesReachable) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.circulation_unreachable',
        '/circulationEdges',
        `Circulation graph has unreachable nodes: ${circulation.unreachableNodeIds.join(', ')}.`,
      ),
    );
  }

  const sourceHash = hashSourceWorldSpec(profile.source);
  const provisionalMetrics = planMetrics(
    profile,
    layout,
    spaces,
    openings,
    stairRuns,
    circulation.allRoomsReachable,
    0,
    0,
  );
  const provisional: ArchitecturePlan = {
    schemaVersion: ARCHITECTURE_PLAN_VERSION,
    plannerVersion: ARCHITECTURE_PLANNER_VERSION,
    source: {
      worldSpecSchemaVersion: profile.source.schemaVersion,
      projectId: profile.source.project.id,
      worldSpecHash: sourceHash,
      buildingEntityId: profile.buildingEntity.id,
    },
    building: {
      topology: profile.building.topology,
      outerFootprint: outerFootprint(profile),
      interiorEnvelope: interiorEnvelope(profile),
      localOrigin: 'footprint_center',
      worldOrigin: { ...profile.building.origin },
      yawDegrees: profile.building.yawDegrees,
      gridSize: profile.building.gridSize,
      corridorAxis: layout.corridorAxis,
      entranceEnd: profile.building.entranceEnd,
      floorToFloorHeight: profile.building.floorToFloorHeight,
      defaultClearHeight: profile.building.defaultClearHeight,
      exteriorWallThickness: profile.building.exteriorWallThickness,
      interiorWallThickness: profile.building.interiorWallThickness,
      slabThickness: profile.building.slabThickness,
      corridorWidth: profile.building.corridorWidth,
      defaultDoorWidth: profile.building.defaultDoorWidth,
      defaultDoorHeight: profile.building.defaultDoorHeight,
      defaultWindowWidth: profile.building.defaultWindowWidth,
      defaultWindowHeight: profile.building.defaultWindowHeight,
      defaultWindowSillHeight: profile.building.defaultWindowSillHeight,
      openingEndClearance: profile.building.openingEndClearance,
      materials: { ...profile.building.materials },
      colors: {
        exteriorWall: { ...profile.building.colors.exteriorWall },
        interiorWall: { ...profile.building.colors.interiorWall },
        floor: { ...profile.building.colors.floor },
        stair: { ...profile.building.colors.stair },
        window: { ...profile.building.colors.window },
      },
      windowTransparency: profile.building.windowTransparency,
    },
    floors,
    spaces,
    walls,
    openings,
    stairRuns: [...stairRuns],
    circulationEdges: [...circulationEdges],
    metrics: provisionalMetrics,
    score: layout.score,
  };
  const counts = countArchitectureEmissionEntities(profile.source, provisional);
  return {
    ...provisional,
    metrics: planMetrics(
      profile,
      layout,
      spaces,
      openings,
      stairRuns,
      circulation.allRoomsReachable,
      counts.totalDerivedEntityCount,
      counts.primitiveCount,
    ),
  };
}

/** Validates a source program, solves it, constructs geometry, and returns a complete plan. */
export function planArchitectureWorldSpec(input: unknown): ArchitecturePlanningResult {
  const profileResult = extractArchitectureSourceProfile(input);
  if (!profileResult.valid) {
    return { success: false, diagnostics: profileResult.diagnostics };
  }
  const diagnostics: ArchitectureDiagnostic[] = [...profileResult.diagnostics];
  const solved = solveArchitectureLayout(profileResult.value);
  if (!solved.success) {
    return {
      success: false,
      diagnostics: sortAndDeduplicateDiagnostics([...diagnostics, ...solved.diagnostics]),
    };
  }
  diagnostics.push(...solved.diagnostics);

  try {
    const plan = normalizeArchitecturePlan(
      reconstructArchitecturePlanFromSolvedLayout(profileResult.value, solved.layout, diagnostics),
    );
    const planValidation = validateArchitecturePlan(plan);
    if (!planValidation.valid) {
      return {
        success: false,
        diagnostics: sortAndDeduplicateDiagnostics([...diagnostics, ...planValidation.diagnostics]),
      };
    }
    const instanceLimit = profileResult.value.source.budgets.limits?.instances;
    if (
      instanceLimit !== undefined &&
      plan.metrics.estimatedGeneratedWorldSpecEntityCount > instanceLimit
    ) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.instance_budget_exceeded',
          '/budgets/limits/instances',
          `Planned derived entity count ${String(plan.metrics.estimatedGeneratedWorldSpecEntityCount)} exceeds instance budget ${String(instanceLimit)}.`,
        ),
      );
    }
    const sortedDiagnostics = sortAndDeduplicateDiagnostics(diagnostics);
    if (hasArchitectureErrors(sortedDiagnostics)) {
      return { success: false, diagnostics: sortedDiagnostics };
    }
    const evaluation = evaluateArchitecturePlan(profileResult.value.source, planValidation.value);
    if (!evaluation.valid) {
      return {
        success: false,
        diagnostics: sortAndDeduplicateDiagnostics([
          ...sortedDiagnostics,
          ...evaluation.diagnostics,
        ]),
      };
    }
    return {
      success: true,
      plan: evaluation.value,
      diagnostics: sortAndDeduplicateDiagnostics([...sortedDiagnostics, ...evaluation.diagnostics]),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown planner construction failure.';
    const generatedIdFailure = error instanceof ArchitectureGeneratedIdError;
    const capacityFailure = error instanceof ArchitectureEmissionCapacityError;
    return {
      success: false,
      diagnostics: sortAndDeduplicateDiagnostics([
        ...diagnostics,
        architectureDiagnostic(
          generatedIdFailure
            ? 'architecture.generated_id_collision'
            : capacityFailure
              ? 'architecture.capacity_exceeded'
              : 'architecture.infeasible',
          capacityFailure ? '/metrics' : '/entities',
          generatedIdFailure
            ? `Architecture generated-ID construction failed: ${message}`
            : capacityFailure
              ? message
              : `Architecture geometry construction failed: ${message}`,
          profileResult.value.buildingEntity.id,
        ),
      ]),
    };
  }
}

/** Convenience orchestration for the complete pure plan-and-emit pipeline. */
export function planAndEmitArchitectureWorldSpec(
  input: unknown,
): ArchitecturePlanAndEmissionResult {
  const planning = planArchitectureWorldSpec(input);
  if (!planning.success) return planning;
  const emission = emitArchitectureWorldSpec(input, planning.plan);
  if (!emission.success) {
    return {
      success: false,
      diagnostics: sortAndDeduplicateDiagnostics([
        ...planning.diagnostics,
        ...emission.diagnostics,
      ]),
    };
  }
  return {
    success: true,
    plan: planning.plan,
    worldSpec: emission.worldSpec,
    manifest: emission.manifest,
    architecturePlanHash: emission.architecturePlanHash,
    diagnostics: sortAndDeduplicateDiagnostics([...planning.diagnostics, ...emission.diagnostics]),
  };
}
