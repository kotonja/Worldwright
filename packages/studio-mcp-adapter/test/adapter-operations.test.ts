import { describe, expect, it } from 'vitest';

import {
  planRobloxChangeSet,
  type RobloxManagedNode,
  type RobloxManifest,
} from '@worldwright/roblox-compiler';

import { applyStudioChangeSetWithPostMutationFault } from '../src/testing.js';
import { createFakeStudioAdapter, emptySnapshot, loadCourtyardManifest } from './helpers.js';

function leafPart(manifest: Readonly<RobloxManifest>): RobloxManagedNode {
  const parentIds = new Set(
    manifest.nodes.flatMap((node) => (node.parentId === undefined ? [] : [node.parentId])),
  );
  return manifest.nodes.find(
    (node) => node.className !== 'Folder' && node.className !== 'Model' && !parentIds.has(node.id),
  )!;
}

function withoutNode(manifest: Readonly<RobloxManifest>, nodeId: string): RobloxManifest {
  const node = manifest.nodes.find((entry) => entry.id === nodeId)!;
  const primitive = node.className !== 'Folder' && node.className !== 'Model';
  return {
    ...structuredClone(manifest),
    nodes: manifest.nodes
      .filter((entry) => entry.id !== nodeId)
      .map((entry) => structuredClone(entry)),
    measurements: {
      instances: manifest.measurements.instances - 1,
      containers: manifest.measurements.containers - (primitive ? 0 : 1),
      primitives: manifest.measurements.primitives - (primitive ? 1 : 0),
    },
  };
}

function renameNode(manifest: Readonly<RobloxManifest>, nodeId: string): RobloxManifest {
  return {
    ...structuredClone(manifest),
    nodes: manifest.nodes.map((node) =>
      node.id === nodeId
        ? { ...structuredClone(node), name: `${node.name} Renamed` }
        : structuredClone(node),
    ),
  };
}

function reparentNode(
  manifest: Readonly<RobloxManifest>,
  nodeId: string,
  parentId: string,
): RobloxManifest {
  return {
    ...structuredClone(manifest),
    nodes: manifest.nodes.map((node) =>
      node.id === nodeId ? { ...structuredClone(node), parentId } : structuredClone(node),
    ),
  };
}

function reviseRoot(manifest: Readonly<RobloxManifest>): RobloxManifest {
  const sourceHash = 'b'.repeat(64);
  return {
    ...structuredClone(manifest),
    source: { ...structuredClone(manifest.source), worldSpecHash: sourceHash },
    nodes: manifest.nodes.map((node) =>
      node.id === manifest.rootNodeId
        ? {
            ...structuredClone(node),
            name: `${node.name} Revised`,
            attributes: {
              ...structuredClone(node.attributes),
              WorldwrightSourceHash: sourceHash,
            },
          }
        : structuredClone(node),
    ),
  };
}

describe('allowlisted Studio adapter operations', () => {
  it('makes direct node mutation impossible outside the verified transaction context', async () => {
    const manifest = loadCourtyardManifest();
    const { adapter, protocol } = await createFakeStudioAdapter();
    try {
      await expect(
        adapter.createNode(
          { projectId: manifest.source.projectId, target: { service: 'Workspace' } },
          manifest.nodes.find((node) => node.id === manifest.rootNodeId)!,
        ),
      ).rejects.toMatchObject({
        diagnostics: [expect.objectContaining({ code: 'studio.usage_invalid' })],
      });
      expect(protocol.calls).toHaveLength(0);
    } finally {
      await adapter.close();
    }
  });

  it('rejects reflective access to the internal transaction capability before MCP calls', async () => {
    const { adapter, protocol } = await createFakeStudioAdapter();
    try {
      const transactionSymbols = Object.getOwnPropertySymbols(
        Object.getPrototypeOf(adapter),
      ).filter((symbol) => symbol.description?.includes('runAuthorizedTransaction') === true);
      expect(transactionSymbols).toEqual([]);
      expect(protocol.calls).toHaveLength(0);
    } finally {
      await adapter.close();
    }
  });

  it('keeps public method tampering outside the private compiler adapter', async () => {
    const manifest = loadCourtyardManifest();
    const plan = planRobloxChangeSet(emptySnapshot(manifest), manifest);
    if (!plan.success) throw new Error('Fixture plan failed.');
    const { adapter, protocol } = await createFakeStudioAdapter();
    const applyChangeSet = adapter.applyChangeSet;
    let intercepted = false;
    try {
      for (const method of ['readSnapshot', 'createNode', 'updateNode', 'deleteNode'] as const) {
        Object.defineProperty(adapter, method, {
          configurable: true,
          value: async (): Promise<never> => {
            intercepted = true;
            throw new Error('Caller-controlled adapter method must not execute.');
          },
        });
      }
      await expect(Reflect.apply(applyChangeSet, adapter, [plan.changeSet])).resolves.toMatchObject(
        {
          success: true,
          operationsAttempted: manifest.nodes.length,
        },
      );
      expect(intercepted).toBe(false);
      expect(protocol.nodes.size).toBe(manifest.nodes.length);
    } finally {
      await adapter.close();
    }
  });

  it('does not allow a read-only auto-selection result to become a mutation target', async () => {
    const manifest = loadCourtyardManifest();
    const plan = planRobloxChangeSet(emptySnapshot(manifest), manifest);
    if (!plan.success) throw new Error('Fixture plan failed.');
    const { adapter, protocol } = await createFakeStudioAdapter({ mutationAuthorized: false });
    try {
      await expect(adapter.applyChangeSet(plan.changeSet)).rejects.toMatchObject({
        diagnostics: [expect.objectContaining({ code: 'studio.usage_invalid' })],
      });
      await expect(
        applyStudioChangeSetWithPostMutationFault(adapter, plan.changeSet, 'create'),
      ).rejects.toMatchObject({
        diagnostics: [expect.objectContaining({ code: 'studio.usage_invalid' })],
      });
      expect(protocol.calls).toHaveLength(0);
    } finally {
      await adapter.close();
    }
  });

  it('reasserts and verifies the exact Studio immediately before every target-sensitive call', async () => {
    const manifest = loadCourtyardManifest();
    const { adapter, protocol } = await createFakeStudioAdapter();
    try {
      protocol.simulateExternalSessionSwitch();
      await adapter.probeSelectedStudio();

      protocol.simulateExternalSessionSwitch();
      await adapter.readSnapshot({
        projectId: manifest.source.projectId,
        target: { service: 'Workspace' },
      });

      protocol.simulateExternalSessionSwitch();
      await adapter.captureViewport({ captureId: 'exact-session-check' });

      for (let index = 0; index < protocol.calls.length; index += 1) {
        const call = protocol.calls[index]!;
        if (!['get_studio_state', 'execute_luau', 'screen_capture'].includes(call.tool)) continue;
        expect(protocol.calls.slice(index - 3, index).map((entry) => entry.tool)).toEqual([
          'list_roblox_studios',
          'set_active_studio',
          'list_roblox_studios',
        ]);
        expect(protocol.calls[index - 2]?.argumentsValue).toEqual({ studio_id: 'studio-test' });
      }
    } finally {
      await adapter.close();
    }
  });

  it('rejects accessor-backed, extended, and class-instance capture requests', async () => {
    const { adapter, protocol } = await createFakeStudioAdapter();
    let accessorInvoked = false;
    const accessor = {};
    Object.defineProperty(accessor, 'captureId', {
      enumerable: true,
      get(): string {
        accessorInvoked = true;
        return 'unsafe';
      },
    });
    class CaptureRequest {
      public readonly captureId = 'class-instance';
    }
    try {
      for (const request of [
        accessor,
        { captureId: 'extended', extra: true },
        new CaptureRequest(),
      ]) {
        await expect(
          adapter.captureViewport(request as Readonly<{ captureId: string }>),
        ).rejects.toMatchObject({
          diagnostics: [expect.objectContaining({ code: 'studio.capture_invalid' })],
        });
      }
      expect(accessorInvoked).toBe(false);
      expect(protocol.calls.some((call) => call.tool === 'screen_capture')).toBe(false);
    } finally {
      await adapter.close();
    }
  });

  it('rechecks the unsaved sandbox inside the fixed action before the first mutation', async () => {
    const manifest = loadCourtyardManifest();
    const plan = planRobloxChangeSet(emptySnapshot(manifest), manifest);
    if (!plan.success) throw new Error('Fixture plan failed.');
    const { adapter, protocol } = await createFakeStudioAdapter({
      publishBeforeAction: 'create',
    });
    try {
      await expect(adapter.applyChangeSet(plan.changeSet)).resolves.toMatchObject({
        success: false,
      });
      expect(protocol.nodes.size).toBe(0);
      expect(
        protocol.calls.some(
          (call) =>
            call.tool === 'execute_luau' &&
            typeof call.argumentsValue['code'] === 'string' &&
            call.argumentsValue['code'].includes('"action": "apply_chunk"') &&
            call.argumentsValue['code'].includes('"type": "create"'),
        ),
      ).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it('fails closed when a selected root or entity appears outside the indexed hierarchy', async () => {
    const manifest = loadCourtyardManifest();
    const plan = planRobloxChangeSet(emptySnapshot(manifest), manifest);
    if (!plan.success) throw new Error('Fixture plan failed.');
    for (const code of ['studio.identity_invalid', 'studio.root_invalid'] as const) {
      const { adapter, protocol } = await createFakeStudioAdapter({
        ownershipConflictBeforeAction: { action: 'create', code },
      });
      try {
        await expect(adapter.applyChangeSet(plan.changeSet)).resolves.toMatchObject({
          success: false,
          stage: 'apply',
          operationsAttempted: 1,
        });
        expect(protocol.nodes.size).toBe(0);
      } finally {
        await adapter.close();
      }
    }
  });

  it('creates all desired nodes through one deterministic fixed batch call', async () => {
    const manifest = loadCourtyardManifest();
    const plan = planRobloxChangeSet(emptySnapshot(manifest), manifest);
    if (!plan.success) throw new Error('Fixture plan failed.');
    const { adapter, protocol } = await createFakeStudioAdapter();
    try {
      const applied = await adapter.applyChangeSetDetailed(plan.changeSet);
      expect(applied.result).toMatchObject({ success: true });
      const fixedCreates = protocol.calls.filter(
        (call) =>
          call.tool === 'execute_luau' &&
          typeof call.argumentsValue['code'] === 'string' &&
          call.argumentsValue['code'].includes('"action": "apply_chunk"') &&
          call.argumentsValue['code'].includes('"type": "create"'),
      );
      expect(fixedCreates).toHaveLength(1);
      expect(applied.transportReport).toMatchObject({
        operationsPlanned: manifest.nodes.length,
        operationsAttempted: manifest.nodes.length,
        chunksPlanned: 1,
        chunksAttempted: 1,
        mutationExecuteCalls: 1,
        finalOutcome: 'applied',
      });
      expect(protocol.nodes.size).toBe(manifest.nodes.length);
    } finally {
      await adapter.close();
    }
  });

  it('rejects create when its managed parent drifts after the transaction snapshot', async () => {
    const desired = loadCourtyardManifest();
    const leaf = leafPart(desired);
    const current = withoutNode(desired, leaf.id);
    const plan = planRobloxChangeSet(
      {
        ...emptySnapshot(desired),
        rootNodeId: current.rootNodeId,
        nodes: current.nodes,
      },
      desired,
    );
    if (!plan.success) throw new Error(JSON.stringify(plan.diagnostics));
    expect(plan.changeSet.operations).toMatchObject([{ type: 'create' }]);
    const { adapter, protocol } = await createFakeStudioAdapter({
      initialNodes: current.nodes,
      parentDriftBeforeAction: {
        action: 'create',
        parentId: leaf.parentId!,
        name: 'Concurrent Parent Revision',
      },
    });
    try {
      await expect(adapter.applyChangeSet(plan.changeSet)).resolves.toMatchObject({
        success: false,
        stage: 'apply',
        operationsAttempted: 1,
      });
      expect(protocol.nodes.has(leaf.id)).toBe(false);
      expect(protocol.nodes.get(leaf.parentId!)?.name).toBe('Concurrent Parent Revision');
    } finally {
      await adapter.close();
    }
  });

  it('rejects reparent when its destination parent drifts after the transaction snapshot', async () => {
    const current = loadCourtyardManifest();
    const leaf = current.nodes.find((node) => node.id === 'east-wall')!;
    const destinationParentId = 'courtyard-details';
    const desired = reparentNode(current, leaf.id, destinationParentId);
    const plan = planRobloxChangeSet(
      {
        ...emptySnapshot(current),
        rootNodeId: current.rootNodeId,
        nodes: current.nodes,
      },
      desired,
    );
    if (!plan.success) throw new Error(JSON.stringify(plan.diagnostics));
    expect(plan.changeSet.operations).toMatchObject([{ type: 'update' }]);
    const { adapter, protocol } = await createFakeStudioAdapter({
      initialNodes: current.nodes,
      parentDriftBeforeAction: {
        action: 'update',
        parentId: destinationParentId,
        name: 'Concurrent Destination Revision',
      },
    });
    try {
      await expect(adapter.applyChangeSet(plan.changeSet)).resolves.toMatchObject({
        success: false,
        stage: 'apply',
        operationsAttempted: 1,
      });
      expect(protocol.nodes.get(leaf.id)?.parentId).toBe(leaf.parentId);
      expect(protocol.nodes.get(destinationParentId)?.name).toBe('Concurrent Destination Revision');
    } finally {
      await adapter.close();
    }
  });

  it('rejects reparent when its source parent drifts after the transaction snapshot', async () => {
    const current = loadCourtyardManifest();
    const leaf = current.nodes.find((node) => node.id === 'east-wall')!;
    const destinationParentId = 'courtyard-details';
    const desired = reparentNode(current, leaf.id, destinationParentId);
    const plan = planRobloxChangeSet(
      {
        ...emptySnapshot(current),
        rootNodeId: current.rootNodeId,
        nodes: current.nodes,
      },
      desired,
    );
    if (!plan.success) throw new Error(JSON.stringify(plan.diagnostics));
    const { adapter, protocol } = await createFakeStudioAdapter({
      initialNodes: current.nodes,
      parentDriftBeforeAction: {
        action: 'update',
        parentId: leaf.parentId!,
        name: 'Concurrent Source Revision',
      },
    });
    try {
      await expect(adapter.applyChangeSet(plan.changeSet)).resolves.toMatchObject({
        success: false,
        stage: 'apply',
        operationsAttempted: 1,
      });
      expect(protocol.nodes.get(leaf.id)?.parentId).toBe(leaf.parentId);
      expect(protocol.nodes.get(leaf.parentId!)?.name).toBe('Concurrent Source Revision');
    } finally {
      await adapter.close();
    }
  });

  it('updates complete state and deletes only an exact leaf', async () => {
    const original = loadCourtyardManifest();
    const leaf = leafPart(original);
    const renamed = renameNode(original, leaf.id);
    const updatePlan = planRobloxChangeSet(
      {
        ...emptySnapshot(original),
        rootNodeId: original.rootNodeId,
        nodes: original.nodes,
      },
      renamed,
    );
    if (!updatePlan.success) throw new Error('Update plan failed.');
    const { adapter, protocol } = await createFakeStudioAdapter({ initialNodes: original.nodes });
    try {
      await expect(adapter.applyChangeSet(updatePlan.changeSet)).resolves.toMatchObject({
        success: true,
        operationsAttempted: 1,
      });
      expect(protocol.nodes.get(leaf.id)?.name).toBe(`${leaf.name} Renamed`);

      const deleteDesired = withoutNode(renamed, leaf.id);
      const currentNodes = [...protocol.nodes.values()];
      const deletePlan = planRobloxChangeSet(
        {
          ...emptySnapshot(original),
          rootNodeId: original.rootNodeId,
          nodes: currentNodes,
        },
        deleteDesired,
      );
      if (!deletePlan.success) throw new Error(JSON.stringify(deletePlan.diagnostics));
      expect(deletePlan.changeSet.operations).toMatchObject([{ type: 'delete' }]);
      await expect(adapter.applyChangeSet(deletePlan.changeSet)).resolves.toMatchObject({
        success: true,
      });
      expect(protocol.nodes.has(leaf.id)).toBe(false);
    } finally {
      await adapter.close();
    }
  });

  it('updates the existing Workspace root name and source hash in place', async () => {
    const original = loadCourtyardManifest();
    const revised = reviseRoot(original);
    const plan = planRobloxChangeSet(
      {
        ...emptySnapshot(original),
        rootNodeId: original.rootNodeId,
        nodes: original.nodes,
      },
      revised,
    );
    if (!plan.success) throw new Error(JSON.stringify(plan.diagnostics));
    expect(plan.changeSet.operations).toMatchObject([{ type: 'update' }]);
    const { adapter, protocol } = await createFakeStudioAdapter({ initialNodes: original.nodes });
    try {
      await expect(adapter.applyChangeSet(plan.changeSet)).resolves.toMatchObject({
        success: true,
      });
      expect(protocol.nodes.get(original.rootNodeId)).toMatchObject({
        name: expect.stringContaining('Revised'),
        attributes: { WorldwrightSourceHash: 'b'.repeat(64) },
      });
    } finally {
      await adapter.close();
    }
  });

  it('maps unmanaged/foreign roots into the snapshot, blocks destructive planning, and permits property-only updates', async () => {
    const original = loadCourtyardManifest();
    const leaf = leafPart(original);
    const unmanaged = {
      parentEntityId: leaf.id,
      className: 'Folder',
      name: 'Foreign Project Root',
      structuralPath: `${leaf.id}/1/Folder/Foreign Project Root`,
      ordinal: 1,
    } as const;
    const { adapter, protocol } = await createFakeStudioAdapter({
      initialNodes: original.nodes,
      unmanagedRoots: [unmanaged],
    });
    try {
      const current = await adapter.readSnapshot({
        projectId: original.source.projectId,
        target: { service: 'Workspace' },
      });
      expect(current.unmanagedRoots).toHaveLength(1);
      const destructive = planRobloxChangeSet(current, withoutNode(original, leaf.id));
      expect(destructive).toMatchObject({
        success: false,
        diagnostics: [expect.objectContaining({ code: 'plan.unmanaged_descendant_conflict' })],
      });
      expect(protocol.nodes.has(leaf.id)).toBe(true);

      const propertyOnly = planRobloxChangeSet(current, renameNode(original, leaf.id));
      if (!propertyOnly.success) throw new Error(JSON.stringify(propertyOnly.diagnostics));
      await expect(adapter.applyChangeSet(propertyOnly.changeSet)).resolves.toMatchObject({
        success: true,
      });
      const final = await adapter.readSnapshot({
        projectId: original.source.projectId,
        target: { service: 'Workspace' },
      });
      expect(final.unmanagedRoots).toEqual(current.unmanagedRoots);
    } finally {
      await adapter.close();
    }
  });
});
