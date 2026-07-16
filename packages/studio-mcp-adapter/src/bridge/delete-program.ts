import type { RobloxManagedNode } from '@worldwright/roblox-compiler';

import { STUDIO_BRIDGE_PROTOCOL_VERSION } from '../constants.js';
import { canonicalNodeMetadata } from '../engine-state.js';
import type { FixedStudioBridgeProgram } from '../mcp/client.js';
import type { StudioBridgeRequest } from '../types.js';
import { buildStudioBridgeProgram } from './program.js';

export function buildDeleteProgram(
  projectId: string,
  before: Readonly<RobloxManagedNode>,
): FixedStudioBridgeProgram {
  const metadata = canonicalNodeMetadata(before);
  const request: StudioBridgeRequest = {
    protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
    action: 'delete',
    projectId,
    before,
    beforeStateJson: metadata.json,
    beforeStateHash: metadata.hash,
  };
  return buildStudioBridgeProgram(request);
}
