import { compareCodePoints } from './diagnostics.js';
import { canonicalizeJsonValue, stringifyCanonicalJson, type JsonValue } from './json.js';
import type {
  StudioApplyReceipt,
  StudioBridgeManagedNode,
  StudioBridgeRequest,
  StudioBridgeResponse,
  StudioReceiptDiagnostic,
  StudioRollbackResult,
} from './types.js';

function canonicalClone<T>(value: T): T {
  return canonicalizeJsonValue(value as unknown as JsonValue) as unknown as T;
}

function compareReceiptDiagnostics(
  left: Readonly<StudioReceiptDiagnostic>,
  right: Readonly<StudioReceiptDiagnostic>,
): number {
  return (
    compareCodePoints(left.code, right.code) ||
    compareCodePoints(left.severity, right.severity) ||
    compareCodePoints(left.path, right.path) ||
    compareCodePoints(left.relatedId ?? '', right.relatedId ?? '') ||
    compareCodePoints(left.message, right.message)
  );
}

function normalizeDiagnostics(
  diagnostics: readonly StudioReceiptDiagnostic[],
): StudioReceiptDiagnostic[] {
  return diagnostics.map((entry) => canonicalClone(entry)).sort(compareReceiptDiagnostics);
}

function normalizeRollback(rollback: Readonly<StudioRollbackResult>): StudioRollbackResult {
  if (!rollback.attempted) return { attempted: false, succeeded: false };
  if (rollback.succeeded) {
    return {
      attempted: true,
      succeeded: true,
      restoredSnapshotHash: rollback.restoredSnapshotHash,
    };
  }
  return {
    attempted: true,
    succeeded: false,
    diagnostics: normalizeDiagnostics(rollback.diagnostics),
    ...(rollback.observedAfterRollbackSnapshotHash === undefined
      ? {}
      : { observedAfterRollbackSnapshotHash: rollback.observedAfterRollbackSnapshotHash }),
  };
}

export function normalizeStudioBridgeManagedNode(
  node: Readonly<StudioBridgeManagedNode>,
): StudioBridgeManagedNode {
  return canonicalClone(node);
}

export function normalizeStudioBridgeRequest(
  request: Readonly<StudioBridgeRequest>,
): StudioBridgeRequest {
  return canonicalClone(request);
}

export function normalizeStudioBridgeResponse(
  response: Readonly<StudioBridgeResponse>,
): StudioBridgeResponse {
  return canonicalClone(response);
}

export function normalizeStudioApplyReceipt(
  receipt: Readonly<StudioApplyReceipt>,
): StudioApplyReceipt {
  const common = {
    schemaVersion: receipt.schemaVersion,
    adapterVersion: receipt.adapterVersion,
    studio: canonicalClone(receipt.studio),
    projectId: receipt.projectId,
    target: { service: 'Workspace' as const },
    changeSetHash: receipt.changeSetHash,
    baseSnapshotHash: receipt.baseSnapshotHash,
    desiredManifestHash: receipt.desiredManifestHash,
    expectedResultSnapshotHash: receipt.expectedResultSnapshotHash,
    operationsPlanned: receipt.operationsPlanned,
    operationsAttempted: receipt.operationsAttempted,
    diagnostics: normalizeDiagnostics(receipt.diagnostics),
    ...(receipt.viewportEvidence === undefined
      ? {}
      : { viewportEvidence: canonicalClone(receipt.viewportEvidence) }),
  };
  switch (receipt.status) {
    case 'applied':
      return {
        ...common,
        status: 'applied',
        finalSnapshotHash: receipt.finalSnapshotHash,
      };
    case 'noop':
      return {
        ...common,
        status: 'noop',
        finalSnapshotHash: receipt.finalSnapshotHash,
      };
    case 'failed':
      return {
        ...common,
        status: 'failed',
        transactionStage: receipt.transactionStage,
        rollback: normalizeRollback(receipt.rollback),
        ...(receipt.observedFailureSnapshotHash === undefined
          ? {}
          : { observedFailureSnapshotHash: receipt.observedFailureSnapshotHash }),
        ...(receipt.finalSnapshotHash === undefined
          ? {}
          : { finalSnapshotHash: receipt.finalSnapshotHash }),
      };
  }
}

export function stringifyStudioBridgeRequest(request: Readonly<StudioBridgeRequest>): string {
  return stringifyCanonicalJson(normalizeStudioBridgeRequest(request) as JsonValue);
}

export function stringifyStudioBridgeResponse(response: Readonly<StudioBridgeResponse>): string {
  return stringifyCanonicalJson(normalizeStudioBridgeResponse(response) as JsonValue);
}

export function stringifyStudioApplyReceipt(receipt: Readonly<StudioApplyReceipt>): string {
  return stringifyCanonicalJson(normalizeStudioApplyReceipt(receipt) as JsonValue);
}

export function stringifyStudioManagedNodeState(node: Readonly<StudioBridgeManagedNode>): string {
  return stringifyCanonicalJson(normalizeStudioBridgeManagedNode(node) as JsonValue);
}
