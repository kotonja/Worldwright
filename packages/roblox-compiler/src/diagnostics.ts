import { compareCodePoints } from './json.js';

export type RobloxDiagnosticSeverity = 'error' | 'warning';

export type RobloxDiagnosticCode =
  | 'json.invalid'
  | 'contract.schema_invalid'
  | 'contract.id_duplicate'
  | 'contract.parent_missing'
  | 'contract.parent_cycle'
  | 'contract.unreachable'
  | 'contract.root_invalid'
  | 'contract.metadata_invalid'
  | 'contract.measurements_invalid'
  | 'contract.operation_invalid'
  | 'compiler.worldspec_invalid'
  | 'compiler.directive_missing'
  | 'compiler.directive_invalid'
  | 'compiler.root_not_container'
  | 'compiler.primitive_has_children'
  | 'compiler.transform_missing'
  | 'compiler.bounds_missing'
  | 'compiler.size_invalid'
  | 'compiler.instance_budget_exceeded'
  | 'compiler.budget_not_evaluated'
  | 'plan.manifest_invalid'
  | 'plan.snapshot_invalid'
  | 'plan.project_mismatch'
  | 'plan.target_mismatch'
  | 'plan.root_change_unsupported'
  | 'plan.class_change_unsupported'
  | 'plan.unmanaged_descendant_conflict'
  | 'plan.simulation_failed'
  | 'simulation.snapshot_invalid'
  | 'simulation.change_set_invalid'
  | 'simulation.project_mismatch'
  | 'simulation.target_mismatch'
  | 'simulation.stale_snapshot'
  | 'simulation.before_state_mismatch'
  | 'simulation.operation_order_invalid'
  | 'simulation.parent_missing'
  | 'simulation.parent_cycle'
  | 'simulation.desired_manifest_invalid'
  | 'simulation.desired_manifest_hash_mismatch'
  | 'simulation.result_hash_mismatch'
  | 'simulation.unmanaged_descendant_conflict'
  | 'progress.base_snapshot_invalid'
  | 'progress.observed_snapshot_invalid'
  | 'progress.change_set_invalid'
  | 'progress.base_hash_mismatch'
  | 'progress.project_mismatch'
  | 'progress.target_mismatch'
  | 'progress.unmanaged_changed'
  | 'progress.not_exact_prefix'
  | 'progress.operation_precondition_invalid'
  | 'transaction.change_set_invalid'
  | 'transaction.snapshot_invalid'
  | 'transaction.stale_snapshot'
  | 'transaction.preflight_failed'
  | 'transaction.apply_failed'
  | 'transaction.verification_failed'
  | 'transaction.rollback_failed'
  | 'transaction.rollback_unsafe_observed_state';

export interface RobloxDiagnostic {
  readonly code: RobloxDiagnosticCode;
  readonly severity: RobloxDiagnosticSeverity;
  readonly path: string;
  readonly message: string;
  readonly relatedId?: string;
}

export function diagnostic(
  code: RobloxDiagnosticCode,
  path: string,
  message: string,
  relatedId?: string,
  severity: RobloxDiagnosticSeverity = 'error',
): RobloxDiagnostic {
  return {
    code,
    severity,
    path,
    message,
    ...(relatedId === undefined ? {} : { relatedId }),
  };
}

export function sortDiagnostics(diagnostics: readonly RobloxDiagnostic[]): RobloxDiagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const byPath = compareCodePoints(left.path, right.path);
    if (byPath !== 0) return byPath;
    const byCode = compareCodePoints(left.code, right.code);
    if (byCode !== 0) return byCode;
    const bySeverity = compareCodePoints(left.severity, right.severity);
    if (bySeverity !== 0) return bySeverity;
    const byMessage = compareCodePoints(left.message, right.message);
    if (byMessage !== 0) return byMessage;
    return compareCodePoints(left.relatedId ?? '', right.relatedId ?? '');
  });
}

export function hasErrorDiagnostics(diagnostics: readonly RobloxDiagnostic[]): boolean {
  return diagnostics.some((entry) => entry.severity === 'error');
}

export function formatRobloxDiagnostics(diagnostics: readonly RobloxDiagnostic[]): string {
  return diagnostics
    .map((entry) => {
      const related = entry.relatedId === undefined ? '' : ` (related: ${entry.relatedId})`;
      return `${entry.severity.toUpperCase()} ${entry.code} ${entry.path || '/'}: ${entry.message}${related}`;
    })
    .join('\n');
}
