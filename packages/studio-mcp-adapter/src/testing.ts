import type { ApplyResult } from '@worldwright/roblox-compiler';

import {
  runAuthorizedStudioTransactionForTesting,
  runStudioBatchDoubleLostAcknowledgmentForTesting,
  runStudioBatchLostAcknowledgmentForTesting,
  type StudioChangeSetApplyEvidence,
  type StudioAdapterFaultOperation,
  type StudioMcpRobloxAdapter,
} from './adapter.js';
export {
  connectStudioMcpForTesting,
  connectStudioPlaytestMcpForTesting,
  type StudioMcpProtocol,
  type StudioMcpProtocolFactory,
} from './mcp/client.js';
export {
  createStudioPlaytestControllerForTesting,
  type StudioPlaytestControllerTestingOptions,
} from './playtest/controller.js';

export type { StudioAdapterFaultOperation } from './adapter.js';

export function applyStudioChangeSetWithPostMutationFault(
  adapter: StudioMcpRobloxAdapter,
  input: unknown,
  operation: StudioAdapterFaultOperation,
): Promise<ApplyResult> {
  return runAuthorizedStudioTransactionForTesting(adapter, input, operation);
}

export function applyStudioChangeSetWithLostBatchAcknowledgment(
  adapter: StudioMcpRobloxAdapter,
  input: unknown,
): Promise<StudioChangeSetApplyEvidence> {
  return runStudioBatchLostAcknowledgmentForTesting(adapter, input);
}

export function applyStudioChangeSetWithLostForwardAndCompensationAcknowledgments(
  adapter: StudioMcpRobloxAdapter,
  input: unknown,
): Promise<StudioChangeSetApplyEvidence> {
  return runStudioBatchDoubleLostAcknowledgmentForTesting(adapter, input);
}
