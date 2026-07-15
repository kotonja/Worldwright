import { compareCodePoints } from './json.js';

export type ArchitectureDiagnosticSeverity = 'error' | 'warning';

export type ArchitectureDiagnosticCode =
  | 'json.invalid'
  | 'architecture.worldspec_invalid'
  | 'architecture.profile_invalid'
  | 'architecture.multiple_buildings'
  | 'architecture.directive_missing'
  | 'architecture.directive_invalid'
  | 'architecture.relationship_invalid'
  | 'architecture.reserved_id_conflict'
  | 'architecture.roblox_directive_conflict'
  | 'architecture.lock_unsupported'
  | 'architecture.constraint_unsupported'
  | 'architecture.constraint_unevaluated'
  | 'architecture.floor_invalid'
  | 'architecture.room_invalid'
  | 'architecture.stair_required'
  | 'architecture.grid_misaligned'
  | 'architecture.arithmetic_overflow'
  | 'architecture.capacity_exceeded'
  | 'architecture.infeasible'
  | 'architecture.required_adjacency_unsatisfied'
  | 'architecture.avoidance_violated'
  | 'architecture.preference_unsatisfied'
  | 'architecture.opening_infeasible'
  | 'architecture.stair_infeasible'
  | 'architecture.circulation_unreachable'
  | 'architecture.instance_budget_exceeded'
  | 'architecture.plan_invalid'
  | 'architecture.plan_stale'
  | 'architecture.generated_id_collision'
  | 'architecture.emission_invalid';

export interface ArchitectureDiagnostic {
  readonly code: ArchitectureDiagnosticCode;
  readonly severity: ArchitectureDiagnosticSeverity;
  readonly path: string;
  readonly message: string;
  readonly relatedId?: string;
}

export function architectureDiagnostic(
  code: ArchitectureDiagnosticCode,
  path: string,
  message: string,
  relatedId?: string,
  severity: ArchitectureDiagnosticSeverity = 'error',
): ArchitectureDiagnostic {
  return {
    code,
    severity,
    path,
    message,
    ...(relatedId === undefined ? {} : { relatedId }),
  };
}

/** Compatibility alias for concise internal call sites. */
export const diagnostic = architectureDiagnostic;

export function sortArchitectureDiagnostics(
  diagnostics: readonly ArchitectureDiagnostic[],
): ArchitectureDiagnostic[] {
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

export function hasArchitectureErrors(diagnostics: readonly ArchitectureDiagnostic[]): boolean {
  return diagnostics.some((entry) => entry.severity === 'error');
}

export function formatArchitectureDiagnostics(
  diagnostics: readonly ArchitectureDiagnostic[],
): string {
  return diagnostics
    .map((entry) => {
      const related = entry.relatedId === undefined ? '' : ` (related: ${entry.relatedId})`;
      return `${entry.severity.toUpperCase()} ${entry.code} ${entry.path || '/'}: ${entry.message}${related}`;
    })
    .join('\n');
}
