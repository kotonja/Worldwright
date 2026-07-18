import { Type } from '@sinclair/typebox';

import {
  STUDIO_MCP_MAX_MANAGED_NODES,
  STUDIO_MCP_PLAYTEST_MAX_MANAGED_BLOCKERS,
  STUDIO_MCP_PLAYTEST_MAX_PATH_WAYPOINTS,
  STUDIO_PLAYTEST_PROBE_PROTOCOL_VERSION,
  STUDIO_PLAYTEST_PROBE_REQUEST_SCHEMA_ID,
  STUDIO_PLAYTEST_PROBE_RESPONSE_SCHEMA_ID,
} from '../constants.js';
import { StudioIdentifierSchema, StudioSha256Schema } from '../contract-schema.js';
import { StudioSandboxLeaseRecordPayloadSchema } from '../sandbox-lease/contract-schema.js';

const JSON_SCHEMA_DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const MAX_COORDINATE = 1_000_000;
const MAX_DISTANCE = 10_000_000;

export const StudioPlaytestVectorSchema = Type.Object(
  {
    x: Type.Number({ minimum: -MAX_COORDINATE, maximum: MAX_COORDINATE }),
    y: Type.Number({ minimum: -MAX_COORDINATE, maximum: MAX_COORDINATE }),
    z: Type.Number({ minimum: -MAX_COORDINATE, maximum: MAX_COORDINATE }),
  },
  { additionalProperties: false },
);

export const StudioPlaytestAgentSchema = Type.Object(
  {
    radius: Type.Literal(2),
    height: Type.Literal(5),
    canJump: Type.Literal(false),
    canClimb: Type.Literal(false),
    waypointSpacing: Type.Literal(4),
    arrivalHorizontalTolerance: Type.Literal(4),
    arrivalVerticalTolerance: Type.Literal(5),
    maximumHorizontalSpeed: Type.Literal(32),
    maximumFallBelowFloor: Type.Literal(12),
    rootHeightAboveFinishedFloor: Type.Literal(3),
  },
  { additionalProperties: false },
);

export const StudioPlaytestFloorSchema = Type.Object(
  {
    floorId: StudioIdentifierSchema,
    level: Type.Integer({ minimum: -128, maximum: 128 }),
    finishedFloorElevation: Type.Number({ minimum: -MAX_COORDINATE, maximum: MAX_COORDINATE }),
  },
  { additionalProperties: false },
);

export const StudioPlaytestIdentitySchema = Type.Object(
  {
    projectId: StudioIdentifierSchema,
    rootNodeId: StudioIdentifierSchema,
    manifestSourceWorldSpecSha256: StudioSha256Schema,
    expectedManagedNodeCount: Type.Integer({ minimum: 1, maximum: STUDIO_MCP_MAX_MANAGED_NODES }),
    sandboxLease: StudioSandboxLeaseRecordPayloadSchema,
    playtestPlanSha256: StudioSha256Schema,
  },
  { additionalProperties: false },
);

const requestBase = {
  protocolVersion: Type.Literal(STUDIO_PLAYTEST_PROBE_PROTOCOL_VERSION),
  identity: StudioPlaytestIdentitySchema,
} as const;

export const StudioPlaytestIdentityProbeRequestSchema = Type.Object(
  { ...requestBase, action: Type.Literal('identity_probe') },
  { additionalProperties: false },
);

export const StudioPlaytestCharacterSetupRequestSchema = Type.Object(
  {
    ...requestBase,
    action: Type.Literal('character_setup'),
    setupPosition: StudioPlaytestVectorSchema,
  },
  { additionalProperties: false },
);

export const StudioPlaytestPlayerStateRequestSchema = Type.Object(
  {
    ...requestBase,
    action: Type.Literal('player_state'),
    floors: Type.Array(StudioPlaytestFloorSchema, { minItems: 1, maxItems: 8 }),
    agent: StudioPlaytestAgentSchema,
  },
  { additionalProperties: false },
);

export const StudioPlaytestPathProbeRequestSchema = Type.Object(
  {
    ...requestBase,
    action: Type.Literal('path_probe'),
    fromCheckpointId: StudioIdentifierSchema,
    targetCheckpointId: StudioIdentifierSchema,
    fromWorldPosition: StudioPlaytestVectorSchema,
    targetWorldPosition: StudioPlaytestVectorSchema,
    agent: StudioPlaytestAgentSchema,
    maximumRetainedWaypoints: Type.Integer({
      minimum: 1,
      maximum: STUDIO_MCP_PLAYTEST_MAX_PATH_WAYPOINTS,
    }),
  },
  { additionalProperties: false },
);

export const StudioPlaytestClearanceProbeRequestSchema = Type.Object(
  {
    ...requestBase,
    action: Type.Literal('clearance_probe'),
    checkpointId: StudioIdentifierSchema,
    expectedFinishedFloorElevation: Type.Number({
      minimum: -MAX_COORDINATE,
      maximum: MAX_COORDINATE,
    }),
    agent: StudioPlaytestAgentSchema,
  },
  { additionalProperties: false },
);

export const StudioPlaytestProbeRequestSchema = Type.Union(
  [
    StudioPlaytestIdentityProbeRequestSchema,
    StudioPlaytestCharacterSetupRequestSchema,
    StudioPlaytestPlayerStateRequestSchema,
    StudioPlaytestPathProbeRequestSchema,
    StudioPlaytestClearanceProbeRequestSchema,
  ],
  {
    $id: STUDIO_PLAYTEST_PROBE_REQUEST_SCHEMA_ID,
    $schema: JSON_SCHEMA_DRAFT_2020_12,
  },
);

const responseBase = {
  protocolVersion: Type.Literal(STUDIO_PLAYTEST_PROBE_PROTOCOL_VERSION),
  ok: Type.Literal(true),
} as const;

export const StudioPlaytestIdentityProbeSuccessSchema = Type.Object(
  {
    ...responseBase,
    action: Type.Literal('identity_probe'),
    projectIdentityMatched: Type.Literal(true),
    rootIdentityMatched: Type.Literal(true),
    managedNodeCount: Type.Integer({ minimum: 1, maximum: STUDIO_MCP_MAX_MANAGED_NODES }),
    playerCount: Type.Integer({ minimum: 0, maximum: 16 }),
    characterReady: Type.Boolean(),
    dataModelType: Type.Literal('Server'),
    playRunning: Type.Literal(true),
  },
  { additionalProperties: false },
);

export const StudioPlaytestCharacterSetupSuccessSchema = Type.Object(
  {
    ...responseBase,
    action: Type.Literal('character_setup'),
    position: StudioPlaytestVectorSchema,
    linearVelocityMagnitude: Type.Number({ minimum: 0, maximum: MAX_DISTANCE }),
    angularVelocityMagnitude: Type.Number({ minimum: 0, maximum: MAX_DISTANCE }),
  },
  { additionalProperties: false },
);

const enumName = Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9]*$' });

export const StudioPlaytestPlayerStateSuccessSchema = Type.Object(
  {
    ...responseBase,
    action: Type.Literal('player_state'),
    position: StudioPlaytestVectorSchema,
    linearVelocityMagnitude: Type.Number({ minimum: 0, maximum: MAX_DISTANCE }),
    health: Type.Number({ minimum: 0, maximum: MAX_DISTANCE }),
    maximumHealth: Type.Number({ minimum: 0, maximum: MAX_DISTANCE }),
    humanoidState: enumName,
    floorMaterial: enumName,
    hasHumanoidRootPart: Type.Literal(true),
    alive: Type.Boolean(),
    supported: Type.Boolean(),
    supportDistance: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_DISTANCE })),
    managedSupportEntityId: Type.Optional(StudioIdentifierSchema),
    currentLevel: Type.Optional(Type.Integer({ minimum: -128, maximum: 128 })),
    currentFloorId: Type.Optional(StudioIdentifierSchema),
  },
  { additionalProperties: false },
);

export const StudioPlaytestPathStatusSchema = Type.Union([
  Type.Literal('success'),
  Type.Literal('no_path'),
  Type.Literal('computation_failed'),
  Type.Literal('waypoint_limit_exceeded'),
  Type.Literal('jump_required'),
]);

export const StudioPlaytestPathProbeSuccessSchema = Type.Object(
  {
    ...responseBase,
    action: Type.Literal('path_probe'),
    status: StudioPlaytestPathStatusSchema,
    waypointCount: Type.Integer({ minimum: 0, maximum: STUDIO_MCP_PLAYTEST_MAX_PATH_WAYPOINTS }),
    waypoints: Type.Array(StudioPlaytestVectorSchema, {
      maxItems: STUDIO_MCP_PLAYTEST_MAX_PATH_WAYPOINTS,
    }),
    totalPathDistance: Type.Number({ minimum: 0, maximum: MAX_DISTANCE }),
    requiresJump: Type.Boolean(),
    jumpWaypointCount: Type.Integer({
      minimum: 0,
      maximum: STUDIO_MCP_PLAYTEST_MAX_PATH_WAYPOINTS,
    }),
    fromCheckpointId: StudioIdentifierSchema,
    targetCheckpointId: StudioIdentifierSchema,
  },
  { additionalProperties: false },
);

export const StudioPlaytestClearanceProbeSuccessSchema = Type.Object(
  {
    ...responseBase,
    action: Type.Literal('clearance_probe'),
    checkpointId: StudioIdentifierSchema,
    supported: Type.Boolean(),
    supportDistance: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_DISTANCE })),
    managedSupportEntityId: Type.Optional(StudioIdentifierSchema),
    bodyClear: Type.Boolean(),
    headClear: Type.Boolean(),
    unmanagedBlockerCount: Type.Integer({
      minimum: 0,
      maximum: STUDIO_MCP_PLAYTEST_MAX_MANAGED_BLOCKERS,
    }),
    managedBlockerIds: Type.Array(StudioIdentifierSchema, {
      maxItems: STUDIO_MCP_PLAYTEST_MAX_MANAGED_BLOCKERS,
    }),
  },
  { additionalProperties: false },
);

export const StudioPlaytestProbeFailureSchema = Type.Object(
  {
    protocolVersion: Type.Literal(STUDIO_PLAYTEST_PROBE_PROTOCOL_VERSION),
    action: Type.Union([
      Type.Literal('identity_probe'),
      Type.Literal('character_setup'),
      Type.Literal('player_state'),
      Type.Literal('path_probe'),
      Type.Literal('clearance_probe'),
    ]),
    ok: Type.Literal(false),
    diagnostic: Type.Object(
      {
        code: Type.Union([
          Type.Literal('studio.playtest_probe_invalid'),
          Type.Literal('studio.playtest_identity_mismatch'),
          Type.Literal('studio.playtest_character_unavailable'),
          Type.Literal('studio.playtest_path_failed'),
          Type.Literal('studio.playtest_clearance_failed'),
          Type.Literal('studio.published_place_forbidden'),
          Type.Literal('studio.node_limit_exceeded'),
        ]),
        message: Type.String({ minLength: 1, maxLength: 256 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const StudioPlaytestProbeResponseSchema = Type.Union(
  [
    StudioPlaytestIdentityProbeSuccessSchema,
    StudioPlaytestCharacterSetupSuccessSchema,
    StudioPlaytestPlayerStateSuccessSchema,
    StudioPlaytestPathProbeSuccessSchema,
    StudioPlaytestClearanceProbeSuccessSchema,
    StudioPlaytestProbeFailureSchema,
  ],
  {
    $id: STUDIO_PLAYTEST_PROBE_RESPONSE_SCHEMA_ID,
    $schema: JSON_SCHEMA_DRAFT_2020_12,
  },
);

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

deepFreeze(StudioPlaytestProbeRequestSchema);
deepFreeze(StudioPlaytestProbeResponseSchema);
