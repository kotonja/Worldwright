import type {
  RobloxOperationBatchAdapter,
  RobloxOperationBatchOutcome,
  RobloxOperationBatchPlanner,
} from './batch-adapter.js';
import {
  applyRobloxChangeSetWithStrategy,
  createBatchTransactionStrategy,
  type RobloxTransactionOperationStrategy,
} from './transaction-engine.js';
import type {
  ApplyResult,
  RobloxAdapter,
  RobloxAdapterScope,
  RobloxChangeOperation,
  RobloxMutationPreparationHook,
} from './types.js';

function preparationHook(adapter: RobloxAdapter): RobloxMutationPreparationHook | undefined {
  const prepareForMutation = adapter.prepareForMutation;
  return prepareForMutation === undefined
    ? undefined
    : (input) => prepareForMutation.call(adapter, input);
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

function sequentialStrategy(adapter: RobloxAdapter): RobloxTransactionOperationStrategy {
  const prepareForMutation = preparationHook(adapter);
  return {
    maxCompensationRecoveryAttempts: 0,
    planBatches: (operations) => operations.map((operation) => [operation]),
    applyBatch: async (scope, operations): Promise<RobloxOperationBatchOutcome> => {
      const operation = operations[0];
      if (operation === undefined || operations.length !== 1) {
        throw new Error('Sequential transaction strategy requires one operation.');
      }
      await applyOperation(adapter, scope, operation);
      return { success: true, operationsAttempted: 1, operationsApplied: 1 };
    },
    ...(prepareForMutation === undefined ? {} : { prepareForMutation }),
  };
}

/** Applies through the original one-operation adapter surface and preserves v0.1 behavior. */
export function applyRobloxChangeSet(adapter: RobloxAdapter, input: unknown): Promise<ApplyResult> {
  return applyRobloxChangeSetWithStrategy(adapter, input, sequentialStrategy(adapter));
}

/** Applies exact planner-produced batches while retaining compiler-owned transaction semantics. */
export function applyRobloxChangeSetBatched(
  adapter: RobloxOperationBatchAdapter,
  input: unknown,
  planner: RobloxOperationBatchPlanner,
): Promise<ApplyResult> {
  return applyRobloxChangeSetWithStrategy(
    adapter,
    input,
    createBatchTransactionStrategy(
      (scope, operations, context) => adapter.applyOperationBatch(scope, operations, context),
      planner,
      preparationHook(adapter),
    ),
  );
}
