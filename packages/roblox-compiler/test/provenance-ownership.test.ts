import { describe, expect, it } from 'vitest';

import { ROBLOX_CHANGE_SET_VERSION, ROBLOX_COMPILER_VERSION } from '../src/contract-schema.js';
import { deriveRobloxManifestFromDesiredSnapshot } from '../src/desired-manifest.js';
import {
  hashRobloxManifest,
  hashRobloxSnapshot,
  stringifyRobloxManifest,
} from '../src/normalize.js';
import { planRobloxChangeSet, planRobloxSnapshotTransition } from '../src/reconcile.js';
import { simulateRobloxChangeSet } from '../src/simulate.js';
import type {
  RobloxChangeOperation,
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
  current: Readonly<RobloxSnapshot>,
  manifest: Readonly<RobloxManifest>,
): { readonly changeSet: RobloxChangeSet; readonly expectedSnapshot: RobloxSnapshot } {
  const result = planRobloxChangeSet(current, manifest);
  if (!result.success) throw new Error(JSON.stringify(result.diagnostics));
  return result;
}

function derivedManifestHashOrThrow(snapshot: Readonly<RobloxSnapshot>): string {
  const result = deriveRobloxManifestFromDesiredSnapshot(snapshot);
  if (!result.success) throw new Error(JSON.stringify(result.diagnostics));
  return hashRobloxManifest(result.manifest);
}

function part(snapshot: Readonly<RobloxSnapshot>, id: string): RobloxPartNode {
  const node = snapshot.nodes.find((entry) => entry.id === id);
  if (node === undefined || node.className !== 'Part') throw new Error(`Expected Part ${id}.`);
  return node;
}

function changeSetForOperations(
  current: Readonly<RobloxSnapshot>,
  result: Readonly<RobloxSnapshot>,
  operations: readonly RobloxChangeOperation[],
  desiredManifestHash: string,
): RobloxChangeSet {
  const creates = operations.filter((operation) => operation.type === 'create').length;
  const updates = operations.filter((operation) => operation.type === 'update').length;
  const deletes = operations.filter((operation) => operation.type === 'delete').length;
  return {
    schemaVersion: ROBLOX_CHANGE_SET_VERSION,
    compilerVersion: ROBLOX_COMPILER_VERSION,
    preconditions: {
      projectId: current.projectId,
      target: current.target,
      baseSnapshotHash: hashRobloxSnapshot(current),
      desiredManifestHash,
      resultSnapshotHash: hashRobloxSnapshot(result),
    },
    operations: clone([...operations]),
    summary: { creates, updates, deletes, total: operations.length },
  };
}

describe('desired-manifest provenance', () => {
  it('reconstructs every planner result to the exact desired manifest hash', () => {
    const manifest = compilePrimitiveFixture();
    const plan = planOrThrow(emptySnapshotForManifest(manifest), manifest);

    const derived = deriveRobloxManifestFromDesiredSnapshot(plan.expectedSnapshot);

    expect(derived.success).toBe(true);
    if (!derived.success) return;
    expect(hashRobloxManifest(derived.manifest)).toBe(
      plan.changeSet.preconditions.desiredManifestHash,
    );
    expect(
      simulateRobloxChangeSet(emptySnapshotForManifest(manifest), plan.changeSet).success,
    ).toBe(true);
  });

  it('rejects a false desired-manifest hash even when the result snapshot hash matches', () => {
    const manifest = compilePrimitiveFixture();
    const current = snapshotFromManifest(manifest);
    const plan = planOrThrow(current, manifest);
    plan.changeSet.preconditions.desiredManifestHash = '0'.repeat(64);

    const result = simulateRobloxChangeSet(current, plan.changeSet);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'simulation.desired_manifest_hash_mismatch',
        path: '/preconditions/desiredManifestHash',
        relatedId: manifest.rootNodeId,
      }),
    ]);
    expect(plan.changeSet.preconditions.resultSnapshotHash).toBe(hashRobloxSnapshot(current));
  });

  it('rejects a tampered operation after its result snapshot hash is recomputed', () => {
    const manifest = compilePrimitiveFixture();
    const current = snapshotFromManifest(manifest);
    part(current, 'north-wall').properties.transparency = 0.4;
    const plan = planOrThrow(current, manifest);
    const operation = plan.changeSet.operations[0];
    if (operation === undefined || operation.type !== 'update') {
      throw new Error('Expected one update operation.');
    }
    operation.after.name = 'Tampered desired wall';
    const tamperedResult = clone(plan.expectedSnapshot);
    const tamperedNode = tamperedResult.nodes.find((node) => node.id === operation.after.id);
    if (tamperedNode === undefined) throw new Error('Expected updated result node.');
    tamperedNode.name = operation.after.name;
    plan.changeSet.preconditions.resultSnapshotHash = hashRobloxSnapshot(tamperedResult);

    const result = simulateRobloxChangeSet(current, plan.changeSet);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'simulation.desired_manifest_hash_mismatch',
        path: '/preconditions/desiredManifestHash',
        relatedId: manifest.rootNodeId,
      }),
    ]);
    expect(plan.changeSet.preconditions.resultSnapshotHash).toBe(
      hashRobloxSnapshot(tamperedResult),
    );
  });

  it('rejects a correctly ordered delete-all transition as a non-manifest result', () => {
    const manifest = compilePrimitiveFixture();
    const current = snapshotFromManifest(manifest);
    const empty = emptySnapshotForManifest(manifest);
    const transition = planRobloxSnapshotTransition(current, empty);
    if (!transition.success) throw new Error(JSON.stringify(transition.diagnostics));
    const changeSet = changeSetForOperations(
      current,
      empty,
      transition.operations,
      hashRobloxManifest(manifest),
    );

    const result = simulateRobloxChangeSet(current, changeSet);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'simulation.desired_manifest_invalid',
        path: '/rootNodeId',
      }),
    ]);
    expect(changeSet.preconditions.resultSnapshotHash).toBe(hashRobloxSnapshot(empty));
  });

  it('derives and hashes byte-identically without mutating its snapshot input', () => {
    const manifest = compilePrimitiveFixture();
    const snapshot = snapshotFromManifest(manifest, [
      { snapshotId: 'user-detail', parentNodeId: 'north-wall', name: 'User Detail' },
    ]);
    const before = clone(snapshot);

    const first = deriveRobloxManifestFromDesiredSnapshot(snapshot);
    const second = deriveRobloxManifestFromDesiredSnapshot(snapshot);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(stringifyRobloxManifest(second.manifest)).toBe(stringifyRobloxManifest(first.manifest));
    expect(hashRobloxManifest(second.manifest)).toBe(hashRobloxManifest(first.manifest));
    expect(snapshot).toEqual(before);
  });

  it('excludes unmanaged roots from desired hashes but includes them in complete snapshot hashes', () => {
    const manifest = compilePrimitiveFixture();
    const withoutUnmanaged = snapshotFromManifest(manifest);
    const withUnmanaged = snapshotFromManifest(manifest, [
      { snapshotId: 'user-detail', parentNodeId: 'north-wall', name: 'User Detail' },
    ]);
    const withoutPlan = planOrThrow(withoutUnmanaged, manifest);
    const withPlan = planOrThrow(withUnmanaged, manifest);

    expect(derivedManifestHashOrThrow(withUnmanaged)).toBe(
      derivedManifestHashOrThrow(withoutUnmanaged),
    );
    expect(withPlan.changeSet.preconditions.desiredManifestHash).toBe(
      withoutPlan.changeSet.preconditions.desiredManifestHash,
    );
    expect(withPlan.changeSet.preconditions.baseSnapshotHash).not.toBe(
      withoutPlan.changeSet.preconditions.baseSnapshotHash,
    );
    expect(withPlan.changeSet.preconditions.resultSnapshotHash).not.toBe(
      withoutPlan.changeSet.preconditions.resultSnapshotHash,
    );
    expect(hashRobloxSnapshot(withUnmanaged)).not.toBe(hashRobloxSnapshot(withoutUnmanaged));
  });
});

describe('shared unmanaged ownership analysis', () => {
  it('allows an unrelated property update while preserving the protected subtree evidence', () => {
    const manifest = compilePrimitiveFixture();
    const current = snapshotFromManifest(manifest, [
      { snapshotId: 'user-detail', parentNodeId: 'north-wall', name: 'User Detail' },
    ]);
    part(current, 'south-wall').properties.transparency = 0.2;
    const plan = planOrThrow(current, manifest);

    const result = simulateRobloxChangeSet(current, plan.changeSet);

    expect(plan.changeSet.operations).toEqual([
      expect.objectContaining({ id: 'update:south-wall', type: 'update' }),
    ]);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.snapshot.unmanagedRoots).toEqual(current.unmanagedRoots);
    expect(result.snapshot.unmanagedRoots).toEqual(plan.expectedSnapshot.unmanagedRoots);
  });

  it('reports a direct protected-parent delete at its operation with the unmanaged witness', () => {
    const manifest = compilePrimitiveFixture();
    const current = snapshotFromManifest(manifest, [
      { snapshotId: 'user-child', parentNodeId: 'north-wall', name: 'User Child' },
    ]);
    const before = clone(part(current, 'north-wall'));
    const resultSnapshot = clone(current);
    resultSnapshot.nodes = resultSnapshot.nodes.filter((node) => node.id !== before.id);
    const changeSet = changeSetForOperations(
      current,
      resultSnapshot,
      [{ id: `delete:${before.id}`, type: 'delete', before }],
      hashRobloxManifest(manifest),
    );

    const result = simulateRobloxChangeSet(current, changeSet);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'simulation.unmanaged_descendant_conflict',
        path: '/operations/0/before',
        relatedId: 'user-child',
      }),
    ]);
  });

  it('reports a protected-ancestor delete with the minimum code-point witness deterministically', () => {
    const manifest = compilePrimitiveFixture();
    const current = snapshotFromManifest(manifest, [
      { snapshotId: 'z-witness', parentNodeId: 'north-wall', name: 'Z Witness' },
      { snapshotId: 'a-witness', parentNodeId: 'east-wall', name: 'A Witness' },
    ]);
    const before = clone(nodeById(manifest, 'architectural-shell'));
    const resultSnapshot = clone(current);
    resultSnapshot.nodes = resultSnapshot.nodes.filter((node) => node.id !== before.id);
    const changeSet = changeSetForOperations(
      current,
      resultSnapshot,
      [{ id: `delete:${before.id}`, type: 'delete', before }],
      hashRobloxManifest(manifest),
    );

    const first = simulateRobloxChangeSet(current, changeSet);
    const second = simulateRobloxChangeSet(current, changeSet);

    expect(first).toEqual(second);
    expect(first.success).toBe(false);
    if (first.success) return;
    expect(first.diagnostics).toEqual([
      expect.objectContaining({
        code: 'simulation.unmanaged_descendant_conflict',
        path: '/operations/0/before',
        relatedId: 'a-witness',
      }),
    ]);
  });

  it('reports a protected-subtree reparent before generic result validation', () => {
    const manifest = compilePrimitiveFixture();
    const current = snapshotFromManifest(manifest, [
      { snapshotId: 'user-detail', parentNodeId: 'north-wall', name: 'User Detail' },
    ]);
    const before = clone(nodeById(manifest, 'architectural-shell'));
    const after = clone(before);
    after.parentId = 'courtyard-region';
    const resultSnapshot = clone(current);
    const resultNode = resultSnapshot.nodes.find((node) => node.id === after.id);
    if (resultNode === undefined) throw new Error('Expected protected subtree root.');
    resultNode.parentId = after.parentId;
    const changeSet = changeSetForOperations(
      current,
      resultSnapshot,
      [{ id: `update:${before.id}`, type: 'update', before, after }],
      derivedManifestHashOrThrow(resultSnapshot),
    );

    const result = simulateRobloxChangeSet(current, changeSet);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'simulation.unmanaged_descendant_conflict',
        path: '/operations/0/after/parentId',
        relatedId: 'user-detail',
      }),
    ]);
    expect(resultSnapshot.unmanagedRoots).toEqual(current.unmanagedRoots);
  });

  it('uses the same deterministic witness when planning a protected reparent', () => {
    const manifest = compilePrimitiveFixture();
    const current = snapshotFromManifest(manifest, [
      { snapshotId: 'z-witness', parentNodeId: 'north-wall', name: 'Z Witness' },
      { snapshotId: 'a-witness', parentNodeId: 'east-wall', name: 'A Witness' },
    ]);
    const desired = clone(manifest);
    nodeById(desired, 'architectural-shell').parentId = 'courtyard-region';

    const result = planRobloxChangeSet(current, desired);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'plan.unmanaged_descendant_conflict',
        path: `/nodes/${desired.nodes.findIndex((node) => node.id === 'architectural-shell')}/parentId`,
        relatedId: 'a-witness',
      }),
    );
  });
});
