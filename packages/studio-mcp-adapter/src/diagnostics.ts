/** Frozen compatibility set used by the already-published Studio Bridge 0.1 schemas. */
export const STUDIO_BRIDGE_V0_1_DIAGNOSTIC_CODES = [
  'studio.mcp_start_failed',
  'studio.mcp_handshake_failed',
  'studio.tool_missing',
  'studio.tool_schema_unsupported',
  'studio.tool_call_failed',
  'studio.tool_timeout',
  'studio.response_invalid',
  'studio.response_too_large',
  'studio.session_not_found',
  'studio.session_ambiguous',
  'studio.edit_mode_required',
  'studio.published_place_forbidden',
  'studio.project_mismatch',
  'studio.node_limit_exceeded',
  'studio.operation_limit_exceeded',
  'studio.payload_too_large',
  'studio.identity_invalid',
  'studio.root_invalid',
  'studio.hierarchy_invalid',
  'studio.class_unsupported',
  'studio.property_invalid',
  'studio.adapter_metadata_invalid',
  'studio.adapter_metadata_too_large',
  'studio.engine_state_drift',
  'studio.unmanaged_content_protected',
  'studio.foreign_project_protected',
  'studio.create_failed',
  'studio.create_cleanup_failed',
  'studio.update_failed',
  'studio.update_restore_failed',
  'studio.delete_failed',
  'studio.snapshot_invalid',
  'studio.transaction_failed',
  'studio.capture_unavailable',
  'studio.capture_invalid',
  'studio.receipt_invalid',
  'studio.io_failed',
  'studio.usage_invalid',
] as const;

export type StudioBridgeV01DiagnosticCode = (typeof STUDIO_BRIDGE_V0_1_DIAGNOSTIC_CODES)[number];

/** Frozen diagnostic set serialized by the published additive Milestone 4 protocols. */
export const STUDIO_PROTOCOL_V0_1_DIAGNOSTIC_CODES = [
  ...STUDIO_BRIDGE_V0_1_DIAGNOSTIC_CODES,
  'studio.sandbox_lease_conflict',
  'studio.sandbox_lease_invalid',
  'studio.sandbox_identity_mismatch',
] as const;

export type StudioProtocolV01DiagnosticCode =
  (typeof STUDIO_PROTOCOL_V0_1_DIAGNOSTIC_CODES)[number];

/** Host diagnostics include additive behavior without widening published wire schemas. */
export const STUDIO_DIAGNOSTIC_CODES = [
  ...STUDIO_PROTOCOL_V0_1_DIAGNOSTIC_CODES,
  'studio.playtest_capability_unavailable',
  'studio.playtest_identity_mismatch',
  'studio.playtest_character_unavailable',
  'studio.playtest_path_failed',
  'studio.playtest_clearance_failed',
  'studio.playtest_state_invalid',
  'studio.playtest_start_uncertain',
  'studio.playtest_navigation_uncertain',
  'studio.playtest_stop_uncertain',
  'studio.playtest_console_incomplete',
  'studio.playtest_probe_invalid',
] as const;

export type StudioDiagnosticCode = (typeof STUDIO_DIAGNOSTIC_CODES)[number];
export type StudioDiagnosticSeverity = 'error' | 'warning';

export interface StudioDiagnostic {
  readonly code: StudioDiagnosticCode;
  readonly severity: StudioDiagnosticSeverity;
  readonly path: string;
  readonly message: string;
  readonly relatedId?: string;
  readonly toolName?: string;
}

export function studioDiagnostic(
  code: StudioDiagnosticCode,
  path: string,
  message: string,
  options: Readonly<{
    severity?: StudioDiagnosticSeverity;
    relatedId?: string;
    toolName?: string;
  }> = {},
): StudioDiagnostic {
  return {
    code,
    severity: options.severity ?? 'error',
    path,
    message,
    ...(options.relatedId === undefined ? {} : { relatedId: options.relatedId }),
    ...(options.toolName === undefined ? {} : { toolName: options.toolName }),
  };
}

export function compareCodePoints(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCodePoint = left.codePointAt(leftIndex)!;
    const rightCodePoint = right.codePointAt(rightIndex)!;
    if (leftCodePoint < rightCodePoint) return -1;
    if (leftCodePoint > rightCodePoint) return 1;
    leftIndex += leftCodePoint > 0xffff ? 2 : 1;
    rightIndex += rightCodePoint > 0xffff ? 2 : 1;
  }
  if (leftIndex < left.length) return 1;
  if (rightIndex < right.length) return -1;
  return 0;
}

export function sortStudioDiagnostics(
  diagnostics: readonly StudioDiagnostic[],
): StudioDiagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const codeOrder = compareCodePoints(left.code, right.code);
    if (codeOrder !== 0) return codeOrder;
    const pathOrder = compareCodePoints(left.path, right.path);
    if (pathOrder !== 0) return pathOrder;
    const severityOrder = compareCodePoints(left.severity, right.severity);
    if (severityOrder !== 0) return severityOrder;
    const relatedOrder = compareCodePoints(left.relatedId ?? '', right.relatedId ?? '');
    if (relatedOrder !== 0) return relatedOrder;
    const toolOrder = compareCodePoints(left.toolName ?? '', right.toolName ?? '');
    if (toolOrder !== 0) return toolOrder;
    return compareCodePoints(left.message, right.message);
  });
}

export class StudioAdapterError extends Error {
  public readonly diagnostics: readonly StudioDiagnostic[];

  public constructor(diagnostics: readonly StudioDiagnostic[]) {
    super(diagnostics[0]?.message ?? 'Roblox Studio adapter operation failed.');
    this.name = 'StudioAdapterError';
    this.diagnostics = sortStudioDiagnostics(diagnostics);
  }
}

export function sanitizedErrorMessage(error: unknown): string {
  if (error instanceof StudioAdapterError) return error.message;
  if (error instanceof Error && error.name === 'AbortError') return 'The operation timed out.';
  return 'The local Studio operation failed.';
}
