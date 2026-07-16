import type { RobloxManagedNode } from '@worldwright/roblox-compiler';

import { STUDIO_BRIDGE_PROTOCOL_VERSION } from '../constants.js';
import { canonicalNodeMetadata } from '../engine-state.js';
import type { FixedStudioBridgeProgram } from '../mcp/client.js';
import type { StudioBridgeRequest } from '../types.js';
import { buildParentState } from './parent-state.js';
import { buildStudioBridgeProgram } from './program.js';

export function buildCreateProgram(
  projectId: string,
  node: Readonly<RobloxManagedNode>,
  parent: Readonly<RobloxManagedNode> | undefined,
): FixedStudioBridgeProgram {
  const metadata = canonicalNodeMetadata(node);
  const parentState = buildParentState(parent);
  const request: StudioBridgeRequest = {
    protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
    action: 'create',
    projectId,
    node,
    stateJson: metadata.json,
    stateHash: metadata.hash,
    ...(parentState === undefined ? {} : { parentState }),
  };
  return buildStudioBridgeProgram(request);
}
