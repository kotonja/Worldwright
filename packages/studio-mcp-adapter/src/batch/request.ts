import type { RobloxChangeOperation, RobloxManagedNode } from '@worldwright/roblox-compiler';

import { buildParentState } from '../bridge/parent-state.js';
import { STUDIO_BATCH_PROTOCOL_VERSION } from '../constants.js';
import { StudioAdapterError, studioDiagnostic } from '../diagnostics.js';
import { canonicalNodeMetadata } from '../engine-state.js';
import { jsonValuesEqual } from '../json.js';
import { hashStudioBatchChunkIdentity } from './hashing.js';
import type { StudioBatchOperation, StudioBatchRequest } from './types.js';
import { validateStudioBatchRequest } from './validate.js';

function transactionStateError(path: string, message: string, relatedId?: string): never {
  throw new StudioAdapterError([
    studioDiagnostic('studio.snapshot_invalid', path, message, {
      ...(relatedId === undefined ? {} : { relatedId }),
    }),
  ]);
}

function expectedParent(
  node: Readonly<RobloxManagedNode>,
  expectedNodes: ReadonlyMap<string, RobloxManagedNode>,
): RobloxManagedNode | undefined {
  if (node.parentId === undefined) return undefined;
  const parent = expectedNodes.get(node.parentId);
  if (parent === undefined) {
    transactionStateError(
      `/nodes/${node.id}/parentId`,
      'The transaction-observed managed parent is unavailable while constructing a batch.',
      node.parentId,
    );
  }
  return structuredClone(parent);
}

function requireTargetState(
  expectedNodes: ReadonlyMap<string, RobloxManagedNode>,
  before: Readonly<RobloxManagedNode>,
  operationPath: string,
): void {
  const expected = expectedNodes.get(before.id);
  if (expected === undefined || !jsonValuesEqual(expected, before)) {
    transactionStateError(
      operationPath,
      'The batch operation before state differs from transaction-observed expected state.',
      before.id,
    );
  }
}

function buildOperation(
  operation: Readonly<RobloxChangeOperation>,
  expectedNodes: Map<string, RobloxManagedNode>,
  operationIndex: number,
): StudioBatchOperation {
  const path = `/operations/${String(operationIndex)}`;
  switch (operation.type) {
    case 'create': {
      if (expectedNodes.has(operation.node.id)) {
        transactionStateError(
          path,
          'A Studio batch create target already exists in expected transaction state.',
          operation.node.id,
        );
      }
      const metadata = canonicalNodeMetadata(operation.node);
      const parentState = buildParentState(expectedParent(operation.node, expectedNodes));
      const output: StudioBatchOperation = {
        type: 'create',
        operationId: operation.id,
        node: structuredClone(operation.node),
        stateJson: metadata.json,
        stateHash: metadata.hash,
        ...(parentState === undefined ? {} : { parentState }),
      };
      expectedNodes.set(operation.node.id, structuredClone(operation.node));
      return output;
    }
    case 'update': {
      requireTargetState(expectedNodes, operation.before, path);
      const beforeMetadata = canonicalNodeMetadata(operation.before);
      const afterMetadata = canonicalNodeMetadata(operation.after);
      const beforeParentState = buildParentState(expectedParent(operation.before, expectedNodes));
      const afterParentState = buildParentState(expectedParent(operation.after, expectedNodes));
      const output: StudioBatchOperation = {
        type: 'update',
        operationId: operation.id,
        before: structuredClone(operation.before),
        after: structuredClone(operation.after),
        beforeStateJson: beforeMetadata.json,
        beforeStateHash: beforeMetadata.hash,
        afterStateJson: afterMetadata.json,
        afterStateHash: afterMetadata.hash,
        ...(beforeParentState === undefined ? {} : { beforeParentState }),
        ...(afterParentState === undefined ? {} : { afterParentState }),
      };
      expectedNodes.set(operation.after.id, structuredClone(operation.after));
      return output;
    }
    case 'delete': {
      requireTargetState(expectedNodes, operation.before, path);
      const metadata = canonicalNodeMetadata(operation.before);
      const output: StudioBatchOperation = {
        type: 'delete',
        operationId: operation.id,
        before: structuredClone(operation.before),
        beforeStateJson: metadata.json,
        beforeStateHash: metadata.hash,
      };
      expectedNodes.delete(operation.before.id);
      return output;
    }
  }
}

export function buildStudioBatchOperations(
  operations: readonly RobloxChangeOperation[],
  initialNodes: readonly RobloxManagedNode[],
): readonly StudioBatchOperation[] {
  const expectedNodes = new Map<string, RobloxManagedNode>();
  for (const node of initialNodes) {
    if (expectedNodes.has(node.id)) {
      transactionStateError(
        `/nodes/${node.id}`,
        'Transaction-observed state contains a duplicate managed node identity.',
        node.id,
      );
    }
    expectedNodes.set(node.id, structuredClone(node));
  }
  return operations.map((operation, index) => buildOperation(operation, expectedNodes, index));
}

export function buildStudioBatchRequest(
  input: Readonly<{
    projectId: string;
    changeSetHash: string;
    sandboxLeaseId: string;
    chunkIndex: number;
    operations: readonly StudioBatchOperation[];
  }>,
): StudioBatchRequest {
  const chunkId = hashStudioBatchChunkIdentity(input);
  const candidate: StudioBatchRequest = {
    protocolVersion: STUDIO_BATCH_PROTOCOL_VERSION,
    action: 'apply_chunk',
    projectId: input.projectId,
    changeSetHash: input.changeSetHash,
    sandboxLeaseId: input.sandboxLeaseId,
    chunkId,
    chunkIndex: input.chunkIndex,
    operations: input.operations.map((operation) => structuredClone(operation)),
  };
  const validation = validateStudioBatchRequest(candidate);
  if (!validation.valid) throw new StudioAdapterError(validation.diagnostics);
  return validation.value;
}
