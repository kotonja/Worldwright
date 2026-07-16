import { describe, expect, it } from 'vitest';

import { discoverStudioMcpCapabilities } from '../src/mcp/capabilities.js';

function validTools(sourceField: 'code' | 'source' = 'code'): unknown[] {
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
          [sourceField]: { type: 'string' },
          datamodel_type: { type: 'string', enum: ['Edit', 'Client', 'Server'] },
        },
        required: [sourceField, 'datamodel_type'],
      },
    },
    {
      name: 'screen_capture',
      inputSchema: {
        type: 'object',
        properties: { capture_id: { type: 'string' } },
        required: ['capture_id'],
      },
    },
  ];
}

describe('Studio MCP capability discovery', () => {
  it('validates the required schemas and records optional presence', () => {
    expect(discoverStudioMcpCapabilities(validTools())).toEqual({
      executeLuauSourceField: 'code',
      optional: {
        searchGameTree: false,
        inspectInstance: false,
        screenCapture: true,
      },
    });
    expect(discoverStudioMcpCapabilities(validTools('source')).executeLuauSourceField).toBe(
      'source',
    );
  });

  it('fails safely when a required tool is absent', () => {
    const tools = validTools().filter(
      (entry) => (entry as Readonly<{ name?: unknown }>).name !== 'set_active_studio',
    );
    expect(() => discoverStudioMcpCapabilities(tools)).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.tool_missing' })],
      }),
    );
  });

  it('rejects an advertised but incompatible viewport evidence tool', () => {
    const tools = structuredClone(validTools()) as Array<{
      name: string;
      inputSchema: Record<string, unknown>;
    }>;
    tools.find((tool) => tool.name === 'screen_capture')!.inputSchema = {
      type: 'object',
      properties: { renamed_capture_id: { type: 'string' } },
      required: ['renamed_capture_id'],
      additionalProperties: false,
    };
    expect(() => discoverStudioMcpCapabilities(tools)).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.tool_schema_unsupported' })],
      }),
    );
  });

  it('rejects incompatible execute_luau schemas instead of guessing arguments', () => {
    const missingEdit = structuredClone(validTools()) as Array<{
      name: string;
      inputSchema: { properties?: Record<string, unknown> };
    }>;
    const execute = missingEdit.find((tool) => tool.name === 'execute_luau')!;
    execute.inputSchema.properties!.datamodel_type = { type: 'string', enum: ['Client', 'Server'] };

    expect(() => discoverStudioMcpCapabilities(missingEdit)).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.tool_schema_unsupported' })],
      }),
    );

    const ambiguousSource = structuredClone(validTools()) as Array<{
      name: string;
      inputSchema: { properties?: Record<string, unknown>; required?: string[] };
    }>;
    const ambiguousExecute = ambiguousSource.find((tool) => tool.name === 'execute_luau')!;
    ambiguousExecute.inputSchema.properties!.source = { type: 'string' };
    ambiguousExecute.inputSchema.required!.push('source');
    expect(() => discoverStudioMcpCapabilities(ambiguousSource)).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.tool_schema_unsupported' })],
      }),
    );

    for (const constrainedSchema of [
      { type: 'string', pattern: '^Play$' },
      { type: 'string', maxLength: 1 },
    ]) {
      const constrained = structuredClone(validTools()) as Array<{
        name: string;
        inputSchema: { properties?: Record<string, unknown> };
      }>;
      const constrainedExecute = constrained.find((tool) => tool.name === 'execute_luau')!;
      constrainedExecute.inputSchema.properties!.datamodel_type = constrainedSchema;
      expect(() => discoverStudioMcpCapabilities(constrained)).toThrowError(
        expect.objectContaining({
          diagnostics: [expect.objectContaining({ code: 'studio.tool_schema_unsupported' })],
        }),
      );
    }

    const constrainedSource = structuredClone(validTools()) as Array<{
      name: string;
      inputSchema: { properties?: Record<string, unknown> };
    }>;
    constrainedSource.find((tool) => tool.name === 'execute_luau')!.inputSchema.properties!.code = {
      type: 'string',
      maxLength: 1,
    };
    expect(() => discoverStudioMcpCapabilities(constrainedSource)).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.tool_schema_unsupported' })],
      }),
    );

    for (const name of [
      'list_roblox_studios',
      'set_active_studio',
      'get_studio_state',
      'execute_luau',
    ]) {
      const extraRequired = structuredClone(validTools()) as Array<{
        name: string;
        inputSchema: { properties?: Record<string, unknown>; required?: string[] };
      }>;
      const tool = extraRequired.find((entry) => entry.name === name)!;
      tool.inputSchema.properties!.nonce = { type: 'string' };
      tool.inputSchema.required ??= [];
      tool.inputSchema.required.push('nonce');
      expect(() => discoverStudioMcpCapabilities(extraRequired)).toThrowError(
        expect.objectContaining({
          diagnostics: [expect.objectContaining({ code: 'studio.tool_schema_unsupported' })],
        }),
      );
    }

    for (const constraint of [
      { minProperties: 1 },
      { not: {} },
      { allOf: [{ type: 'object' }] },
      { if: { type: 'object' }, then: false },
      { dependentRequired: { studio_id: ['nonce'] } },
      { propertyNames: { const: 'impossible' } },
    ]) {
      const constrainedRoot = structuredClone(validTools()) as Array<{
        name: string;
        inputSchema: Record<string, unknown>;
      }>;
      Object.assign(constrainedRoot[0]!.inputSchema, constraint);
      expect(() => discoverStudioMcpCapabilities(constrainedRoot)).toThrowError(
        expect.objectContaining({
          diagnostics: [expect.objectContaining({ code: 'studio.tool_schema_unsupported' })],
        }),
      );
    }

    const deeplyNested = structuredClone(validTools()) as Array<{
      name: string;
      inputSchema: Record<string, unknown>;
    }>;
    let nested: Record<string, unknown> = {};
    deeplyNested[0]!.inputSchema.description = nested;
    for (let depth = 0; depth < 40; depth += 1) {
      const next: Record<string, unknown> = {};
      nested.next = next;
      nested = next;
    }
    expect(() => discoverStudioMcpCapabilities(deeplyNested)).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'studio.mcp_handshake_failed' })],
      }),
    );
  });
});
