import { Buffer } from 'node:buffer';

import {
  STUDIO_BATCH_PROTOCOL_VERSION,
  STUDIO_MCP_MAX_BATCH_OPERATIONS,
  STUDIO_MCP_MAX_BATCH_PAYLOAD_BYTES,
  STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS,
  STUDIO_MCP_MAX_PAYLOAD_BYTES,
} from '../constants.js';
import { StudioAdapterError, studioDiagnostic } from '../diagnostics.js';
import { measureFixedStudioBatchOuterPayloadBytes } from '../bridge/program.js';
import { stringifyStudioBatchRequest } from './normalize.js';
import { buildStudioBatchRequest } from './request.js';
import type {
  StudioBatchChunkLimits,
  StudioBatchOperation,
  StudioBatchRequest,
  StudioOperationChunk,
} from './types.js';

const DEFAULT_LIMITS: StudioBatchChunkLimits = Object.freeze({
  maxOperations: STUDIO_MCP_MAX_BATCH_OPERATIONS,
  maxPayloadBytes: STUDIO_MCP_MAX_BATCH_PAYLOAD_BYTES,
});

function assertLimits(limits: Readonly<StudioBatchChunkLimits>): void {
  if (
    !Number.isSafeInteger(limits.maxOperations) ||
    limits.maxOperations < 1 ||
    limits.maxOperations > STUDIO_MCP_MAX_BATCH_OPERATIONS ||
    !Number.isSafeInteger(limits.maxPayloadBytes) ||
    limits.maxPayloadBytes < 1 ||
    limits.maxPayloadBytes > STUDIO_MCP_MAX_BATCH_PAYLOAD_BYTES ||
    limits.maxPayloadBytes > STUDIO_MCP_MAX_PAYLOAD_BYTES
  ) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.usage_invalid',
        '/limits',
        'Studio batch chunk limits are invalid or exceed the fixed production bounds.',
      ),
    ]);
  }
}

function buildChunk(
  projectId: string,
  changeSetHash: string,
  chunkIndex: number,
  operations: readonly StudioBatchOperation[],
): StudioOperationChunk {
  const request = buildStudioBatchRequest({
    projectId,
    changeSetHash,
    chunkIndex,
    operations,
  });
  const canonicalRequestBytes = Buffer.byteLength(stringifyStudioBatchRequest(request), 'utf8');
  return Object.freeze({
    chunkId: request.chunkId,
    chunkIndex,
    operationIds: Object.freeze(request.operations.map((operation) => operation.operationId)),
    canonicalRequestBytes,
    request,
  });
}

function requestByteLengths(
  projectId: string,
  changeSetHash: string,
  chunkIndex: number,
  operations: readonly StudioBatchOperation[],
): { readonly canonical: number; readonly outer: number } {
  // A chunk ID is always one lowercase SHA-256, so a zero hash has the exact
  // final encoded width without repeatedly validating every growing prefix.
  const sizingRequest: StudioBatchRequest = {
    protocolVersion: STUDIO_BATCH_PROTOCOL_VERSION,
    action: 'apply_chunk',
    projectId,
    changeSetHash,
    chunkId: '0'.repeat(64),
    chunkIndex,
    operations: [...operations],
  };
  const canonical = stringifyStudioBatchRequest(sizingRequest);
  return {
    canonical: Buffer.byteLength(canonical, 'utf8'),
    outer: measureFixedStudioBatchOuterPayloadBytes(canonical),
  };
}

function singleOperationTooLarge(operationId: string): never {
  throw new StudioAdapterError([
    studioDiagnostic(
      'studio.payload_too_large',
      '/operations',
      'One Studio batch operation cannot fit inside a valid bounded chunk.',
      { relatedId: operationId },
    ),
  ]);
}

export function chunkStudioBatchOperations(
  input: Readonly<{
    projectId: string;
    changeSetHash: string;
    operations: readonly StudioBatchOperation[];
  }>,
  limits: Readonly<StudioBatchChunkLimits> = DEFAULT_LIMITS,
): readonly StudioOperationChunk[] {
  assertLimits(limits);
  if (input.operations.length === 0) return Object.freeze([]);
  if (input.operations.length > STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.operation_limit_exceeded',
        '/operations',
        `Studio transactions are limited to ${STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS} operations.`,
      ),
    ]);
  }

  const chunks: StudioOperationChunk[] = [];
  let pending: StudioBatchOperation[] = [];
  for (const sourceOperation of input.operations) {
    const operation = structuredClone(sourceOperation);
    const candidateOperations = [...pending, operation];
    const candidateBytes =
      candidateOperations.length <= limits.maxOperations
        ? requestByteLengths(
            input.projectId,
            input.changeSetHash,
            chunks.length,
            candidateOperations,
          )
        : undefined;
    const fits =
      candidateBytes !== undefined &&
      candidateBytes.canonical <= limits.maxPayloadBytes &&
      candidateBytes.canonical <= STUDIO_MCP_MAX_PAYLOAD_BYTES &&
      candidateBytes.outer <= STUDIO_MCP_MAX_PAYLOAD_BYTES;
    if (fits) {
      pending = candidateOperations;
      continue;
    }

    if (pending.length === 0) singleOperationTooLarge(operation.operationId);
    const completed = buildChunk(input.projectId, input.changeSetHash, chunks.length, pending);
    chunks.push(completed);
    pending = [operation];
    const single = buildChunk(input.projectId, input.changeSetHash, chunks.length, pending);
    if (
      single.canonicalRequestBytes > limits.maxPayloadBytes ||
      single.canonicalRequestBytes > STUDIO_MCP_MAX_PAYLOAD_BYTES ||
      measureFixedStudioBatchOuterPayloadBytes(stringifyStudioBatchRequest(single.request)) >
        STUDIO_MCP_MAX_PAYLOAD_BYTES
    ) {
      singleOperationTooLarge(operation.operationId);
    }
  }

  if (pending.length > 0) {
    chunks.push(buildChunk(input.projectId, input.changeSetHash, chunks.length, pending));
  }
  return Object.freeze(chunks);
}

/** Name retained from the milestone design for callers operating on prepared batch operations. */
export const chunkRobloxChangeSetOperations = chunkStudioBatchOperations;
