import {
  CRITIC_MAX_FINDINGS,
  CRITIC_REPORT_VERSION,
  PLAYTEST_CRITIC_VERSION,
} from '../constants.js';
import { compareCodePoints } from '../json.js';
import type { PlaytestCheckpoint, PlaytestPlan, PlaytestSegment } from '../plan/contract-schema.js';
import { hashPlaytestPlan } from '../plan/hashing.js';
import { validatePlaytestPlan } from '../plan/validate.js';
import type { PlaytestRunReport, PlaytestSegmentResult } from '../run/contract-schema.js';
import { hashPlaytestRunReport } from '../run/hashing.js';
import { validatePlaytestRunReportAgainstPlan } from '../run/validate.js';
import type { PlaytestValidationResult } from '../diagnostic.js';
import type { CriticFinding, CriticFindingCode, CriticReport } from './contract-schema.js';
import { deriveCriticFindingId } from './finding-id.js';
import { CRITIC_RULES } from './rules.js';

interface FindingContext {
  readonly relatedFloorLevel?: number;
  readonly relatedSourceIds?: readonly string[];
  readonly relatedCheckpointIds?: readonly string[];
  readonly relatedSegmentIds?: readonly string[];
  readonly evidenceIds?: readonly string[];
}

function sorted(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort(compareCodePoints);
}

function createFinding(
  code: CriticFindingCode,
  context: Readonly<FindingContext> = {},
): CriticFinding {
  const rule = CRITIC_RULES[code];
  return {
    id: deriveCriticFindingId({ code, ...context }),
    code,
    severity: rule.severity,
    category: rule.category,
    message: rule.message,
    ...(context.relatedFloorLevel === undefined
      ? {}
      : { relatedFloorLevel: context.relatedFloorLevel }),
    relatedSourceIds: sorted(context.relatedSourceIds),
    relatedCheckpointIds: sorted(context.relatedCheckpointIds),
    relatedSegmentIds: sorted(context.relatedSegmentIds),
    evidenceIds: sorted(context.evidenceIds),
    suggestionCode: rule.suggestionCode,
  };
}

function checkpointContext(
  checkpoint: Readonly<PlaytestCheckpoint> | undefined,
  segment?: Readonly<PlaytestSegment>,
): FindingContext {
  const checkpointSourceIds =
    checkpoint === undefined
      ? []
      : [
          checkpoint.sourceSemanticId,
          checkpoint.sourceFloorId,
          ...('openingId' in checkpoint ? [checkpoint.openingId] : []),
          ...('roomId' in checkpoint ? [checkpoint.roomId] : []),
          ...('corridorId' in checkpoint ? [checkpoint.corridorId] : []),
          ...('stairRunId' in checkpoint ? [checkpoint.stairRunId] : []),
        ];
  return {
    ...(checkpoint === undefined ? {} : { relatedFloorLevel: checkpoint.level }),
    relatedSourceIds: [
      ...checkpointSourceIds,
      ...(segment === undefined ? [] : [segment.sourceCirculationEdgeId]),
    ],
    relatedCheckpointIds: checkpoint === undefined ? [] : [checkpoint.id],
    relatedSegmentIds: segment === undefined ? [] : [segment.id],
  };
}

function straightLine(
  left: Readonly<PlaytestCheckpoint>,
  right: Readonly<PlaytestCheckpoint>,
): number {
  const dx = left.worldPosition.x - right.worldPosition.x;
  const dy = left.worldPosition.y - right.worldPosition.y;
  const dz = left.worldPosition.z - right.worldPosition.z;
  return Math.hypot(dx, dy, dz);
}

function addSegmentFindings(
  findings: CriticFinding[],
  plan: Readonly<PlaytestPlan>,
  segment: Readonly<PlaytestSegment>,
  result: Readonly<PlaytestSegmentResult>,
  checkpoints: ReadonlyMap<string, PlaytestCheckpoint>,
): void {
  const target = checkpoints.get(segment.toCheckpointId);
  const source = checkpoints.get(segment.fromCheckpointId);
  const context = checkpointContext(target, segment);
  if (result.path.status === 'failed')
    findings.push(createFinding('critic.path_not_successful', context));
  if (result.path.jumpWaypointCount > 0 && !plan.agent.canJump)
    findings.push(createFinding('critic.path_requires_jump', context));
  if (result.arrival.status === 'missed')
    findings.push(createFinding('critic.arrival_not_reached', context));
  if (result.path.status !== 'not_attempted' && !result.character.observed)
    findings.push(createFinding('critic.character_missing', context));
  if (result.character.observed && (!result.character.alive || result.character.health <= 0))
    findings.push(createFinding('critic.character_dead', context));
  if (result.character.fallDetected) findings.push(createFinding('critic.character_fell', context));
  if (
    result.character.observedLevel !== undefined &&
    result.character.observedLevel !== result.character.expectedLevel
  ) {
    findings.push(createFinding('critic.wrong_floor', context));
  }
  if (result.clearance.observed && !result.clearance.supported)
    findings.push(
      createFinding('critic.support_missing', {
        ...context,
        relatedSourceIds: [
          ...(context.relatedSourceIds ?? []),
          ...(result.clearance.supportEntityId === undefined
            ? []
            : [result.clearance.supportEntityId]),
        ],
      }),
    );
  if (result.clearance.observed && !result.clearance.headClear)
    findings.push(
      createFinding('critic.head_clearance_blocked', {
        ...context,
        // The exact blocker set is the actionable source localization. Checkpoint,
        // segment, and floor localization remain in their dedicated fields.
        relatedSourceIds: result.clearance.managedBlockerIds,
      }),
    );
  if (result.clearance.observed && !result.clearance.bodyClear)
    findings.push(
      createFinding('critic.body_clearance_blocked', {
        ...context,
        relatedSourceIds: result.clearance.managedBlockerIds,
      }),
    );
  if (
    result.arrival.status === 'reached' &&
    result.navigation.finalVelocityMagnitude !== undefined &&
    result.navigation.finalVelocityMagnitude > plan.agent.maximumHorizontalSpeed
  ) {
    findings.push(createFinding('critic.arrival_velocity_high', context));
  }
  if (
    result.arrival.status === 'reached' &&
    result.navigation.requestedOnce &&
    !result.navigation.acknowledgmentCertain
  ) {
    findings.push(createFinding('critic.navigation_ack_uncertain', context));
  }
  if (
    result.clearance.observed &&
    result.clearance.unmanagedBlockerCount > 0 &&
    result.arrival.status === 'reached'
  ) {
    findings.push(createFinding('critic.unmanaged_blocker_nearby', context));
  }
  if (source !== undefined && target !== undefined && result.path.status === 'success') {
    const direct = straightLine(source, target);
    if (direct > 0 && result.path.totalPathDistance > Math.max(24, direct * 3)) {
      findings.push(createFinding('critic.path_detour_high', context));
    }
  }
}

function sortFindings(findings: readonly CriticFinding[]): CriticFinding[] {
  return [...findings].sort(
    (left, right) =>
      (left.severity === right.severity ? 0 : left.severity === 'error' ? -1 : 1) ||
      compareCodePoints(left.category, right.category) ||
      (left.relatedFloorLevel === undefined
        ? right.relatedFloorLevel === undefined
          ? 0
          : 1
        : right.relatedFloorLevel === undefined
          ? -1
          : left.relatedFloorLevel - right.relatedFloorLevel) ||
      compareCodePoints(left.relatedSourceIds[0] ?? '', right.relatedSourceIds[0] ?? '') ||
      compareCodePoints(left.code, right.code) ||
      compareCodePoints(left.id, right.id),
  );
}

function evaluateValidated(
  plan: Readonly<PlaytestPlan>,
  run: Readonly<PlaytestRunReport>,
): CriticReport {
  const findings: CriticFinding[] = [];
  const checkpointById = new Map(
    plan.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint] as const),
  );
  const segmentById = new Map(plan.segments.map((segment) => [segment.id, segment] as const));
  if (run.summary.status !== 'completed') findings.push(createFinding('critic.run_incomplete'));
  if (!run.start.observedPlayRunning) findings.push(createFinding('critic.playtest_start_failed'));
  if (!run.start.identityProbePassed)
    findings.push(createFinding('critic.play_simulation_identity_unproved'));
  if (!run.start.characterReady) findings.push(createFinding('critic.character_missing'));
  if (!run.setup.succeeded)
    findings.push(
      createFinding(
        'critic.setup_failed',
        checkpointContext(checkpointById.get(plan.setup.checkpointId)),
      ),
    );
  for (const result of run.segmentResults) {
    const segment = segmentById.get(result.segmentId);
    if (segment !== undefined) addSegmentFindings(findings, plan, segment, result, checkpointById);
  }
  for (const checkpointId of run.coverage.missedCheckpointIds) {
    findings.push(
      createFinding(
        'critic.checkpoint_not_reached',
        checkpointContext(checkpointById.get(checkpointId)),
      ),
    );
  }
  for (const roomId of run.coverage.missedRoomIds) {
    const checkpoint = plan.checkpoints.find(
      (value) => value.type === 'room_center' && value.roomId === roomId,
    );
    findings.push(createFinding('critic.room_not_reached', checkpointContext(checkpoint)));
  }
  for (const floorId of run.coverage.missedFloorIds) {
    const checkpoint = plan.checkpoints.find((value) => value.sourceFloorId === floorId);
    findings.push(createFinding('critic.floor_not_reached', checkpointContext(checkpoint)));
  }
  for (const stairRunId of run.coverage.missedStairRunIds) {
    const checkpoint = plan.checkpoints.find(
      (value) =>
        (value.type === 'stair_hall' || value.type === 'stair_landing') &&
        value.stairRunId === stairRunId,
    );
    findings.push(createFinding('critic.stair_not_traversed', checkpointContext(checkpoint)));
  }
  if (!run.consoleEvidence.evidenceComplete)
    findings.push(createFinding('critic.console_evidence_incomplete'));
  const errorEvidenceIds = run.consoleEvidence.entries
    .filter((entry) => entry.isNew && entry.severity === 'error')
    .map((entry) => entry.evidenceId);
  const warningEvidenceIds = run.consoleEvidence.entries
    .filter((entry) => entry.isNew && entry.severity === 'warning')
    .map((entry) => entry.evidenceId);
  // Counts are the complete evidence. Retained sanitized entries are optional localization only.
  // Always emit one aggregate finding so truncation or an empty retained summary cannot hide it.
  if (run.consoleEvidence.newErrorCount > 0)
    findings.push(createFinding('critic.console_error_new', { evidenceIds: errorEvidenceIds }));
  if (run.consoleEvidence.newWarningCount > 0)
    findings.push(createFinding('critic.console_warning_new', { evidenceIds: warningEvidenceIds }));
  // A failed start with no proved owned Play simulation must not issue Stop and
  // therefore must not be criticized for correctly omitting that unsafe call.
  if (run.start.identityProbePassed && !run.stop.requested)
    findings.push(createFinding('critic.playtest_stop_failed'));
  if (run.start.identityProbePassed && !run.stop.observedEditRestored)
    findings.push(createFinding('critic.edit_not_restored'));
  if (!run.editIntegrity.exactMatch) findings.push(createFinding('critic.edit_snapshot_changed'));
  if (run.editIntegrity.finalManifestNoopOperationCount !== 0)
    findings.push(createFinding('critic.manifest_not_noop'));
  const captured = new Set(run.viewportEvidence.map((evidence) => evidence.checkpointId));
  for (const checkpointId of plan.captureCheckpoints) {
    if (!captured.has(checkpointId))
      findings.push(
        createFinding(
          'critic.capture_unavailable',
          checkpointContext(checkpointById.get(checkpointId)),
        ),
      );
  }
  const ordered = sortFindings(findings);
  if (ordered.length > CRITIC_MAX_FINDINGS) {
    throw new Error('Validated Critic evaluation exceeded its proven findings bound.');
  }
  const errors = ordered.filter((finding) => finding.severity === 'error').length;
  const warnings = ordered.length - errors;
  const pathSuccessCount = run.segmentResults.filter(
    (result) => result.path.status === 'success',
  ).length;
  const arrivalSuccessCount = run.segmentResults.filter(
    (result) => result.arrival.status === 'reached',
  ).length;
  const clearanceSuccessCount = run.segmentResults.filter(
    (result) =>
      result.clearance.observed &&
      result.clearance.supported &&
      result.clearance.headClear &&
      result.clearance.bodyClear,
  ).length;
  return {
    schemaVersion: CRITIC_REPORT_VERSION,
    criticVersion: PLAYTEST_CRITIC_VERSION,
    source: {
      playtestPlanSchemaVersion: plan.schemaVersion,
      playtestPlanSha256: hashPlaytestPlan(plan),
      playtestRunReportSchemaVersion: run.schemaVersion,
      playtestRunReportSha256: hashPlaytestRunReport(run),
      architecturePlanSha256: plan.source.architecturePlanSha256,
      robloxManifestSha256: plan.source.robloxManifestSha256,
      projectId: plan.source.projectId,
    },
    status: errors > 0 ? 'fail' : warnings > 0 ? 'pass_with_warnings' : 'pass',
    findings: ordered,
    metrics: {
      requiredCheckpoints: run.coverage.requiredCheckpointCount,
      reachedCheckpoints: run.coverage.reachedCheckpointCount,
      requiredRooms: run.coverage.requiredRoomCount,
      reachedRooms: run.coverage.reachedRoomCount,
      requiredFloors: run.coverage.requiredFloorCount,
      reachedFloors: run.coverage.reachedFloorCount,
      requiredStairs: run.coverage.requiredStairRunCount,
      traversedStairs: run.coverage.traversedStairRunCount,
      pathSuccessCount,
      pathFailureCount: run.segmentResults.filter((result) => result.path.status === 'failed')
        .length,
      arrivalSuccessCount,
      arrivalFailureCount: run.segmentResults.filter((result) => result.arrival.status === 'missed')
        .length,
      clearanceSuccessCount,
      clearanceFailureCount: run.segmentResults.filter(
        (result) =>
          result.clearance.observed &&
          (!result.clearance.supported ||
            !result.clearance.headClear ||
            !result.clearance.bodyClear),
      ).length,
      consoleErrorCount: run.consoleEvidence.newErrorCount,
      consoleWarningCount: run.consoleEvidence.newWarningCount,
      editHashMatch: run.editIntegrity.exactMatch,
    },
    evidenceCompleteness: {
      segmentEvidenceComplete:
        run.segmentResults.length === plan.segments.length &&
        run.segmentResults.every((result) => result.path.status !== 'not_attempted'),
      consoleEvidenceComplete: run.consoleEvidence.evidenceComplete,
      viewportEvidenceComplete: plan.captureCheckpoints.every((checkpointId) =>
        captured.has(checkpointId),
      ),
      stopEvidenceComplete:
        !run.start.identityProbePassed || (run.stop.requested && run.stop.observedEditRestored),
      editIntegrityEvidenceComplete: run.editIntegrity.postPlayEditSnapshotSha256 !== undefined,
    },
  };
}

export function evaluatePlaytestRun(
  planInput: unknown,
  runInput: unknown,
): PlaytestValidationResult<CriticReport> {
  const planResult = validatePlaytestPlan(planInput);
  if (!planResult.valid) return planResult;
  const validated = validatePlaytestRunReportAgainstPlan(planResult.value, runInput);
  if (!validated.valid) return validated;
  return {
    valid: true,
    value: evaluateValidated(planResult.value, validated.value),
    diagnostics: [],
  };
}
