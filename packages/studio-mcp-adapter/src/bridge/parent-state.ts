import type { RobloxManagedNode } from '@worldwright/roblox-compiler';

import { canonicalNodeMetadata } from '../engine-state.js';
import type { StudioBridgeParentState } from '../types.js';

export function buildParentState(
  parent: Readonly<RobloxManagedNode> | undefined,
): StudioBridgeParentState | undefined {
  if (parent === undefined) return undefined;
  const metadata = canonicalNodeMetadata(parent);
  return {
    node: structuredClone(parent),
    stateJson: metadata.json,
    stateHash: metadata.hash,
  };
}
