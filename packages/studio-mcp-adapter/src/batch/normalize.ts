import { canonicalizeJsonValue, stringifyCanonicalJson, type JsonValue } from '../json.js';
import type { StudioBatchOperation, StudioBatchRequest, StudioBatchResponse } from './types.js';

function canonicalClone<T>(value: Readonly<T>): T {
  return canonicalizeJsonValue(value as unknown as JsonValue) as unknown as T;
}

export function normalizeStudioBatchOperation(
  operation: Readonly<StudioBatchOperation>,
): StudioBatchOperation {
  return canonicalClone(operation);
}

export function normalizeStudioBatchRequest(
  request: Readonly<StudioBatchRequest>,
): StudioBatchRequest {
  return canonicalClone(request);
}

export function normalizeStudioBatchResponse(
  response: Readonly<StudioBatchResponse>,
): StudioBatchResponse {
  return canonicalClone(response);
}

export function stringifyStudioBatchRequest(request: Readonly<StudioBatchRequest>): string {
  return stringifyCanonicalJson(normalizeStudioBatchRequest(request) as unknown as JsonValue);
}

export function stringifyStudioBatchResponse(response: Readonly<StudioBatchResponse>): string {
  return stringifyCanonicalJson(normalizeStudioBatchResponse(response) as unknown as JsonValue);
}
