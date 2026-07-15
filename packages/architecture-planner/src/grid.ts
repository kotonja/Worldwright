export const ARCHITECTURE_MAX_SAFE_INTEGER = 9_007_199_254_740_991;

export class ArchitectureGridError extends RangeError {
  readonly code: 'architecture.grid_misaligned' | 'architecture.arithmetic_overflow';

  constructor(
    code: 'architecture.grid_misaligned' | 'architecture.arithmetic_overflow',
    message: string,
  ) {
    super(message);
    this.name = 'ArchitectureGridError';
    this.code = code;
  }
}

export function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function isGridAligned(value: number, gridSize: number): boolean {
  return Number.isSafeInteger(value) && isPositiveSafeInteger(gridSize) && value % gridSize === 0;
}

/** Converts an aligned stud measurement into an exact safe-integer cell count. */
export function studsToGridCells(value: number, gridSize: number): number {
  if (!isPositiveSafeInteger(gridSize)) {
    throw new ArchitectureGridError(
      'architecture.grid_misaligned',
      'Grid size must be a positive safe integer.',
    );
  }
  if (!isGridAligned(value, gridSize)) {
    throw new ArchitectureGridError(
      'architecture.grid_misaligned',
      `Stud measurement ${String(value)} is not aligned to grid size ${String(gridSize)}.`,
    );
  }
  const cells = value / gridSize;
  if (!Number.isSafeInteger(cells)) {
    throw new ArchitectureGridError(
      'architecture.arithmetic_overflow',
      'Grid-cell conversion exceeded safe-integer arithmetic.',
    );
  }
  return Object.is(cells, -0) ? 0 : cells;
}

export const toGridCells = studsToGridCells;

/** Converts a safe-integer cell count into studs with checked multiplication. */
export function gridCellsToStuds(cells: number, gridSize: number): number {
  if (!Number.isSafeInteger(cells) || !isPositiveSafeInteger(gridSize)) {
    throw new ArchitectureGridError(
      'architecture.arithmetic_overflow',
      'Grid conversion requires safe-integer cells and a positive safe-integer grid size.',
    );
  }
  const studs = cells * gridSize;
  if (!Number.isSafeInteger(studs)) {
    throw new ArchitectureGridError(
      'architecture.arithmetic_overflow',
      'Grid-cell conversion exceeded safe-integer arithmetic.',
    );
  }
  return Object.is(studs, -0) ? 0 : studs;
}

export const fromGridCells = gridCellsToStuds;

export function checkedGridAdd(...values: readonly number[]): number {
  let result = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) {
      throw new ArchitectureGridError(
        'architecture.arithmetic_overflow',
        'Grid addition requires safe integers.',
      );
    }
    result += value;
    if (!Number.isSafeInteger(result)) {
      throw new ArchitectureGridError(
        'architecture.arithmetic_overflow',
        'Grid addition exceeded safe-integer arithmetic.',
      );
    }
  }
  return Object.is(result, -0) ? 0 : result;
}

export function checkedGridMultiply(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    throw new ArchitectureGridError(
      'architecture.arithmetic_overflow',
      'Grid multiplication requires safe integers.',
    );
  }
  const result = left * right;
  if (!Number.isSafeInteger(result)) {
    throw new ArchitectureGridError(
      'architecture.arithmetic_overflow',
      'Grid multiplication exceeded safe-integer arithmetic.',
    );
  }
  return Object.is(result, -0) ? 0 : result;
}

export function checkedGridSubtract(left: number, right: number): number {
  return checkedGridAdd(left, -right);
}
