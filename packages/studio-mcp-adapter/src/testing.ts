import type { ApplyResult } from '@worldwright/roblox-compiler';

import {
  runAuthorizedStudioTransactionForTesting,
  type StudioAdapterFaultOperation,
  type StudioMcpRobloxAdapter,
} from './adapter.js';
export {
  connectStudioMcpForTesting,
  type StudioMcpProtocol,
  type StudioMcpProtocolFactory,
} from './mcp/client.js';

export type { StudioAdapterFaultOperation } from './adapter.js';

export function applyStudioChangeSetWithPostMutationFault(
  adapter: StudioMcpRobloxAdapter,
  input: unknown,
  operation: StudioAdapterFaultOperation,
): Promise<ApplyResult> {
  return runAuthorizedStudioTransactionForTesting(adapter, input, operation);
}
