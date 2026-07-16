import { describe, expect, it } from 'vitest';

import type {
  RobloxOperationBatchAdapter,
  RobloxOperationBatchContext,
  RobloxOperationBatchOutcome,
  RobloxOperationBatchPlanner,
} from '../src/batch-adapter.js';
import { diagnostic } from '../src/diagnostics.js';
import { hashRobloxSnapshot, normalizeRobloxSnapshot } from '../src/normalize.js';
import { planRobloxChangeSet } from '../src/reconcile.js';
import { createInMemoryRobloxAdapter, type InMemoryRobloxAdapter } from '../src/testing.js';
import { applyRobloxChangeSetBatched } from '../src/transaction.js';
import type {
  PlanSuccess,
  RobloxAdapterScope,
  RobloxChangeOperation,
  RobloxManifest,
  RobloxSnapshot,
} from '../src/types.js';
import {
  clone,
  compilePrimitiveFixture,
  emptySnapshotForManifest,
  snapshotFromManifest,
} from './helpers.js';

function requirePlan(
  snapshot: Readonly<RobloxSnapshot>,
  manifest: Readonly<RobloxManifest>,
): PlanSuccess {
  const result = planRobloxChangeSet(snapshot, manifest);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('Expected a valid fixture plan.');
  return result;
}

function renamedManifest(
  manifest: Readonly<RobloxManifest>,
  nodeId: string,
  name: string,
): RobloxManifest {
  return {
    ...clone(manifest),
    nodes: manifest.nodes.map((node) =>
      node.id === nodeId ? { ...clone(node), name } : clone(node),
    ),
  };
}

function scopeFor(manifest: Readonly<RobloxManifest>): RobloxAdapterScope {
  return { projectId: manifest.source.projectId, target: { service: 'Workspace' } };
}

async function snapshotFromAdapter(
  backing: InMemoryRobloxAdapter,
  scope: Readonly<RobloxAdapterScope>,
): Promise<RobloxSnapshot> {
  return normalizeRobloxSnapshot((await backing.readSnapshot(scope)) as RobloxSnapshot);
}

function fixedSizePlanner(
  size: number,
  calls: RobloxOperationBatchContext['phase'][] = [],
): RobloxOperationBatchPlanner {
  return ({ phase, operations }) => {
    calls.push(phase);
    const batches: Readonly<RobloxChangeOperation>[][] = [];
    for (let index = 0; index < operations.length; index += size) {
      batches.push(operations.slice(index, index + size));
    }
    return batches;
  };
}

type ForwardFault =
  | 'none'
  | 'certain-after-first'
  | 'throw-before'
  | 'throw-after-first'
  | 'throw-after-all'
  | 'skip-last-success'
  | 'unsafe-after-all'
  | 'invalid-outcome';

interface BatchHarness {
  readonly adapter: RobloxOperationBatchAdapter;
  readonly backing: InMemoryRobloxAdapter;
  readonly contexts: RobloxOperationBatchContext[];
  readonly submittedOperationIds: string[][];
}

function createBatchHarness(
  initial: Readonly<RobloxSnapshot>,
  forwardFault: ForwardFault = 'none',
  compensationThrowsAfterFirst = false,
  compensationThrowsBeforeMutation = false,
  compensationFaultBatchIndex = 0,
  reapplyDefinitelyCompensatedOperation = false,
): BatchHarness {
  const backing = createInMemoryRobloxAdapter({ initialSnapshots: [initial] });
  const contexts: RobloxOperationBatchContext[] = [];
  const submittedOperationIds: string[][] = [];
  let forwardFaultUsed = false;
  let compensationFaultUsed = false;
  let lastDefinitelyCompensatedOperation: Readonly<RobloxChangeOperation> | undefined;

  const applyOne = async (
    scope: Readonly<RobloxAdapterScope>,
    operation: Readonly<RobloxChangeOperation>,
  ): Promise<void> => {
    switch (operation.type) {
      case 'create':
        await backing.createNode(scope, operation.node);
        return;
      case 'update':
        await backing.updateNode(scope, operation.before, operation.after);
        return;
      case 'delete':
        await backing.deleteNode(scope, operation.before);
    }
  };

  const applyInverseOne = async (
    scope: Readonly<RobloxAdapterScope>,
    operation: Readonly<RobloxChangeOperation>,
  ): Promise<void> => {
    switch (operation.type) {
      case 'create':
        await backing.deleteNode(scope, operation.node);
        return;
      case 'update':
        await backing.updateNode(scope, operation.after, operation.before);
        return;
      case 'delete':
        await backing.createNode(scope, operation.before);
    }
  };

  const applyOperationBatch = async (
    scope: Readonly<RobloxAdapterScope>,
    operations: readonly Readonly<RobloxChangeOperation>[],
    context: Readonly<RobloxOperationBatchContext>,
  ): Promise<RobloxOperationBatchOutcome> => {
    contexts.push({ ...context });
    submittedOperationIds.push(operations.map((operation) => operation.id));

    if (
      context.phase === 'compensation' &&
      (compensationThrowsAfterFirst || compensationThrowsBeforeMutation) &&
      context.batchIndex === compensationFaultBatchIndex &&
      !compensationFaultUsed
    ) {
      compensationFaultUsed = true;
      if (
        reapplyDefinitelyCompensatedOperation &&
        lastDefinitelyCompensatedOperation !== undefined
      ) {
        await applyInverseOne(scope, lastDefinitelyCompensatedOperation);
      }
      if (compensationThrowsAfterFirst && operations[0] !== undefined) {
        await applyOne(scope, operations[0]);
      }
      throw new Error('Uncertain compensation response.');
    }
    if (context.phase !== 'forward' || forwardFaultUsed || forwardFault === 'none') {
      for (const operation of operations) await applyOne(scope, operation);
      if (context.phase === 'compensation') {
        lastDefinitelyCompensatedOperation = operations.at(-1);
      }
      return {
        success: true,
        operationsAttempted: operations.length,
        operationsApplied: operations.length,
      };
    }

    forwardFaultUsed = true;
    if (forwardFault === 'throw-before') throw new Error('Uncertain response before mutation.');
    if (forwardFault === 'invalid-outcome') {
      return {
        success: true,
        operationsAttempted: operations.length + 1,
        operationsApplied: operations.length + 1,
      };
    }
    if (forwardFault === 'certain-after-first') {
      if (operations[0] !== undefined) await applyOne(scope, operations[0]);
      return {
        success: false,
        stateCertain: true,
        operationsAttempted: Math.min(2, operations.length),
        operationsApplied: Math.min(1, operations.length),
        diagnostics: [diagnostic('transaction.apply_failed', '', 'Deterministic batch fault.')],
      };
    }
    if (forwardFault === 'throw-after-first') {
      if (operations[0] !== undefined) await applyOne(scope, operations[0]);
      throw new Error('Uncertain response after a partial batch.');
    }

    const applied = forwardFault === 'skip-last-success' ? operations.slice(0, -1) : operations;
    for (const operation of applied) await applyOne(scope, operation);
    if (forwardFault === 'unsafe-after-all') {
      const observed = await snapshotFromAdapter(backing, scope);
      backing.replaceSnapshotForTesting({
        ...clone(observed),
        nodes: observed.nodes.map((node) =>
          node.id === 'north-wall'
            ? { ...clone(node), name: 'Concurrent unsafe edit' }
            : clone(node),
        ),
      });
      throw new Error('Uncertain response with unrelated state.');
    }
    if (forwardFault === 'throw-after-all') {
      throw new Error('Lost complete batch acknowledgment.');
    }
    return {
      success: true,
      operationsAttempted: operations.length,
      operationsApplied: operations.length,
    };
  };

  const adapter: RobloxOperationBatchAdapter = {
    readSnapshot: (scope) => backing.readSnapshot(scope),
    createNode: (scope, node) => backing.createNode(scope, node),
    updateNode: (scope, before, after) => backing.updateNode(scope, before, after),
    deleteNode: (scope, before) => backing.deleteNode(scope, before),
    applyOperationBatch,
  };
  return { adapter, backing, contexts, submittedOperationIds };
}

describe('generic batched Roblox transactions', () => {
  it('applies deterministic multi-operation batches and independently verifies the final snapshot', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const harness = createBatchHarness(initial);
    const result = await applyRobloxChangeSetBatched(
      harness.adapter,
      plan.changeSet,
      fixedSizePlanner(3),
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        status: 'applied',
        operationsAttempted: plan.changeSet.operations.length,
        finalSnapshotHash: plan.changeSet.preconditions.resultSnapshotHash,
      }),
    );
    expect(harness.contexts).toHaveLength(Math.ceil(plan.changeSet.operations.length / 3));
    expect(harness.contexts.every((context) => context.phase === 'forward')).toBe(true);
    expect(harness.submittedOperationIds.flat()).toEqual(
      plan.changeSet.operations.map((operation) => operation.id),
    );
    expect(hashRobloxSnapshot(await snapshotFromAdapter(harness.backing, scopeFor(manifest)))).toBe(
      plan.changeSet.preconditions.resultSnapshotHash,
    );
  });

  it('uses a trustworthy certain-failure prefix count and compensates only exact observed progress', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const harness = createBatchHarness(initial, 'certain-after-first');
    const result = await applyRobloxChangeSetBatched(
      harness.adapter,
      plan.changeSet,
      fixedSizePlanner(4),
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'apply',
        operationsAttempted: 2,
        rollback: {
          attempted: true,
          succeeded: true,
          restoredSnapshotHash: hashRobloxSnapshot(initial),
        },
      }),
    );
    expect(harness.contexts.map((context) => context.phase)).toEqual(['forward', 'compensation']);
  });

  it('treats a whole submitted chunk as attempted after an uncertain partial response', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const harness = createBatchHarness(initial, 'throw-after-first');
    const result = await applyRobloxChangeSetBatched(
      harness.adapter,
      plan.changeSet,
      fixedSizePlanner(4),
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        operationsAttempted: 4,
        rollback: expect.objectContaining({ attempted: true, succeeded: true }),
      }),
    );
    expect(await snapshotFromAdapter(harness.backing, scopeFor(manifest))).toEqual(
      normalizeRobloxSnapshot(initial),
    );
  });

  it('conservatively compensates a complete desired result after its acknowledgment is lost', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = snapshotFromManifest(manifest);
    const plan = requirePlan(initial, renamedManifest(manifest, 'plaza-floor', 'Reviewed rename'));
    const harness = createBatchHarness(initial, 'throw-after-all');
    const result = await applyRobloxChangeSetBatched(
      harness.adapter,
      plan.changeSet,
      fixedSizePlanner(32),
    );

    expect(plan.changeSet.operations).toHaveLength(1);
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'apply',
        operationsAttempted: 1,
        observedFailureSnapshotHash: plan.changeSet.preconditions.resultSnapshotHash,
        rollback: {
          attempted: true,
          succeeded: true,
          restoredSnapshotHash: hashRobloxSnapshot(initial),
        },
      }),
    );
    expect(harness.contexts.map((context) => context.phase)).toEqual(['forward', 'compensation']);
  });

  it('does not trust a successful batch outcome when the independent final snapshot is only a prefix', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const harness = createBatchHarness(initial, 'skip-last-success');
    const result = await applyRobloxChangeSetBatched(
      harness.adapter,
      plan.changeSet,
      fixedSizePlanner(512),
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'verification',
        operationsAttempted: plan.changeSet.operations.length,
        rollback: expect.objectContaining({ attempted: true, succeeded: true }),
      }),
    );
    expect(await snapshotFromAdapter(harness.backing, scopeFor(manifest))).toEqual(
      normalizeRobloxSnapshot(initial),
    );
  });

  it('observes exact base after a thrown batch without issuing a compensation mutation', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const harness = createBatchHarness(initial, 'throw-before');
    const result = await applyRobloxChangeSetBatched(
      harness.adapter,
      plan.changeSet,
      fixedSizePlanner(4),
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        operationsAttempted: 4,
        observedFailureSnapshotHash: hashRobloxSnapshot(initial),
        rollback: expect.objectContaining({ attempted: true, succeeded: true }),
      }),
    );
    expect(harness.contexts.map((context) => context.phase)).toEqual(['forward']);
    expect(harness.backing.mutationAttempts).toBe(0);
  });

  it('blocks compensation when fresh state contains an unrelated managed edit', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = snapshotFromManifest(manifest);
    const plan = requirePlan(initial, renamedManifest(manifest, 'plaza-floor', 'Reviewed rename'));
    const harness = createBatchHarness(initial, 'unsafe-after-all');
    const result = await applyRobloxChangeSetBatched(
      harness.adapter,
      plan.changeSet,
      fixedSizePlanner(32),
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected unsafe rollback failure.');
    expect(result.rollback).toEqual(
      expect.objectContaining({
        attempted: true,
        succeeded: false,
        diagnostics: [
          expect.objectContaining({
            code: 'transaction.rollback_unsafe_observed_state',
            path: '/nodes/north-wall',
          }),
        ],
      }),
    );
    expect(harness.contexts.map((context) => context.phase)).toEqual(['forward']);
  });

  it('re-observes and replans after one uncertain compensating chunk', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const harness = createBatchHarness(initial, 'throw-after-first', true);
    const result = await applyRobloxChangeSetBatched(
      harness.adapter,
      plan.changeSet,
      fixedSizePlanner(4),
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        rollback: {
          attempted: true,
          succeeded: true,
          restoredSnapshotHash: hashRobloxSnapshot(initial),
        },
      }),
    );
    expect(harness.contexts.map((context) => context.phase)).toEqual(['forward', 'compensation']);
    expect(await snapshotFromAdapter(harness.backing, scopeFor(manifest))).toEqual(
      normalizeRobloxSnapshot(initial),
    );
  });

  it('keeps partial compensation on the exact reverse forward prefix across siblings', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const harness = createBatchHarness(initial, 'throw-after-all', true);
    const result = await applyRobloxChangeSetBatched(
      harness.adapter,
      plan.changeSet,
      fixedSizePlanner(512),
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        operationsAttempted: plan.changeSet.operations.length,
        rollback: {
          attempted: true,
          succeeded: true,
          restoredSnapshotHash: hashRobloxSnapshot(initial),
        },
      }),
    );
    const compensationSubmissions = harness.contexts
      .map((context, index) => ({ context, ids: harness.submittedOperationIds[index]! }))
      .filter(({ context }) => context.phase === 'compensation')
      .map(({ ids }) => ids);
    expect(compensationSubmissions).toHaveLength(2);
    expect(compensationSubmissions[0]).toEqual(
      plan.changeSet.operations
        .map((operation) =>
          operation.type === 'create'
            ? `delete:${operation.node.id}`
            : operation.type === 'delete'
              ? `create:${operation.before.id}`
              : operation.id,
        )
        .reverse(),
    );
    expect(await snapshotFromAdapter(harness.backing, scopeFor(manifest))).toEqual(
      normalizeRobloxSnapshot(initial),
    );
  });

  it('does not retransmit an uncertain compensation chunk after observing zero progress', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const harness = createBatchHarness(initial, 'throw-after-first', false, true);
    const result = await applyRobloxChangeSetBatched(
      harness.adapter,
      plan.changeSet,
      fixedSizePlanner(4),
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        rollback: expect.objectContaining({
          attempted: true,
          succeeded: false,
          diagnostics: expect.arrayContaining([
            expect.objectContaining({
              code: 'transaction.rollback_failed',
              path: '/operations',
              message: expect.stringContaining('will not be retransmitted'),
            }),
          ]),
        }),
      }),
    );
    expect(harness.contexts.map((context) => context.phase)).toEqual(['forward', 'compensation']);
    expect(harness.submittedOperationIds.filter((_ids, index) => index > 0)).toHaveLength(1);
  });

  it('rejects compensation observations that undo definitely acknowledged inverse progress', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const harness = createBatchHarness(initial, 'throw-after-all', false, true, 2, true);
    const result = await applyRobloxChangeSetBatched(
      harness.adapter,
      plan.changeSet,
      ({ phase, operations }) =>
        phase === 'forward' ? [operations] : operations.map((operation) => [operation]),
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        rollback: expect.objectContaining({
          attempted: true,
          succeeded: false,
          diagnostics: expect.arrayContaining([
            expect.objectContaining({
              code: 'transaction.rollback_unsafe_observed_state',
              path: '/operations',
              message: expect.stringContaining('causal prefix envelope'),
            }),
          ]),
        }),
      }),
    );
    expect(harness.contexts.map((context) => context.phase)).toEqual([
      'forward',
      'compensation',
      'compensation',
      'compensation',
    ]);
  });

  it('rejects a planner that omits or reorders operations before any mutation', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const harness = createBatchHarness(initial);
    const invalidPlanner: RobloxOperationBatchPlanner = ({ operations }) => [
      [...operations].reverse(),
    ];
    const result = await applyRobloxChangeSetBatched(
      harness.adapter,
      plan.changeSet,
      invalidPlanner,
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'apply',
        operationsAttempted: 0,
        rollback: { attempted: false, succeeded: false },
      }),
    );
    expect(harness.contexts).toHaveLength(0);
    expect(harness.backing.mutationAttempts).toBe(0);
  });

  it('isolates planner input and rejects in-place mutation before any adapter call', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const originalName =
      plan.changeSet.operations[0]?.type === 'create'
        ? plan.changeSet.operations[0].node.name
        : undefined;
    const harness = createBatchHarness(initial);
    const mutatingPlanner: RobloxOperationBatchPlanner = ({ operations }) => {
      const first = operations[0];
      if (first?.type === 'create') {
        (first.node as unknown as { name: string }).name = 'Unauthorized planner mutation';
      }
      return [operations];
    };
    const result = await applyRobloxChangeSetBatched(
      harness.adapter,
      plan.changeSet,
      mutatingPlanner,
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'apply',
        operationsAttempted: 0,
        rollback: { attempted: false, succeeded: false },
      }),
    );
    expect(harness.contexts).toHaveLength(0);
    expect(harness.backing.mutationAttempts).toBe(0);
    expect(
      plan.changeSet.operations[0]?.type === 'create'
        ? plan.changeSet.operations[0].node.name
        : undefined,
    ).toBe(originalName);
  });

  it('treats impossible batch counts as uncertain and uses the full submitted envelope', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const harness = createBatchHarness(initial, 'invalid-outcome');
    const result = await applyRobloxChangeSetBatched(
      harness.adapter,
      plan.changeSet,
      fixedSizePlanner(5),
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        operationsAttempted: 5,
        rollback: expect.objectContaining({ attempted: true, succeeded: true }),
      }),
    );
    expect(harness.backing.mutationAttempts).toBe(0);
  });
});
