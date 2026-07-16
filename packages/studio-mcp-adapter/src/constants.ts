export const STUDIO_MCP_ADAPTER_VERSION = '0.1.0' as const;
export const STUDIO_BRIDGE_PROTOCOL_VERSION = '0.1.0' as const;
export const STUDIO_APPLY_RECEIPT_VERSION = '0.1.0' as const;

export const STUDIO_BRIDGE_REQUEST_SCHEMA_ID =
  'urn:worldwright:studio-bridge-request:0.1.0' as const;
export const STUDIO_BRIDGE_RESPONSE_SCHEMA_ID =
  'urn:worldwright:studio-bridge-response:0.1.0' as const;
export const STUDIO_APPLY_RECEIPT_SCHEMA_ID = 'urn:worldwright:studio-apply-receipt:0.1.0' as const;

export const STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS = 512;
export const STUDIO_MCP_MAX_MANAGED_NODES = 2048;
export const STUDIO_MCP_MAX_WORKSPACE_SCAN_INSTANCES = 65_536;
export const STUDIO_MCP_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const STUDIO_MCP_MAX_RESULT_BYTES = 16 * 1024 * 1024;
export const STUDIO_MCP_MAX_BRIDGE_TEXT_BYTES = 96 * 1024;
export const STUDIO_MCP_MAX_NODE_STATE_BYTES = 256 * 1024;
export const STUDIO_MCP_MAX_INSTANCE_NAME_CODE_POINTS = 100;
export const STUDIO_MCP_MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
export const STUDIO_MCP_VIEWPORT_MEDIA_TYPE = 'image/jpeg' as const;
export const STUDIO_MCP_MAX_RECEIPT_DIAGNOSTICS = 2 * STUDIO_MCP_MAX_MANAGED_NODES + 3;
export const STUDIO_MCP_ENGINE_EPSILON = 0.00001;
export const STUDIO_MCP_STARTUP_TIMEOUT_MS = 15_000;
export const STUDIO_MCP_TOOL_TIMEOUT_MS = 30_000;
export const STUDIO_MCP_CLOSE_TIMEOUT_MS = 7_000;
export const STUDIO_MCP_SESSION_DISCOVERY_TIMEOUT_MS = 6_000;

export const STUDIO_BRIDGE_RESPONSE_PREFIX = 'WORLDWRIGHT_STUDIO_BRIDGE_V1\n' as const;

export const STUDIO_ADAPTER_ATTRIBUTE_NAMES = [
  'WorldwrightStudioAdapterVersion',
  'WorldwrightStudioStateJson',
  'WorldwrightStudioStateHash',
] as const;

export const STUDIO_BRIDGE_ACTIONS = ['probe', 'snapshot', 'create', 'update', 'delete'] as const;

export type StudioBridgeAction = (typeof STUDIO_BRIDGE_ACTIONS)[number];
