import { describe, expect, it } from 'vitest';

import { planRobloxChangeSet } from '../src/reconcile.js';
import { simulateRobloxChangeSet } from '../src/simulate.js';
import type {
  RobloxChangeSet,
  RobloxManifest,
  RobloxPartNode,
  RobloxSnapshot,
} from '../src/types.js';
import {
  clone,
  compilePrimitiveFixture,
  emptySnapshotForManifest,
  nodeById,
  snapshotFromManifest,
} from './helpers.js';

function planOrThrow(
  current: unknown,
  desired: unknown,
): {
  readonly changeSet: RobloxChangeSet;
  readonly expectedSnapshot: RobloxSnapshot;
} {
  const result = planRobloxChangeSet(current, desired);
  if (!result.success) throw new Error(JSON.stringify(result.diagnostics));
  return result;
}

function snapshotPart(snapshot: RobloxSnapshot, id: string): RobloxPartNode {
  const node = snapshot.nodes.find((entry) => entry.id === id);
  if (node === undefined || node.className !== 'Part') throw new Error(`Expected Part ${id}.`);
  return node;
}

function obsoletePart(manifest: Readonly<RobloxManifest>): RobloxPartNode {
  const node = clone(nodeById(manifest, 'north-wall'));
  if (node.className !== 'Part') throw new Error('Expected fixture Part.');
  return {
    ...node,
    id: 'obsolete-leaf',
    name: 'Obsolete Leaf',
    parentId: 'courtyard-details',
    attributes: { ...node.attributes, WorldwrightEntityId: 'obsolete-leaf' },
  };
}

function expectSimulationFailureCode(snapshot: unknown, changeSet: unknown, code: string): void {
  const result = simulateRobloxChangeSet(snapshot, changeSet);
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.diagnostics.map((entry) => entry.code)).toContain(code);
}

describe('pure Roblox change-set simulation', () => {
  it('applies a complete create plan to the exact expected result', () => {
    const manifest = compilePrimitiveFixture();
    const current = emptySnapshotForManifest(manifest);
    const plan = planOrThrow(current, manifest);

    const result = simulateRobloxChangeSet(current, plan.changeSet);

    expect(result).toEqual({ success: true, snapshot: plan.expectedSnapshot, diagnostics: [] });
  });

  it('applies a complete update plan to the exact expected result', () => {
    const manifest = compilePrimitiveFixture();
    const current = snapshotFromManifest(manifest);
    snapshotPart(current, 'north-wall').properties.transparency = 0.4;
    const plan = planOrThrow(current, manifest);

    const result = simulateRobloxChangeSet(current, plan.changeSet);

    expect(result).toEqual({ success: true, snapshot: plan.expectedSnapshot, diagnostics: [] });
  });

  it('applies a complete delete plan to the exact expected result', () => {
    const manifest = compilePrimitiveFixture();
    const current = snapshotFromManifest(manifest);
    current.nodes.push(obsoletePart(manifest));
    const plan = planOrThrow(current, manifest);

    const result = simulateRobloxChangeSet(current, plan.changeSet);

    expect(result).toEqual({ success: true, snapshot: plan.expectedSnapshot, diagnostics: [] });
    if (result.success) {
      expect(result.snapshot.nodes.some((node) => node.id === 'obsolete-leaf')).toBe(false);
    }
  });

  it('simulates a no-op change set without changing state', () => {
    const manifest = compilePrimitiveFixture();
    const current = snapshotFromManifest(manifest);
    const plan = planOrThrow(current, manifest);

    const result = simulateRobloxChangeSet(current, plan.changeSet);

    expect(plan.changeSet.operations).toEqual([]);
    expect(result).toEqual({ success: true, snapshot: plan.expectedSnapshot, diagnostics: [] });
  });

  it('rejects a stale base hash, including a snapshot changed only by unmanaged content', () => {
    const manifest = compilePrimitiveFixture();
    const current = snapshotFromManifest(manifest);
    snapshotPart(current, 'south-wall').properties.transparency = 0.2;
    const plan = planOrThrow(current, manifest);
    const stale = clone(current);
    stale.unmanagedRoots.push({
      snapshotId: 'new-user-content',
      parentNodeId: 'north-wall',
      name: 'New User Content',
    });

    expectSimulationFailureCode(stale, plan.changeSet, 'simulation.stale_snapshot');
  });

  it('rejects an update whose complete before state does not match', () => {
    const manifest = compilePrimitiveFixture();
    const current = snapshotFromManifest(manifest);
    snapshotPart(current, 'north-wall').properties.transparency = 0.4;
    const plan = planOrThrow(current, manifest);
    const operation = plan.changeSet.operations[0];
    if (operation === undefined || operation.type !== 'update') {
      throw new Error('Expected update operation.');
    }
    operation.before.name = 'Tampered Before Name';

    expectSimulationFailureCode(current, plan.changeSet, 'simulation.before_state_mismatch');
  });

  it('rejects create operations that are not in canonical ancestor-first order', () => {
    const manifest = compilePrimitiveFixture();
    const current = emptySnapshotForManifest(manifest);
    const plan = planOrThrow(current, manifest);
    const rootIndex = plan.changeSet.operations.findIndex(
      (operation) => operation.type === 'create' && operation.node.id === manifest.rootNodeId,
    );
    const childIndex = plan.changeSet.operations.findIndex(
      (operation) => operation.type === 'create' && operation.node.parentId === manifest.rootNodeId,
    );
    if (rootIndex < 0 || childIndex < 0) throw new Error('Expected root and child creates.');
    const root = plan.changeSet.operations[rootIndex];
    const child = plan.changeSet.operations[childIndex];
    if (root === undefined || child === undefined) throw new Error('Expected operations.');
    plan.changeSet.operations[rootIndex] = child;
    plan.changeSet.operations[childIndex] = root;

    expectSimulationFailureCode(current, plan.changeSet, 'simulation.operation_order_invalid');
  });

  it('rejects duplicate operations affecting the same managed node', () => {
    const manifest = compilePrimitiveFixture();
    const current = snapshotFromManifest(manifest);
    snapshotPart(current, 'north-wall').properties.transparency = 0.4;
    const plan = planOrThrow(current, manifest);
    const operation = plan.changeSet.operations[0];
    if (operation === undefined || operation.type !== 'update') {
      throw new Error('Expected update operation.');
    }
    plan.changeSet.operations.push(clone(operation));
    plan.changeSet.summary.updates += 1;
    plan.changeSet.summary.total += 1;

    expectSimulationFailureCode(current, plan.changeSet, 'simulation.change_set_invalid');
  });

  it('rejects a simulated result containing a managed parent cycle', () => {
    const manifest = compilePrimitiveFixture();
    const current = snapshotFromManifest(manifest);
    const region = current.nodes.find((node) => node.id === 'courtyard-region');
    const structure = current.nodes.find((node) => node.id === 'courtyard-structure');
    if (region === undefined || structure === undefined) {
      throw new Error('Expected fixture containers.');
    }
    region.name = 'Old Region';
    structure.name = 'Old Structure';
    const plan = planOrThrow(current, manifest);
    for (const operation of plan.changeSet.operations) {
      if (operation.type !== 'update') continue;
      if (operation.after.id === 'courtyard-region') {
        operation.after.parentId = 'courtyard-structure';
      }
      if (operation.after.id === 'courtyard-structure') {
        operation.after.parentId = 'courtyard-region';
      }
    }

    expectSimulationFailureCode(current, plan.changeSet, 'simulation.parent_cycle');
  });

  it('rejects an operation that would produce a node with a missing parent', () => {
    const manifest = compilePrimitiveFixture();
    const current = emptySnapshotForManifest(manifest);
    const plan = planOrThrow(current, manifest);
    const operation = plan.changeSet.operations.find(
      (entry) => entry.type === 'create' && entry.node.id === 'north-wall',
    );
    if (operation === undefined || operation.type !== 'create') {
      throw new Error('Expected north-wall create.');
    }
    operation.node.parentId = 'missing-parent';

    const result = simulateRobloxChangeSet(current, plan.changeSet);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected missing-parent simulation failure.');
    expect(result.diagnostics.map((entry) => entry.code)).toContain('simulation.parent_missing');
    expect(result.diagnostics.map((entry) => entry.code)).not.toContain('simulation.parent_cycle');
  });

  it('rejects a result snapshot hash mismatch after otherwise valid simulation', () => {
    const manifest = compilePrimitiveFixture();
    const current = emptySnapshotForManifest(manifest);
    const plan = planOrThrow(current, manifest);
    plan.changeSet.preconditions.resultSnapshotHash = '0'.repeat(64);

    expectSimulationFailureCode(current, plan.changeSet, 'simulation.result_hash_mismatch');
  });

  it('preserves unmanaged-root records byte-for-byte through unrelated updates', () => {
    const manifest = compilePrimitiveFixture();
    const unmanaged = [
      { snapshotId: 'user-detail', parentNodeId: 'north-wall', name: 'User Detail' },
    ];
    const current = snapshotFromManifest(manifest, unmanaged);
    snapshotPart(current, 'south-wall').properties.transparency = 0.2;
    const plan = planOrThrow(current, manifest);

    const result = simulateRobloxChangeSet(current, plan.changeSet);

    expect(result.success).toBe(true);
    if (result.success) expect(result.snapshot.unmanagedRoots).toEqual(unmanaged);
  });

  it('never mutates the snapshot or change set, including on failure', () => {
    const manifest = compilePrimitiveFixture();
    const current = snapshotFromManifest(manifest);
    snapshotPart(current, 'north-wall').properties.transparency = 0.4;
    const plan = planOrThrow(current, manifest);
    const currentBefore = clone(current);
    const changeSetBefore = clone(plan.changeSet);

    const success = simulateRobloxChangeSet(current, plan.changeSet);

    expect(success.success).toBe(true);
    expect(current).toEqual(currentBefore);
    expect(plan.changeSet).toEqual(changeSetBefore);

    plan.changeSet.preconditions.resultSnapshotHash = '0'.repeat(64);
    const tamperedBefore = clone(plan.changeSet);
    const failure = simulateRobloxChangeSet(current, plan.changeSet);
    expect(failure.success).toBe(false);
    expect(current).toEqual(currentBefore);
    expect(plan.changeSet).toEqual(tamperedBefore);
  });
});
