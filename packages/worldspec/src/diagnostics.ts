import type { WorldSpec } from './types.js';

export type DiagnosticSeverity = 'error' | 'warning';

export type DiagnosticCode =
  | 'json.invalid'
  | 'schema.invalid'
  | 'id.duplicate'
  | 'entity.root_missing'
  | 'entity.root_wrong_kind'
  | 'entity.root_has_parent'
  | 'entity.parent_missing'
  | 'entity.parent_self'
  | 'entity.parent_cycle'
  | 'entity.unreachable'
  | 'reference.missing'
  | 'relationship.endpoint_missing'
  | 'relationship.self'
  | 'constraint.entity_missing'
  | 'lock.entity_missing'
  | 'lock.path_empty';

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly path: string;
  readonly message: string;
  readonly relatedId?: string;
}

export interface ValidationSuccess {
  readonly valid: true;
  readonly value: WorldSpec;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ValidationFailure {
  readonly valid: false;
  readonly diagnostics: readonly Diagnostic[];
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map((diagnostic) => {
      const related =
        diagnostic.relatedId === undefined ? '' : ` (related: ${diagnostic.relatedId})`;
      const path = diagnostic.path === '' ? '/' : diagnostic.path;
      return `${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${path}: ${diagnostic.message}${related}`;
    })
    .join('\n');
}
