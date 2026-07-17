import { readFileSync } from 'node:fs';

import {
  planRobloxChangeSet,
  type RobloxChangeSet,
  type RobloxManifest,
  type RobloxSnapshot,
} from '@worldwright/roblox-compiler';
import { describe, expect, it } from 'vitest';

import {
  applyStudioChangeSetWithLostBatchAcknowledgment,
  applyStudioChangeSetWithLostForwardAndCompensationAcknowledgments,
} from '../src/testing.js';
import { createFakeStudioAdapter, loadCourtyardManifest } from './helpers.js';

function loadCliffwatchChangeSet(): RobloxChangeSet {
  return JSON.parse(
    readFileSync(
      new URL(
        '../../architecture-planner/fixtures/change-sets/create-cliffwatch-blockout.change-set.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as RobloxChangeSet;
}

function snapshotFromManifest(manifest: Readonly<RobloxManifest>): RobloxSnapshot {
  return {
    schemaVersion: '0.1.0',
    projectId: manifest.source.projectId,
    target: { service: 'Workspace' },
    rootNodeId: manifest.rootNodeId,
    nodes: structuredClone(manifest.nodes),
    unmanagedRoots: [],
  };
}

function renamedManifest(manifest: Readonly<RobloxManifest>): RobloxManifest {
  const target = manifest.nodes.find((node) => node.id === 'east-wall')!;
  return {
    ...structuredClone(manifest),
    nodes: manifest.nodes.map((node) =>
      node.id === target.id
        ? { ...structuredClone(node), name: 'East Wall Reviewed' }
        : structuredClone(node),
    ),
  };
}

function updatePlan() {
  const original = loadCourtyardManifest();
  const desired = renamedManifest(original);
  const plan = planRobloxChangeSet(snapshotFromManifest(original), desired);
  if (!plan.success) throw new Error('Update fixture planning failed.');
  return { original, changeSet: plan.changeSet };
}

describe('Studio chunked transaction transport', () => {
  it('applies the canonical 400-create transition in 13 mutation calls and verifies final state', async () => {
    const changeSet = loadCliffwatchChangeSet();
    const fake = await createFakeStudioAdapter();
    try {
      const applied = await fake.adapter.applyChangeSetDetailed(changeSet);
      if (!applied.result.success) {
        throw new Error(`Cliffwatch batch apply failed: ${JSON.stringify(applied)}`);
      }
      expect(applied.result).toMatchObject({
        success: true,
        status: 'applied',
        operationsAttempted: 400,
        finalSnapshotHash: changeSet.preconditions.resultSnapshotHash,
      });
      expect(applied.transportReport).toMatchObject({
        operationsPlanned: 400,
        operationsAttempted: 400,
        operationsAppliedBeforeFailure: 400,
        chunksPlanned: 13,
        chunksAttempted: 13,
        chunksCompleted: 13,
        mutationExecuteCalls: 13,
        reconnectAttempts: 0,
        finalOutcome: 'applied',
      });
      expect(fake.protocol.nodes.size).toBe(400);
    } finally {
      await fake.adapter.close();
    }
  }, 30_000);

  it('performs no mutation call for a canonical no-op', async () => {
    const manifest = loadCourtyardManifest();
    const plan = planRobloxChangeSet(snapshotFromManifest(manifest), manifest);
    if (!plan.success) throw new Error('No-op fixture planning failed.');
    const fake = await createFakeStudioAdapter({ initialNodes: manifest.nodes });
    try {
      const applied = await fake.adapter.applyChangeSetDetailed(plan.changeSet);
      expect(applied.result).toMatchObject({ success: true, status: 'noop' });
      expect(applied.transportReport).toMatchObject({
        operationsPlanned: 0,
        mutationExecuteCalls: 0,
        finalOutcome: 'noop',
      });
    } finally {
      await fake.adapter.close();
    }
  });

  it('reconnects after a lost response, classifies complete progress, and restores the base', async () => {
    const { original, changeSet } = updatePlan();
    const fake = await createFakeStudioAdapter({ initialNodes: original.nodes });
    try {
      const applied = await applyStudioChangeSetWithLostBatchAcknowledgment(
        fake.adapter,
        changeSet,
      );
      expect(applied.result).toMatchObject({
        success: false,
        stage: 'apply',
        rollback: {
          attempted: true,
          succeeded: true,
          restoredSnapshotHash: changeSet.preconditions.baseSnapshotHash,
        },
      });
      expect(applied.transportReport).toMatchObject({
        operationsPlanned: 1,
        operationsAttempted: 1,
        operationsAppliedBeforeFailure: 1,
        chunksPlanned: 1,
        chunksAttempted: 1,
        mutationExecuteCalls: 2,
        uncertainTransportEvents: 1,
        reconnectAttempts: 1,
        reconnectsSucceeded: 1,
        compensationOperationsAttempted: 1,
        compensationOperationsApplied: 1,
        compensationChunksAttempted: 1,
        compensationChunksCompleted: 1,
        finalOutcome: 'failed-restored',
      });
      expect(fake.protocol.nodes.get('east-wall')?.name).toBe('East Brick Wall');
    } finally {
      await fake.adapter.close();
    }
  });

  it('uses the second exact-session reconnect after a lost compensation acknowledgment', async () => {
    const { original, changeSet } = updatePlan();
    const fake = await createFakeStudioAdapter({ initialNodes: original.nodes });
    try {
      const applied = await applyStudioChangeSetWithLostForwardAndCompensationAcknowledgments(
        fake.adapter,
        changeSet,
      );
      expect(applied.result).toMatchObject({
        success: false,
        stage: 'apply',
        rollback: {
          attempted: true,
          succeeded: true,
          restoredSnapshotHash: changeSet.preconditions.baseSnapshotHash,
        },
      });
      expect(applied.transportReport).toMatchObject({
        operationsPlanned: 1,
        operationsAttempted: 1,
        operationsAppliedBeforeFailure: 1,
        uncertainTransportEvents: 2,
        reconnectAttempts: 2,
        reconnectsSucceeded: 2,
        compensationOperationsAttempted: 1,
        compensationOperationsApplied: 0,
        compensationChunksAttempted: 1,
        compensationChunksCompleted: 0,
        mutationExecuteCalls: 2,
        finalOutcome: 'failed-restored',
      });
      expect(fake.protocol.nodes.get('east-wall')?.name).toBe('East Brick Wall');
    } finally {
      await fake.adapter.close();
    }
  });

  it('makes zero compensation calls when reconnect observation contains unrelated managed drift', async () => {
    const { original, changeSet } = updatePlan();
    const fake = await createFakeStudioAdapter({
      initialNodes: original.nodes,
      beforeReconnect: (protocol) => {
        const unrelated = protocol.nodes.get('west-wall')!;
        protocol.nodes.set(unrelated.id, { ...unrelated, name: 'Concurrent Creator Edit' });
      },
    });
    try {
      const applied = await applyStudioChangeSetWithLostBatchAcknowledgment(
        fake.adapter,
        changeSet,
      );
      expect(applied.result).toMatchObject({
        success: false,
        rollback: { attempted: true, succeeded: false },
      });
      expect(applied.transportReport).toMatchObject({
        mutationExecuteCalls: 1,
        compensationChunksAttempted: 0,
        reconnectAttempts: 1,
        finalOutcome: 'failed-unsafe',
      });
      expect(fake.protocol.nodes.get('west-wall')?.name).toBe('Concurrent Creator Edit');
    } finally {
      await fake.adapter.close();
    }
  });

  it('refuses compensation when the exact reconnected Studio is published or running', async () => {
    for (const mode of ['published', 'running'] as const) {
      const { original, changeSet } = updatePlan();
      const fake = await createFakeStudioAdapter({
        initialNodes: original.nodes,
        beforeReconnect: (protocol) => {
          if (mode === 'published') {
            protocol.placeId = 42;
            protocol.gameId = 42;
          } else {
            protocol.running = true;
          }
        },
      });
      try {
        const applied = await applyStudioChangeSetWithLostBatchAcknowledgment(
          fake.adapter,
          changeSet,
        );
        expect(applied.result).toMatchObject({
          success: false,
          rollback: { attempted: true, succeeded: false },
        });
        expect(applied.transportReport).toMatchObject({
          mutationExecuteCalls: 1,
          compensationChunksAttempted: 0,
          reconnectAttempts: 1,
          reconnectsSucceeded: 0,
          finalOutcome: 'failed-unrestored',
        });
      } finally {
        await fake.adapter.close();
      }
    }
  });
});
