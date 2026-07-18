import { evaluateLayoutAdjacencies, type ArchitectureAdjacencyEvaluation } from './adjacency.js';
import type {
  ArchitectureBandSide,
  ArchitectureGridRectangle,
  SolvedFloorLayout,
  SolvedLayout,
  SolvedRoomPlacement,
} from './candidate.js';
import {
  architectureDiagnostic,
  hasArchitectureErrors,
  sortArchitectureDiagnostics,
  type ArchitectureDiagnostic,
} from './diagnostics.js';
import type { ArchitecturePlanScore } from './plan-schema.js';
import {
  addArchitectureScoreComponent,
  sumArchitectureScoreComponents,
  toArchitectureScoreComponent,
} from './score-arithmetic.js';
import type { ArchitectureSourceProfile, ArchitectureSourceRoom } from './source-profile.js';

export interface SolvedLayoutEvaluation {
  readonly valid: boolean;
  readonly diagnostics: readonly ArchitectureDiagnostic[];
  readonly score: ArchitecturePlanScore;
  readonly adjacency: ArchitectureAdjacencyEvaluation;
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function positiveIntegerRectangle(rectangle: ArchitectureGridRectangle): boolean {
  return (
    Number.isSafeInteger(rectangle.x) &&
    Number.isSafeInteger(rectangle.z) &&
    Number.isSafeInteger(rectangle.width) &&
    Number.isSafeInteger(rectangle.depth) &&
    rectangle.width > 0 &&
    rectangle.depth > 0
  );
}

function rectanglesOverlap(
  left: ArchitectureGridRectangle,
  right: ArchitectureGridRectangle,
): boolean {
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.z < right.z + right.depth &&
    right.z < left.z + left.depth
  );
}

function sameGridRectangle(
  left: ArchitectureGridRectangle,
  right: ArchitectureGridRectangle,
): boolean {
  return (
    left.x === right.x &&
    left.z === right.z &&
    left.width === right.width &&
    left.depth === right.depth
  );
}

function roomLengthCells(room: SolvedRoomPlacement, axis: 'x' | 'z'): number {
  return axis === 'x' ? room.rectangleCells.width : room.rectangleCells.depth;
}

function roomDepthCells(room: SolvedRoomPlacement, axis: 'x' | 'z'): number {
  return axis === 'x' ? room.rectangleCells.depth : room.rectangleCells.width;
}

function roomAxisStart(room: SolvedRoomPlacement, axis: 'x' | 'z'): number {
  return axis === 'x' ? room.rectangleCells.x : room.rectangleCells.z;
}

function roomDirectiveById(
  profile: ArchitectureSourceProfile,
): ReadonlyMap<string, ArchitectureSourceRoom> {
  return new Map(
    profile.floors.flatMap((floor) => floor.rooms.map((room) => [room.entity.id, room] as const)),
  );
}

/** Computes every non-seed penalty before attaching the already bounded seed tie key. */
export function calculateSolvedLayoutScore(
  profile: ArchitectureSourceProfile,
  layout: SolvedLayout,
  seedTieBreak: number,
): ArchitecturePlanScore {
  const roomProfiles = roomDirectiveById(profile);
  const clearHeightByFloorId = new Map(
    profile.floors.map((floor) => [floor.entity.id, floor.directive.clearHeight] as const),
  );
  let areaDeviation = 0;
  let aspectRatio = 0;
  let preferredWindows = 0;
  let zoneOrdering = 0;

  for (const floor of layout.floors) {
    const corridorStart =
      layout.corridorAxis === 'x' ? floor.corridorCells.x : floor.corridorCells.z;
    const corridorLength =
      layout.corridorAxis === 'x' ? floor.corridorCells.width : floor.corridorCells.depth;
    for (const room of floor.rooms) {
      const sourceRoom = roomProfiles.get(room.roomId);
      if (sourceRoom === undefined) continue;
      areaDeviation = addArchitectureScoreComponent(
        areaDeviation,
        Math.abs(room.clearArea - sourceRoom.directive.preferredArea),
      );
      aspectRatio = addArchitectureScoreComponent(
        aspectRatio,
        Math.round((room.aspectRatio - 1) * 1_000),
      );
      const exteriorWallLength =
        roomLengthCells(room, layout.corridorAxis) * profile.building.gridSize;
      const availableWindowLength = exteriorWallLength - 2 * profile.building.openingEndClearance;
      const windowFitsVertically =
        profile.building.defaultWindowSillHeight + profile.building.defaultWindowHeight <=
        (clearHeightByFloorId.get(floor.floorId) ?? 0);
      const fittingWindowCount = windowFitsVertically
        ? Math.max(0, Math.floor(availableWindowLength / profile.building.defaultWindowWidth))
        : 0;
      preferredWindows = addArchitectureScoreComponent(
        preferredWindows,
        Math.max(0, sourceRoom.directive.windows.preferred - fittingWindowCount),
      );

      const centerTwice =
        2 * roomAxisStart(room, layout.corridorAxis) + roomLengthCells(room, layout.corridorAxis);
      const distanceFromNegativeTwice = centerTwice - 2 * corridorStart;
      const distanceFromEntranceTwice =
        profile.building.entranceEnd === 'negative'
          ? distanceFromNegativeTwice
          : 2 * corridorLength - distanceFromNegativeTwice;
      const distanceFromRearTwice = 2 * corridorLength - distanceFromEntranceTwice;
      switch (sourceRoom.directive.zone) {
        case 'public':
          zoneOrdering = addArchitectureScoreComponent(zoneOrdering, distanceFromEntranceTwice);
          break;
        case 'private':
          zoneOrdering = addArchitectureScoreComponent(zoneOrdering, distanceFromRearTwice);
          break;
        case 'service':
          zoneOrdering = addArchitectureScoreComponent(zoneOrdering, distanceFromRearTwice);
          break;
      }
    }
  }

  // For auto selection, the longer footprint dimension is the documented preferred spine axis.
  if (profile.building.corridorAxis === 'auto') {
    const preferredAxis =
      profile.building.footprint.width >= profile.building.footprint.depth ? 'x' : 'z';
    if (layout.corridorAxis !== preferredAxis) {
      zoneOrdering = addArchitectureScoreComponent(zoneOrdering, 1);
    }
  }

  const adjacency = evaluateLayoutAdjacencies(profile, layout);
  const components = {
    areaDeviation: toArchitectureScoreComponent(areaDeviation),
    aspectRatio: toArchitectureScoreComponent(aspectRatio),
    preferredAdjacency: toArchitectureScoreComponent(adjacency.preferredAdjacencyPenalty),
    preferredWindows: toArchitectureScoreComponent(preferredWindows),
    nearDistance: toArchitectureScoreComponent(adjacency.nearDistancePenalty),
    zoneOrdering: toArchitectureScoreComponent(zoneOrdering),
  };
  return {
    total: sumArchitectureScoreComponents([
      components.areaDeviation,
      components.aspectRatio,
      components.preferredAdjacency,
      components.preferredWindows,
      components.nearDistance,
      components.zoneOrdering,
    ]),
    ...components,
    // This is deliberately excluded from total: it may resolve only exact primary-score ties.
    seedTieBreak: toArchitectureScoreComponent(seedTieBreak),
  };
}

function expectedBandCoordinates(
  profile: ArchitectureSourceProfile,
  layout: SolvedLayout,
  floor: SolvedFloorLayout,
  side: ArchitectureBandSide,
): { readonly start: number; readonly depth: number } {
  const corridorWallCells = profile.building.interiorWallThickness / profile.building.gridSize;
  if (layout.corridorAxis === 'x') {
    const depth =
      side === 'negative' ? layout.negativeBandDepthCells : layout.positiveBandDepthCells;
    return {
      start:
        side === 'negative'
          ? floor.corridorCells.z - depth - corridorWallCells
          : floor.corridorCells.z + floor.corridorCells.depth + corridorWallCells,
      depth,
    };
  }
  const depth = side === 'negative' ? layout.negativeBandDepthCells : layout.positiveBandDepthCells;
  return {
    start:
      side === 'negative'
        ? floor.corridorCells.x - depth - corridorWallCells
        : floor.corridorCells.x + floor.corridorCells.width + corridorWallCells,
    depth,
  };
}

function validateExactSideTiling(
  profile: ArchitectureSourceProfile,
  layout: SolvedLayout,
  floor: SolvedFloorLayout,
  side: ArchitectureBandSide,
  diagnostics: ArchitectureDiagnostic[],
): void {
  const gridSize = profile.building.gridSize;
  const exteriorCells = profile.building.exteriorWallThickness / gridSize;
  const dividerCells = profile.building.interiorWallThickness / gridSize;
  const outerLength = layout.corridorAxis === 'x' ? layout.outerWidthCells : layout.outerDepthCells;
  const innerStart = exteriorCells;
  const innerEnd = outerLength - exteriorCells;
  const intervals = floor.rooms
    .filter((room) => room.side === side)
    .map((room) => ({
      id: room.roomId,
      start: roomAxisStart(room, layout.corridorAxis),
      end: roomAxisStart(room, layout.corridorAxis) + roomLengthCells(room, layout.corridorAxis),
    }));
  if (layout.stairSide === side && floor.stairCoreCells !== undefined) {
    intervals.push({
      id: 'stair-core',
      start: layout.corridorAxis === 'x' ? floor.stairCoreCells.x : floor.stairCoreCells.z,
      end:
        layout.corridorAxis === 'x'
          ? floor.stairCoreCells.x + floor.stairCoreCells.width
          : floor.stairCoreCells.z + floor.stairCoreCells.depth,
    });
  }
  intervals.sort((left, right) => left.start - right.start || compareCodePoints(left.id, right.id));
  if (intervals.length === 0 || intervals[0]?.start !== innerStart) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.infeasible',
        '/floors',
        'A room band contains an unexplained clear-space void at its first end.',
        floor.floorId,
      ),
    );
    return;
  }
  for (let index = 1; index < intervals.length; index += 1) {
    if (intervals[index]!.start !== intervals[index - 1]!.end + dividerCells) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.infeasible',
          '/floors',
          'Room bands must tile exactly with one interior divider wall between segments.',
          floor.floorId,
        ),
      );
      return;
    }
  }
  if (intervals.at(-1)?.end !== innerEnd) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.infeasible',
        '/floors',
        'A room band contains an unexplained clear-space void at its final end.',
        floor.floorId,
      ),
    );
  }
}

/** Re-checks a complete solved layout independently of the bounded search that produced it. */
export function evaluateSolvedLayout(
  profile: ArchitectureSourceProfile,
  layout: SolvedLayout,
): SolvedLayoutEvaluation {
  const diagnostics: ArchitectureDiagnostic[] = [];
  const sourceRooms = roomDirectiveById(profile);
  const placementCounts = new Map<string, number>();
  const gridSize = profile.building.gridSize;
  const exteriorCells = profile.building.exteriorWallThickness / gridSize;
  const innerMinimum = exteriorCells;
  const innerMaximumX = layout.outerWidthCells - exteriorCells;
  const innerMaximumZ = layout.outerDepthCells - exteriorCells;

  const expectedOuterWidth = profile.building.footprint.width / gridSize;
  const expectedOuterDepth = profile.building.footprint.depth / gridSize;
  const axisPermitted =
    profile.building.corridorAxis === 'auto' ||
    profile.building.corridorAxis === layout.corridorAxis;
  const interiorWallCells = profile.building.interiorWallThickness / gridSize;
  const corridorWidthCells = profile.building.corridorWidth / gridSize;
  const interiorPerpendicular =
    (layout.corridorAxis === 'x' ? expectedOuterDepth : expectedOuterWidth) - 2 * exteriorCells;
  if (
    layout.outerWidthCells !== expectedOuterWidth ||
    layout.outerDepthCells !== expectedOuterDepth ||
    !axisPermitted ||
    layout.negativeBandDepthCells <= 0 ||
    layout.positiveBandDepthCells <= 0 ||
    layout.negativeBandDepthCells +
      layout.positiveBandDepthCells +
      corridorWidthCells +
      2 * interiorWallCells !==
      interiorPerpendicular
  ) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.plan_invalid',
        '/building',
        'Solved layout axis, footprint cells, or room-band split does not match the source building.',
        profile.buildingEntity.id,
      ),
    );
  }

  if (
    (profile.stair === undefined &&
      (layout.stairSide !== undefined ||
        layout.floors.some((floor) => floor.stairCoreCells !== undefined))) ||
    (profile.stair !== undefined && layout.stairSide === undefined) ||
    (profile.stair?.directive.preferredSide !== undefined &&
      profile.stair.directive.preferredSide !== 'auto' &&
      layout.stairSide !== profile.stair.directive.preferredSide)
  ) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.stair_infeasible',
        '/floors',
        'Solved layout stair presence or side does not match the source stair directive.',
        profile.stair?.entity.id,
      ),
    );
  }

  if (layout.floors.length !== profile.floors.length) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.plan_invalid',
        '/floors',
        'Solved layout floor count does not match the source profile.',
      ),
    );
  }

  let firstStairSignature: string | undefined;
  for (const floor of layout.floors) {
    const sourceFloor = profile.floors.find((candidate) => candidate.entity.id === floor.floorId);
    if (sourceFloor === undefined || sourceFloor.directive.level !== floor.level) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          '/floors',
          'Solved floor ID and level must resolve to one source floor.',
          floor.floorId,
        ),
      );
    }
    if (!positiveIntegerRectangle(floor.corridorCells)) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          '/floors',
          'Corridor cell rectangle must contain positive safe-integer dimensions.',
          floor.floorId,
        ),
      );
    }
    const expectedCorridorLength =
      layout.corridorAxis === 'x'
        ? layout.outerWidthCells - 2 * exteriorCells
        : layout.outerDepthCells - 2 * exteriorCells;
    const actualCorridorLength =
      layout.corridorAxis === 'x' ? floor.corridorCells.width : floor.corridorCells.depth;
    if (actualCorridorLength !== expectedCorridorLength) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.infeasible',
          '/floors',
          'The corridor must remain continuous across the full interior-envelope length.',
          floor.floorId,
        ),
      );
    }
    const expectedCorridor: ArchitectureGridRectangle =
      layout.corridorAxis === 'x'
        ? {
            x: exteriorCells,
            z: exteriorCells + layout.negativeBandDepthCells + interiorWallCells,
            width: expectedOuterWidth - 2 * exteriorCells,
            depth: corridorWidthCells,
          }
        : {
            x: exteriorCells + layout.negativeBandDepthCells + interiorWallCells,
            z: exteriorCells,
            width: corridorWidthCells,
            depth: expectedOuterDepth - 2 * exteriorCells,
          };
    if (!sameGridRectangle(floor.corridorCells, expectedCorridor)) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.infeasible',
          '/floors',
          'The corridor must be centered between the exact selected room bands.',
          floor.floorId,
        ),
      );
    }

    if (floor.stairCoreCells !== undefined) {
      const stairSignature = JSON.stringify(floor.stairCoreCells);
      firstStairSignature ??= stairSignature;
      if (stairSignature !== firstStairSignature) {
        diagnostics.push(
          architectureDiagnostic(
            'architecture.stair_infeasible',
            '/floors',
            'The stair core must use the same aligned rectangle on every floor.',
            floor.floorId,
          ),
        );
      }
      if (profile.stair !== undefined && layout.stairSide !== undefined) {
        const coreLengthCells = profile.stair.directive.coreLength / gridSize;
        const coreWidthCells = profile.stair.directive.coreWidth / gridSize;
        const accessLaneCells = profile.building.defaultDoorWidth / gridSize;
        const rearAtNegative = profile.building.entranceEnd === 'positive';
        const expectedCore: ArchitectureGridRectangle =
          layout.corridorAxis === 'x'
            ? {
                x: rearAtNegative
                  ? expectedCorridor.x
                  : expectedCorridor.x + expectedCorridor.width - coreLengthCells,
                z:
                  layout.stairSide === 'negative'
                    ? expectedCorridor.z - interiorWallCells - accessLaneCells - coreWidthCells
                    : expectedCorridor.z +
                      expectedCorridor.depth +
                      interiorWallCells +
                      accessLaneCells,
                width: coreLengthCells,
                depth: coreWidthCells,
              }
            : {
                x:
                  layout.stairSide === 'negative'
                    ? expectedCorridor.x - interiorWallCells - accessLaneCells - coreWidthCells
                    : expectedCorridor.x +
                      expectedCorridor.width +
                      interiorWallCells +
                      accessLaneCells,
                z: rearAtNegative
                  ? expectedCorridor.z
                  : expectedCorridor.z + expectedCorridor.depth - coreLengthCells,
                width: coreWidthCells,
                depth: coreLengthCells,
              };
        if (!sameGridRectangle(floor.stairCoreCells, expectedCore)) {
          diagnostics.push(
            architectureDiagnostic(
              'architecture.stair_infeasible',
              '/floors',
              'The stair core must occupy the configured aligned rear rectangle behind its corridor access lane.',
              floor.floorId,
            ),
          );
        }
      }
    }

    const sequenceIds = [...floor.negativeSequence, ...floor.positiveSequence];
    if (
      sequenceIds.length !== floor.rooms.length ||
      new Set(sequenceIds).size !== sequenceIds.length ||
      floor.rooms.some(
        (room) =>
          !sequenceIds.includes(room.roomId) ||
          room.floorId !== floor.floorId ||
          (room.side === 'negative'
            ? floor.negativeSequence[room.sequenceIndex] !== room.roomId
            : floor.positiveSequence[room.sequenceIndex] !== room.roomId),
      )
    ) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          '/floors',
          'Room side sequences must match every placement ID, side, floor, and sequence index exactly.',
          floor.floorId,
        ),
      );
    }

    for (let leftIndex = 0; leftIndex < floor.rooms.length; leftIndex += 1) {
      const room = floor.rooms[leftIndex]!;
      placementCounts.set(room.roomId, (placementCounts.get(room.roomId) ?? 0) + 1);
      const sourceRoom = sourceRooms.get(room.roomId);
      if (sourceRoom === undefined) {
        diagnostics.push(
          architectureDiagnostic(
            'architecture.plan_invalid',
            '/floors',
            'Solved room placement does not resolve to a source room.',
            room.roomId,
          ),
        );
        continue;
      }
      const rectangle = room.rectangleCells;
      if (
        !positiveIntegerRectangle(rectangle) ||
        rectangle.x < innerMinimum ||
        rectangle.z < innerMinimum ||
        rectangle.x + rectangle.width > innerMaximumX ||
        rectangle.z + rectangle.depth > innerMaximumZ
      ) {
        diagnostics.push(
          architectureDiagnostic(
            'architecture.plan_invalid',
            '/floors',
            'Room clear rectangle must be positive, grid-cell aligned, and inside the interior envelope.',
            room.roomId,
          ),
        );
      }
      for (let rightIndex = leftIndex + 1; rightIndex < floor.rooms.length; rightIndex += 1) {
        if (rectanglesOverlap(rectangle, floor.rooms[rightIndex]!.rectangleCells)) {
          diagnostics.push(
            architectureDiagnostic(
              'architecture.infeasible',
              '/floors',
              'Solved room clear rectangles must not overlap.',
              room.roomId,
            ),
          );
        }
      }

      const lengthCells = roomLengthCells(room, layout.corridorAxis);
      const depthCells = roomDepthCells(room, layout.corridorAxis);
      const lengthStuds = lengthCells * gridSize;
      const depthStuds = depthCells * gridSize;
      const actualArea = lengthStuds * depthStuds;
      const actualAspect = Math.max(lengthCells, depthCells) / Math.min(lengthCells, depthCells);
      if (
        actualArea < sourceRoom.directive.minimumArea ||
        actualArea > sourceRoom.directive.maximumArea ||
        Math.min(lengthStuds, depthStuds) < sourceRoom.directive.minimumSpan ||
        actualAspect > sourceRoom.directive.maximumAspectRatio + Number.EPSILON
      ) {
        diagnostics.push(
          architectureDiagnostic(
            'architecture.room_invalid',
            '/floors',
            'Solved room violates its area, minimum-span, or maximum-aspect requirement.',
            room.roomId,
          ),
        );
      }
      if (
        room.clearArea !== actualArea ||
        Math.abs(room.aspectRatio - actualAspect) > Number.EPSILON
      ) {
        diagnostics.push(
          architectureDiagnostic(
            'architecture.plan_invalid',
            '/floors',
            'Solved room derived area or aspect ratio is not exact.',
            room.roomId,
          ),
        );
      }

      const band = expectedBandCoordinates(profile, layout, floor, room.side);
      const actualBandStart = layout.corridorAxis === 'x' ? rectangle.z : rectangle.x;
      if (actualBandStart !== band.start || depthCells !== band.depth) {
        diagnostics.push(
          architectureDiagnostic(
            'architecture.infeasible',
            '/floors',
            'Every room must span exactly from its corridor wall to the exterior-side wall.',
            room.roomId,
          ),
        );
      }
      const requiredOpeningLength =
        ((sourceRoom.directive.doorWidth ?? profile.building.defaultDoorWidth) +
          2 * profile.building.openingEndClearance) /
        gridSize;
      const requiredWindowLength =
        (sourceRoom.directive.windows.minimum * profile.building.defaultWindowWidth +
          2 * profile.building.openingEndClearance) /
        gridSize;
      if (lengthCells < requiredOpeningLength || lengthCells < requiredWindowLength) {
        diagnostics.push(
          architectureDiagnostic(
            'architecture.opening_infeasible',
            '/floors',
            'Room wall length cannot fit its required corridor door or minimum windows.',
            room.roomId,
          ),
        );
      }

      if (sourceRoom.directive.isEntrance) {
        const start = roomAxisStart(room, layout.corridorAxis);
        const end = start + lengthCells;
        const expected =
          profile.building.entranceEnd === 'negative'
            ? innerMinimum
            : layout.corridorAxis === 'x'
              ? innerMaximumX
              : innerMaximumZ;
        if (
          (profile.building.entranceEnd === 'negative' && start !== expected) ||
          (profile.building.entranceEnd === 'positive' && end !== expected)
        ) {
          diagnostics.push(
            architectureDiagnostic(
              'architecture.room_invalid',
              '/floors',
              'The entrance room must touch the selected entrance-end facade.',
              room.roomId,
            ),
          );
        }
      }
    }

    validateExactSideTiling(profile, layout, floor, 'negative', diagnostics);
    validateExactSideTiling(profile, layout, floor, 'positive', diagnostics);
  }

  for (const roomId of sourceRooms.keys()) {
    if (placementCounts.get(roomId) !== 1) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          '/floors',
          'Every source room must have exactly one solved placement.',
          roomId,
        ),
      );
    }
  }

  const adjacency = evaluateLayoutAdjacencies(profile, layout);
  diagnostics.push(...adjacency.diagnostics);
  for (const resolved of adjacency.resolved) {
    const sourceAdjacency = profile.adjacencies.find(
      (entry) => entry.relationship.id === resolved.relationshipId,
    );
    if (resolved.directlyAdjacent && sourceAdjacency?.directive.connection === 'door') {
      const room = layout.floors
        .flatMap((floor) => floor.rooms)
        .find((candidate) => candidate.roomId === resolved.sourceRoomId);
      if (room !== undefined) {
        const dividerStuds = roomDepthCells(room, layout.corridorAxis) * gridSize;
        if (
          dividerStuds <
          profile.building.defaultDoorWidth + 2 * profile.building.openingEndClearance
        ) {
          diagnostics.push(
            architectureDiagnostic(
              'architecture.opening_infeasible',
              '/floors',
              'A direct-adjacency divider cannot fit its required door and end clearances.',
              resolved.relationshipId,
            ),
          );
        }
      }
    }
  }

  if (adjacency.preferredSatisfied < adjacency.preferredTotal) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.preference_unsatisfied',
        '/floors',
        'One or more preferred room adjacencies were not satisfied.',
        undefined,
        'warning',
      ),
    );
  }

  const expectedScore = calculateSolvedLayoutScore(profile, layout, layout.score.seedTieBreak);
  for (const key of [
    'total',
    'areaDeviation',
    'aspectRatio',
    'preferredAdjacency',
    'preferredWindows',
    'nearDistance',
    'zoneOrdering',
    'seedTieBreak',
  ] as const) {
    if (layout.score[key] !== expectedScore[key]) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          `/score/${key}`,
          'Solved layout score breakdown does not match deterministic re-evaluation.',
        ),
      );
    }
  }

  const sortedDiagnostics = sortArchitectureDiagnostics(diagnostics);
  return {
    valid: !hasArchitectureErrors(sortedDiagnostics),
    diagnostics: sortedDiagnostics,
    score: expectedScore,
    adjacency,
  };
}
