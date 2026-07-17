import { describe, expect, it } from 'vitest';

import { compactSnapshotFixture } from '../scripts/compact-snapshot-fixture.js';
import { renderStudioFixtures } from '../scripts/generate-fixtures.js';
import {
  STUDIO_MCP_MAX_SANDBOX_LEASE_BYTES,
  STUDIO_SANDBOX_LEASE_RECORD_SCHEMA_ID,
  STUDIO_SANDBOX_LEASE_REQUEST_SCHEMA_ID,
  STUDIO_SANDBOX_LEASE_RESPONSE_PREFIX,
  STUDIO_SANDBOX_LEASE_RESPONSE_SCHEMA_ID,
} from '../src/constants.js';
import {
  StudioSandboxLeaseRecordSchema,
  StudioSandboxLeaseRequestSchema,
  StudioSandboxLeaseResponseSchema,
} from '../src/sandbox-lease/contract-schema.js';
import {
  sandboxLeaseRecordsEqual,
  stringifySandboxLeaseRecord,
  stringifyStudioSandboxLeaseResponse,
} from '../src/sandbox-lease/normalize.js';
import {
  createSandboxLeaseRecord,
  generateSandboxLeaseId,
  parseSandboxLeaseAttribute,
} from '../src/sandbox-lease/record.js';
import {
  buildBoundSnapshotSandboxLeaseRequest,
  buildClaimSandboxLeaseRequest,
  buildReadSandboxLeaseRequest,
} from '../src/sandbox-lease/request.js';
import { parseStudioSandboxLeaseResponse } from '../src/sandbox-lease/response.js';
import type { StudioSandboxLeaseResponse } from '../src/sandbox-lease/types.js';
import {
  validateSandboxLeaseRecord,
  validateStudioSandboxLeaseRequest,
  validateStudioSandboxLeaseResponseForRequest,
} from '../src/sandbox-lease/validate.js';

const projectId = 'project-sandbox-lease';
const changeSetHash = 'a'.repeat(64);
const leaseId = 'b'.repeat(64);

function record() {
  return createSandboxLeaseRecord(projectId, changeSetHash, () => leaseId);
}

function frame(response: Readonly<StudioSandboxLeaseResponse>): string {
  return `${STUDIO_SANDBOX_LEASE_RESPONSE_PREFIX}${stringifyStudioSandboxLeaseResponse(response)}`;
}

describe('Studio sandbox lease contract', () => {
  it('publishes separate frozen schemas and creates a strict deterministic record', () => {
    expect(StudioSandboxLeaseRecordSchema.$id).toBe(STUDIO_SANDBOX_LEASE_RECORD_SCHEMA_ID);
    expect(StudioSandboxLeaseRequestSchema.$id).toBe(STUDIO_SANDBOX_LEASE_REQUEST_SCHEMA_ID);
    expect(StudioSandboxLeaseResponseSchema.$id).toBe(STUDIO_SANDBOX_LEASE_RESPONSE_SCHEMA_ID);
    expect(Object.isFrozen(StudioSandboxLeaseRecordSchema)).toBe(true);
    expect(Object.isFrozen(StudioSandboxLeaseRequestSchema)).toBe(true);
    expect(Object.isFrozen(StudioSandboxLeaseResponseSchema)).toBe(true);

    const value = record();
    expect(value).toEqual({
      changeSetHash,
      leaseId,
      projectId,
      schemaVersion: '0.1.0',
    });
    expect(validateSandboxLeaseRecord(value)).toMatchObject({ valid: true });
    expect(stringifySandboxLeaseRecord(value)).toBe(
      `{
  "changeSetHash": "${changeSetHash}",
  "leaseId": "${leaseId}",
  "projectId": "${projectId}",
  "schemaVersion": "0.1.0"
}
`,
    );
    expect(sandboxLeaseRecordsEqual(value, structuredClone(value))).toBe(true);
  });

  it('uses 32 cryptographically random Node bytes in production and permits a test factory', () => {
    expect(generateSandboxLeaseId()).toMatch(/^[0-9a-f]{64}$/u);
    expect(createSandboxLeaseRecord(projectId, changeSetHash, () => 'c'.repeat(64)).leaseId).toBe(
      'c'.repeat(64),
    );
    expect(() =>
      createSandboxLeaseRecord(projectId, changeSetHash, () => 'invalid'),
    ).toThrowError();
  });

  it.each([
    ['invalid version', { ...record(), schemaVersion: '0.2.0' }],
    ['invalid lease ID', { ...record(), leaseId: 'B'.repeat(64) }],
    ['invalid project ID', { ...record(), projectId: 'Invalid Project' }],
    ['invalid Change Set hash', { ...record(), changeSetHash: 'a'.repeat(63) }],
    ['unknown field', { ...record(), privateExtra: true }],
  ])('rejects %s', (_label, value) => {
    expect(validateSandboxLeaseRecord(value)).toMatchObject({
      valid: false,
      diagnostics: [expect.objectContaining({ code: 'studio.sandbox_lease_invalid' })],
    });
  });

  it('fails closed on malformed, noncanonical, oversized, or non-string Workspace values', () => {
    const canonical = stringifySandboxLeaseRecord(record());
    expect(parseSandboxLeaseAttribute(undefined)).toBeUndefined();
    expect(parseSandboxLeaseAttribute(canonical)).toEqual(record());
    for (const invalid of [
      JSON.stringify(record()),
      '{',
      '',
      'x'.repeat(STUDIO_MCP_MAX_SANDBOX_LEASE_BYTES + 1),
      null,
      7,
      record(),
    ]) {
      expect(() => parseSandboxLeaseAttribute(invalid)).toThrowError(
        expect.objectContaining({
          diagnostics: [expect.objectContaining({ code: 'studio.sandbox_lease_invalid' })],
        }),
      );
    }
  });

  it('rejects non-JSON in-memory values without invoking accessors', () => {
    let invoked = false;
    const value = { ...record() };
    Object.defineProperty(value, 'leaseId', {
      enumerable: true,
      get(): string {
        invoked = true;
        return leaseId;
      },
    });
    expect(validateSandboxLeaseRecord(value)).toMatchObject({ valid: false });
    expect(validateSandboxLeaseRecord({ ...record(), extra: 1n })).toMatchObject({ valid: false });
    expect(invoked).toBe(false);
  });

  it('builds explicit absent and exact prior-state compare-and-set claims', () => {
    const next = record();
    const absent = buildClaimSandboxLeaseRequest(undefined, next);
    expect(absent).toEqual({
      protocolVersion: '0.1.0',
      action: 'claim_lease',
      expectedLeasePresent: false,
      newLease: next,
    });
    const prior = createSandboxLeaseRecord('prior-project', 'c'.repeat(64), () => 'd'.repeat(64));
    const rotated = buildClaimSandboxLeaseRequest(prior, next);
    expect(rotated.expectedLeasePresent).toBe(true);
    expect(rotated.expectedLease).toEqual(prior);
    expect(
      validateStudioSandboxLeaseRequest({ ...rotated, expectedLeasePresent: false }),
    ).toMatchObject({ valid: false });
    expect(() => buildClaimSandboxLeaseRequest(next, next)).toThrowError();
  });

  it('parses read, claim, and one-call bound-snapshot responses against exact requests', () => {
    const readRequest = buildReadSandboxLeaseRequest();
    const readResponse: StudioSandboxLeaseResponse = {
      protocolVersion: '0.1.0',
      action: 'read_lease',
      ok: true,
      leasePresent: true,
      lease: record(),
    };
    expect(parseStudioSandboxLeaseResponse(frame(readResponse), readRequest)).toEqual(readResponse);

    const claimRequest = buildClaimSandboxLeaseRequest(undefined, record());
    const claimResponse: StudioSandboxLeaseResponse = {
      protocolVersion: '0.1.0',
      action: 'claim_lease',
      ok: true,
    };
    expect(parseStudioSandboxLeaseResponse(frame(claimResponse), claimRequest)).toEqual(
      claimResponse,
    );

    const boundRequest = buildBoundSnapshotSandboxLeaseRequest(record());
    const boundResponse: StudioSandboxLeaseResponse = {
      protocolVersion: '0.1.0',
      action: 'bound_snapshot',
      ok: true,
      compactSnapshot: compactSnapshotFixture(projectId, [], []),
    };
    expect(parseStudioSandboxLeaseResponse(frame(boundResponse), boundRequest)).toEqual(
      boundResponse,
    );
  });

  it('rejects mismatched actions, duplicate framing, and diagnostics that expose a lease ID', () => {
    const request = buildBoundSnapshotSandboxLeaseRequest(record());
    const leaked: StudioSandboxLeaseResponse = {
      protocolVersion: '0.1.0',
      action: 'bound_snapshot',
      ok: false,
      diagnostic: {
        code: 'studio.sandbox_identity_mismatch',
        message: `Lease ${leaseId} does not match.`,
      },
    };
    expect(validateStudioSandboxLeaseResponseForRequest(leaked, request)).toMatchObject({
      valid: false,
      diagnostics: [expect.objectContaining({ path: '/diagnostic/message' })],
    });
    const duplicate = frame(leaked).replace(
      '"action": "bound_snapshot",',
      '"action": "bound_snapshot",\n  "action": "bound_snapshot",',
    );
    expect(() => parseStudioSandboxLeaseResponse(duplicate, request)).toThrowError();
    expect(() =>
      parseStudioSandboxLeaseResponse(
        frame({
          protocolVersion: '0.1.0',
          action: 'read_lease',
          ok: true,
          leasePresent: false,
        }),
        request,
      ),
    ).toThrowError();
  });

  it('keeps generated committed fixtures free of private lease identifiers and metadata', () => {
    for (const artifact of renderStudioFixtures()) {
      expect(artifact.content, artifact.label).not.toMatch(
        /"(?:leaseId|sandboxLeaseId)"\s*:\s*"[0-9a-f]{64}"/u,
      );
      expect(artifact.content, artifact.label).not.toContain('WorldwrightStudioSandboxLeaseJson');
    }
  });
});
