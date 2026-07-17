import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createStudioReconnectState,
  StudioExactSessionLease,
} from '../src/connection/session-lease.js';
import { connectStudioMcpForTesting } from '../src/testing.js';
import { FakeStudioProtocol } from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('exact Studio session reconnect lease', () => {
  it('returns the verifier observation produced before installing a replacement client', async () => {
    const initialProtocol = new FakeStudioProtocol();
    const initialClient = await connectStudioMcpForTesting(() => initialProtocol);
    const replacementProtocol = new FakeStudioProtocol();
    const lease = new StudioExactSessionLease(
      initialClient,
      { studioId: 'studio-test', displayName: 'Unsaved Sandbox', active: true },
      async () => connectStudioMcpForTesting(() => replacementProtocol),
    );
    const state = createStudioReconnectState();
    await lease.markUncertainMutation(state);

    const observation = await lease.clientForVerifiedObservation(state, async (candidate) => {
      expect(candidate).not.toBe(initialClient);
      return Object.freeze({ classificationInput: 'lease-bound-snapshot' as const });
    });

    expect(observation.client).not.toBe(initialClient);
    expect(observation.verified).toEqual({ classificationInput: 'lease-bound-snapshot' });
    expect(lease.currentClient()).toBe(observation.client);
    await lease.close();
  });

  it('closes the poisoned client before selecting the exact ID on a new connection', async () => {
    const initialProtocol = new FakeStudioProtocol();
    const initialClient = await connectStudioMcpForTesting(() => initialProtocol);
    const replacementProtocol = new FakeStudioProtocol();
    let factoryCalls = 0;
    const lease = new StudioExactSessionLease(
      initialClient,
      { studioId: 'studio-test', displayName: 'Unsaved Sandbox', active: true },
      async () => {
        factoryCalls += 1;
        expect(initialProtocol.closed).toBe(true);
        return connectStudioMcpForTesting(() => replacementProtocol);
      },
    );
    const state = createStudioReconnectState();
    await lease.markUncertainMutation(state);
    const initialCallsAfterPoison = initialProtocol.calls.length;
    let verified = false;
    const client = await lease.clientForObservation(state, async () => {
      verified = true;
    });
    expect(client).not.toBe(initialClient);
    expect(factoryCalls).toBe(1);
    expect(verified).toBe(true);
    expect(initialProtocol.calls).toHaveLength(initialCallsAfterPoison);
    expect(replacementProtocol.calls.some((call) => call.tool === 'set_active_studio')).toBe(true);
    expect(state).toEqual({
      needsReconnect: false,
      uncertainTransportEvents: 1,
      reconnectAttempts: 1,
      reconnectsSucceeded: 1,
    });
    await lease.close();
  });

  it('does not select a different sole Studio even when its display name matches', async () => {
    vi.useFakeTimers();
    const initialProtocol = new FakeStudioProtocol();
    const initialClient = await connectStudioMcpForTesting(() => initialProtocol);
    const replacementProtocol = new FakeStudioProtocol();
    const originalInvoke = replacementProtocol.invoke.bind(replacementProtocol);
    Object.defineProperty(replacementProtocol, 'invoke', {
      configurable: true,
      value: async (...args: Parameters<typeof originalInvoke>): Promise<unknown> => {
        if (args[0] === 'list_roblox_studios') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  studios: [{ id: 'different-id', name: 'Unsaved Sandbox', active: true }],
                }),
              },
            ],
            isError: false,
          };
        }
        return originalInvoke(...args);
      },
    });
    const lease = new StudioExactSessionLease(
      initialClient,
      { studioId: 'studio-test', displayName: 'Unsaved Sandbox', active: true },
      async () => connectStudioMcpForTesting(() => replacementProtocol),
    );
    const state = createStudioReconnectState();
    await lease.markUncertainMutation(state);
    const reconnecting = lease.clientForObservation(state, async () => undefined);
    const rejected = expect(reconnecting).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'studio.session_not_found' })],
    });
    await vi.advanceTimersByTimeAsync(7_000);
    await rejected;
    expect(replacementProtocol.calls.some((call) => call.tool === 'set_active_studio')).toBe(false);
    expect(replacementProtocol.closed).toBe(true);
    expect(state.reconnectsSucceeded).toBe(0);
    await lease.close();
  });

  it('rejects and cleans replacement clients with missing or incompatible required tools', async () => {
    for (const scenario of ['missing', 'incompatible'] as const) {
      const initialProtocol = new FakeStudioProtocol();
      const initialClient = await connectStudioMcpForTesting(() => initialProtocol);
      const replacementProtocol = new FakeStudioProtocol();
      const originalListTools = replacementProtocol.listTools.bind(replacementProtocol);
      Object.defineProperty(replacementProtocol, 'listTools', {
        configurable: true,
        value: async (): Promise<unknown> => {
          const envelope = (await originalListTools()) as { readonly tools: readonly unknown[] };
          if (scenario === 'missing') {
            return {
              tools: envelope.tools.filter(
                (tool) => (tool as { readonly name?: unknown }).name !== 'execute_luau',
              ),
            };
          }
          return {
            tools: envelope.tools.map((tool) =>
              (tool as { readonly name?: unknown }).name === 'execute_luau'
                ? {
                    name: 'execute_luau',
                    inputSchema: {
                      type: 'object',
                      properties: { code: { type: 'string' } },
                      required: ['code'],
                    },
                  }
                : tool,
            ),
          };
        },
      });
      const lease = new StudioExactSessionLease(
        initialClient,
        { studioId: 'studio-test', displayName: 'Unsaved Sandbox', active: true },
        async () => connectStudioMcpForTesting(() => replacementProtocol),
      );
      const state = createStudioReconnectState();
      await lease.markUncertainMutation(state);
      await expect(lease.clientForObservation(state, async () => undefined)).rejects.toMatchObject({
        diagnostics: [
          expect.objectContaining({
            code: scenario === 'missing' ? 'studio.tool_missing' : 'studio.tool_schema_unsupported',
          }),
        ],
      });
      expect(replacementProtocol.closed).toBe(true);
      expect(state).toMatchObject({ reconnectAttempts: 1, reconnectsSucceeded: 0 });
      await lease.close();
    }
  });

  it('permanently blocks replacement when a rejected candidate cannot prove termination', async () => {
    vi.useFakeTimers();
    const initialProtocol = new FakeStudioProtocol();
    const initialClient = await connectStudioMcpForTesting(() => initialProtocol);
    const replacementProtocol = new FakeStudioProtocol();
    const originalInvoke = replacementProtocol.invoke.bind(replacementProtocol);
    Object.defineProperty(replacementProtocol, 'invoke', {
      configurable: true,
      value: async (...args: Parameters<typeof originalInvoke>): Promise<unknown> => {
        if (args[0] === 'list_roblox_studios') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  studios: [{ id: 'different-id', name: 'Other Sandbox', active: true }],
                }),
              },
            ],
            isError: false,
          };
        }
        return originalInvoke(...args);
      },
    });
    Object.defineProperty(replacementProtocol, 'close', {
      configurable: true,
      value: async (): Promise<void> => {
        throw new Error('Injected candidate termination failure.');
      },
    });
    let factoryCalls = 0;
    const lease = new StudioExactSessionLease(
      initialClient,
      { studioId: 'studio-test', displayName: 'Unsaved Sandbox', active: true },
      async () => {
        factoryCalls += 1;
        return connectStudioMcpForTesting(() => replacementProtocol);
      },
    );
    const state = createStudioReconnectState();
    await lease.markUncertainMutation(state);
    const rejected = expect(
      lease.clientForObservation(state, async () => undefined),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'studio.mcp_start_failed' })],
    });
    await vi.advanceTimersByTimeAsync(7_000);
    await rejected;
    await expect(lease.clientForObservation(state, async () => undefined)).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'studio.mcp_start_failed' })],
    });
    expect(factoryCalls).toBe(1);
    expect(state).toMatchObject({ reconnectAttempts: 1, reconnectsSucceeded: 0 });
    await expect(lease.close()).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'studio.mcp_start_failed' })],
    });
  });

  it('rejects a third reconnect attempt without starting another client', async () => {
    const initialProtocol = new FakeStudioProtocol();
    const initialClient = await connectStudioMcpForTesting(() => initialProtocol);
    let factoryCalls = 0;
    const lease = new StudioExactSessionLease(
      initialClient,
      { studioId: 'studio-test', displayName: 'Unsaved Sandbox', active: true },
      async () => {
        factoryCalls += 1;
        return connectStudioMcpForTesting(() => new FakeStudioProtocol());
      },
    );
    const state = createStudioReconnectState();
    state.reconnectAttempts = 2;
    await lease.markUncertainMutation(state);
    await expect(lease.clientForObservation(state, async () => undefined)).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'studio.tool_call_failed' })],
    });
    expect(factoryCalls).toBe(0);
    await lease.close();
  });

  it('permits exactly two successive uncertainty reconnections and then fails closed', async () => {
    const initialProtocol = new FakeStudioProtocol();
    const initialClient = await connectStudioMcpForTesting(() => initialProtocol);
    const replacements = [new FakeStudioProtocol(), new FakeStudioProtocol()];
    let factoryCalls = 0;
    const lease = new StudioExactSessionLease(
      initialClient,
      { studioId: 'studio-test', displayName: 'Unsaved Sandbox', active: true },
      async () => {
        const protocol = replacements[factoryCalls];
        factoryCalls += 1;
        if (protocol === undefined) throw new Error('Unexpected third client construction.');
        return connectStudioMcpForTesting(() => protocol);
      },
    );
    const state = createStudioReconnectState();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await lease.markUncertainMutation(state);
      await lease.clientForObservation(state, async () => undefined);
    }
    expect(state.reconnectAttempts).toBe(2);
    expect(state.reconnectsSucceeded).toBe(2);
    expect(state.uncertainTransportEvents).toBe(2);
    await lease.markUncertainMutation(state);
    await expect(lease.clientForObservation(state, async () => undefined)).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'studio.tool_call_failed' })],
    });
    expect(factoryCalls).toBe(2);
    expect(state.uncertainTransportEvents).toBe(3);
    await lease.close();
  });

  it('refuses replacement when poisoned-process termination fails', async () => {
    const initialProtocol = new FakeStudioProtocol();
    Object.defineProperty(initialProtocol, 'close', {
      configurable: true,
      value: async (): Promise<void> => {
        throw new Error('Injected termination failure.');
      },
    });
    const initialClient = await connectStudioMcpForTesting(() => initialProtocol);
    let factoryCalls = 0;
    const lease = new StudioExactSessionLease(
      initialClient,
      { studioId: 'studio-test', displayName: 'Unsaved Sandbox', active: true },
      async () => {
        factoryCalls += 1;
        return connectStudioMcpForTesting(() => new FakeStudioProtocol());
      },
    );
    const state = createStudioReconnectState();
    await expect(lease.markUncertainMutation(state)).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'studio.tool_call_failed' })],
    });
    await expect(lease.clientForObservation(state, async () => undefined)).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'studio.tool_call_failed' })],
    });
    expect(factoryCalls).toBe(0);
    expect(state.reconnectAttempts).toBe(0);
    await expect(lease.close()).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'studio.tool_call_failed' })],
    });
  });

  it('refuses replacement when poisoned-process termination times out', async () => {
    vi.useFakeTimers();
    const initialProtocol = new FakeStudioProtocol();
    Object.defineProperty(initialProtocol, 'close', {
      configurable: true,
      value: (): Promise<void> => new Promise(() => undefined),
    });
    const initialClient = await connectStudioMcpForTesting(() => initialProtocol);
    let factoryCalls = 0;
    const lease = new StudioExactSessionLease(
      initialClient,
      { studioId: 'studio-test', displayName: 'Unsaved Sandbox', active: true },
      async () => {
        factoryCalls += 1;
        return connectStudioMcpForTesting(() => new FakeStudioProtocol());
      },
    );
    const state = createStudioReconnectState();
    const poisoning = expect(lease.markUncertainMutation(state)).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'studio.tool_call_failed' })],
    });
    await vi.advanceTimersByTimeAsync(7_000);
    await poisoning;
    await expect(lease.clientForObservation(state, async () => undefined)).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'studio.tool_call_failed' })],
    });
    expect(factoryCalls).toBe(0);
  });
});
