import { describe, expect, it } from 'vitest';

import { compileWorldSpecToRobloxManifest } from '../src/compile.js';
import { validateRobloxDirective } from '../src/directive.js';
import {
  ROBLOX_CONTAINER_CLASSES,
  ROBLOX_CHANGE_SET_SCHEMA_ID,
  ROBLOX_MANIFEST_SCHEMA_ID,
  ROBLOX_MATERIALS,
  ROBLOX_PART_SHAPES,
  ROBLOX_PRIMITIVE_CLASSES,
  ROBLOX_SNAPSHOT_SCHEMA_ID,
  RobloxChangeSetSchema,
  RobloxDirectiveSchema,
  RobloxManifestSchema,
  RobloxSnapshotSchema,
} from '../src/index.js';
import { clone, loadPrimitiveWorldSpec } from './helpers.js';

function partDirective(): Record<string, unknown> {
  return {
    schemaVersion: '0.1.0',
    mode: 'primitive',
    className: 'Part',
    shape: 'Block',
    material: 'Concrete',
    color: { r: 12, g: 34, b: 56 },
    transparency: 0.25,
    canCollide: true,
    canQuery: true,
    canTouch: false,
    castShadow: true,
  };
}

function expectInvalidDirective(input: unknown, expectedPath?: string): void {
  const result = validateRobloxDirective(input, '/entities/3/attributes/worldwright.roblox');
  expect(result.valid).toBe(false);
  if (result.valid) return;
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      code: 'compiler.directive_invalid',
      path:
        expectedPath === undefined
          ? expect.stringMatching(/^\/entities\/3\/attributes\/worldwright\.roblox/)
          : `/entities/3/attributes/worldwright.roblox${expectedPath}`,
    }),
  ]);
}

function expectDeepFrozen(root: object): void {
  const pending = [root];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    expect(Object.isFrozen(current)).toBe(true);
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !('value' in descriptor)) continue;
      const child: unknown = descriptor.value;
      if (child !== null && (typeof child === 'object' || typeof child === 'function')) {
        pending.push(child);
      }
    }
  }
}

describe('Roblox directive validation', () => {
  it('exposes runtime-frozen allowlists', () => {
    for (const allowlist of [
      ROBLOX_CONTAINER_CLASSES,
      ROBLOX_PRIMITIVE_CLASSES,
      ROBLOX_PART_SHAPES,
      ROBLOX_MATERIALS,
    ]) {
      expect(Object.isFrozen(allowlist)).toBe(true);
    }
    expect(() => (ROBLOX_MATERIALS as unknown as string[]).push('ForceField')).toThrow(TypeError);
    expect(ROBLOX_MATERIALS).not.toContain('ForceField');
  });

  it('exposes deeply frozen public schema descriptors', () => {
    expect(RobloxManifestSchema.$id).toBe(ROBLOX_MANIFEST_SCHEMA_ID);
    expect(RobloxSnapshotSchema.$id).toBe(ROBLOX_SNAPSHOT_SCHEMA_ID);
    expect(RobloxChangeSetSchema.$id).toBe(ROBLOX_CHANGE_SET_SCHEMA_ID);
    for (const schema of [
      RobloxDirectiveSchema,
      RobloxManifestSchema,
      RobloxSnapshotSchema,
      RobloxChangeSetSchema,
    ]) {
      expectDeepFrozen(schema);
    }
  });

  it('accepts a strict container directive', () => {
    expect(
      validateRobloxDirective({
        schemaVersion: '0.1.0',
        mode: 'container',
        className: 'Model',
      }),
    ).toEqual({
      valid: true,
      value: { schemaVersion: '0.1.0', mode: 'container', className: 'Model' },
      diagnostics: [],
    });
  });

  it('accepts strict Part, WedgePart, and CornerWedgePart directives', () => {
    const part = partDirective();
    const { shape, ...withoutShape } = part;

    expect(shape).toBe('Block');
    expect(validateRobloxDirective(part).valid).toBe(true);
    expect(
      validateRobloxDirective({ ...withoutShape, className: 'WedgePart', material: 'Slate' }).valid,
    ).toBe(true);
    expect(
      validateRobloxDirective({
        ...withoutShape,
        className: 'CornerWedgePart',
        material: 'Cobblestone',
      }).valid,
    ).toBe(true);
  });

  it('returns a deep-independent directive value', () => {
    const input = partDirective();
    const result = validateRobloxDirective(input);

    expect(result.valid).toBe(true);
    if (!result.valid || result.value.mode !== 'primitive') {
      throw new Error('Expected a validated primitive directive.');
    }
    expect(result.value).not.toBe(input);
    expect(result.value.color).not.toBe(input.color);
    expect(result.value.color).toEqual(input.color);
  });

  it('reports a missing entity directive as a stable compiler error', () => {
    const input = loadPrimitiveWorldSpec();
    const entity = input.entities[1];
    if (entity === undefined) throw new Error('Fixture entity is missing.');
    delete (entity.attributes as Record<string, unknown>)['worldwright.roblox'];

    const result = compileWorldSpecToRobloxManifest(input);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'compiler.directive_missing',
        relatedId: entity.id,
        path: expect.stringContaining('/attributes/worldwright.roblox'),
      }),
    );
  });

  it('reports directive paths against the caller entity order', () => {
    const input = loadPrimitiveWorldSpec();
    input.entities.reverse();
    const inputIndex = input.entities.findIndex((entity) => entity.id === 'courtyard-world');
    const entity = input.entities[inputIndex];
    if (entity === undefined) throw new Error('Fixture root entity is missing.');
    delete (entity.attributes as Record<string, unknown>)['worldwright.roblox'];

    const result = compileWorldSpecToRobloxManifest(input);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected missing-directive compilation failure.');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'compiler.directive_missing',
        relatedId: 'courtyard-world',
        path: `/entities/${inputIndex}/attributes/worldwright.roblox`,
      }),
    );
  });

  it('rejects an unsupported directive version', () => {
    expectInvalidDirective({ ...partDirective(), schemaVersion: '0.2.0' });
  });

  it('rejects unknown directive fields', () => {
    expectInvalidDirective({ ...partDirective(), arbitraryProperty: true });
  });

  it('rejects unsupported classes and materials', () => {
    expectInvalidDirective({ ...partDirective(), className: 'MeshPart' }, '/className');
    expectInvalidDirective({ ...partDirective(), material: 'ForceField' }, '/material');
  });

  it('requires Part shape and forbids shape on WedgePart', () => {
    const missingShape = partDirective();
    delete missingShape.shape;
    expectInvalidDirective(missingShape, '/shape');
    expectInvalidDirective({ ...partDirective(), className: 'WedgePart' }, '/shape');
  });

  it('rejects RGB components outside byte bounds', () => {
    expectInvalidDirective({ ...partDirective(), color: { r: -1, g: 34, b: 56 } });
    expectInvalidDirective({ ...partDirective(), color: { r: 12, g: 34, b: 256 } });
  });

  it('rejects transparency outside the inclusive zero-to-one range', () => {
    expectInvalidDirective({ ...partDirective(), transparency: -0.01 });
    expectInvalidDirective({ ...partDirective(), transparency: 1.01 });
  });

  it('rejects executable, non-JSON, and cyclic in-memory data without invoking it', () => {
    let invoked = false;
    const executable = {
      ...partDirective(),
      execute: (): void => {
        invoked = true;
      },
    };
    const cyclic = clone(partDirective()) as Record<string, unknown>;
    cyclic.self = cyclic;

    expectInvalidDirective(executable);
    expectInvalidDirective(cyclic);
    expect(invoked).toBe(false);
  });
});
