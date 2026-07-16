import type { RobloxDiagnostic } from './diagnostics.js';
import type { RobloxAdapter, RobloxAdapterScope, RobloxChangeOperation } from './types.js';

export type RobloxTransactionPhase = 'forward' | 'compensation';

export interface RobloxOperationBatchContext {
  readonly changeSetHash: string;
  readonly phase: RobloxTransactionPhase;
  readonly batchIndex: number;
  readonly operationOffset: number;
}

export interface RobloxOperationBatchSuccess {
  readonly success: true;
  readonly operationsAttempted: number;
  readonly operationsApplied: number;
}

export interface RobloxOperationBatchCertainFailure {
  readonly success: false;
  readonly stateCertain: true;
  readonly operationsAttempted: number;
  readonly operationsApplied: number;
  readonly diagnostics: readonly RobloxDiagnostic[];
}

export type RobloxOperationBatchOutcome =
  | RobloxOperationBatchSuccess
  | RobloxOperationBatchCertainFailure;

/** Optional bounded multi-operation mutation surface; thrown failures are transport-uncertain. */
export interface RobloxOperationBatchAdapter extends RobloxAdapter {
  applyOperationBatch(
    scope: Readonly<RobloxAdapterScope>,
    operations: readonly Readonly<RobloxChangeOperation>[],
    context: Readonly<RobloxOperationBatchContext>,
  ): Promise<RobloxOperationBatchOutcome>;
}

export interface RobloxOperationBatchPlanInput {
  readonly changeSetHash: string;
  readonly phase: RobloxTransactionPhase;
  readonly operations: readonly Readonly<RobloxChangeOperation>[];
}

/**
 * The transport owns its byte-aware partitioning. The compiler verifies that the
 * returned non-empty batches flatten to the exact authorized operation sequence.
 */
export type RobloxOperationBatchPlanner = (
  input: Readonly<RobloxOperationBatchPlanInput>,
) => readonly (readonly Readonly<RobloxChangeOperation>[])[];
