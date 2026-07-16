import { describe, expect, it } from 'vitest';

import { hashRobloxSnapshot } from '@worldwright/roblox-compiler';

import { snapshotFromStudioRaw } from '../src/snapshot.js';
import { deriveUnmanagedRoot } from '../src/unmanaged.js';
import { loadCourtyardManifest, rawNode } from './helpers.js';

describe('live snapshot conversion', () => {
  const manifest = loadCourtyardManifest();

  it('returns the canonical valid empty project snapshot', () => {
    expect(
      snapshotFromStudioRaw(
        { projectId: manifest.source.projectId, nodes: [], unmanagedRoots: [] },
        manifest.source.projectId,
      ),
    ).toEqual({
      schemaVersion: '0.1.0',
      projectId: manifest.source.projectId,
      target: { service: 'Workspace' },
      nodes: [],
      unmanagedRoots: [],
    });
  });

  it('validates a complete managed hierarchy and deterministic unmanaged marker', () => {
    const unmanaged = {
      parentEntityId: manifest.rootNodeId,
      className: 'Folder',
      name: 'Creator Content',
      structuralPath: `${manifest.rootNodeId}/Folder/Creator Content/1`,
      ordinal: 1,
    } as const;
    const snapshot = snapshotFromStudioRaw(
      {
        projectId: manifest.source.projectId,
        nodes: manifest.nodes.map((node) => rawNode(node)),
        unmanagedRoots: [unmanaged],
      },
      manifest.source.projectId,
    );
    expect(snapshot.rootNodeId).toBe(manifest.rootNodeId);
    expect(snapshot.nodes).toHaveLength(manifest.nodes.length);
    expect(snapshot.unmanagedRoots).toEqual([deriveUnmanagedRoot(unmanaged)]);
    expect(hashRobloxSnapshot(snapshot)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('changes unmanaged identity on rename, reparent, class, path, or ordinal changes', () => {
    const base = {
      parentEntityId: manifest.rootNodeId,
      className: 'Folder',
      name: 'Content',
      structuralPath: 'root/Folder/Content/1',
      ordinal: 1,
    } as const;
    const baseId = deriveUnmanagedRoot(base).snapshotId;
    const variants = [
      { ...base, name: 'Renamed' },
      { ...base, parentEntityId: 'courtyard-region' },
      { ...base, className: 'Model' },
      { ...base, structuralPath: 'root/Folder/Content/2' },
      { ...base, ordinal: 2 },
    ];
    for (const variant of variants)
      expect(deriveUnmanagedRoot(variant).snapshotId).not.toBe(baseId);
  });

  it('keeps unmanaged identity stable across response ordering and unrelated siblings', () => {
    const duplicateRoots = [1, 2].map((ordinal) => ({
      parentEntityId: manifest.rootNodeId,
      className: 'Folder',
      name: 'Creator Content',
      structuralPath: `${manifest.rootNodeId}/Folder/Creator Content/${ordinal}`,
      ordinal,
    }));
    const unrelated = {
      parentEntityId: manifest.rootNodeId,
      className: 'Model',
      name: 'Unrelated',
      structuralPath: `${manifest.rootNodeId}/Model/Unrelated/1`,
      ordinal: 1,
    } as const;
    const nodes = manifest.nodes.map((node) => rawNode(node));
    const first = snapshotFromStudioRaw(
      {
        projectId: manifest.source.projectId,
        nodes,
        unmanagedRoots: [duplicateRoots[0]!, unrelated, duplicateRoots[1]!],
      },
      manifest.source.projectId,
    );
    const reordered = snapshotFromStudioRaw(
      {
        projectId: manifest.source.projectId,
        nodes,
        unmanagedRoots: [duplicateRoots[1]!, duplicateRoots[0]!, unrelated],
      },
      manifest.source.projectId,
    );
    const withoutUnrelated = snapshotFromStudioRaw(
      {
        projectId: manifest.source.projectId,
        nodes,
        unmanagedRoots: duplicateRoots,
      },
      manifest.source.projectId,
    );

    expect(reordered.unmanagedRoots).toEqual(first.unmanagedRoots);
    expect(hashRobloxSnapshot(reordered)).toBe(hashRobloxSnapshot(first));
    expect(first.unmanagedRoots.filter((entry) => entry.name === 'Creator Content')).toEqual(
      withoutUnrelated.unmanagedRoots,
    );
  });

  it('rejects wrong projects, duplicate identities, malformed roots, and broken hierarchy', () => {
    expect(() =>
      snapshotFromStudioRaw(
        { projectId: 'another-project', nodes: [], unmanagedRoots: [] },
        manifest.source.projectId,
      ),
    ).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.project_mismatch' })],
      }),
    );

    const root = manifest.nodes.find((node) => node.id === manifest.rootNodeId)!;
    expect(() =>
      snapshotFromStudioRaw(
        {
          projectId: manifest.source.projectId,
          nodes: [rawNode(root), rawNode(root)],
          unmanagedRoots: [],
        },
        manifest.source.projectId,
      ),
    ).toThrow();

    const child = manifest.nodes.find((node) => node.parentId !== undefined)!;
    expect(() =>
      snapshotFromStudioRaw(
        {
          projectId: manifest.source.projectId,
          nodes: [rawNode(child)],
          unmanagedRoots: [],
        },
        manifest.source.projectId,
      ),
    ).toThrow();
  });
});
