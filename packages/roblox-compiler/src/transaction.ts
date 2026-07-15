import { validateRobloxChangeSet, validateRobloxSnapshot } from './contract-validation.js';
import { diagnostic, sortDiagnostics, type RobloxDiagnostic } from './diagnostics.js';
import { compareCodePoints, jsonValuesEqual } from './json.js';
import {
  hashRobloxSnapshot,
  normalizeRobloxChangeSet,
  normalizeRobloxManagedNode,
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
  RobloxManagedNode,
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
  readonly observedFailureSnapshotHash?: string;
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

function operationNodeId(operation: Readonly<RobloxChangeOperation>): string {
  switch (operation.type) {
    case 'create':
      return operation.node.id;
    case 'update':
      return operation.before.id;
    case 'delete':
      return operation.before.id;
  }
}

function nodeMatches(
  actual: Readonly<RobloxManagedNode> | undefined,
  expected: Readonly<RobloxManagedNode>,
): boolean {
  return (
    actual !== undefined &&
    jsonValuesEqual(normalizeRobloxManagedNode(actual), normalizeRobloxManagedNode(expected))
  );
}

function attemptedTargetIsAdmissible(
  observed: Readonly<RobloxManagedNode> | undefined,
  operation: Readonly<RobloxChangeOperation>,
): boolean {
  switch (operation.type) {
    case 'create':
      return observed === undefined || nodeMatches(observed, operation.node);
    case 'update':
      return nodeMatches(observed, operation.before) || nodeMatches(observed, operation.after);
    case 'delete':
      return observed === undefined || nodeMatches(observed, operation.before);
  }
}

function rootChangeIsAdmissible(
  initialRootNodeId: string | undefined,
  observedRootNodeId: string | undefined,
  attemptedByNodeId: ReadonlyMap<string, RobloxChangeOperation>,
): boolean {
  if (initialRootNodeId === observedRootNodeId) return true;
  const initialRootOperation =
    initialRootNodeId === undefined ? undefined : attemptedByNodeId.get(initialRootNodeId);
  const observedRootOperation =
    observedRootNodeId === undefined ? undefined : attemptedByNodeId.get(observedRootNodeId);
  const removalIsExplained =
    initialRootNodeId === undefined || initialRootOperation?.type === 'delete';
  const additionIsExplained =
    observedRootNodeId === undefined || observedRootOperation?.type === 'create';
  return removalIsExplained && additionIsExplained;
}

function rollbackAdmissibilityDiagnostics(
  initial: Readonly<RobloxSnapshot>,
  observed: Readonly<RobloxSnapshot>,
  attemptedOperations: readonly RobloxChangeOperation[],
): RobloxDiagnostic[] {
  const diagnostics: RobloxDiagnostic[] = [];
  const attemptedByNodeId = new Map(
    attemptedOperations.map((operation) => [operationNodeId(operation), operation]),
  );
  const initialById = new Map(initial.nodes.map((node) => [node.id, node]));
  const observedById = new Map(observed.nodes.map((node) => [node.id, node]));

  if (
    initial.schemaVersion !== observed.schemaVersion ||
    initial.projectId !== observed.projectId ||
    !jsonValuesEqual(initial.target, observed.target)
  ) {
    diagnostics.push(
      diagnostic(
        'transaction.rollback_unsafe_observed_state',
        '',
        'Rollback observed different snapshot scope metadata.',
      ),
    );
  }

  if (!jsonValuesEqual(initial.unmanagedRoots, observed.unmanagedRoots)) {
    diagnostics.push(
      diagnostic(
        'transaction.rollback_unsafe_observed_state',
        '/unmanagedRoots',
        'Rollback observed an unmanaged-root change outside the forward operation envelope.',
      ),
    );
  }

  if (!rootChangeIsAdmissible(initial.rootNodeId, observed.rootNodeId, attemptedByNodeId)) {
    diagnostics.push(
      diagnostic(
        'transaction.rollback_unsafe_observed_state',
        '/rootNodeId',
        'Rollback observed a root identity change not explained by an attempted create or delete.',
        observed.rootNodeId ?? initial.rootNodeId,
      ),
    );
  }

  const nodeIds = [...new Set([...initialById.keys(), ...observedById.keys()])].sort(
    compareCodePoints,
  );
  for (const nodeId of nodeIds) {
    const initialNode = initialById.get(nodeId);
    const observedNode = observedById.get(nodeId);
    const attempted = attemptedByNodeId.get(nodeId);
    const admissible =
      attempted === undefined
        ? (initialNode === undefined && observedNode === undefined) ||
          (initialNode !== undefined && nodeMatches(observedNode, initialNode))
        : attemptedTargetIsAdmissible(observedNode, attempted);
    if (!admissible) {
      diagnostics.push(
        diagnostic(
          'transaction.rollback_unsafe_observed_state',
          `/nodes/${nodeId}`,
          attempted === undefined
            ? 'Rollback observed an unrelated managed-state change.'
            : 'Rollback observed an attempted target in a state outside its allowed envelope.',
          nodeId,
        ),
      );
    }
  }
  return sortDiagnostics(diagnostics);
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
  attemptedOperations: readonly RobloxChangeOperation[],
): Promise<RollbackAttempt> {
  let rawObserved: unknown;
  try {
    rawObserved = await adapter.readSnapshot(scope);
  } catch {
    return rollbackFailure(
      'transaction.rollback_failed',
      'Rollback could not read observable adapter state.',
    );
  }
  const validation = validateRobloxSnapshot(rawObserved);
  if (!validation.valid) {
    return rollbackValidationFailure(validation.diagnostics);
  }
  const observed = normalizeRobloxSnapshot(validation.value);

  const observedSnapshotHash = hashRobloxSnapshot(observed);
  const admissibilityDiagnostics = rollbackAdmissibilityDiagnostics(
    initialSnapshot,
    observed,
    attemptedOperations,
  );
  if (admissibilityDiagnostics.length > 0) {
    return {
      result: {
        attempted: true,
        succeeded: false,
        diagnostics: admissibilityDiagnostics,
      },
      observedFailureSnapshotHash: observedSnapshotHash,
    };
  }

  const transition = planRobloxSnapshotTransition(observed, initialSnapshot);
  if (!transition.success) {
    return rollbackFailure(
      'transaction.rollback_failed',
      'Rollback could not plan a safe compensating transition.',
      observedSnapshotHash,
    );
  }

  for (const operation of transition.operations) {
    try {
      await applyOperation(adapter, scope, operation);
    } catch {
      return rollbackFailure(
        'transaction.rollback_failed',
        'A compensating adapter operation failed.',
        observedSnapshotHash,
        await readValidatedSnapshotHash(adapter, scope),
      );
    }
  }

  let rawRestored: unknown;
  try {
    rawRestored = await adapter.readSnapshot(scope);
  } catch {
    return rollbackFailure(
      'transaction.rollback_failed',
      'Rollback could not read state for restoration verification.',
      observedSnapshotHash,
    );
  }
  const restoredValidation = validateRobloxSnapshot(rawRestored);
  if (!restoredValidation.valid) {
    return rollbackValidationFailure(restoredValidation.diagnostics, observedSnapshotHash);
  }

  const restoredSnapshotHash = hashRobloxSnapshot(
    normalizeRobloxSnapshot(restoredValidation.value),
  );
  if (restoredSnapshotHash !== initialSnapshotHash) {
    return rollbackFailure(
      'transaction.rollback_failed',
      'Rollback did not restore the complete initial snapshot hash.',
      observedSnapshotHash,
      restoredSnapshotHash,
    );
  }
  return {
    result: {
      attempted: true,
      succeeded: true,
      restoredSnapshotHash,
    },
    observedFailureSnapshotHash: observedSnapshotHash,
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
      wrapDiagnostics('transaction.change_set_invalid', changeSetValidation.diagnostics),
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
        changeSet.operations.slice(0, operationsAttempted),
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
        rollback.observedFailureSnapshotHash,
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
      changeSet.operations.slice(0, operationsAttempted),
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
      scope,
      initialSnapshot,
      initialSnapshotHash,
      changeSet.operations.slice(0, operationsAttempted),
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
      scope,
      initialSnapshot,
      initialSnapshotHash,
      changeSet.operations.slice(0, operationsAttempted),
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
