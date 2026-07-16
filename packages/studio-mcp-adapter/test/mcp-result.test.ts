import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { STUDIO_MCP_MAX_RESULT_BYTES } from '../src/constants.js';
import { readStudioMcpImageResult, readStudioMcpTextResult } from '../src/mcp/result.js';

describe('MCP tool result safety', () => {
  it('reads one bounded text result', () => {
    expect(
      readStudioMcpTextResult({ content: [{ type: 'text', text: '{"ok":true}' }] }, 'probe'),
    ).toEqual({ text: '{"ok":true}' });
  });

  it('reads one canonical bounded image result', () => {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const result = readStudioMcpImageResult(
      {
        content: [{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }],
      },
      'screen_capture',
    );
    expect(result.mediaType).toBe('image/png');
    expect([...result.bytes]).toEqual([...bytes]);
  });

  it('rejects mixed, malformed, error, and oversized content with stable diagnostics', () => {
    let accessorInvoked = false;
    const accessorResult = {};
    Object.defineProperty(accessorResult, 'content', {
      enumerable: true,
      get(): unknown {
        accessorInvoked = true;
        return [{ type: 'text', text: 'unsafe' }];
      },
    });
    const cases: readonly [unknown, string][] = [
      [
        {
          content: [
            { type: 'text', text: 'metadata' },
            { type: 'image', mimeType: 'image/png', data: 'iVBORw==' },
          ],
        },
        'studio.response_invalid',
      ],
      [
        { content: [{ type: 'text', text: 'private details' }], isError: true },
        'studio.tool_call_failed',
      ],
      [
        {
          content: [{ type: 'text', text: 'x'.repeat(STUDIO_MCP_MAX_RESULT_BYTES + 1) }],
          isError: true,
        },
        'studio.response_too_large',
      ],
      [
        { content: [{ type: 'image', mimeType: 'image/png', data: 'not base64' }] },
        'studio.response_invalid',
      ],
      [
        {
          content: [
            {
              type: 'image',
              mimeType: 'image/png',
              data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
            },
          ],
        },
        'studio.response_invalid',
      ],
      [
        { content: [{ type: 'text', text: 'x'.repeat(STUDIO_MCP_MAX_RESULT_BYTES + 1) }] },
        'studio.response_too_large',
      ],
      [
        {
          content: [{ type: 'text', text: 'ok' }],
          _meta: { private: 'x'.repeat(1024) },
        },
        'studio.response_invalid',
      ],
      [accessorResult, 'studio.response_invalid'],
    ];

    for (const [value, code] of cases) {
      const read =
        value !== accessorResult && isImageContent(value)
          ? () => readStudioMcpImageResult(value, 'screen_capture')
          : () => readStudioMcpTextResult(value, 'probe');
      expect(read).toThrowError(
        expect.objectContaining({ diagnostics: [expect.objectContaining({ code })] }),
      );
    }
    expect(accessorInvoked).toBe(false);
  });
});

function isImageContent(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('content' in value)) return false;
  const content = (value as Readonly<{ content?: unknown }>).content;
  return (
    Array.isArray(content) &&
    content.some(
      (entry) =>
        typeof entry === 'object' && entry !== null && 'type' in entry && entry.type === 'image',
    )
  );
}
