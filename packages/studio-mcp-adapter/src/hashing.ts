import { createHash } from 'node:crypto';

import {
  stringifyStudioApplyReceipt,
  stringifyStudioBridgeRequest,
  stringifyStudioBridgeResponse,
  stringifyStudioManagedNodeState,
} from './normalize.js';
import type {
  StudioApplyReceipt,
  StudioBridgeManagedNode,
  StudioBridgeRequest,
  StudioBridgeResponse,
} from './types.js';

function sha256Utf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashStudioBridgeRequest(request: Readonly<StudioBridgeRequest>): string {
  return sha256Utf8(stringifyStudioBridgeRequest(request));
}

export function hashStudioBridgeResponse(response: Readonly<StudioBridgeResponse>): string {
  return sha256Utf8(stringifyStudioBridgeResponse(response));
}

export function hashStudioManagedNodeState(node: Readonly<StudioBridgeManagedNode>): string {
  return sha256Utf8(stringifyStudioManagedNodeState(node));
}

export function hashStudioApplyReceipt(receipt: Readonly<StudioApplyReceipt>): string {
  return sha256Utf8(stringifyStudioApplyReceipt(receipt));
}

export function hashCaptureBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
