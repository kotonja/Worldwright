import { Type, type Static } from '@sinclair/typebox';

import {
  CRITIC_REPORT_SCHEMA_ID,
  CRITIC_REPORT_VERSION,
  CRITIC_MAX_FINDINGS,
  JSON_SCHEMA_DRAFT_2020_12,
  PLAYTEST_CRITIC_VERSION,
  PLAYTEST_PLAN_VERSION,
  PLAYTEST_RUN_REPORT_VERSION,
} from '../constants.js';
import { deepFreeze } from '../json.js';
import { PlaytestIdentifierSchema, PlaytestSha256Schema } from '../plan/contract-schema.js';

export const CriticFindingCodeSchema = Type.Union([
  Type.Literal('critic.run_incomplete'),
  Type.Literal('critic.play_simulation_identity_unproved'),
  Type.Literal('critic.playtest_start_failed'),
  Type.Literal('critic.character_missing'),
  Type.Literal('critic.character_dead'),
  Type.Literal('critic.character_fell'),
  Type.Literal('critic.setup_failed'),
  Type.Literal('critic.path_not_successful'),
  Type.Literal('critic.path_requires_jump'),
  Type.Literal('critic.arrival_not_reached'),
  Type.Literal('critic.wrong_floor'),
  Type.Literal('critic.checkpoint_not_reached'),
  Type.Literal('critic.room_not_reached'),
  Type.Literal('critic.floor_not_reached'),
  Type.Literal('critic.stair_not_traversed'),
  Type.Literal('critic.head_clearance_blocked'),
  Type.Literal('critic.body_clearance_blocked'),
  Type.Literal('critic.support_missing'),
  Type.Literal('critic.console_error_new'),
  Type.Literal('critic.console_evidence_incomplete'),
  Type.Literal('critic.playtest_stop_failed'),
  Type.Literal('critic.edit_not_restored'),
  Type.Literal('critic.edit_snapshot_changed'),
  Type.Literal('critic.manifest_not_noop'),
  Type.Literal('critic.console_warning_new'),
  Type.Literal('critic.arrival_velocity_high'),
  Type.Literal('critic.unmanaged_blocker_nearby'),
  Type.Literal('critic.navigation_ack_uncertain'),
  Type.Literal('critic.path_detour_high'),
  Type.Literal('critic.capture_unavailable'),
]);

export const CriticSuggestionCodeSchema = Type.Union([
  Type.Literal('inspect-opening-clearance'),
  Type.Literal('widen-corridor'),
  Type.Literal('inspect-stair-geometry'),
  Type.Literal('inspect-floor-support'),
  Type.Literal('inspect-collision-volume'),
  Type.Literal('inspect-spawn-or-setup'),
  Type.Literal('inspect-console-error'),
  Type.Literal('rerun-with-complete-evidence'),
  Type.Literal('restore-edit-snapshot'),
  Type.Literal('inspect-playtest-state'),
]);

export const CriticFindingSchema = Type.Object(
  {
    id: PlaytestIdentifierSchema,
    code: CriticFindingCodeSchema,
    severity: Type.Union([Type.Literal('error'), Type.Literal('warning')]),
    category: Type.Union([
      Type.Literal('identity'),
      Type.Literal('playtest_start'),
      Type.Literal('character'),
      Type.Literal('pathfinding'),
      Type.Literal('navigation'),
      Type.Literal('clearance'),
      Type.Literal('circulation'),
      Type.Literal('stairs'),
      Type.Literal('console'),
      Type.Literal('evidence'),
      Type.Literal('playtest_stop'),
      Type.Literal('edit_integrity'),
    ]),
    message: Type.String({ minLength: 1, maxLength: 256 }),
    relatedFloorLevel: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
    relatedSourceIds: Type.Array(PlaytestIdentifierSchema, { maxItems: 64, uniqueItems: true }),
    relatedCheckpointIds: Type.Array(PlaytestIdentifierSchema, { maxItems: 64, uniqueItems: true }),
    relatedSegmentIds: Type.Array(PlaytestIdentifierSchema, { maxItems: 64, uniqueItems: true }),
    evidenceIds: Type.Array(PlaytestIdentifierSchema, { maxItems: 64, uniqueItems: true }),
    suggestionCode: CriticSuggestionCodeSchema,
  },
  { additionalProperties: false },
);

export const CriticReportSourceSchema = Type.Object(
  {
    playtestPlanSchemaVersion: Type.Literal(PLAYTEST_PLAN_VERSION),
    playtestPlanSha256: PlaytestSha256Schema,
    playtestRunReportSchemaVersion: Type.Literal(PLAYTEST_RUN_REPORT_VERSION),
    playtestRunReportSha256: PlaytestSha256Schema,
    architecturePlanSha256: PlaytestSha256Schema,
    robloxManifestSha256: PlaytestSha256Schema,
    projectId: PlaytestIdentifierSchema,
  },
  { additionalProperties: false },
);

export const CriticMetricsSchema = Type.Object(
  {
    requiredCheckpoints: Type.Integer({ minimum: 0, maximum: 128 }),
    reachedCheckpoints: Type.Integer({ minimum: 0, maximum: 128 }),
    requiredRooms: Type.Integer({ minimum: 0, maximum: 128 }),
    reachedRooms: Type.Integer({ minimum: 0, maximum: 128 }),
    requiredFloors: Type.Integer({ minimum: 0, maximum: 3 }),
    reachedFloors: Type.Integer({ minimum: 0, maximum: 3 }),
    requiredStairs: Type.Integer({ minimum: 0, maximum: 8 }),
    traversedStairs: Type.Integer({ minimum: 0, maximum: 8 }),
    pathSuccessCount: Type.Integer({ minimum: 0, maximum: 256 }),
    pathFailureCount: Type.Integer({ minimum: 0, maximum: 256 }),
    arrivalSuccessCount: Type.Integer({ minimum: 0, maximum: 256 }),
    arrivalFailureCount: Type.Integer({ minimum: 0, maximum: 256 }),
    clearanceSuccessCount: Type.Integer({ minimum: 0, maximum: 256 }),
    clearanceFailureCount: Type.Integer({ minimum: 0, maximum: 256 }),
    consoleErrorCount: Type.Integer({ minimum: 0, maximum: 512 }),
    consoleWarningCount: Type.Integer({ minimum: 0, maximum: 512 }),
    editHashMatch: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CriticEvidenceCompletenessSchema = Type.Object(
  {
    segmentEvidenceComplete: Type.Boolean(),
    consoleEvidenceComplete: Type.Boolean(),
    viewportEvidenceComplete: Type.Boolean(),
    stopEvidenceComplete: Type.Boolean(),
    editIntegrityEvidenceComplete: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CriticReportSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CRITIC_REPORT_VERSION),
    criticVersion: Type.Literal(PLAYTEST_CRITIC_VERSION),
    source: CriticReportSourceSchema,
    status: Type.Union([
      Type.Literal('pass'),
      Type.Literal('pass_with_warnings'),
      Type.Literal('fail'),
    ]),
    findings: Type.Array(CriticFindingSchema, { maxItems: CRITIC_MAX_FINDINGS }),
    metrics: CriticMetricsSchema,
    evidenceCompleteness: CriticEvidenceCompletenessSchema,
  },
  {
    $id: CRITIC_REPORT_SCHEMA_ID,
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    additionalProperties: false,
  },
);

deepFreeze(CriticReportSchema);

export type CriticFindingCode = Static<typeof CriticFindingCodeSchema>;
export type CriticSuggestionCode = Static<typeof CriticSuggestionCodeSchema>;
export type CriticFinding = Static<typeof CriticFindingSchema>;
export type CriticReport = Static<typeof CriticReportSchema>;
