import { describe, expect, it } from 'vitest';

import { hashRobloxSnapshot } from '@worldwright/roblox-compiler';

import { snapshotFromStudioCompact, snapshotFromStudioRaw } from '../src/snapshot.js';
import { deriveUnmanagedRoot } from '../src/unmanaged.js';
import { validateStudioBridgeResponse } from '../src/validate.js';
import { compactSnapshotFixture } from '../scripts/compact-snapshot-fixture.js';
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

  it('round-trips the exact compiler snapshot through compact dictionaries and tuples', () => {
    const unmanaged = {
      parentEntityId: manifest.rootNodeId,
      className: 'Folder',
      name: 'Creator Content',
      structuralPath: `${manifest.rootNodeId}/Folder/Creator Content/1`,
      ordinal: 1,
    } as const;
    const compact = compactSnapshotFixture(manifest.source.projectId, manifest.nodes, [unmanaged]);
    const snapshot = snapshotFromStudioCompact(compact, manifest.source.projectId);
    expect(snapshot.nodes).toEqual(manifest.nodes);
    expect(snapshot.rootNodeId).toBe(manifest.rootNodeId);
    expect(snapshot.unmanagedRoots).toEqual([deriveUnmanagedRoot(unmanaged)]);
  });

  it('front-codes shared non-BMP name prefixes by Unicode code point and rejects non-maximal coding', () => {
    const unicodeNodes = manifest.nodes.map((node, index) => ({
      ...node,
      name: index === 0 ? '😀alpha' : index === 1 ? '😀beta' : node.name,
    }));
    const compact = compactSnapshotFixture(manifest.source.projectId, unicodeNodes, []);
    const betaIndex = compact.names.findIndex(([, suffix]) => suffix === 'beta');
    expect(betaIndex).toBeGreaterThan(0);
    expect(compact.names[betaIndex]).toEqual([1, 'beta']);
    expect(snapshotFromStudioCompact(compact, manifest.source.projectId).nodes).toEqual(
      unicodeNodes,
    );

    const nonMaximal = structuredClone(compact);
    nonMaximal.names[betaIndex] = [0, '😀beta'];
    const result = validateStudioBridgeResponse({
      protocolVersion: '0.1.0',
      action: 'snapshot',
      ok: true,
      compactSnapshot: nonMaximal,
    });
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'studio.response_invalid' }),
    );

    for (const unpairedSurrogate of ['\ud800', '\udc00']) {
      const malformedUnicode = structuredClone(compact);
      malformedUnicode.names[0] = [0, unpairedSurrogate];
      const malformedResult = validateStudioBridgeResponse({
        protocolVersion: '0.1.0',
        action: 'snapshot',
        ok: true,
        compactSnapshot: malformedUnicode,
      });
      expect(malformedResult.valid).toBe(false);
      expect(malformedResult.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'studio.response_invalid',
          message: 'Decoded compact names must contain only Unicode scalar values.',
        }),
      );
    }
  });

  it.each([
    ['ASCII', 'n'],
    ['non-BMP', '\u{1f600}'],
  ])('accepts 100-code-point %s names and rejects decoded 101-code-point names', (_label, unit) => {
    const acceptedNodes = manifest.nodes.map((node, index) => ({
      ...node,
      name: index === 0 ? unit.repeat(100) : node.name,
    }));
    const accepted = compactSnapshotFixture(manifest.source.projectId, acceptedNodes, []);
    expect(
      validateStudioBridgeResponse({
        protocolVersion: '0.1.0',
        action: 'snapshot',
        ok: true,
        compactSnapshot: accepted,
      }).valid,
    ).toBe(true);

    const rejectedNodes = manifest.nodes.map((node, index) => ({
      ...node,
      name: index === 0 ? unit.repeat(100) : index === 1 ? `${unit.repeat(100)}z` : node.name,
    }));
    const rejected = compactSnapshotFixture(manifest.source.projectId, rejectedNodes, []);
    const result = validateStudioBridgeResponse({
      protocolVersion: '0.1.0',
      action: 'snapshot',
      ok: true,
      compactSnapshot: rejected,
    });
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'studio.response_invalid',
        message: expect.stringContaining('exceeds 100 Unicode scalar values'),
      }),
    );

    const overlongUnmanaged = compactSnapshotFixture(manifest.source.projectId, acceptedNodes, [
      {
        parentEntityId: manifest.rootNodeId,
        className: 'Folder',
        name: `${unit.repeat(100)}z`,
        structuralPath: 'ignored-by-compact-fixture',
        ordinal: 1,
      },
    ]);
    const unmanagedResult = validateStudioBridgeResponse({
      protocolVersion: '0.1.0',
      action: 'snapshot',
      ok: true,
      compactSnapshot: overlongUnmanaged,
    });
    expect(unmanagedResult.valid).toBe(false);
    expect(unmanagedResult.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'studio.response_invalid' }),
    );

    const root = manifest.nodes.find((node) => node.id === manifest.rootNodeId)!;
    const acceptedRoot = { ...root, name: unit.repeat(100) };
    expect(() =>
      snapshotFromStudioRaw(
        {
          projectId: manifest.source.projectId,
          nodes: [rawNode(acceptedRoot)],
          unmanagedRoots: [],
        },
        manifest.source.projectId,
      ),
    ).not.toThrow();
    const rejectedRoot = { ...root, name: unit.repeat(101) };
    expect(() =>
      snapshotFromStudioRaw(
        {
          projectId: manifest.source.projectId,
          nodes: [rawNode(rejectedRoot)],
          unmanagedRoots: [],
        },
        manifest.source.projectId,
      ),
    ).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.response_invalid' })],
      }),
    );
    expect(() =>
      snapshotFromStudioRaw(
        {
          projectId: manifest.source.projectId,
          nodes: [rawNode(acceptedRoot)],
          unmanagedRoots: [
            {
              parentEntityId: acceptedRoot.id,
              className: 'Folder',
              name: unit.repeat(101),
              structuralPath: `${acceptedRoot.id}/Folder/overlong/1`,
              ordinal: 1,
            },
          ],
        },
        manifest.source.projectId,
      ),
    ).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.response_invalid' })],
      }),
    );
  });

  it('rejects malformed packed hashes and canonical state-hash mismatches', () => {
    const compact = compactSnapshotFixture(manifest.source.projectId, manifest.nodes, []);
    const wrongLength = { ...compact, stateHashesZ85: compact.stateHashesZ85.slice(1) };
    const lengthResult = validateStudioBridgeResponse({
      protocolVersion: '0.1.0',
      action: 'snapshot',
      ok: true,
      compactSnapshot: wrongLength,
    });
    expect(lengthResult.valid).toBe(false);
    expect(lengthResult.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'studio.response_invalid' }),
    );

    const noncanonicalGroup = {
      ...compact,
      stateHashesZ85: `#####${compact.stateHashesZ85.slice(5)}`,
    };
    const groupResult = validateStudioBridgeResponse({
      protocolVersion: '0.1.0',
      action: 'snapshot',
      ok: true,
      compactSnapshot: noncanonicalGroup,
    });
    expect(groupResult.valid).toBe(false);
    expect(groupResult.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'studio.response_invalid' }),
    );

    const mismatch = {
      ...compact,
      stateHashesZ85: '0'.repeat(compact.nodes.length * 40),
    };
    const mismatchResult = validateStudioBridgeResponse({
      protocolVersion: '0.1.0',
      action: 'snapshot',
      ok: true,
      compactSnapshot: mismatch,
    });
    expect(mismatchResult.valid).toBe(false);
    expect(mismatchResult.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'studio.adapter_metadata_invalid' }),
    );
  });

  it('rejects malformed compact indexes and noncanonical dictionaries', () => {
    const compact = compactSnapshotFixture(manifest.source.projectId, manifest.nodes, []);
    const malformedIndex = structuredClone(compact);
    (malformedIndex.nodes[0] as unknown as unknown[])[3] = malformedIndex.names.length;
    const malformedResult = validateStudioBridgeResponse({
      protocolVersion: '0.1.0',
      action: 'snapshot',
      ok: true,
      compactSnapshot: malformedIndex,
    });
    expect(malformedResult.valid).toBe(false);
    expect(malformedResult.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'studio.response_invalid' }),
    );

    const noncanonicalDictionary = structuredClone(compact);
    noncanonicalDictionary.names.reverse();
    const dictionaryResult = validateStudioBridgeResponse({
      protocolVersion: '0.1.0',
      action: 'snapshot',
      ok: true,
      compactSnapshot: noncanonicalDictionary,
    });
    expect(dictionaryResult.valid).toBe(false);
    expect(dictionaryResult.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'studio.response_invalid' }),
    );
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
