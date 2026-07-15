export { WORLD_SPEC_SCHEMA_ID, WORLD_SPEC_VERSION, WorldSpecSchema } from './schema.js';
export type { JsonValue } from './schema.js';

export { formatDiagnostics } from './diagnostics.js';
export type {
  Diagnostic,
  DiagnosticCode,
  DiagnosticSeverity,
  ValidationFailure,
  ValidationResult,
  ValidationSuccess,
} from './diagnostics.js';

export { normalizeWorldSpec, stringifyWorldSpec } from './normalize.js';
export { parseWorldSpec, validateWorldSpec } from './validate.js';

export type {
  Bounds,
  Intent,
  Project,
  Provenance,
  StyleDna,
  Transform,
  WorldBudgets,
  WorldConstraint,
  WorldEntity,
  WorldLock,
  WorldReference,
  WorldRelationship,
  WorldSpec,
} from './types.js';
