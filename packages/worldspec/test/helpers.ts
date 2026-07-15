import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { formatDiagnostics, parseWorldSpec } from '../src/index.js';
import type { ValidationResult, WorldSpec } from '../src/index.js';

export function fixturePath(relativePath: string): string {
  return fileURLToPath(new URL(`../fixtures/${relativePath}`, import.meta.url));
}

export function fixtureSource(relativePath: string): string {
  return readFileSync(fixturePath(relativePath), 'utf8');
}

export function validateFixture(relativePath: string): ValidationResult {
  return parseWorldSpec(fixtureSource(relativePath));
}

export function loadValidFixture(): WorldSpec {
  const result = validateFixture('valid/reference-mansion.worldspec.json');
  if (!result.valid) {
    throw new Error(
      `Valid test fixture failed validation:\n${formatDiagnostics(result.diagnostics)}`,
    );
  }

  return structuredClone(result.value);
}

export function findEntity(spec: WorldSpec, id: string): WorldSpec['entities'][number] {
  const entity = spec.entities.find((candidate) => candidate.id === id);
  if (entity === undefined) {
    throw new Error(`Fixture entity not found: ${id}`);
  }

  return entity;
}

export function diagnosticCodes(result: ValidationResult): readonly string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}
