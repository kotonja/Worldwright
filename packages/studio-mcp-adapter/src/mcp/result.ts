import { Buffer } from 'node:buffer';

import { STUDIO_MCP_MAX_CAPTURE_BYTES, STUDIO_MCP_MAX_RESULT_BYTES } from '../constants.js';
import { hasValidPngStructure } from '../capture.js';
import { StudioAdapterError, studioDiagnostic } from '../diagnostics.js';

const MAX_CONTENT_ITEMS = 8;
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set(['image/png']);

export interface StudioMcpTextResult {
  readonly text: string;
}

export interface StudioMcpImageResult {
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

function resultError(
  code: 'studio.response_invalid' | 'studio.response_too_large' | 'studio.tool_call_failed',
  tool: string,
  message: string,
): StudioAdapterError {
  return new StudioAdapterError([studioDiagnostic(code, '/content', message, { toolName: tool })]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function readExactDataRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) return undefined;
  const names = Object.getOwnPropertyNames(value);
  if (names.some((name) => !allowedKeys.has(name))) return undefined;
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      return undefined;
    }
  }
  return value;
}

function readSingleArrayItem(value: unknown): unknown {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== 1 ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.getOwnPropertyNames(value).some((name) => name !== '0' && name !== 'length')
  ) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, '0');
  return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor
    ? descriptor.value
    : undefined;
}

function readSingleContent(value: unknown, tool: string): Readonly<Record<string, unknown>> {
  const result = readExactDataRecord(value, new Set(['content', 'isError']));
  if (result === undefined) {
    throw resultError(
      'studio.response_invalid',
      tool,
      `Studio tool ${tool} returned invalid content.`,
    );
  }
  if (result.isError !== undefined && typeof result.isError !== 'boolean') {
    throw resultError(
      'studio.response_invalid',
      tool,
      `Studio tool ${tool} returned invalid content.`,
    );
  }
  if (!Array.isArray(result.content) || result.content.length !== 1) {
    const tooMany = Array.isArray(result.content) && result.content.length > MAX_CONTENT_ITEMS;
    throw resultError(
      tooMany ? 'studio.response_too_large' : 'studio.response_invalid',
      tool,
      tooMany
        ? `Studio tool ${tool} returned too many content items.`
        : `Studio tool ${tool} must return exactly one unambiguous content item.`,
    );
  }
  const contentValue = readSingleArrayItem(result.content);
  const content = readExactDataRecord(contentValue, new Set(['type', 'text', 'data', 'mimeType']));
  if (content === undefined) {
    throw resultError(
      'studio.response_invalid',
      tool,
      `Studio tool ${tool} returned invalid content.`,
    );
  }
  let contentStringBytes = 0;
  for (const entry of Object.values(content)) {
    if (typeof entry === 'string') contentStringBytes += Buffer.byteLength(entry, 'utf8');
  }
  if (contentStringBytes > STUDIO_MCP_MAX_RESULT_BYTES) {
    throw resultError(
      'studio.response_too_large',
      tool,
      `Studio tool ${tool} returned oversized content.`,
    );
  }
  if (result.isError === true) {
    throw resultError('studio.tool_call_failed', tool, `Studio tool ${tool} reported a failure.`);
  }
  return content;
}

export function readStudioMcpTextResult(value: unknown, tool: string): StudioMcpTextResult {
  const content = readSingleContent(value, tool);
  if (
    content.type !== 'text' ||
    typeof content.text !== 'string' ||
    Object.keys(content).some((key) => key !== 'type' && key !== 'text')
  ) {
    throw resultError('studio.response_invalid', tool, `Studio tool ${tool} did not return text.`);
  }
  if (Buffer.byteLength(content.text, 'utf8') > STUDIO_MCP_MAX_RESULT_BYTES) {
    throw resultError(
      'studio.response_too_large',
      tool,
      `Studio tool ${tool} returned oversized text.`,
    );
  }
  return Object.freeze({ text: content.text });
}

function decodeCanonicalBase64(value: string, tool: string): Uint8Array {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw resultError(
      'studio.response_invalid',
      tool,
      `Studio tool ${tool} returned invalid image data.`,
    );
  }
  if (Buffer.byteLength(value, 'ascii') > STUDIO_MCP_MAX_RESULT_BYTES) {
    throw resultError(
      'studio.response_too_large',
      tool,
      `Studio tool ${tool} returned an oversized image.`,
    );
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw resultError(
      'studio.response_invalid',
      tool,
      `Studio tool ${tool} returned invalid image data.`,
    );
  }
  if (bytes.byteLength > STUDIO_MCP_MAX_CAPTURE_BYTES) {
    throw resultError(
      'studio.response_too_large',
      tool,
      `Studio tool ${tool} returned an oversized image.`,
    );
  }
  return Uint8Array.from(bytes);
}

export function readStudioMcpImageResult(value: unknown, tool: string): StudioMcpImageResult {
  const content = readSingleContent(value, tool);
  if (
    content.type !== 'image' ||
    typeof content.data !== 'string' ||
    typeof content.mimeType !== 'string' ||
    !SUPPORTED_IMAGE_MEDIA_TYPES.has(content.mimeType) ||
    Object.keys(content).some((key) => key !== 'type' && key !== 'data' && key !== 'mimeType')
  ) {
    throw resultError(
      'studio.response_invalid',
      tool,
      `Studio tool ${tool} did not return a supported image.`,
    );
  }
  const bytes = decodeCanonicalBase64(content.data, tool);
  if (!hasValidPngStructure(bytes)) {
    throw resultError(
      'studio.response_invalid',
      tool,
      `Studio tool ${tool} did not return a structurally valid PNG image.`,
    );
  }
  return Object.freeze({ mediaType: content.mimeType, bytes });
}
