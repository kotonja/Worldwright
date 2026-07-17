import { STUDIO_MCP_MAX_RECONNECTS_PER_TRANSACTION } from '../constants.js';
import { StudioAdapterError, studioDiagnostic } from '../diagnostics.js';
import {
  connectStudioMcp,
  poisonStudioMcpClient,
  StudioMcpTerminationUnprovenError,
  type StudioMcpClient,
} from '../mcp/client.js';
import { selectStudioSession, type StudioSessionSummary } from '../mcp/session.js';

export interface StudioReconnectState {
  needsReconnect: boolean;
  uncertainTransportEvents: number;
  reconnectAttempts: number;
  reconnectsSucceeded: number;
}

export type StudioMcpClientFactory = () => Promise<StudioMcpClient>;
export type StudioReconnectVerifier<T = void> = (client: StudioMcpClient) => Promise<T>;

export interface StudioReconnectObservation<T> {
  readonly client: StudioMcpClient;
  /** Present only when a replacement client was verified before installation. */
  readonly verified?: T;
}

export function createStudioReconnectState(): StudioReconnectState {
  return {
    needsReconnect: false,
    uncertainTransportEvents: 0,
    reconnectAttempts: 0,
    reconnectsSucceeded: 0,
  };
}

/**
 * Owns one exact private Studio identity while allowing only observation-driven
 * replacement of a poisoned local-stdio client.
 */
export class StudioExactSessionLease {
  #client: StudioMcpClient;
  readonly #session: StudioSessionSummary;
  readonly #connectClient: StudioMcpClientFactory;
  #closed = false;
  #replacementTerminationUnproven = false;

  public constructor(
    client: StudioMcpClient,
    session: StudioSessionSummary,
    connectClient: StudioMcpClientFactory = connectStudioMcp,
  ) {
    this.#client = client;
    this.#session = Object.freeze({ ...session });
    this.#connectClient = connectClient;
  }

  public get studioId(): string {
    return this.#session.studioId;
  }

  public get displayName(): string {
    return this.#session.displayName;
  }

  public currentClient(): StudioMcpClient {
    if (this.#closed) {
      throw new StudioAdapterError([
        studioDiagnostic('studio.usage_invalid', '/adapter', 'The Studio adapter is closed.'),
      ]);
    }
    return this.#client;
  }

  public async reassertExactSession(): Promise<void> {
    await selectStudioSession(this.currentClient(), this.#session.studioId);
  }

  public async markUncertainMutation(state: StudioReconnectState): Promise<void> {
    if (!state.needsReconnect) {
      state.needsReconnect = true;
      state.uncertainTransportEvents += 1;
    }
    await poisonStudioMcpClient(this.#client);
  }

  /**
   * Reconnects only for the next required observation after uncertainty. The
   * candidate is not installed until exact-ID selection and the caller's full
   * sandbox re-probe both succeed.
   */
  public async clientForVerifiedObservation<T>(
    state: StudioReconnectState | undefined,
    verify: StudioReconnectVerifier<T>,
  ): Promise<StudioReconnectObservation<T>> {
    if (this.#client.poisoned && state !== undefined && !state.needsReconnect) {
      state.needsReconnect = true;
      state.uncertainTransportEvents += 1;
    }
    const needsReconnect = state?.needsReconnect === true || this.#client.poisoned;
    if (!needsReconnect) return { client: this.currentClient() };
    if (state === undefined) {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.tool_call_failed',
          '/reconnect',
          'A poisoned Studio client cannot be reused outside its transaction recovery context.',
        ),
      ]);
    }
    if (state.reconnectAttempts >= STUDIO_MCP_MAX_RECONNECTS_PER_TRANSACTION) {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.tool_call_failed',
          '/reconnect',
          'The bounded Studio reconnect limit was reached.',
        ),
      ]);
    }
    if (this.#replacementTerminationUnproven) {
      throw new StudioMcpTerminationUnprovenError('/reconnect');
    }
    if (!this.#client.terminationProven) {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.tool_call_failed',
          '/reconnect',
          'The old poisoned Studio MCP process tree was not proven terminated.',
        ),
      ]);
    }

    state.reconnectAttempts += 1;
    let candidate: StudioMcpClient | undefined;
    try {
      candidate = await this.#connectClient();
      await selectStudioSession(candidate, this.#session.studioId);
      const verified = await verify(candidate);
      this.#client = candidate;
      state.needsReconnect = false;
      state.reconnectsSucceeded += 1;
      return { client: candidate, verified };
    } catch (error) {
      if (candidate !== undefined) {
        try {
          await candidate.close();
        } catch {
          this.#replacementTerminationUnproven = true;
          throw new StudioMcpTerminationUnprovenError('/reconnect');
        }
      }
      if (error instanceof StudioMcpTerminationUnprovenError) {
        this.#replacementTerminationUnproven = true;
      }
      if (error instanceof StudioAdapterError) throw error;
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.tool_call_failed',
          '/reconnect',
          'The exact Studio session could not be safely reconnected.',
        ),
      ]);
    }
  }

  public async clientForObservation(
    state: StudioReconnectState | undefined,
    verify: StudioReconnectVerifier,
  ): Promise<StudioMcpClient> {
    return (await this.clientForVerifiedObservation(state, verify)).client;
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      if (this.#replacementTerminationUnproven) {
        throw new StudioMcpTerminationUnprovenError('/reconnect');
      }
      return;
    }
    this.#closed = true;
    await this.#client.close();
    if (this.#replacementTerminationUnproven) {
      throw new StudioMcpTerminationUnprovenError('/reconnect');
    }
  }
}
