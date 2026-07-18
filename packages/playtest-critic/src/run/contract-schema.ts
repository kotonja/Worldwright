import { Type, type Static } from '@sinclair/typebox';

import {
  JSON_SCHEMA_DRAFT_2020_12,
  PLAYTEST_CRITIC_VERSION,
  PLAYTEST_RUN_REPORT_SCHEMA_ID,
  PLAYTEST_RUN_REPORT_VERSION,
} from '../constants.js';
import { deepFreeze } from '../json.js';
import {
  PlaytestIdentifierSchema,
  PlaytestSha256Schema,
  PlaytestVector3Schema,
} from '../plan/contract-schema.js';

export const PlaytestRunSourceSchema = Type.Object(
  {
    playtestPlanSha256: PlaytestSha256Schema,
    architecturePlanSha256: PlaytestSha256Schema,
    robloxManifestSha256: PlaytestSha256Schema,
    projectId: PlaytestIdentifierSchema,
    manifestRootNodeId: PlaytestIdentifierSchema,
    manifestSourceWorldSpecSha256: PlaytestSha256Schema,
  },
  { additionalProperties: false },
);

export const PlaytestEnvironmentSchema = Type.Object(
  {
    placeId: Type.Literal(0),
    gameId: Type.Literal(0),
    editBaseSnapshotSha256: PlaytestSha256Schema,
    managedNodeCount: Type.Integer({ minimum: 1, maximum: 4096 }),
    playDataModelsUsed: Type.Array(
      Type.Union([Type.Literal('Edit'), Type.Literal('Server'), Type.Literal('Client')]),
      { minItems: 1, maxItems: 3, uniqueItems: true },
    ),
    exactStudioSelected: Type.Literal(true),
    sandboxLeaseVerified: Type.Literal(true),
  },
  { additionalProperties: false },
);

const boundedFailureCode = Type.Union([
  Type.Literal('none'),
  Type.Literal('start-uncertain'),
  Type.Literal('play-not-observed'),
  Type.Literal('identity-unproved'),
  Type.Literal('character-missing'),
  Type.Literal('setup-failed'),
  Type.Literal('path-failed'),
  Type.Literal('navigation-failed'),
  Type.Literal('arrival-missed'),
  Type.Literal('character-dead'),
  Type.Literal('character-fell'),
  Type.Literal('wrong-floor'),
  Type.Literal('support-missing'),
  Type.Literal('head-blocked'),
  Type.Literal('body-blocked'),
  Type.Literal('stop-uncertain'),
  Type.Literal('edit-not-restored'),
  Type.Literal('edit-snapshot-changed'),
]);

export const PlaytestStartSchema = Type.Object(
  {
    requested: Type.Boolean(),
    acknowledgmentCertain: Type.Boolean(),
    observedPlayRunning: Type.Boolean(),
    identityProbePassed: Type.Boolean(),
    characterReady: Type.Boolean(),
    failureCode: boundedFailureCode,
  },
  { additionalProperties: false },
);

export const PlaytestRunSetupSchema = Type.Object(
  {
    attempted: Type.Boolean(),
    succeeded: Type.Boolean(),
    requestedPosition: PlaytestVector3Schema,
    verifiedPosition: Type.Optional(PlaytestVector3Schema),
    excludedFromScoring: Type.Literal(true),
    failureCode: boundedFailureCode,
  },
  { additionalProperties: false },
);

export const PlaytestPathResultSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal('not_attempted'),
      Type.Literal('success'),
      Type.Literal('failed'),
    ]),
    waypointCount: Type.Integer({ minimum: 0, maximum: 128 }),
    totalPathDistance: Type.Number({ minimum: 0 }),
    jumpWaypointCount: Type.Integer({ minimum: 0, maximum: 128 }),
    waypointDigestSha256: Type.Optional(PlaytestSha256Schema),
  },
  { additionalProperties: false },
);

export const PlaytestNavigationResultSchema = Type.Object(
  {
    requestedOnce: Type.Boolean(),
    acknowledgmentCertain: Type.Boolean(),
    independentlyReached: Type.Boolean(),
    finalPosition: Type.Optional(PlaytestVector3Schema),
    horizontalError: Type.Optional(Type.Number({ minimum: 0 })),
    verticalError: Type.Optional(Type.Number({ minimum: 0 })),
    finalVelocityMagnitude: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const PlaytestArrivalResultSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal('not_observed'),
      Type.Literal('reached'),
      Type.Literal('missed'),
    ]),
    targetPosition: PlaytestVector3Schema,
    observedPosition: Type.Optional(PlaytestVector3Schema),
    horizontalError: Type.Optional(Type.Number({ minimum: 0 })),
    verticalError: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const PlaytestCharacterResultSchema = Type.Object(
  {
    observed: Type.Boolean(),
    alive: Type.Boolean(),
    health: Type.Number({ minimum: 0 }),
    maximumHealth: Type.Number({ minimum: 0 }),
    humanoidState: Type.Union([
      Type.Literal('unknown'),
      Type.Literal('running'),
      Type.Literal('running_no_physics'),
      Type.Literal('landed'),
      Type.Literal('freefall'),
      Type.Literal('falling_down'),
      Type.Literal('dead'),
    ]),
    fallDetected: Type.Boolean(),
    expectedLevel: Type.Integer({ minimum: 0, maximum: 2 }),
    observedLevel: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
  },
  { additionalProperties: false },
);

export const PlaytestClearanceResultSchema = Type.Object(
  {
    observed: Type.Boolean(),
    supported: Type.Boolean(),
    headClear: Type.Boolean(),
    bodyClear: Type.Boolean(),
    supportEntityId: Type.Optional(PlaytestIdentifierSchema),
    managedBlockerIds: Type.Array(PlaytestIdentifierSchema, { maxItems: 64, uniqueItems: true }),
    unmanagedBlockerCount: Type.Integer({ minimum: 0, maximum: 64 }),
  },
  { additionalProperties: false },
);

export const PlaytestSegmentResultSchema = Type.Object(
  {
    segmentId: PlaytestIdentifierSchema,
    sequence: Type.Integer({ minimum: 0, maximum: 255 }),
    fromCheckpointId: PlaytestIdentifierSchema,
    toCheckpointId: PlaytestIdentifierSchema,
    traversal: Type.Union([
      Type.Literal('door'),
      Type.Literal('open'),
      Type.Literal('corridor'),
      Type.Literal('stair'),
    ]),
    path: PlaytestPathResultSchema,
    navigation: PlaytestNavigationResultSchema,
    arrival: PlaytestArrivalResultSchema,
    character: PlaytestCharacterResultSchema,
    clearance: PlaytestClearanceResultSchema,
    viewportEvidenceId: Type.Optional(PlaytestIdentifierSchema),
    failureCodes: Type.Array(boundedFailureCode, { maxItems: 16, uniqueItems: true }),
  },
  { additionalProperties: false },
);

export const SanitizedConsoleEntrySchema = Type.Object(
  {
    evidenceId: PlaytestIdentifierSchema,
    severity: Type.Union([Type.Literal('error'), Type.Literal('warning'), Type.Literal('info')]),
    dataModelSource: Type.Union([Type.Literal('Edit'), Type.Literal('Server')]),
    messageSha256: PlaytestSha256Schema,
    classificationCode: Type.Union([
      Type.Literal('console-error'),
      Type.Literal('console-warning'),
      Type.Literal('console-information'),
      Type.Literal('console-output'),
    ]),
    isNew: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const PlaytestConsoleEvidenceSchema = Type.Object(
  {
    baselineEvidenceSha256: PlaytestSha256Schema,
    finalEvidenceSha256: PlaytestSha256Schema,
    evidenceComplete: Type.Boolean(),
    newErrorCount: Type.Integer({ minimum: 0, maximum: 512 }),
    newWarningCount: Type.Integer({ minimum: 0, maximum: 512 }),
    entries: Type.Array(SanitizedConsoleEntrySchema, { maxItems: 64 }),
  },
  { additionalProperties: false },
);

export const PlaytestViewportEvidenceSchema = Type.Object(
  {
    evidenceId: PlaytestIdentifierSchema,
    checkpointId: PlaytestIdentifierSchema,
    mediaType: Type.Literal('image/jpeg'),
    sha256: PlaytestSha256Schema,
    byteLength: Type.Integer({ minimum: 1, maximum: 4 * 1024 * 1024 }),
  },
  { additionalProperties: false },
);

export const PlaytestCoverageSchema = Type.Object(
  {
    requiredCheckpointCount: Type.Integer({ minimum: 0, maximum: 128 }),
    reachedCheckpointCount: Type.Integer({ minimum: 0, maximum: 128 }),
    missedCheckpointIds: Type.Array(PlaytestIdentifierSchema, { maxItems: 128, uniqueItems: true }),
    requiredRoomCount: Type.Integer({ minimum: 0, maximum: 128 }),
    reachedRoomCount: Type.Integer({ minimum: 0, maximum: 128 }),
    missedRoomIds: Type.Array(PlaytestIdentifierSchema, { maxItems: 128, uniqueItems: true }),
    requiredFloorCount: Type.Integer({ minimum: 0, maximum: 3 }),
    reachedFloorCount: Type.Integer({ minimum: 0, maximum: 3 }),
    missedFloorIds: Type.Array(PlaytestIdentifierSchema, { maxItems: 3, uniqueItems: true }),
    requiredStairRunCount: Type.Integer({ minimum: 0, maximum: 8 }),
    traversedStairRunCount: Type.Integer({ minimum: 0, maximum: 8 }),
    missedStairRunIds: Type.Array(PlaytestIdentifierSchema, { maxItems: 8, uniqueItems: true }),
  },
  { additionalProperties: false },
);

export const PlaytestStopSchema = Type.Object(
  {
    requested: Type.Boolean(),
    acknowledgmentCertain: Type.Boolean(),
    observedEditRestored: Type.Boolean(),
    identityVerifiedBeforeSecondStop: Type.Boolean(),
    failureCode: boundedFailureCode,
  },
  { additionalProperties: false },
);

export const PlaytestEditIntegritySchema = Type.Object(
  {
    prePlayEditSnapshotSha256: PlaytestSha256Schema,
    postPlayEditSnapshotSha256: Type.Optional(PlaytestSha256Schema),
    exactMatch: Type.Boolean(),
    finalManifestNoopOperationCount: Type.Integer({ minimum: 0, maximum: 512 }),
  },
  { additionalProperties: false },
);

export const PlaytestRunSummarySchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal('completed'),
      Type.Literal('aborted'),
      Type.Literal('failed_to_start'),
      Type.Literal('failed_to_stop'),
    ]),
    segmentsPlanned: Type.Integer({ minimum: 0, maximum: 256 }),
    segmentsAttempted: Type.Integer({ minimum: 0, maximum: 256 }),
    segmentsReached: Type.Integer({ minimum: 0, maximum: 256 }),
    allRequiredCoverageReached: Type.Boolean(),
    characterSurvived: Type.Boolean(),
    pathFailures: Type.Integer({ minimum: 0, maximum: 256 }),
    arrivalFailures: Type.Integer({ minimum: 0, maximum: 256 }),
    clearanceFailures: Type.Integer({ minimum: 0, maximum: 256 }),
    consoleErrors: Type.Integer({ minimum: 0, maximum: 512 }),
    consoleWarnings: Type.Integer({ minimum: 0, maximum: 512 }),
    editIntegrityPassed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const PlaytestRunReportSchema = Type.Object(
  {
    schemaVersion: Type.Literal(PLAYTEST_RUN_REPORT_VERSION),
    criticVersion: Type.Literal(PLAYTEST_CRITIC_VERSION),
    source: PlaytestRunSourceSchema,
    environment: PlaytestEnvironmentSchema,
    start: PlaytestStartSchema,
    setup: PlaytestRunSetupSchema,
    segmentResults: Type.Array(PlaytestSegmentResultSchema, { maxItems: 256 }),
    consoleEvidence: PlaytestConsoleEvidenceSchema,
    viewportEvidence: Type.Array(PlaytestViewportEvidenceSchema, { maxItems: 8 }),
    coverage: PlaytestCoverageSchema,
    stop: PlaytestStopSchema,
    editIntegrity: PlaytestEditIntegritySchema,
    summary: PlaytestRunSummarySchema,
  },
  {
    $id: PLAYTEST_RUN_REPORT_SCHEMA_ID,
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    additionalProperties: false,
  },
);

deepFreeze(PlaytestRunReportSchema);

export type PlaytestRunSource = Static<typeof PlaytestRunSourceSchema>;
export type PlaytestSegmentResult = Static<typeof PlaytestSegmentResultSchema>;
export type PlaytestConsoleEvidence = Static<typeof PlaytestConsoleEvidenceSchema>;
export type PlaytestViewportEvidence = Static<typeof PlaytestViewportEvidenceSchema>;
export type PlaytestCoverage = Static<typeof PlaytestCoverageSchema>;
export type PlaytestRunReport = Static<typeof PlaytestRunReportSchema>;
