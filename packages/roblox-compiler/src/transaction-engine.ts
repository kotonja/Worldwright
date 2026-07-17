import type {
  RobloxOperationBatchContext,
  RobloxOperationBatchOutcome,
  RobloxOperationBatchPlanner,
  RobloxTransactionPhase,
} from './batch-adapter.js';
import { validateRobloxChangeSet, validateRobloxSnapshot } from './contract-validation.js';
import { deepFreeze } from './deep-freeze.js';
import { diagnostic, sortDiagnostics, type RobloxDiagnostic } from './diagnostics.js';
import { compareCodePoints, jsonValuesEqual } from './json.js';
import {
  hashRobloxChangeSet,
  hashRobloxSnapshot,
  normalizeRobloxChangeSet,
  normalizeRobloxSnapshot,
} from './normalize.js';
import { classifyRobloxChangeSetProgress } from './progress.js';
import { planRobloxSnapshotTransition } from './reconcile.js';
import { simulateRobloxChangeSet } from './simulate.js';
import type {
  ApplyFailure,
  ApplyFailureStage,
  ApplyResult,
  RobloxAdapter,
  RobloxAdapterScope,
  RobloxChangeOperation,
  RobloxChangeSet,
  RobloxMutationPreparationHook,
  RobloxSnapshot,
  RollbackResult,
} from './types.js';

export interface RobloxTransactionOperationStrategy {
  readonly maxCompensationRecoveryAttempts: number;
  readonly prepareForMutation?: RobloxMutationPreparationHook;
  planBatches(
    operations: readonly Readonly<RobloxChangeOperation>[],
    changeSetHash: string,
    phase: RobloxTransactionPhase,
  ): readonly (readonly Readonly<RobloxChangeOperation>[])[];
  applyBatch(
    scope: Readonly<RobloxAdapterScope>,
    operations: readonly Readonly<RobloxChangeOperation>[],
    context: Readonly<RobloxOperationBatchContext>,
  ): Promise<RobloxOperationBatchOutcome>;
}

function rollbackNotAttempted(): RollbackResult {
  return { attempted: false, succeeded: false };
}

function transactionDiagnostic(
  code:
    | 'transaction.change_set_invalid'
    | 'transaction.snapshot_invalid'
    | 'transaction.stale_snapshot'
    | 'transaction.preflight_failed'
    | 'transaction.apply_failed'
    | 'transaction.verification_failed'
    | 'transaction.rollback_failed'
    | 'transaction.rollback_unsafe_observed_state',
  path: string,
  message: string,
  relatedId?: string,
): RobloxDiagnostic[] {
  return [diagnostic(code, path, message, relatedId)];
}

function failure(
  stage: ApplyFailureStage,
  diagnostics: readonly RobloxDiagnostic[],
  operationsAttempted: number,
  rollback: RollbackResult,
  initialSnapshotHash?: string,
  observedFailureSnapshotHash?: string,
): ApplyFailure {
  return {
    success: false,
    stage,
    diagnostics,
    operationsAttempted,
    rollback,
    ...(initialSnapshotHash === undefined ? {} : { initialSnapshotHash }),
    ...(observedFailureSnapshotHash === undefined ? {} : { observedFailureSnapshotHash }),
  };
}

function wrapDiagnostics(
  code:
    | 'transaction.change_set_invalid'
    | 'transaction.snapshot_invalid'
    | 'transaction.preflight_failed'
    | 'transaction.verification_failed'
    | 'transaction.rollback_failed',
  diagnostics: readonly RobloxDiagnostic[],
): RobloxDiagnostic[] {
  return sortDiagnostics(
    diagnostics.map((entry) =>
      diagnostic(code, entry.path, `${entry.code}: ${entry.message}`, entry.relatedId),
    ),
  );
}

interface RollbackAttempt {
  readonly result: RollbackResult;
  readonly observedFailureSnapshotHash?: string;
}

function rollbackValidationFailure(
  diagnostics: readonly RobloxDiagnostic[],
  observedFailureSnapshotHash?: string,
): RollbackAttempt {
  return {
    result: {
      attempted: true,
      succeeded: false,
      diagnostics: wrapDiagnostics('transaction.rollback_failed', diagnostics),
    },
    ...(observedFailureSnapshotHash === undefined ? {} : { observedFailureSnapshotHash }),
  };
}

function rollbackFailure(
  code: 'transaction.rollback_failed' | 'transaction.rollback_unsafe_observed_state',
  message: string,
  observedFailureSnapshotHash?: string,
  observedAfterRollbackSnapshotHash?: string,
  path = '',
  relatedId?: string,
): RollbackAttempt {
  return {
    result: {
      attempted: true,
      succeeded: false,
      diagnostics: transactionDiagnostic(code, path, message, relatedId),
      ...(observedAfterRollbackSnapshotHash === undefined
        ? {}
        : { observedAfterRollbackSnapshotHash }),
    },
    ...(observedFailureSnapshotHash === undefined ? {} : { observedFailureSnapshotHash }),
  };
}

async function readValidatedSnapshotHash(
  adapter: RobloxAdapter,
  scope: Readonly<RobloxAdapterScope>,
): Promise<string | undefined> {
  try {
    const validation = validateRobloxSnapshot(await adapter.readSnapshot(scope));
    return validation.valid
      ? hashRobloxSnapshot(normalizeRobloxSnapshot(validation.value))
      : undefined;
  } catch {
    return undefined;
  }
}

function exactBatches(
  strategy: Readonly<RobloxTransactionOperationStrategy>,
  operations: readonly Readonly<RobloxChangeOperation>[],
  changeSetHash: string,
  phase: RobloxTransactionPhase,
): readonly (readonly Readonly<RobloxChangeOperation>[])[] | undefined {
  let planned: readonly (readonly Readonly<RobloxChangeOperation>[])[];
  try {
    planned = strategy.planBatches(deepFreeze(structuredClone(operations)), changeSetHash, phase);
  } catch {
    return undefined;
  }
  if (!Array.isArray(planned)) return undefined;
  const flattened: Readonly<RobloxChangeOperation>[] = [];
  const authorizedBatches: Readonly<RobloxChangeOperation>[][] = [];
  let operationOffset = 0;
  for (const batch of planned) {
    if (!Array.isArray(batch) || batch.length === 0) return undefined;
    flattened.push(...batch);
    authorizedBatches.push(operations.slice(operationOffset, operationOffset + batch.length));
    operationOffset += batch.length;
  }
  return jsonValuesEqual(flattened, operations) ? authorizedBatches : undefined;
}

function validBatchOutcome(
  outcome: Readonly<RobloxOperationBatchOutcome>,
  submittedCount: number,
): boolean {
  if (
    !Number.isSafeInteger(outcome.operationsAttempted) ||
    !Number.isSafeInteger(outcome.operationsApplied) ||
    outcome.operationsAttempted < 0 ||
    outcome.operationsApplied < 0 ||
    outcome.operationsApplied > outcome.operationsAttempted ||
    outcome.operationsAttempted > submittedCount
  ) {
    return false;
  }
  if (outcome.success) {
    return (
      outcome.operationsAttempted === submittedCount && outcome.operationsApplied === submittedCount
    );
  }
  return outcome.stateCertain === true && Array.isArray(outcome.diagnostics);
}

interface OperationSequenceSuccess {
  readonly success: true;
  readonly operationsAttempted: number;
}

interface OperationSequenceFailure {
  readonly success: false;
  readonly uncertain: boolean;
  readonly planningFailed: boolean;
  readonly operationsAttempted: number;
  readonly failedOperationIndex: number;
  readonly failedOperationId?: string;
}

type OperationSequenceResult = OperationSequenceSuccess | OperationSequenceFailure;

async function executeOperationSequence(
  strategy: Readonly<RobloxTransactionOperationStrategy>,
  scope: Readonly<RobloxAdapterScope>,
  operations: readonly Readonly<RobloxChangeOperation>[],
  changeSetHash: string,
  phase: RobloxTransactionPhase,
): Promise<OperationSequenceResult> {
  const batches = exactBatches(strategy, operations, changeSetHash, phase);
  if (batches === undefined) {
    return {
      success: false,
      uncertain: false,
      planningFailed: true,
      operationsAttempted: 0,
      failedOperationIndex: 0,
    };
  }

  let operationOffset = 0;
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex]!;
    const context: RobloxOperationBatchContext = {
      changeSetHash,
      phase,
      batchIndex,
      operationOffset,
    };
    let outcome: RobloxOperationBatchOutcome;
    try {
      outcome = await strategy.applyBatch(scope, batch, context);
    } catch {
      return {
        success: false,
        uncertain: true,
        planningFailed: false,
        operationsAttempted: operationOffset + batch.length,
        failedOperationIndex: operationOffset,
        ...(batch[0] === undefined ? {} : { failedOperationId: batch[0].id }),
      };
    }
    if (!validBatchOutcome(outcome, batch.length)) {
      return {
        success: false,
        uncertain: true,
        planningFailed: false,
        operationsAttempted: operationOffset + batch.length,
        failedOperationIndex: operationOffset,
        ...(batch[0] === undefined ? {} : { failedOperationId: batch[0].id }),
      };
    }
    if (!outcome.success) {
      const attemptedWithinBatch = outcome.operationsAttempted;
      const failedWithinBatch =
        attemptedWithinBatch === 0 ? 0 : Math.min(attemptedWithinBatch - 1, batch.length - 1);
      const failedOperation = batch[failedWithinBatch];
      return {
        success: false,
        uncertain: false,
        planningFailed: false,
        operationsAttempted: operationOffset + attemptedWithinBatch,
        failedOperationIndex: operationOffset + failedWithinBatch,
        ...(failedOperation === undefined ? {} : { failedOperationId: failedOperation.id }),
      };
    }
    operationOffset += batch.length;
  }
  return { success: true, operationsAttempted: operationOffset };
}

function unsafeProgressRollback(
  diagnostics: readonly RobloxDiagnostic[],
  observedFailureSnapshotHash?: string,
): RollbackAttempt {
  return {
    result: {
      attempted: true,
      succeeded: false,
      diagnostics: sortDiagnostics(
        diagnostics.map((entry) =>
          diagnostic(
            'transaction.rollback_unsafe_observed_state',
            entry.path,
            `${entry.code}: ${entry.message}`,
            entry.relatedId,
          ),
        ),
      ),
    },
    ...(observedFailureSnapshotHash === undefined ? {} : { observedFailureSnapshotHash }),
  };
}

interface ObservedProgress {
  readonly snapshot: RobloxSnapshot;
  readonly snapshotHash: string;
  readonly appliedPrefixLength: number;
}

function inverseOperation(operation: Readonly<RobloxChangeOperation>): RobloxChangeOperation {
  switch (operation.type) {
    case 'create':
      return { id: `delete:${operation.node.id}`, type: 'delete', before: operation.node };
    case 'update':
      return {
        id: operation.id,
        type: 'update',
        before: operation.after,
        after: operation.before,
      };
    case 'delete':
      return { id: `create:${operation.before.id}`, type: 'create', node: operation.before };
  }
}

function exactReversePrefixCompensation(
  changeSet: Readonly<RobloxChangeSet>,
  appliedPrefixLength: number,
  plannedOperations: readonly Readonly<RobloxChangeOperation>[],
): readonly RobloxChangeOperation[] | undefined {
  const inverse = changeSet.operations
    .slice(0, appliedPrefixLength)
    .reverse()
    .map((operation) => inverseOperation(operation));
  const byId = (operations: readonly Readonly<RobloxChangeOperation>[]) =>
    [...operations].sort((left, right) => compareCodePoints(left.id, right.id));
  return jsonValuesEqual(byId(inverse), byId(plannedOperations)) ? inverse : undefined;
}

function classifyObservedProgress(
  initialSnapshot: Readonly<RobloxSnapshot>,
  observed: Readonly<RobloxSnapshot>,
  changeSet: Readonly<RobloxChangeSet>,
):
  | { readonly success: true; readonly value: ObservedProgress }
  | { readonly success: false; readonly rollback: RollbackAttempt } {
  const progress = classifyRobloxChangeSetProgress(initialSnapshot, observed, changeSet);
  if (!progress.success) {
    return {
      success: false,
      rollback: unsafeProgressRollback(progress.diagnostics, progress.observedSnapshotHash),
    };
  }
  return {
    success: true,
    value: {
      snapshot: normalizeRobloxSnapshot(observed),
      snapshotHash: progress.observedSnapshotHash,
      appliedPrefixLength: progress.appliedPrefixLength,
    },
  };
}

async function readObservedProgress(
  adapter: RobloxAdapter,
  scope: Readonly<RobloxAdapterScope>,
  initialSnapshot: Readonly<RobloxSnapshot>,
  changeSet: Readonly<RobloxChangeSet>,
): Promise<
  | { readonly success: true; readonly value: ObservedProgress }
  | { readonly success: false; readonly rollback: RollbackAttempt }
> {
  let rawObserved: unknown;
  try {
    rawObserved = await adapter.readSnapshot(scope);
  } catch {
    return {
      success: false,
      rollback: rollbackFailure(
        'transaction.rollback_failed',
        'Rollback could not read observable adapter state.',
      ),
    };
  }
  const validation = validateRobloxSnapshot(rawObserved);
  if (!validation.valid) {
    return { success: false, rollback: rollbackValidationFailure(validation.diagnostics) };
  }
  return classifyObservedProgress(
    initialSnapshot,
    normalizeRobloxSnapshot(validation.value),
    changeSet,
  );
}

async function verifyRestoredSnapshot(
  adapter: RobloxAdapter,
  scope: Readonly<RobloxAdapterScope>,
  initialSnapshotHash: string,
  observedFailureSnapshotHash: string,
): Promise<RollbackAttempt> {
  let rawRestored: unknown;
  try {
    rawRestored = await adapter.readSnapshot(scope);
  } catch {
    return rollbackFailure(
      'transaction.rollback_failed',
      'Rollback could not read state for restoration verification.',
      observedFailureSnapshotHash,
    );
  }
  const validation = validateRobloxSnapshot(rawRestored);
  if (!validation.valid) {
    return rollbackValidationFailure(validation.diagnostics, observedFailureSnapshotHash);
  }
  const restoredSnapshotHash = hashRobloxSnapshot(normalizeRobloxSnapshot(validation.value));
  if (restoredSnapshotHash !== initialSnapshotHash) {
    return rollbackFailure(
      'transaction.rollback_failed',
      'Rollback did not restore the complete initial snapshot hash.',
      observedFailureSnapshotHash,
      restoredSnapshotHash,
    );
  }
  return {
    result: { attempted: true, succeeded: true, restoredSnapshotHash },
    observedFailureSnapshotHash,
  };
}

/** Observation-gated compensation. Every replan starts from a fresh exact forward prefix. */
async function compensateToInitialSnapshot(
  adapter: RobloxAdapter,
  strategy: Readonly<RobloxTransactionOperationStrategy>,
  scope: Readonly<RobloxAdapterScope>,
  initialSnapshot: Readonly<RobloxSnapshot>,
  initialSnapshotHash: string,
  changeSet: Readonly<RobloxChangeSet>,
  changeSetHash: string,
  attemptedOperationEnvelope: number,
): Promise<RollbackAttempt> {
  const initialObservation = await readObservedProgress(adapter, scope, initialSnapshot, changeSet);
  if (!initialObservation.success) return initialObservation.rollback;
  const observedFailureSnapshotHash = initialObservation.value.snapshotHash;
  if (initialObservation.value.appliedPrefixLength > attemptedOperationEnvelope) {
    return rollbackFailure(
      'transaction.rollback_unsafe_observed_state',
      'Observed exact progress exceeds the conservative attempted-operation envelope.',
      observedFailureSnapshotHash,
      undefined,
      '/operations',
    );
  }

  let current = initialObservation.value;
  let recoveryAttemptsRemaining = strategy.maxCompensationRecoveryAttempts;
  while (true) {
    const transition = planRobloxSnapshotTransition(current.snapshot, initialSnapshot);
    if (!transition.success) {
      return rollbackFailure(
        'transaction.rollback_failed',
        'Rollback could not plan a safe compensating transition.',
        observedFailureSnapshotHash,
      );
    }
    const compensationOperations = exactReversePrefixCompensation(
      changeSet,
      current.appliedPrefixLength,
      transition.operations,
    );
    if (compensationOperations === undefined) {
      return rollbackFailure(
        'transaction.rollback_failed',
        'Rollback inverse operations did not match the safe compensating transition.',
        observedFailureSnapshotHash,
      );
    }
    const compensation = await executeOperationSequence(
      strategy,
      scope,
      compensationOperations,
      changeSetHash,
      'compensation',
    );
    if (compensation.success) {
      return verifyRestoredSnapshot(
        adapter,
        scope,
        initialSnapshotHash,
        observedFailureSnapshotHash,
      );
    }
    if (compensation.planningFailed) {
      return rollbackFailure(
        'transaction.rollback_failed',
        'Rollback could not create exact compensating operation batches.',
        observedFailureSnapshotHash,
      );
    }
    if (!compensation.uncertain || recoveryAttemptsRemaining === 0) {
      return rollbackFailure(
        'transaction.rollback_failed',
        'A compensating adapter operation failed.',
        observedFailureSnapshotHash,
        await readValidatedSnapshotHash(adapter, scope),
      );
    }

    recoveryAttemptsRemaining -= 1;
    const minimumRemainingPrefix = Math.max(
      0,
      current.appliedPrefixLength - compensation.operationsAttempted,
    );
    const maximumRemainingPrefix = current.appliedPrefixLength - compensation.failedOperationIndex;
    const recoveryObservation = await readObservedProgress(
      adapter,
      scope,
      initialSnapshot,
      changeSet,
    );
    if (!recoveryObservation.success) {
      return {
        result: recoveryObservation.rollback.result,
        observedFailureSnapshotHash,
      };
    }
    if (
      recoveryObservation.value.appliedPrefixLength < minimumRemainingPrefix ||
      recoveryObservation.value.appliedPrefixLength > maximumRemainingPrefix
    ) {
      return rollbackFailure(
        'transaction.rollback_unsafe_observed_state',
        'Observed state is outside the causal prefix envelope of the uncertain compensation.',
        observedFailureSnapshotHash,
        recoveryObservation.value.snapshotHash,
        '/operations',
      );
    }
    if (recoveryObservation.value.snapshotHash === initialSnapshotHash) {
      return {
        result: {
          attempted: true,
          succeeded: true,
          restoredSnapshotHash: initialSnapshotHash,
        },
        observedFailureSnapshotHash,
      };
    }
    if (recoveryObservation.value.appliedPrefixLength === current.appliedPrefixLength) {
      return rollbackFailure(
        'transaction.rollback_failed',
        'Uncertain compensation made no observable progress; its chunk will not be retransmitted.',
        observedFailureSnapshotHash,
        recoveryObservation.value.snapshotHash,
        '/operations',
      );
    }
    current = recoveryObservation.value;
  }
}

/** Shared validated transaction state machine used by sequential and batch adapters. */
export async function applyRobloxChangeSetWithStrategy(
  adapter: RobloxAdapter,
  input: unknown,
  strategy: Readonly<RobloxTransactionOperationStrategy>,
): Promise<ApplyResult> {
  const changeSetValidation = validateRobloxChangeSet(input);
  if (!changeSetValidation.valid) {
    return failure(
      'change-set-validation',
      wrapDiagnostics('transaction.change_set_invalid', changeSetValidation.diagnostics),
      0,
      rollbackNotAttempted(),
    );
  }
  const changeSet = normalizeRobloxChangeSet(changeSetValidation.value);
  const changeSetHash = hashRobloxChangeSet(changeSet);
  const scope: RobloxAdapterScope = {
    projectId: changeSet.preconditions.projectId,
    target: { service: 'Workspace' },
  };

  let rawInitialSnapshot: unknown;
  try {
    rawInitialSnapshot = await adapter.readSnapshot(scope);
  } catch {
    return failure(
      'snapshot-read',
      transactionDiagnostic(
        'transaction.snapshot_invalid',
        '',
        'The adapter snapshot could not be read.',
      ),
      0,
      rollbackNotAttempted(),
    );
  }
  const initialValidation = validateRobloxSnapshot(rawInitialSnapshot);
  if (!initialValidation.valid) {
    return failure(
      'snapshot-validation',
      wrapDiagnostics('transaction.snapshot_invalid', initialValidation.diagnostics),
      0,
      rollbackNotAttempted(),
    );
  }
  const initialSnapshot = normalizeRobloxSnapshot(initialValidation.value);
  const initialSnapshotHash = hashRobloxSnapshot(initialSnapshot);
  if (initialSnapshotHash !== changeSet.preconditions.baseSnapshotHash) {
    return failure(
      'stale-check',
      transactionDiagnostic(
        'transaction.stale_snapshot',
        '/preconditions/baseSnapshotHash',
        'The complete current snapshot does not match the change-set base hash.',
      ),
      0,
      rollbackNotAttempted(),
      initialSnapshotHash,
    );
  }

  const preflight = simulateRobloxChangeSet(initialSnapshot, changeSet);
  if (!preflight.success) {
    return failure(
      'preflight',
      wrapDiagnostics('transaction.preflight_failed', preflight.diagnostics),
      0,
      rollbackNotAttempted(),
      initialSnapshotHash,
    );
  }
  if (changeSet.operations.length === 0) {
    return {
      success: true,
      status: 'noop',
      snapshot: initialSnapshot,
      diagnostics: [],
      operationsAttempted: 0,
      initialSnapshotHash,
      finalSnapshotHash: initialSnapshotHash,
    };
  }

  if (strategy.prepareForMutation !== undefined) {
    let preparationDiagnostics: readonly RobloxDiagnostic[] | undefined;
    try {
      const preparation = await strategy.prepareForMutation(
        deepFreeze(
          structuredClone({
            scope,
            changeSet,
            changeSetHash,
            initialSnapshot,
            initialSnapshotHash,
          }),
        ),
      );
      if (!preparation.success) preparationDiagnostics = preparation.diagnostics;
    } catch {
      preparationDiagnostics = transactionDiagnostic(
        'transaction.apply_failed',
        '/preparation',
        'The adapter could not prepare the mutation boundary.',
      );
    }
    if (preparationDiagnostics !== undefined) {
      return failure(
        'apply',
        preparationDiagnostics.length === 0
          ? transactionDiagnostic(
              'transaction.apply_failed',
              '/preparation',
              'The adapter could not prepare the mutation boundary.',
            )
          : sortDiagnostics(structuredClone(preparationDiagnostics)),
        0,
        rollbackNotAttempted(),
        initialSnapshotHash,
      );
    }

    let rawPreparedSnapshot: unknown;
    try {
      rawPreparedSnapshot = await adapter.readSnapshot(scope);
    } catch {
      return failure(
        'snapshot-read',
        transactionDiagnostic(
          'transaction.snapshot_invalid',
          '/preparation',
          'The complete adapter snapshot could not be read after mutation preparation.',
        ),
        0,
        rollbackNotAttempted(),
        initialSnapshotHash,
      );
    }
    const preparedValidation = validateRobloxSnapshot(rawPreparedSnapshot);
    if (!preparedValidation.valid) {
      return failure(
        'snapshot-validation',
        wrapDiagnostics('transaction.snapshot_invalid', preparedValidation.diagnostics),
        0,
        rollbackNotAttempted(),
        initialSnapshotHash,
      );
    }
    const preparedSnapshotHash = hashRobloxSnapshot(
      normalizeRobloxSnapshot(preparedValidation.value),
    );
    if (preparedSnapshotHash !== initialSnapshotHash) {
      return failure(
        'stale-check',
        transactionDiagnostic(
          'transaction.stale_snapshot',
          '/preconditions/baseSnapshotHash',
          'The complete current snapshot changed after mutation preparation.',
        ),
        0,
        rollbackNotAttempted(),
        initialSnapshotHash,
        preparedSnapshotHash,
      );
    }
  }

  const execution = await executeOperationSequence(
    strategy,
    scope,
    changeSet.operations,
    changeSetHash,
    'forward',
  );
  if (!execution.success) {
    if (execution.planningFailed) {
      return failure(
        'apply',
        transactionDiagnostic(
          'transaction.apply_failed',
          '/operations',
          'The adapter did not produce exact non-empty batches for the authorized operations.',
        ),
        0,
        rollbackNotAttempted(),
        initialSnapshotHash,
      );
    }
    const rollback = await compensateToInitialSnapshot(
      adapter,
      strategy,
      scope,
      initialSnapshot,
      initialSnapshotHash,
      changeSet,
      changeSetHash,
      execution.operationsAttempted,
    );
    return failure(
      'apply',
      transactionDiagnostic(
        'transaction.apply_failed',
        `/operations/${execution.failedOperationIndex}`,
        'An adapter mutation failed.',
        execution.failedOperationId,
      ),
      execution.operationsAttempted,
      rollback.result,
      initialSnapshotHash,
      rollback.observedFailureSnapshotHash,
    );
  }
  const operationsAttempted = execution.operationsAttempted;

  let rawFinalSnapshot: unknown;
  try {
    rawFinalSnapshot = await adapter.readSnapshot(scope);
  } catch {
    const rollback = await compensateToInitialSnapshot(
      adapter,
      strategy,
      scope,
      initialSnapshot,
      initialSnapshotHash,
      changeSet,
      changeSetHash,
      operationsAttempted,
    );
    return failure(
      'verification',
      transactionDiagnostic(
        'transaction.verification_failed',
        '',
        'The final adapter snapshot could not be read.',
      ),
      operationsAttempted,
      rollback.result,
      initialSnapshotHash,
      rollback.observedFailureSnapshotHash,
    );
  }
  const finalValidation = validateRobloxSnapshot(rawFinalSnapshot);
  if (!finalValidation.valid) {
    const rollback = await compensateToInitialSnapshot(
      adapter,
      strategy,
      scope,
      initialSnapshot,
      initialSnapshotHash,
      changeSet,
      changeSetHash,
      operationsAttempted,
    );
    return failure(
      'verification',
      wrapDiagnostics('transaction.verification_failed', finalValidation.diagnostics),
      operationsAttempted,
      rollback.result,
      initialSnapshotHash,
      rollback.observedFailureSnapshotHash,
    );
  }
  const finalSnapshot = normalizeRobloxSnapshot(finalValidation.value);
  const finalSnapshotHash = hashRobloxSnapshot(finalSnapshot);
  if (finalSnapshotHash !== changeSet.preconditions.resultSnapshotHash) {
    const rollback = await compensateToInitialSnapshot(
      adapter,
      strategy,
      scope,
      initialSnapshot,
      initialSnapshotHash,
      changeSet,
      changeSetHash,
      operationsAttempted,
    );
    return failure(
      'verification',
      transactionDiagnostic(
        'transaction.verification_failed',
        '/preconditions/resultSnapshotHash',
        'The complete final snapshot does not match the expected result hash.',
      ),
      operationsAttempted,
      rollback.result,
      initialSnapshotHash,
      rollback.observedFailureSnapshotHash,
    );
  }
  return {
    success: true,
    status: 'applied',
    snapshot: finalSnapshot,
    diagnostics: [],
    operationsAttempted,
    initialSnapshotHash,
    finalSnapshotHash,
  };
}

export function createBatchTransactionStrategy(
  applyBatch: RobloxTransactionOperationStrategy['applyBatch'],
  planner: RobloxOperationBatchPlanner,
  prepareForMutation?: RobloxMutationPreparationHook,
): RobloxTransactionOperationStrategy {
  return {
    maxCompensationRecoveryAttempts: 1,
    planBatches: (operations, changeSetHash, phase) =>
      planner({ changeSetHash, phase, operations }),
    applyBatch,
    ...(prepareForMutation === undefined ? {} : { prepareForMutation }),
  };
}
