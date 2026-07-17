import type { StudioViewportEvidence } from '../src/types.js';

export interface BatchLiveTransportReportHashes {
  readonly create: string;
  readonly noop: string;
  readonly update: string;
  readonly repair: string;
  readonly lostResponse: string;
}

export interface BatchLiveReceiptHashes {
  readonly applied: string;
  readonly noop: string;
  readonly lostResponseRollback: string;
}

export interface BatchLiveShareableSummaryInput {
  readonly placeId: number;
  readonly gameId: number;
  readonly authorizationEnvelopeHash: string;
  readonly createOperationCount: number;
  readonly createChunkCount: number;
  readonly createMutationExecuteCallCount: number;
  readonly createChangeSetHash: string;
  readonly createChunkIds: readonly string[];
  readonly expectedResultHash: string;
  readonly observedResultHash: string;
  readonly noOpChangeSetHash: string;
  readonly noOpMutationExecuteCallCount: number;
  readonly noOpSandboxLeaseClaimCallCount: number;
  readonly updateResultHash: string;
  readonly repairResultHash: string;
  readonly controlledResponseLossObservedHash: string;
  readonly observedProgressClassification: 'base' | 'prefix' | 'complete';
  readonly observedAppliedPrefixLength: number;
  readonly reconnectCount: number;
  readonly compensationAttempted: boolean;
  readonly compensationSucceeded: boolean;
  readonly restoredHash: string;
  readonly finalHash: string;
  readonly finalNoOpOperations: number;
  readonly transportReportHashes: Readonly<BatchLiveTransportReportHashes>;
  readonly receiptHashes: Readonly<BatchLiveReceiptHashes>;
  readonly viewportEvidence: Readonly<StudioViewportEvidence>;
}

export interface BatchLiveShareableSummary extends BatchLiveShareableSummaryInput {
  readonly schemaVersion: '0.1.0';
  readonly stoppedEditSandboxVerified: true;
  readonly exactStudioReselectedAfterUncertainty: true;
  readonly sandboxLeaseClaimed: true;
  readonly sandboxLeaseReverifiedAfterReconnect: true;
  readonly controlledResponseLossForwardFailed: true;
  readonly strictArtifactsValidated: true;
}

const FORBIDDEN_SUMMARY_KEYS = new Set([
  'studioId',
  'leaseId',
  'sandboxLeaseId',
  'leaseJson',
  'sandboxLeaseJson',
  'workspaceLease',
]);
const SANDBOX_LEASE_ATTRIBUTE_NAME = 'WorldwrightStudioSandboxLeaseJson';

export function assertBatchLiveShareableSummaryPrivacy(value: unknown): void {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (current.includes(SANDBOX_LEASE_ATTRIBUTE_NAME)) {
        throw new Error('Shareable live summary contains private sandbox lease metadata.');
      }
      continue;
    }
    if (typeof current !== 'object' || current === null || seen.has(current)) continue;
    seen.add(current);
    for (const [key, child] of Object.entries(current)) {
      if (FORBIDDEN_SUMMARY_KEYS.has(key)) {
        throw new Error('Shareable live summary contains a private identity field.');
      }
      pending.push(child);
    }
  }
}

export function buildBatchLiveShareableSummary(
  input: Readonly<BatchLiveShareableSummaryInput>,
): BatchLiveShareableSummary {
  const summary: BatchLiveShareableSummary = {
    schemaVersion: '0.1.0',
    placeId: input.placeId,
    gameId: input.gameId,
    stoppedEditSandboxVerified: true,
    exactStudioReselectedAfterUncertainty: true,
    sandboxLeaseClaimed: true,
    sandboxLeaseReverifiedAfterReconnect: true,
    authorizationEnvelopeHash: input.authorizationEnvelopeHash,
    createOperationCount: input.createOperationCount,
    createChunkCount: input.createChunkCount,
    createMutationExecuteCallCount: input.createMutationExecuteCallCount,
    createChangeSetHash: input.createChangeSetHash,
    createChunkIds: [...input.createChunkIds],
    expectedResultHash: input.expectedResultHash,
    observedResultHash: input.observedResultHash,
    noOpChangeSetHash: input.noOpChangeSetHash,
    noOpMutationExecuteCallCount: input.noOpMutationExecuteCallCount,
    noOpSandboxLeaseClaimCallCount: input.noOpSandboxLeaseClaimCallCount,
    updateResultHash: input.updateResultHash,
    repairResultHash: input.repairResultHash,
    controlledResponseLossForwardFailed: true,
    controlledResponseLossObservedHash: input.controlledResponseLossObservedHash,
    observedProgressClassification: input.observedProgressClassification,
    observedAppliedPrefixLength: input.observedAppliedPrefixLength,
    reconnectCount: input.reconnectCount,
    compensationAttempted: input.compensationAttempted,
    compensationSucceeded: input.compensationSucceeded,
    restoredHash: input.restoredHash,
    finalHash: input.finalHash,
    finalNoOpOperations: input.finalNoOpOperations,
    transportReportHashes: { ...input.transportReportHashes },
    receiptHashes: { ...input.receiptHashes },
    viewportEvidence: { ...input.viewportEvidence },
    strictArtifactsValidated: true,
  };
  assertBatchLiveShareableSummaryPrivacy(summary);
  return summary;
}
