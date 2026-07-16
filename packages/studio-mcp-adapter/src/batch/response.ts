import { Buffer } from 'node:buffer';

import {
  STUDIO_BATCH_RESPONSE_PREFIX,
  STUDIO_MCP_MAX_BRIDGE_TEXT_BYTES,
  STUDIO_MCP_MAX_RESULT_BYTES,
} from '../constants.js';
import { StudioAdapterError, studioDiagnostic } from '../diagnostics.js';
import type { StudioBatchRequest, StudioBatchResponse } from './types.js';
import { validateStudioBatchResponseForRequest } from './validate.js';

type JsonContainerFrame =
  | { readonly kind: 'array'; state: 'value-or-end' | 'comma-or-end' }
  | {
      readonly kind: 'object';
      readonly keys: Set<string>;
      state: 'key-or-end' | 'colon' | 'value' | 'comma-or-end';
    };

function skipJsonWhitespace(text: string, start: number): number {
  let index = start;
  while (
    index < text.length &&
    (text[index] === ' ' || text[index] === '\t' || text[index] === '\r' || text[index] === '\n')
  ) {
    index += 1;
  }
  return index;
}

function stringTokenEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    if (text[index] === '"') return index + 1;
    index += 1;
  }
  return text.length;
}

function completeContainerValue(stack: JsonContainerFrame[]): void {
  const parent = stack.at(-1);
  if (parent !== undefined) parent.state = 'comma-or-end';
}

function containsDuplicateObjectKeys(text: string): boolean {
  const stack: JsonContainerFrame[] = [];
  let index = 0;
  while (index < text.length) {
    index = skipJsonWhitespace(text, index);
    if (index >= text.length) break;
    const token = text[index]!;
    const current = stack.at(-1);
    if (token === '{') {
      stack.push({ kind: 'object', keys: new Set<string>(), state: 'key-or-end' });
      index += 1;
      continue;
    }
    if (token === '[') {
      stack.push({ kind: 'array', state: 'value-or-end' });
      index += 1;
      continue;
    }
    if (token === '}' || token === ']') {
      stack.pop();
      completeContainerValue(stack);
      index += 1;
      continue;
    }
    if (token === ',') {
      if (current?.kind === 'object') current.state = 'key-or-end';
      if (current?.kind === 'array') current.state = 'value-or-end';
      index += 1;
      continue;
    }
    if (token === ':') {
      if (current?.kind === 'object') current.state = 'value';
      index += 1;
      continue;
    }
    if (token === '"') {
      const end = stringTokenEnd(text, index);
      if (current?.kind === 'object' && current.state === 'key-or-end') {
        const key = JSON.parse(text.slice(index, end)) as string;
        if (current.keys.has(key)) return true;
        current.keys.add(key);
        current.state = 'colon';
      } else if (current !== undefined) {
        current.state = 'comma-or-end';
      }
      index = end;
      continue;
    }
    let end = index + 1;
    while (
      end < text.length &&
      text[end] !== ',' &&
      text[end] !== ']' &&
      text[end] !== '}' &&
      text[end] !== ' ' &&
      text[end] !== '\t' &&
      text[end] !== '\r' &&
      text[end] !== '\n'
    ) {
      end += 1;
    }
    if (current !== undefined) current.state = 'comma-or-end';
    index = end;
  }
  return false;
}

function responseInvalid(message: string, path = ''): never {
  throw new StudioAdapterError([studioDiagnostic('studio.response_invalid', path, message)]);
}

export function parseStudioBatchResponse(
  text: string,
  expectedRequest: Readonly<StudioBatchRequest>,
): StudioBatchResponse {
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > STUDIO_MCP_MAX_RESULT_BYTES || byteLength > STUDIO_MCP_MAX_BRIDGE_TEXT_BYTES) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.response_too_large',
        '',
        'Studio batch response exceeds the bounded bridge result size.',
      ),
    ]);
  }
  const prefixIndex = text.indexOf(STUDIO_BATCH_RESPONSE_PREFIX);
  const secondPrefixIndex = text.indexOf(
    STUDIO_BATCH_RESPONSE_PREFIX,
    prefixIndex < 0 ? 0 : prefixIndex + STUDIO_BATCH_RESPONSE_PREFIX.length,
  );
  if (prefixIndex !== 0 || secondPrefixIndex !== -1 || !text.endsWith('\n')) {
    responseInvalid('Studio batch response has invalid or ambiguous framing.');
  }
  const encoded = text.slice(STUDIO_BATCH_RESPONSE_PREFIX.length, -1);
  if (encoded.length === 0 || encoded.trim() !== encoded) {
    responseInvalid('Studio batch response contains trailing or noncanonical framing output.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded) as unknown;
  } catch {
    if (/(?:\.\.\.|…)[ \t]*\(truncated\)[ \t\r\n]*$/iu.test(encoded)) {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.response_too_large',
          '',
          'Studio batch response was truncated by the MCP transport.',
        ),
      ]);
    }
    responseInvalid('Studio batch bridge returned malformed JSON.');
  }
  if (containsDuplicateObjectKeys(encoded)) {
    responseInvalid('Studio batch response contains duplicate object keys.');
  }
  const validation = validateStudioBatchResponseForRequest(parsed, expectedRequest);
  if (!validation.valid) throw new StudioAdapterError(validation.diagnostics);
  return validation.value;
}
