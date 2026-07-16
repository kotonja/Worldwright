import { describe, expect, it } from 'vitest';

import { parseStudioBridgeResponse } from '../src/bridge/response.js';
import {
  STUDIO_BRIDGE_RESPONSE_PREFIX,
  STUDIO_MCP_MAX_BRIDGE_TEXT_BYTES,
  STUDIO_MCP_MAX_RESULT_BYTES,
} from '../src/constants.js';
import { stringifyCanonicalJson, type JsonValue } from '../src/json.js';

function framed(value: JsonValue): string {
  return `${STUDIO_BRIDGE_RESPONSE_PREFIX}${stringifyCanonicalJson(value)}`;
}

describe('Studio bridge response framing', () => {
  const probe = {
    protocolVersion: '0.1.0',
    action: 'probe',
    ok: true,
    probe: {
      placeName: 'Sandbox',
      placeId: 0,
      gameId: 0,
      isRunning: false,
      isEditAvailable: true,
    },
  } as const;

  it('accepts one exact prefix with compact or trailing-whitespace JSON and normalizes the value', () => {
    expect(parseStudioBridgeResponse(framed(probe), 'probe')).toEqual(probe);
    expect(
      parseStudioBridgeResponse(
        `${STUDIO_BRIDGE_RESPONSE_PREFIX}${JSON.stringify(probe)}  \r\n\n`,
        'probe',
      ),
    ).toEqual(probe);
    expect(
      parseStudioBridgeResponse(
        `${STUDIO_BRIDGE_RESPONSE_PREFIX}{"protocolVersion":"0.1.0","action":"probe","ok":true,"probe":{"placeName":"\\u0053andbox","placeId":-0,"gameId":0e0,"isRunning":false,"isEditAvailable":true}}`,
        'probe',
      ),
    ).toEqual(probe);
  });

  it.each([
    ['missing prefix', stringifyCanonicalJson(probe)],
    ['leading text', `noise${framed(probe)}`],
    ['multiple prefixes', `${framed(probe)}${framed(probe)}`],
    ['malformed JSON', `${STUDIO_BRIDGE_RESPONSE_PREFIX}{`],
    ['trailing text', `${framed(probe)}not-json`],
    [
      'duplicate JSON key',
      `${STUDIO_BRIDGE_RESPONSE_PREFIX}{"action":"probe","action":"probe","ok":true,"probe":{"gameId":0,"isEditAvailable":true,"isRunning":false,"placeId":0,"placeName":"Sandbox"},"protocolVersion":"0.1.0"}\n`,
    ],
    [
      'escape-equivalent duplicate JSON key',
      `${STUDIO_BRIDGE_RESPONSE_PREFIX}{"action":"probe","act\\u0069on":"probe","ok":true,"probe":{"gameId":0,"isEditAvailable":true,"isRunning":false,"placeId":0,"placeName":"Sandbox"},"protocolVersion":"0.1.0"}\n`,
    ],
  ])('rejects %s', (_label, text) => {
    expect(() => parseStudioBridgeResponse(text, 'probe')).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.response_invalid' })],
      }),
    );
  });

  it('rejects unknown fields, versions, and action mismatches', () => {
    for (const value of [
      { ...probe, extra: true },
      { ...probe, protocolVersion: '9.9.9' },
    ]) {
      expect(() =>
        parseStudioBridgeResponse(framed(value as unknown as JsonValue), 'probe'),
      ).toThrow();
    }
    expect(() => parseStudioBridgeResponse(framed(probe), 'snapshot')).toThrow();
  });

  it('rejects bounded oversized output before parsing it', () => {
    const text = `${STUDIO_BRIDGE_RESPONSE_PREFIX}${'x'.repeat(STUDIO_MCP_MAX_RESULT_BYTES + 1)}`;
    expect(() => parseStudioBridgeResponse(text, 'probe')).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.response_too_large' })],
      }),
    );
  });

  it('maps the compact bridge cap and MCP truncation suffix to response_too_large', () => {
    const oversized = `${STUDIO_BRIDGE_RESPONSE_PREFIX}${'x'.repeat(STUDIO_MCP_MAX_BRIDGE_TEXT_BYTES)}`;
    for (const text of [
      oversized,
      `${STUDIO_BRIDGE_RESPONSE_PREFIX}{"protocolVersion":"0.1.0"... (truncated)`,
    ]) {
      expect(() => parseStudioBridgeResponse(text, 'snapshot')).toThrowError(
        expect.objectContaining({
          diagnostics: [expect.objectContaining({ code: 'studio.response_too_large' })],
        }),
      );
    }
  });

  it('requires mutation success to echo the exact requested node ID', () => {
    const response = {
      protocolVersion: '0.1.0',
      action: 'create',
      ok: true,
      nodeId: 'node-a',
    } as const;
    expect(parseStudioBridgeResponse(framed(response), 'create', 'node-a')).toEqual(response);
    expect(() => parseStudioBridgeResponse(framed(response), 'create', 'node-b')).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.response_invalid' })],
      }),
    );
  });

  it('rejects a mismatched mutation failure node ID before exposing its diagnostic', () => {
    const response = {
      protocolVersion: '0.1.0',
      action: 'delete',
      ok: false,
      diagnostic: {
        code: 'studio.delete_failed',
        message: 'Untrusted bridge detail.',
        nodeId: 'node-b',
      },
    } as const;

    expect(() => parseStudioBridgeResponse(framed(response), 'delete', 'node-a')).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.response_invalid' })],
      }),
    );
  });

  it('maps bridge failure text to a package-owned sanitized message', () => {
    const response = {
      protocolVersion: '0.1.0',
      action: 'update',
      ok: false,
      diagnostic: {
        code: 'studio.update_failed',
        message: 'C:\\Users\\private\\stack.lua:42 secret bridge detail',
        nodeId: 'node-a',
        property: 'Material',
      },
    } as const;
    expect(() => parseStudioBridgeResponse(framed(response), 'update', 'node-a')).toThrowError(
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            code: 'studio.update_failed',
            path: '/engine/Material',
            relatedId: 'node-a',
            message: 'The fixed Studio bridge update action failed (studio.update_failed).',
          }),
        ],
      }),
    );
  });

  it('preserves the stable oversized adapter-metadata code across sanitization', () => {
    const response = {
      protocolVersion: '0.1.0',
      action: 'snapshot',
      ok: false,
      diagnostic: {
        code: 'studio.adapter_metadata_too_large',
        message: 'Untrusted bridge detail.',
        nodeId: 'node-a',
      },
    } as const;

    expect(() => parseStudioBridgeResponse(framed(response), 'snapshot')).toThrowError(
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            code: 'studio.adapter_metadata_too_large',
            relatedId: 'node-a',
            message:
              'The fixed Studio bridge snapshot action failed (studio.adapter_metadata_too_large).',
          }),
        ],
      }),
    );
  });
});
