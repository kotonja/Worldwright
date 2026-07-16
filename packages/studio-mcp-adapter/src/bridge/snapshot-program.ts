import { STUDIO_BRIDGE_PROTOCOL_VERSION } from '../constants.js';
import type { FixedStudioBridgeProgram } from '../mcp/client.js';
import type { StudioBridgeRequest } from '../types.js';
import { buildStudioBridgeProgram } from './program.js';

export function buildProbeProgram(): FixedStudioBridgeProgram {
  const request: StudioBridgeRequest = {
    protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
    action: 'probe',
  };
  return buildStudioBridgeProgram(request);
}

export function buildSnapshotProgram(projectId: string): FixedStudioBridgeProgram {
  const request: StudioBridgeRequest = {
    protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
    action: 'snapshot',
    projectId,
  };
  return buildStudioBridgeProgram(request);
}
