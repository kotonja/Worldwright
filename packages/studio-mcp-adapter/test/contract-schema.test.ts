import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { RobloxManifestSchema } from '@worldwright/roblox-compiler';

import { parseStudioBridgeResponse } from '../src/bridge/response.js';
import {
  STUDIO_APPLY_RECEIPT_SCHEMA_ID,
  STUDIO_BRIDGE_RESPONSE_PREFIX,
  STUDIO_BRIDGE_PROTOCOL_VERSION,
  STUDIO_BRIDGE_REQUEST_SCHEMA_ID,
  STUDIO_BRIDGE_RESPONSE_SCHEMA_ID,
  STUDIO_MCP_MAX_BRIDGE_TEXT_BYTES,
} from '../src/constants.js';
import {
  StudioApplyReceiptSchema,
  StudioBridgeManagedNodeSchema,
  StudioBridgeRequestSchema,
  StudioBridgeResponseSchema,
} from '../src/contract-schema.js';
import { hashStudioManagedNodeState } from '../src/hashing.js';
import { stringifyStudioManagedNodeState } from '../src/normalize.js';
import type { StudioBridgeManagedNode } from '../src/types.js';
import {
  validateStudioApplyReceipt,
  validateStudioBridgeRequest,
  validateStudioBridgeResponse,
} from '../src/validate.js';
import { renderStudioBridgeFixtures } from '../scripts/generate-fixtures.js';
import { compactSnapshotFixture } from '../scripts/compact-snapshot-fixture.js';

function folderNode(id = 'root-node', parentId?: string): StudioBridgeManagedNode {
  return {
    id,
    entityKind: 'structure',
    name: id,
    ...(parentId === undefined ? {} : { parentId }),
    attributes: {
      WorldwrightManaged: true,
      WorldwrightProjectId: 'fixture-project',
      WorldwrightEntityId: id,
      WorldwrightEntityKind: 'structure',
      WorldwrightCompilerVersion: '0.1.0',
    },
    className: 'Folder',
    properties: {},
  };
}

function state(node: Readonly<StudioBridgeManagedNode>): {
  readonly stateJson: string;
  readonly stateHash: string;
} {
  return {
    stateJson: stringifyStudioManagedNodeState(node),
    stateHash: hashStudioManagedNodeState(node),
  };
}

function expectDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
  if (seen.has(value as object)) return;
  seen.add(value as object);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value as object)) {
    const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
    if (descriptor !== undefined && 'value' in descriptor) expectDeepFrozen(descriptor.value, seen);
  }
}

describe('Studio adapter strict contracts', () => {
  it('publishes frozen draft-2020-12 schemas with stable IDs', () => {
    expect(StudioBridgeRequestSchema).toMatchObject({
      $id: STUDIO_BRIDGE_REQUEST_SCHEMA_ID,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
    });
    expect(StudioBridgeResponseSchema).toMatchObject({
      $id: STUDIO_BRIDGE_RESPONSE_SCHEMA_ID,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
    });
    expect(StudioApplyReceiptSchema).toMatchObject({
      $id: STUDIO_APPLY_RECEIPT_SCHEMA_ID,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
    });
    expectDeepFrozen(StudioBridgeRequestSchema);
    expectDeepFrozen(StudioBridgeResponseSchema);
    expectDeepFrozen(StudioApplyReceiptSchema);
  });

  it('accepts every exact request variant and validates canonical state metadata', () => {
    const before = folderNode();
    const after = { ...folderNode(), name: 'Updated Root' };
    const child = folderNode('child-node', before.id);
    const requests = [
      { protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION, action: 'probe' },
      {
        protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
        action: 'snapshot',
        projectId: 'fixture-project',
      },
      {
        protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
        action: 'create',
        projectId: 'fixture-project',
        node: before,
        ...state(before),
      },
      {
        protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
        action: 'create',
        projectId: 'fixture-project',
        node: child,
        ...state(child),
        parentState: { node: before, ...state(before) },
      },
      {
        protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
        action: 'update',
        projectId: 'fixture-project',
        before,
        after,
        beforeStateJson: state(before).stateJson,
        beforeStateHash: state(before).stateHash,
        afterStateJson: state(after).stateJson,
        afterStateHash: state(after).stateHash,
      },
      {
        protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
        action: 'delete',
        projectId: 'fixture-project',
        before,
        beforeStateJson: state(before).stateJson,
        beforeStateHash: state(before).stateHash,
      },
    ];
    expect(requests.every((request) => validateStudioBridgeRequest(request).valid)).toBe(true);
  });

  it.each([
    ['ASCII', 'n'],
    ['non-BMP', '\u{1f600}'],
  ])('enforces the Studio Instance.Name code-point limit for %s names', (_label, unit) => {
    const base = folderNode('name-boundary');
    const accepted = { ...base, name: unit.repeat(100) };
    const rejected = { ...base, name: unit.repeat(101) };
    expect(StudioBridgeManagedNodeSchema).toBe(RobloxManifestSchema.properties.nodes.items);
    expect(Value.Check(RobloxManifestSchema.properties.nodes.items, rejected)).toBe(true);
    expect(
      validateStudioBridgeRequest({
        protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
        action: 'create',
        projectId: 'fixture-project',
        node: accepted,
        ...state(accepted),
      }).valid,
    ).toBe(true);
    const rejectedCreate = validateStudioBridgeRequest({
      protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
      action: 'create',
      projectId: 'fixture-project',
      node: rejected,
      ...state(rejected),
    });
    expect(rejectedCreate.valid).toBe(false);
    expect(rejectedCreate.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'studio.property_invalid', path: '/node/name' }),
    );

    const rejectedAfter = validateStudioBridgeRequest({
      protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
      action: 'update',
      projectId: 'fixture-project',
      before: accepted,
      after: rejected,
      beforeStateJson: state(accepted).stateJson,
      beforeStateHash: state(accepted).stateHash,
      afterStateJson: state(rejected).stateJson,
      afterStateHash: state(rejected).stateHash,
    });
    expect(rejectedAfter.valid).toBe(false);
    expect(rejectedAfter.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'studio.property_invalid', path: '/after/name' }),
    );

    const rejectedBefore = validateStudioBridgeRequest({
      protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
      action: 'update',
      projectId: 'fixture-project',
      before: rejected,
      after: accepted,
      beforeStateJson: state(rejected).stateJson,
      beforeStateHash: state(rejected).stateHash,
      afterStateJson: state(accepted).stateJson,
      afterStateHash: state(accepted).stateHash,
    });
    expect(rejectedBefore.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'studio.property_invalid', path: '/before/name' }),
    );

    const child = folderNode('name-child', rejected.id);
    const rejectedParent = validateStudioBridgeRequest({
      protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
      action: 'create',
      projectId: 'fixture-project',
      node: child,
      ...state(child),
      parentState: { node: rejected, ...state(rejected) },
    });
    expect(rejectedParent.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'studio.property_invalid',
        path: '/parentState/node/name',
      }),
    );
  });

  it('requires exact parent metadata for managed create, update, and restoration paths', () => {
    const parent = folderNode('parent-node');
    const otherParent = folderNode('other-parent');
    const before = folderNode('child-node', parent.id);
    const after = { ...before, parentId: otherParent.id };
    const updateBase = {
      protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
      action: 'update',
      projectId: 'fixture-project',
      before,
      after,
      beforeStateJson: state(before).stateJson,
      beforeStateHash: state(before).stateHash,
      afterStateJson: state(after).stateJson,
      afterStateHash: state(after).stateHash,
      beforeParentState: { node: parent, ...state(parent) },
      afterParentState: { node: otherParent, ...state(otherParent) },
    } as const;

    expect(validateStudioBridgeRequest(updateBase).valid).toBe(true);
    expect(validateStudioBridgeRequest({ ...updateBase, beforeParentState: undefined }).valid).toBe(
      false,
    );
    expect(
      validateStudioBridgeRequest({
        protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
        action: 'create',
        projectId: 'fixture-project',
        node: before,
        ...state(before),
      }).valid,
    ).toBe(false);
    expect(
      validateStudioBridgeRequest({
        protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
        action: 'create',
        projectId: 'fixture-project',
        node: before,
        ...state(before),
        parentState: { node: otherParent, ...state(otherParent) },
      }).diagnostics,
    ).toContainEqual(expect.objectContaining({ code: 'studio.identity_invalid' }));
    expect(
      validateStudioBridgeRequest({
        protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
        action: 'create',
        projectId: 'fixture-project',
        node: parent,
        ...state(parent),
        parentState: { node: otherParent, ...state(otherParent) },
      }).valid,
    ).toBe(false);

    const sameParentAfter = { ...before, name: 'Updated Child' };
    const concurrentlyRevisedParent = { ...parent, name: 'Revised Parent' };
    expect(
      validateStudioBridgeRequest({
        protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
        action: 'update',
        projectId: 'fixture-project',
        before,
        after: sameParentAfter,
        beforeStateJson: state(before).stateJson,
        beforeStateHash: state(before).stateHash,
        afterStateJson: state(sameParentAfter).stateJson,
        afterStateHash: state(sameParentAfter).stateHash,
        beforeParentState: { node: parent, ...state(parent) },
        afterParentState: {
          node: concurrentlyRevisedParent,
          ...state(concurrentlyRevisedParent),
        },
      }).diagnostics,
    ).toContainEqual(expect.objectContaining({ code: 'studio.adapter_metadata_invalid' }));
  });

  it('rejects unknown fields, mismatched state hashes, and non-JSON accessors', () => {
    expect(
      validateStudioBridgeRequest({
        protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
        action: 'probe',
        arbitrary: true,
      }).valid,
    ).toBe(false);

    const node = folderNode();
    const invalidHash = validateStudioBridgeRequest({
      protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
      action: 'create',
      projectId: 'fixture-project',
      node,
      stateJson: state(node).stateJson,
      stateHash: '0'.repeat(64),
    });
    expect(invalidHash.valid).toBe(false);
    expect(invalidHash.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'studio.adapter_metadata_invalid' }),
    );

    let invoked = false;
    const accessor = Object.defineProperty(
      { protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION, action: 'probe' },
      'privateValue',
      {
        enumerable: true,
        get(): string {
          invoked = true;
          return 'secret';
        },
      },
    );
    expect(validateStudioBridgeRequest(accessor).valid).toBe(false);
    expect(invoked).toBe(false);

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => validateStudioBridgeRequest(revoked.proxy)).not.toThrow();
    expect(validateStudioBridgeRequest(revoked.proxy).valid).toBe(false);
    expect(validateStudioBridgeResponse(revoked.proxy).valid).toBe(false);
    expect(validateStudioApplyReceipt(revoked.proxy).valid).toBe(false);
  });

  it('accepts exact raw responses and rejects injected bridge diagnostic codes', () => {
    const baseNode = folderNode();
    const node: StudioBridgeManagedNode = {
      ...baseNode,
      entityKind: 'world',
      attributes: {
        ...baseNode.attributes,
        WorldwrightEntityKind: 'world',
        WorldwrightSourceHash: '1'.repeat(64),
      },
    };
    const response = {
      protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
      action: 'snapshot',
      ok: true,
      compactSnapshot: compactSnapshotFixture('fixture-project', [node], []),
    };
    expect(validateStudioBridgeResponse(response).valid).toBe(true);
    const hiddenNodes = [...response.compactSnapshot.nodes];
    Object.defineProperty(hiddenNodes, '0', {
      value: hiddenNodes[0],
      enumerable: false,
      configurable: true,
      writable: true,
    });
    expect(
      validateStudioBridgeResponse({
        ...response,
        compactSnapshot: { ...response.compactSnapshot, nodes: hiddenNodes },
      }).valid,
    ).toBe(false);
    expect(
      validateStudioBridgeResponse({
        protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
        action: 'snapshot',
        ok: false,
        diagnostic: { code: 'arbitrary.injected', message: 'not allowed' },
      }).valid,
    ).toBe(false);
  });

  it('keeps every generated bridge fixture inside the strict response contract', () => {
    for (const artifact of renderStudioBridgeFixtures()) {
      expect(validateStudioBridgeResponse(JSON.parse(artifact.content)).valid, artifact.label).toBe(
        true,
      );
    }
  });

  it('keeps the representative Cliffwatch compact frame below the Studio text cap', () => {
    const fixture: unknown = JSON.parse(
      readFileSync(
        new URL('../fixtures/bridge/cliffwatch-project.response.json', import.meta.url),
        'utf8',
      ),
    );
    const encoded = JSON.stringify(fixture);
    expect(encoded).toBeDefined();
    const frame = `${STUDIO_BRIDGE_RESPONSE_PREFIX}${encoded}\n`;

    expect(Buffer.byteLength(frame, 'utf8')).toBeLessThanOrEqual(STUDIO_MCP_MAX_BRIDGE_TEXT_BYTES);
    expect(parseStudioBridgeResponse(frame, 'snapshot')).toEqual(fixture);
  });
});
