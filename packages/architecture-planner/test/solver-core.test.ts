import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluateLayoutAdjacencies } from '../src/adjacency.js';
import { allocateExactRoomLengths } from '../src/allocation.js';
import { extractArchitectureSourceProfile } from '../src/source-profile.js';
import { solveArchitectureLayout } from '../src/solver.js';

interface MutableFixtureEntity {
  readonly id: string;
  readonly attributes: Record<string, unknown>;
}

interface MutableFixture {
  entities: MutableFixtureEntity[];
  locks: {
    readonly id: string;
    readonly entityId: string;
    readonly fieldPaths: string[];
    readonly owner: 'user' | 'system';
    readonly reason?: string;
  }[];
}

function mansionFixture(): MutableFixture {
  return JSON.parse(
    readFileSync(resolve('fixtures/input/cliffwatch-mansion-program.worldspec.json'), 'utf8'),
  ) as MutableFixture;
}

describe('deterministic room length allocation', () => {
  it('fills the exact capacity toward preferred and then maximum lengths', () => {
    const result = allocateExactRoomLengths(
      [
        { roomId: 'room-b', minimumCells: 2, preferredCells: 4, maximumCells: 6 },
        { roomId: 'room-a', minimumCells: 2, preferredCells: 4, maximumCells: 6 },
      ],
      9,
    );

    expect(result).toEqual({
      feasible: true,
      lengths: [
        { roomId: 'room-a', lengthCells: 5 },
        { roomId: 'room-b', lengthCells: 4 },
      ],
    });
  });

  it('rejects capacity that maximum room lengths cannot tile', () => {
    expect(
      allocateExactRoomLengths(
        [{ roomId: 'room-a', minimumCells: 2, preferredCells: 3, maximumCells: 4 }],
        5,
      ),
    ).toEqual({ feasible: false, reason: 'maximum_below_capacity' });
  });
});

describe('source profile and bounded solver', () => {
  it('produces the same complete layout after unrelated entity reordering', () => {
    const original = mansionFixture();
    const reordered = mansionFixture();
    reordered.entities.reverse();
    const firstProfile = extractArchitectureSourceProfile(original);
    const secondProfile = extractArchitectureSourceProfile(reordered);
    expect(firstProfile.valid).toBe(true);
    expect(secondProfile.valid).toBe(true);
    if (!firstProfile.valid || !secondProfile.valid) return;

    const first = solveArchitectureLayout(firstProfile.value);
    const repeated = solveArchitectureLayout(firstProfile.value);
    const second = solveArchitectureLayout(secondProfile.value);
    expect(first.success).toBe(true);
    expect(repeated.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !repeated.success || !second.success) return;

    expect(JSON.stringify(first.layout)).toBe(JSON.stringify(repeated.layout));
    expect(JSON.stringify(first.layout)).toBe(JSON.stringify(second.layout));
    const adjacency = evaluateLayoutAdjacencies(firstProfile.value, first.layout);
    expect(adjacency.valid).toBe(true);
    expect(adjacency.requiredSatisfied).toBe(adjacency.requiredTotal);
    expect(adjacency.avoidedSatisfied).toBe(adjacency.avoidedTotal);
  });

  it('rejects a pre-authored Roblox directive instead of overwriting it', () => {
    const fixture = mansionFixture();
    const room = fixture.entities.find((entity) => entity.id === 'ballroom');
    expect(room).toBeDefined();
    if (room === undefined) return;
    room.attributes['worldwright.roblox'] = {
      schemaVersion: '0.1.0',
      mode: 'container',
      className: 'Folder',
    };

    const result = extractArchitectureSourceProfile(fixture);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      'architecture.roblox_directive_conflict',
    );
  });

  it('rejects a lock targeting a planned room', () => {
    const fixture = mansionFixture();
    fixture.locks.push({
      id: 'lock-ballroom',
      entityId: 'ballroom',
      fieldPaths: ['attributes'],
      owner: 'user',
      reason: 'test lock',
    });

    const result = extractArchitectureSourceProfile(fixture);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      'architecture.lock_unsupported',
    );
  });
});
