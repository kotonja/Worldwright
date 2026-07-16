import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  planRobloxChangeSet,
  type RobloxManagedNode,
  type RobloxManifest,
} from '@worldwright/roblox-compiler';

import { STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS } from '../src/constants.js';
import { applyStudioChangeSetWithPostMutationFault } from '../src/testing.js';
import { createFakeStudioAdapter, emptySnapshot, loadCourtyardManifest } from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

function planOrThrow(manifest: RobloxManifest, nodes: readonly RobloxManagedNode[] = []) {
  const snapshot = {
    ...emptySnapshot(manifest),
    ...(nodes.length === 0 ? {} : { rootNodeId: manifest.rootNodeId }),
    nodes: structuredClone(nodes),
  };
  const plan = planRobloxChangeSet(snapshot, manifest);
  if (!plan.success) throw new Error(JSON.stringify(plan.diagnostics));
  return plan.changeSet;
}

function renamedManifest(manifest: RobloxManifest): RobloxManifest {
  const renamedId = manifest.nodes.find((node) => node.className === 'Part')!.id;
  return {
    ...structuredClone(manifest),
    nodes: manifest.nodes.map((node) =>
      node.id === renamedId
        ? { ...structuredClone(node), name: `${node.name} Updated` }
        : structuredClone(node),
    ),
  };
}

function largeManifest(): RobloxManifest {
  const projectId = 'project-operation-limit';
  const sourceHash = 'a'.repeat(64);
  const nodes: RobloxManagedNode[] = [];
  for (let index = 0; index <= STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS; index += 1) {
    const id = index === 0 ? 'world-root' : `node-${String(index).padStart(4, '0')}`;
    const entityKind = index === 0 ? ('world' as const) : ('object' as const);
    nodes.push({
      id,
      entityKind,
      name: `Node ${index}`,
      ...(index === 0 ? {} : { parentId: 'world-root' }),
      attributes: {
        WorldwrightManaged: true,
        WorldwrightProjectId: projectId,
        WorldwrightEntityId: id,
        WorldwrightEntityKind: entityKind,
        WorldwrightCompilerVersion: '0.1.0',
        ...(index === 0 ? { WorldwrightSourceHash: sourceHash } : {}),
      },
      className: 'Folder',
      properties: {},
    });
  }
  return {
    schemaVersion: '0.1.0',
    compilerVersion: '0.1.0',
    source: {
      worldSpecSchemaVersion: '0.1.0',
      projectId,
      worldSpecHash: sourceHash,
    },
    target: { service: 'Workspace' },
    rootNodeId: 'world-root',
    nodes,
    measurements: { instances: nodes.length, containers: nodes.length, primitives: 0 },
  };
}

describe('Studio adapter transaction integration', () => {
  it('applies all allowlisted classes, verifies the result, then performs a mutation-free no-op', async () => {
    const manifest = loadCourtyardManifest();
    const changeSet = planOrThrow(manifest);
    const { adapter, protocol } = await createFakeStudioAdapter();
    try {
      const applied = await adapter.applyChangeSet(changeSet);
      expect(applied).toMatchObject({
        success: true,
        status: 'applied',
        operationsAttempted: manifest.nodes.length,
        finalSnapshotHash: changeSet.preconditions.resultSnapshotHash,
      });
      expect(new Set([...protocol.nodes.values()].map((node) => node.className))).toEqual(
        new Set(['Folder', 'Model', 'Part', 'WedgePart', 'CornerWedgePart']),
      );

      const noOp = planOrThrow(manifest, manifest.nodes);
      const mutationsBefore = protocol.calls.filter((call) =>
        ['create', 'update', 'delete'].some(
          (action) =>
            typeof call.argumentsValue['code'] === 'string' &&
            call.argumentsValue['code'].includes(`"action": "${action}"`),
        ),
      ).length;
      const noOpResult = await adapter.applyChangeSet(noOp);
      expect(noOpResult).toMatchObject({ success: true, status: 'noop', operationsAttempted: 0 });
      const mutationsAfter = protocol.calls.filter((call) =>
        ['create', 'update', 'delete'].some(
          (action) =>
            typeof call.argumentsValue['code'] === 'string' &&
            call.argumentsValue['code'].includes(`"action": "${action}"`),
        ),
      ).length;
      expect(mutationsAfter).toBe(mutationsBefore);
    } finally {
      await adapter.close();
    }
  });

  it('rejects stale live state before any mutation call', async () => {
    const manifest = loadCourtyardManifest();
    const changeSet = planOrThrow(manifest);
    const { adapter, protocol } = await createFakeStudioAdapter({ initialNodes: manifest.nodes });
    try {
      const result = await adapter.applyChangeSet(changeSet);
      expect(result).toMatchObject({
        success: false,
        stage: 'stale-check',
        operationsAttempted: 0,
      });
      expect(protocol.calls.filter((call) => call.tool === 'execute_luau')).toHaveLength(2);
    } finally {
      await adapter.close();
    }
  });

  it('never reports compensation after an uncertain post-update transport rejection', async () => {
    const original = loadCourtyardManifest();
    const modified = renamedManifest(original);
    const changeSet = planOrThrow(modified, original.nodes);
    expect(changeSet.operations).toHaveLength(1);
    const { adapter, protocol } = await createFakeStudioAdapter({
      initialNodes: original.nodes,
      throwAfter: 'update',
    });
    try {
      const result = await adapter.applyChangeSet(changeSet);
      expect(result).toMatchObject({
        success: false,
        stage: 'apply',
        operationsAttempted: 1,
        rollback: { attempted: true, succeeded: false },
      });
      expect(
        protocol.nodes.get(
          changeSet.operations[0]!.type === 'update' ? changeSet.operations[0]!.before.id : '',
        )?.name,
      ).toBe(
        changeSet.operations[0]!.type === 'update'
          ? changeSet.operations[0]!.after.name
          : undefined,
      );
    } finally {
      await adapter.close();
    }
  });

  it('keeps bounded fault injection private despite public adapter tampering', async () => {
    const original = loadCourtyardManifest();
    const modified = renamedManifest(original);
    const changeSet = planOrThrow(modified, original.nodes);
    const { adapter, protocol } = await createFakeStudioAdapter({ initialNodes: original.nodes });
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
      await expect(
        applyStudioChangeSetWithPostMutationFault(adapter, changeSet, 'update'),
      ).resolves.toMatchObject({
        success: false,
        stage: 'apply',
        rollback: { attempted: true, succeeded: true },
      });
      expect(intercepted).toBe(false);
      expect(
        protocol.nodes.get(
          changeSet.operations[0]!.type === 'update' ? changeSet.operations[0]!.before.id : '',
        )?.name,
      ).toBe(
        changeSet.operations[0]!.type === 'update'
          ? changeSet.operations[0]!.before.name
          : undefined,
      );
    } finally {
      await adapter.close();
    }
  });

  it('queues close behind an in-flight transaction so verification can complete', async () => {
    const manifest = loadCourtyardManifest();
    const changeSet = planOrThrow(manifest);
    const { adapter, protocol } = await createFakeStudioAdapter();
    const originalInvoke = protocol.invoke.bind(protocol);
    let releaseCreate!: () => void;
    let reportCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      reportCreateStarted = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let delayed = false;
    Object.defineProperty(protocol, 'invoke', {
      configurable: true,
      value: async (...args: Parameters<typeof originalInvoke>): Promise<unknown> => {
        const [tool, argumentsValue] = args;
        if (
          !delayed &&
          tool === 'execute_luau' &&
          typeof argumentsValue['code'] === 'string' &&
          argumentsValue['code'].includes('"action": "create"')
        ) {
          delayed = true;
          reportCreateStarted();
          await createGate;
        }
        return originalInvoke(...args);
      },
    });

    const applying = adapter.applyChangeSet(changeSet);
    await createStarted;
    let closeSettled = false;
    const closing = adapter.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(protocol.closed).toBe(false);
    releaseCreate();
    await expect(applying).resolves.toMatchObject({ success: true });
    await closing;
    expect(protocol.closed).toBe(true);
    await expect(
      adapter.readSnapshot({
        projectId: manifest.source.projectId,
        target: { service: 'Workspace' },
      }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'studio.usage_invalid' })],
    });
  });

  it('never reports verified compensation after an uncertain timed-out mutation', async () => {
    vi.useFakeTimers();
    const manifest = loadCourtyardManifest();
    const changeSet = planOrThrow(manifest);
    const { adapter, protocol } = await createFakeStudioAdapter();
    const originalInvoke = protocol.invoke.bind(protocol);
    let reportCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      reportCreateStarted = resolve;
    });
    let delayed = false;
    Object.defineProperty(protocol, 'invoke', {
      configurable: true,
      value: async (
        tool: Parameters<typeof originalInvoke>[0],
        argumentsValue: Parameters<typeof originalInvoke>[1],
        signal: AbortSignal,
      ): Promise<unknown> => {
        if (
          !delayed &&
          tool === 'execute_luau' &&
          typeof argumentsValue['code'] === 'string' &&
          argumentsValue['code'].includes('"action": "create"')
        ) {
          delayed = true;
          reportCreateStarted();
          return new Promise<unknown>((resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                const abortError = new Error('Protocol observed cancellation first.');
                abortError.name = 'AbortError';
                reject(abortError);
              },
              { once: true },
            );
            setTimeout(() => {
              protocol.closed = false;
              originalInvoke(tool, argumentsValue)
                .then(resolve, reject)
                .finally(() => {
                  protocol.closed = true;
                });
            }, 30_001);
          });
        }
        return originalInvoke(tool, argumentsValue);
      },
    });

    const applying = adapter.applyChangeSet(changeSet);
    await createStarted;
    await vi.advanceTimersByTimeAsync(36_000);
    const result = await applying;
    expect(result).toMatchObject({
      success: false,
      stage: 'apply',
      rollback: { succeeded: false },
    });
    if (result.success) throw new Error('Expected a timed-out transaction failure.');
    expect(result.rollback.succeeded).toBe(false);
    expect(protocol.nodes.size).toBe(1);
    await adapter.close();
  });

  it('rejects published/running places and the operation cap before mutation', async () => {
    const manifest = loadCourtyardManifest();
    const changeSet = planOrThrow(manifest);
    const published = await createFakeStudioAdapter({ placeId: 42 });
    try {
      await expect(published.adapter.applyChangeSet(changeSet)).rejects.toMatchObject({
        diagnostics: [expect.objectContaining({ code: 'studio.published_place_forbidden' })],
      });
      expect(published.protocol.nodes.size).toBe(0);
    } finally {
      await published.adapter.close();
    }

    const oversizedManifest = largeManifest();
    const oversizedChangeSet = planOrThrow(oversizedManifest);
    expect(oversizedChangeSet.operations).toHaveLength(STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS + 1);
    const oversized = await createFakeStudioAdapter();
    try {
      await expect(oversized.adapter.applyChangeSet(oversizedChangeSet)).rejects.toMatchObject({
        diagnostics: [expect.objectContaining({ code: 'studio.operation_limit_exceeded' })],
      });
      expect(oversized.protocol.calls).toHaveLength(0);
    } finally {
      await oversized.adapter.close();
    }
  });
});
