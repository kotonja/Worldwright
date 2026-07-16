import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type {
  RobloxChangeOperation,
  RobloxChangeSet,
  RobloxManagedNode,
} from '@worldwright/roblox-compiler';

import { chunkStudioBatchOperations } from '../src/batch/chunk.js';
import { buildStudioBatchOperations } from '../src/batch/request.js';
import { STUDIO_MCP_MAX_BATCH_OPERATIONS } from '../src/constants.js';

const projectId = 'project-batch-chunking';
const changeSetHash = 'd'.repeat(64);

function node(id: string, parentId?: string): RobloxManagedNode {
  const entityKind = parentId === undefined ? ('world' as const) : ('object' as const);
  return {
    id,
    entityKind,
    name: `Node ${id}`,
    ...(parentId === undefined ? {} : { parentId }),
    attributes: {
      WorldwrightManaged: true,
      WorldwrightProjectId: projectId,
      WorldwrightEntityId: id,
      WorldwrightEntityKind: entityKind,
      WorldwrightCompilerVersion: '0.1.0',
      ...(parentId === undefined ? { WorldwrightSourceHash: 'e'.repeat(64) } : {}),
    },
    className: 'Folder',
    properties: {},
  };
}

function createOperations(count: number): RobloxChangeOperation[] {
  const output: RobloxChangeOperation[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = index === 0 ? 'world-root' : `node-${String(index).padStart(4, '0')}`;
    output.push({
      id: `create:${id}`,
      type: 'create',
      node: node(id, index === 0 ? undefined : 'world-root'),
    });
  }
  return output;
}

function prepared(count: number) {
  return buildStudioBatchOperations(createOperations(count), []);
}

function chunk(count: number) {
  return chunkStudioBatchOperations({
    projectId,
    changeSetHash,
    operations: prepared(count),
  });
}

describe('deterministic Studio batch chunking', () => {
  it('handles zero, one, exactly 32, and 33 operations without empty chunks', () => {
    expect(chunk(0)).toEqual([]);
    expect(chunk(1).map((entry) => entry.request.operations.length)).toEqual([1]);
    expect(chunk(32).map((entry) => entry.request.operations.length)).toEqual([32]);
    expect(chunk(33).map((entry) => entry.request.operations.length)).toEqual([32, 1]);
    expect(chunk(33).every((entry) => entry.request.operations.length > 0)).toBe(true);
  });

  it('splits before a byte bound and rejects one operation that cannot fit', () => {
    const operations = prepared(2);
    const unrestricted = chunkStudioBatchOperations({ projectId, changeSetHash, operations });
    const twoOperationBytes = unrestricted[0]!.canonicalRequestBytes;
    const oneOperationBytes = chunkStudioBatchOperations({
      projectId,
      changeSetHash,
      operations: operations.slice(0, 1),
    })[0]!.canonicalRequestBytes;
    expect(twoOperationBytes).toBeGreaterThan(oneOperationBytes);
    expect(
      chunkStudioBatchOperations(
        { projectId, changeSetHash, operations },
        {
          maxOperations: STUDIO_MCP_MAX_BATCH_OPERATIONS,
          maxPayloadBytes: twoOperationBytes - 1,
        },
      ).map((entry) => entry.request.operations.length),
    ).toEqual([1, 1]);
    expect(() =>
      chunkStudioBatchOperations(
        { projectId, changeSetHash, operations: operations.slice(0, 1) },
        { maxOperations: STUDIO_MCP_MAX_BATCH_OPERATIONS, maxPayloadBytes: oneOperationBytes - 1 },
      ),
    ).toThrowError();
  });

  it('preserves exact operation order and parent state across prepared operations', () => {
    const operations = createOperations(3);
    const batchOperations = buildStudioBatchOperations(operations, []);
    expect(batchOperations.map((operation) => operation.operationId)).toEqual(
      operations.map((operation) => operation.id),
    );
    const child = batchOperations[1];
    expect(child?.type).toBe('create');
    if (child?.type !== 'create') throw new Error('Expected a create operation.');
    expect(child.parentState?.node.id).toBe('world-root');
  });

  it('produces byte-identical deterministic IDs and deep-independent output', () => {
    const operations = prepared(33);
    const first = chunkStudioBatchOperations({ projectId, changeSetHash, operations });
    const second = chunkStudioBatchOperations({ projectId, changeSetHash, operations });
    expect(second).toEqual(first);
    const retainedName = first[0]!.request.operations[0];
    if (operations[0]?.type !== 'create' || retainedName?.type !== 'create') {
      throw new Error('Expected create operations.');
    }
    operations[0].node.name = 'Caller Mutation';
    expect(retainedName.node.name).not.toBe('Caller Mutation');
  });

  it('keeps the 400-create Cliffwatch fixture at no more than 16 chunks', () => {
    const changeSet = JSON.parse(
      readFileSync(
        new URL(
          '../../architecture-planner/fixtures/change-sets/create-cliffwatch-blockout.change-set.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as RobloxChangeSet;
    expect(changeSet.operations).toHaveLength(400);
    const operations = buildStudioBatchOperations(changeSet.operations, []);
    const chunks = chunkStudioBatchOperations({
      projectId: changeSet.preconditions.projectId,
      changeSetHash: 'f'.repeat(64),
      operations,
    });
    expect(chunks).toHaveLength(13);
    expect(chunks.length).toBeLessThanOrEqual(16);
    expect(chunks.every((entry) => entry.request.operations.length <= 32)).toBe(true);
  });

  it('allows 512 operations and rejects 513 before producing chunks', () => {
    expect(chunk(512)).toHaveLength(16);
    expect(() => chunk(513)).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.operation_limit_exceeded' })],
      }),
    );
  });
});
