import { Buffer } from 'node:buffer';

import {
  STUDIO_MCP_MAX_BRIDGE_TEXT_BYTES,
  STUDIO_MCP_MAX_RESULT_BYTES,
  STUDIO_PLAYTEST_PROBE_RESPONSE_PREFIX,
} from '../constants.js';
import { StudioAdapterError, studioDiagnostic } from '../diagnostics.js';
import type { StudioPlaytestProbeRequest, StudioPlaytestProbeResponse } from './types.js';
import { validateStudioPlaytestProbeResponseForRequest } from './validate.js';

type Frame =
  | { readonly kind: 'array'; state: 'value-or-end' | 'comma-or-end' }
  | {
      readonly kind: 'object';
      readonly keys: Set<string>;
      state: 'key-or-end' | 'colon' | 'value' | 'comma-or-end';
    };

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (/\s/u.test(text[index] ?? '')) index += 1;
  return index;
}

function stringEnd(text: string, start: number): number {
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

function duplicateObjectKeys(text: string): boolean {
  const stack: Frame[] = [];
  let index = 0;
  while (index < text.length) {
    index = skipWhitespace(text, index);
    const token = text[index];
    const current = stack.at(-1);
    if (token === undefined) break;
    if (token === '{') {
      stack.push({ kind: 'object', keys: new Set(), state: 'key-or-end' });
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
      const parent = stack.at(-1);
      if (parent !== undefined) parent.state = 'comma-or-end';
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
      const end = stringEnd(text, index);
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
    while (end < text.length && !/[\s,\]}]/u.test(text[end]!)) end += 1;
    if (current !== undefined) current.state = 'comma-or-end';
    index = end;
  }
  return false;
}

function invalid(message: string): never {
  throw new StudioAdapterError([studioDiagnostic('studio.response_invalid', '', message)]);
}

export function parseStudioPlaytestProbeResponse(
  text: string,
  expectedRequest: Readonly<StudioPlaytestProbeRequest>,
): StudioPlaytestProbeResponse {
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > STUDIO_MCP_MAX_RESULT_BYTES || byteLength > STUDIO_MCP_MAX_BRIDGE_TEXT_BYTES) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.response_too_large',
        '',
        'Studio playtest probe response exceeds the bounded bridge result size.',
      ),
    ]);
  }
  const prefixIndex = text.indexOf(STUDIO_PLAYTEST_PROBE_RESPONSE_PREFIX);
  if (
    prefixIndex !== 0 ||
    text.indexOf(
      STUDIO_PLAYTEST_PROBE_RESPONSE_PREFIX,
      STUDIO_PLAYTEST_PROBE_RESPONSE_PREFIX.length,
    ) !== -1 ||
    !text.endsWith('\n')
  ) {
    invalid('Studio playtest probe response has invalid or ambiguous framing.');
  }
  const encoded = text.slice(STUDIO_PLAYTEST_PROBE_RESPONSE_PREFIX.length, -1);
  if (encoded.length === 0 || encoded.trim() !== encoded) {
    invalid('Studio playtest probe response contains noncanonical framing output.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded) as unknown;
  } catch {
    invalid('Studio playtest probe returned malformed JSON.');
  }
  if (duplicateObjectKeys(encoded)) {
    invalid('Studio playtest probe response contains duplicate object keys.');
  }
  const validation = validateStudioPlaytestProbeResponseForRequest(parsed, expectedRequest);
  if (!validation.valid) throw new StudioAdapterError(validation.diagnostics);
  return validation.value;
}
