import { describe, expect, it } from 'vitest';

import {
  ARCHITECTURE_ENTITY_DIRECTIVE_SCHEMA_ID,
  ARCHITECTURE_MAX_WINDOWS_PER_ROOM,
  ArchitectureBuildingDirectiveSchema,
  ArchitectureEntityDirectiveSchema,
} from '../src/entity-directive-schema.js';
import {
  validateArchitectureEntityDirective,
  validateArchitectureEntityDirectiveForKind,
} from '../src/directive-validation.js';
import {
  buildingDirective,
  clone,
  floorDirective,
  roomDirective,
  stairDirective,
} from './helpers.js';

function codes(input: unknown): readonly string[] {
  const result = validateArchitectureEntityDirective(input);
  return result.diagnostics.map((entry) => entry.code);
}

function expectDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
  if (seen.has(value as object)) return;
  seen.add(value as object);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value as object)) {
    const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
    if (descriptor !== undefined && 'value' in descriptor) {
      expectDeepFrozen(descriptor.value, seen);
    }
  }
}

describe('architecture entity directives', () => {
  it('accepts and independently normalizes every supported directive mode', () => {
    for (const directive of [
      buildingDirective(),
      floorDirective(),
      roomDirective(),
      stairDirective(),
    ]) {
      const result = validateArchitectureEntityDirective(directive);
      expect(result.valid).toBe(true);
      if (!result.valid) continue;
      expect(result.diagnostics).toEqual([]);
      expect(result.value).toEqual(directive);
      expect(result.value).not.toBe(directive);
    }
  });

  it('publishes strict, recursively frozen draft-2020-12 TypeBox schemas', () => {
    expect(ArchitectureEntityDirectiveSchema).toMatchObject({
      $id: ARCHITECTURE_ENTITY_DIRECTIVE_SCHEMA_ID,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
    });
    expect(ArchitectureBuildingDirectiveSchema.additionalProperties).toBe(false);
    expectDeepFrozen(ArchitectureEntityDirectiveSchema);
  });

  it('rejects a directive whose mode does not match the entity kind', () => {
    const result = validateArchitectureEntityDirectiveForKind(roomDirective(), 'structure');
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'architecture.directive_invalid',
        path: '/mode',
      }),
    ]);
  });

  it.each([
    ['unsupported version', { ...roomDirective(), schemaVersion: '0.2.0' }],
    ['unknown field', { ...roomDirective(), arbitraryProperty: true }],
    ['unsupported topology', { ...buildingDirective(), topology: 'freeform' }],
    ['invalid yaw', { ...buildingDirective(), yawDegrees: 45 }],
    [
      'invalid material',
      {
        ...buildingDirective(),
        materials: { ...buildingDirective().materials, exteriorWall: 'Fabric' },
      },
    ],
    [
      'invalid color',
      {
        ...buildingDirective(),
        colors: {
          ...buildingDirective().colors,
          exteriorWall: { r: 256, g: 0, b: 0 },
        },
      },
    ],
    ['invalid aspect ratio', { ...roomDirective(), maximumAspectRatio: 0.99 }],
    ['invalid stair value', { ...stairDirective(), maximumRiserHeight: 0 }],
  ])('rejects %s with a stable directive diagnostic', (_label, input) => {
    expect(codes(input)).toContain('architecture.directive_invalid');
  });

  it('rejects non-grid horizontal building dimensions', () => {
    const result = validateArchitectureEntityDirective({
      ...buildingDirective(),
      exteriorWallThickness: 1.5,
    });
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'architecture.grid_misaligned',
        path: '/exteriorWallThickness',
      }),
    );
  });

  it('requires one complete grid cell for each room band after corridor walls', () => {
    const exact = validateArchitectureEntityDirective({
      ...buildingDirective(),
      corridorAxis: 'x',
      corridorWidth: 82,
    });
    expect(exact.valid).toBe(true);

    const tooNarrow = validateArchitectureEntityDirective({
      ...buildingDirective(),
      corridorAxis: 'x',
      corridorWidth: 83,
    });
    expect(tooNarrow.valid).toBe(false);
    expect(tooNarrow.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'architecture.directive_invalid',
        path: '/corridorWidth',
      }),
    );
  });

  it('records default clear height without treating it as an authored floor', () => {
    expect(
      validateArchitectureEntityDirective({
        ...buildingDirective(),
        defaultClearHeight: 1,
      }).valid,
    ).toBe(true);
  });

  it('rejects inverted room areas and window counts semantically', () => {
    const areaResult = validateArchitectureEntityDirective({
      ...roomDirective(),
      minimumArea: 400,
      preferredArea: 300,
      maximumArea: 500,
    });
    expect(areaResult.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'architecture.room_invalid', path: '/preferredArea' }),
    );

    const windowsResult = validateArchitectureEntityDirective({
      ...roomDirective(),
      windows: { minimum: 3, preferred: 2 },
    });
    expect(windowsResult.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'architecture.room_invalid',
        path: '/windows/preferred',
      }),
    );
  });

  it('bounds required and preferred windows per room in the strict schema', () => {
    expect(
      validateArchitectureEntityDirective({
        ...roomDirective(),
        windows: {
          minimum: ARCHITECTURE_MAX_WINDOWS_PER_ROOM,
          preferred: ARCHITECTURE_MAX_WINDOWS_PER_ROOM,
        },
      }).valid,
    ).toBe(true);
    const result = validateArchitectureEntityDirective({
      ...roomDirective(),
      windows: { minimum: 0, preferred: ARCHITECTURE_MAX_WINDOWS_PER_ROOM + 1 },
    });
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'architecture.directive_invalid',
        path: '/windows/preferred',
      }),
    );
  });

  it.each([
    ['Date', new Date(0)],
    ['BigInt', { mode: 'room', value: 1n }],
    ['function', { mode: 'room', value: (): void => undefined }],
    ['undefined', { mode: 'room', value: undefined }],
    ['sparse array', Array(2)],
  ])('rejects non-JSON %s input', (_label, input) => {
    const result = validateArchitectureEntityDirective(input);
    expect(result.valid).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ code: 'architecture.directive_invalid' });
    expect(result.diagnostics[0]?.message).toContain('not JSON-compatible');
  });

  it('rejects accessors without invoking them', () => {
    let invoked = false;
    const input = clone(roomDirective()) as object;
    Object.defineProperty(input, 'surprise', {
      enumerable: true,
      get(): never {
        invoked = true;
        throw new Error('Accessor must not execute.');
      },
    });

    const result = validateArchitectureEntityDirective(input);
    expect(invoked).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'architecture.directive_invalid',
        path: '/surprise',
      }),
    ]);
  });

  it('normalizes negative zero without mutating caller-owned input', () => {
    const input = clone(buildingDirective());
    input.origin.x = -0;
    const before = clone(input);
    const result = validateArchitectureEntityDirective(input);
    expect(result.valid).toBe(true);
    expect(Object.is(input.origin.x, -0)).toBe(true);
    expect(input).toEqual(before);
    if (result.valid && result.value.mode === 'building') {
      expect(Object.is(result.value.origin.x, -0)).toBe(false);
      result.value.origin.x = 99;
      expect(Object.is(input.origin.x, -0)).toBe(true);
    }
  });
});
