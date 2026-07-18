import { describe, expect, it } from 'vitest';

import {
  buildStudioPlaytestCharacterSetupRequest,
  buildStudioPlaytestClearanceProbeRequest,
  buildStudioPlaytestIdentityProbeRequest,
  buildStudioPlaytestPathProbeRequest,
  buildStudioPlaytestPlayerStateRequest,
} from '../src/playtest/request.js';
import type { StudioPlaytestAgent, StudioPlaytestIdentity } from '../src/playtest/types.js';
import { validateStudioPlaytestProbeResponseForRequest } from '../src/playtest/validate.js';

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

function validForRequest(
  request: Parameters<typeof validateStudioPlaytestProbeResponseForRequest>[1],
  response: unknown,
): boolean {
  return validateStudioPlaytestProbeResponseForRequest(response, request).valid;
}

describe('untrusted Studio playtest response semantics', () => {
  it('requires all fixed identity assertions, exact managed count, running Server, and matching action', () => {
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
    expect(validForRequest(request, response)).toBe(true);
    for (const drift of [
      { projectIdentityMatched: false },
      { rootIdentityMatched: false },
      { managedNodeCount: 3 },
      { dataModelType: 'Edit' },
      { playRunning: false },
    ]) {
      expect(validForRequest(request, { ...response, ...drift })).toBe(false);
    }
  });

  it('requires setup to verify the exact requested position and zero linear/angular velocity', () => {
    const request = buildStudioPlaytestCharacterSetupRequest(identity(), { x: 1, y: 2, z: 3 });
    const response = {
      protocolVersion: '0.1.0',
      action: 'character_setup',
      ok: true,
      position: { x: 1, y: 2, z: 3 },
      linearVelocityMagnitude: 0,
      angularVelocityMagnitude: 0,
    } as const;
    expect(validForRequest(request, response)).toBe(true);
    expect(validForRequest(request, { ...response, position: { x: 2, y: 2, z: 3 } })).toBe(false);
    expect(validForRequest(request, { ...response, linearVelocityMagnitude: 0.01 })).toBe(false);
    expect(validForRequest(request, { ...response, angularVelocityMagnitude: 0.01 })).toBe(false);
  });

  it('accepts bounded dead state but rejects contradictory health, life, root, support, and floor pairs', () => {
    const request = buildStudioPlaytestPlayerStateRequest(
      identity(),
      [{ floorId: 'floor-zero', level: 0, finishedFloorElevation: 0 }],
      AGENT,
    );
    const response = {
      protocolVersion: '0.1.0',
      action: 'player_state',
      ok: true,
      position: { x: 0, y: 3, z: 0 },
      linearVelocityMagnitude: 0,
      health: 0,
      maximumHealth: 100,
      humanoidState: 'Dead',
      floorMaterial: 'Concrete',
      hasHumanoidRootPart: true,
      alive: false,
      supported: true,
      supportDistance: 3,
      managedSupportEntityId: 'floor-part',
      currentLevel: 0,
      currentFloorId: 'floor-zero',
    } as const;
    expect(validForRequest(request, response)).toBe(true);
    for (const drift of [
      { health: 101 },
      { alive: true },
      { hasHumanoidRootPart: false, alive: true },
      { supported: false },
      { currentLevel: 1 },
      { currentFloorId: 'floor-other' },
    ]) {
      expect(validForRequest(request, { ...response, ...drift })).toBe(false);
    }
  });

  it('recomputes path distance from the exact requested source and retained waypoints', () => {
    const request = buildStudioPlaytestPathProbeRequest(identity(), {
      fromCheckpointId: 'checkpoint-one',
      targetCheckpointId: 'checkpoint-two',
      fromWorldPosition: { x: 0, y: 3, z: 0 },
      targetWorldPosition: { x: 6, y: 3, z: 8 },
      agent: AGENT,
      maximumRetainedWaypoints: 128,
    });
    const response = {
      protocolVersion: '0.1.0',
      action: 'path_probe',
      ok: true,
      status: 'success',
      waypointCount: 1,
      waypoints: [{ x: 6, y: 3, z: 8 }],
      totalPathDistance: 10,
      requiresJump: false,
      jumpWaypointCount: 0,
      fromCheckpointId: 'checkpoint-one',
      targetCheckpointId: 'checkpoint-two',
    } as const;
    expect(validForRequest(request, response)).toBe(true);
    expect(validForRequest(request, { ...response, totalPathDistance: 9 })).toBe(false);
    expect(validForRequest(request, { ...response, fromCheckpointId: 'checkpoint-other' })).toBe(
      false,
    );
  });

  it('accepts exact jump-required evidence and rejects jump success or contradictory failures', () => {
    const request = buildStudioPlaytestPathProbeRequest(identity(), {
      fromCheckpointId: 'checkpoint-one',
      targetCheckpointId: 'checkpoint-two',
      fromWorldPosition: { x: 0, y: 3, z: 0 },
      targetWorldPosition: { x: 3, y: 3, z: 4 },
      agent: AGENT,
      maximumRetainedWaypoints: 128,
    });
    const jump = {
      protocolVersion: '0.1.0',
      action: 'path_probe',
      ok: true,
      status: 'jump_required',
      waypointCount: 1,
      waypoints: [{ x: 3, y: 3, z: 4 }],
      totalPathDistance: 5,
      requiresJump: true,
      jumpWaypointCount: 1,
      fromCheckpointId: 'checkpoint-one',
      targetCheckpointId: 'checkpoint-two',
    } as const;
    expect(validForRequest(request, jump)).toBe(true);
    expect(validForRequest(request, { ...jump, status: 'success' })).toBe(false);
    expect(validForRequest(request, { ...jump, jumpWaypointCount: 0 })).toBe(false);
    expect(validForRequest(request, { ...jump, status: 'no_path' })).toBe(false);
    expect(
      validForRequest(request, {
        ...jump,
        status: 'no_path',
        waypointCount: 0,
        waypoints: [],
        totalPathDistance: 0,
        requiresJump: false,
        jumpWaypointCount: 0,
      }),
    ).toBe(true);
  });

  it('binds clearance checkpoint/support and exact blocker-derived body clearance', () => {
    const request = buildStudioPlaytestClearanceProbeRequest(identity(), {
      checkpointId: 'checkpoint-two',
      expectedFinishedFloorElevation: 0,
      agent: AGENT,
    });
    const response = {
      protocolVersion: '0.1.0',
      action: 'clearance_probe',
      ok: true,
      checkpointId: 'checkpoint-two',
      supported: true,
      supportDistance: 3,
      managedSupportEntityId: 'floor-part',
      bodyClear: true,
      headClear: true,
      unmanagedBlockerCount: 0,
      managedBlockerIds: [],
    } as const;
    expect(validForRequest(request, response)).toBe(true);
    expect(validForRequest(request, { ...response, checkpointId: 'checkpoint-other' })).toBe(false);
    expect(validForRequest(request, { ...response, supported: false })).toBe(false);
    expect(
      validForRequest(request, {
        ...response,
        managedBlockerIds: ['wall-part'],
        bodyClear: true,
      }),
    ).toBe(false);
    expect(
      validForRequest(request, {
        ...response,
        managedBlockerIds: ['wall-part'],
        bodyClear: false,
      }),
    ).toBe(true);
    expect(validForRequest(request, { ...response, unmanagedBlockerCount: 1 })).toBe(false);
    expect(
      validForRequest(request, {
        ...response,
        bodyClear: false,
        unmanagedBlockerCount: 64,
      }),
    ).toBe(true);
    expect(
      validForRequest(request, {
        ...response,
        bodyClear: false,
        unmanagedBlockerCount: 65,
      }),
    ).toBe(false);
  });
});
