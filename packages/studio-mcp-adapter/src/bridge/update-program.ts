import type { RobloxManagedNode } from '@worldwright/roblox-compiler';

import { STUDIO_BRIDGE_PROTOCOL_VERSION } from '../constants.js';
import { canonicalNodeMetadata } from '../engine-state.js';
import type { FixedStudioBridgeProgram } from '../mcp/client.js';
import type { StudioBridgeRequest } from '../types.js';
import { buildParentState } from './parent-state.js';
import { buildStudioBridgeProgram } from './program.js';

export function buildUpdateProgram(
  projectId: string,
  before: Readonly<RobloxManagedNode>,
  after: Readonly<RobloxManagedNode>,
  beforeParent: Readonly<RobloxManagedNode> | undefined,
  afterParent: Readonly<RobloxManagedNode> | undefined,
): FixedStudioBridgeProgram {
  const beforeMetadata = canonicalNodeMetadata(before);
  const afterMetadata = canonicalNodeMetadata(after);
  const beforeParentState = buildParentState(beforeParent);
  const afterParentState = buildParentState(afterParent);
  const request: StudioBridgeRequest = {
    protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
    action: 'update',
    projectId,
    before,
    after,
    beforeStateJson: beforeMetadata.json,
    beforeStateHash: beforeMetadata.hash,
    afterStateJson: afterMetadata.json,
    afterStateHash: afterMetadata.hash,
    ...(beforeParentState === undefined ? {} : { beforeParentState }),
    ...(afterParentState === undefined ? {} : { afterParentState }),
  };
  return buildStudioBridgeProgram(request);
}
