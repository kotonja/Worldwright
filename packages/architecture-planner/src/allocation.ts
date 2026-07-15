/** Maximum supported clear length of one room band in integer grid cells. */
export const ARCHITECTURE_MAX_BAND_LENGTH_CELLS = 4_096;

export interface RoomLengthLimits {
  readonly roomId: string;
  readonly minimumCells: number;
  readonly preferredCells: number;
  readonly maximumCells: number;
}

export interface AllocatedRoomLength {
  readonly roomId: string;
  readonly lengthCells: number;
}

export type LengthAllocationFailureReason =
  | 'invalid_capacity'
  | 'invalid_limits'
  | 'minimum_exceeds_capacity'
  | 'maximum_below_capacity';

export type LengthAllocationResult =
  | {
      readonly feasible: true;
      readonly lengths: readonly AllocatedRoomLength[];
    }
  | {
      readonly feasible: false;
      readonly reason: LengthAllocationFailureReason;
    };

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isSupportedCellCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= ARCHITECTURE_MAX_BAND_LENGTH_CELLS;
}

function safeSum(values: readonly number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

interface MutableAllocation {
  readonly roomId: string;
  readonly preferredCells: number;
  readonly maximumCells: number;
  lengthCells: number;
}

/**
 * Allocates an exact integer-cell capacity without leaving a hidden void.
 *
 * Rooms begin at their minimum. Cells are then assigned to the largest remaining preferred
 * deficit and, if capacity remains, to the largest remaining maximum deficit. Source ID is the
 * final tie-break. The supported band limit makes the loop explicitly bounded.
 */
export function allocateExactRoomLengths(
  limits: readonly RoomLengthLimits[],
  capacityCells: number,
): LengthAllocationResult {
  if (!isSupportedCellCount(capacityCells)) {
    return { feasible: false, reason: 'invalid_capacity' };
  }

  const seenIds = new Set<string>();
  for (const limit of limits) {
    if (
      limit.roomId.length === 0 ||
      seenIds.has(limit.roomId) ||
      !isSupportedCellCount(limit.minimumCells) ||
      !isSupportedCellCount(limit.preferredCells) ||
      !isSupportedCellCount(limit.maximumCells) ||
      limit.minimumCells <= 0 ||
      limit.minimumCells > limit.preferredCells ||
      limit.preferredCells > limit.maximumCells
    ) {
      return { feasible: false, reason: 'invalid_limits' };
    }
    seenIds.add(limit.roomId);
  }

  if (limits.length === 0) {
    return capacityCells === 0
      ? { feasible: true, lengths: [] }
      : { feasible: false, reason: 'maximum_below_capacity' };
  }

  const minimumTotal = safeSum(limits.map((limit) => limit.minimumCells));
  const maximumTotal = safeSum(limits.map((limit) => limit.maximumCells));
  if (minimumTotal === undefined || maximumTotal === undefined) {
    return { feasible: false, reason: 'invalid_limits' };
  }
  if (minimumTotal > capacityCells) {
    return { feasible: false, reason: 'minimum_exceeds_capacity' };
  }
  if (maximumTotal < capacityCells) {
    return { feasible: false, reason: 'maximum_below_capacity' };
  }

  const allocations: MutableAllocation[] = limits.map((limit) => ({
    roomId: limit.roomId,
    preferredCells: limit.preferredCells,
    maximumCells: limit.maximumCells,
    lengthCells: limit.minimumCells,
  }));
  let remaining = capacityCells - minimumTotal;

  const distributeToward = (target: 'preferredCells' | 'maximumCells'): void => {
    while (remaining > 0) {
      let selected: MutableAllocation | undefined;
      let selectedDeficit = 0;
      for (const allocation of allocations) {
        const deficit = allocation[target] - allocation.lengthCells;
        if (
          deficit > selectedDeficit ||
          (deficit === selectedDeficit &&
            deficit > 0 &&
            selected !== undefined &&
            compareCodePoints(allocation.roomId, selected.roomId) < 0)
        ) {
          selected = allocation;
          selectedDeficit = deficit;
        }
      }
      if (selected === undefined || selectedDeficit <= 0) return;
      selected.lengthCells += 1;
      remaining -= 1;
    }
  };

  distributeToward('preferredCells');
  distributeToward('maximumCells');

  if (remaining !== 0) {
    return { feasible: false, reason: 'maximum_below_capacity' };
  }

  return {
    feasible: true,
    lengths: allocations
      .map(({ roomId, lengthCells }) => ({ roomId, lengthCells }))
      .sort((left, right) => compareCodePoints(left.roomId, right.roomId)),
  };
}
