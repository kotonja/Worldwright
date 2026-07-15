import { describe, expect, it } from 'vitest';

import { architectureDiagnostic, sortArchitectureDiagnostics } from '../src/diagnostics.js';
import { validateArchitecturePlan } from '../src/directive-validation.js';
import { hashArchitecturePlan, hashSourceWorldSpec } from '../src/hashing.js';
import { normalizeArchitecturePlan, stringifyArchitecturePlan } from '../src/normalize.js';
import {
  ARCHITECTURE_MAX_PLAN_OPENINGS_PER_WALL,
  ARCHITECTURE_MAX_PLAN_SPACE_COUNT,
  ARCHITECTURE_MAX_PLAN_WALL_COUNT,
  ARCHITECTURE_MAX_PLAN_WALLS_PER_FLOOR,
} from '../src/plan-schema.js';
import { clone, loadMansionProgram, makeMinimalPlan } from './helpers.js';

describe('Architecture Plan validation and normalization', () => {
  it('accepts a strict plan and returns a deep independent value', () => {
    const input = makeMinimalPlan();
    const result = validateArchitecturePlan(input);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.value).toEqual(normalizeArchitecturePlan(input));
    expect(result.value).not.toBe(input);
    expect(result.value.building).not.toBe(input.building);
    result.value.building.worldOrigin.x = 100;
    expect(input.building.worldOrigin.x).toBe(0);
  });

  it('includes a preferred-window shortfall in the non-seed score total', () => {
    const input = makeMinimalPlan();
    input.score.preferredWindows = 3;
    input.score.total = 3;

    const result = validateArchitecturePlan(input);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.value.score).toMatchObject({ preferredWindows: 3, total: 3 });
  });

  it('rejects unknown fields and globally duplicate plan IDs', () => {
    const unknown = { ...makeMinimalPlan(), undocumented: true };
    expect(validateArchitecturePlan(unknown).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'architecture.plan_invalid', path: '/undocumented' }),
    );

    const duplicate = makeMinimalPlan();
    duplicate.walls[1]!.id = duplicate.walls[0]!.id;
    const result = validateArchitecturePlan(duplicate);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'architecture.plan_invalid',
        relatedId: duplicate.walls[0]!.id,
      }),
    );
  });

  it('rejects accessors without invoking them', () => {
    const input = makeMinimalPlan() as object;
    let invoked = false;
    Object.defineProperty(input, 'trap', {
      enumerable: true,
      get(): never {
        invoked = true;
        throw new Error('must not execute');
      },
    });
    const result = validateArchitecturePlan(input);
    expect(invoked).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'architecture.plan_invalid',
      path: '/trap',
    });
  });

  it('does not invoke accessor-backed array elements during raw plan preflight', () => {
    const input = makeMinimalPlan();
    let invoked = false;
    Object.defineProperty(input.floors, '0', {
      configurable: true,
      enumerable: true,
      get(): never {
        invoked = true;
        throw new Error('must not execute');
      },
    });

    const result = validateArchitecturePlan(input);

    expect(invoked).toBe(false);
    expect(result).toMatchObject({
      valid: false,
      diagnostics: [{ code: 'architecture.plan_invalid', path: '/floors/0' }],
    });
  });

  it('rejects oversized top-level plan collections before inspecting their elements', () => {
    const input = makeMinimalPlan();
    let invoked = false;
    const trap = {};
    Object.defineProperty(trap, 'value', {
      enumerable: true,
      get(): never {
        invoked = true;
        throw new Error('must not execute');
      },
    });
    (input as unknown as { spaces: unknown[] }).spaces = [
      trap,
      ...Array.from({ length: ARCHITECTURE_MAX_PLAN_SPACE_COUNT }, () => null),
    ];

    const result = validateArchitecturePlan(input);

    expect(invoked).toBe(false);
    expect(result).toMatchObject({
      valid: false,
      diagnostics: [{ code: 'architecture.plan_invalid', path: '/spaces' }],
    });
  });

  it('rejects oversized nested plan reference collections before semantic scans', () => {
    const input = makeMinimalPlan();
    input.walls[0]!.openingIds = Array.from(
      { length: ARCHITECTURE_MAX_PLAN_OPENINGS_PER_WALL + 1 },
      (_value, index) => `opening-${String(index)}`,
    );

    expect(validateArchitecturePlan(input)).toMatchObject({
      valid: false,
      diagnostics: [{ code: 'architecture.plan_invalid', path: '/walls/0/openingIds' }],
    });
  });

  it('accepts the supported per-floor logical-wall cap without undercounting stair halls', () => {
    const input = makeMinimalPlan();
    const originalWalls = clone(input.walls);
    const extraWalls = Array.from(
      { length: ARCHITECTURE_MAX_PLAN_WALLS_PER_FLOOR - originalWalls.length },
      (_value, index) => ({
        ...clone(originalWalls[0]!),
        id: `archgen-wall-cap-${String(index)}`,
        constant: 100 + index,
        openingIds: [],
      }),
    );
    input.walls = [...originalWalls, ...extraWalls];
    input.floors[0]!.wallIds = input.walls.map((wall) => wall.id);

    expect(ARCHITECTURE_MAX_PLAN_WALL_COUNT).toBe(3 * ARCHITECTURE_MAX_PLAN_WALLS_PER_FLOOR);
    expect(input.walls).toHaveLength(103);
    expect(validateArchitecturePlan(input).valid).toBe(true);
  });

  it('canonicalizes ordering and negative zero without mutating either caller', () => {
    const ordered = makeMinimalPlan();
    const reordered = clone(ordered);
    reordered.floors[0]!.spaceIds.reverse();
    reordered.floors[0]!.wallIds.reverse();
    reordered.spaces.reverse();
    reordered.walls.reverse();
    reordered.building.worldOrigin.x = -0;
    ordered.building.worldOrigin.x = 0;
    const before = JSON.stringify(reordered);

    const normalized = normalizeArchitecturePlan(reordered);
    expect(JSON.stringify(reordered)).toBe(before);
    expect(normalized).toEqual(normalizeArchitecturePlan(ordered));
    expect(Object.is(normalized.building.worldOrigin.x, -0)).toBe(false);
    expect(hashArchitecturePlan(reordered)).toBe(hashArchitecturePlan(ordered));
  });

  it('uses canonical JSON and lowercase SHA-256', () => {
    const plan = makeMinimalPlan();
    const serialized = stringifyArchitecturePlan(plan);
    expect(serialized.endsWith('\n')).toBe(true);
    expect(serialized.endsWith('\n\n')).toBe(false);
    expect(serialized).not.toContain('\r');
    expect(serialized.indexOf('"building"')).toBeLessThan(serialized.indexOf('"floors"'));
    expect(hashArchitecturePlan(plan)).toMatch(/^[0-9a-f]{64}$/u);

    const changed = clone(plan);
    changed.building.worldOrigin.x = 1;
    expect(hashArchitecturePlan(changed)).not.toBe(hashArchitecturePlan(plan));
  });

  it('hashes normalized WorldSpec values independently of array ordering', () => {
    const source = loadMansionProgram();
    const reordered = clone(source);
    reordered.entities.reverse();
    reordered.relationships.reverse();
    expect(hashSourceWorldSpec(reordered)).toBe(hashSourceWorldSpec(source));
  });

  it('sorts diagnostics by path, code, severity, message, then related ID', () => {
    const diagnostics = [
      architectureDiagnostic('architecture.room_invalid', '/z', 'later'),
      architectureDiagnostic('architecture.plan_invalid', '/a', 'same', 'b'),
      architectureDiagnostic('architecture.plan_invalid', '/a', 'same', 'a'),
    ];
    expect(sortArchitectureDiagnostics(diagnostics).map((entry) => entry.relatedId ?? '')).toEqual([
      'a',
      'b',
      '',
    ]);
    expect(diagnostics[0]?.path).toBe('/z');
  });
});
