import type { StudioMcpClient } from '../mcp/client.js';
import type {
  StudioExactSessionLease,
  StudioReconnectState,
  StudioReconnectVerifier,
} from './session-lease.js';

/** Observation-only reconnect entrypoint used after an uncertain mutation lane is poisoned. */
export function reconnectExactStudioSessionForObservation(
  lease: StudioExactSessionLease,
  state: StudioReconnectState | undefined,
  verify: StudioReconnectVerifier,
): Promise<StudioMcpClient> {
  return lease.clientForObservation(state, verify);
}
