import { describe, expect, it } from 'vitest';

import { validateArchitectureRelationshipDirective } from '../src/directive-validation.js';
import {
  ARCHITECTURE_RELATIONSHIP_DIRECTIVE_SCHEMA_ID,
  ArchitectureRelationshipDirectiveSchema,
} from '../src/relationship-directive-schema.js';

function directive(
  requirement: 'required' | 'preferred' | 'avoid',
  connection: 'door' | 'near' | 'none',
  weight = 50,
): Record<string, unknown> {
  return {
    schemaVersion: '0.1.0',
    mode: 'adjacency',
    requirement,
    connection,
    weight,
  };
}

describe('architecture relationship directives', () => {
  it.each([
    ['required door', directive('required', 'door', 100)],
    ['required near', directive('required', 'near')],
    ['preferred door', directive('preferred', 'door')],
    ['preferred near', directive('preferred', 'near')],
    ['avoid', directive('avoid', 'none')],
  ])('accepts %s', (_label, input) => {
    const result = validateArchitectureRelationshipDirective(input);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toEqual(input);
      expect(result.value).not.toBe(input);
    }
  });

  it('publishes the intended strict schema identity', () => {
    expect(ArchitectureRelationshipDirectiveSchema).toMatchObject({
      $id: ARCHITECTURE_RELATIONSHIP_DIRECTIVE_SCHEMA_ID,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
    });
    expect(Object.isFrozen(ArchitectureRelationshipDirectiveSchema)).toBe(true);
  });

  it.each([
    ['avoid with door', directive('avoid', 'door')],
    ['avoid with near', directive('avoid', 'near')],
    ['required with none', directive('required', 'none')],
    ['weight below range', directive('required', 'door', 0)],
    ['weight above range', directive('preferred', 'near', 101)],
    ['non-integer weight', directive('preferred', 'near', 1.5)],
    ['unknown field', { ...directive('required', 'door'), inferred: true }],
    ['unsupported version', { ...directive('required', 'door'), schemaVersion: '0.2.0' }],
  ])('rejects %s', (_label, input) => {
    const result = validateArchitectureRelationshipDirective(input);
    expect(result.valid).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'architecture.relationship_invalid',
    });
  });

  it('rejects a cyclic in-memory object at the JSON boundary', () => {
    const input = directive('preferred', 'near');
    input.self = input;
    const result = validateArchitectureRelationshipDirective(input);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'architecture.relationship_invalid',
        path: '/self',
      }),
    ]);
  });
});
