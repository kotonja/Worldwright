import { requiredAdjacencyDegreeByRoomId } from './adjacency.js';
import {
  ARCHITECTURE_MAX_BAND_LENGTH_CELLS,
  allocateExactRoomLengths,
  type RoomLengthLimits,
} from './allocation.js';
import {
  candidateSeedTieBreak,
  canonicalSolvedLayoutSignature,
  createGlobalCandidates,
  type ArchitectureGlobalCandidate,
  type ArchitectureGridRectangle,
  type SolvedFloorLayout,
  type SolvedLayout,
  type SolvedRoomPlacement,
} from './candidate.js';
import {
  architectureDiagnostic,
  sortArchitectureDiagnostics,
  type ArchitectureDiagnostic,
} from './diagnostics.js';
import { calculateSolvedLayoutScore, evaluateSolvedLayout } from './evaluation.js';
import { addArchitectureScoreComponent } from './score-arithmetic.js';
import type {
  ArchitectureSourceFloor,
  ArchitectureSourceProfile,
  ArchitectureSourceRoom,
} from './source-profile.js';

export const ARCHITECTURE_SOLVER_BEAM_WIDTH = 256;
export const ARCHITECTURE_FLOOR_CANDIDATE_LIMIT = 64;
export const ARCHITECTURE_GLOBAL_COMBINATION_LIMIT = 512;

export type SolveArchitectureLayoutResult =
  | {
      readonly success: true;
      readonly layout: SolvedLayout;
      readonly diagnostics: readonly ArchitectureDiagnostic[];
    }
  | {
      readonly success: false;
      readonly diagnostics: readonly ArchitectureDiagnostic[];
    };

interface PartialFloorState {
  readonly negative: readonly string[];
  readonly positive: readonly string[];
  readonly signature: string;
}

interface CompletedFloorCandidate {
  readonly floor: SolvedFloorLayout;
  readonly heuristicPenalty: number;
}

interface IndexedRoomPair {
  readonly relationshipId: string;
  readonly leftRoomId: string;
  readonly rightRoomId: string;
  readonly weight: number;
}

interface FloorRelationshipPairIndexes {
  readonly requiredDoorPartnersByRoomId: ReadonlyMap<string, readonly IndexedRoomPair[]>;
  readonly avoidedPartnersByRoomId: ReadonlyMap<string, readonly IndexedRoomPair[]>;
  readonly preferredDoorPairs: readonly IndexedRoomPair[];
}

interface MutableFloorRelationshipPairIndexes {
  readonly requiredDoorPartnersByRoomId: Map<string, IndexedRoomPair[]>;
  readonly avoidedPartnersByRoomId: Map<string, IndexedRoomPair[]>;
  readonly preferredDoorPairs: IndexedRoomPair[];
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function stateSignature(negative: readonly string[], positive: readonly string[]): string {
  return `negative=${negative.join(',')}|positive=${positive.join(',')}`;
}

function sourceRoomById(
  floor: ArchitectureSourceFloor,
): ReadonlyMap<string, ArchitectureSourceRoom> {
  return new Map(floor.rooms.map((room) => [room.entity.id, room] as const));
}

function indexFloorRelationshipPairs(
  profile: ArchitectureSourceProfile,
): ReadonlyMap<string, FloorRelationshipPairIndexes> {
  const addPartnerPair = (index: Map<string, IndexedRoomPair[]>, pair: IndexedRoomPair): void => {
    for (const roomId of [pair.leftRoomId, pair.rightRoomId]) {
      const pairs = index.get(roomId);
      if (pairs === undefined) index.set(roomId, [pair]);
      else pairs.push(pair);
    }
  };
  const floorIdByRoomId = new Map<string, string>();
  const mutableByFloorId = new Map<string, MutableFloorRelationshipPairIndexes>();
  for (const floor of profile.floors) {
    mutableByFloorId.set(floor.entity.id, {
      requiredDoorPartnersByRoomId: new Map(),
      avoidedPartnersByRoomId: new Map(),
      preferredDoorPairs: [],
    });
    for (const room of floor.rooms) floorIdByRoomId.set(room.entity.id, floor.entity.id);
  }

  for (const adjacency of profile.adjacencies) {
    const leftRoomId = adjacency.relationship.sourceId;
    const rightRoomId = adjacency.relationship.targetId;
    const floorId = floorIdByRoomId.get(leftRoomId);
    if (floorId === undefined || floorIdByRoomId.get(rightRoomId) !== floorId) continue;
    const indexes = mutableByFloorId.get(floorId);
    if (indexes === undefined) continue;
    const pair: IndexedRoomPair = {
      relationshipId: adjacency.relationship.id,
      leftRoomId,
      rightRoomId,
      weight: adjacency.directive.weight,
    };
    if (
      adjacency.directive.requirement === 'required' &&
      adjacency.directive.connection === 'door'
    ) {
      addPartnerPair(indexes.requiredDoorPartnersByRoomId, pair);
    } else if (adjacency.directive.requirement === 'avoid') {
      addPartnerPair(indexes.avoidedPartnersByRoomId, pair);
    } else if (
      adjacency.directive.requirement === 'preferred' &&
      adjacency.directive.connection === 'door'
    ) {
      indexes.preferredDoorPairs.push(pair);
    }
  }

  for (const indexes of mutableByFloorId.values()) {
    const byRelationshipId = (left: IndexedRoomPair, right: IndexedRoomPair): number =>
      compareCodePoints(left.relationshipId, right.relationshipId);
    for (const pairs of indexes.requiredDoorPartnersByRoomId.values()) {
      pairs.sort(byRelationshipId);
    }
    for (const pairs of indexes.avoidedPartnersByRoomId.values()) {
      pairs.sort(byRelationshipId);
    }
    indexes.preferredDoorPairs.sort(byRelationshipId);
  }
  return mutableByFloorId;
}

function roomLimitsForBand(
  profile: ArchitectureSourceProfile,
  room: ArchitectureSourceRoom,
  bandDepthCells: number,
): RoomLengthLimits | undefined {
  const gridSize = profile.building.gridSize;
  const bandDepthStuds = bandDepthCells * gridSize;
  if (bandDepthStuds < room.directive.minimumSpan) return undefined;
  const areaPerLengthCell = bandDepthStuds * gridSize;
  if (!Number.isSafeInteger(areaPerLengthCell) || areaPerLengthCell <= 0) return undefined;

  const minimumSpanCells = Math.ceil(room.directive.minimumSpan / gridSize);
  const minimumAreaCells = Math.ceil(room.directive.minimumArea / areaPerLengthCell);
  const minimumAspectCells = Math.ceil(bandDepthCells / room.directive.maximumAspectRatio);
  const corridorDoorCells = Math.ceil(
    ((room.directive.doorWidth ?? profile.building.defaultDoorWidth) +
      2 * profile.building.openingEndClearance) /
      gridSize,
  );
  const minimumWindowCells =
    room.directive.windows.minimum === 0
      ? 0
      : Math.ceil(
          (room.directive.windows.minimum * profile.building.defaultWindowWidth +
            2 * profile.building.openingEndClearance) /
            gridSize,
        );
  const minimumCells = Math.max(
    1,
    minimumSpanCells,
    minimumAreaCells,
    minimumAspectCells,
    corridorDoorCells,
    minimumWindowCells,
  );

  const maximumAreaCells = Math.min(
    ARCHITECTURE_MAX_BAND_LENGTH_CELLS,
    Math.floor(room.directive.maximumArea / areaPerLengthCell),
  );
  const unboundedMaximumAspectCells = bandDepthCells * room.directive.maximumAspectRatio;
  const maximumAspectCells = Number.isFinite(unboundedMaximumAspectCells)
    ? Math.min(ARCHITECTURE_MAX_BAND_LENGTH_CELLS, Math.floor(unboundedMaximumAspectCells))
    : ARCHITECTURE_MAX_BAND_LENGTH_CELLS;
  const maximumCells = Math.min(maximumAreaCells, maximumAspectCells);
  if (!Number.isSafeInteger(minimumCells) || !Number.isSafeInteger(maximumCells)) {
    return undefined;
  }
  if (minimumCells > maximumCells) return undefined;
  const idealCells = Math.round(room.directive.preferredArea / areaPerLengthCell);
  const preferredCells = Math.max(minimumCells, Math.min(maximumCells, idealCells));
  return { roomId: room.entity.id, minimumCells, preferredCells, maximumCells };
}

function sequenceConsumedMinimum(
  sequence: readonly string[],
  limits: ReadonlyMap<string, RoomLengthLimits>,
  dividerCells: number,
  stairLengthCells: number,
  hasStair: boolean,
): number {
  let total = sequence.reduce(
    (sum, id) => sum + (limits.get(id)?.minimumCells ?? Number.MAX_SAFE_INTEGER),
    0,
  );
  if (sequence.length > 1) total += dividerCells * (sequence.length - 1);
  if (hasStair) {
    total += stairLengthCells;
    if (sequence.length > 0) total += dividerCells;
  }
  return total;
}

function directRuleViolated(
  indexes: FloorRelationshipPairIndexes,
  insertedRoomId: string,
  negative: readonly string[],
  positive: readonly string[],
): boolean {
  const assigned = new Set([...negative, ...positive]);
  const endNeighbor = (sequence: readonly string[]): string | undefined => {
    if (sequence[0] === insertedRoomId) return sequence[1];
    if (sequence.at(-1) === insertedRoomId) return sequence.at(-2);
    return undefined;
  };
  const adjacentNeighborId = endNeighbor(negative) ?? endNeighbor(positive);
  const partnerRoomId = (pair: IndexedRoomPair): string =>
    pair.leftRoomId === insertedRoomId ? pair.rightRoomId : pair.leftRoomId;
  for (const pair of indexes.requiredDoorPartnersByRoomId.get(insertedRoomId) ?? []) {
    const partner = partnerRoomId(pair);
    if (assigned.has(partner) && adjacentNeighborId !== partner) {
      return true;
    }
  }
  for (const pair of indexes.avoidedPartnersByRoomId.get(insertedRoomId) ?? []) {
    if (adjacentNeighborId === partnerRoomId(pair)) {
      return true;
    }
  }
  return false;
}

function partialCapacityBalanceHeuristic(
  negative: readonly string[],
  positive: readonly string[],
  negativeLimits: ReadonlyMap<string, RoomLengthLimits>,
  positiveLimits: ReadonlyMap<string, RoomLengthLimits>,
): number {
  const deviation = (
    ids: readonly string[],
    limits: ReadonlyMap<string, RoomLengthLimits>,
  ): number =>
    ids.reduce((sum, id) => {
      const limit = limits.get(id);
      return sum + (limit === undefined ? 1_000_000 : limit.preferredCells - limit.minimumCells);
    }, 0);
  return Math.abs(deviation(negative, negativeLimits) - deviation(positive, positiveLimits));
}

function remainingMinimumCanFit(
  remainingRooms: readonly ArchitectureSourceRoom[],
  negative: readonly string[],
  positive: readonly string[],
  negativeLimits: ReadonlyMap<string, RoomLengthLimits>,
  positiveLimits: ReadonlyMap<string, RoomLengthLimits>,
  dividerCells: number,
  stairLengthCells: number,
  stairSide: ArchitectureGlobalCandidate['stairSide'],
  interiorLength: number,
): boolean {
  const negativeFree =
    interiorLength -
    sequenceConsumedMinimum(
      negative,
      negativeLimits,
      dividerCells,
      stairLengthCells,
      stairSide === 'negative',
    );
  const positiveFree =
    interiorLength -
    sequenceConsumedMinimum(
      positive,
      positiveLimits,
      dividerCells,
      stairLengthCells,
      stairSide === 'positive',
    );
  let combinedMinimum = 0;
  let forcedNegative = 0;
  let forcedPositive = 0;
  for (const room of remainingRooms) {
    const negativeLimit = negativeLimits.get(room.entity.id);
    const positiveLimit = positiveLimits.get(room.entity.id);
    const negativeIncrement =
      negativeLimit === undefined
        ? Number.POSITIVE_INFINITY
        : negativeLimit.minimumCells +
          (negative.length > 0 || stairSide === 'negative' ? dividerCells : 0);
    const positiveIncrement =
      positiveLimit === undefined
        ? Number.POSITIVE_INFINITY
        : positiveLimit.minimumCells +
          (positive.length > 0 || stairSide === 'positive' ? dividerCells : 0);
    if (negativeIncrement > negativeFree && positiveIncrement > positiveFree) return false;
    combinedMinimum += Math.min(negativeIncrement, positiveIncrement);
    if (!Number.isFinite(negativeIncrement)) forcedPositive += positiveIncrement;
    if (!Number.isFinite(positiveIncrement)) forcedNegative += negativeIncrement;
  }
  if (combinedMinimum > negativeFree + positiveFree) return false;
  if (forcedNegative > negativeFree || forcedPositive > positiveFree) return false;
  if (negative.length === 0 && !remainingRooms.some((room) => negativeLimits.has(room.entity.id))) {
    return false;
  }
  if (positive.length === 0 && !remainingRooms.some((room) => positiveLimits.has(room.entity.id))) {
    return false;
  }
  return true;
}

function insertRoom(
  sequence: readonly string[],
  roomId: string,
  end: 'front' | 'rear',
): readonly string[] {
  return end === 'front' ? [roomId, ...sequence] : [...sequence, roomId];
}

function candidateCorridorRectangle(
  profile: ArchitectureSourceProfile,
  candidate: ArchitectureGlobalCandidate,
): ArchitectureGridRectangle {
  const building = profile.building;
  const gridSize = building.gridSize;
  const outerWidthCells = building.footprint.width / gridSize;
  const outerDepthCells = building.footprint.depth / gridSize;
  const exteriorCells = building.exteriorWallThickness / gridSize;
  const interiorWallCells = building.interiorWallThickness / gridSize;
  const corridorWidthCells = building.corridorWidth / gridSize;
  if (candidate.corridorAxis === 'x') {
    return {
      x: exteriorCells,
      z: exteriorCells + candidate.negativeBandDepthCells + interiorWallCells,
      width: outerWidthCells - 2 * exteriorCells,
      depth: corridorWidthCells,
    };
  }
  return {
    x: exteriorCells + candidate.negativeBandDepthCells + interiorWallCells,
    z: exteriorCells,
    width: corridorWidthCells,
    depth: outerDepthCells - 2 * exteriorCells,
  };
}

function candidateStairCoreRectangle(
  profile: ArchitectureSourceProfile,
  candidate: ArchitectureGlobalCandidate,
  corridor: ArchitectureGridRectangle,
): ArchitectureGridRectangle | undefined {
  if (profile.stair === undefined || candidate.stairSide === undefined) return undefined;
  const gridSize = profile.building.gridSize;
  const coreWidthCells = profile.stair.directive.coreWidth / gridSize;
  const coreLengthCells = profile.stair.directive.coreLength / gridSize;
  const interiorWallCells = profile.building.interiorWallThickness / gridSize;
  // A straight run occupies the full stair-core width. Retain one door-width
  // floor-level lane between the corridor and core so the explicit centered
  // stair-hall opening can reach the first and final tread from the side.
  const accessLaneCells = profile.building.defaultDoorWidth / gridSize;
  const atNegativeEnd = profile.building.entranceEnd === 'positive';
  if (candidate.corridorAxis === 'x') {
    const x = atNegativeEnd ? corridor.x : corridor.x + corridor.width - coreLengthCells;
    const z =
      candidate.stairSide === 'negative'
        ? corridor.z - interiorWallCells - accessLaneCells - coreWidthCells
        : corridor.z + corridor.depth + interiorWallCells + accessLaneCells;
    return { x, z, width: coreLengthCells, depth: coreWidthCells };
  }
  const z = atNegativeEnd ? corridor.z : corridor.z + corridor.depth - coreLengthCells;
  const x =
    candidate.stairSide === 'negative'
      ? corridor.x - interiorWallCells - accessLaneCells - coreWidthCells
      : corridor.x + corridor.width + interiorWallCells + accessLaneCells;
  return { x, z, width: coreWidthCells, depth: coreLengthCells };
}

function createRoomPlacements(
  profile: ArchitectureSourceProfile,
  floor: ArchitectureSourceFloor,
  candidate: ArchitectureGlobalCandidate,
  corridor: ArchitectureGridRectangle,
  negativeSequence: readonly string[],
  positiveSequence: readonly string[],
  lengthByRoomId: ReadonlyMap<string, number>,
): readonly SolvedRoomPlacement[] {
  const gridSize = profile.building.gridSize;
  const exteriorCells = profile.building.exteriorWallThickness / gridSize;
  const dividerCells = profile.building.interiorWallThickness / gridSize;
  const outerLength =
    candidate.corridorAxis === 'x'
      ? profile.building.footprint.width / gridSize
      : profile.building.footprint.depth / gridSize;
  const innerEnd = outerLength - exteriorCells;
  const roomById = sourceRoomById(floor);
  const placements: SolvedRoomPlacement[] = [];

  for (const [side, sequence, bandDepthCells] of [
    ['negative', negativeSequence, candidate.negativeBandDepthCells],
    ['positive', positiveSequence, candidate.positiveBandDepthCells],
  ] as const) {
    let cursor = profile.building.entranceEnd === 'negative' ? exteriorCells : innerEnd;
    for (let sequenceIndex = 0; sequenceIndex < sequence.length; sequenceIndex += 1) {
      const roomId = sequence[sequenceIndex]!;
      const lengthCells = lengthByRoomId.get(roomId);
      const sourceRoom = roomById.get(roomId);
      if (lengthCells === undefined || sourceRoom === undefined) continue;
      const axisStart = profile.building.entranceEnd === 'negative' ? cursor : cursor - lengthCells;
      const bandStart =
        candidate.corridorAxis === 'x'
          ? side === 'negative'
            ? corridor.z - dividerCells - bandDepthCells
            : corridor.z + corridor.depth + dividerCells
          : side === 'negative'
            ? corridor.x - dividerCells - bandDepthCells
            : corridor.x + corridor.width + dividerCells;
      const rectangleCells: ArchitectureGridRectangle =
        candidate.corridorAxis === 'x'
          ? { x: axisStart, z: bandStart, width: lengthCells, depth: bandDepthCells }
          : { x: bandStart, z: axisStart, width: bandDepthCells, depth: lengthCells };
      const clearArea = lengthCells * bandDepthCells * gridSize * gridSize;
      const aspectRatio =
        Math.max(lengthCells, bandDepthCells) / Math.min(lengthCells, bandDepthCells);
      placements.push({
        roomId,
        floorId: floor.entity.id,
        side,
        sequenceIndex,
        rectangleCells,
        clearArea,
        aspectRatio,
      });
      cursor =
        profile.building.entranceEnd === 'negative'
          ? axisStart + lengthCells + dividerCells
          : axisStart - dividerCells;
    }
  }
  return placements.sort((left, right) => compareCodePoints(left.roomId, right.roomId));
}

function floorHeuristicPenalty(
  floor: SolvedFloorLayout,
  sourceFloor: ArchitectureSourceFloor,
  relationshipIndexes: FloorRelationshipPairIndexes,
): number {
  const sourceRooms = sourceRoomById(sourceFloor);
  let penalty = 0;
  for (const room of floor.rooms) {
    const source = sourceRooms.get(room.roomId);
    if (source === undefined) continue;
    penalty = addArchitectureScoreComponent(
      penalty,
      Math.abs(room.clearArea - source.directive.preferredArea),
    );
    penalty = addArchitectureScoreComponent(penalty, Math.round((room.aspectRatio - 1) * 1_000));
  }
  const sameSequence = (left: string, right: string): boolean => {
    for (const sequence of [floor.negativeSequence, floor.positiveSequence]) {
      const a = sequence.indexOf(left);
      const b = sequence.indexOf(right);
      if (a >= 0 && b >= 0 && Math.abs(a - b) === 1) return true;
    }
    return false;
  };
  for (const pair of relationshipIndexes.preferredDoorPairs) {
    if (!sameSequence(pair.leftRoomId, pair.rightRoomId)) {
      penalty = addArchitectureScoreComponent(penalty, pair.weight);
    }
  }
  return penalty;
}

function solveFloorCandidates(
  profile: ArchitectureSourceProfile,
  sourceFloor: ArchitectureSourceFloor,
  candidate: ArchitectureGlobalCandidate,
  relationshipIndexes: FloorRelationshipPairIndexes,
  requiredDegree: ReadonlyMap<string, number>,
): readonly CompletedFloorCandidate[] {
  const gridSize = profile.building.gridSize;
  const exteriorCells = profile.building.exteriorWallThickness / gridSize;
  const dividerCells = profile.building.interiorWallThickness / gridSize;
  const outerLength =
    candidate.corridorAxis === 'x'
      ? profile.building.footprint.width / gridSize
      : profile.building.footprint.depth / gridSize;
  const interiorLength = outerLength - 2 * exteriorCells;
  const stairLengthCells =
    profile.stair?.directive.coreLength === undefined
      ? 0
      : profile.stair.directive.coreLength / gridSize;
  const stairWidthCells =
    profile.stair?.directive.coreWidth === undefined
      ? 0
      : profile.stair.directive.coreWidth / gridSize;
  const stairAccessLaneCells =
    profile.stair === undefined ? 0 : profile.building.defaultDoorWidth / gridSize;
  if (
    candidate.stairSide !== undefined &&
    stairWidthCells + stairAccessLaneCells >
      (candidate.stairSide === 'negative'
        ? candidate.negativeBandDepthCells
        : candidate.positiveBandDepthCells)
  ) {
    return [];
  }
  if (stairLengthCells >= interiorLength) return [];

  const negativeLimits = new Map<string, RoomLengthLimits>();
  const positiveLimits = new Map<string, RoomLengthLimits>();
  for (const room of sourceFloor.rooms) {
    const negativeLimit = roomLimitsForBand(profile, room, candidate.negativeBandDepthCells);
    const positiveLimit = roomLimitsForBand(profile, room, candidate.positiveBandDepthCells);
    if (negativeLimit !== undefined) negativeLimits.set(room.entity.id, negativeLimit);
    if (positiveLimit !== undefined) positiveLimits.set(room.entity.id, positiveLimit);
    if (negativeLimit === undefined && positiveLimit === undefined) return [];
  }

  const roomProfilesById = sourceRoomById(sourceFloor);
  const orderedRooms = [...sourceFloor.rooms].sort(
    (left, right) =>
      (requiredDegree.get(right.entity.id) ?? 0) - (requiredDegree.get(left.entity.id) ?? 0) ||
      right.directive.minimumArea - left.directive.minimumArea ||
      compareCodePoints(left.entity.id, right.entity.id),
  );
  let beam: PartialFloorState[] = [
    { negative: [], positive: [], signature: stateSignature([], []) },
  ];

  for (let roomIndex = 0; roomIndex < orderedRooms.length; roomIndex += 1) {
    const room = orderedRooms[roomIndex]!;
    const remainingRooms = orderedRooms.slice(roomIndex + 1);
    const nextBySignature = new Map<string, PartialFloorState>();
    for (const state of beam) {
      for (const side of ['negative', 'positive'] as const) {
        const limits = side === 'negative' ? negativeLimits : positiveLimits;
        if (!limits.has(room.entity.id)) continue;
        const sequence = side === 'negative' ? state.negative : state.positive;
        const ends: readonly ('front' | 'rear')[] =
          room.directive.isEntrance || sequence.length === 0
            ? ['front']
            : sequence[0] !== undefined &&
                roomProfilesById.get(sequence[0])?.directive.isEntrance === true
              ? ['rear']
              : ['front', 'rear'];
        for (const end of ends) {
          const nextSequence = insertRoom(sequence, room.entity.id, end);
          const negative = side === 'negative' ? nextSequence : state.negative;
          const positive = side === 'positive' ? nextSequence : state.positive;
          const negativeConsumed = sequenceConsumedMinimum(
            negative,
            negativeLimits,
            dividerCells,
            stairLengthCells,
            candidate.stairSide === 'negative',
          );
          const positiveConsumed = sequenceConsumedMinimum(
            positive,
            positiveLimits,
            dividerCells,
            stairLengthCells,
            candidate.stairSide === 'positive',
          );
          if (
            negativeConsumed > interiorLength ||
            positiveConsumed > interiorLength ||
            directRuleViolated(relationshipIndexes, room.entity.id, negative, positive) ||
            !remainingMinimumCanFit(
              remainingRooms,
              negative,
              positive,
              negativeLimits,
              positiveLimits,
              dividerCells,
              stairLengthCells,
              candidate.stairSide,
              interiorLength,
            )
          ) {
            continue;
          }
          const signature = stateSignature(negative, positive);
          nextBySignature.set(signature, { negative, positive, signature });
        }
      }
    }
    beam = [...nextBySignature.values()]
      .sort((left, right) => {
        const byPenalty =
          partialCapacityBalanceHeuristic(
            left.negative,
            left.positive,
            negativeLimits,
            positiveLimits,
          ) -
          partialCapacityBalanceHeuristic(
            right.negative,
            right.positive,
            negativeLimits,
            positiveLimits,
          );
        return byPenalty || compareCodePoints(left.signature, right.signature);
      })
      .slice(0, ARCHITECTURE_SOLVER_BEAM_WIDTH);
    if (beam.length === 0) return [];
  }

  const corridor = candidateCorridorRectangle(profile, candidate);
  const stairCore = candidateStairCoreRectangle(profile, candidate, corridor);
  const completed: CompletedFloorCandidate[] = [];
  for (const state of beam) {
    if (state.negative.length === 0 || state.positive.length === 0) continue;
    const allocatedById = new Map<string, number>();
    let allocationFailed = false;
    for (const [side, sequence, limits] of [
      ['negative', state.negative, negativeLimits],
      ['positive', state.positive, positiveLimits],
    ] as const) {
      const dividerTotal = dividerCells * (sequence.length - 1);
      const stairTotal = candidate.stairSide === side ? stairLengthCells + dividerCells : 0;
      const clearCapacity = interiorLength - dividerTotal - stairTotal;
      const allocation = allocateExactRoomLengths(
        sequence.map((id) => limits.get(id)!).filter((value) => value !== undefined),
        clearCapacity,
      );
      if (!allocation.feasible) {
        allocationFailed = true;
        break;
      }
      for (const value of allocation.lengths) {
        allocatedById.set(value.roomId, value.lengthCells);
      }
    }
    if (allocationFailed || allocatedById.size !== sourceFloor.rooms.length) continue;
    const rooms = createRoomPlacements(
      profile,
      sourceFloor,
      candidate,
      corridor,
      state.negative,
      state.positive,
      allocatedById,
    );
    const signature = `${sourceFloor.entity.id}|${state.signature}|lengths=${[...allocatedById]
      .sort((left, right) => compareCodePoints(left[0], right[0]))
      .map(([id, length]) => `${id}:${String(length)}`)
      .join(',')}`;
    const floor: SolvedFloorLayout = {
      floorId: sourceFloor.entity.id,
      level: sourceFloor.directive.level,
      corridorCells: corridor,
      ...(stairCore === undefined ? {} : { stairCoreCells: stairCore }),
      negativeSequence: state.negative,
      positiveSequence: state.positive,
      rooms,
      signature,
    };
    completed.push({
      floor,
      heuristicPenalty: floorHeuristicPenalty(floor, sourceFloor, relationshipIndexes),
    });
  }
  return completed
    .sort(
      (left, right) =>
        left.heuristicPenalty - right.heuristicPenalty ||
        compareCodePoints(left.floor.signature, right.floor.signature),
    )
    .slice(0, ARCHITECTURE_FLOOR_CANDIDATE_LIMIT);
}

function comparePrimaryScore(left: SolvedLayout, right: SolvedLayout): number {
  for (const key of [
    'total',
    'areaDeviation',
    'aspectRatio',
    'preferredAdjacency',
    'preferredWindows',
    'nearDistance',
    'zoneOrdering',
  ] as const) {
    const difference = left.score[key] - right.score[key];
    if (difference !== 0) return difference;
  }
  const seedDifference = left.score.seedTieBreak - right.score.seedTieBreak;
  return seedDifference || compareCodePoints(left.signature, right.signature);
}

/** Performs a bounded, deterministic integer-grid search over every documented global choice. */
export function solveArchitectureLayout(
  profile: ArchitectureSourceProfile,
): SolveArchitectureLayoutResult {
  const diagnostics: ArchitectureDiagnostic[] = [];
  const successfulLayouts: SolvedLayout[] = [];
  const floorRelationshipIndexes = indexFloorRelationshipPairs(profile);
  const requiredDegree = requiredAdjacencyDegreeByRoomId(profile);
  const gridSize = profile.building.gridSize;
  const outerWidthCells = profile.building.footprint.width / gridSize;
  const outerDepthCells = profile.building.footprint.depth / gridSize;

  for (const globalCandidate of createGlobalCandidates(profile)) {
    const perFloor = profile.floors.map((floor) => {
      const relationshipIndexes = floorRelationshipIndexes.get(floor.entity.id);
      if (relationshipIndexes === undefined) return [];
      return solveFloorCandidates(
        profile,
        floor,
        globalCandidate,
        relationshipIndexes,
        requiredDegree,
      );
    });
    if (perFloor.some((values) => values.length === 0)) continue;
    let combinations: readonly {
      readonly floors: readonly SolvedFloorLayout[];
      readonly heuristicPenalty: number;
      readonly signature: string;
    }[] = [{ floors: [], heuristicPenalty: 0, signature: '' }];
    for (const floorCandidates of perFloor) {
      combinations = combinations
        .flatMap((combination) =>
          floorCandidates.map((floorCandidate) => ({
            floors: [...combination.floors, floorCandidate.floor],
            heuristicPenalty: addArchitectureScoreComponent(
              combination.heuristicPenalty,
              floorCandidate.heuristicPenalty,
            ),
            signature: `${combination.signature}||${floorCandidate.floor.signature}`,
          })),
        )
        .sort(
          (left, right) =>
            left.heuristicPenalty - right.heuristicPenalty ||
            compareCodePoints(left.signature, right.signature),
        )
        .slice(0, ARCHITECTURE_GLOBAL_COMBINATION_LIMIT);
    }

    for (const combination of combinations) {
      const signature = canonicalSolvedLayoutSignature(globalCandidate, combination.floors);
      const seedTieBreak = candidateSeedTieBreak(profile.source.project.seed, signature);
      const zeroScore = {
        total: 0,
        areaDeviation: 0,
        aspectRatio: 0,
        preferredAdjacency: 0,
        preferredWindows: 0,
        nearDistance: 0,
        zoneOrdering: 0,
        seedTieBreak,
      } as const;
      const provisional: SolvedLayout = {
        corridorAxis: globalCandidate.corridorAxis,
        ...(globalCandidate.stairSide === undefined
          ? {}
          : { stairSide: globalCandidate.stairSide }),
        negativeBandDepthCells: globalCandidate.negativeBandDepthCells,
        positiveBandDepthCells: globalCandidate.positiveBandDepthCells,
        outerWidthCells,
        outerDepthCells,
        floors: combination.floors,
        score: zeroScore,
        signature,
      };
      const layout: SolvedLayout = {
        ...provisional,
        score: calculateSolvedLayoutScore(profile, provisional, seedTieBreak),
      };
      const evaluation = evaluateSolvedLayout(profile, layout);
      if (evaluation.valid) successfulLayouts.push(layout);
    }
  }

  successfulLayouts.sort(comparePrimaryScore);
  const selected = successfulLayouts[0];
  if (selected === undefined) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.infeasible',
        '/entities',
        'No bounded double-loaded-spine candidate satisfies the complete source program.',
        profile.buildingEntity.id,
      ),
    );
    return { success: false, diagnostics: sortArchitectureDiagnostics(diagnostics) };
  }
  const evaluation = evaluateSolvedLayout(profile, selected);
  return {
    success: true,
    layout: selected,
    diagnostics: evaluation.diagnostics,
  };
}
