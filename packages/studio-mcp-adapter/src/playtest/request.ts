import { STUDIO_PLAYTEST_PROBE_PROTOCOL_VERSION } from '../constants.js';
import { StudioAdapterError } from '../diagnostics.js';
import type {
  StudioPlaytestAgent,
  StudioPlaytestCharacterSetupRequest,
  StudioPlaytestClearanceProbeRequest,
  StudioPlaytestFloor,
  StudioPlaytestIdentity,
  StudioPlaytestIdentityProbeRequest,
  StudioPlaytestPathProbeRequest,
  StudioPlaytestPlayerStateRequest,
  StudioPlaytestProbeRequest,
  StudioPlaytestVector,
} from './types.js';
import { validateStudioPlaytestProbeRequest } from './validate.js';

function checked<T extends StudioPlaytestProbeRequest>(candidate: T): T {
  const validation = validateStudioPlaytestProbeRequest(candidate);
  if (!validation.valid) throw new StudioAdapterError(validation.diagnostics);
  return validation.value as T;
}

function identityClone(identity: Readonly<StudioPlaytestIdentity>): StudioPlaytestIdentity {
  return structuredClone(identity);
}

export function buildStudioPlaytestIdentityProbeRequest(
  identity: Readonly<StudioPlaytestIdentity>,
): StudioPlaytestIdentityProbeRequest {
  return checked<StudioPlaytestIdentityProbeRequest>({
    protocolVersion: STUDIO_PLAYTEST_PROBE_PROTOCOL_VERSION,
    action: 'identity_probe',
    identity: identityClone(identity),
  });
}

export function buildStudioPlaytestCharacterSetupRequest(
  identity: Readonly<StudioPlaytestIdentity>,
  setupPosition: Readonly<StudioPlaytestVector>,
): StudioPlaytestCharacterSetupRequest {
  return checked<StudioPlaytestCharacterSetupRequest>({
    protocolVersion: STUDIO_PLAYTEST_PROBE_PROTOCOL_VERSION,
    action: 'character_setup',
    identity: identityClone(identity),
    setupPosition: structuredClone(setupPosition),
  });
}

export function buildStudioPlaytestPlayerStateRequest(
  identity: Readonly<StudioPlaytestIdentity>,
  floors: readonly Readonly<StudioPlaytestFloor>[],
  agent: Readonly<StudioPlaytestAgent>,
): StudioPlaytestPlayerStateRequest {
  return checked<StudioPlaytestPlayerStateRequest>({
    protocolVersion: STUDIO_PLAYTEST_PROBE_PROTOCOL_VERSION,
    action: 'player_state',
    identity: identityClone(identity),
    floors: floors.map((floor) => structuredClone(floor)),
    agent: structuredClone(agent),
  });
}

export function buildStudioPlaytestPathProbeRequest(
  identity: Readonly<StudioPlaytestIdentity>,
  input: Readonly<{
    fromCheckpointId: string;
    targetCheckpointId: string;
    fromWorldPosition: StudioPlaytestVector;
    targetWorldPosition: StudioPlaytestVector;
    agent: StudioPlaytestAgent;
    maximumRetainedWaypoints: number;
  }>,
): StudioPlaytestPathProbeRequest {
  return checked<StudioPlaytestPathProbeRequest>({
    protocolVersion: STUDIO_PLAYTEST_PROBE_PROTOCOL_VERSION,
    action: 'path_probe',
    identity: identityClone(identity),
    ...structuredClone(input),
  });
}

export function buildStudioPlaytestClearanceProbeRequest(
  identity: Readonly<StudioPlaytestIdentity>,
  input: Readonly<{
    checkpointId: string;
    expectedFinishedFloorElevation: number;
    agent: StudioPlaytestAgent;
  }>,
): StudioPlaytestClearanceProbeRequest {
  return checked<StudioPlaytestClearanceProbeRequest>({
    protocolVersion: STUDIO_PLAYTEST_PROBE_PROTOCOL_VERSION,
    action: 'clearance_probe',
    identity: identityClone(identity),
    ...structuredClone(input),
  });
}
