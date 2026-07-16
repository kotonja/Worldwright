import { Buffer } from 'node:buffer';

import {
  STUDIO_BRIDGE_RESPONSE_PREFIX,
  STUDIO_MCP_MAX_RESULT_BYTES,
  type StudioBridgeAction,
} from '../constants.js';
import { StudioAdapterError, studioDiagnostic } from '../diagnostics.js';
import { canonicalizeJsonValue, type JsonValue } from '../json.js';
import type { StudioBridgeResponse } from '../types.js';
import { validateStudioBridgeResponse } from '../validate.js';

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
  if (parent === undefined) return;
  parent.state = 'comma-or-end';
}

// JSON.parse accepts duplicate object names and silently keeps only the last
// value. Scan the already syntax-validated text iteratively so ambiguous
// bridge responses fail without imposing Node's scalar formatting on Luau.
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

export function parseStudioBridgeResponse(
  text: string,
  expectedAction: StudioBridgeAction,
  expectedNodeId?: string,
): StudioBridgeResponse {
  if (Buffer.byteLength(text, 'utf8') > STUDIO_MCP_MAX_RESULT_BYTES) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.response_too_large',
        '',
        `Studio bridge response exceeds ${STUDIO_MCP_MAX_RESULT_BYTES} bytes.`,
      ),
    ]);
  }
  const prefixIndex = text.indexOf(STUDIO_BRIDGE_RESPONSE_PREFIX);
  const secondPrefixIndex = text.indexOf(
    STUDIO_BRIDGE_RESPONSE_PREFIX,
    prefixIndex < 0 ? 0 : prefixIndex + STUDIO_BRIDGE_RESPONSE_PREFIX.length,
  );
  if (prefixIndex !== 0 || secondPrefixIndex !== -1) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.response_invalid',
        '',
        'Studio bridge response has invalid or ambiguous framing.',
      ),
    ]);
  }
  const encoded = text.slice(STUDIO_BRIDGE_RESPONSE_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded) as unknown;
  } catch {
    throw new StudioAdapterError([
      studioDiagnostic('studio.response_invalid', '', 'Studio bridge returned malformed JSON.'),
    ]);
  }
  const validation = validateStudioBridgeResponse(parsed);
  if (!validation.valid) throw new StudioAdapterError(validation.diagnostics);
  if (containsDuplicateObjectKeys(encoded)) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.response_invalid',
        '',
        'Studio bridge response contains duplicate object keys.',
      ),
    ]);
  }
  const response = canonicalizeJsonValue(
    validation.value as unknown as JsonValue,
  ) as unknown as StudioBridgeResponse;
  if (response.action !== expectedAction) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.response_invalid',
        '/action',
        'Studio bridge response action does not match the request.',
      ),
    ]);
  }
  const mutationAction =
    expectedAction === 'create' || expectedAction === 'update' || expectedAction === 'delete';
  if (
    mutationAction &&
    (expectedNodeId === undefined ||
      (response.ok
        ? !('nodeId' in response) || response.nodeId !== expectedNodeId
        : response.diagnostic.nodeId !== undefined &&
          response.diagnostic.nodeId !== expectedNodeId))
  ) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.response_invalid',
        '/nodeId',
        'Studio bridge mutation response does not match the requested node.',
      ),
    ]);
  }
  if (!response.ok) {
    const { diagnostic } = response;
    const supportedCode = diagnostic.code;
    const safeProperty =
      diagnostic.property !== undefined && /^[A-Za-z][A-Za-z0-9]{0,127}$/u.test(diagnostic.property)
        ? diagnostic.property
        : undefined;
    throw new StudioAdapterError([
      studioDiagnostic(
        supportedCode,
        safeProperty === undefined ? '' : `/engine/${safeProperty}`,
        `The fixed Studio bridge ${expectedAction} action failed (${supportedCode}).`,
        {
          ...(diagnostic.nodeId === undefined ? {} : { relatedId: diagnostic.nodeId }),
        },
      ),
    ]);
  }
  return response;
}
