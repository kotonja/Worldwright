import { describe, expect, it } from 'vitest';

import {
  STUDIO_APPLY_RECEIPT_SCHEMA_ID,
  STUDIO_BRIDGE_PROTOCOL_VERSION,
  STUDIO_BRIDGE_REQUEST_SCHEMA_ID,
  STUDIO_BRIDGE_RESPONSE_SCHEMA_ID,
  STUDIO_MCP_ADAPTER_VERSION,
} from '../src/constants.js';
import {
  StudioApplyReceiptSchema,
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
    const compilerCompatibleLongName = { ...folderNode('long-name-node'), name: 'n'.repeat(300) };
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
      {
        protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
        action: 'create',
        projectId: 'fixture-project',
        node: compilerCompatibleLongName,
        ...state(compilerCompatibleLongName),
      },
    ];
    expect(requests.every((request) => validateStudioBridgeRequest(request).valid)).toBe(true);
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
    const node = folderNode();
    const response = {
      protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
      action: 'snapshot',
      ok: true,
      snapshot: {
        projectId: 'fixture-project',
        nodes: [
          {
            entityId: node.id,
            projectId: 'fixture-project',
            className: 'Folder',
            name: node.name,
            parentKind: 'Workspace',
            entityKind: node.entityKind,
            compilerVersion: '0.1.0',
            adapterVersion: STUDIO_MCP_ADAPTER_VERSION,
            ...state(node),
            properties: {},
          },
        ],
        unmanagedRoots: [],
      },
    };
    expect(validateStudioBridgeResponse(response).valid).toBe(true);
    const hiddenNodes = [...response.snapshot.nodes];
    Object.defineProperty(hiddenNodes, '0', {
      value: hiddenNodes[0],
      enumerable: false,
      configurable: true,
      writable: true,
    });
    expect(
      validateStudioBridgeResponse({
        ...response,
        snapshot: { ...response.snapshot, nodes: hiddenNodes },
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
});
