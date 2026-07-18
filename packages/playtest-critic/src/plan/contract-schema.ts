import { Type, type Static } from '@sinclair/typebox';
import {
  ARCHITECTURE_PLAN_VERSION,
  ARCHITECTURE_PLANNER_VERSION,
} from '@worldwright/architecture-planner';
import { ROBLOX_COMPILER_VERSION, ROBLOX_MANIFEST_VERSION } from '@worldwright/roblox-compiler';

import {
  JSON_SCHEMA_DRAFT_2020_12,
  PLAYTEST_CRITIC_VERSION,
  PLAYTEST_IDENTIFIER_PATTERN,
  PLAYTEST_LIMITS,
  PLAYTEST_MAX_IDENTIFIER_LENGTH,
  PLAYTEST_PLAN_SCHEMA_ID,
  PLAYTEST_PLAN_VERSION,
  SHA_256_PATTERN,
} from '../constants.js';
import { deepFreeze } from '../json.js';

export const PlaytestIdentifierSchema = Type.String({
  maxLength: PLAYTEST_MAX_IDENTIFIER_LENGTH,
  pattern: PLAYTEST_IDENTIFIER_PATTERN,
});
export const PlaytestSha256Schema = Type.String({ pattern: SHA_256_PATTERN });
export const PlaytestVector3Schema = Type.Object(
  { x: Type.Number(), y: Type.Number(), z: Type.Number() },
  { additionalProperties: false },
);

export const PlaytestPlanSourceSchema = Type.Object(
  {
    architecturePlanSchemaVersion: Type.Literal(ARCHITECTURE_PLAN_VERSION),
    architecturePlannerVersion: Type.Literal(ARCHITECTURE_PLANNER_VERSION),
    architecturePlanSha256: PlaytestSha256Schema,
    sourceWorldSpecSha256: PlaytestSha256Schema,
    projectId: PlaytestIdentifierSchema,
    buildingEntityId: PlaytestIdentifierSchema,
    robloxManifestSchemaVersion: Type.Literal(ROBLOX_MANIFEST_VERSION),
    robloxCompilerVersion: Type.Literal(ROBLOX_COMPILER_VERSION),
    robloxManifestSha256: PlaytestSha256Schema,
    manifestSourceWorldSpecSha256: PlaytestSha256Schema,
    manifestRootNodeId: PlaytestIdentifierSchema,
    expectedManagedInstanceCount: Type.Integer({ minimum: 1, maximum: 4096 }),
  },
  { additionalProperties: false },
);

export const PlaytestAgentSchema = Type.Object(
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

export const PlaytestSetupSchema = Type.Object(
  {
    checkpointId: PlaytestIdentifierSchema,
    worldPosition: PlaytestVector3Schema,
    expectedLevel: Type.Integer({ minimum: 0, maximum: 2 }),
    sourceFloorId: PlaytestIdentifierSchema,
    expectedFinishedFloorElevation: Type.Number(),
    exteriorEntranceOpeningId: PlaytestIdentifierSchema,
    entranceRoomId: PlaytestIdentifierSchema,
    excludedFromScoring: Type.Literal(true),
  },
  { additionalProperties: false },
);

const checkpointCommon = {
  id: PlaytestIdentifierSchema,
  sourceSemanticId: PlaytestIdentifierSchema,
  sourceFloorId: PlaytestIdentifierSchema,
  level: Type.Integer({ minimum: 0, maximum: 2 }),
  localPosition: PlaytestVector3Schema,
  worldPosition: PlaytestVector3Schema,
  expectedFinishedFloorElevation: Type.Number(),
  required: Type.Boolean(),
} as const;

export const ExteriorEntranceCheckpointSchema = Type.Object(
  {
    ...checkpointCommon,
    type: Type.Literal('exterior_entrance'),
    openingId: PlaytestIdentifierSchema,
    circulationNodeId: PlaytestIdentifierSchema,
    roomId: PlaytestIdentifierSchema,
  },
  { additionalProperties: false },
);

export const RoomOpeningThresholdCheckpointSchema = Type.Object(
  {
    ...checkpointCommon,
    type: Type.Literal('opening_threshold'),
    openingId: PlaytestIdentifierSchema,
    circulationNodeId: PlaytestIdentifierSchema,
    roomId: PlaytestIdentifierSchema,
  },
  { additionalProperties: false },
);

export const RoomCenterCheckpointSchema = Type.Object(
  { ...checkpointCommon, type: Type.Literal('room_center'), roomId: PlaytestIdentifierSchema },
  { additionalProperties: false },
);

export const CorridorCheckpointSchema = Type.Object(
  {
    ...checkpointCommon,
    type: Type.Literal('corridor'),
    corridorId: PlaytestIdentifierSchema,
    circulationNodeId: PlaytestIdentifierSchema,
    openingId: Type.Optional(PlaytestIdentifierSchema),
  },
  { additionalProperties: false },
);

export const StairHallCheckpointSchema = Type.Object(
  {
    ...checkpointCommon,
    type: Type.Literal('stair_hall'),
    circulationNodeId: PlaytestIdentifierSchema,
    stairRunId: PlaytestIdentifierSchema,
    openingId: PlaytestIdentifierSchema,
  },
  { additionalProperties: false },
);

export const StairLandingCheckpointSchema = Type.Object(
  {
    ...checkpointCommon,
    type: Type.Literal('stair_landing'),
    circulationNodeId: PlaytestIdentifierSchema,
    stairRunId: PlaytestIdentifierSchema,
    landing: Type.Union([Type.Literal('lower'), Type.Literal('upper')]),
  },
  { additionalProperties: false },
);

export const PlaytestCheckpointSchema = Type.Union([
  ExteriorEntranceCheckpointSchema,
  RoomOpeningThresholdCheckpointSchema,
  RoomCenterCheckpointSchema,
  CorridorCheckpointSchema,
  StairHallCheckpointSchema,
  StairLandingCheckpointSchema,
]);

export const PlaytestSegmentSchema = Type.Object(
  {
    id: PlaytestIdentifierSchema,
    sequence: Type.Integer({ minimum: 0, maximum: PLAYTEST_LIMITS.maximumRouteSegments - 1 }),
    fromCheckpointId: PlaytestIdentifierSchema,
    toCheckpointId: PlaytestIdentifierSchema,
    sourceCirculationEdgeId: PlaytestIdentifierSchema,
    traversal: Type.Union([
      Type.Literal('door'),
      Type.Literal('open'),
      Type.Literal('corridor'),
      Type.Literal('stair'),
    ]),
    expectedFromLevel: Type.Integer({ minimum: 0, maximum: 2 }),
    expectedToLevel: Type.Integer({ minimum: 0, maximum: 2 }),
    maximumNavigationAttempts: Type.Literal(1),
    pathfindingRequired: Type.Literal(true),
    independentArrivalVerificationRequired: Type.Literal(true),
    clearanceVerificationRequired: Type.Literal(true),
  },
  { additionalProperties: false },
);

const coverageDimension = Type.Object(
  {
    ids: Type.Array(PlaytestIdentifierSchema, { uniqueItems: true }),
    count: Type.Integer({ minimum: 0, maximum: 4096 }),
  },
  { additionalProperties: false },
);

export const PlaytestRequiredCoverageSchema = Type.Object(
  {
    rooms: coverageDimension,
    floors: coverageDimension,
    corridors: coverageDimension,
    stairRuns: coverageDimension,
    openings: coverageDimension,
    checkpoints: coverageDimension,
    segments: coverageDimension,
  },
  { additionalProperties: false },
);

export const PlaytestLimitsSchema = Type.Object(
  {
    maximumCheckpoints: Type.Literal(128),
    maximumRouteSegments: Type.Literal(256),
    maximumCaptures: Type.Literal(8),
    maximumPathWaypointsRetainedPerSegment: Type.Literal(128),
    maximumConsoleEvidenceEntries: Type.Literal(512),
    maximumSanitizedConsoleSummaryEntries: Type.Literal(64),
    maximumNavigationWaitMillisecondsPerSegment: Type.Literal(45_000),
    maximumTotalPlaytestWaitMilliseconds: Type.Literal(900_000),
    maximumCharacterLoadWaitMilliseconds: Type.Literal(60_000),
    maximumStartStopTransitionWaitMilliseconds: Type.Literal(60_000),
  },
  { additionalProperties: false },
);

export const PlaytestPlanSchema = Type.Object(
  {
    schemaVersion: Type.Literal(PLAYTEST_PLAN_VERSION),
    criticVersion: Type.Literal(PLAYTEST_CRITIC_VERSION),
    source: PlaytestPlanSourceSchema,
    agent: PlaytestAgentSchema,
    setup: PlaytestSetupSchema,
    checkpoints: Type.Array(PlaytestCheckpointSchema, {
      minItems: 1,
      maxItems: PLAYTEST_LIMITS.maximumCheckpoints,
    }),
    segments: Type.Array(PlaytestSegmentSchema, {
      minItems: 1,
      maxItems: PLAYTEST_LIMITS.maximumRouteSegments,
    }),
    captureCheckpoints: Type.Array(PlaytestIdentifierSchema, {
      maxItems: PLAYTEST_LIMITS.maximumCaptures,
      uniqueItems: true,
    }),
    requiredCoverage: PlaytestRequiredCoverageSchema,
    limits: PlaytestLimitsSchema,
  },
  {
    $id: PLAYTEST_PLAN_SCHEMA_ID,
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    additionalProperties: false,
  },
);

deepFreeze(PlaytestPlanSchema);

export type PlaytestVector3 = Static<typeof PlaytestVector3Schema>;
export type PlaytestPlanSource = Static<typeof PlaytestPlanSourceSchema>;
export type PlaytestAgent = Static<typeof PlaytestAgentSchema>;
export type PlaytestSetup = Static<typeof PlaytestSetupSchema>;
export type PlaytestCheckpoint = Static<typeof PlaytestCheckpointSchema>;
export type PlaytestSegment = Static<typeof PlaytestSegmentSchema>;
export type PlaytestRequiredCoverage = Static<typeof PlaytestRequiredCoverageSchema>;
export type PlaytestPlan = Static<typeof PlaytestPlanSchema>;
