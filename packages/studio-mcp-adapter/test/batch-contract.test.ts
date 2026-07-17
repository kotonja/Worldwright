import { describe, expect, it } from 'vitest';

import type { RobloxChangeOperation, RobloxManagedNode } from '@worldwright/roblox-compiler';

import {
  StudioBatchRequestSchema,
  StudioBatchResponseSchema,
} from '../src/batch/contract-schema.js';
import { chunkStudioBatchOperations } from '../src/batch/chunk.js';
import { stringifyStudioBatchResponse } from '../src/batch/normalize.js';
import { buildStudioBatchOperations } from '../src/batch/request.js';
import { parseStudioBatchResponse } from '../src/batch/response.js';
import type { StudioBatchResponse } from '../src/batch/types.js';
import {
  validateStudioBatchRequest,
  validateStudioBatchResponseForRequest,
} from '../src/batch/validate.js';
import {
  STUDIO_BATCH_REQUEST_SCHEMA_ID,
  STUDIO_BATCH_RESPONSE_PREFIX,
  STUDIO_BATCH_RESPONSE_SCHEMA_ID,
  STUDIO_MCP_MAX_BRIDGE_TEXT_BYTES,
} from '../src/constants.js';

const projectId = 'project-batch-contract';
const changeSetHash = 'a'.repeat(64);
const sandboxLeaseId = 'c'.repeat(64);

function node(id: string, parentId?: string): RobloxManagedNode {
  const entityKind = parentId === undefined ? ('world' as const) : ('object' as const);
  return {
    id,
    entityKind,
    name: id,
    ...(parentId === undefined ? {} : { parentId }),
    attributes: {
      WorldwrightManaged: true,
      WorldwrightProjectId: projectId,
      WorldwrightEntityId: id,
      WorldwrightEntityKind: entityKind,
      WorldwrightCompilerVersion: '0.1.0',
      ...(parentId === undefined ? { WorldwrightSourceHash: 'b'.repeat(64) } : {}),
    },
    className: 'Folder',
    properties: {},
  };
}

function request(operationCount = 2) {
  const root = node('world-root');
  const operations: RobloxChangeOperation[] = [
    { id: 'create:world-root', type: 'create', node: root },
  ];
  for (let index = 1; index < operationCount; index += 1) {
    const id = `node-${String(index).padStart(3, '0')}`;
    operations.push({ id: `create:${id}`, type: 'create', node: node(id, root.id) });
  }
  const prepared = buildStudioBatchOperations(operations, []);
  return chunkStudioBatchOperations({
    projectId,
    changeSetHash,
    sandboxLeaseId,
    operations: prepared,
  })[0]!.request;
}

function successResponse(requestValue = request()): StudioBatchResponse {
  return {
    protocolVersion: '0.1.0',
    action: 'apply_chunk',
    ok: true,
    changeSetHash: requestValue.changeSetHash,
    chunkId: requestValue.chunkId,
    chunkIndex: requestValue.chunkIndex,
    operationsAttempted: requestValue.operations.length,
    operationsApplied: requestValue.operations.length,
    completedOperationIds: requestValue.operations.map((operation) => operation.operationId),
  };
}

function frame(response: Readonly<StudioBatchResponse>): string {
  return `${STUDIO_BATCH_RESPONSE_PREFIX}${stringifyStudioBatchResponse(response)}`;
}

describe('strict Studio batch contracts', () => {
  it('publishes separate frozen request and response schemas with stable IDs', () => {
    expect(StudioBatchRequestSchema.$id).toBe(STUDIO_BATCH_REQUEST_SCHEMA_ID);
    expect(StudioBatchResponseSchema.$id).toBe(STUDIO_BATCH_RESPONSE_SCHEMA_ID);
    expect(Object.isFrozen(StudioBatchRequestSchema)).toBe(true);
    expect(Object.isFrozen(StudioBatchResponseSchema)).toBe(true);
  });

  it('accepts a canonical batch and reuses every v0.1 operation-state check', () => {
    const valid = request();
    expect(valid.sandboxLeaseId).toBe(sandboxLeaseId);
    expect(validateStudioBatchRequest(valid)).toMatchObject({ valid: true });

    expect(
      validateStudioBatchRequest({ ...valid, sandboxLeaseId: 'not-a-lease-id' }),
    ).toMatchObject({
      valid: false,
      diagnostics: [expect.objectContaining({ path: '/sandboxLeaseId' })],
    });

    const wrongState = structuredClone(valid);
    if (wrongState.operations[0]?.type !== 'create') throw new Error('Expected a create.');
    wrongState.operations[0].stateHash = 'c'.repeat(64);
    expect(validateStudioBatchRequest(wrongState)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'studio.adapter_metadata_invalid' }),
      ]),
    });

    expect(validateStudioBatchRequest({ ...valid, extra: true })).toMatchObject({
      valid: false,
      diagnostics: [expect.objectContaining({ path: '/extra' })],
    });
  });

  it('accepts strict create, update, and delete payloads in canonical phase order', () => {
    const root = node('world-root');
    const updatedBefore = node('updated-node', root.id);
    const deleted = node('deleted-node', root.id);
    const created = node('created-node', root.id);
    const updatedAfter = { ...structuredClone(updatedBefore), name: 'Reviewed updated name' };
    const operations: RobloxChangeOperation[] = [
      { id: `create:${created.id}`, type: 'create', node: created },
      {
        id: `update:${updatedBefore.id}`,
        type: 'update',
        before: updatedBefore,
        after: updatedAfter,
      },
      { id: `delete:${deleted.id}`, type: 'delete', before: deleted },
    ];
    const prepared = buildStudioBatchOperations(operations, [root, updatedBefore, deleted]);
    const mixed = chunkStudioBatchOperations({
      projectId,
      changeSetHash,
      sandboxLeaseId,
      operations: prepared,
    })[0]!.request;
    expect(mixed.operations.map((operation) => operation.type)).toEqual([
      'create',
      'update',
      'delete',
    ]);
    expect(validateStudioBatchRequest(mixed)).toMatchObject({ valid: true });
  });

  it('binds chunk identity to the exact operation order and canonical contents', () => {
    const valid = request();
    const reordered = structuredClone(valid);
    reordered.operations.reverse();
    expect(validateStudioBatchRequest(reordered)).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ path: '/chunkId' })]),
    });
  });

  it('accepts only an exact success or failure prefix for its request', () => {
    const expected = request();
    const success = successResponse(expected);
    expect(validateStudioBatchResponseForRequest(success, expected)).toMatchObject({ valid: true });

    const failure: StudioBatchResponse = {
      protocolVersion: '0.1.0',
      action: 'apply_chunk',
      ok: false,
      changeSetHash: expected.changeSetHash,
      chunkId: expected.chunkId,
      chunkIndex: expected.chunkIndex,
      operationsAttempted: 2,
      operationsApplied: 1,
      completedOperationIds: [expected.operations[0]!.operationId],
      failedOperationId: expected.operations[1]!.operationId,
      localRestoreSucceeded: true,
      diagnostic: { code: 'studio.create_failed', message: 'Create failed.' },
    };
    expect(validateStudioBatchResponseForRequest(failure, expected)).toMatchObject({ valid: true });

    const postChunkVerificationFailure: StudioBatchResponse = {
      ...success,
      ok: false,
      localRestoreSucceeded: false,
      diagnostic: {
        code: 'studio.engine_state_drift',
        message: 'Studio batch final state verification failed.',
      },
    };
    expect(
      validateStudioBatchResponseForRequest(postChunkVerificationFailure, expected),
    ).toMatchObject({ valid: true });

    const preMutationGateFailure: StudioBatchResponse = {
      ...postChunkVerificationFailure,
      operationsAttempted: 0,
      operationsApplied: 0,
      completedOperationIds: [],
      localRestoreSucceeded: true,
      diagnostic: {
        code: 'studio.published_place_forbidden',
        message: 'Sandbox gate changed before mutation.',
      },
    };
    expect(validateStudioBatchResponseForRequest(preMutationGateFailure, expected)).toMatchObject({
      valid: true,
    });

    const sandboxIdentityFailure: StudioBatchResponse = {
      ...postChunkVerificationFailure,
      operationsAttempted: 0,
      operationsApplied: 0,
      completedOperationIds: [],
      localRestoreSucceeded: false,
      diagnostic: {
        code: 'studio.sandbox_identity_mismatch',
        message: 'The selected Studio no longer contains the transaction sandbox.',
      },
    };
    expect(validateStudioBatchResponseForRequest(sandboxIdentityFailure, expected)).toMatchObject({
      valid: true,
    });

    for (const impossibleRestore of [
      {
        ...failure,
        localRestoreSucceeded: true,
        diagnostic: {
          code: 'studio.create_cleanup_failed' as const,
          message: 'Cleanup could not be verified.',
        },
      },
      { ...postChunkVerificationFailure, localRestoreSucceeded: true },
      {
        ...postChunkVerificationFailure,
        operationsAttempted: 1,
        operationsApplied: 1,
        completedOperationIds: [expected.operations[0]!.operationId],
      },
      { ...sandboxIdentityFailure, localRestoreSucceeded: true },
    ]) {
      expect(validateStudioBatchResponseForRequest(impossibleRestore, expected)).toMatchObject({
        valid: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'studio.response_invalid' }),
        ]),
      });
    }

    expect(
      validateStudioBatchResponseForRequest(
        { ...success, completedOperationIds: [...success.completedOperationIds].reverse() },
        expected,
      ),
    ).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ path: '/completedOperationIds' }),
      ]),
    });
  });

  it('parses exact separate framing and rejects duplicate keys or trailing output', () => {
    const expected = request();
    const response = successResponse(expected);
    expect(parseStudioBatchResponse(frame(response), expected)).toEqual(response);

    const duplicate = frame(response).replace(
      '"action": "apply_chunk",',
      '"action": "apply_chunk",\n  "action": "apply_chunk",',
    );
    expect(() => parseStudioBatchResponse(duplicate, expected)).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.response_invalid' })],
      }),
    );
    expect(() => parseStudioBatchResponse(`${frame(response)} \n`, expected)).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.response_invalid' })],
      }),
    );
    expect(() => parseStudioBatchResponse(`${STUDIO_BATCH_RESPONSE_PREFIX}{`, expected)).toThrow();
    expect(() =>
      parseStudioBatchResponse(
        `${STUDIO_BATCH_RESPONSE_PREFIX}${'x'.repeat(STUDIO_MCP_MAX_BRIDGE_TEXT_BYTES)}`,
        expected,
      ),
    ).toThrow();
  });

  it('rejects response identities that do not match the exact request', () => {
    const expected = request();
    const response = successResponse(expected);
    for (const mismatch of [
      { ...response, changeSetHash: 'f'.repeat(64) },
      { ...response, chunkId: 'e'.repeat(64) },
      { ...response, chunkIndex: response.chunkIndex + 1 },
    ]) {
      expect(validateStudioBatchResponseForRequest(mismatch, expected)).toMatchObject({
        valid: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'studio.response_invalid' }),
        ]),
      });
    }
  });

  it('rejects non-JSON in-memory values without invoking accessors', () => {
    let invoked = false;
    const value = {};
    Object.defineProperty(value, 'protocolVersion', {
      enumerable: true,
      get(): string {
        invoked = true;
        return '0.1.0';
      },
    });
    expect(validateStudioBatchRequest(value)).toMatchObject({ valid: false });
    expect(invoked).toBe(false);
  });
});
