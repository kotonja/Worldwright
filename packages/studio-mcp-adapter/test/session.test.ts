import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertSandboxStudioProbe,
  listStudioSessions,
  parseStudioSessionListText,
  parseStudioStateText,
  sanitizeStudioDisplayName,
  selectReadOnlyStudioSession,
  selectStudioSession,
} from '../src/mcp/session.js';
import { connectStudioMcpForTesting } from '../src/testing.js';
import { FakeStudioProtocol } from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('Studio session selection and sandbox gates', () => {
  it('parses, sanitizes, and deterministically sorts session summaries', () => {
    expect(
      parseStudioSessionListText(
        JSON.stringify({
          studios: [
            { id: 'studio-b', name: 'Beta\nPlace', active: false },
            { studio_id: 'studio-a', studio_name: 'Alpha', is_active: true },
          ],
        }),
      ),
    ).toEqual([
      { studioId: 'studio-a', displayName: 'Alpha', active: true },
      { studioId: 'studio-b', displayName: 'Beta Place', active: false },
    ]);
    expect(sanitizeStudioDisplayName('Sandbox\n\u001b[31m\u009bunsafe')).toBe(
      'Sandbox [31m unsafe',
    );
    expect(sanitizeStudioDisplayName('Sandbox\u202e hidden')).toBe('Sandbox hidden');
    expect(sanitizeStudioDisplayName('C:\\Users\\private\\place.rbxl')).toBe('Redacted Studio');
    expect(sanitizeStudioDisplayName('C\u200b:\\Users\\private\\place.rbxl')).toBe(
      'Redacted Studio',
    );
    expect(() =>
      parseStudioSessionListText(
        JSON.stringify({ studios: [{ id: '/workspace/private', name: 'Unsafe', active: true }] }),
      ),
    ).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.response_invalid' })],
      }),
    );
  });

  it('selects one exact ID and verifies it became active', async () => {
    let selected = false;
    const client = {
      async listStudioSessionsText(): Promise<string> {
        return JSON.stringify({
          studios: [{ id: 'studio-one', name: 'Sandbox', active: selected }],
        });
      },
      async selectStudioSessionById(studioId: string): Promise<void> {
        expect(studioId).toBe('studio-one');
        selected = true;
      },
    };

    await expect(selectStudioSession(client, 'studio-one')).resolves.toEqual({
      studioId: 'studio-one',
      displayName: 'Sandbox',
      active: true,
    });
  });

  it('bounds a hung session-list call by the dedicated discovery deadline', async () => {
    vi.useFakeTimers();
    const protocol = new FakeStudioProtocol();
    const client = await connectStudioMcpForTesting(() => protocol);
    const originalInvoke = protocol.invoke.bind(protocol);
    Object.defineProperty(protocol, 'invoke', {
      configurable: true,
      value: async (...args: Parameters<typeof originalInvoke>): Promise<unknown> => {
        if (args[0] === 'list_roblox_studios') {
          return new Promise<unknown>(() => undefined);
        }
        return originalInvoke(...args);
      },
    });
    try {
      const listing = listStudioSessions(client);
      const rejection = expect(listing).rejects.toMatchObject({
        diagnostics: [expect.objectContaining({ code: 'studio.tool_timeout' })],
      });
      await vi.advanceTimersByTimeAsync(6_000);
      await rejection;
    } finally {
      await client.close();
    }
  });

  it('waits for asynchronous Studio registration and transient partial session data', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const client = {
      async listStudioSessionsText(): Promise<string> {
        calls += 1;
        if (calls === 1) return JSON.stringify({ studios: [] });
        if (calls === 2) {
          return JSON.stringify({
            studios: [{ id: 'studio-one', name: null, active: false }],
          });
        }
        return JSON.stringify({
          studios: [{ id: 'studio-one', name: 'Sandbox', active: false }],
        });
      },
      async selectStudioSessionById(): Promise<void> {
        throw new Error('Selection is not expected.');
      },
    };

    const discovery = listStudioSessions(client);
    await vi.runAllTimersAsync();
    await expect(discovery).resolves.toEqual([
      { studioId: 'studio-one', displayName: 'Sandbox', active: false },
    ]);
    expect(calls).toBe(3);
  });

  it('does not auto-select among multiple sessions, including an already active one', async () => {
    let mutations = 0;
    const client = {
      async listStudioSessionsText(): Promise<string> {
        return JSON.stringify([
          { id: 'studio-a', name: 'A', active: true },
          { id: 'studio-b', name: 'B', active: false },
        ]);
      },
      async selectStudioSessionById(): Promise<void> {
        mutations += 1;
      },
    };

    await expect(selectReadOnlyStudioSession(client)).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({ code: 'studio.session_ambiguous', relatedId: 'studio-a' }),
        expect.objectContaining({ code: 'studio.session_ambiguous', relatedId: 'studio-b' }),
      ],
    });
    expect(mutations).toBe(0);
  });

  it('rejects an ambiguous post-selection response with multiple active sessions', async () => {
    vi.useFakeTimers();
    const client = {
      async listStudioSessionsText(): Promise<string> {
        return JSON.stringify([
          { id: 'studio-a', name: 'A', active: true },
          { id: 'studio-b', name: 'B', active: true },
        ]);
      },
      async selectStudioSessionById(): Promise<void> {},
    };

    const selection = selectStudioSession(client, 'studio-a');
    const rejection = expect(selection).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'studio.response_invalid' })],
    });
    await vi.advanceTimersByTimeAsync(6_000);
    await rejection;
  });

  it('extracts stopped Edit availability from Studio state', () => {
    expect(
      parseStudioStateText(
        JSON.stringify({ play_state: 'NotRunning', available_datamodel_types: ['Edit'] }),
      ),
    ).toEqual({
      playState: 'NotRunning',
      availableDataModelTypes: ['Edit'],
      editAvailable: true,
      playtesting: false,
    });
    expect(
      parseStudioStateText(
        '- Current Studio Mode: Edit\n- Available DataModels: Edit\n- Focused DataModel in the viewport: Edit',
      ),
    ).toEqual({
      playState: 'Edit',
      availableDataModelTypes: ['Edit'],
      editAvailable: true,
      playtesting: false,
    });
  });

  it('accepts only an unsaved, stopped Edit sandbox', () => {
    const valid = {
      studioId: 'studio-one',
      placeName: 'Sandbox',
      placeId: 0,
      gameId: 0,
      dataModelMode: 'Edit',
      playtesting: false,
      editExecutionAvailable: true,
    } as const;
    expect(assertSandboxStudioProbe(valid)).toEqual(valid);

    expect(() => assertSandboxStudioProbe({ ...valid, placeId: 42 })).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.published_place_forbidden' })],
      }),
    );
    expect(() => assertSandboxStudioProbe({ ...valid, playtesting: true })).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.edit_mode_required' })],
      }),
    );
    expect(() =>
      assertSandboxStudioProbe({ ...valid, dataModelMode: 'Client', playtesting: false }),
    ).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.edit_mode_required' })],
      }),
    );
  });
});
