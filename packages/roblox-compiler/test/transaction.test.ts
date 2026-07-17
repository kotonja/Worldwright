import { describe, expect, it } from 'vitest';

import { validateRobloxSnapshot } from '../src/contract-validation.js';
import { diagnostic } from '../src/diagnostics.js';
import {
  hashRobloxChangeSet,
  hashRobloxSnapshot,
  normalizeRobloxSnapshot,
} from '../src/normalize.js';
import { planRobloxChangeSet, planRobloxSnapshotTransition } from '../src/reconcile.js';
import {
  createInMemoryRobloxAdapter,
  inMemoryRobloxFault,
  type InMemoryRobloxAdapter,
} from '../src/testing.js';
import { applyRobloxChangeSet } from '../src/transaction.js';
import type {
  PlanSuccess,
  RobloxAdapter,
  RobloxAdapterScope,
  RobloxManagedNode,
  RobloxManifest,
  RobloxMutationPreparationHook,
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
  if (!result.success) {
    throw new Error(`Planning failed: ${JSON.stringify(result.diagnostics)}`);
  }
  return result;
}

function scopeFor(manifest: Readonly<RobloxManifest>): RobloxAdapterScope {
  return {
    projectId: manifest.source.projectId,
    target: { service: 'Workspace' },
  };
}

function adapterWithPreparation(
  backing: InMemoryRobloxAdapter,
  prepareForMutation: RobloxMutationPreparationHook,
): RobloxAdapter {
  return {
    readSnapshot: (scope) => backing.readSnapshot(scope),
    prepareForMutation,
    createNode: (scope, node) => backing.createNode(scope, node),
    updateNode: (scope, before, after) => backing.updateNode(scope, before, after),
    deleteNode: (scope, before) => backing.deleteNode(scope, before),
  };
}

async function readSnapshot(
  adapter: InMemoryRobloxAdapter,
  scope: Readonly<RobloxAdapterScope>,
): Promise<RobloxSnapshot> {
  const validation = validateRobloxSnapshot(await adapter.readSnapshot(scope));
  expect(validation.valid).toBe(true);
  if (!validation.valid) throw new Error('The in-memory adapter returned an invalid snapshot.');
  return normalizeRobloxSnapshot(validation.value);
}

function manifestWithRenamedNode(
  manifest: Readonly<RobloxManifest>,
  nodeId: string,
  name: string,
): RobloxManifest {
  if (!manifest.nodes.some((entry) => entry.id === nodeId)) {
    throw new Error(`Missing fixture node: ${nodeId}`);
  }
  return {
    ...clone(manifest),
    nodes: manifest.nodes.map((node) =>
      node.id === nodeId ? { ...clone(node), name } : clone(node),
    ),
  };
}

function snapshotForProject(snapshot: Readonly<RobloxSnapshot>, projectId: string): RobloxSnapshot {
  return {
    ...clone(snapshot),
    projectId,
    nodes: snapshot.nodes.map((node) => ({
      ...clone(node),
      attributes: {
        ...clone(node.attributes),
        WorldwrightProjectId: projectId,
      },
    })),
  };
}

function snapshotWithRenamedNode(
  snapshot: Readonly<RobloxSnapshot>,
  nodeId: string,
  name: string,
): RobloxSnapshot {
  if (!snapshot.nodes.some((node) => node.id === nodeId)) {
    throw new Error(`Missing fixture snapshot node: ${nodeId}`);
  }
  return {
    ...clone(snapshot),
    nodes: snapshot.nodes.map((node) =>
      node.id === nodeId ? { ...clone(node), name } : clone(node),
    ),
  };
}

function snapshotWithoutNode(snapshot: Readonly<RobloxSnapshot>, nodeId: string): RobloxSnapshot {
  if (!snapshot.nodes.some((node) => node.id === nodeId)) {
    throw new Error(`Missing fixture snapshot node: ${nodeId}`);
  }
  return {
    ...clone(snapshot),
    nodes: snapshot.nodes.filter((node) => node.id !== nodeId).map((node) => clone(node)),
  };
}

function snapshotWithAdditionalNode(
  snapshot: Readonly<RobloxSnapshot>,
  sourceNodeId: string,
  newNodeId: string,
): RobloxSnapshot {
  const source = snapshot.nodes.find((node) => node.id === sourceNodeId);
  if (source === undefined) throw new Error(`Missing fixture snapshot node: ${sourceNodeId}`);
  const additional: RobloxManagedNode = {
    ...clone(source),
    id: newNodeId,
    name: 'Concurrent managed addition',
    attributes: {
      ...clone(source.attributes),
      WorldwrightEntityId: newNodeId,
    },
  };
  return {
    ...clone(snapshot),
    nodes: [...snapshot.nodes.map((node) => clone(node)), additional],
  };
}

interface ReplacingFailureAdapter {
  readonly adapter: RobloxAdapter;
  readonly backing: InMemoryRobloxAdapter;
  readonly mutationCalls: () => number;
}

function replacingFailureAdapter(
  initial: Readonly<RobloxSnapshot>,
  replacement: Readonly<RobloxSnapshot>,
  otherInitialSnapshots: readonly RobloxSnapshot[] = [],
): ReplacingFailureAdapter {
  const backing = createInMemoryRobloxAdapter({
    initialSnapshots: [initial, ...otherInitialSnapshots],
  });
  let mutationCalls = 0;
  let replaced = false;
  const afterForwardMutation = (): void => {
    if (replaced) return;
    replaced = true;
    backing.replaceSnapshotForTesting(replacement);
    throw new Error('PRIVATE CONCURRENT ADAPTER FAILURE');
  };
  const adapter: RobloxAdapter = {
    readSnapshot: async (scope): Promise<unknown> => backing.readSnapshot(scope),
    createNode: async (scope, node): Promise<void> => {
      mutationCalls += 1;
      await backing.createNode(scope, node);
      afterForwardMutation();
    },
    updateNode: async (scope, before, after): Promise<void> => {
      mutationCalls += 1;
      await backing.updateNode(scope, before, after);
      afterForwardMutation();
    },
    deleteNode: async (scope, before): Promise<void> => {
      mutationCalls += 1;
      await backing.deleteNode(scope, before);
      afterForwardMutation();
    },
  };
  return { adapter, backing, mutationCalls: () => mutationCalls };
}

type UnsafeReplacement = (
  expected: Readonly<RobloxSnapshot>,
  initial: Readonly<RobloxSnapshot>,
) => RobloxSnapshot;

async function runUnsafeRollback(
  replacement: UnsafeReplacement,
  unmanagedRoots: Readonly<RobloxSnapshot['unmanagedRoots']> = [],
): Promise<{
  readonly result: Awaited<ReturnType<typeof applyRobloxChangeSet>>;
  readonly unsafeSnapshot: RobloxSnapshot;
  readonly harness: ReplacingFailureAdapter;
  readonly manifest: RobloxManifest;
}> {
  const manifest = compilePrimitiveFixture();
  const initial = snapshotFromManifest(manifest, unmanagedRoots);
  const desired = manifestWithRenamedNode(manifest, 'plaza-floor', 'Transaction rename');
  const plan = requirePlan(initial, desired);
  expect(plan.changeSet.operations).toHaveLength(1);
  const unsafeSnapshot = normalizeRobloxSnapshot(replacement(plan.expectedSnapshot, initial));
  const harness = replacingFailureAdapter(initial, unsafeSnapshot);
  const result = await applyRobloxChangeSet(harness.adapter, plan.changeSet);
  return { result, unsafeSnapshot, harness, manifest };
}

describe('transaction protocol', () => {
  it('applies a complete planned transition in deterministic operation order', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const adapter = createInMemoryRobloxAdapter({ initialSnapshots: [initial] });

    const result = await applyRobloxChangeSet(adapter, plan.changeSet);

    expect(result).toEqual({
      success: true,
      status: 'applied',
      snapshot: plan.expectedSnapshot,
      diagnostics: [],
      operationsAttempted: plan.changeSet.operations.length,
      initialSnapshotHash: plan.changeSet.preconditions.baseSnapshotHash,
      finalSnapshotHash: plan.changeSet.preconditions.resultSnapshotHash,
    });
    expect(adapter.mutationLog.map(({ type, nodeId }) => ({ type, nodeId }))).toEqual(
      plan.changeSet.operations.map((operation) => ({
        type: operation.type,
        nodeId:
          operation.type === 'create'
            ? operation.node.id
            : operation.type === 'update'
              ? operation.after.id
              : operation.before.id,
      })),
    );
    expect(adapter.mutationLog.every((entry) => entry.outcome === 'applied')).toBe(true);
    expect(adapter.snapshotReads).toBe(2);
  });

  it('applies only within the selected project scope', async () => {
    const manifest = compilePrimitiveFixture();
    const selectedInitial = emptySnapshotForManifest(manifest);
    const otherInitial = snapshotForProject(snapshotFromManifest(manifest), 'project-other');
    const otherScope: RobloxAdapterScope = {
      projectId: otherInitial.projectId,
      target: { service: 'Workspace' },
    };
    const otherHashBefore = hashRobloxSnapshot(otherInitial);
    const plan = requirePlan(selectedInitial, manifest);
    const adapter = createInMemoryRobloxAdapter({
      initialSnapshots: [selectedInitial, otherInitial],
    });

    const result = await applyRobloxChangeSet(adapter, plan.changeSet);

    expect(result.success).toBe(true);
    const otherAfter = await readSnapshot(adapter, otherScope);
    expect(otherAfter).toEqual(normalizeRobloxSnapshot(otherInitial));
    expect(hashRobloxSnapshot(otherAfter)).toBe(otherHashBefore);
    expect(
      adapter.mutationLog.every((entry) => entry.projectId === manifest.source.projectId),
    ).toBe(true);
  });

  it('returns a no-op without calling any mutation method', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = snapshotFromManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const adapter = createInMemoryRobloxAdapter({ initialSnapshots: [initial] });

    const result = await applyRobloxChangeSet(adapter, plan.changeSet);

    expect(plan.changeSet.operations).toEqual([]);
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        status: 'noop',
        operationsAttempted: 0,
        initialSnapshotHash: hashRobloxSnapshot(initial),
        finalSnapshotHash: hashRobloxSnapshot(initial),
      }),
    );
    expect(adapter.mutationAttempts).toBe(0);
    expect(adapter.mutationLog).toEqual([]);
    expect(adapter.snapshotReads).toBe(1);
  });

  it('returns a no-op after one read without observing a configured second value', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = snapshotFromManifest(manifest);
    const hypotheticalSecond = snapshotWithRenamedNode(
      initial,
      'plaza-floor',
      'Must never be observed',
    );
    const plan = requirePlan(initial, manifest);
    let reads = 0;
    let mutationCalls = 0;
    const adapter: RobloxAdapter = {
      readSnapshot: async (): Promise<unknown> => {
        reads += 1;
        return reads === 1 ? clone(initial) : clone(hypotheticalSecond);
      },
      createNode: async (): Promise<void> => {
        mutationCalls += 1;
      },
      updateNode: async (): Promise<void> => {
        mutationCalls += 1;
      },
      deleteNode: async (): Promise<void> => {
        mutationCalls += 1;
      },
    };

    const result = await applyRobloxChangeSet(adapter, plan.changeSet);

    expect(reads).toBe(1);
    expect(mutationCalls).toBe(0);
    expect(result).toEqual({
      success: true,
      status: 'noop',
      snapshot: normalizeRobloxSnapshot(initial),
      diagnostics: [],
      operationsAttempted: 0,
      initialSnapshotHash: hashRobloxSnapshot(initial),
      finalSnapshotHash: hashRobloxSnapshot(initial),
    });
    expect(result).not.toHaveProperty('rollback');
  });

  it('returns a no-op before optional mutation preparation', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = snapshotFromManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const backing = createInMemoryRobloxAdapter({ initialSnapshots: [initial] });
    let preparationCalls = 0;
    const adapter = adapterWithPreparation(backing, async () => {
      preparationCalls += 1;
      return { success: true };
    });

    const result = await applyRobloxChangeSet(adapter, plan.changeSet);

    expect(result).toEqual(
      expect.objectContaining({ success: true, status: 'noop', operationsAttempted: 0 }),
    );
    expect(preparationCalls).toBe(0);
    expect(backing.snapshotReads).toBe(1);
    expect(backing.mutationAttempts).toBe(0);
  });

  it('prepares after preflight and rereads the exact base before the first mutation', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const backing = createInMemoryRobloxAdapter({ initialSnapshots: [initial] });
    const events: string[] = [];
    const adapter: RobloxAdapter = {
      readSnapshot: async (scope): Promise<unknown> => {
        events.push('read');
        return backing.readSnapshot(scope);
      },
      prepareForMutation: async (input) => {
        events.push('prepare');
        expect(input.changeSetHash).toBe(hashRobloxChangeSet(plan.changeSet));
        expect(input.initialSnapshotHash).toBe(plan.changeSet.preconditions.baseSnapshotHash);
        expect(Object.isFrozen(input)).toBe(true);
        expect(Object.isFrozen(input.changeSet)).toBe(true);
        expect(Object.isFrozen(input.changeSet.operations)).toBe(true);
        expect(Object.isFrozen(input.initialSnapshot)).toBe(true);
        return { success: true };
      },
      createNode: async (scope, node): Promise<void> => {
        events.push('mutation');
        await backing.createNode(scope, node);
      },
      updateNode: async (scope, before, after): Promise<void> => {
        events.push('mutation');
        await backing.updateNode(scope, before, after);
      },
      deleteNode: async (scope, before): Promise<void> => {
        events.push('mutation');
        await backing.deleteNode(scope, before);
      },
    };

    const result = await applyRobloxChangeSet(adapter, plan.changeSet);

    expect(result.success).toBe(true);
    expect(events.slice(0, 4)).toEqual(['read', 'prepare', 'read', 'mutation']);
    expect(backing.snapshotReads).toBe(3);
  });

  it('returns a structured preparation failure without mutation or rollback', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const backing = createInMemoryRobloxAdapter({ initialSnapshots: [initial] });
    const adapter = adapterWithPreparation(backing, async () => ({
      success: false,
      diagnostics: [
        diagnostic(
          'transaction.apply_failed',
          '/preparation',
          'studio.sandbox_lease_conflict: The sandbox lease changed before claim.',
        ),
      ],
    }));

    const result = await applyRobloxChangeSet(adapter, plan.changeSet);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'apply',
        operationsAttempted: 0,
        rollback: { attempted: false, succeeded: false },
        initialSnapshotHash: plan.changeSet.preconditions.baseSnapshotHash,
        diagnostics: [
          expect.objectContaining({
            code: 'transaction.apply_failed',
            path: '/preparation',
            message: expect.stringContaining('studio.sandbox_lease_conflict'),
          }),
        ],
      }),
    );
    expect(backing.snapshotReads).toBe(1);
    expect(backing.mutationAttempts).toBe(0);
  });

  it('sanitizes a thrown preparation failure without mutation or rollback', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const backing = createInMemoryRobloxAdapter({ initialSnapshots: [initial] });
    const adapter = adapterWithPreparation(backing, async () => {
      throw new Error('LEASE_PRIVATE_VALUE at private-machine.ts:4');
    });

    const result = await applyRobloxChangeSet(adapter, plan.changeSet);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'apply',
        operationsAttempted: 0,
        rollback: { attempted: false, succeeded: false },
      }),
    );
    expect(JSON.stringify(result)).not.toContain('LEASE_PRIVATE_VALUE');
    expect(JSON.stringify(result)).not.toContain('private-machine.ts');
    expect(backing.snapshotReads).toBe(1);
    expect(backing.mutationAttempts).toBe(0);
  });

  it('rejects a changed post-preparation base without mutation or rollback', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = snapshotFromManifest(manifest);
    const desired = manifestWithRenamedNode(manifest, 'plaza-floor', 'Authorized rename');
    const plan = requirePlan(initial, desired);
    const changed = snapshotWithRenamedNode(initial, 'plaza-floor', 'Concurrent rename');
    let reads = 0;
    let mutationCalls = 0;
    const adapter: RobloxAdapter = {
      readSnapshot: async (): Promise<unknown> => {
        reads += 1;
        return clone(reads === 1 ? initial : changed);
      },
      prepareForMutation: async () => ({ success: true }),
      createNode: async (): Promise<void> => {
        mutationCalls += 1;
      },
      updateNode: async (): Promise<void> => {
        mutationCalls += 1;
      },
      deleteNode: async (): Promise<void> => {
        mutationCalls += 1;
      },
    };

    const result = await applyRobloxChangeSet(adapter, plan.changeSet);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'stale-check',
        operationsAttempted: 0,
        rollback: { attempted: false, succeeded: false },
        initialSnapshotHash: hashRobloxSnapshot(initial),
        observedFailureSnapshotHash: hashRobloxSnapshot(changed),
      }),
    );
    expect(reads).toBe(2);
    expect(mutationCalls).toBe(0);
  });

  it('does not prepare when pure preflight fails', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const tampered = clone(plan.changeSet);
    tampered.preconditions.desiredManifestHash = '0'.repeat(64);
    const backing = createInMemoryRobloxAdapter({ initialSnapshots: [initial] });
    let preparationCalls = 0;
    const adapter = adapterWithPreparation(backing, async () => {
      preparationCalls += 1;
      return { success: true };
    });

    const result = await applyRobloxChangeSet(adapter, tampered);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'preflight',
        operationsAttempted: 0,
        rollback: { attempted: false, succeeded: false },
      }),
    );
    expect(preparationCalls).toBe(0);
    expect(backing.snapshotReads).toBe(1);
    expect(backing.mutationAttempts).toBe(0);
  });

  it('preserves detailed malformed-operation diagnostics without reading the adapter', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const malformed = clone(plan.changeSet) as unknown as {
      operations: Array<{ node?: { className?: string } }>;
    };
    const first = malformed.operations[0];
    if (first?.node === undefined) throw new Error('Expected a leading create operation.');
    first.node.className = 'Script';
    const adapter = createInMemoryRobloxAdapter({ initialSnapshots: [initial] });

    const result = await applyRobloxChangeSet(adapter, malformed);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'change-set-validation',
        operationsAttempted: 0,
        rollback: { attempted: false, succeeded: false },
        diagnostics: [
          expect.objectContaining({
            code: 'transaction.change_set_invalid',
            path: '/operations/0/node/className',
            message: expect.stringContaining('contract.schema_invalid'),
          }),
        ],
      }),
    );
    expect(adapter.snapshotReads).toBe(0);
    expect(adapter.mutationAttempts).toBe(0);
  });

  it('preserves detailed invalid-snapshot diagnostics from the adapter boundary', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = snapshotFromManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const malformed = clone(initial) as unknown as {
      nodes: Array<{ className?: string }>;
    };
    const first = malformed.nodes[0];
    if (first === undefined) throw new Error('Expected a managed fixture node.');
    first.className = 'Script';
    let mutationCalls = 0;
    const adapter: RobloxAdapter = {
      readSnapshot: async (): Promise<unknown> => malformed,
      createNode: async (): Promise<void> => {
        mutationCalls += 1;
      },
      updateNode: async (): Promise<void> => {
        mutationCalls += 1;
      },
      deleteNode: async (): Promise<void> => {
        mutationCalls += 1;
      },
    };

    const result = await applyRobloxChangeSet(adapter, plan.changeSet);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'snapshot-validation',
        diagnostics: [
          expect.objectContaining({
            code: 'transaction.snapshot_invalid',
            path: '/nodes/0/className',
            message: expect.stringContaining('contract.schema_invalid'),
          }),
        ],
        operationsAttempted: 0,
        rollback: { attempted: false, succeeded: false },
      }),
    );
    expect(mutationCalls).toBe(0);
  });

  it('preserves detailed invalid final-snapshot diagnostics before verified rollback', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = snapshotFromManifest(manifest);
    const desired = manifestWithRenamedNode(manifest, 'plaza-floor', 'Transaction rename');
    const plan = requirePlan(initial, desired);
    const backing = createInMemoryRobloxAdapter({ initialSnapshots: [initial] });
    const malformedFinal = clone(plan.expectedSnapshot) as unknown as {
      nodes: Array<{ className?: string }>;
    };
    const first = malformedFinal.nodes[0];
    if (first === undefined) throw new Error('Expected a managed fixture node.');
    first.className = 'Script';
    let reads = 0;
    const adapter: RobloxAdapter = {
      readSnapshot: async (scope): Promise<unknown> => {
        reads += 1;
        return reads === 2 ? malformedFinal : backing.readSnapshot(scope);
      },
      createNode: async (scope, node): Promise<void> => backing.createNode(scope, node),
      updateNode: async (scope, before, after): Promise<void> =>
        backing.updateNode(scope, before, after),
      deleteNode: async (scope, before): Promise<void> => backing.deleteNode(scope, before),
    };

    const result = await applyRobloxChangeSet(adapter, plan.changeSet);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'verification',
        diagnostics: [
          expect.objectContaining({
            code: 'transaction.verification_failed',
            path: '/nodes/0/className',
            message: expect.stringContaining('contract.schema_invalid'),
          }),
        ],
        observedFailureSnapshotHash: hashRobloxSnapshot(plan.expectedSnapshot),
        rollback: {
          attempted: true,
          succeeded: true,
          restoredSnapshotHash: hashRobloxSnapshot(initial),
        },
      }),
    );
    expect(reads).toBe(4);
    expect(await readSnapshot(backing, scopeFor(manifest))).toEqual(
      normalizeRobloxSnapshot(initial),
    );
  });

  it('preserves desired-manifest mismatch paths and related IDs through preflight', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const tampered = clone(plan.changeSet);
    tampered.preconditions.desiredManifestHash = '0'.repeat(64);
    const adapter = createInMemoryRobloxAdapter({ initialSnapshots: [initial] });

    const result = await applyRobloxChangeSet(adapter, tampered);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'preflight',
        operationsAttempted: 0,
        rollback: { attempted: false, succeeded: false },
        diagnostics: [
          expect.objectContaining({
            code: 'transaction.preflight_failed',
            path: '/preconditions/desiredManifestHash',
            message: expect.stringContaining('simulation.desired_manifest_hash_mismatch'),
            relatedId: manifest.rootNodeId,
          }),
        ],
      }),
    );
    expect(adapter.snapshotReads).toBe(1);
    expect(adapter.mutationAttempts).toBe(0);
  });

  it('rejects a correctly ordered delete-all transition during preflight', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = snapshotFromManifest(manifest);
    const empty = emptySnapshotForManifest(manifest);
    const seedPlan = requirePlan(initial, manifest);
    const transition = planRobloxSnapshotTransition(initial, empty);
    expect(transition.success).toBe(true);
    if (!transition.success) throw new Error('Expected a valid delete-all snapshot transition.');
    expect(transition.operations).toHaveLength(initial.nodes.length);
    expect(transition.operations.every((operation) => operation.type === 'delete')).toBe(true);
    const deleteAll = {
      schemaVersion: seedPlan.changeSet.schemaVersion,
      compilerVersion: seedPlan.changeSet.compilerVersion,
      preconditions: {
        ...clone(seedPlan.changeSet.preconditions),
        resultSnapshotHash: hashRobloxSnapshot(empty),
      },
      operations: [...transition.operations],
      summary: {
        creates: 0,
        updates: 0,
        deletes: transition.operations.length,
        total: transition.operations.length,
      },
    };
    const adapter = createInMemoryRobloxAdapter({ initialSnapshots: [initial] });

    const result = await applyRobloxChangeSet(adapter, deleteAll);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'preflight',
        operationsAttempted: 0,
        rollback: { attempted: false, succeeded: false },
        diagnostics: [
          expect.objectContaining({
            code: 'transaction.preflight_failed',
            message: expect.stringContaining('simulation.desired_manifest_invalid'),
          }),
        ],
      }),
    );
    expect(adapter.snapshotReads).toBe(1);
    expect(adapter.mutationAttempts).toBe(0);
    expect(adapter.mutationLog).toEqual([]);
  });

  it('rejects a stale complete snapshot before calling any mutation method', async () => {
    const manifest = compilePrimitiveFixture();
    const plannedBase = snapshotFromManifest(manifest);
    const plan = requirePlan(plannedBase, manifest);
    const observed = clone(plannedBase);
    const observedNode = observed.nodes.find((node) => node.id === 'plaza-floor');
    if (observedNode === undefined) throw new Error('Missing fixture node: plaza-floor');
    observedNode.name = 'Out-of-band observed name';
    const adapter = createInMemoryRobloxAdapter({ initialSnapshots: [observed] });

    const result = await applyRobloxChangeSet(adapter, plan.changeSet);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'stale-check',
        operationsAttempted: 0,
        rollback: { attempted: false, succeeded: false },
        initialSnapshotHash: hashRobloxSnapshot(observed),
        diagnostics: [expect.objectContaining({ code: 'transaction.stale_snapshot' })],
      }),
    );
    expect(adapter.mutationAttempts).toBe(0);
    if (result.success) throw new Error('Expected stale-plan failure.');

    const repeated = await applyRobloxChangeSet(adapter, plan.changeSet);
    expect(repeated.success).toBe(false);
    if (repeated.success) throw new Error('Expected repeated stale-plan failure.');
    expect(repeated.rollback).toEqual({ attempted: false, succeeded: false });
    expect(repeated.rollback).not.toBe(result.rollback);
  });

  it('verifies the original state when failure occurs before the first mutation', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const adapter = createInMemoryRobloxAdapter({
      initialSnapshots: [initial],
      faults: [inMemoryRobloxFault(1, 'throw-before')],
    });

    const result = await applyRobloxChangeSet(adapter, plan.changeSet);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'apply',
        operationsAttempted: 1,
        observedFailureSnapshotHash: hashRobloxSnapshot(initial),
        rollback: {
          attempted: true,
          succeeded: true,
          restoredSnapshotHash: hashRobloxSnapshot(initial),
        },
      }),
    );
    expect(adapter.mutationLog.map((entry) => entry.outcome)).toEqual(['threw-before']);
    expect(await readSnapshot(adapter, scopeFor(manifest))).toEqual(
      normalizeRobloxSnapshot(initial),
    );
  });

  it('sanitizes a hostile throw-before error and verifies restoration after prior mutation', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const hostile = 'PRIVATE TOKEN\n    at maliciousAdapter (secret.ts:1:1)';
    const adapter = createInMemoryRobloxAdapter({
      initialSnapshots: [initial],
      faults: [inMemoryRobloxFault(2, 'throw-before', hostile)],
    });

    const result = await applyRobloxChangeSet(adapter, plan.changeSet);

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
        diagnostics: [expect.objectContaining({ code: 'transaction.apply_failed' })],
      }),
    );
    expect(JSON.stringify(result)).not.toContain(hostile);
    expect(JSON.stringify(result)).not.toContain('PRIVATE TOKEN');
    expect(adapter.mutationLog.map((entry) => entry.outcome)).toEqual([
      'applied',
      'threw-before',
      'applied',
    ]);
    expect(await readSnapshot(adapter, scopeFor(manifest))).toEqual(
      normalizeRobloxSnapshot(initial),
    );
  });

  it('observes throw-after partial mutation and compensates to the exact initial state', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const adapter = createInMemoryRobloxAdapter({
      initialSnapshots: [initial],
      faults: [inMemoryRobloxFault(2, 'throw-after')],
    });

    const result = await applyRobloxChangeSet(adapter, plan.changeSet);
    const first = plan.changeSet.operations[0];
    const second = plan.changeSet.operations[1];
    if (first?.type !== 'create' || second?.type !== 'create') {
      throw new Error('Expected the fixture plan to begin with creates.');
    }
    const observedFailure = normalizeRobloxSnapshot({
      ...clone(initial),
      rootNodeId: first.node.id,
      nodes: [clone(first.node), clone(second.node)],
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'apply',
        operationsAttempted: 2,
        initialSnapshotHash: hashRobloxSnapshot(initial),
        observedFailureSnapshotHash: hashRobloxSnapshot(observedFailure),
        rollback: {
          attempted: true,
          succeeded: true,
          restoredSnapshotHash: hashRobloxSnapshot(initial),
        },
      }),
    );
    expect(hashRobloxSnapshot(observedFailure)).not.toBe(hashRobloxSnapshot(initial));
    expect(adapter.mutationLog.map(({ type, outcome }) => ({ type, outcome }))).toEqual([
      { type: 'create', outcome: 'applied' },
      { type: 'create', outcome: 'threw-after' },
      { type: 'delete', outcome: 'applied' },
      { type: 'delete', outcome: 'applied' },
    ]);
    expect(await readSnapshot(adapter, scopeFor(manifest))).toEqual(
      normalizeRobloxSnapshot(initial),
    );
  });

  it('detects a skipped final mutation during verification and rolls back every applied node', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const operationCount = plan.changeSet.operations.length;
    const adapter = createInMemoryRobloxAdapter({
      initialSnapshots: [initial],
      faults: [inMemoryRobloxFault(operationCount, 'skip')],
    });

    const result = await applyRobloxChangeSet(adapter, plan.changeSet);
    const restored = await readSnapshot(adapter, scopeFor(manifest));
    const skippedOperation = plan.changeSet.operations.at(-1);
    if (skippedOperation?.type !== 'create') {
      throw new Error('Expected the fixture plan to end with a create.');
    }
    const observedFailure = snapshotWithoutNode(plan.expectedSnapshot, skippedOperation.node.id);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'verification',
        operationsAttempted: operationCount,
        observedFailureSnapshotHash: hashRobloxSnapshot(observedFailure),
        diagnostics: [expect.objectContaining({ code: 'transaction.verification_failed' })],
        rollback: {
          attempted: true,
          succeeded: true,
          restoredSnapshotHash: hashRobloxSnapshot(initial),
        },
      }),
    );
    expect(adapter.mutationLog[operationCount - 1]?.outcome).toBe('skipped');
    expect(restored).toEqual(normalizeRobloxSnapshot(initial));
  });

  it('verifies rollback with the full hash, including unmanaged-root markers', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = snapshotFromManifest(manifest, [
      {
        snapshotId: 'unmanaged-fountain-decoration',
        parentNodeId: 'fountain-water',
        name: 'Artist Decoration',
      },
    ]);
    const desired = manifestWithRenamedNode(manifest, 'plaza-floor', 'Renamed Plaza Floor');
    const plan = requirePlan(initial, desired);
    const adapter = createInMemoryRobloxAdapter({
      initialSnapshots: [initial],
      faults: [inMemoryRobloxFault(1, 'throw-after')],
    });

    const result = await applyRobloxChangeSet(adapter, plan.changeSet);

    expect(plan.changeSet.operations).toHaveLength(1);
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'apply',
        rollback: {
          attempted: true,
          succeeded: true,
          restoredSnapshotHash: hashRobloxSnapshot(initial),
        },
      }),
    );
    const restored = await readSnapshot(adapter, scopeFor(manifest));
    expect(restored).toEqual(normalizeRobloxSnapshot(initial));
    expect(restored.unmanagedRoots).toEqual(initial.unmanagedRoots);
  });

  const unsafeRollbackCases: readonly {
    readonly name: string;
    readonly expectedPath: string;
    readonly unmanagedRoots?: RobloxSnapshot['unmanagedRoots'];
    readonly replacement: UnsafeReplacement;
  }[] = [
    {
      name: 'an unrelated managed property change',
      expectedPath: '/nodes/north-wall',
      replacement: (expected) =>
        snapshotWithRenamedNode(expected, 'north-wall', 'Concurrent unrelated rename'),
    },
    {
      name: 'an unrelated managed addition',
      expectedPath: '/nodes/concurrent-extra',
      replacement: (expected) =>
        snapshotWithAdditionalNode(expected, 'north-wall', 'concurrent-extra'),
    },
    {
      name: 'an unrelated managed deletion',
      expectedPath: '/nodes/north-wall',
      replacement: (expected) => snapshotWithoutNode(expected, 'north-wall'),
    },
    {
      name: 'a newly added unmanaged root',
      expectedPath: '/unmanagedRoots',
      replacement: (expected) => ({
        ...clone(expected),
        unmanagedRoots: [
          ...expected.unmanagedRoots.map((root) => clone(root)),
          {
            snapshotId: 'concurrent-unmanaged-root',
            parentNodeId: 'north-wall',
            name: 'Concurrent artist content',
          },
        ],
      }),
    },
    {
      name: 'a renamed unmanaged-root record',
      expectedPath: '/unmanagedRoots',
      unmanagedRoots: [
        {
          snapshotId: 'artist-owned-root',
          parentNodeId: 'north-wall',
          name: 'Artist content',
        },
      ],
      replacement: (expected) => ({
        ...clone(expected),
        unmanagedRoots: expected.unmanagedRoots.map((root) => ({
          ...clone(root),
          name: 'Concurrent renamed artist content',
        })),
      }),
    },
    {
      name: 'an attempted target in a third state',
      expectedPath: '/nodes/plaza-floor',
      replacement: (expected) =>
        snapshotWithRenamedNode(expected, 'plaza-floor', 'Concurrent third state'),
    },
  ];

  it.each(unsafeRollbackCases)(
    'blocks compensation after observing $name',
    async ({ expectedPath, replacement, unmanagedRoots }) => {
      const { result, unsafeSnapshot, harness, manifest } = await runUnsafeRollback(
        replacement,
        unmanagedRoots,
      );
      const unsafeHash = hashRobloxSnapshot(unsafeSnapshot);

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected unsafe rollback failure.');
      expect(result).toEqual(
        expect.objectContaining({
          stage: 'apply',
          operationsAttempted: 1,
          observedFailureSnapshotHash: unsafeHash,
          rollback: {
            attempted: true,
            succeeded: false,
            diagnostics: [
              expect.objectContaining({
                code: 'transaction.rollback_unsafe_observed_state',
                path: expectedPath,
              }),
            ],
          },
        }),
      );
      expect(result.rollback).not.toHaveProperty('observedAfterRollbackSnapshotHash');
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
      expect(harness.mutationCalls()).toBe(1);
      expect(harness.backing.mutationLog).toEqual([
        expect.objectContaining({
          attempt: 1,
          type: 'update',
          nodeId: 'plaza-floor',
          projectId: manifest.source.projectId,
          outcome: 'applied',
        }),
      ]);
      expect(await readSnapshot(harness.backing, scopeFor(manifest))).toEqual(unsafeSnapshot);
    },
  );

  it('evaluates an unsafe rollback envelope deterministically', async () => {
    const replacement: UnsafeReplacement = (expected) =>
      snapshotWithRenamedNode(expected, 'north-wall', 'Concurrent unrelated rename');
    const first = await runUnsafeRollback(replacement);
    const second = await runUnsafeRollback(replacement);
    expect(first.result.success).toBe(false);
    expect(second.result.success).toBe(false);
    if (first.result.success || second.result.success) {
      throw new Error('Expected deterministic unsafe rollback failures.');
    }
    expect(first.result.diagnostics).toEqual(second.result.diagnostics);
    expect(first.result.rollback).toEqual(second.result.rollback);
  });

  it('leaves another project untouched when unsafe selected-project state blocks rollback', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = snapshotFromManifest(manifest);
    const otherInitial = snapshotForProject(initial, 'project-other');
    const desired = manifestWithRenamedNode(manifest, 'plaza-floor', 'Transaction rename');
    const plan = requirePlan(initial, desired);
    const unsafeSnapshot = snapshotWithAdditionalNode(
      plan.expectedSnapshot,
      'north-wall',
      'concurrent-extra',
    );
    const harness = replacingFailureAdapter(initial, unsafeSnapshot, [otherInitial]);

    const result = await applyRobloxChangeSet(harness.adapter, plan.changeSet);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected unsafe rollback failure.');
    expect(result.rollback).toEqual(
      expect.objectContaining({
        attempted: true,
        succeeded: false,
        diagnostics: [
          expect.objectContaining({ code: 'transaction.rollback_unsafe_observed_state' }),
        ],
      }),
    );
    const otherScope: RobloxAdapterScope = {
      projectId: otherInitial.projectId,
      target: { service: 'Workspace' },
    };
    expect(await readSnapshot(harness.backing, otherScope)).toEqual(
      normalizeRobloxSnapshot(otherInitial),
    );
    expect(
      harness.backing.mutationLog.every((entry) => entry.projectId === manifest.source.projectId),
    ).toBe(true);
  });

  it('reports deterministic rollback failure when a compensating operation faults', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const first = plan.changeSet.operations[0];
    const second = plan.changeSet.operations[1];
    if (first?.type !== 'create' || second?.type !== 'create') {
      throw new Error('Expected the fixture plan to begin with creates.');
    }
    const adapter = createInMemoryRobloxAdapter({
      initialSnapshots: [initial],
      faults: [
        inMemoryRobloxFault(2, 'throw-after'),
        inMemoryRobloxFault(3, 'throw-before', 'ROLLBACK SECRET'),
      ],
    });

    const result = await applyRobloxChangeSet(adapter, plan.changeSet);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'apply',
        operationsAttempted: 2,
        rollback: {
          attempted: true,
          succeeded: false,
          diagnostics: [expect.objectContaining({ code: 'transaction.rollback_failed' })],
          observedAfterRollbackSnapshotHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
      }),
    );
    expect(JSON.stringify(result)).not.toContain('ROLLBACK SECRET');
    expect(adapter.mutationLog).toEqual([
      {
        attempt: 1,
        type: 'create',
        nodeId: first.node.id,
        projectId: manifest.source.projectId,
        target: { service: 'Workspace' },
        outcome: 'applied',
      },
      {
        attempt: 2,
        type: 'create',
        nodeId: second.node.id,
        projectId: manifest.source.projectId,
        target: { service: 'Workspace' },
        outcome: 'threw-after',
      },
      {
        attempt: 3,
        type: 'delete',
        nodeId: second.node.id,
        projectId: manifest.source.projectId,
        target: { service: 'Workspace' },
        outcome: 'threw-before',
      },
    ]);
  });

  it('reports the actual complete state hash when rollback mutates and then throws', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const first = plan.changeSet.operations[0];
    const second = plan.changeSet.operations[1];
    if (first?.type !== 'create' || second?.type !== 'create') {
      throw new Error('Expected the fixture plan to begin with creates.');
    }
    const adapter = createInMemoryRobloxAdapter({
      initialSnapshots: [initial],
      faults: [inMemoryRobloxFault(2, 'throw-after'), inMemoryRobloxFault(3, 'throw-after')],
    });

    const result = await applyRobloxChangeSet(adapter, plan.changeSet);
    const actual = await readSnapshot(adapter, scopeFor(manifest));
    const actualHash = hashRobloxSnapshot(actual);
    const observedFailure = normalizeRobloxSnapshot({
      ...clone(initial),
      rootNodeId: first.node.id,
      nodes: [clone(first.node), clone(second.node)],
    });
    const observedFailureHash = hashRobloxSnapshot(observedFailure);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected rollback failure.');
    expect(result.stage).toBe('apply');
    expect(result.observedFailureSnapshotHash).toBe(observedFailureHash);
    expect(result.observedFailureSnapshotHash).not.toBe(actualHash);
    expect(result.rollback).toEqual(
      expect.objectContaining({
        attempted: true,
        succeeded: false,
        observedAfterRollbackSnapshotHash: actualHash,
        diagnostics: [expect.objectContaining({ code: 'transaction.rollback_failed' })],
      }),
    );
    expect(actual.nodes.map((node) => node.id)).toEqual([first.node.id]);
    expect(adapter.mutationLog.map((entry) => entry.outcome)).toEqual([
      'applied',
      'threw-after',
      'threw-after',
    ]);
  });

  it('sanitizes hostile adapter read failures without attempting rollback or mutation', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = emptySnapshotForManifest(manifest);
    const plan = requirePlan(initial, manifest);
    const hostileAdapter = {
      readSnapshot: async (): Promise<unknown> => {
        throw new Error('PASSWORD=secret\n    at hostile.ts:4:2');
      },
      createNode: async (): Promise<void> => {
        throw new Error('must not be called');
      },
      updateNode: async (): Promise<void> => {
        throw new Error('must not be called');
      },
      deleteNode: async (): Promise<void> => {
        throw new Error('must not be called');
      },
    };

    const result = await applyRobloxChangeSet(hostileAdapter, plan.changeSet);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'snapshot-read',
        operationsAttempted: 0,
        rollback: { attempted: false, succeeded: false },
        diagnostics: [expect.objectContaining({ code: 'transaction.snapshot_invalid' })],
      }),
    );
    expect(JSON.stringify(result)).not.toContain('PASSWORD');
    expect(JSON.stringify(result)).not.toContain('hostile.ts');
  });
});
