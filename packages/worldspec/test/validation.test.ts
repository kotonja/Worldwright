import { describe, expect, it } from 'vitest';

import { parseWorldSpec, validateWorldSpec } from '../src/index.js';
import type { WorldSpec } from '../src/index.js';
import { diagnosticCodes, findEntity, loadValidFixture, validateFixture } from './helpers.js';

describe('semantic validation', () => {
  it.each([
    ['duplicate-id.worldspec.json', 'id.duplicate'],
    ['dangling-parent.worldspec.json', 'entity.parent_missing'],
    ['parent-cycle.worldspec.json', 'entity.parent_cycle'],
    ['dangling-relationship.worldspec.json', 'relationship.endpoint_missing'],
    ['unknown-reference.worldspec.json', 'reference.missing'],
    ['invalid-version.worldspec.json', 'schema.invalid'],
  ])('rejects %s with %s', (fixtureName: string, expectedCode: string) => {
    const result = validateFixture(`invalid/${fixtureName}`);

    expect(result.valid).toBe(false);
    expect(diagnosticCodes(result)).toContain(expectedCode);
  });

  it.each<readonly [string, (spec: WorldSpec) => void]>([
    ['reference', (spec) => (spec.references[0]!.id = spec.project.id)],
    ['entity', (spec) => (spec.entities[0]!.id = spec.project.id)],
    ['relationship', (spec) => (spec.relationships[0]!.id = spec.project.id)],
    ['constraint', (spec) => (spec.constraints[0]!.id = spec.project.id)],
    ['lock', (spec) => (spec.locks[0]!.id = spec.project.id)],
  ])('enforces global ID uniqueness for a %s ID', (_category, mutate) => {
    const input = loadValidFixture();
    mutate(input);

    expect(diagnosticCodes(validateWorldSpec(input))).toContain('id.duplicate');
  });

  it('requires rootEntityId to resolve', () => {
    const input = loadValidFixture();
    input.rootEntityId = 'entity-not-present';

    expect(diagnosticCodes(validateWorldSpec(input))).toContain('entity.root_missing');
  });

  it('requires the root entity to be a world', () => {
    const input = loadValidFixture();
    findEntity(input, 'entity-world').kind = 'region';

    expect(diagnosticCodes(validateWorldSpec(input))).toContain('entity.root_wrong_kind');
  });

  it('forbids a parent on the root entity', () => {
    const input = loadValidFixture();
    findEntity(input, 'entity-world').parentId = 'entity-cliffside-region';

    expect(diagnosticCodes(validateWorldSpec(input))).toContain('entity.root_has_parent');
  });

  it('requires every non-root entity to have a parent and reach the root', () => {
    const input = loadValidFixture();
    delete findEntity(input, 'entity-kitchen').parentId;

    const codes = diagnosticCodes(validateWorldSpec(input));
    expect(codes).toContain('entity.parent_missing');
    expect(codes).toContain('entity.unreachable');
  });

  it('forbids self-parenting', () => {
    const input = loadValidFixture();
    findEntity(input, 'entity-kitchen').parentId = 'entity-kitchen';

    expect(diagnosticCodes(validateWorldSpec(input))).toContain('entity.parent_self');
  });

  it('detects cycles in parent chains', () => {
    const result = validateFixture('invalid/parent-cycle.worldspec.json');

    expect(diagnosticCodes(result)).toContain('entity.parent_cycle');
  });

  it('requires provenance references to resolve', () => {
    const result = validateFixture('invalid/unknown-reference.worldspec.json');

    expect(diagnosticCodes(result)).toContain('reference.missing');
  });

  it('requires both relationship endpoints to resolve', () => {
    const result = validateFixture('invalid/dangling-relationship.worldspec.json');

    expect(diagnosticCodes(result)).toContain('relationship.endpoint_missing');
  });

  it('forbids self relationships', () => {
    const input = loadValidFixture();
    const relationship = input.relationships[0]!;
    relationship.targetId = relationship.sourceId;

    expect(diagnosticCodes(validateWorldSpec(input))).toContain('relationship.self');
  });

  it.each(['subjectIds', 'targetIds'] as const)('requires constraint %s to resolve', (field) => {
    const input = loadValidFixture();
    input.constraints[0]![field] = ['entity-not-present'];

    expect(diagnosticCodes(validateWorldSpec(input))).toContain('constraint.entity_missing');
  });

  it('requires lock entity IDs to resolve', () => {
    const input = loadValidFixture();
    input.locks[0]!.entityId = 'entity-not-present';

    expect(diagnosticCodes(validateWorldSpec(input))).toContain('lock.entity_missing');
  });

  it('requires every lock field path to be non-empty', () => {
    const input = loadValidFixture();
    input.locks[0]!.fieldPaths = [''];

    expect(diagnosticCodes(validateWorldSpec(input))).toContain('lock.path_empty');
  });

  it('requires each lock to contain at least one field path', () => {
    const input = loadValidFixture();
    input.locks[0]!.fieldPaths = [];

    expect(diagnosticCodes(validateWorldSpec(input))).toContain('lock.path_empty');
  });

  it('returns a structured diagnostic instead of throwing for malformed JSON', () => {
    const result = parseWorldSpec('{"schemaVersion":');

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'json.invalid',
        severity: 'error',
        path: '',
      }),
    ]);
  });

  it('uses JSON Pointer-like paths and stable structured fields', () => {
    const result = validateFixture('invalid/dangling-parent.worldspec.json');
    const diagnostic = result.diagnostics.find(
      (candidate) => candidate.code === 'entity.parent_missing',
    );

    expect(diagnostic).toEqual(
      expect.objectContaining({
        code: 'entity.parent_missing',
        severity: 'error',
        path: expect.stringMatching(/^\//u),
        message: expect.any(String),
        relatedId: 'entity-missing',
      }),
    );
  });

  it('accepts unknown input and never throws for an invalid value', () => {
    expect(() => validateWorldSpec(null)).not.toThrow();
    expect(diagnosticCodes(validateWorldSpec(null))).toContain('schema.invalid');
  });

  it('does not mutate caller-owned input while validating', () => {
    const input = loadValidFixture();
    const before = structuredClone(input);

    expect(validateWorldSpec(input).valid).toBe(true);
    expect(input).toEqual(before);
  });
});
