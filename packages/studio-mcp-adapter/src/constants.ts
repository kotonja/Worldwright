export const STUDIO_MCP_PACKAGE_VERSION = '0.3.0' as const;
export const STUDIO_STORED_METADATA_VERSION = '0.1.0' as const;
/** Backward-compatible alias for the persisted Milestone 3 node-metadata version. */
export const STUDIO_MCP_ADAPTER_VERSION = STUDIO_STORED_METADATA_VERSION;
export const STUDIO_BRIDGE_PROTOCOL_VERSION = '0.1.0' as const;
export const STUDIO_APPLY_RECEIPT_VERSION = '0.1.0' as const;
export const STUDIO_BATCH_PROTOCOL_VERSION = '0.1.0' as const;
export const STUDIO_PROGRESS_REPORT_VERSION = '0.1.0' as const;
export const STUDIO_TRANSPORT_REPORT_VERSION = '0.1.0' as const;
export const STUDIO_SANDBOX_LEASE_PROTOCOL_VERSION = '0.1.0' as const;
export const STUDIO_SANDBOX_LEASE_RECORD_VERSION = '0.1.0' as const;
export const STUDIO_PLAYTEST_PROBE_PROTOCOL_VERSION = '0.1.0' as const;

export const STUDIO_BRIDGE_REQUEST_SCHEMA_ID =
  'urn:worldwright:studio-bridge-request:0.1.0' as const;
export const STUDIO_BRIDGE_RESPONSE_SCHEMA_ID =
  'urn:worldwright:studio-bridge-response:0.1.0' as const;
export const STUDIO_APPLY_RECEIPT_SCHEMA_ID = 'urn:worldwright:studio-apply-receipt:0.1.0' as const;
export const STUDIO_BATCH_REQUEST_SCHEMA_ID = 'urn:worldwright:studio-batch-request:0.1.0' as const;
export const STUDIO_BATCH_RESPONSE_SCHEMA_ID =
  'urn:worldwright:studio-batch-response:0.1.0' as const;
export const STUDIO_PROGRESS_REPORT_SCHEMA_ID =
  'urn:worldwright:studio-progress-report:0.1.0' as const;
export const STUDIO_TRANSPORT_REPORT_SCHEMA_ID =
  'urn:worldwright:studio-transport-report:0.1.0' as const;
export const STUDIO_SANDBOX_LEASE_RECORD_SCHEMA_ID =
  'urn:worldwright:studio-sandbox-lease-record:0.1.0' as const;
export const STUDIO_SANDBOX_LEASE_REQUEST_SCHEMA_ID =
  'urn:worldwright:studio-sandbox-lease-request:0.1.0' as const;
export const STUDIO_SANDBOX_LEASE_RESPONSE_SCHEMA_ID =
  'urn:worldwright:studio-sandbox-lease-response:0.1.0' as const;
export const STUDIO_PLAYTEST_PROBE_REQUEST_SCHEMA_ID =
  'urn:worldwright:studio-playtest-probe-request:0.1.0' as const;
export const STUDIO_PLAYTEST_PROBE_RESPONSE_SCHEMA_ID =
  'urn:worldwright:studio-playtest-probe-response:0.1.0' as const;

export const STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS = 512;
export const STUDIO_MCP_MAX_BATCH_OPERATIONS = 32;
export const STUDIO_MCP_MAX_BATCH_PAYLOAD_BYTES = 3 * 1024 * 1024;
export const STUDIO_MCP_MAX_RECONNECTS_PER_TRANSACTION = 2;
export const STUDIO_MCP_MAX_MANAGED_NODES = 2048;
export const STUDIO_MCP_MAX_WORKSPACE_SCAN_INSTANCES = 65_536;
export const STUDIO_MCP_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const STUDIO_MCP_MAX_RESULT_BYTES = 16 * 1024 * 1024;
export const STUDIO_MCP_MAX_BRIDGE_TEXT_BYTES = 96 * 1024;
export const STUDIO_MCP_MAX_NODE_STATE_BYTES = 256 * 1024;
export const STUDIO_MCP_MAX_SANDBOX_LEASE_BYTES = 1024;
export const STUDIO_MCP_MAX_INSTANCE_NAME_CODE_POINTS = 100;
export const STUDIO_MCP_MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
export const STUDIO_MCP_VIEWPORT_MEDIA_TYPE = 'image/jpeg' as const;
export const STUDIO_MCP_MAX_RECEIPT_DIAGNOSTICS = 2 * STUDIO_MCP_MAX_MANAGED_NODES + 3;
export const STUDIO_MCP_ENGINE_EPSILON = 0.00001;
export const STUDIO_MCP_STARTUP_TIMEOUT_MS = 15_000;
export const STUDIO_MCP_TOOL_TIMEOUT_MS = 30_000;
export const STUDIO_MCP_BATCH_TOOL_TIMEOUT_MS = 45_000;
export const STUDIO_MCP_CLOSE_TIMEOUT_MS = 7_000;
export const STUDIO_MCP_SESSION_DISCOVERY_TIMEOUT_MS = 6_000;
export const STUDIO_MCP_PLAYTEST_START_TIMEOUT_MS = 30_000;
export const STUDIO_MCP_PLAYTEST_NAVIGATION_TIMEOUT_MS = 45_000;
export const STUDIO_MCP_PLAYTEST_STOP_TIMEOUT_MS = 30_000;
export const STUDIO_MCP_PLAYTEST_STATE_TRANSITION_TIMEOUT_MS = 60_000;
export const STUDIO_MCP_PLAYTEST_CHARACTER_TIMEOUT_MS = 60_000;
export const STUDIO_MCP_PLAYTEST_SEGMENT_TIMEOUT_MS = 45_000;
export const STUDIO_MCP_PLAYTEST_TOTAL_TIMEOUT_MS = 900_000;
export const STUDIO_MCP_PLAYTEST_POLL_INTERVAL_MS = 250;
export const STUDIO_MCP_PLAYTEST_MAX_PATH_WAYPOINTS = 128;
export const STUDIO_MCP_PLAYTEST_MAX_SEGMENTS = 256;
export const STUDIO_MCP_PLAYTEST_MAX_CONSOLE_ENTRIES = 512;
export const STUDIO_MCP_PLAYTEST_MAX_CONSOLE_MESSAGE_BYTES = 16 * 1024;
export const STUDIO_MCP_PLAYTEST_MAX_CONSOLE_TOTAL_BYTES = 1024 * 1024;
export const STUDIO_MCP_PLAYTEST_MAX_MANAGED_BLOCKERS = 64;

export const STUDIO_BRIDGE_RESPONSE_PREFIX = 'WORLDWRIGHT_STUDIO_BRIDGE_V1\n' as const;
export const STUDIO_BATCH_RESPONSE_PREFIX = 'WORLDWRIGHT_STUDIO_BATCH_V1\n' as const;
export const STUDIO_SANDBOX_LEASE_RESPONSE_PREFIX =
  'WORLDWRIGHT_STUDIO_SANDBOX_LEASE_V1\n' as const;
export const STUDIO_PLAYTEST_PROBE_RESPONSE_PREFIX =
  'WORLDWRIGHT_STUDIO_PLAYTEST_PROBE_V1\n' as const;

export const STUDIO_PLAYTEST_PROBE_ACTIONS = [
  'identity_probe',
  'character_setup',
  'player_state',
  'path_probe',
  'clearance_probe',
] as const;

/** The sole adapter-owned Workspace attribute; it is not managed-node metadata. */
export const STUDIO_SANDBOX_LEASE_ATTRIBUTE_NAME = 'WorldwrightStudioSandboxLeaseJson' as const;

export const STUDIO_ADAPTER_ATTRIBUTE_NAMES = [
  'WorldwrightStudioAdapterVersion',
  'WorldwrightStudioStateJson',
  'WorldwrightStudioStateHash',
] as const;

export const STUDIO_BRIDGE_ACTIONS = ['probe', 'snapshot', 'create', 'update', 'delete'] as const;

export type StudioBridgeAction = (typeof STUDIO_BRIDGE_ACTIONS)[number];
