import { validateRobloxChangeSet, validateRobloxSnapshot } from './contract-validation.js';
import { diagnostic, type RobloxDiagnostic } from './diagnostics.js';
import {
  hashRobloxSnapshot,
  normalizeRobloxChangeSet,
  normalizeRobloxSnapshot,
} from './normalize.js';
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
  RobloxSnapshot,
  RollbackResult,
} from './types.js';

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
    | 'transaction.rollback_failed',
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
  observedFinalSnapshotHash?: string,
): ApplyFailure {
  return {
    success: false,
    stage,
    diagnostics,
    operationsAttempted,
    rollback,
    ...(initialSnapshotHash === undefined ? {} : { initialSnapshotHash }),
    ...(observedFinalSnapshotHash === undefined ? {} : { observedFinalSnapshotHash }),
  };
}

async function applyOperation(
  adapter: RobloxAdapter,
  scope: Readonly<RobloxAdapterScope>,
  operation: Readonly<RobloxChangeOperation>,
): Promise<void> {
  switch (operation.type) {
    case 'create':
      await adapter.createNode(scope, operation.node);
      return;
    case 'update':
      await adapter.updateNode(scope, operation.before, operation.after);
      return;
    case 'delete':
      await adapter.deleteNode(scope, operation.before);
  }
}

interface RollbackAttempt {
  readonly result: RollbackResult;
  readonly observedSnapshotHash?: string;
}

function rollbackFailure(message: string, observedSnapshotHash?: string): RollbackAttempt {
  return {
    result: {
      attempted: true,
      succeeded: false,
      diagnostics: transactionDiagnostic('transaction.rollback_failed', '', message),
      ...(observedSnapshotHash === undefined ? {} : { observedSnapshotHash }),
    },
    ...(observedSnapshotHash === undefined ? {} : { observedSnapshotHash }),
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

/**
 * Compensates from observable current state rather than assuming whether the failed
 * adapter operation mutated. Restoration is successful only after the complete
 * snapshot, including unmanaged-root markers, has its original hash again.
 */
async function compensateToInitialSnapshot(
  adapter: RobloxAdapter,
  scope: Readonly<RobloxAdapterScope>,
  initialSnapshot: Readonly<RobloxSnapshot>,
  initialSnapshotHash: string,
  knownObservedSnapshot?: Readonly<RobloxSnapshot>,
): Promise<RollbackAttempt> {
  let observed: RobloxSnapshot;
  if (knownObservedSnapshot === undefined) {
    let rawObserved: unknown;
    try {
      rawObserved = await adapter.readSnapshot(scope);
    } catch {
      return rollbackFailure('Rollback could not read observable adapter state.');
    }
    const validation = validateRobloxSnapshot(rawObserved);
    if (!validation.valid) {
      return rollbackFailure('Rollback observed an invalid scene snapshot.');
    }
    observed = normalizeRobloxSnapshot(validation.value);
  } else {
    observed = normalizeRobloxSnapshot(knownObservedSnapshot);
  }

  const observedSnapshotHash = hashRobloxSnapshot(observed);
  const transition = planRobloxSnapshotTransition(observed, initialSnapshot);
  if (!transition.success) {
    return rollbackFailure(
      'Rollback could not plan a safe compensating transition.',
      observedSnapshotHash,
    );
  }

  for (const operation of transition.operations) {
    try {
      await applyOperation(adapter, scope, operation);
    } catch {
      return rollbackFailure(
        'A compensating adapter operation failed.',
        await readValidatedSnapshotHash(adapter, scope),
      );
    }
  }

  let rawRestored: unknown;
  try {
    rawRestored = await adapter.readSnapshot(scope);
  } catch {
    return rollbackFailure('Rollback could not read state for restoration verification.');
  }
  const restoredValidation = validateRobloxSnapshot(rawRestored);
  if (!restoredValidation.valid) {
    return rollbackFailure('Rollback restoration produced an invalid scene snapshot.');
  }

  const restoredSnapshotHash = hashRobloxSnapshot(
    normalizeRobloxSnapshot(restoredValidation.value),
  );
  if (restoredSnapshotHash !== initialSnapshotHash) {
    return rollbackFailure(
      'Rollback did not restore the complete initial snapshot hash.',
      restoredSnapshotHash,
    );
  }
  return {
    result: {
      attempted: true,
      succeeded: true,
      restoredSnapshotHash,
    },
    observedSnapshotHash: restoredSnapshotHash,
  };
}

/**
 * Applies a validated dry-run plan through a narrow adapter and verifies the complete
 * resulting snapshot. Expected data, adapter, and verification failures are returned
 * as structured values with sanitized messages.
 */
export async function applyRobloxChangeSet(
  adapter: RobloxAdapter,
  input: unknown,
): Promise<ApplyResult> {
  const changeSetValidation = validateRobloxChangeSet(input);
  if (!changeSetValidation.valid) {
    return failure(
      'change-set-validation',
      transactionDiagnostic(
        'transaction.change_set_invalid',
        '',
        'The Roblox change set is invalid.',
      ),
      0,
      rollbackNotAttempted(),
    );
  }

  const changeSet: RobloxChangeSet = normalizeRobloxChangeSet(changeSetValidation.value);
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
      transactionDiagnostic(
        'transaction.snapshot_invalid',
        '',
        'The adapter returned an invalid scene snapshot.',
      ),
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
      transactionDiagnostic(
        'transaction.preflight_failed',
        '',
        'The change set failed complete pure simulation.',
      ),
      0,
      rollbackNotAttempted(),
      initialSnapshotHash,
    );
  }

  let operationsAttempted = 0;
  for (let index = 0; index < changeSet.operations.length; index += 1) {
    const operation = changeSet.operations[index]!;
    operationsAttempted += 1;
    try {
      await applyOperation(adapter, scope, operation);
    } catch {
      const rollback = await compensateToInitialSnapshot(
        adapter,
        scope,
        initialSnapshot,
        initialSnapshotHash,
      );
      return failure(
        'apply',
        transactionDiagnostic(
          'transaction.apply_failed',
          `/operations/${index}`,
          'An adapter mutation failed.',
          operation.id,
        ),
        operationsAttempted,
        rollback.result,
        initialSnapshotHash,
        rollback.observedSnapshotHash,
      );
    }
  }

  let rawFinalSnapshot: unknown;
  try {
    rawFinalSnapshot = await adapter.readSnapshot(scope);
  } catch {
    const rollback = await compensateToInitialSnapshot(
      adapter,
      scope,
      initialSnapshot,
      initialSnapshotHash,
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
      rollback.observedSnapshotHash,
    );
  }

  const finalValidation = validateRobloxSnapshot(rawFinalSnapshot);
  if (!finalValidation.valid) {
    const rollback = await compensateToInitialSnapshot(
      adapter,
      scope,
      initialSnapshot,
      initialSnapshotHash,
    );
    return failure(
      'verification',
      transactionDiagnostic(
        'transaction.verification_failed',
        '',
        'The adapter returned an invalid final scene snapshot.',
      ),
      operationsAttempted,
      rollback.result,
      initialSnapshotHash,
      rollback.observedSnapshotHash,
    );
  }

  const finalSnapshot = normalizeRobloxSnapshot(finalValidation.value);
  const finalSnapshotHash = hashRobloxSnapshot(finalSnapshot);
  if (finalSnapshotHash !== changeSet.preconditions.resultSnapshotHash) {
    const rollback = await compensateToInitialSnapshot(
      adapter,
      scope,
      initialSnapshot,
      initialSnapshotHash,
      finalSnapshot,
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
      rollback.observedSnapshotHash,
    );
  }

  return {
    success: true,
    status: changeSet.operations.length === 0 ? 'noop' : 'applied',
    snapshot: finalSnapshot,
    diagnostics: [],
    operationsAttempted,
    initialSnapshotHash,
    finalSnapshotHash,
  };
}
