import { describe, expect, it } from 'vitest';

import {
  hashRobloxChangeSet,
  hashRobloxManagedSnapshotState,
  hashRobloxManifest,
  hashRobloxSnapshot,
  normalizeRobloxChangeSet,
  normalizeRobloxManifest,
  normalizeRobloxSnapshot,
  sha256Hex,
  stringifyRobloxChangeSet,
  stringifyRobloxManifest,
  stringifyRobloxSnapshot,
} from '../src/normalize.js';
import { planRobloxChangeSet } from '../src/reconcile.js';
import {
  clone,
  compilePrimitiveFixture,
  emptySnapshotForManifest,
  snapshotFromManifest,
} from './helpers.js';

describe('Roblox compiler normalization and hashing', () => {
  it('sorts nodes and unmanaged-root records by code point without mutating inputs', () => {
    const manifest = compilePrimitiveFixture();
    manifest.nodes.reverse();
    const manifestBefore = clone(manifest);
    const normalizedManifest = normalizeRobloxManifest(manifest);

    expect(manifest).toEqual(manifestBefore);
    expect(normalizedManifest.nodes.map((node) => node.id)).toEqual(
      [...normalizedManifest.nodes.map((node) => node.id)].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );

    const snapshot = snapshotFromManifest(normalizedManifest, [
      { snapshotId: 'zeta', parentNodeId: 'north-wall', name: 'Zeta' },
      { snapshotId: 'alpha', parentNodeId: 'south-wall', name: 'Alpha' },
    ]);
    snapshot.nodes.reverse();
    const snapshotBefore = clone(snapshot);
    const normalizedSnapshot = normalizeRobloxSnapshot(snapshot);

    expect(snapshot).toEqual(snapshotBefore);
    expect(normalizedSnapshot.unmanagedRoots.map((root) => root.snapshotId)).toEqual([
      'alpha',
      'zeta',
    ]);
    expect(normalizedSnapshot.nodes.map((node) => node.id)).toEqual(
      normalizedManifest.nodes.map((node) => node.id),
    );
  });

  it('orders Unicode strings by scalar code point rather than UTF-16 code unit', () => {
    const manifest = compilePrimitiveFixture();
    const snapshot = snapshotFromManifest(manifest, [
      { snapshotId: '\u{1f600}', parentNodeId: 'north-wall', name: 'Astral code point' },
      { snapshotId: '\ue000', parentNodeId: 'south-wall', name: 'BMP code point' },
    ]);

    expect(normalizeRobloxSnapshot(snapshot).unmanagedRoots.map((root) => root.snapshotId)).toEqual(
      ['\ue000', '\u{1f600}'],
    );
  });

  it('returns deeply independent normalized values', () => {
    const manifest = compilePrimitiveFixture();
    const normalized = normalizeRobloxManifest(manifest);
    const originalName = manifest.nodes[0]?.name;
    if (normalized.nodes[0] === undefined) throw new Error('Expected a normalized node.');

    normalized.nodes[0].name = 'Changed only in normalized value';

    expect(manifest.nodes[0]?.name).toBe(originalName);
  });

  it('serializes canonical JSON with code-point key order, two spaces, and one final line feed', () => {
    const bytes = stringifyRobloxManifest(compilePrimitiveFixture());

    expect(bytes.endsWith('\n')).toBe(true);
    expect(bytes.endsWith('\n\n')).toBe(false);
    expect(bytes).not.toContain('\r');
    expect(bytes).toMatch(/^\{\n {2}"compilerVersion":/);
    expect(bytes).toContain('\n    "containers":');
    expect(bytes).not.toContain('\t');
    expect(JSON.parse(bytes)).toEqual(
      JSON.parse(stringifyRobloxManifest(compilePrimitiveFixture())),
    );
  });

  it('normalizes equivalent manifest and snapshot collection order to identical bytes and hashes', () => {
    const firstManifest = compilePrimitiveFixture();
    const secondManifest = clone(firstManifest);
    secondManifest.nodes.reverse();

    expect(stringifyRobloxManifest(secondManifest)).toBe(stringifyRobloxManifest(firstManifest));
    expect(hashRobloxManifest(secondManifest)).toBe(hashRobloxManifest(firstManifest));

    const roots = [
      { snapshotId: 'user-b', parentNodeId: 'north-wall', name: 'B' },
      { snapshotId: 'user-a', parentNodeId: 'south-wall', name: 'A' },
    ];
    const firstSnapshot = snapshotFromManifest(firstManifest, roots);
    const secondSnapshot = snapshotFromManifest(secondManifest, [...roots].reverse());
    secondSnapshot.nodes.reverse();

    expect(stringifyRobloxSnapshot(secondSnapshot)).toBe(stringifyRobloxSnapshot(firstSnapshot));
    expect(hashRobloxSnapshot(secondSnapshot)).toBe(hashRobloxSnapshot(firstSnapshot));
  });

  it('canonicalizes negative zero before equality checks and JSON round trips', () => {
    const manifest = compilePrimitiveFixture();
    const part = manifest.nodes.find((node) => node.className === 'Part');
    if (part === undefined) throw new Error('Expected the fixture to contain a Part.');
    part.properties.position.x = -0;

    const normalizedManifest = normalizeRobloxManifest(manifest);
    const normalizedPart = normalizedManifest.nodes.find((node) => node.id === part.id);
    if (normalizedPart?.className !== 'Part') {
      throw new Error('Expected the normalized fixture node to remain a Part.');
    }
    expect(Object.is(normalizedPart.properties.position.x, -0)).toBe(false);

    const roundTrippedSnapshot = JSON.parse(
      stringifyRobloxSnapshot(snapshotFromManifest(manifest)),
    ) as unknown;
    const plan = planRobloxChangeSet(roundTrippedSnapshot, manifest);

    expect(plan.success).toBe(true);
    if (!plan.success) throw new Error(JSON.stringify(plan.diagnostics));
    expect(plan.changeSet.operations).toEqual([]);
    expect(plan.changeSet.preconditions.baseSnapshotHash).toBe(
      plan.changeSet.preconditions.resultSnapshotHash,
    );
  });

  it('includes unmanaged-root markers in the complete snapshot hash', () => {
    const manifest = compilePrimitiveFixture();
    const withoutUserContent = snapshotFromManifest(manifest);
    const withUserContent = snapshotFromManifest(manifest, [
      { snapshotId: 'user-model-1', parentNodeId: 'north-wall', name: 'User Model' },
    ]);

    expect(hashRobloxSnapshot(withUserContent)).not.toBe(hashRobloxSnapshot(withoutUserContent));
    expect(hashRobloxManagedSnapshotState(withUserContent)).toBe(
      hashRobloxManagedSnapshotState(withoutUserContent),
    );
  });

  it('changes manifest and snapshot hashes when managed desired or observed state changes', () => {
    const manifest = compilePrimitiveFixture();
    const changedManifest = clone(manifest);
    const node = changedManifest.nodes.find((entry) => entry.id === 'north-wall');
    if (node === undefined) throw new Error('Fixture node is missing.');
    node.name = 'Renamed Wall';

    expect(hashRobloxManifest(changedManifest)).not.toBe(hashRobloxManifest(manifest));
    expect(hashRobloxSnapshot(snapshotFromManifest(changedManifest))).not.toBe(
      hashRobloxSnapshot(snapshotFromManifest(manifest)),
    );
  });

  it('normalizes and hashes change sets deterministically without mutating them', () => {
    const manifest = compilePrimitiveFixture();
    const plan = planRobloxChangeSet(emptySnapshotForManifest(manifest), manifest);
    if (!plan.success) throw new Error(JSON.stringify(plan.diagnostics));
    const before = clone(plan.changeSet);
    const firstNormalized = normalizeRobloxChangeSet(plan.changeSet);
    const secondNormalized = normalizeRobloxChangeSet(clone(plan.changeSet));

    expect(plan.changeSet).toEqual(before);
    expect(secondNormalized).toEqual(firstNormalized);
    expect(stringifyRobloxChangeSet(secondNormalized)).toBe(
      stringifyRobloxChangeSet(firstNormalized),
    );
    expect(hashRobloxChangeSet(secondNormalized)).toBe(hashRobloxChangeSet(firstNormalized));
  });

  it('emits lowercase hexadecimal SHA-256 with a known deterministic vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    for (const hash of [
      hashRobloxManifest(compilePrimitiveFixture()),
      hashRobloxSnapshot(snapshotFromManifest(compilePrimitiveFixture())),
    ]) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
