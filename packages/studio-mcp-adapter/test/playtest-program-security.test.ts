import { describe, expect, it } from 'vitest';

import { STUDIO_PLAYTEST_PROBE_RESPONSE_PREFIX } from '../src/constants.js';
import { buildStudioPlaytestProbeProgram } from '../src/playtest/program.js';
import {
  buildStudioPlaytestIdentityProbeRequest,
  buildStudioPlaytestPathProbeRequest,
} from '../src/playtest/request.js';
import { parseStudioPlaytestProbeResponse } from '../src/playtest/response.js';
import type { StudioPlaytestAgent, StudioPlaytestIdentity } from '../src/playtest/types.js';
import {
  validateStudioPlaytestProbeRequest,
  validateStudioPlaytestProbeResponseForRequest,
} from '../src/playtest/validate.js';

const AGENT: StudioPlaytestAgent = {
  radius: 2,
  height: 5,
  canJump: false,
  canClimb: false,
  waypointSpacing: 4,
  arrivalHorizontalTolerance: 4,
  arrivalVerticalTolerance: 5,
  maximumHorizontalSpeed: 32,
  maximumFallBelowFloor: 12,
  rootHeightAboveFinishedFloor: 3,
};

function identity(): StudioPlaytestIdentity {
  return {
    projectId: 'project-test',
    rootNodeId: 'root-test',
    manifestSourceWorldSpecSha256: '1'.repeat(64),
    expectedManagedNodeCount: 4,
    sandboxLease: {
      schemaVersion: '0.1.0',
      leaseId: '2'.repeat(64),
      projectId: 'project-test',
      changeSetHash: '3'.repeat(64),
    },
    playtestPlanSha256: '4'.repeat(64),
  };
}

function identityRequest(): ReturnType<typeof buildStudioPlaytestIdentityProbeRequest> {
  return buildStudioPlaytestIdentityProbeRequest(identity());
}

function frame(value: Readonly<Record<string, unknown>>): string {
  return `${STUDIO_PLAYTEST_PROBE_RESPONSE_PREFIX}${JSON.stringify(value)}\n`;
}

function expectInvalidRequest(value: unknown): void {
  expect(validateStudioPlaytestProbeRequest(value)).toMatchObject({
    valid: false,
    diagnostics: [expect.objectContaining({ code: 'studio.playtest_probe_invalid' })],
  });
  expect(() => buildStudioPlaytestProbeProgram(value)).toThrowError(
    expect.objectContaining({
      diagnostics: [expect.objectContaining({ code: 'studio.playtest_probe_invalid' })],
    }),
  );
}

describe('fixed Studio playtest probe security', () => {
  it.each([
    [
      'project identity',
      (request: Record<string, unknown>) => {
        const requestIdentity = request.identity as Record<string, unknown>;
        requestIdentity.projectId = 'Project-Test';
      },
    ],
    [
      'root identity',
      (request: Record<string, unknown>) => {
        const requestIdentity = request.identity as Record<string, unknown>;
        requestIdentity.rootNodeId = 'root/test';
      },
    ],
    [
      'Manifest source hash',
      (request: Record<string, unknown>) => {
        const requestIdentity = request.identity as Record<string, unknown>;
        requestIdentity.manifestSourceWorldSpecSha256 = '1'.repeat(63);
      },
    ],
    [
      'managed count lower bound',
      (request: Record<string, unknown>) => {
        const requestIdentity = request.identity as Record<string, unknown>;
        requestIdentity.expectedManagedNodeCount = 0;
      },
    ],
    [
      'managed count integer bound',
      (request: Record<string, unknown>) => {
        const requestIdentity = request.identity as Record<string, unknown>;
        requestIdentity.expectedManagedNodeCount = 1.5;
      },
    ],
    [
      'lease identity',
      (request: Record<string, unknown>) => {
        const requestIdentity = request.identity as Record<string, unknown>;
        const lease = requestIdentity.sandboxLease as Record<string, unknown>;
        lease.leaseId = 'g'.repeat(64);
      },
    ],
    [
      'lease Change Set hash',
      (request: Record<string, unknown>) => {
        const requestIdentity = request.identity as Record<string, unknown>;
        const lease = requestIdentity.sandboxLease as Record<string, unknown>;
        lease.changeSetHash = '3'.repeat(65);
      },
    ],
    [
      'lease project binding',
      (request: Record<string, unknown>) => {
        const requestIdentity = request.identity as Record<string, unknown>;
        const lease = requestIdentity.sandboxLease as Record<string, unknown>;
        lease.projectId = 'other-project';
      },
    ],
    [
      'Playtest Plan hash',
      (request: Record<string, unknown>) => {
        const requestIdentity = request.identity as Record<string, unknown>;
        requestIdentity.playtestPlanSha256 = 'A'.repeat(64);
      },
    ],
  ] as const)('rejects malformed %s before fixed-program construction', (_name, mutate) => {
    const request = structuredClone(identityRequest()) as unknown as Record<string, unknown>;
    mutate(request);
    expectInvalidRequest(request);
  });

  it('rejects unknown fields at every privileged request boundary', () => {
    const request = identityRequest();
    expectInvalidRequest({ ...request, source: 'return game' });
    expectInvalidRequest({
      ...request,
      identity: { ...request.identity, studioId: 'private-studio' },
    });
    expectInvalidRequest({
      ...request,
      identity: {
        ...request.identity,
        sandboxLease: { ...request.identity.sandboxLease, previousLease: 'private' },
      },
    });

    const pathRequest = buildStudioPlaytestPathProbeRequest(identity(), {
      fromCheckpointId: 'checkpoint-one',
      targetCheckpointId: 'checkpoint-two',
      fromWorldPosition: { x: 0, y: 3, z: 0 },
      targetWorldPosition: { x: 10, y: 3, z: 20 },
      agent: AGENT,
      maximumRetainedWaypoints: 128,
    });
    expectInvalidRequest({ ...pathRequest, agent: { ...pathRequest.agent, walkSpeed: 100 } });
  });

  it('rejects executable-looking strings, accessors, functions, and cyclic payloads safely', () => {
    expectInvalidRequest({
      ...identityRequest(),
      identity: {
        ...identityRequest().identity,
        projectId: 'project-test"]); game:HttpGet("https://example.invalid")--',
      },
    });

    const accessor = structuredClone(identityRequest()) as unknown as Record<string, unknown>;
    let accessorReads = 0;
    Object.defineProperty(accessor, 'source', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 'return game';
      },
    });
    expectInvalidRequest(accessor);
    expect(accessorReads).toBe(0);

    expectInvalidRequest({ ...identityRequest(), callback: () => 'return game' });
    const cyclic = structuredClone(identityRequest()) as unknown as Record<string, unknown>;
    cyclic.self = cyclic;
    expectInvalidRequest(cyclic);
  });

  it('embeds only canonical validated data in one fixed long-bracket payload', () => {
    const request = buildStudioPlaytestPathProbeRequest(identity(), {
      fromCheckpointId: 'checkpoint-one',
      targetCheckpointId: 'checkpoint-two',
      fromWorldPosition: { x: 0, y: 3, z: 0 },
      targetWorldPosition: { x: 10, y: 3, z: 20 },
      agent: AGENT,
      maximumRetainedWaypoints: 128,
    });
    const source = buildStudioPlaytestProbeProgram(request).source;
    const payloadMatches = [...source.matchAll(/local payloadJson = \[(=*)\[([\s\S]*?)\]\1\]/gu)];
    expect(payloadMatches).toHaveLength(1);
    expect(JSON.parse(payloadMatches[0]![2]!)).toEqual(request);
    expect(source).not.toContain('__WORLDWRIGHT_PLAYTEST_VALIDATED_PAYLOAD__');
  });

  it('binds every probe to unsaved running Server identity and exact managed root state', () => {
    const source = buildStudioPlaytestProbeProgram(identityRequest()).source;
    expect(source).toContain('game.PlaceId ~= 0 or game.GameId ~= 0');
    expect(source).toContain(
      'not RunService:IsStudio() or not RunService:IsRunning() or not RunService:IsServer()',
    );
    expect(source).toContain('rawLease ~= canonicalLease(identity.sandboxLease)');
    expect(source).toContain('instance:GetAttribute("WorldwrightProjectId") == identity.projectId');
    expect(source).toContain('selectedCount ~= identity.expectedManagedNodeCount');
    expect(source).toContain('root:GetAttribute("WorldwrightEntityId") ~= identity.rootNodeId');
    expect(source).toContain(
      'root:GetAttribute("WorldwrightSourceHash") ~= identity.manifestSourceWorldSpecSha256',
    );
    expect(source).toContain('(not root:IsA("Folder") and not root:IsA("Model"))');
  });

  it('contains no architecture mutation, arbitrary execution, asset, or network escape hatch', () => {
    const source = buildStudioPlaytestProbeProgram(identityRequest()).source;
    expect(source).toContain('character:PivotTo');
    expect(source).toContain('root.AssemblyLinearVelocity = Vector3.zero');
    expect(source).toContain('root.AssemblyAngularVelocity = Vector3.zero');
    expect(source).not.toMatch(
      /Instance\.new|SetAttribute|Destroy\s*\(|Clone\s*\(|ChangeHistoryService|CollectionService|InsertService/iu,
    );
    expect(source).not.toMatch(
      /loadstring|getfenv|setfenv|string\.dump|debug\.|require\s*\(|HttpGet|HttpPost|GetObjects/iu,
    );
    expect(source).not.toMatch(/\.Parent\s*=(?!=)|\.Anchored\s*=(?!=)|humanoid\.Health\s*=(?!=)/iu);
    expect(source).not.toMatch(/\.Source\s*=(?!=)|ScriptContext|ServerScriptService/iu);
    expect(source).toContain('if unmanagedBlockerCount > MAX_MANAGED_BLOCKERS then');
    expect(source).not.toContain('if unmanagedBlockerCount > MAX_MANAGED_NODES then');
  });

  it('ignores noncollidable overlays while retaining collidable support and head blockers', () => {
    const source = buildStudioPlaytestProbeProgram(identityRequest()).source;
    expect(source.match(/RespectCanCollide = true/gu)).toHaveLength(2);
    expect(source).toContain('result == nil or not result.Instance.CanCollide');
    expect(source).toContain('headHit == nil or not headHit.Instance.CanCollide');
  });

  it.each([
    ['published sandbox', 'studio.published_place_forbidden'],
    ['non-running or wrong data-model sandbox', 'studio.playtest_identity_mismatch'],
  ] as const)('accepts one sanitized framed failure for a %s', (_name, code) => {
    const request = identityRequest();
    const response = {
      protocolVersion: '0.1.0',
      action: 'identity_probe',
      ok: false,
      diagnostic: {
        code,
        message: 'The running Studio simulation does not match the expected sandbox.',
      },
    } as const;
    expect(parseStudioPlaytestProbeResponse(frame(response), request)).toEqual(response);
  });

  it('rejects identity success with a wrong project flag, root flag, count, lane, or run state', () => {
    const request = identityRequest();
    const success = {
      protocolVersion: '0.1.0',
      action: 'identity_probe',
      ok: true,
      projectIdentityMatched: true,
      rootIdentityMatched: true,
      managedNodeCount: 4,
      playerCount: 1,
      characterReady: true,
      dataModelType: 'Server',
      playRunning: true,
    } as const;
    for (const mismatch of [
      { projectIdentityMatched: false },
      { rootIdentityMatched: false },
      { managedNodeCount: 3 },
      { dataModelType: 'Edit' },
      { playRunning: false },
    ]) {
      expect(
        validateStudioPlaytestProbeResponseForRequest({ ...success, ...mismatch }, request),
      ).toMatchObject({ valid: false });
    }
  });

  it.each([
    ['sandbox lease ID', identity().sandboxLease.leaseId],
    ['Change Set hash', identity().sandboxLease.changeSetHash],
    ['Playtest Plan hash', identity().playtestPlanSha256],
  ])('rejects a failure diagnostic that leaks the private %s', (_name, privateValue) => {
    const request = identityRequest();
    expect(
      validateStudioPlaytestProbeResponseForRequest(
        {
          protocolVersion: '0.1.0',
          action: 'identity_probe',
          ok: false,
          diagnostic: {
            code: 'studio.playtest_identity_mismatch',
            message: `private=${privateValue}`,
          },
        },
        request,
      ),
    ).toMatchObject({
      valid: false,
      diagnostics: [expect.objectContaining({ code: 'studio.response_invalid' })],
    });
  });

  it('rejects response-side unknown identity and lease fields', () => {
    const request = identityRequest();
    expect(
      validateStudioPlaytestProbeResponseForRequest(
        {
          protocolVersion: '0.1.0',
          action: 'identity_probe',
          ok: false,
          diagnostic: {
            code: 'studio.playtest_identity_mismatch',
            message: 'Identity mismatch.',
          },
          studioId: 'private-studio',
          sandboxLeaseId: request.identity.sandboxLease.leaseId,
        },
        request,
      ),
    ).toMatchObject({ valid: false });
  });
});
