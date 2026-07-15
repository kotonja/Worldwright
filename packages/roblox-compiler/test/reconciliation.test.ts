import { describe, expect, it } from 'vitest';

import { stringifyRobloxChangeSet } from '../src/normalize.js';
import { planRobloxChangeSet } from '../src/reconcile.js';
import type {
  RobloxManagedNode,
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

function partInSnapshot(snapshot: RobloxSnapshot, id: string): RobloxPartNode {
  const node = snapshot.nodes.find((entry) => entry.id === id);
  if (node === undefined || node.className !== 'Part') {
    throw new Error(`Expected Part node ${id}.`);
  }
  return node;
}

function extraContainer(
  manifest: Readonly<RobloxManifest>,
  id: string,
  parentId: string,
): RobloxManagedNode {
  return {
    id,
    entityKind: 'structure',
    name: id,
    parentId,
    attributes: {
      WorldwrightManaged: true,
      WorldwrightProjectId: manifest.source.projectId,
      WorldwrightEntityId: id,
      WorldwrightEntityKind: 'structure',
      WorldwrightCompilerVersion: '0.1.0',
    },
    className: 'Folder',
    properties: {},
  };
}

function extraPart(
  manifest: Readonly<RobloxManifest>,
  id: string,
  parentId: string,
): RobloxPartNode {
  const template = clone(nodeById(manifest, 'north-wall'));
  if (template.className !== 'Part') throw new Error('Expected Part fixture template.');
  return {
    ...template,
    id,
    name: id,
    parentId,
    attributes: {
      ...template.attributes,
      WorldwrightEntityId: id,
      WorldwrightEntityKind: template.entityKind,
    },
  };
}

function expectPlanFailureCode(current: unknown, desired: unknown, code: string): void {
  const result = planRobloxChangeSet(current, desired);
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.diagnostics.map((entry) => entry.code)).toContain(code);
}

describe('deterministic Roblox reconciliation', () => {
  it('creates the complete desired state from an empty snapshot with ancestors first', () => {
    const manifest = compilePrimitiveFixture();
    const result = planRobloxChangeSet(emptySnapshotForManifest(manifest), manifest);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.changeSet.operations).toHaveLength(manifest.nodes.length);
    expect(result.changeSet.operations.every((operation) => operation.type === 'create')).toBe(
      true,
    );
    const created = new Set<string>();
    for (const operation of result.changeSet.operations) {
      if (operation.type !== 'create') throw new Error('Expected only creates.');
      if (operation.node.parentId !== undefined) {
        expect(created.has(operation.node.parentId)).toBe(true);
      }
      created.add(operation.node.id);
    }
    expect(result.changeSet.operations[0]?.id).toBe(`create:${manifest.rootNodeId}`);
  });

  it('produces a valid zero-operation plan for identical managed state', () => {
    const manifest = compilePrimitiveFixture();
    const current = snapshotFromManifest(manifest);
    const result = planRobloxChangeSet(current, manifest);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.changeSet.operations).toEqual([]);
    expect(result.changeSet.summary).toEqual({ creates: 0, updates: 0, deletes: 0, total: 0 });
    expect(result.expectedSnapshot).toEqual(current);
  });

  it('emits complete before/after updates for property, name, and parent differences', () => {
    const manifest = compilePrimitiveFixture();

    const propertySnapshot = snapshotFromManifest(manifest);
    partInSnapshot(propertySnapshot, 'north-wall').properties.transparency = 0.25;
    const propertyPlan = planRobloxChangeSet(propertySnapshot, manifest);
    expect(propertyPlan.success).toBe(true);
    if (propertyPlan.success) {
      expect(propertyPlan.changeSet.operations).toEqual([
        expect.objectContaining({
          id: 'update:north-wall',
          type: 'update',
          before: expect.objectContaining({
            properties: expect.objectContaining({ transparency: 0.25 }),
          }),
          after: expect.objectContaining({
            properties: expect.objectContaining({ transparency: 0 }),
          }),
        }),
      ]);
    }

    const nameSnapshot = snapshotFromManifest(manifest);
    partInSnapshot(nameSnapshot, 'north-wall').name = 'User-visible old name';
    const namePlan = planRobloxChangeSet(nameSnapshot, manifest);
    expect(namePlan.success).toBe(true);
    if (namePlan.success) {
      expect(namePlan.changeSet.operations).toEqual([
        expect.objectContaining({ id: 'update:north-wall', type: 'update' }),
      ]);
    }

    const parentSnapshot = snapshotFromManifest(manifest);
    partInSnapshot(parentSnapshot, 'north-wall').parentId = 'courtyard-details';
    const parentPlan = planRobloxChangeSet(parentSnapshot, manifest);
    expect(parentPlan.success).toBe(true);
    if (parentPlan.success) {
      expect(parentPlan.changeSet.operations).toEqual([
        expect.objectContaining({
          id: 'update:north-wall',
          type: 'update',
          before: expect.objectContaining({ parentId: 'courtyard-details' }),
          after: expect.objectContaining({ parentId: 'architectural-shell' }),
        }),
      ]);
    }
  });

  it('fails safely instead of replacing a node whose class changed', () => {
    const manifest = compilePrimitiveFixture();
    manifest.nodes.reverse();
    const snapshot = snapshotFromManifest(manifest);
    const index = snapshot.nodes.findIndex((node) => node.id === 'north-wall');
    const before = snapshot.nodes[index];
    if (before === undefined || before.className !== 'Part')
      throw new Error('Expected fixture Part.');
    const { shape, ...properties } = before.properties;
    expect(shape).toBe('Block');
    snapshot.nodes[index] = { ...before, className: 'WedgePart', properties };

    const result = planRobloxChangeSet(snapshot, manifest);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected class-change conflict.');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'plan.class_change_unsupported',
        path: `/nodes/${manifest.nodes.findIndex((node) => node.id === 'north-wall')}/className`,
      }),
    );
  });

  it('deletes obsolete managed leaves', () => {
    const manifest = compilePrimitiveFixture();
    const snapshot = snapshotFromManifest(manifest);
    snapshot.nodes.push(extraPart(manifest, 'obsolete-leaf', 'courtyard-details'));

    const result = planRobloxChangeSet(snapshot, manifest);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.changeSet.operations).toEqual([
      expect.objectContaining({ id: 'delete:obsolete-leaf', type: 'delete' }),
    ]);
  });

  it('orders deletes descendants before ancestors and IDs by code point at equal depth', () => {
    const manifest = compilePrimitiveFixture();
    const snapshot = snapshotFromManifest(manifest);
    snapshot.nodes.push(
      extraContainer(manifest, 'obsolete-parent', manifest.rootNodeId),
      extraContainer(manifest, 'obsolete-child', 'obsolete-parent'),
      extraContainer(manifest, 'obsolete-zeta', manifest.rootNodeId),
      extraContainer(manifest, 'obsolete-alpha', manifest.rootNodeId),
    );

    const result = planRobloxChangeSet(snapshot, manifest);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.changeSet.operations.map((operation) => operation.id)).toEqual([
      'delete:obsolete-child',
      'delete:obsolete-alpha',
      'delete:obsolete-parent',
      'delete:obsolete-zeta',
    ]);
  });

  it('orders same-depth creates deterministically by node ID', () => {
    const manifest = compilePrimitiveFixture();
    const result = planRobloxChangeSet(emptySnapshotForManifest(manifest), manifest);
    if (!result.success) throw new Error(JSON.stringify(result.diagnostics));
    const rootChildren = result.changeSet.operations
      .filter(
        (operation) =>
          operation.type === 'create' && operation.node.parentId === manifest.rootNodeId,
      )
      .map((operation) => (operation.type === 'create' ? operation.node.id : ''));

    expect(rootChildren).toEqual(
      [...rootChildren].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  });

  it('reports exact operation summary counts', () => {
    const desired = compilePrimitiveFixture();
    const currentManifest = clone(desired);
    const snapshot = snapshotFromManifest(currentManifest);
    partInSnapshot(snapshot, 'north-wall').name = 'Old Wall';
    snapshot.nodes.push(extraPart(desired, 'obsolete-leaf', 'courtyard-details'));
    const newNode = desired.nodes.find((node) => node.id === 'courtyard-guide-orb');
    if (newNode === undefined) throw new Error('Fixture node is missing.');
    snapshot.nodes = snapshot.nodes.filter((node) => node.id !== newNode.id);

    const result = planRobloxChangeSet(snapshot, desired);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.changeSet.summary).toEqual({ creates: 1, updates: 1, deletes: 1, total: 3 });
    expect(result.changeSet.summary.total).toBe(result.changeSet.operations.length);
  });

  it('never mutates inputs and repeated planning is byte-identical', () => {
    const manifest = compilePrimitiveFixture();
    const snapshot = emptySnapshotForManifest(manifest);
    const manifestBefore = clone(manifest);
    const snapshotBefore = clone(snapshot);

    const first = planRobloxChangeSet(snapshot, manifest);
    const second = planRobloxChangeSet(snapshot, manifest);

    expect(snapshot).toEqual(snapshotBefore);
    expect(manifest).toEqual(manifestBefore);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(stringifyRobloxChangeSet(second.changeSet)).toBe(
      stringifyRobloxChangeSet(first.changeSet),
    );
    expect(second.expectedSnapshot).toEqual(first.expectedSnapshot);
  });

  it('rejects project mismatch without mutating either project', () => {
    const manifest = compilePrimitiveFixture();
    const snapshot = snapshotFromManifest(manifest);
    snapshot.projectId = 'different-project';
    for (const node of snapshot.nodes) {
      node.attributes.WorldwrightProjectId = 'different-project';
    }
    const before = clone(snapshot);
    const manifestBefore = clone(manifest);

    expectPlanFailureCode(snapshot, manifest, 'plan.project_mismatch');

    expect(snapshot).toEqual(before);
    expect(manifest).toEqual(manifestBefore);
  });

  it('rejects replacing one non-empty managed root with another', () => {
    const manifest = compilePrimitiveFixture();
    const current = snapshotFromManifest(manifest);
    const desired = clone(manifest);
    const oldRootId = desired.rootNodeId;
    const newRootId = 'replacement-root';
    const root = nodeById(desired, oldRootId);
    root.id = newRootId;
    root.attributes.WorldwrightEntityId = newRootId;
    desired.rootNodeId = newRootId;
    for (const node of desired.nodes) {
      if (node.parentId === oldRootId) node.parentId = newRootId;
    }

    expectPlanFailureCode(current, desired, 'plan.root_change_unsupported');
  });

  it('rejects an out-of-scope target at the strict contract boundary', () => {
    const manifest = compilePrimitiveFixture();
    (manifest.target as { service: string }).service = 'ReplicatedStorage';

    expectPlanFailureCode(
      snapshotFromManifest(compilePrimitiveFixture()),
      manifest,
      'plan.manifest_invalid',
    );
  });

  it('blocks deleting a managed node that directly contains an unmanaged root', () => {
    const manifest = compilePrimitiveFixture();
    const snapshot = snapshotFromManifest(manifest);
    snapshot.nodes.push(extraPart(manifest, 'obsolete-leaf', 'courtyard-details'));
    snapshot.unmanagedRoots.push({
      snapshotId: 'user-child',
      parentNodeId: 'obsolete-leaf',
      name: 'User Child',
    });

    expectPlanFailureCode(snapshot, manifest, 'plan.unmanaged_descendant_conflict');
  });

  it('blocks deleting any managed ancestor of unmanaged content', () => {
    const manifest = compilePrimitiveFixture();
    const snapshot = snapshotFromManifest(manifest);
    snapshot.nodes.push(
      extraContainer(manifest, 'obsolete-parent', manifest.rootNodeId),
      extraContainer(manifest, 'obsolete-child', 'obsolete-parent'),
    );
    snapshot.unmanagedRoots.push({
      snapshotId: 'user-grandchild',
      parentNodeId: 'obsolete-child',
      name: 'User Grandchild',
    });

    const result = planRobloxChangeSet(snapshot, manifest);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.diagnostics.filter((entry) => entry.code === 'plan.unmanaged_descendant_conflict'),
    ).toHaveLength(2);
  });

  it('blocks reparenting a managed subtree containing unmanaged content', () => {
    const manifest = compilePrimitiveFixture();
    const snapshot = snapshotFromManifest(manifest, [
      { snapshotId: 'user-wall-detail', parentNodeId: 'north-wall', name: 'User Detail' },
    ]);
    const desired = clone(manifest);
    nodeById(desired, 'architectural-shell').parentId = 'courtyard-region';

    const result = planRobloxChangeSet(snapshot, desired);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected unmanaged reparent conflict.');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'plan.unmanaged_descendant_conflict',
        path: `/nodes/${desired.nodes.findIndex((node) => node.id === 'architectural-shell')}/parentId`,
      }),
    );
  });

  it('allows unrelated property updates and preserves unmanaged markers exactly', () => {
    const manifest = compilePrimitiveFixture();
    const unmanaged = [
      { snapshotId: 'user-north-detail', parentNodeId: 'north-wall', name: 'User North Detail' },
    ];
    const snapshot = snapshotFromManifest(manifest, unmanaged);
    partInSnapshot(snapshot, 'south-wall').properties.transparency = 0.2;

    const result = planRobloxChangeSet(snapshot, manifest);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.changeSet.operations).toEqual([
      expect.objectContaining({ id: 'update:south-wall', type: 'update' }),
    ]);
    expect(result.expectedSnapshot.unmanagedRoots).toEqual(unmanaged);
  });
});
