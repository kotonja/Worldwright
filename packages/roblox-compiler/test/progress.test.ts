import { describe, expect, it } from 'vitest';

import { deriveRobloxManifestFromDesiredSnapshot } from '../src/desired-manifest.js';
import { classifyRobloxChangeSetProgress } from '../src/progress.js';
import {
  hashRobloxManifest,
  hashRobloxSnapshot,
  normalizeRobloxManagedNode,
  normalizeRobloxSnapshot,
} from '../src/normalize.js';
import { planRobloxChangeSet } from '../src/reconcile.js';
import type {
  PlanSuccess,
  RobloxChangeOperation,
  RobloxChangeSet,
  RobloxManifest,
  RobloxManagedNode,
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

function applyOperations(
  snapshot: Readonly<RobloxSnapshot>,
  operations: readonly Readonly<RobloxChangeOperation>[],
): RobloxSnapshot {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, normalizeRobloxManagedNode(node)]));
  for (const operation of operations) {
    switch (operation.type) {
      case 'create':
        byId.set(operation.node.id, normalizeRobloxManagedNode(operation.node));
        break;
      case 'update':
        byId.set(operation.after.id, normalizeRobloxManagedNode(operation.after));
        break;
      case 'delete':
        byId.delete(operation.before.id);
        break;
    }
  }
  const nodes = [...byId.values()];
  const roots = nodes.filter((node) => node.parentId === undefined);
  return normalizeRobloxSnapshot({
    schemaVersion: snapshot.schemaVersion,
    projectId: snapshot.projectId,
    target: snapshot.target,
    ...(roots.length === 1 ? { rootNodeId: roots[0]!.id } : {}),
    nodes,
    unmanagedRoots: snapshot.unmanagedRoots,
  });
}

function manifestWithRenames(
  manifest: Readonly<RobloxManifest>,
  renames: ReadonlyMap<string, string>,
): RobloxManifest {
  return {
    ...clone(manifest),
    nodes: manifest.nodes.map((node) => ({
      ...clone(node),
      name: renames.get(node.id) ?? node.name,
    })),
  };
}

function manifestWithoutLeafNodes(
  manifest: Readonly<RobloxManifest>,
  count: number,
): RobloxManifest {
  const parentIds = new Set(
    manifest.nodes.flatMap((node) => (node.parentId === undefined ? [] : [node.parentId])),
  );
  const removedIds = new Set(
    manifest.nodes
      .filter((node) => !parentIds.has(node.id) && node.id !== manifest.rootNodeId)
      .slice(0, count)
      .map((node) => node.id),
  );
  return {
    ...clone(manifest),
    nodes: manifest.nodes.filter((node) => !removedIds.has(node.id)).map((node) => clone(node)),
    measurements: {
      instances: manifest.nodes.length - removedIds.size,
      containers: manifest.nodes.filter(
        (node) =>
          !removedIds.has(node.id) && (node.className === 'Folder' || node.className === 'Model'),
      ).length,
      primitives: manifest.nodes.filter(
        (node) =>
          !removedIds.has(node.id) && node.className !== 'Folder' && node.className !== 'Model',
      ).length,
    },
  };
}

describe('pure Roblox change-set progress classification', () => {
  it('classifies the exact base, every nonempty prefix, and the complete result', () => {
    const manifest = compilePrimitiveFixture();
    const base = emptySnapshotForManifest(manifest);
    const plan = requirePlan(base, manifest);

    for (
      let prefixLength = 0;
      prefixLength <= plan.changeSet.operations.length;
      prefixLength += 1
    ) {
      const observed = applyOperations(base, plan.changeSet.operations.slice(0, prefixLength));
      const result = classifyRobloxChangeSetProgress(base, observed, plan.changeSet);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected exact progress classification.');
      expect(result.appliedPrefixLength).toBe(prefixLength);
      expect(result.classification).toBe(
        prefixLength === 0
          ? 'base'
          : prefixLength === plan.changeSet.operations.length
            ? 'complete'
            : 'prefix',
      );
      expect(result.nextOperationId).toBe(plan.changeSet.operations[prefixLength]?.id);
    }
  });

  it('classifies a zero-operation change set deterministically as base at prefix zero', () => {
    const manifest = compilePrimitiveFixture();
    const base = snapshotFromManifest(manifest);
    const plan = requirePlan(base, manifest);
    expect(plan.changeSet.operations).toHaveLength(0);

    expect(classifyRobloxChangeSetProgress(base, clone(base), plan.changeSet)).toEqual(
      expect.objectContaining({
        success: true,
        classification: 'base',
        operationsTotal: 0,
        appliedPrefixLength: 0,
      }),
    );
  });

  it('classifies every exact prefix of multi-update and multi-delete transitions', () => {
    const manifest = compilePrimitiveFixture();
    const base = snapshotFromManifest(manifest);
    const plans = [
      requirePlan(
        base,
        manifestWithRenames(
          manifest,
          new Map([
            ['north-wall', 'Reviewed North Wall'],
            ['plaza-floor', 'Reviewed Plaza Floor'],
            ['west-wall', 'Reviewed West Wall'],
          ]),
        ),
      ),
      requirePlan(base, manifestWithoutLeafNodes(manifest, 3)),
    ];
    expect(plans[0]!.changeSet.operations.every((operation) => operation.type === 'update')).toBe(
      true,
    );
    expect(plans[1]!.changeSet.operations.every((operation) => operation.type === 'delete')).toBe(
      true,
    );
    for (const plan of plans) {
      for (let prefix = 0; prefix <= plan.changeSet.operations.length; prefix += 1) {
        const observed = applyOperations(base, plan.changeSet.operations.slice(0, prefix));
        expect(classifyRobloxChangeSetProgress(base, observed, plan.changeSet)).toMatchObject({
          success: true,
          appliedPrefixLength: prefix,
        });
      }
    }
  });

  it('rejects a valid arbitrary subset whose later operation is present without its prefix', () => {
    const manifest = compilePrimitiveFixture();
    const base = snapshotFromManifest(manifest);
    const desired = manifestWithRenames(
      manifest,
      new Map([
        ['north-wall', 'Renamed North Wall'],
        ['plaza-floor', 'Renamed Plaza Floor'],
      ]),
    );
    const plan = requirePlan(base, desired);
    expect(plan.changeSet.operations).toHaveLength(2);
    const observed = applyOperations(base, [plan.changeSet.operations[1]!]);

    const result = classifyRobloxChangeSetProgress(base, observed, plan.changeSet);
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        classification: 'unsafe',
        diagnostics: [expect.objectContaining({ code: 'progress.not_exact_prefix' })],
      }),
    );
  });

  it.each([
    {
      name: 'unrelated managed edit',
      mutate: (base: RobloxSnapshot): RobloxSnapshot => ({
        ...clone(base),
        nodes: base.nodes.map((node) =>
          node.id === 'north-wall' ? { ...clone(node), name: 'Concurrent rename' } : clone(node),
        ),
      }),
      path: '/nodes/north-wall',
    },
    {
      name: 'operation target in a third state',
      mutate: (base: RobloxSnapshot): RobloxSnapshot => ({
        ...clone(base),
        nodes: base.nodes.map((node) =>
          node.id === 'plaza-floor' ? { ...clone(node), name: 'Third state' } : clone(node),
        ),
      }),
      path: '/nodes/plaza-floor',
    },
  ])('rejects $name with a precise deterministic path', ({ mutate, path }) => {
    const manifest = compilePrimitiveFixture();
    const base = snapshotFromManifest(manifest);
    const desired = manifestWithRenames(manifest, new Map([['plaza-floor', 'Authorized rename']]));
    const plan = requirePlan(base, desired);
    const result = classifyRobloxChangeSetProgress(base, mutate(base), plan.changeSet);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected unsafe progress.');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'progress.not_exact_prefix', path }),
    );
  });

  it('rejects any unmanaged-root boundary change', () => {
    const manifest = compilePrimitiveFixture();
    const base = snapshotFromManifest(manifest, [
      {
        snapshotId: 'artist-root',
        parentNodeId: 'north-wall',
        name: 'Artist content',
      },
    ]);
    const plan = requirePlan(
      base,
      manifestWithRenames(manifest, new Map([['plaza-floor', 'Authorized rename']])),
    );
    const observed: RobloxSnapshot = {
      ...clone(base),
      unmanagedRoots: [{ ...clone(base.unmanagedRoots[0]!), name: 'Concurrent rename' }],
    };

    const result = classifyRobloxChangeSetProgress(base, observed, plan.changeSet);
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        diagnostics: [
          expect.objectContaining({ code: 'progress.unmanaged_changed', path: '/unmanagedRoots' }),
        ],
      }),
    );
  });

  it('rejects unrelated managed additions and deletions with deterministic diagnostics', () => {
    const manifest = compilePrimitiveFixture();
    const base = snapshotFromManifest(manifest);
    const plan = requirePlan(
      base,
      manifestWithRenames(manifest, new Map([['plaza-floor', 'Authorized rename']])),
    );
    const unrelatedAddition: RobloxManagedNode = {
      id: 'concurrent-node',
      entityKind: 'object',
      name: 'Concurrent node',
      parentId: manifest.rootNodeId,
      attributes: {
        WorldwrightManaged: true,
        WorldwrightProjectId: manifest.source.projectId,
        WorldwrightEntityId: 'concurrent-node',
        WorldwrightEntityKind: 'object',
        WorldwrightCompilerVersion: '0.1.0',
      },
      className: 'Folder',
      properties: {},
    };
    const leaf = manifestWithoutLeafNodes(manifest, 1);
    const retainedIds = new Set(leaf.nodes.map((node) => node.id));
    const observations: RobloxSnapshot[] = [
      normalizeRobloxSnapshot({ ...clone(base), nodes: [...base.nodes, unrelatedAddition] }),
      normalizeRobloxSnapshot({
        ...clone(base),
        nodes: base.nodes.filter((node) => retainedIds.has(node.id)),
      }),
    ];
    for (const observed of observations) {
      const first = classifyRobloxChangeSetProgress(base, observed, plan.changeSet);
      const second = classifyRobloxChangeSetProgress(base, clone(observed), clone(plan.changeSet));
      expect(first).toEqual(second);
      expect(first).toMatchObject({
        success: false,
        diagnostics: [expect.objectContaining({ code: 'progress.not_exact_prefix' })],
      });
    }
  });

  it('rejects an added unmanaged boundary as well as a renamed one', () => {
    const manifest = compilePrimitiveFixture();
    const base = snapshotFromManifest(manifest);
    const plan = requirePlan(
      base,
      manifestWithRenames(manifest, new Map([['plaza-floor', 'Authorized rename']])),
    );
    const observed = normalizeRobloxSnapshot({
      ...clone(base),
      unmanagedRoots: [
        {
          snapshotId: 'concurrent-unmanaged-root',
          parentNodeId: manifest.rootNodeId,
          name: 'Concurrent creator content',
        },
      ],
    });
    expect(classifyRobloxChangeSetProgress(base, observed, plan.changeSet)).toMatchObject({
      success: false,
      diagnostics: [expect.objectContaining({ code: 'progress.unmanaged_changed' })],
    });
  });

  it('reports invalid inputs, project mismatch, base hash mismatch, and bad operation preconditions', () => {
    const manifest = compilePrimitiveFixture();
    const base = snapshotFromManifest(manifest);
    const plan = requirePlan(
      base,
      manifestWithRenames(manifest, new Map([['plaza-floor', 'Authorized rename']])),
    );

    const invalid = classifyRobloxChangeSetProgress({}, [], null);
    expect(invalid.success).toBe(false);
    if (invalid.success) throw new Error('Expected invalid inputs.');
    expect(invalid.diagnostics.map((entry) => entry.code).sort()).toEqual(
      [
        'progress.base_snapshot_invalid',
        'progress.change_set_invalid',
        'progress.observed_snapshot_invalid',
      ].sort(),
    );

    const otherProject = 'project-other';
    const observedOtherProject: RobloxSnapshot = {
      ...clone(base),
      projectId: otherProject,
      nodes: base.nodes.map((node) => ({
        ...clone(node),
        attributes: { ...clone(node.attributes), WorldwrightProjectId: otherProject },
      })),
    };
    const projectMismatch = classifyRobloxChangeSetProgress(
      base,
      observedOtherProject,
      plan.changeSet,
    );
    expect(projectMismatch.success).toBe(false);
    if (projectMismatch.success) throw new Error('Expected project mismatch.');
    expect(projectMismatch.diagnostics[0]?.code).toBe('progress.project_mismatch');

    const badBaseHash: RobloxChangeSet = {
      ...clone(plan.changeSet),
      preconditions: {
        ...clone(plan.changeSet.preconditions),
        baseSnapshotHash: '0'.repeat(64),
      },
    };
    const hashMismatch = classifyRobloxChangeSetProgress(base, base, badBaseHash);
    expect(hashMismatch.success).toBe(false);
    if (hashMismatch.success) throw new Error('Expected base-hash mismatch.');
    expect(hashMismatch.diagnostics[0]?.code).toBe('progress.base_hash_mismatch');

    const operation = plan.changeSet.operations[0];
    if (operation?.type !== 'update') throw new Error('Expected one update operation.');
    const badPrecondition: RobloxChangeSet = {
      ...clone(plan.changeSet),
      operations: [
        {
          ...clone(operation),
          before: { ...clone(operation.before), name: 'Incorrect before state' },
        },
      ],
    };
    const precondition = classifyRobloxChangeSetProgress(base, base, badPrecondition);
    expect(precondition.success).toBe(false);
    if (precondition.success) throw new Error('Expected operation precondition failure.');
    expect(precondition.diagnostics[0]?.code).toBe('progress.operation_precondition_invalid');
  });

  it('never mutates base, observed, or change-set inputs', () => {
    const manifest = compilePrimitiveFixture();
    const base = emptySnapshotForManifest(manifest);
    const plan = requirePlan(base, manifest);
    const observed = applyOperations(base, plan.changeSet.operations.slice(0, 2));
    const before = JSON.stringify({ base, observed, changeSet: plan.changeSet });

    classifyRobloxChangeSetProgress(base, observed, plan.changeSet);

    expect(JSON.stringify({ base, observed, changeSet: plan.changeSet })).toBe(before);
  });

  it('handles 3,000-node flat and deep no-ops without hierarchy recursion', () => {
    const projectId = 'project-deep-progress';
    const nodes: RobloxManagedNode[] = [];
    for (let index = 0; index < 3_000; index += 1) {
      const id = `deep-${String(index).padStart(4, '0')}`;
      const entityKind = index === 0 ? ('world' as const) : ('object' as const);
      nodes.push({
        id,
        entityKind,
        name: `Deep node ${String(index)}`,
        ...(index === 0 ? {} : { parentId: nodes[0]!.id }),
        attributes: {
          WorldwrightManaged: true,
          WorldwrightProjectId: projectId,
          WorldwrightEntityId: id,
          WorldwrightEntityKind: entityKind,
          WorldwrightCompilerVersion: '0.1.0',
          ...(index === 0 ? { WorldwrightSourceHash: 'd'.repeat(64) } : {}),
        },
        className: 'Folder',
        properties: {},
      });
    }
    const base = normalizeRobloxSnapshot({
      schemaVersion: '0.1.0',
      projectId,
      target: { service: 'Workspace' },
      rootNodeId: nodes[0]!.id,
      nodes,
      unmanagedRoots: [],
    });
    const snapshotHash = hashRobloxSnapshot(base);
    const desiredManifest = deriveRobloxManifestFromDesiredSnapshot(base);
    if (!desiredManifest.success) throw new Error('Deep practical manifest derivation failed.');
    const changeSet: RobloxChangeSet = {
      schemaVersion: '0.1.0',
      compilerVersion: '0.1.0',
      preconditions: {
        projectId,
        target: { service: 'Workspace' },
        baseSnapshotHash: snapshotHash,
        desiredManifestHash: hashRobloxManifest(desiredManifest.manifest),
        resultSnapshotHash: snapshotHash,
      },
      operations: [],
      summary: { creates: 0, updates: 0, deletes: 0, total: 0 },
    };
    const practical = classifyRobloxChangeSetProgress(base, structuredClone(base), changeSet);
    if (!practical.success) {
      throw new Error(
        `Practical progress fixture failed: ${JSON.stringify(practical.diagnostics)}`,
      );
    }
    expect(practical).toMatchObject({
      success: true,
      classification: 'base',
      appliedPrefixLength: 0,
    });

    const deeplyNested = normalizeRobloxSnapshot({
      ...structuredClone(base),
      nodes: base.nodes.map((node, index) =>
        index < 2
          ? structuredClone(node)
          : { ...structuredClone(node), parentId: base.nodes[index - 1]!.id },
      ),
    });
    const deeplyNestedManifest = deriveRobloxManifestFromDesiredSnapshot(deeplyNested);
    if (!deeplyNestedManifest.success) {
      throw new Error('Deeply nested practical manifest derivation failed.');
    }
    const deeplyNestedHash = hashRobloxSnapshot(deeplyNested);
    const deeplyNestedChangeSet: RobloxChangeSet = {
      ...changeSet,
      preconditions: {
        ...changeSet.preconditions,
        baseSnapshotHash: deeplyNestedHash,
        desiredManifestHash: hashRobloxManifest(deeplyNestedManifest.manifest),
        resultSnapshotHash: deeplyNestedHash,
      },
    };
    expect(
      classifyRobloxChangeSetProgress(deeplyNested, deeplyNested, deeplyNestedChangeSet),
    ).toMatchObject({
      success: true,
      classification: 'base',
      appliedPrefixLength: 0,
    });
  }, 15_000);
});
