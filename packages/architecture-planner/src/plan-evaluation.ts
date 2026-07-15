import { stringifyCanonicalJson, type JsonValue } from './json.js';
import {
  architectureDiagnostic,
  hasArchitectureErrors,
  sortArchitectureDiagnostics,
  type ArchitectureDiagnostic,
} from './diagnostics.js';
import { validateArchitecturePlan } from './directive-validation.js';
import { ArchitectureEmissionCapacityError } from './emit-worldspec.js';
import { evaluateSolvedLayout } from './evaluation.js';
import { ArchitectureGeneratedIdError } from './generated-id.js';
import { hashSourceWorldSpec } from './hashing.js';
import { evaluateCirculation } from './circulation.js';
import { normalizeArchitecturePlan } from './normalize.js';
import { validateOpeningIntervals } from './openings.js';
import { reconstructArchitecturePlanFromSolvedLayout } from './planner.js';
import type {
  ArchitectureGridRectangle,
  SolvedFloorLayout,
  SolvedLayout,
  SolvedRoomPlacement,
} from './candidate.js';
import type {
  ArchitectureFloorPlan,
  ArchitecturePlan,
  ArchitecturePlanBuilding,
  ArchitectureRectangle,
  ArchitectureRoomSpace,
  ArchitectureSpace,
  ArchitectureWall,
} from './plan-schema.js';
import {
  extractArchitectureSourceProfile,
  type ArchitectureSourceProfile,
} from './source-profile.js';
import { solveArchitectureLayout } from './solver.js';

export type ArchitecturePlanEvaluationResult =
  | {
      readonly valid: true;
      readonly value: ArchitecturePlan;
      readonly diagnostics: readonly ArchitectureDiagnostic[];
    }
  | {
      readonly valid: false;
      readonly diagnostics: readonly ArchitectureDiagnostic[];
    };

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

function rectangleArea(rectangle: Readonly<ArchitectureRectangle>): number {
  return rectangle.width * rectangle.depth;
}

function rectanglesOverlap(
  left: Readonly<ArchitectureRectangle>,
  right: Readonly<ArchitectureRectangle>,
): boolean {
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.z < right.z + right.depth &&
    right.z < left.z + left.depth
  );
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort(compareCodePoints);
  const b = [...right].sort(compareCodePoints);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function numberEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return stringifyCanonicalJson(left as JsonValue) === stringifyCanonicalJson(right as JsonValue);
}

interface DeterministicPlanReconstruction {
  readonly layout: SolvedLayout;
  readonly plan: ArchitecturePlan;
}

function reconstructExpectedPlan(
  profile: Readonly<ArchitectureSourceProfile>,
  diagnostics: ArchitectureDiagnostic[],
): DeterministicPlanReconstruction | undefined {
  const solved = solveArchitectureLayout(profile);
  diagnostics.push(...solved.diagnostics);
  if (!solved.success) return undefined;

  const constructionDiagnostics: ArchitectureDiagnostic[] = [];
  try {
    const plan = normalizeArchitecturePlan(
      reconstructArchitecturePlanFromSolvedLayout(profile, solved.layout, constructionDiagnostics),
    );
    diagnostics.push(...constructionDiagnostics);
    return { layout: solved.layout, plan };
  } catch (error: unknown) {
    const generatedIdFailure = error instanceof ArchitectureGeneratedIdError;
    const capacityFailure = error instanceof ArchitectureEmissionCapacityError;
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push(
      architectureDiagnostic(
        generatedIdFailure
          ? 'architecture.generated_id_collision'
          : capacityFailure
            ? 'architecture.capacity_exceeded'
            : 'architecture.plan_invalid',
        capacityFailure ? '/metrics' : '/entities',
        generatedIdFailure
          ? `Architecture generated-ID reconstruction failed: ${message}`
          : capacityFailure
            ? message
            : `Architecture Plan reconstruction failed: ${message}`,
        profile.buildingEntity.id,
      ),
    );
    return undefined;
  }
}

function validateDeterministicReconstruction(
  plan: Readonly<ArchitecturePlan>,
  expected: Readonly<ArchitecturePlan>,
  diagnostics: ArchitectureDiagnostic[],
): void {
  const sections = [
    'schemaVersion',
    'plannerVersion',
    'source',
    'building',
    'floors',
    'spaces',
    'walls',
    'openings',
    'stairRuns',
    'circulationEdges',
    'metrics',
    'score',
  ] as const satisfies readonly (keyof ArchitecturePlan)[];
  for (const section of sections) {
    if (canonicalEqual(plan[section], expected[section])) continue;
    diagnostics.push(
      architectureDiagnostic(
        section === 'source' ? 'architecture.plan_stale' : 'architecture.plan_invalid',
        `/${section}`,
        `Architecture Plan ${section} does not match the deterministic plan reconstructed from the canonical source.`,
        section === 'source' ? plan.source.buildingEntityId : undefined,
      ),
    );
  }
}

function expectedBuilding(
  profile: Readonly<ArchitectureSourceProfile>,
  corridorAxis: 'x' | 'z',
): ArchitecturePlanBuilding {
  const outerFootprint = {
    x: -profile.building.footprint.width / 2,
    z: -profile.building.footprint.depth / 2,
    width: profile.building.footprint.width,
    depth: profile.building.footprint.depth,
  };
  return {
    topology: profile.building.topology,
    outerFootprint,
    interiorEnvelope: {
      x: outerFootprint.x + profile.building.exteriorWallThickness,
      z: outerFootprint.z + profile.building.exteriorWallThickness,
      width: outerFootprint.width - 2 * profile.building.exteriorWallThickness,
      depth: outerFootprint.depth - 2 * profile.building.exteriorWallThickness,
    },
    localOrigin: 'footprint_center',
    worldOrigin: { ...profile.building.origin },
    yawDegrees: profile.building.yawDegrees,
    gridSize: profile.building.gridSize,
    corridorAxis,
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
  };
}

function toGridRectangle(
  rectangle: Readonly<ArchitectureRectangle>,
  outer: Readonly<ArchitectureRectangle>,
  gridSize: number,
): ArchitectureGridRectangle {
  return {
    x: (rectangle.x - outer.x) / gridSize,
    z: (rectangle.z - outer.z) / gridSize,
    width: rectangle.width / gridSize,
    depth: rectangle.depth / gridSize,
  };
}

function reconstructFloorLayout(
  plan: Readonly<ArchitecturePlan>,
  floor: Readonly<ArchitectureFloorPlan>,
  spaces: readonly ArchitectureSpace[],
  diagnostics: ArchitectureDiagnostic[],
): SolvedFloorLayout {
  const corridorCells = toGridRectangle(
    floor.corridor,
    plan.building.outerFootprint,
    plan.building.gridSize,
  );
  const roomSpaces = spaces.filter(
    (space): space is ArchitectureRoomSpace => space.type === 'room',
  );
  const negative: SolvedRoomPlacement[] = [];
  const positive: SolvedRoomPlacement[] = [];
  for (const room of roomSpaces) {
    const negativeTouch =
      plan.building.corridorAxis === 'x'
        ? numberEqual(
            room.rectangle.z + room.rectangle.depth + plan.building.interiorWallThickness,
            floor.corridor.z,
          )
        : numberEqual(
            room.rectangle.x + room.rectangle.width + plan.building.interiorWallThickness,
            floor.corridor.x,
          );
    const positiveTouch =
      plan.building.corridorAxis === 'x'
        ? numberEqual(
            room.rectangle.z,
            floor.corridor.z + floor.corridor.depth + plan.building.interiorWallThickness,
          )
        : numberEqual(
            room.rectangle.x,
            floor.corridor.x + floor.corridor.width + plan.building.interiorWallThickness,
          );
    if (negativeTouch === positiveTouch) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          '/spaces',
          'Every room must touch exactly one corridor boundary through one wall thickness.',
          room.id,
        ),
      );
    }
    const placement: SolvedRoomPlacement = {
      roomId: room.id,
      floorId: room.floorId,
      side: negativeTouch ? 'negative' : 'positive',
      sequenceIndex: 0,
      rectangleCells: toGridRectangle(
        room.rectangle,
        plan.building.outerFootprint,
        plan.building.gridSize,
      ),
      clearArea: room.clearArea,
      aspectRatio: room.aspectRatio,
    };
    (negativeTouch ? negative : positive).push(placement);
  }
  const axisStart = (room: Readonly<SolvedRoomPlacement>): number =>
    plan.building.corridorAxis === 'x' ? room.rectangleCells.x : room.rectangleCells.z;
  const sortSequence = (values: SolvedRoomPlacement[]): SolvedRoomPlacement[] =>
    values.sort((left, right) => {
      const coordinate = axisStart(left) - axisStart(right);
      const ordered = plan.building.entranceEnd === 'negative' ? coordinate : -coordinate;
      return ordered || compareCodePoints(left.roomId, right.roomId);
    });
  sortSequence(negative).forEach((room, index) => {
    (room as { sequenceIndex: number }).sequenceIndex = index;
  });
  sortSequence(positive).forEach((room, index) => {
    (room as { sequenceIndex: number }).sequenceIndex = index;
  });
  const rooms = [...negative, ...positive].sort((left, right) =>
    compareCodePoints(left.roomId, right.roomId),
  );
  return {
    floorId: floor.id,
    level: floor.level,
    corridorCells,
    ...(floor.stairCore === undefined
      ? {}
      : {
          stairCoreCells: toGridRectangle(
            floor.stairCore,
            plan.building.outerFootprint,
            plan.building.gridSize,
          ),
        }),
    negativeSequence: negative.map((room) => room.roomId),
    positiveSequence: positive.map((room) => room.roomId),
    rooms,
    signature: floor.id,
  };
}

function reconstructSolvedLayout(
  plan: Readonly<ArchitecturePlan>,
  diagnostics: ArchitectureDiagnostic[],
): SolvedLayout {
  const floors = plan.floors.map((floor) =>
    reconstructFloorLayout(
      plan,
      floor,
      plan.spaces.filter((space) => space.floorId === floor.id),
      diagnostics,
    ),
  );
  const firstCorridor = plan.floors[0]?.corridor;
  const negativeBandDepth =
    firstCorridor === undefined
      ? 0
      : plan.building.corridorAxis === 'x'
        ? firstCorridor.z - plan.building.interiorWallThickness - plan.building.interiorEnvelope.z
        : firstCorridor.x - plan.building.interiorWallThickness - plan.building.interiorEnvelope.x;
  const positiveBandDepth =
    firstCorridor === undefined
      ? 0
      : plan.building.corridorAxis === 'x'
        ? plan.building.interiorEnvelope.z +
          plan.building.interiorEnvelope.depth -
          (firstCorridor.z + firstCorridor.depth + plan.building.interiorWallThickness)
        : plan.building.interiorEnvelope.x +
          plan.building.interiorEnvelope.width -
          (firstCorridor.x + firstCorridor.width + plan.building.interiorWallThickness);
  const firstCore = plan.floors.find((floor) => floor.stairCore !== undefined)?.stairCore;
  let stairSide: 'negative' | 'positive' | undefined;
  if (firstCore !== undefined && firstCorridor !== undefined) {
    stairSide =
      plan.building.corridorAxis === 'x'
        ? firstCore.z < firstCorridor.z
          ? 'negative'
          : 'positive'
        : firstCore.x < firstCorridor.x
          ? 'negative'
          : 'positive';
  }
  return {
    corridorAxis: plan.building.corridorAxis,
    ...(stairSide === undefined ? {} : { stairSide }),
    negativeBandDepthCells: negativeBandDepth / plan.building.gridSize,
    positiveBandDepthCells: positiveBandDepth / plan.building.gridSize,
    outerWidthCells: plan.building.outerFootprint.width / plan.building.gridSize,
    outerDepthCells: plan.building.outerFootprint.depth / plan.building.gridSize,
    floors,
    score: plan.score,
    signature: 'reconstructed-plan',
  };
}

function validatePlanReferences(
  profile: Readonly<ArchitectureSourceProfile>,
  plan: Readonly<ArchitecturePlan>,
  diagnostics: ArchitectureDiagnostic[],
): void {
  const floorById = new Map(plan.floors.map((floor) => [floor.id, floor] as const));
  const spaceById = new Map(plan.spaces.map((space) => [space.id, space] as const));
  const wallById = new Map(plan.walls.map((wall) => [wall.id, wall] as const));
  const openingById = new Map(plan.openings.map((opening) => [opening.id, opening] as const));
  const stairRunById = new Map(plan.stairRuns.map((run) => [run.id, run] as const));

  for (const sourceFloor of profile.floors) {
    const floor = floorById.get(sourceFloor.entity.id);
    if (
      floor === undefined ||
      floor.level !== sourceFloor.directive.level ||
      !numberEqual(
        floor.finishedFloorElevation,
        profile.building.origin.y + floor.level * profile.building.floorToFloorHeight,
      ) ||
      !numberEqual(floor.clearHeight, sourceFloor.directive.clearHeight)
    ) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          '/floors',
          'Plan floor identity, level, elevation, or clear height differs from its source directive.',
          sourceFloor.entity.id,
        ),
      );
    }
  }
  if (plan.floors.length !== profile.floors.length) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.plan_invalid',
        '/floors',
        'Plan floor count differs from the source program.',
      ),
    );
  }

  for (const floor of plan.floors) {
    const spaces = plan.spaces.filter((space) => space.floorId === floor.id);
    const walls = plan.walls.filter((wall) => wall.floorId === floor.id);
    const openings = plan.openings.filter((opening) => opening.floorId === floor.id);
    const runs = plan.stairRuns.filter(
      (run) => run.fromFloorId === floor.id || run.toFloorId === floor.id,
    );
    if (
      !sameIds(
        floor.spaceIds,
        spaces.map((space) => space.id),
      ) ||
      !sameIds(
        floor.wallIds,
        walls.map((wall) => wall.id),
      ) ||
      !sameIds(
        floor.openingIds,
        openings.map((opening) => opening.id),
      ) ||
      !sameIds(
        floor.stairRunIds,
        runs.map((run) => run.id),
      )
    ) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          '/floors',
          'Floor-owned ID lists must exactly match their resolved plan objects.',
          floor.id,
        ),
      );
    }
  }

  const sourceRooms = profile.floors.flatMap((floor) => floor.rooms);
  const plannedRooms = plan.spaces.filter(
    (space): space is ArchitectureRoomSpace => space.type === 'room',
  );
  for (const sourceRoom of sourceRooms) {
    const matches = plannedRooms.filter((room) => room.id === sourceRoom.entity.id);
    if (matches.length !== 1) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          '/spaces',
          'Every source room must resolve to exactly one plan room.',
          sourceRoom.entity.id,
        ),
      );
      continue;
    }
    const room = matches[0]!;
    const corridorDoor = openingById.get(room.corridorDoorOpeningId);
    const corridor = plan.spaces.find(
      (space) => space.floorId === room.floorId && space.type === 'corridor',
    );
    if (
      corridorDoor?.type !== 'door' ||
      corridor === undefined ||
      !sameIds([corridorDoor.fromNodeId, corridorDoor.toNodeId], [room.id, corridor.id])
    ) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.opening_infeasible',
          '/spaces',
          'Every room corridorDoorOpeningId must resolve to its explicit corridor door.',
          room.id,
        ),
      );
    }
    if (
      room.exteriorWallIds.length === 0 ||
      room.exteriorWallIds.some((id) => {
        const wall = wallById.get(id);
        return (
          wall?.exterior !== true ||
          (wall.firstSpaceId !== room.id && wall.secondSpaceId !== room.id)
        );
      })
    ) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          '/spaces',
          'Room exteriorWallIds must resolve to adjacent exterior logical walls.',
          room.id,
        ),
      );
    }
    const windowCount = plan.openings.filter(
      (opening) => opening.type === 'window' && opening.sourceId === room.id,
    ).length;
    if (windowCount < sourceRoom.directive.windows.minimum) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.opening_infeasible',
          '/openings',
          'Room minimum window count is not satisfied.',
          room.id,
        ),
      );
    }
  }
  if (plannedRooms.length !== sourceRooms.length) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.plan_invalid',
        '/spaces',
        'Plan contains a missing or extra room placement.',
      ),
    );
  }

  for (const floor of plan.floors) {
    const clearSpaces = plan.spaces.filter((space) => space.floorId === floor.id);
    for (let left = 0; left < clearSpaces.length; left += 1) {
      for (let right = left + 1; right < clearSpaces.length; right += 1) {
        if (rectanglesOverlap(clearSpaces[left]!.rectangle, clearSpaces[right]!.rectangle)) {
          diagnostics.push(
            architectureDiagnostic(
              'architecture.plan_invalid',
              '/spaces',
              'Clear-space rectangles on one floor must not overlap.',
              clearSpaces[left]!.id,
            ),
          );
        }
      }
    }
  }

  const wallKeys = new Set<string>();
  const collinear = new Map<string, ArchitectureWall[]>();
  for (const wall of plan.walls) {
    if (!floorById.has(wall.floorId)) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          '/walls',
          'Wall floor does not resolve.',
          wall.id,
        ),
      );
    }
    const key = `${wall.floorId}|${wall.axis}|${String(wall.constant)}|${String(wall.start)}|${String(wall.end)}`;
    if (wallKeys.has(key)) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          '/walls',
          'Duplicate logical wall geometry.',
          wall.id,
        ),
      );
    }
    wallKeys.add(key);
    const lineKey = `${wall.floorId}|${wall.axis}|${String(wall.constant)}`;
    const entries = collinear.get(lineKey) ?? [];
    entries.push(wall);
    collinear.set(lineKey, entries);
    if (
      (wall.firstSpaceId !== undefined && !spaceById.has(wall.firstSpaceId)) ||
      (wall.secondSpaceId !== undefined && !spaceById.has(wall.secondSpaceId))
    ) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          '/walls',
          'Wall adjacent-space metadata does not resolve.',
          wall.id,
        ),
      );
    }
    const wallOpenings = plan.openings.filter((opening) => opening.wallId === wall.id);
    if (
      !sameIds(
        wall.openingIds,
        wallOpenings.map((opening) => opening.id),
      ) ||
      !validateOpeningIntervals(wall, wallOpenings)
    ) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.opening_infeasible',
          '/walls',
          'Wall opening IDs, bounds, or overlap are invalid.',
          wall.id,
        ),
      );
    }
  }
  for (const walls of collinear.values()) {
    walls.sort((left, right) => left.start - right.start || compareCodePoints(left.id, right.id));
    for (let index = 1; index < walls.length; index += 1) {
      if (walls[index]!.start < walls[index - 1]!.end) {
        diagnostics.push(
          architectureDiagnostic(
            'architecture.plan_invalid',
            '/walls',
            'Collinear logical walls must not overlap.',
            walls[index]!.id,
          ),
        );
      }
    }
  }

  for (const opening of plan.openings) {
    const wall = wallById.get(opening.wallId);
    if (wall === undefined || wall.floorId !== opening.floorId) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          '/openings',
          'Opening wall and floor references must resolve.',
          opening.id,
        ),
      );
      continue;
    }
    const wallLength = wall.end - wall.start;
    if (
      opening.offset < plan.building.openingEndClearance ||
      opening.offset + opening.width > wallLength - plan.building.openingEndClearance
    ) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.opening_infeasible',
          '/openings',
          'Opening does not preserve the configured end clearance.',
          opening.id,
        ),
      );
    }
    if (opening.type === 'window' && wall.exterior !== true) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.opening_infeasible',
          '/openings',
          'Windows are allowed only on exterior logical walls.',
          opening.id,
        ),
      );
    }
  }

  for (const run of plan.stairRuns) {
    const from = floorById.get(run.fromFloorId);
    const to = floorById.get(run.toFloorId);
    if (
      profile.stair === undefined ||
      from === undefined ||
      to === undefined ||
      to.level !== from.level + 1 ||
      from.stairCore === undefined ||
      to.stairCore === undefined ||
      stringifyCanonicalJson(from.stairCore) !== stringifyCanonicalJson(to.stairCore) ||
      stringifyCanonicalJson(run.core) !== stringifyCanonicalJson(from.stairCore) ||
      run.stepCount !==
        Math.ceil(
          (to.finishedFloorElevation - from.finishedFloorElevation) /
            profile.stair.directive.maximumRiserHeight,
        ) ||
      run.riserHeight > profile.stair.directive.maximumRiserHeight ||
      run.treadDepth < profile.stair.directive.minimumTreadDepth
    ) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.stair_infeasible',
          '/stairRuns',
          'Stair run floors, aligned core, riser, or tread data is invalid.',
          run.id,
        ),
      );
    }
  }
  if (plan.stairRuns.length !== Math.max(0, plan.floors.length - 1)) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.stair_infeasible',
        '/stairRuns',
        'There must be exactly one stair run per adjacent floor pair.',
      ),
    );
  }
  for (const edge of plan.circulationEdges) {
    if (
      edge.sourceType === 'opening'
        ? !openingById.has(edge.sourceId)
        : !stairRunById.has(edge.sourceId)
    ) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          '/circulationEdges',
          'Circulation edge source does not resolve.',
          edge.id,
        ),
      );
    }
  }
}

function validateAdjacencyWalls(
  profile: Readonly<ArchitectureSourceProfile>,
  plan: Readonly<ArchitecturePlan>,
  diagnostics: ArchitectureDiagnostic[],
): void {
  const canonicalDoorRelationshipByPair = new Map<string, string>();
  for (const adjacency of [...profile.adjacencies]
    .filter((value) => value.directive.connection === 'door')
    .sort((left, right) => compareCodePoints(left.relationship.id, right.relationship.id))) {
    const pair = [adjacency.relationship.sourceId, adjacency.relationship.targetId]
      .sort(compareCodePoints)
      .join('|');
    if (!canonicalDoorRelationshipByPair.has(pair)) {
      canonicalDoorRelationshipByPair.set(pair, adjacency.relationship.id);
    }
  }

  for (const adjacency of profile.adjacencies) {
    const pair = [adjacency.relationship.sourceId, adjacency.relationship.targetId]
      .sort(compareCodePoints)
      .join('|');
    const sharesDivider = plan.walls.some(
      (wall) =>
        wall.kind === 'divider' &&
        sameIds(
          [wall.firstSpaceId ?? '', wall.secondSpaceId ?? ''],
          [adjacency.relationship.sourceId, adjacency.relationship.targetId],
        ),
    );
    if (
      adjacency.directive.requirement === 'required' &&
      adjacency.directive.connection === 'door' &&
      !sharesDivider
    ) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.required_adjacency_unsatisfied',
          '/walls',
          'Required door adjacency lacks a shared divider wall.',
          adjacency.relationship.id,
        ),
      );
    }
    if (adjacency.directive.requirement === 'avoid' && sharesDivider) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.avoidance_violated',
          '/walls',
          'Avoided room pair shares a divider wall.',
          adjacency.relationship.id,
        ),
      );
    }
    if (
      sharesDivider &&
      adjacency.directive.connection === 'door' &&
      canonicalDoorRelationshipByPair.get(pair) === adjacency.relationship.id
    ) {
      const directDoor = plan.openings.some(
        (opening) =>
          opening.type === 'door' &&
          opening.sourceId === adjacency.relationship.id &&
          sameIds(
            [opening.fromNodeId, opening.toNodeId],
            [adjacency.relationship.sourceId, adjacency.relationship.targetId],
          ),
      );
      if (!directDoor) {
        diagnostics.push(
          architectureDiagnostic(
            'architecture.opening_infeasible',
            '/openings',
            'Satisfied direct-door pair lacks its canonical explicit opening.',
            adjacency.relationship.id,
          ),
        );
      }
    }
  }
}

function reachableFrom(startNodeId: string, plan: Readonly<ArchitecturePlan>): ReadonlySet<string> {
  const adjacency = new Map<string, Set<string>>();
  const add = (from: string, to: string): void => {
    const neighbors = adjacency.get(from);
    if (neighbors === undefined) adjacency.set(from, new Set([to]));
    else neighbors.add(to);
  };
  for (const edge of plan.circulationEdges) {
    add(edge.fromNodeId, edge.toNodeId);
    add(edge.toNodeId, edge.fromNodeId);
  }

  const reached = new Set<string>([startNodeId]);
  const queue = [startNodeId];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    for (const neighbor of [...(adjacency.get(current) ?? [])].sort(compareCodePoints)) {
      if (reached.has(neighbor)) continue;
      reached.add(neighbor);
      queue.push(neighbor);
    }
  }
  return reached;
}

function validateSupportedReachability(
  profile: Readonly<ArchitectureSourceProfile>,
  plan: Readonly<ArchitecturePlan>,
  diagnostics: ArchitectureDiagnostic[],
): void {
  for (const constraint of profile.supportedConstraints) {
    const failedPairs: string[] = [];
    const targets = [...constraint.targetIds].sort(compareCodePoints);
    for (const subjectId of [...constraint.subjectIds].sort(compareCodePoints)) {
      const reached = reachableFrom(subjectId, plan);
      for (const targetId of targets) {
        if (!reached.has(targetId)) failedPairs.push(`${subjectId} -> ${targetId}`);
      }
    }
    if (failedPairs.length === 0) continue;
    const constraintIndex = profile.source.constraints.findIndex(
      (candidate) => candidate.id === constraint.id,
    );
    diagnostics.push(
      architectureDiagnostic(
        'architecture.circulation_unreachable',
        `/constraints/${String(constraintIndex)}`,
        `Reachability constraint has disconnected room pairs: ${failedPairs.join(', ')}.`,
        constraint.id,
        constraint.severity,
      ),
    );
  }
}

function validateMetrics(
  profile: Readonly<ArchitectureSourceProfile>,
  plan: Readonly<ArchitecturePlan>,
  layout: Readonly<SolvedLayout>,
  allRoomsReachable: boolean,
  diagnostics: ArchitectureDiagnostic[],
): void {
  const rooms = plan.spaces.filter(
    (space): space is ArchitectureRoomSpace => space.type === 'room',
  );
  const adjacency = evaluateSolvedLayout(profile, layout).adjacency;
  const grossOuterArea = rectangleArea(plan.building.outerFootprint) * plan.floors.length;
  const clearRoomArea = rooms.reduce((total, room) => total + room.clearArea, 0);
  const corridorArea = plan.spaces
    .filter((space) => space.type === 'corridor')
    .reduce((total, corridor) => total + rectangleArea(corridor.rectangle), 0);
  const stairArea = plan.spaces
    .filter((space) => space.type === 'stair_hall')
    .reduce((total, stairHall) => total + rectangleArea(stairHall.rectangle), 0);
  const expected = {
    floorCount: plan.floors.length,
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
    doorCount: plan.openings.filter((opening) => opening.type === 'door').length,
    windowCount: plan.openings.filter((opening) => opening.type === 'window').length,
    stairRunCount: plan.stairRuns.length,
    allRoomsReachable,
  };
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    const actual = plan.metrics[key];
    const wanted = expected[key];
    if (
      typeof actual !== typeof wanted ||
      (typeof actual === 'number' && typeof wanted === 'number'
        ? !numberEqual(actual, wanted)
        : actual !== wanted)
    ) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          `/metrics/${key}`,
          'Architecture Plan metric does not match deterministic re-evaluation.',
        ),
      );
    }
  }
}

/** Independently re-evaluates source identity, geometry, openings, stairs, graph, metrics, and score. */
export function evaluateArchitecturePlan(
  sourceInput: unknown,
  architecturePlanInput: unknown,
): ArchitecturePlanEvaluationResult {
  const profileResult = extractArchitectureSourceProfile(sourceInput);
  if (!profileResult.valid) return profileResult;
  const planResult = validateArchitecturePlan(architecturePlanInput);
  if (!planResult.valid) return planResult;
  const profile = profileResult.value;
  const plan = planResult.value;
  const diagnostics: ArchitectureDiagnostic[] = [...profileResult.diagnostics];

  if (plan.source.worldSpecHash !== hashSourceWorldSpec(profile.source)) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.plan_stale',
        '/source/worldSpecHash',
        'Architecture Plan source hash does not match this canonical source WorldSpec.',
        plan.source.buildingEntityId,
      ),
    );
  }
  if (
    plan.source.projectId !== profile.source.project.id ||
    plan.source.buildingEntityId !== profile.buildingEntity.id ||
    plan.source.worldSpecSchemaVersion !== profile.source.schemaVersion
  ) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.plan_stale',
        '/source',
        'Architecture Plan source identity does not match this WorldSpec.',
        plan.source.buildingEntityId,
      ),
    );
  }
  if (
    stringifyCanonicalJson(plan.building) !==
      stringifyCanonicalJson(expectedBuilding(profile, plan.building.corridorAxis)) ||
    (profile.building.corridorAxis !== 'auto' &&
      plan.building.corridorAxis !== profile.building.corridorAxis)
  ) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.plan_invalid',
        '/building',
        'Normalized plan building values differ from the source building directive.',
        profile.buildingEntity.id,
      ),
    );
  }

  const deterministic = reconstructExpectedPlan(profile, diagnostics);
  if (deterministic !== undefined) {
    validateDeterministicReconstruction(plan, deterministic.plan, diagnostics);
  }

  const layout = reconstructSolvedLayout(plan, diagnostics);
  const layoutEvaluation = evaluateSolvedLayout(profile, layout);
  diagnostics.push(...layoutEvaluation.diagnostics);
  validatePlanReferences(profile, plan, diagnostics);
  validateAdjacencyWalls(profile, plan, diagnostics);

  const entranceRoom = plan.spaces.find(
    (space): space is ArchitectureRoomSpace => space.type === 'room' && space.isEntrance,
  );
  const exteriorDoor =
    entranceRoom === undefined
      ? undefined
      : plan.openings.find((opening) => {
          const wall = plan.walls.find((candidate) => candidate.id === opening.wallId);
          return (
            opening.type === 'door' &&
            opening.sourceId === entranceRoom.id &&
            wall?.exterior === true &&
            (opening.fromNodeId === entranceRoom.id || opening.toNodeId === entranceRoom.id)
          );
        });
  const exteriorNodeId =
    exteriorDoor === undefined || entranceRoom === undefined
      ? undefined
      : exteriorDoor.fromNodeId === entranceRoom.id
        ? exteriorDoor.toNodeId
        : exteriorDoor.fromNodeId;
  if (exteriorNodeId === undefined) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.circulation_unreachable',
        '/openings',
        'Entrance room requires one explicit exterior entrance door.',
        entranceRoom?.id,
      ),
    );
  }
  const circulation =
    exteriorNodeId === undefined
      ? {
          allRoomsReachable: false,
          allRequiredNodesReachable: false,
          reachableNodeIds: [],
          unreachableNodeIds: plan.spaces.map((space) => space.id),
        }
      : evaluateCirculation(exteriorNodeId, plan.spaces, plan.circulationEdges);
  if (!circulation.allRoomsReachable || !circulation.allRequiredNodesReachable) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.circulation_unreachable',
        '/circulationEdges',
        `Plan circulation graph has unreachable nodes: ${circulation.unreachableNodeIds.join(', ')}.`,
      ),
    );
  }
  validateSupportedReachability(profile, plan, diagnostics);
  validateMetrics(
    profile,
    plan,
    deterministic?.layout ?? layout,
    circulation.allRoomsReachable,
    diagnostics,
  );

  const sorted = sortAndDeduplicateDiagnostics(diagnostics);
  return hasArchitectureErrors(sorted)
    ? { valid: false, diagnostics: sorted }
    : { valid: true, value: plan, diagnostics: sorted };
}
