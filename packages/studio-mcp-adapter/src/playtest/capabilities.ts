import { StudioAdapterError, studioDiagnostic } from '../diagnostics.js';
import {
  objectSchemaHasSupportedEnvelope,
  objectSchemaProperties,
  objectSchemaRequires,
  readDiscoveredTools,
  schemaAcceptsBoolean,
  schemaAcceptsExactNumber,
  schemaAcceptsExactString,
  schemaAcceptsNumber,
  schemaAcceptsString,
  type DiscoveredMcpTool,
} from '../mcp/tool-schema.js';

export const REQUIRED_STUDIO_PLAYTEST_MCP_TOOLS = [
  'list_roblox_studios',
  'set_active_studio',
  'get_studio_state',
  'start_stop_play',
  'get_console_output',
  'character_navigation',
  'screen_capture',
  'execute_luau',
] as const;

export type StudioPlaytestMcpToolName =
  | 'start_stop_play'
  | 'get_console_output'
  | 'character_navigation';

export interface StudioPlaytestMcpCapabilities {
  readonly executeLuauSourceField: 'code' | 'source';
  readonly navigationSpeedMultiplier: 1;
}

function failure(tool: string, message: string): never {
  throw new StudioAdapterError([
    studioDiagnostic('studio.playtest_capability_unavailable', `/tools/${tool}`, message, {
      toolName: tool,
    }),
  ]);
}

function findUnique(tools: readonly DiscoveredMcpTool[], name: string): DiscoveredMcpTool {
  const matches = tools.filter((tool) => tool.name === name);
  if (matches.length !== 1) {
    return failure(
      name,
      matches.length === 0
        ? `Required Studio playtest tool ${name} is unavailable.`
        : `Required Studio playtest tool ${name} was advertised more than once.`,
    );
  }
  return matches[0]!;
}

function exactRequired(tool: DiscoveredMcpTool, expected: ReadonlySet<string>): boolean {
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

function validEnvelope(tool: DiscoveredMcpTool): Readonly<Record<string, unknown>> {
  const properties = objectSchemaProperties(tool.inputSchema);
  if (!objectSchemaHasSupportedEnvelope(tool.inputSchema) || properties === undefined) {
    return failure(tool.name, `Studio playtest tool ${tool.name} has an unsupported input schema.`);
  }
  return properties;
}

function requireNoArguments(tool: DiscoveredMcpTool): void {
  validEnvelope(tool);
  if (!exactRequired(tool, new Set())) {
    failure(tool.name, `Studio playtest tool ${tool.name} must require no arguments.`);
  }
}

function validateSetActive(tool: DiscoveredMcpTool): void {
  const properties = validEnvelope(tool);
  if (
    !schemaAcceptsString(properties.studio_id) ||
    !objectSchemaRequires(tool.inputSchema, 'studio_id') ||
    !exactRequired(tool, new Set(['studio_id']))
  ) {
    failure(tool.name, 'The Studio playtest session selector schema is incompatible.');
  }
}

function validateStartStop(tool: DiscoveredMcpTool): void {
  const properties = validEnvelope(tool);
  if (
    !schemaAcceptsBoolean(properties.is_start) ||
    !objectSchemaRequires(tool.inputSchema, 'is_start') ||
    !exactRequired(tool, new Set(['is_start']))
  ) {
    failure(tool.name, 'The Studio start/stop schema must require one boolean is_start field.');
  }
}

function validateExecute(tool: DiscoveredMcpTool): 'code' | 'source' {
  const properties = validEnvelope(tool);
  const sourceFields = (['code', 'source'] as const).filter(
    (field) =>
      schemaAcceptsString(properties[field]) && objectSchemaRequires(tool.inputSchema, field),
  );
  if (
    sourceFields.length !== 1 ||
    !objectSchemaRequires(tool.inputSchema, 'datamodel_type') ||
    !schemaAcceptsExactString(properties.datamodel_type, 'Edit') ||
    !schemaAcceptsExactString(properties.datamodel_type, 'Server') ||
    !exactRequired(tool, new Set([sourceFields[0]!, 'datamodel_type']))
  ) {
    return failure(
      tool.name,
      'The Studio playtest Luau schema must require one source field and support Edit and Server.',
    );
  }
  return sourceFields[0]!;
}

function validateCapture(tool: DiscoveredMcpTool): void {
  const properties = validEnvelope(tool);
  if (
    !schemaAcceptsString(properties.capture_id) ||
    !objectSchemaRequires(tool.inputSchema, 'capture_id') ||
    !exactRequired(tool, new Set(['capture_id']))
  ) {
    failure(tool.name, 'The Studio playtest capture schema must require capture_id only.');
  }
}

function validateNavigation(tool: DiscoveredMcpTool): void {
  const properties = validEnvelope(tool);
  if (
    !schemaAcceptsExactString(properties.datamodel_type, 'Client') ||
    !schemaAcceptsNumber(properties.x) ||
    !schemaAcceptsNumber(properties.y) ||
    !schemaAcceptsNumber(properties.z) ||
    !schemaAcceptsExactNumber(properties.speed_multiplier, 1) ||
    !objectSchemaRequires(tool.inputSchema, 'datamodel_type') ||
    !exactRequired(tool, new Set(['datamodel_type']))
  ) {
    failure(
      tool.name,
      'The Studio character navigation schema must support an exact Client world position and fixed speed 1.',
    );
  }
}

/** Validate the separate privileged tool surface required only for playtest controllers. */
export function discoverStudioPlaytestMcpCapabilities(
  toolList: unknown,
): StudioPlaytestMcpCapabilities {
  const tools = readDiscoveredTools(toolList);
  if (tools === undefined) {
    return failure('tools/list', 'Studio returned an invalid playtest tools/list response.');
  }
  requireNoArguments(findUnique(tools, 'list_roblox_studios'));
  validateSetActive(findUnique(tools, 'set_active_studio'));
  requireNoArguments(findUnique(tools, 'get_studio_state'));
  validateStartStop(findUnique(tools, 'start_stop_play'));
  requireNoArguments(findUnique(tools, 'get_console_output'));
  validateNavigation(findUnique(tools, 'character_navigation'));
  validateCapture(findUnique(tools, 'screen_capture'));
  const executeLuauSourceField = validateExecute(findUnique(tools, 'execute_luau'));
  return Object.freeze({ executeLuauSourceField, navigationSpeedMultiplier: 1 as const });
}
