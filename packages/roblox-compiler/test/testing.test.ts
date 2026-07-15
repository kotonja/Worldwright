import { describe, expect, it } from 'vitest';

import { validateRobloxSnapshot } from '../src/contract-validation.js';
import { normalizeRobloxManagedNode, normalizeRobloxSnapshot } from '../src/normalize.js';
import { createInMemoryRobloxAdapter, inMemoryRobloxFault } from '../src/testing.js';
import type { InMemoryRobloxAdapter } from '../src/testing.js';
import type {
  RobloxAdapterScope,
  RobloxManagedNode,
  RobloxManifest,
  RobloxSnapshot,
} from '../src/types.js';
import { clone, compilePrimitiveFixture, nodeById, snapshotFromManifest } from './helpers.js';

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

function renamed(node: Readonly<RobloxManagedNode>, name: string): RobloxManagedNode {
  return { ...clone(node), name };
}

describe('in-memory Roblox adapter', () => {
  it('keeps constructor inputs, reads, mutation inputs, and logs deeply independent', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = snapshotFromManifest(manifest);
    const expected = normalizeRobloxSnapshot(clone(initial));
    const adapter = createInMemoryRobloxAdapter({ initialSnapshots: [initial] });
    const scope = scopeFor(manifest);

    initial.nodes[0]!.name = 'Mutated caller-owned initial value';
    const firstRead = await readSnapshot(adapter, scope);
    firstRead.nodes[0]!.name = 'Mutated caller-owned read value';
    expect(await readSnapshot(adapter, scope)).toEqual(expected);

    const before = nodeById(manifest, 'plaza-floor');
    const after = renamed(before, 'Adapter-owned name');
    await adapter.updateNode(scope, before, after);
    after.name = 'Mutated caller-owned update value';
    expect(
      (await readSnapshot(adapter, scope)).nodes.find((node) => node.id === before.id)?.name,
    ).toBe('Adapter-owned name');

    const firstLog = adapter.mutationLog;
    (firstLog[0]!.target as { service: string }).service = 'Caller mutation';
    expect(adapter.mutationLog[0]?.target).toEqual({ service: 'Workspace' });
  });

  it('isolates state by project and never lets a mutation cross scope', async () => {
    const manifest = compilePrimitiveFixture();
    const projectA = snapshotFromManifest(manifest);
    const projectB = snapshotForProject(projectA, 'project-other');
    const adapter = createInMemoryRobloxAdapter({ initialSnapshots: [projectA, projectB] });
    const scopeA = scopeFor(manifest);
    const scopeB: RobloxAdapterScope = {
      projectId: 'project-other',
      target: { service: 'Workspace' },
    };
    const beforeA = nodeById(manifest, 'plaza-floor');
    const afterA = renamed(beforeA, 'Only project A changes');

    await adapter.updateNode(scopeA, beforeA, afterA);

    expect(
      (await readSnapshot(adapter, scopeA)).nodes.find((node) => node.id === beforeA.id)?.name,
    ).toBe('Only project A changes');
    expect(
      (await readSnapshot(adapter, scopeB)).nodes.find((node) => node.id === beforeA.id)?.name,
    ).toBe(beforeA.name);
    const projectBNode = clone(projectB.nodes.find((node) => node.id === beforeA.id));
    if (projectBNode === undefined) throw new Error('Missing project B node.');
    await expect(
      adapter.updateNode(scopeA, projectBNode, renamed(projectBNode, 'Wrong scope')),
    ).rejects.toThrow('rejected an unsafe mutation');
    expect(adapter.mutationLog.at(-1)).toEqual(
      expect.objectContaining({ projectId: manifest.source.projectId, outcome: 'rejected' }),
    );
  });

  it('requires exact update and delete before-states and preserves state on rejection', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = snapshotFromManifest(manifest);
    const adapter = createInMemoryRobloxAdapter({ initialSnapshots: [initial] });
    const scope = scopeFor(manifest);
    const actual = nodeById(manifest, 'plaza-floor');
    const staleBefore = renamed(actual, 'Stale before-state');
    const wrongIdentity = renamed(actual, 'Wrong managed identity');
    wrongIdentity.attributes.WorldwrightEntityId = 'east-wall';

    await expect(
      adapter.updateNode(scope, staleBefore, renamed(actual, 'Desired')),
    ).rejects.toThrow('rejected an unsafe mutation');
    await expect(adapter.deleteNode(scope, staleBefore)).rejects.toThrow(
      'rejected an unsafe mutation',
    );
    await expect(adapter.updateNode(scope, actual, wrongIdentity)).rejects.toThrow(
      'rejected an unsafe mutation',
    );
    await expect(adapter.createNode(scope, actual)).rejects.toThrow('rejected an unsafe mutation');

    expect(await readSnapshot(adapter, scope)).toEqual(normalizeRobloxSnapshot(initial));
    expect(adapter.mutationLog.map((entry) => entry.outcome)).toEqual([
      'rejected',
      'rejected',
      'rejected',
      'rejected',
    ]);
  });

  it('rejects missing parents, cycles, and deleting parents before managed children', async () => {
    const manifest = compilePrimitiveFixture();
    const scope = scopeFor(manifest);
    const empty = createInMemoryRobloxAdapter();
    const childWithoutParent = nodeById(manifest, 'courtyard-region');

    await expect(empty.createNode(scope, childWithoutParent)).rejects.toThrow(
      'rejected an unsafe mutation',
    );
    expect((await readSnapshot(empty, scope)).nodes).toEqual([]);

    const initial = snapshotFromManifest(manifest);
    const adapter = createInMemoryRobloxAdapter({ initialSnapshots: [initial] });
    const root = nodeById(manifest, 'courtyard-world');
    const cyclicRoot = clone(root);
    cyclicRoot.parentId = 'courtyard-region';

    await expect(adapter.updateNode(scope, root, cyclicRoot)).rejects.toThrow(
      'rejected an unsafe mutation',
    );
    await expect(adapter.deleteNode(scope, root)).rejects.toThrow('rejected an unsafe mutation');
    expect(await readSnapshot(adapter, scope)).toEqual(normalizeRobloxSnapshot(initial));
  });

  it('rejects deleting or reparenting managed subtrees that contain unmanaged roots', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = snapshotFromManifest(manifest, [
      {
        snapshotId: 'artist-owned-child',
        parentNodeId: 'fountain-water',
        name: 'Artist Water Detail',
      },
    ]);
    const adapter = createInMemoryRobloxAdapter({ initialSnapshots: [initial] });
    const scope = scopeFor(manifest);
    const protectedLeaf = nodeById(manifest, 'fountain-water');
    const protectedAncestor = nodeById(manifest, 'courtyard-details');
    const reparentedAncestor = clone(protectedAncestor);
    reparentedAncestor.parentId = 'architectural-shell';

    await expect(adapter.deleteNode(scope, protectedLeaf)).rejects.toThrow(
      'rejected an unsafe mutation',
    );
    await expect(adapter.updateNode(scope, protectedAncestor, reparentedAncestor)).rejects.toThrow(
      'rejected an unsafe mutation',
    );

    expect(await readSnapshot(adapter, scope)).toEqual(normalizeRobloxSnapshot(initial));
  });

  it('records deterministic one-shot fault outcomes and returns independent logs', async () => {
    const manifest = compilePrimitiveFixture();
    const initial = snapshotFromManifest(manifest);
    const scope = scopeFor(manifest);
    const before = nodeById(manifest, 'plaza-floor');
    const after = renamed(before, 'Updated after faults');
    const adapter = createInMemoryRobloxAdapter({
      initialSnapshots: [initial],
      faults: [inMemoryRobloxFault(1, 'skip'), inMemoryRobloxFault(2, 'throw-before')],
    });

    await adapter.updateNode(scope, before, after);
    await expect(adapter.updateNode(scope, before, after)).rejects.toThrow();
    await adapter.updateNode(scope, before, after);

    expect(adapter.mutationAttempts).toBe(3);
    expect(adapter.mutationLog).toEqual([
      {
        attempt: 1,
        type: 'update',
        nodeId: before.id,
        projectId: manifest.source.projectId,
        target: { service: 'Workspace' },
        outcome: 'skipped',
      },
      {
        attempt: 2,
        type: 'update',
        nodeId: before.id,
        projectId: manifest.source.projectId,
        target: { service: 'Workspace' },
        outcome: 'threw-before',
      },
      {
        attempt: 3,
        type: 'update',
        nodeId: before.id,
        projectId: manifest.source.projectId,
        target: { service: 'Workspace' },
        outcome: 'applied',
      },
    ]);
    expect(
      (await readSnapshot(adapter, scope)).nodes.find((node) => node.id === before.id),
    ).toEqual(normalizeRobloxManagedNode(after));
  });

  it('validates fault schedules and duplicate initial scopes at construction', () => {
    const manifest = compilePrimitiveFixture();
    const initial = snapshotFromManifest(manifest);

    expect(inMemoryRobloxFault(1, 'skip')).toEqual({ attempt: 1, action: 'skip' });
    expect(() => createInMemoryRobloxAdapter({ faults: [inMemoryRobloxFault(0, 'skip')] })).toThrow(
      'positive safe integers',
    );
    expect(() =>
      createInMemoryRobloxAdapter({
        faults: [inMemoryRobloxFault(1, 'skip'), inMemoryRobloxFault(1, 'throw-before')],
      }),
    ).toThrow('unique');
    expect(() =>
      createInMemoryRobloxAdapter({ initialSnapshots: [initial, clone(initial)] }),
    ).toThrow('unique project scopes');
  });
});
