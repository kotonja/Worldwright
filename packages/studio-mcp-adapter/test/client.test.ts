import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AllowedStudioMcpToolName } from '../src/mcp/capabilities.js';
import {
  executeFixedStudioBridgeProgram,
  issueFixedStudioBridgeProgram,
  type FixedStudioBridgeProgram,
} from '../src/mcp/client.js';
import { connectStudioMcpForTesting } from '../src/testing.js';

function validToolList(): readonly unknown[] {
  return [
    { name: 'list_roblox_studios', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'set_active_studio',
      inputSchema: {
        type: 'object',
        properties: { studio_id: { type: 'string' } },
        required: ['studio_id'],
      },
    },
    { name: 'get_studio_state', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'execute_luau',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          datamodel_type: { type: 'string', enum: ['Edit', 'Client', 'Server'] },
        },
        required: ['code', 'datamodel_type'],
      },
    },
  ];
}

afterEach(() => {
  vi.useRealTimers();
});

describe('narrow Studio MCP client', () => {
  it('discovers capabilities and invokes only an issued fixed Edit program', async () => {
    const calls: Array<{
      tool: AllowedStudioMcpToolName;
      argumentsValue: Readonly<Record<string, unknown>>;
    }> = [];
    const protocol = {
      async connect(): Promise<void> {},
      async listTools(): Promise<unknown> {
        return { tools: validToolList() };
      },
      async invoke(
        tool: AllowedStudioMcpToolName,
        argumentsValue: Readonly<Record<string, unknown>>,
      ): Promise<unknown> {
        calls.push({ tool, argumentsValue });
        return { content: [{ type: 'text', text: 'ok' }] };
      },
      async close(): Promise<void> {},
    };
    const client = await connectStudioMcpForTesting(() => protocol);

    await expect(
      executeFixedStudioBridgeProgram(client, issueFixedStudioBridgeProgram('return "fixed"')),
    ).resolves.toBe('ok');
    expect(calls).toEqual([
      {
        tool: 'execute_luau',
        argumentsValue: { code: 'return "fixed"', datamodel_type: 'Edit' },
      },
    ]);

    await expect(
      executeFixedStudioBridgeProgram(
        client,
        Object.freeze({ source: 'return "forged"' }) as FixedStudioBridgeProgram,
      ),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'studio.usage_invalid' })],
    });
    expect(calls).toHaveLength(1);
    await client.close();
  });

  it('rejects reflective access to the adapter-only viewport capability', async () => {
    const calls: AllowedStudioMcpToolName[] = [];
    const protocol = {
      async connect(): Promise<void> {},
      async listTools(): Promise<unknown> {
        return { tools: validToolList() };
      },
      async invoke(tool: AllowedStudioMcpToolName): Promise<unknown> {
        calls.push(tool);
        return { content: [{ type: 'text', text: 'unexpected' }] };
      },
      async close(): Promise<void> {},
    };
    const client = await connectStudioMcpForTesting(() => protocol);
    try {
      const privilegedSymbols = Object.getOwnPropertySymbols(Object.getPrototypeOf(client)).filter(
        (symbol) =>
          symbol.description?.includes('captureViewport') === true ||
          symbol.description?.includes('executeFixedProgram') === true,
      );
      expect(privilegedSymbols).toEqual([]);
      expect(calls).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it('closes the protocol and sanitizes startup failure details', async () => {
    let closes = 0;
    const protocol = {
      async connect(): Promise<void> {
        throw new Error('C:\\Users\\private\\Roblox\\StudioMCP.exe failed');
      },
      async listTools(): Promise<unknown> {
        return { tools: [] };
      },
      async invoke(): Promise<unknown> {
        return { content: [] };
      },
      async close(): Promise<void> {
        closes += 1;
      },
    };

    await expect(connectStudioMcpForTesting(() => protocol)).rejects.toMatchObject({
      message: 'The local Studio operation failed.',
      diagnostics: [expect.objectContaining({ code: 'studio.mcp_start_failed' })],
    });
    expect(closes).toBe(1);
  });

  it('rejects unknown tools-list envelope fields before capability discovery', async () => {
    let closes = 0;
    const protocol = {
      async connect(): Promise<void> {},
      async listTools(): Promise<unknown> {
        return { tools: validToolList(), _meta: { private: 'unexpected' } };
      },
      async invoke(): Promise<unknown> {
        return { content: [] };
      },
      async close(): Promise<void> {
        closes += 1;
      },
    };

    await expect(connectStudioMcpForTesting(() => protocol)).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'studio.mcp_handshake_failed' })],
    });
    expect(closes).toBe(1);
  });

  it('aborts and closes a startup operation at the fixed bound', async () => {
    vi.useFakeTimers();
    let closes = 0;
    let observedSignal: AbortSignal | undefined;
    const protocol = {
      async connect(signal: AbortSignal): Promise<void> {
        observedSignal = signal;
        await new Promise<void>(() => undefined);
      },
      async listTools(): Promise<unknown> {
        return { tools: validToolList() };
      },
      async invoke(): Promise<unknown> {
        return { content: [] };
      },
      async close(): Promise<void> {
        closes += 1;
      },
    };

    const connection = connectStudioMcpForTesting(() => protocol);
    const rejection = expect(connection).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'studio.mcp_start_failed' })],
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect(observedSignal?.aborted).toBe(true);
    expect(closes).toBe(1);
  });

  it('bounds cleanup when a failed protocol never finishes closing', async () => {
    vi.useFakeTimers();
    const protocol = {
      async connect(): Promise<void> {
        throw new Error('startup failed');
      },
      async listTools(): Promise<unknown> {
        return { tools: validToolList() };
      },
      async invoke(): Promise<unknown> {
        return { content: [] };
      },
      async close(): Promise<void> {
        await new Promise<void>(() => undefined);
      },
    };

    const connection = connectStudioMcpForTesting(() => protocol);
    const rejection = expect(connection).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'studio.mcp_start_failed' })],
    });
    await vi.advanceTimersByTimeAsync(7_000);
    await rejection;
  });

  it('classifies an abort-aware execute rejection at the boundary as a timeout', async () => {
    vi.useFakeTimers();
    let closes = 0;
    const protocol = {
      async connect(): Promise<void> {},
      async listTools(): Promise<unknown> {
        return { tools: validToolList() };
      },
      async invoke(
        _tool: AllowedStudioMcpToolName,
        _argumentsValue: Readonly<Record<string, unknown>>,
        signal: AbortSignal,
      ): Promise<unknown> {
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('transport observed abort first')),
            { once: true },
          );
        });
      },
      async close(): Promise<void> {
        closes += 1;
      },
    };
    const client = await connectStudioMcpForTesting(() => protocol);
    const call = executeFixedStudioBridgeProgram(
      client,
      issueFixedStudioBridgeProgram('return "fixed"'),
    );
    const rejection = expect(call).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'studio.tool_timeout' })],
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(closes).toBe(1);
  });
});
