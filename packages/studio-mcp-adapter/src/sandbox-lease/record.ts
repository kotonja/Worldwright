import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';

import {
  STUDIO_MCP_MAX_SANDBOX_LEASE_BYTES,
  STUDIO_SANDBOX_LEASE_RECORD_VERSION,
} from '../constants.js';
import { StudioAdapterError, studioDiagnostic } from '../diagnostics.js';
import { stringifySandboxLeaseRecord } from './normalize.js';
import type { SandboxLeaseIdFactory, StudioSandboxLeaseRecord } from './types.js';
import { validateSandboxLeaseRecord } from './validate.js';

export function generateSandboxLeaseId(): string {
  return randomBytes(32).toString('hex');
}

export function createSandboxLeaseRecord(
  projectId: string,
  changeSetHash: string,
  leaseIdFactory: SandboxLeaseIdFactory = generateSandboxLeaseId,
): StudioSandboxLeaseRecord {
  let leaseId: unknown;
  try {
    leaseId = leaseIdFactory();
  } catch {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.sandbox_lease_invalid',
        '/leaseId',
        'Studio sandbox lease ID generation failed.',
      ),
    ]);
  }
  const validation = validateSandboxLeaseRecord({
    schemaVersion: STUDIO_SANDBOX_LEASE_RECORD_VERSION,
    leaseId,
    projectId,
    changeSetHash,
  });
  if (!validation.valid) throw new StudioAdapterError(validation.diagnostics);
  return validation.value;
}

function invalidAttribute(message: string): never {
  throw new StudioAdapterError([
    studioDiagnostic('studio.sandbox_lease_invalid', '/workspaceLease', message),
  ]);
}

/** Decode the exact adapter-owned Workspace attribute; undefined is the only absent state. */
export function parseSandboxLeaseAttribute(value: unknown): StudioSandboxLeaseRecord | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    invalidAttribute('Existing Studio sandbox lease attribute is not a string.');
  }
  if (value.length === 0) {
    invalidAttribute('Existing Studio sandbox lease attribute is empty.');
  }
  if (Buffer.byteLength(value, 'utf8') > STUDIO_MCP_MAX_SANDBOX_LEASE_BYTES) {
    invalidAttribute('Existing Studio sandbox lease attribute exceeds the bounded size.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    invalidAttribute('Existing Studio sandbox lease attribute contains malformed JSON.');
  }
  const validation = validateSandboxLeaseRecord(parsed);
  if (!validation.valid) throw new StudioAdapterError(validation.diagnostics);
  if (stringifySandboxLeaseRecord(validation.value) !== value) {
    invalidAttribute('Existing Studio sandbox lease attribute is not canonical JSON.');
  }
  return validation.value;
}
