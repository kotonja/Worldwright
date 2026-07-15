import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  parseWorldSpec,
  WORLD_SPEC_SCHEMA_ID,
  WORLD_SPEC_VERSION,
  WorldSpecSchema,
  validateWorldSpec,
} from '../src/index.js';
import { renderWorldSpecSchema, schemaArtifactPath } from '../scripts/generate-schema.js';
import { diagnosticCodes, fixtureSource, loadValidFixture, validateFixture } from './helpers.js';

describe('WorldSpec JSON Schema', () => {
  it('publishes the v0.1.0 draft 2020-12 identity', () => {
    expect(WORLD_SPEC_VERSION).toBe('0.1.0');
    expect(WORLD_SPEC_SCHEMA_ID).toBe('urn:worldwright:worldspec:0.1.0');
    expect(WorldSpecSchema).toMatchObject({
      $id: WORLD_SPEC_SCHEMA_ID,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      additionalProperties: false,
    });
  });

  it('accepts the reference mansion fixture', () => {
    const result = validateFixture('valid/reference-mansion.worldspec.json');

    expect(result.valid, result.valid ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
  });

  it('rejects unknown properties on strict domain objects', () => {
    const input = loadValidFixture();
    Object.assign(input.project, { unrecognizedField: 'not allowed' });

    expect(diagnosticCodes(validateWorldSpec(input))).toContain('schema.invalid');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite numeric input: %s',
    (value: number) => {
      const input = loadValidFixture();
      input.project.seed = value;

      expect(diagnosticCodes(validateWorldSpec(input))).toContain('schema.invalid');
    },
  );

  it('accepts the maximum safe integer for seeds and integer budget limits', () => {
    const input = loadValidFixture();
    input.project.seed = Number.MAX_SAFE_INTEGER;
    input.budgets.limits = {
      ...input.budgets.limits,
      instances: Number.MAX_SAFE_INTEGER,
      triangles: Number.MAX_SAFE_INTEGER,
    };

    expect(validateWorldSpec(input).valid).toBe(true);
  });

  it.each([
    [
      'project.seed',
      (input: ReturnType<typeof loadValidFixture>): void => {
        input.project.seed = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      'budgets.limits.instances',
      (input: ReturnType<typeof loadValidFixture>): void => {
        input.budgets.limits = {
          ...input.budgets.limits,
          instances: Number.MAX_SAFE_INTEGER + 1,
        };
      },
    ],
    [
      'budgets.limits.triangles',
      (input: ReturnType<typeof loadValidFixture>): void => {
        input.budgets.limits = {
          ...input.budgets.limits,
          triangles: Number.MAX_SAFE_INTEGER + 1,
        };
      },
    ],
  ])('rejects values above the safe integer boundary for %s', (_field, mutate) => {
    const input = loadValidFixture();
    mutate(input);

    expect(diagnosticCodes(validateWorldSpec(input))).toContain('schema.invalid');
  });

  it('rejects an unsafe integer written in JSON source after parsing', () => {
    const source = fixtureSource('valid/reference-mansion.worldspec.json').replace(
      '"seed": 1847',
      '"seed": 9007199254740992',
    );

    expect(diagnosticCodes(parseWorldSpec(source))).toContain('schema.invalid');
  });

  it.each([
    ['undefined', undefined],
    ['function', (): void => undefined],
    ['symbol', Symbol('not-json')],
    ['bigint', BigInt(1)],
    ['Date', new Date('2026-01-01T00:00:00.000Z')],
    ['class instance', new (class NonJsonValue {})()],
  ])('rejects non-JSON-compatible %s values in open fields', (_name, value: unknown) => {
    const input = loadValidFixture();
    const attributes = input.entities[0]?.attributes as Record<string, unknown>;
    attributes.invalidValue = value;

    expect(diagnosticCodes(validateWorldSpec(input))).toContain('schema.invalid');
  });

  it('rejects unsupported schema versions in phase one', () => {
    const result = validateFixture('invalid/invalid-version.worldspec.json');

    expect(result.valid).toBe(false);
    expect(diagnosticCodes(result)).toContain('schema.invalid');
  });

  it('keeps the checked-in schema artifact byte-for-byte current', () => {
    expect(readFileSync(schemaArtifactPath, 'utf8')).toBe(renderWorldSpecSchema());
  });
});
