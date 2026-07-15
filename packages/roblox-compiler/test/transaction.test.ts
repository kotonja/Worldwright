import { describe, expect, it } from 'vitest';

import { validateRobloxSnapshot } from '../src/contract-validation.js';
import { hashRobloxSnapshot, normalizeRobloxSnapshot } from '../src/normalize.js';
import { planRobloxChangeSet } from '../src/reconcile.js';
import {
  createInMemoryRobloxAdapter,
  inMemoryRobloxFault,
  type InMemoryRobloxAdapter,
} from '../src/testing.js';
import { applyRobloxChangeSet } from '../src/transaction.js';
import type {
  PlanSuccess,
  RobloxAdapterScope,
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
        observedFinalSnapshotHash: hashRobloxSnapshot(initial),
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

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        stage: 'verification',
        operationsAttempted: operationCount,
        observedFinalSnapshotHash: hashRobloxSnapshot(restored),
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
          observedSnapshotHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
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

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected rollback failure.');
    expect(result.stage).toBe('apply');
    expect(result.observedFinalSnapshotHash).toBe(actualHash);
    expect(result.rollback).toEqual(
      expect.objectContaining({
        attempted: true,
        succeeded: false,
        observedSnapshotHash: actualHash,
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
