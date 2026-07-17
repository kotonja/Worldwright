import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { STUDIO_BRIDGE_ACTIONS, STUDIO_MCP_MAX_PAYLOAD_BYTES } from '../src/constants.js';
import { buildSandboxLeaseProgram } from '../src/sandbox-lease/program.js';
import { createSandboxLeaseRecord } from '../src/sandbox-lease/record.js';
import {
  buildBoundSnapshotSandboxLeaseRequest,
  buildClaimSandboxLeaseRequest,
  buildReadSandboxLeaseRequest,
} from '../src/sandbox-lease/request.js';

const lease = createSandboxLeaseRecord('project-sandbox-program', 'a'.repeat(64), () =>
  'b'.repeat(64),
);

describe('fixed Studio sandbox lease program', () => {
  it('keeps lease actions outside the frozen Bridge 0.1 union and uses separate framing', () => {
    expect(STUDIO_BRIDGE_ACTIONS).toEqual(['probe', 'snapshot', 'create', 'update', 'delete']);
    const source = buildSandboxLeaseProgram(buildReadSandboxLeaseRequest()).source;
    expect(source).toContain('local RESPONSE_PREFIX = "WORLDWRIGHT_STUDIO_SANDBOX_LEASE_V1\\n"');
    expect(source).toContain('value.action == "read_lease"');
    expect(source).toContain('value.action == "claim_lease"');
    expect(source).toContain('value.action == "bound_snapshot"');
    for (const forbidden of [
      'clear_lease',
      'force_claim',
      'adopt_lease',
      'set_attribute',
      'get_attribute',
      'loadstring',
      'ChangeHistoryService',
      'HttpService:GetAsync',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('touches only the exact adapter-owned Workspace attribute through audited calls', () => {
    const next = createSandboxLeaseRecord(lease.projectId, lease.changeSetHash, () =>
      'c'.repeat(64),
    );
    const source = buildSandboxLeaseProgram(buildClaimSandboxLeaseRequest(lease, next)).source;
    expect(source).toContain(
      'local SANDBOX_LEASE_ATTRIBUTE_NAME = "WorldwrightStudioSandboxLeaseJson"',
    );
    expect(source).toContain('Workspace:GetAttribute(SANDBOX_LEASE_ATTRIBUTE_NAME)');
    expect(source).toContain('Workspace:SetAttribute(SANDBOX_LEASE_ATTRIBUTE_NAME, newJson)');
    expect(source.match(/Workspace:SetAttribute\(/gu)).toHaveLength(1);
    expect(source).not.toContain('Workspace:GetAttributes(');
    expect(source).not.toContain('SetAttribute(SANDBOX_LEASE_ATTRIBUTE_NAME, nil)');
    expect(source).toContain('current.raw == canonicalSandboxLeaseJson(payload.expectedLease)');
    expect(source).toContain('verified.raw ~= newJson');
    expect(source).toContain('local gateFailure = sandboxGate()');
    expect(source).toContain('if game.PlaceId ~= 0 or game.GameId ~= 0 then');
    expect(source).toContain('if RunService:IsRunning() then');
  });

  it('validates canonical existing metadata and binds identity plus snapshot in one fixed call', () => {
    const source = buildSandboxLeaseProgram(buildBoundSnapshotSandboxLeaseRequest(lease)).source;
    expect(source).toContain('local function readSandboxLeaseState()');
    expect(source).toContain('canonicalSandboxLeaseJson(record) ~= raw');
    expect(source).toContain('current.raw ~= canonicalSandboxLeaseJson(payload.lease)');
    expect(source).toContain('"studio.sandbox_identity_mismatch"');
    expect(source).toContain('payload.projectId = payload.lease.projectId');
    expect(source).toContain('return snapshotAction()');
    expect(source).toContain('compactSnapshot = {');
    expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(STUDIO_MCP_MAX_PAYLOAD_BYTES);
  });

  it('keeps request data inert in a deterministic long-bracket literal', () => {
    const request = buildBoundSnapshotSandboxLeaseRequest(lease);
    const first = buildSandboxLeaseProgram(request);
    const second = buildSandboxLeaseProgram(structuredClone(request));
    expect(second.source).toBe(first.source);
    expect(first.source).not.toContain('__WORLDWRIGHT_VALIDATED_PAYLOAD__');
    expect(first.source).toMatch(/local payloadJson = \[=*\[/u);
  });
});
