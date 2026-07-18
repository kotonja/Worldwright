import { describe, expect, it } from 'vitest';

import {
  STUDIO_PLAYTEST_PROBE_REQUEST_SCHEMA_ID,
  STUDIO_PLAYTEST_PROBE_RESPONSE_PREFIX,
  STUDIO_PLAYTEST_PROBE_RESPONSE_SCHEMA_ID,
} from '../src/constants.js';
import {
  StudioPlaytestProbeRequestSchema,
  StudioPlaytestProbeResponseSchema,
} from '../src/playtest/contract-schema.js';
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

describe('Studio playtest probe contracts', () => {
  it('publishes separate frozen strict schemas with stable IDs', () => {
    expect(StudioPlaytestProbeRequestSchema).toMatchObject({
      $id: STUDIO_PLAYTEST_PROBE_REQUEST_SCHEMA_ID,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
    });
    expect(StudioPlaytestProbeResponseSchema).toMatchObject({
      $id: STUDIO_PLAYTEST_PROBE_RESPONSE_SCHEMA_ID,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
    });
    expect(Object.isFrozen(StudioPlaytestProbeRequestSchema)).toBe(true);
    expect(Object.isFrozen(StudioPlaytestProbeResponseSchema)).toBe(true);
  });

  it('rejects unknown fields, mismatched leases, duplicate floors, and same-checkpoint paths', () => {
    const request = buildStudioPlaytestIdentityProbeRequest(identity());
    expect(validateStudioPlaytestProbeRequest({ ...request, source: 'print(1)' }).valid).toBe(
      false,
    );
    expect(
      validateStudioPlaytestProbeRequest({
        ...request,
        identity: {
          ...request.identity,
          sandboxLease: { ...request.identity.sandboxLease, projectId: 'other-project' },
        },
      }).valid,
    ).toBe(false);
    expect(
      validateStudioPlaytestProbeRequest({
        protocolVersion: '0.1.0',
        action: 'player_state',
        identity: identity(),
        agent: AGENT,
        floors: [
          { floorId: 'floor-one', level: 0, finishedFloorElevation: 0 },
          { floorId: 'floor-two', level: 0, finishedFloorElevation: 10 },
        ],
      }).valid,
    ).toBe(false);
    expect(() =>
      buildStudioPlaytestPathProbeRequest(identity(), {
        fromCheckpointId: 'same-checkpoint',
        targetCheckpointId: 'same-checkpoint',
        fromWorldPosition: { x: 0, y: 3, z: 0 },
        targetWorldPosition: { x: 0, y: 3, z: 0 },
        agent: AGENT,
        maximumRetainedWaypoints: 128,
      }),
    ).toThrowError();
  });

  it('builds only the branded fixed Server probe source without mutation escape hatches', () => {
    const request = buildStudioPlaytestPathProbeRequest(identity(), {
      fromCheckpointId: 'checkpoint-one',
      targetCheckpointId: 'checkpoint-two',
      fromWorldPosition: { x: 0, y: 3, z: 0 },
      targetWorldPosition: { x: 10, y: 3, z: 20 },
      agent: AGENT,
      maximumRetainedWaypoints: 128,
    });
    const program = buildStudioPlaytestProbeProgram(request);
    expect(program.source).toContain('PathfindingService:CreatePath');
    expect(program.source).toContain('character:PivotTo');
    expect(program.source).not.toMatch(
      /Instance\.new|SetAttribute|ChangeHistoryService|loadstring/iu,
    );
    expect(program.source).not.toContain(request.identity.sandboxLease.leaseId.slice(0, 16) + '\n');
  });

  it('parses one exact framed response and rejects mismatches, duplicate keys, and private leaks', () => {
    const request = buildStudioPlaytestIdentityProbeRequest(identity());
    const response = {
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
    const framed = `${STUDIO_PLAYTEST_PROBE_RESPONSE_PREFIX}${JSON.stringify(response)}\n`;
    expect(parseStudioPlaytestProbeResponse(framed, request)).toEqual(response);
    expect(() => parseStudioPlaytestProbeResponse(`${framed}${framed}`, request)).toThrowError();
    expect(() =>
      parseStudioPlaytestProbeResponse(
        `${STUDIO_PLAYTEST_PROBE_RESPONSE_PREFIX}{"protocolVersion":"0.1.0","action":"identity_probe","ok":true,"ok":true}\n`,
        request,
      ),
    ).toThrowError();
    expect(
      validateStudioPlaytestProbeResponseForRequest(
        {
          protocolVersion: '0.1.0',
          action: 'identity_probe',
          ok: false,
          diagnostic: {
            code: 'studio.playtest_identity_mismatch',
            message: `private ${request.identity.sandboxLease.leaseId}`,
          },
        },
        request,
      ).valid,
    ).toBe(false);
  });
});
