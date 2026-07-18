import { canonicalizeJsonValue, stringifyCanonicalJson, type JsonValue } from '../json.js';
import type { StudioPlaytestProbeRequest, StudioPlaytestProbeResponse } from './types.js';

function canonicalClone<T>(value: Readonly<T>): T {
  return canonicalizeJsonValue(value as unknown as JsonValue) as unknown as T;
}

export function normalizeStudioPlaytestProbeRequest(
  request: Readonly<StudioPlaytestProbeRequest>,
): StudioPlaytestProbeRequest {
  return canonicalClone(request);
}

export function normalizeStudioPlaytestProbeResponse(
  response: Readonly<StudioPlaytestProbeResponse>,
): StudioPlaytestProbeResponse {
  return canonicalClone(response);
}

export function stringifyStudioPlaytestProbeRequest(
  request: Readonly<StudioPlaytestProbeRequest>,
): string {
  return stringifyCanonicalJson(
    normalizeStudioPlaytestProbeRequest(request) as unknown as JsonValue,
  );
}

export function stringifyStudioPlaytestProbeResponse(
  response: Readonly<StudioPlaytestProbeResponse>,
): string {
  return stringifyCanonicalJson(
    normalizeStudioPlaytestProbeResponse(response) as unknown as JsonValue,
  );
}
