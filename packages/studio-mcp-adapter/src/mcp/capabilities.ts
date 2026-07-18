import { StudioAdapterError, studioDiagnostic } from '../diagnostics.js';
import {
  objectSchemaProperties,
  objectSchemaHasSupportedEnvelope,
  objectSchemaRequires,
  readDiscoveredTools,
  schemaAcceptsExactString,
  schemaAcceptsString,
  type DiscoveredMcpTool,
} from './tool-schema.js';

export const REQUIRED_STUDIO_MCP_TOOLS = [
  'list_roblox_studios',
  'set_active_studio',
  'get_studio_state',
  'execute_luau',
] as const;

export const OPTIONAL_STUDIO_MCP_TOOLS = [
  'search_game_tree',
  'inspect_instance',
  'screen_capture',
] as const;

export type RequiredStudioMcpToolName = (typeof REQUIRED_STUDIO_MCP_TOOLS)[number];
export type OptionalStudioMcpToolName = (typeof OPTIONAL_STUDIO_MCP_TOOLS)[number];
export type PlaytestStudioMcpToolName =
  | 'start_stop_play'
  | 'get_console_output'
  | 'character_navigation';
export type AllowedStudioMcpToolName =
  | RequiredStudioMcpToolName
  | OptionalStudioMcpToolName
  | PlaytestStudioMcpToolName;
export type ExecuteLuauSourceField = 'code' | 'source';

export interface StudioMcpCapabilities {
  readonly executeLuauSourceField: ExecuteLuauSourceField;
  readonly optional: Readonly<{
    searchGameTree: boolean;
    inspectInstance: boolean;
    screenCapture: boolean;
  }>;
}

function capabilityError(
  code: 'studio.mcp_handshake_failed' | 'studio.tool_missing' | 'studio.tool_schema_unsupported',
  tool: string,
  message: string,
): StudioAdapterError {
  return new StudioAdapterError([
    studioDiagnostic(code, `/tools/${tool}`, message, { toolName: tool }),
  ]);
}

function findUniqueTool(
  tools: readonly DiscoveredMcpTool[],
  name: RequiredStudioMcpToolName,
): DiscoveredMcpTool {
  const matches = tools.filter((tool) => tool.name === name);
  if (matches.length === 0) {
    throw capabilityError(
      'studio.tool_missing',
      name,
      `Required Studio tool ${name} is unavailable.`,
    );
  }
  if (matches.length !== 1) {
    throw capabilityError(
      'studio.tool_schema_unsupported',
      name,
      `Required Studio tool ${name} was advertised more than once.`,
    );
  }
  return matches[0]!;
}

function hasExactRequiredFields(tool: DiscoveredMcpTool, expected: ReadonlySet<string>): boolean {
  const required = tool.inputSchema.required;
  if (required === undefined) return expected.size === 0;
  if (!Array.isArray(required) || !required.every((entry) => typeof entry === 'string')) {
    return false;
  }
  const actual = new Set(required);
  return (
    actual.size === required.length &&
    actual.size === expected.size &&
    [...actual].every((entry) => expected.has(entry))
  );
}

function requireNoArguments(tool: DiscoveredMcpTool): void {
  const properties = objectSchemaProperties(tool.inputSchema);
  if (
    !objectSchemaHasSupportedEnvelope(tool.inputSchema) ||
    properties === undefined ||
    !hasExactRequiredFields(tool, new Set())
  ) {
    throw capabilityError(
      'studio.tool_schema_unsupported',
      tool.name,
      `Required Studio tool ${tool.name} has an unsupported input schema.`,
    );
  }
}

function validateSetActiveStudio(tool: DiscoveredMcpTool): void {
  const properties = objectSchemaProperties(tool.inputSchema);
  if (
    !objectSchemaHasSupportedEnvelope(tool.inputSchema) ||
    properties === undefined ||
    !schemaAcceptsString(properties.studio_id) ||
    !objectSchemaRequires(tool.inputSchema, 'studio_id') ||
    !hasExactRequiredFields(tool, new Set(['studio_id']))
  ) {
    throw capabilityError(
      'studio.tool_schema_unsupported',
      tool.name,
      'The set_active_studio tool does not require a string studio_id.',
    );
  }
}

function validateExecuteLuau(tool: DiscoveredMcpTool): ExecuteLuauSourceField {
  const properties = objectSchemaProperties(tool.inputSchema);
  if (!objectSchemaHasSupportedEnvelope(tool.inputSchema) || properties === undefined) {
    throw capabilityError(
      'studio.tool_schema_unsupported',
      tool.name,
      'The execute_luau tool input schema is unsupported.',
    );
  }

  const sourceFields = (['code', 'source'] as const).filter(
    (name) => schemaAcceptsString(properties[name]) && objectSchemaRequires(tool.inputSchema, name),
  );
  if (sourceFields.length !== 1) {
    throw capabilityError(
      'studio.tool_schema_unsupported',
      tool.name,
      'The execute_luau tool must require exactly one supported source field.',
    );
  }
  if (
    !objectSchemaRequires(tool.inputSchema, 'datamodel_type') ||
    !schemaAcceptsExactString(properties.datamodel_type, 'Edit') ||
    !hasExactRequiredFields(tool, new Set([sourceFields[0]!, 'datamodel_type']))
  ) {
    throw capabilityError(
      'studio.tool_schema_unsupported',
      tool.name,
      'The execute_luau tool does not support the required Edit data model.',
    );
  }
  return sourceFields[0]!;
}

function validateScreenCapture(tool: DiscoveredMcpTool): void {
  const properties = objectSchemaProperties(tool.inputSchema);
  if (
    !objectSchemaHasSupportedEnvelope(tool.inputSchema) ||
    properties === undefined ||
    !schemaAcceptsString(properties.capture_id) ||
    !objectSchemaRequires(tool.inputSchema, 'capture_id') ||
    !hasExactRequiredFields(tool, new Set(['capture_id']))
  ) {
    throw capabilityError(
      'studio.tool_schema_unsupported',
      tool.name,
      'The screen_capture tool does not support the required capture_id payload.',
    );
  }
}

/** Validate the live tools/list result and retain only the capability facts Worldwright uses. */
export function discoverStudioMcpCapabilities(toolList: unknown): StudioMcpCapabilities {
  const tools = readDiscoveredTools(toolList);
  if (tools === undefined) {
    throw capabilityError(
      'studio.mcp_handshake_failed',
      'tools/list',
      'Studio returned an invalid tools/list response.',
    );
  }

  const listStudios = findUniqueTool(tools, 'list_roblox_studios');
  const setActiveStudio = findUniqueTool(tools, 'set_active_studio');
  const getStudioState = findUniqueTool(tools, 'get_studio_state');
  const executeLuau = findUniqueTool(tools, 'execute_luau');
  requireNoArguments(listStudios);
  validateSetActiveStudio(setActiveStudio);
  requireNoArguments(getStudioState);
  const executeLuauSourceField = validateExecuteLuau(executeLuau);
  const names = new Set(tools.map((tool) => tool.name));
  const screenCaptureTools = tools.filter((tool) => tool.name === 'screen_capture');
  if (screenCaptureTools.length > 1) {
    throw capabilityError(
      'studio.tool_schema_unsupported',
      'screen_capture',
      'The optional screen_capture tool was advertised more than once.',
    );
  }
  if (screenCaptureTools[0] !== undefined) validateScreenCapture(screenCaptureTools[0]);

  return Object.freeze({
    executeLuauSourceField,
    optional: Object.freeze({
      searchGameTree: names.has('search_game_tree'),
      inspectInstance: names.has('inspect_instance'),
      screenCapture: screenCaptureTools.length === 1,
    }),
  });
}
