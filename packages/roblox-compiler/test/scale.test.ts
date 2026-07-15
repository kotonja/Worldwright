import { describe, expect, it } from 'vitest';

import { validateRobloxManifest, validateRobloxSnapshot } from '../src/contract-validation.js';
import {
  hashRobloxManifest,
  hashRobloxSnapshot,
  stringifyRobloxChangeSet,
} from '../src/normalize.js';
import { planRobloxChangeSet } from '../src/reconcile.js';
import { simulateRobloxChangeSet } from '../src/simulate.js';
import {
  deepContainerManifest,
  emptySnapshotForManifest,
  snapshotFromManifest,
} from './helpers.js';

describe('compiler scale and stack safety', () => {
  it('validates, normalizes, plans, and simulates a 4,096-node deep hierarchy iteratively', () => {
    const nodeCount = 4_096;
    const manifest = deepContainerManifest(nodeCount);
    const populatedSnapshot = snapshotFromManifest(manifest);
    const emptySnapshot = emptySnapshotForManifest(manifest);

    expect(validateRobloxManifest(manifest).valid).toBe(true);
    expect(validateRobloxSnapshot(populatedSnapshot).valid).toBe(true);
    expect(hashRobloxManifest(manifest)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRobloxSnapshot(populatedSnapshot)).toMatch(/^[0-9a-f]{64}$/);

    const first = planRobloxChangeSet(emptySnapshot, manifest);
    const second = planRobloxChangeSet(emptySnapshot, manifest);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;

    expect(first.changeSet.operations).toHaveLength(nodeCount);
    expect(first.changeSet.summary).toEqual({
      creates: nodeCount,
      updates: 0,
      deletes: 0,
      total: nodeCount,
    });
    expect(stringifyRobloxChangeSet(second.changeSet)).toBe(
      stringifyRobloxChangeSet(first.changeSet),
    );

    const created = new Set<string>();
    for (const operation of first.changeSet.operations) {
      if (operation.type !== 'create') throw new Error('Scale plan must contain only creates.');
      if (operation.node.parentId !== undefined) {
        expect(created.has(operation.node.parentId)).toBe(true);
      }
      created.add(operation.node.id);
    }

    const simulation = simulateRobloxChangeSet(emptySnapshot, first.changeSet);
    expect(simulation.success).toBe(true);
    if (simulation.success) {
      expect(simulation.snapshot.nodes).toHaveLength(nodeCount);
      expect(hashRobloxSnapshot(simulation.snapshot)).toBe(
        first.changeSet.preconditions.resultSnapshotHash,
      );
    }
  }, 30_000);
});
