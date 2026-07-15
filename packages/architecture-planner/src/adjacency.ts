import {
  architectureDiagnostic,
  sortArchitectureDiagnostics,
  type ArchitectureDiagnostic,
} from './diagnostics.js';
import type { SolvedFloorLayout, SolvedLayout, SolvedRoomPlacement } from './candidate.js';
import type { ArchitectureSourceAdjacency, ArchitectureSourceProfile } from './source-profile.js';

export interface ResolvedArchitectureAdjacency {
  readonly relationshipId: string;
  readonly sourceRoomId: string;
  readonly targetRoomId: string;
  readonly directlyAdjacent: boolean;
  /** Manhattan centroid distance in doubled grid-cell units, avoiding fractional centers. */
  readonly centroidDistanceTwiceCells: number;
  readonly satisfied: boolean;
}

export interface ArchitectureAdjacencyEvaluation {
  readonly valid: boolean;
  readonly diagnostics: readonly ArchitectureDiagnostic[];
  readonly resolved: readonly ResolvedArchitectureAdjacency[];
  readonly requiredTotal: number;
  readonly requiredSatisfied: number;
  readonly preferredTotal: number;
  readonly preferredSatisfied: number;
  readonly avoidedTotal: number;
  readonly avoidedSatisfied: number;
  readonly preferredAdjacencyPenalty: number;
  readonly nearDistancePenalty: number;
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function placementByRoomId(layout: SolvedLayout): ReadonlyMap<string, SolvedRoomPlacement> {
  return new Map(
    layout.floors.flatMap((floor) => floor.rooms.map((room) => [room.roomId, room] as const)),
  );
}

function floorByRoomId(layout: SolvedLayout): ReadonlyMap<string, SolvedFloorLayout> {
  const result = new Map<string, SolvedFloorLayout>();
  for (const floor of layout.floors) {
    for (const room of floor.rooms) result.set(room.roomId, floor);
  }
  return result;
}

function consecutive(sequence: readonly string[], leftId: string, rightId: string): boolean {
  const leftIndex = sequence.indexOf(leftId);
  const rightIndex = sequence.indexOf(rightId);
  return leftIndex >= 0 && rightIndex >= 0 && Math.abs(leftIndex - rightIndex) === 1;
}

/** Opposite rooms across the corridor are intentionally not directly adjacent. */
export function roomsShareDivider(
  floor: SolvedFloorLayout,
  leftId: string,
  rightId: string,
): boolean {
  return (
    consecutive(floor.negativeSequence, leftId, rightId) ||
    consecutive(floor.positiveSequence, leftId, rightId)
  );
}

function centroidDistanceTwiceCells(
  left: SolvedRoomPlacement,
  right: SolvedRoomPlacement,
  leftLevel: number,
  rightLevel: number,
  verticalLevelWeightCells: number,
): number {
  const leftXTwice = 2 * left.rectangleCells.x + left.rectangleCells.width;
  const leftZTwice = 2 * left.rectangleCells.z + left.rectangleCells.depth;
  const rightXTwice = 2 * right.rectangleCells.x + right.rectangleCells.width;
  const rightZTwice = 2 * right.rectangleCells.z + right.rectangleCells.depth;
  return (
    Math.abs(leftXTwice - rightXTwice) +
    Math.abs(leftZTwice - rightZTwice) +
    2 * Math.abs(leftLevel - rightLevel) * verticalLevelWeightCells
  );
}

export function requiredAdjacencyDegreeByRoomId(
  profile: ArchitectureSourceProfile,
): ReadonlyMap<string, number> {
  const degree = new Map<string, number>();
  for (const adjacency of profile.adjacencies) {
    if (adjacency.directive.requirement !== 'required') continue;
    degree.set(
      adjacency.relationship.sourceId,
      (degree.get(adjacency.relationship.sourceId) ?? 0) + 1,
    );
    degree.set(
      adjacency.relationship.targetId,
      (degree.get(adjacency.relationship.targetId) ?? 0) + 1,
    );
  }
  return degree;
}

function relationshipSatisfied(
  adjacency: ArchitectureSourceAdjacency,
  directlyAdjacent: boolean,
  distanceTwiceCells: number,
  nearThresholdTwiceCells: number,
): boolean {
  if (adjacency.directive.requirement === 'avoid') return !directlyAdjacent;
  if (adjacency.directive.connection === 'door') return directlyAdjacent;
  return distanceTwiceCells <= nearThresholdTwiceCells;
}

/** Evaluates hard divider rules and all adjacency score components on a complete layout. */
export function evaluateLayoutAdjacencies(
  profile: ArchitectureSourceProfile,
  layout: SolvedLayout,
): ArchitectureAdjacencyEvaluation {
  const diagnostics: ArchitectureDiagnostic[] = [];
  const placements = placementByRoomId(layout);
  const floors = floorByRoomId(layout);
  const corridorLengthCells =
    layout.corridorAxis === 'x'
      ? (layout.floors[0]?.corridorCells.width ?? 0)
      : (layout.floors[0]?.corridorCells.depth ?? 0);
  const nearThresholdTwiceCells = 2 * Math.max(1, Math.floor(corridorLengthCells / 2));
  const verticalLevelWeightCells = corridorLengthCells;

  let requiredTotal = 0;
  let requiredSatisfied = 0;
  let preferredTotal = 0;
  let preferredSatisfied = 0;
  let avoidedTotal = 0;
  let avoidedSatisfied = 0;
  let preferredAdjacencyPenalty = 0;
  let nearDistancePenalty = 0;
  const resolved: ResolvedArchitectureAdjacency[] = [];

  for (const adjacency of profile.adjacencies) {
    const left = placements.get(adjacency.relationship.sourceId);
    const right = placements.get(adjacency.relationship.targetId);
    const leftFloor = floors.get(adjacency.relationship.sourceId);
    const rightFloor = floors.get(adjacency.relationship.targetId);
    if (
      left === undefined ||
      right === undefined ||
      leftFloor === undefined ||
      rightFloor === undefined
    ) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          '/spaces',
          'An adjacency endpoint does not resolve to exactly one solved room placement.',
          adjacency.relationship.id,
        ),
      );
      continue;
    }
    const directlyAdjacent =
      leftFloor.floorId === rightFloor.floorId &&
      roomsShareDivider(leftFloor, left.roomId, right.roomId);
    const distance = centroidDistanceTwiceCells(
      left,
      right,
      leftFloor.level,
      rightFloor.level,
      verticalLevelWeightCells,
    );
    const satisfied = relationshipSatisfied(
      adjacency,
      directlyAdjacent,
      distance,
      nearThresholdTwiceCells,
    );

    switch (adjacency.directive.requirement) {
      case 'required':
        requiredTotal += 1;
        if (satisfied) requiredSatisfied += 1;
        if (!satisfied) {
          diagnostics.push(
            architectureDiagnostic(
              'architecture.required_adjacency_unsatisfied',
              '/floors',
              adjacency.directive.connection === 'door'
                ? 'Required door adjacency rooms do not share a divider wall.'
                : `Required near rooms exceed the deterministic threshold of ${String(nearThresholdTwiceCells)} doubled grid cells.`,
              adjacency.relationship.id,
            ),
          );
        }
        break;
      case 'preferred':
        preferredTotal += 1;
        if (satisfied) preferredSatisfied += 1;
        if (adjacency.directive.connection === 'door' && !directlyAdjacent) {
          preferredAdjacencyPenalty += adjacency.directive.weight;
        }
        break;
      case 'avoid':
        avoidedTotal += 1;
        if (satisfied) avoidedSatisfied += 1;
        if (directlyAdjacent) {
          diagnostics.push(
            architectureDiagnostic(
              'architecture.avoidance_violated',
              '/floors',
              'An avoided room pair shares a direct divider wall.',
              adjacency.relationship.id,
            ),
          );
        }
        break;
    }
    if (adjacency.directive.connection === 'near') {
      nearDistancePenalty += distance * adjacency.directive.weight;
    }
    resolved.push({
      relationshipId: adjacency.relationship.id,
      sourceRoomId: adjacency.relationship.sourceId,
      targetRoomId: adjacency.relationship.targetId,
      directlyAdjacent,
      centroidDistanceTwiceCells: distance,
      satisfied,
    });
  }

  const sortedDiagnostics = sortArchitectureDiagnostics(diagnostics);
  return {
    valid: sortedDiagnostics.every((entry) => entry.severity !== 'error'),
    diagnostics: sortedDiagnostics,
    resolved: resolved.sort((left, right) =>
      compareCodePoints(left.relationshipId, right.relationshipId),
    ),
    requiredTotal,
    requiredSatisfied,
    preferredTotal,
    preferredSatisfied,
    avoidedTotal,
    avoidedSatisfied,
    preferredAdjacencyPenalty,
    nearDistancePenalty,
  };
}
