import { describe, expect, it, vi } from 'vitest';

import { allocateExactRoomLengths } from '../src/allocation.js';
import {
  ARCHITECTURE_GENERATED_ID_PREFIX,
  ARCHITECTURE_IDENTIFIER_MAX_LENGTH,
  ARCHITECTURE_IDENTIFIER_PATTERN,
  createGeneratedId,
  isReservedArchitectureId,
} from '../src/generated-id.js';
import {
  ARCHITECTURE_MAX_SAFE_INTEGER,
  checkedGridAdd,
  checkedGridMultiply,
  checkedGridSubtract,
  gridCellsToStuds,
  isGridAligned,
  studsToGridCells,
} from '../src/grid.js';
import type { ArchitectureGridError } from '../src/grid.js';

describe('integer grid primitives', () => {
  it('round-trips aligned positive and negative safe-integer measurements', () => {
    expect(studsToGridCells(24, 2)).toBe(12);
    expect(studsToGridCells(-24, 2)).toBe(-12);
    expect(gridCellsToStuds(-12, 2)).toBe(-24);
    expect(Object.is(studsToGridCells(-0, 1), -0)).toBe(false);
    expect(isGridAligned(24, 2)).toBe(true);
    expect(isGridAligned(23, 2)).toBe(false);
  });

  it('reports misalignment and unsafe arithmetic with stable error codes', () => {
    expect(() => studsToGridCells(3, 2)).toThrowError(
      expect.objectContaining<Partial<ArchitectureGridError>>({
        code: 'architecture.grid_misaligned',
      }),
    );
    for (const operation of [
      (): number => gridCellsToStuds(ARCHITECTURE_MAX_SAFE_INTEGER, 2),
      (): number => checkedGridAdd(ARCHITECTURE_MAX_SAFE_INTEGER, 1),
      (): number => checkedGridMultiply(ARCHITECTURE_MAX_SAFE_INTEGER, 2),
    ]) {
      expect(operation).toThrowError(
        expect.objectContaining<Partial<ArchitectureGridError>>({
          code: 'architecture.arithmetic_overflow',
        }),
      );
    }
    expect(checkedGridSubtract(12, 5)).toBe(7);
  });
});

describe('bounded room-length allocation', () => {
  const limits = [
    { roomId: 'room-a', minimumCells: 2, preferredCells: 4, maximumCells: 5 },
    { roomId: 'room-b', minimumCells: 2, preferredCells: 3, maximumCells: 6 },
  ] as const;

  it('fills capacity exactly through minimum, preferred, then maximum lengths', () => {
    expect(allocateExactRoomLengths(limits, 8)).toEqual({
      feasible: true,
      lengths: [
        { roomId: 'room-a', lengthCells: 4 },
        { roomId: 'room-b', lengthCells: 4 },
      ],
    });
  });

  it('is independent of caller array order and does not mutate limits', () => {
    const reversed = [...limits].reverse();
    const before = structuredClone(reversed);
    expect(allocateExactRoomLengths(reversed, 8)).toEqual(allocateExactRoomLengths(limits, 8));
    expect(reversed).toEqual(before);
  });

  it.each([
    [3, 'minimum_exceeds_capacity'],
    [12, 'maximum_below_capacity'],
    [-1, 'invalid_capacity'],
    [4_097, 'invalid_capacity'],
  ])('fails capacity %i with %s', (capacity, reason) => {
    expect(allocateExactRoomLengths(limits, capacity)).toEqual({ feasible: false, reason });
  });

  it('rejects duplicate IDs and invalid limit ordering', () => {
    expect(
      allocateExactRoomLengths([limits[0], { ...limits[1], roomId: limits[0].roomId }], 8),
    ).toEqual({ feasible: false, reason: 'invalid_limits' });
    expect(
      allocateExactRoomLengths(
        [{ roomId: 'room-a', minimumCells: 3, preferredCells: 2, maximumCells: 4 }],
        3,
      ),
    ).toEqual({ feasible: false, reason: 'invalid_limits' });
  });
});

describe('generated architecture IDs', () => {
  it('creates readable WorldSpec-safe deterministic IDs', () => {
    const first = createGeneratedId(['wall', 'floor-ground', 'corridor']);
    const second = createGeneratedId(['wall', 'floor-ground', 'corridor']);
    expect(first).toBe('archgen-wall-floor-ground-corridor');
    expect(second).toBe(first);
    expect(first).toMatch(ARCHITECTURE_IDENTIFIER_PATTERN);
    expect(isReservedArchitectureId(first)).toBe(true);
    expect(first.startsWith(ARCHITECTURE_GENERATED_ID_PREFIX)).toBe(true);
  });

  it('stays stable when unrelated IDs are reordered', () => {
    const usedA = new Set(['room-z', 'room-a']);
    const usedB = new Set(['room-a', 'room-z']);
    expect(createGeneratedId(['corridor', 'floor-ground'], usedA)).toBe(
      createGeneratedId(['corridor', 'floor-ground'], usedB),
    );
  });

  it('bounds long IDs and resolves a readable candidate collision with SHA-256', () => {
    const long = createGeneratedId(['wall', 'a'.repeat(128), 'b'.repeat(128)]);
    expect(long.length).toBeLessThanOrEqual(ARCHITECTURE_IDENTIFIER_MAX_LENGTH);
    expect(long).toMatch(ARCHITECTURE_IDENTIFIER_PATTERN);
    expect(long).toMatch(/[0-9a-f]{16}$/u);

    const readable = createGeneratedId(['wall', 'floor-ground']);
    const collided = createGeneratedId(['wall', 'floor-ground'], new Set([readable]));
    expect(collided).not.toBe(readable);
    expect(collided).toMatch(/^archgen-wall-floor-ground-[0-9a-f]{16}$/u);
  });

  it('does not consult random or system time', () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must not be used.');
    });
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now must not be used.');
    });
    try {
      expect(createGeneratedId(['opening', 'room-a'])).toBe('archgen-opening-room-a');
    } finally {
      random.mockRestore();
      now.mockRestore();
    }
  });
});
