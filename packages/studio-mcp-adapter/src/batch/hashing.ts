import { createHash } from 'node:crypto';

import { hashCanonicalJson, type JsonValue } from '../json.js';
import { stringifyStudioBatchRequest, stringifyStudioBatchResponse } from './normalize.js';
import type { StudioBatchOperation, StudioBatchRequest, StudioBatchResponse } from './types.js';

function sha256Utf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashStudioBatchChunkIdentity(
  input: Readonly<{
    projectId: string;
    changeSetHash: string;
    chunkIndex: number;
    operations: readonly StudioBatchOperation[];
  }>,
): string {
  return hashCanonicalJson({
    projectId: input.projectId,
    changeSetHash: input.changeSetHash,
    chunkIndex: input.chunkIndex,
    operationIds: input.operations.map((operation) => operation.operationId),
    operations: input.operations,
  } as unknown as JsonValue);
}

export function hashStudioBatchRequest(request: Readonly<StudioBatchRequest>): string {
  return sha256Utf8(stringifyStudioBatchRequest(request));
}

export function hashStudioBatchResponse(response: Readonly<StudioBatchResponse>): string {
  return sha256Utf8(stringifyStudioBatchResponse(response));
}
