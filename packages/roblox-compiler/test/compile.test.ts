import type { JsonValue, WorldEntity, WorldSpec } from '@worldwright/worldspec';
import { describe, expect, it } from 'vitest';

import { compileWorldSpecToRobloxManifest } from '../src/compile.js';
import { stringifyRobloxManifest } from '../src/normalize.js';
import type { RobloxManifest } from '../src/types.js';
import { clone, loadPrimitiveWorldSpec, nodeById } from './helpers.js';

function entityById(input: WorldSpec, id: string): WorldEntity {
  const entity = input.entities.find((entry) => entry.id === id);
  if (entity === undefined) throw new Error(`Fixture entity is missing: ${id}`);
  return entity;
}

function compileOrThrow(input: unknown): RobloxManifest {
  const result = compileWorldSpecToRobloxManifest(input);
  if (!result.success) throw new Error(JSON.stringify(result.diagnostics));
  return result.manifest;
}

function primitiveDirective(
  overrides: Readonly<Record<string, JsonValue>> = {},
): Record<string, JsonValue> {
  return {
    schemaVersion: '0.1.0',
    mode: 'primitive',
    className: 'Part',
    shape: 'Block',
    material: 'Concrete',
    color: { r: 120, g: 121, b: 122 },
    transparency: 0,
    canCollide: true,
    canQuery: true,
    canTouch: true,
    castShadow: true,
    ...overrides,
  };
}

describe('WorldSpec to Roblox Manifest compilation', () => {
  it('compiles the authored primitive courtyard with every allowlisted node class represented', () => {
    const input = loadPrimitiveWorldSpec();
    const result = compileWorldSpecToRobloxManifest(input);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.manifest.measurements).toEqual({ instances: 20, containers: 6, primitives: 14 });
    expect(result.manifest.nodes).toContainEqual(
      expect.objectContaining({
        id: 'courtyard-floor',
        entityKind: 'floor',
        className: 'Folder',
        parentId: 'courtyard-structure',
      }),
    );
    expect(result.manifest.nodes).toContainEqual(
      expect.objectContaining({
        id: 'courtyard-details',
        entityKind: 'room',
        className: 'Folder',
      }),
    );
    expect(new Set(result.manifest.nodes.map((node) => node.className))).toEqual(
      new Set(['Folder', 'Model', 'Part', 'WedgePart', 'CornerWedgePart']),
    );
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      'compiler.budget_not_evaluated',
      'compiler.budget_not_evaluated',
    ]);
  });

  it('rejects an invalid WorldSpec before directive compilation', () => {
    const input = loadPrimitiveWorldSpec();
    (input as unknown as { schemaVersion: string }).schemaVersion = 'unsupported';

    const result = compileWorldSpecToRobloxManifest(input);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.diagnostics.every((entry) => entry.code === 'compiler.worldspec_invalid')).toBe(
      true,
    );
  });

  it('requires the root to compile as a container', () => {
    const input = loadPrimitiveWorldSpec();
    entityById(input, input.rootEntityId).attributes['worldwright.roblox'] = primitiveDirective();

    const result = compileWorldSpecToRobloxManifest(input);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'compiler.root_not_container',
        relatedId: input.rootEntityId,
      }),
    );
  });

  it('requires primitives to be hierarchy leaves', () => {
    const input = loadPrimitiveWorldSpec();
    entityById(input, 'courtyard-region').attributes['worldwright.roblox'] = primitiveDirective();

    const result = compileWorldSpecToRobloxManifest(input);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'compiler.primitive_has_children',
        relatedId: 'courtyard-region',
      }),
    );
  });

  it('requires explicit transform and bounds on primitives', () => {
    const withoutTransform = loadPrimitiveWorldSpec();
    delete entityById(withoutTransform, 'north-wall').transform;
    const transformResult = compileWorldSpecToRobloxManifest(withoutTransform);
    expect(transformResult.success).toBe(false);
    if (!transformResult.success) {
      expect(transformResult.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'compiler.transform_missing', relatedId: 'north-wall' }),
      );
    }

    const withoutBounds = loadPrimitiveWorldSpec();
    delete entityById(withoutBounds, 'north-wall').bounds;
    const boundsResult = compileWorldSpecToRobloxManifest(withoutBounds);
    expect(boundsResult.success).toBe(false);
    if (!boundsResult.success) {
      expect(boundsResult.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'compiler.bounds_missing', relatedId: 'north-wall' }),
      );
    }
  });

  it('multiplies bounds and scale component-wise and rejects an underflowed non-positive size', () => {
    const manifest = compileOrThrow(loadPrimitiveWorldSpec());
    const wall = nodeById(manifest, 'west-wall');
    expect(wall.className).toBe('Part');
    if (wall.className !== 'Part') return;
    expect(wall.properties.size).toEqual({ x: 48, y: 11, z: 2 });

    const underflow = loadPrimitiveWorldSpec();
    const entity = entityById(underflow, 'west-wall');
    if (entity.bounds === undefined || entity.transform === undefined) {
      throw new Error('Fixture primitive dimensions are missing.');
    }
    entity.bounds.size.x = Number.MIN_VALUE;
    entity.transform.scale.x = Number.MIN_VALUE;
    const result = compileWorldSpecToRobloxManifest(underflow);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'compiler.size_invalid', relatedId: 'west-wall' }),
      );
    }
  });

  it('preserves exact world-space XYZ transforms without composing parent transforms', () => {
    const input = loadPrimitiveWorldSpec();
    const sourceOrb = entityById(input, 'courtyard-guide-orb');
    const manifest = compileOrThrow(input);
    const orb = nodeById(manifest, sourceOrb.id);
    expect(orb.className).toBe('Part');
    if (orb.className !== 'Part' || sourceOrb.transform === undefined) return;

    expect(orb.properties.position).toEqual(sourceOrb.transform.position);
    expect(orb.properties.rotationEulerDegreesXYZ).toEqual(
      sourceOrb.transform.rotationEulerDegrees,
    );
    expect(orb.properties.position).toEqual({ x: 0, y: 9, z: 0 });
    expect(orb.properties.rotationEulerDegreesXYZ).toEqual({ x: 15, y: 30, z: 45 });
    expect(orb.properties.position).not.toEqual(
      entityById(input, 'courtyard-details').transform?.position,
    );
  });

  it('anchors every output primitive', () => {
    const manifest = compileOrThrow(loadPrimitiveWorldSpec());
    const primitives = manifest.nodes.filter(
      (node) =>
        node.className === 'Part' ||
        node.className === 'WedgePart' ||
        node.className === 'CornerWedgePart',
    );

    expect(primitives).toHaveLength(manifest.measurements.primitives);
    expect(primitives.every((node) => node.properties.anchored === true)).toBe(true);
  });

  it('mirrors hierarchy and maps every entity ID to exactly one stable node ID', () => {
    const input = loadPrimitiveWorldSpec();
    const manifest = compileOrThrow(input);
    const parents = new Map(manifest.nodes.map((node) => [node.id, node.parentId]));

    expect(manifest.nodes).toHaveLength(input.entities.length);
    expect(new Set(manifest.nodes.map((node) => node.id))).toEqual(
      new Set(input.entities.map((entity) => entity.id)),
    );
    for (const entity of input.entities) {
      expect(parents.get(entity.id)).toBe(entity.parentId);
    }
  });

  it('copies only the fixed managed attributes and never arbitrary source attributes', () => {
    const input = loadPrimitiveWorldSpec();
    const entity = entityById(input, 'plaza-floor');
    entity.attributes['private-design-note'] = { source: 'must-not-copy' };
    entity.attributes['Source'] = 'print("not executable output")';

    const manifest = compileOrThrow(input);
    const node = nodeById(manifest, entity.id);

    expect(Object.keys(node.attributes)).toEqual([
      'WorldwrightManaged',
      'WorldwrightProjectId',
      'WorldwrightEntityId',
      'WorldwrightEntityKind',
      'WorldwrightCompilerVersion',
    ]);
    expect(node).not.toHaveProperty('private-design-note');
    expect(node).not.toHaveProperty('Source');
  });

  it('does not mutate the caller-owned WorldSpec', () => {
    const input = loadPrimitiveWorldSpec();
    const before = clone(input);

    compileWorldSpecToRobloxManifest(input);

    expect(input).toEqual(before);
  });

  it('is deterministic across repeated compilation and canonical serialization', () => {
    const input = loadPrimitiveWorldSpec();
    const first = compileOrThrow(input);
    const second = compileOrThrow(clone(input));

    expect(second).toEqual(first);
    expect(stringifyRobloxManifest(second)).toBe(stringifyRobloxManifest(first));
  });

  it('hashes WorldSpecs identically when set-like provenance reference order normalizes identically', () => {
    const firstInput = loadPrimitiveWorldSpec();
    firstInput.references.push({
      id: 'reference-secondary-brief',
      kind: 'text',
      role: 'Secondary locally authored dimensions',
      influence: 0.5,
    });
    const firstEntity = entityById(firstInput, 'plaza-floor');
    firstEntity.provenance.referenceIds = [
      'reference-courtyard-brief',
      'reference-secondary-brief',
    ];
    const secondInput = clone(firstInput);
    entityById(secondInput, 'plaza-floor').provenance.referenceIds = [
      'reference-secondary-brief',
      'reference-courtyard-brief',
    ];

    const first = compileOrThrow(firstInput);
    const second = compileOrThrow(secondInput);

    expect(second.source.worldSpecHash).toBe(first.source.worldSpecHash);
    expect(second).toEqual(first);
  });

  it('enforces the instance budget above the limit but passes at exact equality', () => {
    const equal = loadPrimitiveWorldSpec();
    if (equal.budgets.limits === undefined) throw new Error('Fixture budget is missing.');
    equal.budgets.limits = { instances: equal.entities.length };
    expect(compileWorldSpecToRobloxManifest(equal).success).toBe(true);

    const exceeded = loadPrimitiveWorldSpec();
    if (exceeded.budgets.limits === undefined) throw new Error('Fixture budget is missing.');
    exceeded.budgets.limits = { instances: exceeded.entities.length - 1 };
    const result = compileWorldSpecToRobloxManifest(exceeded);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: 'compiler.instance_budget_exceeded' }),
      ]);
    }
  });

  it('emits deterministic unevaluated warnings for triangle and texture budgets without failing', () => {
    const input = loadPrimitiveWorldSpec();
    if (input.budgets.limits === undefined) throw new Error('Fixture budget is missing.');
    input.budgets.limits = { triangles: 1, textureMemoryMegabytes: 0.001 };

    const result = compileWorldSpecToRobloxManifest(input);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'compiler.budget_not_evaluated',
        severity: 'warning',
        path: '/budgets/limits/textureMemoryMegabytes',
      }),
      expect.objectContaining({
        code: 'compiler.budget_not_evaluated',
        severity: 'warning',
        path: '/budgets/limits/triangles',
      }),
    ]);
  });
});
