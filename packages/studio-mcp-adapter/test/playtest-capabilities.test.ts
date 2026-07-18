import { describe, expect, it } from 'vitest';

import { discoverStudioMcpCapabilities } from '../src/mcp/capabilities.js';
import {
  discoverStudioPlaytestMcpCapabilities,
  REQUIRED_STUDIO_PLAYTEST_MCP_TOOLS,
} from '../src/playtest/capabilities.js';
import { connectStudioMcpForTesting, connectStudioPlaytestMcpForTesting } from '../src/testing.js';

type ToolDescription = Record<string, unknown> & {
  readonly name: string;
  inputSchema: Record<string, unknown>;
};

function coreOnlyTools(): ToolDescription[] {
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
    { name: 'get_studio_state', inputSchema: { type: 'object', properties: {}, required: [] } },
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

function playtestTools(): ToolDescription[] {
  return [
    ...coreOnlyTools(),
    {
      name: 'screen_capture',
      inputSchema: {
        type: 'object',
        properties: {
          capture_id: { type: 'string' },
          camera_position: { type: 'array', items: { type: 'number' } },
          look_at_position: { type: 'array', items: { type: 'number' } },
        },
        required: ['capture_id'],
      },
    },
    {
      name: 'start_stop_play',
      inputSchema: {
        type: 'object',
        properties: { is_start: { type: 'boolean' } },
        required: ['is_start'],
      },
    },
    { name: 'get_console_output', inputSchema: { type: 'object', properties: {}, required: [] } },
    {
      name: 'character_navigation',
      inputSchema: {
        type: 'object',
        properties: {
          datamodel_type: { type: 'string', enum: ['Client'] },
          instance_path: { type: 'string' },
          speed_multiplier: { type: 'number' },
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
        },
        required: ['datamodel_type'],
      },
    },
  ];
}

function replaceToolSchema(
  tools: ToolDescription[],
  name: string,
  inputSchema: Record<string, unknown>,
): ToolDescription[] {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Missing test tool ${name}.`);
  tool.inputSchema = inputSchema;
  return tools;
}

function expectPlaytestCapabilityFailure(tools: readonly unknown[], toolName: string): void {
  expect(() => discoverStudioPlaytestMcpCapabilities(tools)).toThrowError(
    expect.objectContaining({
      diagnostics: [
        expect.objectContaining({
          code: 'studio.playtest_capability_unavailable',
          path: `/tools/${toolName}`,
        }),
      ],
    }),
  );
}

function protocol(toolList: readonly unknown[], close: () => void = () => undefined) {
  return {
    async connect(): Promise<void> {},
    async listTools(): Promise<unknown> {
      return { tools: toolList };
    },
    async invoke(): Promise<unknown> {
      return { content: [{ type: 'text', text: 'unused' }] };
    },
    async close(): Promise<void> {
      close();
    },
  };
}

describe('Studio playtest capability discovery', () => {
  it('requires the exact separate privileged tool surface', () => {
    expect(REQUIRED_STUDIO_PLAYTEST_MCP_TOOLS).toEqual([
      'list_roblox_studios',
      'set_active_studio',
      'get_studio_state',
      'start_stop_play',
      'get_console_output',
      'character_navigation',
      'screen_capture',
      'execute_luau',
    ]);
    expect(discoverStudioPlaytestMcpCapabilities(playtestTools())).toEqual({
      executeLuauSourceField: 'code',
      navigationSpeedMultiplier: 1,
    });
  });

  it.each(REQUIRED_STUDIO_PLAYTEST_MCP_TOOLS)(
    'rejects a missing %s tool for playtest controllers',
    (missing) => {
      expectPlaytestCapabilityFailure(
        playtestTools().filter((tool) => tool.name !== missing),
        missing,
      );
    },
  );

  it.each(REQUIRED_STUDIO_PLAYTEST_MCP_TOOLS)(
    'rejects a duplicate %s advertisement for playtest controllers',
    (duplicate) => {
      const tools = playtestTools();
      const original = tools.find((tool) => tool.name === duplicate)!;
      expectPlaytestCapabilityFailure(tools.concat(structuredClone(original)), duplicate);
    },
  );

  it.each([
    {
      name: 'list_roblox_studios',
      schema: { type: 'object', properties: {}, required: ['unexpected'] },
    },
    {
      name: 'set_active_studio',
      schema: {
        type: 'object',
        properties: { studio_id: { type: 'number' } },
        required: ['studio_id'],
      },
    },
    {
      name: 'get_studio_state',
      schema: { type: 'object', properties: {}, required: ['unexpected'] },
    },
    {
      name: 'start_stop_play',
      schema: {
        type: 'object',
        properties: { is_start: { type: 'string' } },
        required: ['is_start'],
      },
    },
    {
      name: 'get_console_output',
      schema: { type: 'object', properties: {}, required: ['unexpected'] },
    },
    {
      name: 'character_navigation',
      schema: {
        type: 'object',
        properties: {
          datamodel_type: { type: 'string', enum: ['Server'] },
          speed_multiplier: { type: 'number' },
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
        },
        required: ['datamodel_type'],
      },
    },
    {
      name: 'screen_capture',
      schema: {
        type: 'object',
        properties: { capture_id: { type: 'number' } },
        required: ['capture_id'],
      },
    },
    {
      name: 'execute_luau',
      schema: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          datamodel_type: { type: 'string', enum: ['Edit'] },
        },
        required: ['code', 'datamodel_type'],
      },
    },
  ])('rejects an incompatible $name schema', ({ name, schema }) => {
    expectPlaytestCapabilityFailure(replaceToolSchema(playtestTools(), name, schema), name);
  });

  it.each([
    ['missing Client data-model support', 'datamodel_type'],
    ['missing world-space x support', 'x'],
    ['missing world-space y support', 'y'],
    ['missing world-space z support', 'z'],
    ['missing fixed speed support', 'speed_multiplier'],
  ] as const)('rejects navigation with %s', (_label, propertyName) => {
    const tools = playtestTools();
    const navigation = tools.find((tool) => tool.name === 'character_navigation')!;
    const schema = structuredClone(navigation.inputSchema) as {
      properties: Record<string, unknown>;
    };
    delete schema.properties[propertyName];
    expectPlaytestCapabilityFailure(
      replaceToolSchema(tools, 'character_navigation', schema as Record<string, unknown>),
      'character_navigation',
    );
  });

  it('rejects navigation schemas that require an instance path or caller-selected speed', () => {
    for (const required of [
      ['datamodel_type', 'instance_path'],
      ['datamodel_type', 'speed_multiplier'],
    ]) {
      const tools = playtestTools();
      const navigation = tools.find((tool) => tool.name === 'character_navigation')!;
      const schema = structuredClone(navigation.inputSchema);
      schema.required = required;
      expectPlaytestCapabilityFailure(
        replaceToolSchema(tools, 'character_navigation', schema),
        'character_navigation',
      );
    }
  });

  it('rejects playtest tools with additional caller-required fields', () => {
    for (const [name, required] of [
      ['set_active_studio', ['studio_id', 'focus_window']],
      ['start_stop_play', ['is_start', 'mode']],
      ['screen_capture', ['capture_id', 'camera_position']],
      ['execute_luau', ['code', 'datamodel_type', 'timeout']],
    ] as const) {
      const tools = playtestTools();
      const tool = tools.find((candidate) => candidate.name === name)!;
      const schema = structuredClone(tool.inputSchema);
      schema.required = [...required];
      expectPlaytestCapabilityFailure(replaceToolSchema(tools, name, schema), name);
    }
  });

  it('rejects a navigation speed schema that excludes the fixed speed one', () => {
    const tools = playtestTools();
    const navigation = tools.find((tool) => tool.name === 'character_navigation')!;
    const schema = structuredClone(navigation.inputSchema) as {
      properties: Record<string, unknown>;
    };
    schema.properties.speed_multiplier = { type: 'number', minimum: 2 };
    expectPlaytestCapabilityFailure(
      replaceToolSchema(tools, 'character_navigation', schema as Record<string, unknown>),
      'character_navigation',
    );
  });

  it('rejects ambiguous or non-Server execute source schemas', () => {
    const cases = [
      {
        type: 'object',
        properties: {
          code: { type: 'string' },
          source: { type: 'string' },
          datamodel_type: { type: 'string', enum: ['Edit', 'Server'] },
        },
        required: ['code', 'source', 'datamodel_type'],
      },
      {
        type: 'object',
        properties: {
          code: { type: 'string' },
          datamodel_type: { type: 'string', enum: ['Server'] },
        },
        required: ['code', 'datamodel_type'],
      },
    ];
    for (const schema of cases) {
      expectPlaytestCapabilityFailure(
        replaceToolSchema(playtestTools(), 'execute_luau', schema),
        'execute_luau',
      );
    }
  });

  it('keeps the existing core discovery and connection compatible without playtest-only tools', async () => {
    expect(discoverStudioMcpCapabilities(coreOnlyTools())).toMatchObject({
      executeLuauSourceField: 'code',
      optional: { screenCapture: false },
    });

    let closes = 0;
    const client = await connectStudioMcpForTesting(() =>
      protocol(coreOnlyTools(), () => {
        closes += 1;
      }),
    );
    expect(client.capabilities).toMatchObject({
      executeLuauSourceField: 'code',
      optional: { screenCapture: false },
    });
    await client.close();
    expect(closes).toBe(1);
  });

  it('fails and closes the privileged connection when playtest-only tools are absent', async () => {
    let closes = 0;
    await expect(
      connectStudioPlaytestMcpForTesting(() =>
        protocol(coreOnlyTools(), () => {
          closes += 1;
        }),
      ),
    ).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({
          code: 'studio.playtest_capability_unavailable',
          path: '/tools/start_stop_play',
        }),
      ],
    });
    expect(closes).toBe(1);
  });

  it('rejects a malformed playtest tools-list value before guessing capabilities', () => {
    expectPlaytestCapabilityFailure(
      [{ name: 'start_stop_play', inputSchema: { type: 'array' } }],
      'tools/list',
    );
  });
});
