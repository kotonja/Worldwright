import type { StudioMcpClient } from '../mcp/client.js';
import type {
  StudioExactSessionLease,
  StudioReconnectObservation,
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

/**
 * Returns the verifier's observation when a replacement was required, allowing
 * exact identity verification and the first complete snapshot to be one fixed
 * Studio call before the candidate client is accepted.
 */
export function reconnectExactStudioSessionWithVerifiedObservation<T>(
  lease: StudioExactSessionLease,
  state: StudioReconnectState | undefined,
  verify: StudioReconnectVerifier<T>,
): Promise<StudioReconnectObservation<T>> {
  return lease.clientForVerifiedObservation(state, verify);
}
