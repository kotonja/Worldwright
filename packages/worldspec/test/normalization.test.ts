import { describe, expect, it } from 'vitest';

import { normalizeWorldSpec, stringifyWorldSpec } from '../src/index.js';
import type { WorldSpec } from '../src/index.js';
import { fixtureSource, loadValidFixture } from './helpers.js';

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function ids(values: readonly { readonly id: string }[]): string[] {
  return values.map((value) => value.id);
}

function reverseSetLikeArrays(spec: WorldSpec): void {
  spec.entities.reverse();
  spec.relationships.reverse();
  spec.constraints.reverse();
  spec.locks.reverse();
  spec.budgets.targetDevices.reverse();

  for (const entity of spec.entities) {
    entity.tags.reverse();
    entity.provenance.referenceIds.reverse();
  }

  for (const constraint of spec.constraints) {
    constraint.subjectIds.reverse();
    constraint.targetIds.reverse();
  }

  for (const lock of spec.locks) {
    lock.fieldPaths.reverse();
  }
}

describe('WorldSpec normalization', () => {
  it('returns a deep independent value without mutating caller input', () => {
    const input = loadValidFixture();
    reverseSetLikeArrays(input);
    const before = structuredClone(input);

    const normalized = normalizeWorldSpec(input);

    expect(input).toEqual(before);
    expect(normalized).not.toBe(input);
    expect(normalized.project).not.toBe(input.project);
    expect(normalized.entities).not.toBe(input.entities);
    expect(normalized.entities[0]?.attributes).not.toBe(input.entities[0]?.attributes);

    normalized.project.name = 'Changed only in normalized output';
    expect(input.project.name).toBe(before.project.name);
  });

  it('sorts ID collections and set-like arrays', () => {
    const input = loadValidFixture();
    reverseSetLikeArrays(input);

    const normalized = normalizeWorldSpec(input);

    expect(ids(normalized.entities)).toEqual(sorted(ids(input.entities)));
    expect(ids(normalized.relationships)).toEqual(sorted(ids(input.relationships)));
    expect(ids(normalized.constraints)).toEqual(sorted(ids(input.constraints)));
    expect(ids(normalized.locks)).toEqual(sorted(ids(input.locks)));
    expect(normalized.budgets.targetDevices).toEqual(sorted(input.budgets.targetDevices));

    for (const entity of normalized.entities) {
      expect(entity.tags).toEqual(sorted(entity.tags));
      expect(entity.provenance.referenceIds).toEqual(sorted(entity.provenance.referenceIds));
    }

    for (const constraint of normalized.constraints) {
      expect(constraint.subjectIds).toEqual(sorted(constraint.subjectIds));
      expect(constraint.targetIds).toEqual(sorted(constraint.targetIds));
    }

    for (const lock of normalized.locks) {
      expect(lock.fieldPaths).toEqual(sorted(lock.fieldPaths));
    }
  });

  it('preserves references, intent lists, and Style DNA author ordering', () => {
    const input = loadValidFixture();
    input.references.reverse();
    input.intent.mustHave.reverse();
    input.intent.mustNotHave.reverse();
    input.intent.preferences.reverse();
    input.style.architecture.reverse();
    input.style.shapeLanguage.reverse();
    input.style.materialFamilies.reverse();
    input.style.palette.reverse();
    input.style.lighting.reverse();
    input.style.exclusions.reverse();

    const expected = {
      referenceIds: ids(input.references),
      mustHave: [...input.intent.mustHave],
      mustNotHave: [...input.intent.mustNotHave],
      preferences: [...input.intent.preferences],
      architecture: [...input.style.architecture],
      shapeLanguage: [...input.style.shapeLanguage],
      materialFamilies: [...input.style.materialFamilies],
      palette: [...input.style.palette],
      lighting: [...input.style.lighting],
      exclusions: [...input.style.exclusions],
    };

    const normalized = normalizeWorldSpec(input);

    expect({
      referenceIds: ids(normalized.references),
      mustHave: normalized.intent.mustHave,
      mustNotHave: normalized.intent.mustNotHave,
      preferences: normalized.intent.preferences,
      architecture: normalized.style.architecture,
      shapeLanguage: normalized.style.shapeLanguage,
      materialFamilies: normalized.style.materialFamilies,
      palette: normalized.style.palette,
      lighting: normalized.style.lighting,
      exclusions: normalized.style.exclusions,
    }).toEqual(expected);
  });

  it('produces identical normalized values for equivalent set ordering', () => {
    const first = loadValidFixture();
    const second = structuredClone(first);
    reverseSetLikeArrays(second);

    expect(normalizeWorldSpec(second)).toEqual(normalizeWorldSpec(first));
  });

  it('serializes deterministically with stable keys, two spaces, and one newline', () => {
    const input = loadValidFixture();
    input.entities[0]!.attributes = { zeta: 1, alpha: 2 };

    const first = stringifyWorldSpec(normalizeWorldSpec(input));
    const second = stringifyWorldSpec(normalizeWorldSpec(input));

    expect(second).toBe(first);
    expect(first.endsWith('\n')).toBe(true);
    expect(first.endsWith('\n\n')).toBe(false);
    expect(first).toContain('\n  "project": {');
    expect(first.indexOf('"alpha"')).toBeLessThan(first.indexOf('"zeta"'));
  });

  it('keeps the checked-in mansion fixture in canonical normalized form', () => {
    const fixture = loadValidFixture();

    expect(stringifyWorldSpec(normalizeWorldSpec(fixture))).toBe(
      fixtureSource('valid/reference-mansion.worldspec.json'),
    );
  });
});
