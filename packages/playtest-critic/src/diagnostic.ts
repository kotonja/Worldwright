import { compareCodePoints } from './json.js';

export type PlaytestDiagnosticCode =
  | 'json.invalid'
  | 'playtest.architecture_plan_invalid'
  | 'playtest.manifest_invalid'
  | 'playtest.source_project_mismatch'
  | 'playtest.source_hash_mismatch'
  | 'playtest.source_root_mismatch'
  | 'playtest.manifest_structure_mismatch'
  | 'playtest.semantic_node_missing'
  | 'playtest.geometry_missing'
  | 'playtest.checkpoint_infeasible'
  | 'playtest.generated_id_collision'
  | 'playtest.route_disconnected'
  | 'playtest.limit_exceeded'
  | 'playtest.plan_invalid'
  | 'playtest.plan_stale'
  | 'playtest.run_report_invalid'
  | 'playtest.run_source_mismatch'
  | 'playtest.critic_report_invalid'
  | 'playtest.evaluation_source_mismatch';

export interface PlaytestDiagnostic {
  readonly code: PlaytestDiagnosticCode;
  readonly path: string;
  readonly message: string;
  readonly sourceId?: string;
}

export function playtestDiagnostic(
  code: PlaytestDiagnosticCode,
  path: string,
  message: string,
  sourceId?: string,
): PlaytestDiagnostic {
  return { code, path, message, ...(sourceId === undefined ? {} : { sourceId }) };
}

export function sortPlaytestDiagnostics(
  diagnostics: readonly PlaytestDiagnostic[],
): readonly PlaytestDiagnostic[] {
  return [...diagnostics].sort(
    (left, right) =>
      compareCodePoints(left.path, right.path) ||
      compareCodePoints(left.code, right.code) ||
      compareCodePoints(left.sourceId ?? '', right.sourceId ?? '') ||
      compareCodePoints(left.message, right.message),
  );
}

export type PlaytestValidationResult<T> =
  | { readonly valid: true; readonly value: T; readonly diagnostics: readonly PlaytestDiagnostic[] }
  | { readonly valid: false; readonly diagnostics: readonly PlaytestDiagnostic[] };
