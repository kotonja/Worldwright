import { Buffer } from 'node:buffer';

import { STUDIO_MCP_MAX_PAYLOAD_BYTES } from '../constants.js';
import { StudioAdapterError, studioDiagnostic } from '../diagnostics.js';
import { stringifyCanonicalJson, type JsonValue } from '../json.js';
import type { StudioBridgeRequest } from '../types.js';
import { validateStudioBridgeRequest } from '../validate.js';
import { encodeLuauLongBracketLiteral } from './literal.js';

export function normalizeStudioBridgePayload(value: unknown): StudioBridgeRequest {
  const validation = validateStudioBridgeRequest(value);
  if (!validation.valid) throw new StudioAdapterError(validation.diagnostics);
  return validation.value;
}

export function encodeStudioBridgePayload(value: unknown): {
  readonly request: StudioBridgeRequest;
  readonly json: string;
  readonly literal: string;
} {
  const request = normalizeStudioBridgePayload(value);
  const json = stringifyCanonicalJson(request as JsonValue);
  const byteLength = Buffer.byteLength(json, 'utf8');
  if (byteLength > STUDIO_MCP_MAX_PAYLOAD_BYTES) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.payload_too_large',
        '',
        `Studio bridge payload exceeds ${STUDIO_MCP_MAX_PAYLOAD_BYTES} bytes.`,
      ),
    ]);
  }
  return { request, json, literal: encodeLuauLongBracketLiteral(json) };
}
