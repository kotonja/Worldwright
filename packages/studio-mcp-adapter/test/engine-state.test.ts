import { describe, expect, it } from 'vitest';

import { verifyStudioRawNode } from '../src/engine-state.js';
import { loadCourtyardManifest, rawNode } from './helpers.js';

describe('exact Studio engine-state verification', () => {
  const manifest = loadCourtyardManifest();
  const root = manifest.nodes.find((node) => node.id === manifest.rootNodeId)!;
  const part = manifest.nodes.find((node) => node.className === 'Part')!;

  it('accepts canonical container and primitive states', () => {
    expect(verifyStudioRawNode(rawNode(root))).toEqual(root);
    expect(verifyStudioRawNode(rawNode(part))).toEqual(part);
  });

  it('accepts float conversion within epsilon and rejects larger drift', () => {
    const within = structuredClone(rawNode(part));
    if ('cframe' in within.properties) within.properties.cframe[0]! += 0.000001;
    expect(verifyStudioRawNode(within)).toEqual(part);

    const drifted = structuredClone(rawNode(part));
    if ('cframe' in drifted.properties) drifted.properties.cframe[0]! += 0.001;
    expect(() => verifyStudioRawNode(drifted)).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.engine_state_drift' })],
      }),
    );
  });

  it.each([
    ['Name', (value: ReturnType<typeof rawNode>) => ({ ...value, name: `${value.name} drift` })],
    ['Parent', (value: ReturnType<typeof rawNode>) => ({ ...value, parentKind: 'other' as const })],
    [
      'ClassName',
      (value: ReturnType<typeof rawNode>) => ({ ...value, className: 'WedgePart' as const }),
    ],
  ])('rejects %s drift', (_label, mutate) => {
    expect(() =>
      verifyStudioRawNode(mutate(rawNode(part)) as ReturnType<typeof rawNode>),
    ).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.engine_state_drift' })],
      }),
    );
  });

  it('rejects missing, malformed, noncanonical, and mismatched adapter metadata', () => {
    const candidates = [
      { ...rawNode(part), adapterVersion: '9.9.9' },
      { ...rawNode(part), stateJson: '{' },
      { ...rawNode(part), stateJson: `${rawNode(part).stateJson} ` },
      { ...rawNode(part), stateHash: '0'.repeat(64) },
    ];
    for (const candidate of candidates) {
      expect(() => verifyStudioRawNode(candidate as ReturnType<typeof rawNode>)).toThrowError(
        expect.objectContaining({
          diagnostics: [expect.objectContaining({ code: 'studio.adapter_metadata_invalid' })],
        }),
      );
    }
  });
});
