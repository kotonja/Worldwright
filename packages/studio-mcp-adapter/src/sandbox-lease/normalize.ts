import { canonicalizeJsonValue, stringifyCanonicalJson, type JsonValue } from '../json.js';
import type {
  StudioSandboxLeaseRecord,
  StudioSandboxLeaseRequest,
  StudioSandboxLeaseResponse,
} from './types.js';

function canonicalClone<T>(value: Readonly<T>): T {
  return canonicalizeJsonValue(value as unknown as JsonValue) as unknown as T;
}

export function normalizeSandboxLeaseRecord(
  record: Readonly<StudioSandboxLeaseRecord>,
): StudioSandboxLeaseRecord {
  return canonicalClone(record);
}

export function normalizeStudioSandboxLeaseRequest(
  request: Readonly<StudioSandboxLeaseRequest>,
): StudioSandboxLeaseRequest {
  return canonicalClone(request);
}

export function normalizeStudioSandboxLeaseResponse(
  response: Readonly<StudioSandboxLeaseResponse>,
): StudioSandboxLeaseResponse {
  return canonicalClone(response);
}

export function stringifySandboxLeaseRecord(record: Readonly<StudioSandboxLeaseRecord>): string {
  return stringifyCanonicalJson(normalizeSandboxLeaseRecord(record) as unknown as JsonValue);
}

export function stringifyStudioSandboxLeaseRequest(
  request: Readonly<StudioSandboxLeaseRequest>,
): string {
  return stringifyCanonicalJson(
    normalizeStudioSandboxLeaseRequest(request) as unknown as JsonValue,
  );
}

export function stringifyStudioSandboxLeaseResponse(
  response: Readonly<StudioSandboxLeaseResponse>,
): string {
  return stringifyCanonicalJson(
    normalizeStudioSandboxLeaseResponse(response) as unknown as JsonValue,
  );
}

export function sandboxLeaseRecordsEqual(
  left: Readonly<StudioSandboxLeaseRecord>,
  right: Readonly<StudioSandboxLeaseRecord>,
): boolean {
  return stringifySandboxLeaseRecord(left) === stringifySandboxLeaseRecord(right);
}
