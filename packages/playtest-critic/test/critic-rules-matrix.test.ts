import { beforeAll, describe, expect, it } from 'vitest';

import type {
  CriticFinding,
  CriticFindingCode,
  CriticReport,
} from '../src/critic/contract-schema.js';
import { evaluatePlaytestRun } from '../src/critic/evaluate.js';
import { hashCriticReport } from '../src/critic/hashing.js';
import { CRITIC_RULES } from '../src/critic/rules.js';
import { validateCriticReport } from '../src/critic/validate.js';
import { compareCodePoints } from '../src/json.js';
import type { PlaytestCheckpoint, PlaytestPlan } from '../src/plan/contract-schema.js';
import type { PlaytestRunReport, PlaytestSegmentResult } from '../src/run/contract-schema.js';
import { validatePlaytestRunReportAgainstPlan } from '../src/run/validate.js';
import { clone, readPlanFixture, readRunFixture } from './helpers.js';

const ERROR_HASH = 'a'.repeat(64);
const WARNING_HASH = 'b'.repeat(64);
const CHANGED_EDIT_HASH = 'c'.repeat(64);

let plan: PlaytestPlan;
let cleanRun: PlaytestRunReport;

function checkpointSourceIds(
  checkpoints: readonly PlaytestCheckpoint[],
  reached: ReadonlySet<string>,
  type: 'room' | 'floor',
): string[] {
  const reachedCheckpoints = checkpoints.filter((checkpoint) => reached.has(checkpoint.id));
  return [
    ...new Set(
      type === 'room'
        ? reachedCheckpoints.flatMap((checkpoint) =>
            checkpoint.type === 'room_center' ? [checkpoint.roomId] : [],
          )
        : reachedCheckpoints.map((checkpoint) => checkpoint.sourceFloorId),
    ),
  ].sort(compareCodePoints);
}

function stairRunIdForTraversal(
  result: Readonly<PlaytestSegmentResult>,
  checkpointById: ReadonlyMap<string, PlaytestCheckpoint>,
): string | undefined {
  if (result.arrival.status !== 'reached' || result.traversal !== 'stair') return undefined;
  const from = checkpointById.get(result.fromCheckpointId);
  const to = checkpointById.get(result.toCheckpointId);
  if (from === undefined || to === undefined || from.level === to.level) return undefined;
  if (to.type === 'stair_landing' || to.type === 'stair_hall') return to.stairRunId;
  if (from.type === 'stair_landing' || from.type === 'stair_hall') return from.stairRunId;
  return undefined;
}

/** Rebuild every caller-derived count after a focused evidence mutation. */
function deriveRunFields(value: PlaytestRunReport): void {
  const reached = new Set<string>();
  if (value.setup.succeeded) reached.add(plan.setup.checkpointId);
  let halted = false;
  for (const result of value.segmentResults) {
    if (halted) makeUnattempted(result);
    const source = plan.checkpoints.find((checkpoint) => checkpoint.id === result.fromCheckpointId);
    const target = plan.checkpoints.find((checkpoint) => checkpoint.id === result.toCheckpointId);
    if (source === undefined || target === undefined)
      throw new Error('Matrix segment checkpoint is missing.');
    result.character.expectedLevel = result.navigation.requestedOnce ? target.level : source.level;
    if (result.character.observed && !result.navigation.requestedOnce)
      result.character.observedLevel = source.level;
    if (result.arrival.status === 'not_observed') {
      delete result.arrival.observedPosition;
      delete result.arrival.horizontalError;
      delete result.arrival.verticalError;
    }
    if (!result.character.observed) {
      result.character.alive = false;
      result.character.health = 0;
      result.character.maximumHealth = 0;
      result.character.humanoidState = 'unknown';
      result.character.fallDetected = false;
      delete result.character.observedLevel;
    }
    if (result.arrival.status !== 'reached') {
      result.clearance.observed = false;
      result.clearance.supported = false;
      result.clearance.headClear = false;
      result.clearance.bodyClear = false;
      delete result.clearance.supportEntityId;
      result.clearance.managedBlockerIds = [];
      result.clearance.unmanagedBlockerCount = 0;
      delete result.viewportEvidenceId;
    }
    if (result.arrival.status === 'reached' && result.navigation.independentlyReached)
      reached.add(result.toCheckpointId);
    const failureCodes: PlaytestSegmentResult['failureCodes'] = [];
    if (result.path.status === 'failed') failureCodes.push('path-failed');
    if (
      result.path.status === 'success' &&
      result.navigation.requestedOnce &&
      result.arrival.status !== 'reached'
    )
      failureCodes.push('navigation-failed');
    if (result.arrival.status === 'missed') failureCodes.push('arrival-missed');
    if (result.character.observed && (!result.character.alive || result.character.health <= 0))
      failureCodes.push('character-dead');
    if (result.character.observed && result.character.fallDetected)
      failureCodes.push('character-fell');
    if (
      result.character.observedLevel !== undefined &&
      result.character.observedLevel !== result.character.expectedLevel
    )
      failureCodes.push('wrong-floor');
    if (result.clearance.observed && !result.clearance.supported)
      failureCodes.push('support-missing');
    if (result.clearance.observed && !result.clearance.headClear) failureCodes.push('head-blocked');
    if (result.clearance.observed && !result.clearance.bodyClear) failureCodes.push('body-blocked');
    result.failureCodes = failureCodes.sort(compareCodePoints);
    if (
      result.path.status !== 'success' ||
      result.arrival.status !== 'reached' ||
      !result.navigation.independentlyReached ||
      result.failureCodes.length > 0
    )
      halted = true;
  }
  value.viewportEvidence = value.viewportEvidence.filter(
    (evidence) =>
      plan.captureCheckpoints.includes(evidence.checkpointId) && reached.has(evidence.checkpointId),
  );
  const viewportById = new Map(
    value.viewportEvidence.map((evidence) => [evidence.evidenceId, evidence] as const),
  );
  for (const result of value.segmentResults) {
    const evidence =
      result.viewportEvidenceId === undefined
        ? undefined
        : viewportById.get(result.viewportEvidenceId);
    if (
      evidence === undefined ||
      evidence.checkpointId !== result.toCheckpointId ||
      result.arrival.status !== 'reached' ||
      !result.navigation.independentlyReached
    )
      delete result.viewportEvidenceId;
  }
  value.start.failureCode =
    !value.start.requested || !value.start.acknowledgmentCertain
      ? 'start-uncertain'
      : !value.start.observedPlayRunning
        ? 'play-not-observed'
        : !value.start.identityProbePassed
          ? 'identity-unproved'
          : !value.start.characterReady
            ? 'character-missing'
            : 'none';
  value.setup.failureCode = value.setup.succeeded ? 'none' : 'setup-failed';
  value.stop.failureCode = !value.stop.requested
    ? 'none'
    : !value.stop.acknowledgmentCertain
      ? 'stop-uncertain'
      : !value.stop.observedEditRestored
        ? 'edit-not-restored'
        : 'none';

  const reachedRooms = checkpointSourceIds(plan.checkpoints, reached, 'room');
  const reachedFloors = checkpointSourceIds(plan.checkpoints, reached, 'floor');
  const missedCheckpointIds = plan.requiredCoverage.checkpoints.ids.filter(
    (id) => !reached.has(id),
  );
  const missedRoomIds = plan.requiredCoverage.rooms.ids.filter((id) => !reachedRooms.includes(id));
  const missedFloorIds = plan.requiredCoverage.floors.ids.filter(
    (id) => !reachedFloors.includes(id),
  );
  const checkpointById = new Map(
    plan.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint] as const),
  );
  const traversedStairs = new Set(
    value.segmentResults
      .map((result) => stairRunIdForTraversal(result, checkpointById))
      .filter((id): id is string => id !== undefined),
  );
  const missedStairRunIds = plan.requiredCoverage.stairRuns.ids.filter(
    (id) => !traversedStairs.has(id),
  );

  value.coverage = {
    requiredCheckpointCount: plan.requiredCoverage.checkpoints.count,
    reachedCheckpointCount: plan.requiredCoverage.checkpoints.count - missedCheckpointIds.length,
    missedCheckpointIds,
    requiredRoomCount: plan.requiredCoverage.rooms.count,
    reachedRoomCount: reachedRooms.length,
    missedRoomIds,
    requiredFloorCount: plan.requiredCoverage.floors.count,
    reachedFloorCount: reachedFloors.length,
    missedFloorIds,
    requiredStairRunCount: plan.requiredCoverage.stairRuns.count,
    traversedStairRunCount: traversedStairs.size,
    missedStairRunIds,
  };

  value.consoleEvidence.newErrorCount = Math.max(
    value.consoleEvidence.newErrorCount,
    value.consoleEvidence.entries.filter((entry) => entry.isNew && entry.severity === 'error')
      .length,
  );
  value.consoleEvidence.newWarningCount = Math.max(
    value.consoleEvidence.newWarningCount,
    value.consoleEvidence.entries.filter((entry) => entry.isNew && entry.severity === 'warning')
      .length,
  );
  const allRequiredCoverageReached =
    missedCheckpointIds.length === 0 &&
    missedRoomIds.length === 0 &&
    missedFloorIds.length === 0 &&
    missedStairRunIds.length === 0;
  value.summary = {
    ...value.summary,
    segmentsPlanned: value.segmentResults.length,
    segmentsAttempted: value.segmentResults.filter(
      (result) => result.path.status !== 'not_attempted',
    ).length,
    segmentsReached: value.segmentResults.filter((result) => result.arrival.status === 'reached')
      .length,
    allRequiredCoverageReached,
    characterSurvived: (() => {
      const observed = value.segmentResults.filter((result) => result.character.observed);
      return (
        value.start.characterReady &&
        observed.length > 0 &&
        observed.every(
          (result) =>
            result.character.alive && result.character.health > 0 && !result.character.fallDetected,
        )
      );
    })(),
    pathFailures: value.segmentResults.filter((result) => result.path.status === 'failed').length,
    arrivalFailures: value.segmentResults.filter((result) => result.arrival.status === 'missed')
      .length,
    clearanceFailures: value.segmentResults.filter(
      (result) =>
        result.clearance.observed &&
        (!result.clearance.supported || !result.clearance.headClear || !result.clearance.bodyClear),
    ).length,
    consoleErrors: value.consoleEvidence.newErrorCount,
    consoleWarnings: value.consoleEvidence.newWarningCount,
    editIntegrityPassed:
      value.editIntegrity.exactMatch && value.editIntegrity.finalManifestNoopOperationCount === 0,
    status:
      !value.start.requested ||
      !value.start.observedPlayRunning ||
      !value.start.identityProbePassed ||
      !value.start.characterReady
        ? 'failed_to_start'
        : !value.stop.observedEditRestored
          ? 'failed_to_stop'
          : !value.setup.succeeded ||
              value.segmentResults.some((result) => result.path.status === 'not_attempted')
            ? 'aborted'
            : 'completed',
  };
}

function evaluateVariant(mutator: (run: PlaytestRunReport) => void): CriticReport {
  const run = clone(cleanRun);
  mutator(run);
  deriveRunFields(run);
  const validation = validatePlaytestRunReportAgainstPlan(plan, run);
  expect(
    validation.valid,
    validation.valid ? undefined : JSON.stringify(validation.diagnostics),
  ).toBe(true);
  const result = evaluatePlaytestRun(plan, run);
  expect(result.valid, result.valid ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.valid) throw new Error('Expected a valid focused Run Report variant.');
  return result.value;
}

function codes(report: Readonly<CriticReport>): CriticFindingCode[] {
  return report.findings.map((finding) => finding.code);
}

function expectCodes(
  mutator: (run: PlaytestRunReport) => void,
  expected: readonly CriticFindingCode[],
  status: CriticReport['status'],
): CriticReport {
  const report = evaluateVariant(mutator);
  expect(report.status).toBe(status);
  for (const code of expected) expect(codes(report)).toContain(code);
  return report;
}

function missArrival(result: PlaytestSegmentResult): void {
  result.arrival.status = 'missed';
  const observedPosition = {
    ...result.arrival.targetPosition,
    x: result.arrival.targetPosition.x + plan.agent.arrivalHorizontalTolerance + 1,
  };
  result.arrival.observedPosition = observedPosition;
  result.arrival.horizontalError = plan.agent.arrivalHorizontalTolerance + 1;
  result.arrival.verticalError = 0;
  result.navigation.finalPosition = { ...observedPosition };
  result.navigation.horizontalError = plan.agent.arrivalHorizontalTolerance + 1;
  result.navigation.verticalError = 0;
  result.navigation.finalVelocityMagnitude = 0;
  result.navigation.independentlyReached = false;
  const failureCodes: PlaytestSegmentResult['failureCodes'] = [
    'arrival-missed',
    ...(result.path.status === 'failed' ? (['path-failed'] as const) : []),
  ];
  result.failureCodes = failureCodes.sort(compareCodePoints);
}

function makeUnattempted(result: PlaytestSegmentResult): void {
  const source = plan.checkpoints.find((checkpoint) => checkpoint.id === result.fromCheckpointId);
  if (source === undefined) throw new Error('Matrix source checkpoint is missing.');
  result.path.status = 'not_attempted';
  result.path.waypointCount = 0;
  result.path.totalPathDistance = 0;
  result.path.jumpWaypointCount = 0;
  delete result.path.waypointDigestSha256;
  result.navigation.requestedOnce = false;
  result.navigation.acknowledgmentCertain = false;
  result.navigation.independentlyReached = false;
  delete result.navigation.finalPosition;
  delete result.navigation.horizontalError;
  delete result.navigation.verticalError;
  delete result.navigation.finalVelocityMagnitude;
  result.arrival.status = 'not_observed';
  delete result.arrival.observedPosition;
  delete result.arrival.horizontalError;
  delete result.arrival.verticalError;
  result.character.observed = false;
  result.character.alive = false;
  result.character.health = 0;
  result.character.maximumHealth = 0;
  result.character.humanoidState = 'unknown';
  result.character.fallDetected = false;
  result.character.expectedLevel = source.level;
  delete result.character.observedLevel;
  result.clearance.observed = false;
  result.clearance.supported = false;
  result.clearance.headClear = false;
  result.clearance.bodyClear = false;
  delete result.clearance.supportEntityId;
  result.clearance.managedBlockerIds = [];
  result.clearance.unmanagedBlockerCount = 0;
  delete result.viewportEvidenceId;
  result.failureCodes = [];
}

function haltAfter(run: PlaytestRunReport, index: number): void {
  for (let cursor = index + 1; cursor < run.segmentResults.length; cursor += 1) {
    const result = run.segmentResults[cursor];
    if (result !== undefined) makeUnattempted(result);
  }
}

function terminalMiss(run: PlaytestRunReport, index: number): void {
  const result = run.segmentResults[index];
  if (result === undefined) throw new Error('Missing matrix segment.');
  missArrival(result);
  haltAfter(run, index);
}

function addConsoleEntry(run: PlaytestRunReport, severity: 'error' | 'warning'): void {
  run.consoleEvidence.entries.push({
    evidenceId: `evidence-console-matrix-${severity}`,
    severity,
    dataModelSource: 'Server',
    messageSha256: severity === 'error' ? ERROR_HASH : WARNING_HASH,
    classificationCode: severity === 'error' ? 'console-error' : 'console-warning',
    isNew: true,
  });
}

function byPublishedFindingOrder(left: CriticFinding, right: CriticFinding): number {
  return (
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
    compareCodePoints(left.id, right.id)
  );
}

function objectKeys(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((entry) => objectKeys(entry));
  const record = value as Record<string, unknown>;
  return [...Object.keys(record), ...Object.values(record).flatMap((entry) => objectKeys(entry))];
}

beforeAll(async () => {
  [plan, cleanRun] = await Promise.all([readPlanFixture(), readRunFixture()]);
});

describe('pure Critic rule matrix', () => {
  it('keeps the complete clean run at a finding-free pass', () => {
    const report = evaluateVariant(() => undefined);
    expect(report.status).toBe('pass');
    expect(report.findings).toEqual([]);
    expect(report.metrics.pathFailureCount).toBe(0);
    expect(report.metrics.arrivalFailureCount).toBe(0);
    expect(report.metrics.clearanceFailureCount).toBe(0);
  });

  it('classifies a sanitized new console warning without failing the run', () => {
    const report = expectCodes(
      (run) => addConsoleEntry(run, 'warning'),
      ['critic.console_warning_new'],
      'pass_with_warnings',
    );
    expect(report.metrics.consoleWarningCount).toBe(1);
    expect(report.findings[0]?.evidenceIds).toEqual(['evidence-console-matrix-warning']);
  });

  it('detects unsuccessful and jumping paths independently', () => {
    const pathFailure = expectCodes(
      (run) => {
        const index = run.segmentResults.length - 1;
        const result = run.segmentResults[index]!;
        result.path.status = 'failed';
        result.path.waypointCount = 0;
        result.path.totalPathDistance = 0;
        result.path.jumpWaypointCount = 0;
        delete result.path.waypointDigestSha256;
        result.navigation.requestedOnce = false;
        result.navigation.acknowledgmentCertain = false;
        result.navigation.independentlyReached = false;
        delete result.navigation.finalPosition;
        delete result.navigation.horizontalError;
        delete result.navigation.verticalError;
        delete result.navigation.finalVelocityMagnitude;
        result.arrival.status = 'not_observed';
        result.failureCodes = ['path-failed'];
      },
      ['critic.path_not_successful'],
      'fail',
    );
    expect(pathFailure.metrics.pathFailureCount).toBe(1);

    expectCodes(
      (run) => {
        const result = run.segmentResults.at(-1)!;
        result.path.status = 'failed';
        result.path.jumpWaypointCount = 1;
        result.navigation.requestedOnce = false;
        result.navigation.acknowledgmentCertain = false;
        result.navigation.independentlyReached = false;
        delete result.navigation.finalPosition;
        delete result.navigation.horizontalError;
        delete result.navigation.verticalError;
        delete result.navigation.finalVelocityMagnitude;
        result.arrival.status = 'not_observed';
        result.failureCodes = ['path-failed'];
      },
      ['critic.path_requires_jump'],
      'fail',
    );
  });

  it('detects an independently missed arrival', () => {
    const report = expectCodes(
      (run) => terminalMiss(run, run.segmentResults.length - 1),
      ['critic.arrival_not_reached'],
      'fail',
    );
    expect(report.metrics.arrivalFailureCount).toBe(1);
  });

  it.each([
    [
      'missing character',
      'critic.character_missing',
      (result: PlaytestSegmentResult): void => {
        result.character.observed = false;
      },
    ],
    [
      'dead character',
      'critic.character_dead',
      (result: PlaytestSegmentResult): void => {
        result.character.alive = false;
        result.character.health = 0;
        result.character.humanoidState = 'dead';
      },
    ],
    [
      'detected fall',
      'critic.character_fell',
      (result: PlaytestSegmentResult): void => {
        result.character.fallDetected = true;
        result.character.humanoidState = 'freefall';
      },
    ],
    [
      'wrong observed floor',
      'critic.wrong_floor',
      (result: PlaytestSegmentResult): void => {
        result.character.observedLevel = result.character.expectedLevel === 0 ? 1 : 0;
      },
    ],
  ] as const)('detects %s evidence', (_label, expectedCode, mutate) => {
    expectCodes(
      (run) => {
        const index = expectedCode === 'critic.wrong_floor' ? 0 : run.segmentResults.length - 1;
        mutate(run.segmentResults[index]!);
        if (expectedCode === 'critic.character_missing') missArrival(run.segmentResults[index]!);
        if (expectedCode === 'critic.wrong_floor')
          run.segmentResults[index]!.failureCodes = ['wrong-floor'];
        if (expectedCode === 'critic.character_dead')
          run.segmentResults[index]!.failureCodes = ['character-dead'];
        if (expectedCode === 'critic.character_fell')
          run.segmentResults[index]!.failureCodes = ['character-fell'];
      },
      [expectedCode],
      'fail',
    );
  });

  it('detects missing support plus blocked head and body clearance', () => {
    const blockerIds = Array.from(
      { length: 64 },
      (_, index) => `archgen-blocker-matrix-${String(index).padStart(2, '0')}`,
    );
    const report = expectCodes(
      (run) => {
        const clearance = run.segmentResults[0]!.clearance;
        clearance.supported = false;
        clearance.headClear = false;
        clearance.bodyClear = false;
        delete clearance.supportEntityId;
        clearance.managedBlockerIds = blockerIds;
        run.segmentResults[0]!.failureCodes = ['support-missing', 'head-blocked', 'body-blocked'];
      },
      ['critic.support_missing', 'critic.head_clearance_blocked', 'critic.body_clearance_blocked'],
      'fail',
    );
    expect(report.metrics.clearanceFailureCount).toBe(1);
    for (const code of [
      'critic.head_clearance_blocked',
      'critic.body_clearance_blocked',
    ] as const) {
      const finding = report.findings.find(
        (value) => value.code === code && value.relatedSegmentIds.includes(plan.segments[0]!.id),
      );
      expect(finding?.relatedSourceIds).toEqual(blockerIds);
    }
  });

  it('localizes missed checkpoint and room coverage', () => {
    const room = plan.checkpoints.find((checkpoint) => checkpoint.type === 'room_center');
    expect(room).toBeDefined();
    if (room === undefined) return;
    const report = expectCodes(
      (run) => {
        const index = run.segmentResults.findIndex((result) => result.toCheckpointId === room.id);
        expect(index).toBeGreaterThanOrEqual(0);
        terminalMiss(run, index);
      },
      ['critic.checkpoint_not_reached', 'critic.room_not_reached'],
      'fail',
    );
    expect(report.metrics.reachedRooms).toBeLessThan(report.metrics.requiredRooms);
    expect(
      report.findings.some(
        (finding) =>
          finding.code === 'critic.room_not_reached' &&
          finding.relatedSourceIds.includes(room.roomId),
      ),
    ).toBe(true);
  });

  it('detects a wholly missed floor even when later evidence remains structurally complete', () => {
    const upperFloor = plan.requiredCoverage.floors.ids.find(
      (floorId) => floorId !== plan.setup.sourceFloorId,
    );
    expect(upperFloor).toBeDefined();
    if (upperFloor === undefined) return;
    const upperCheckpointIds = new Set(
      plan.checkpoints
        .filter((checkpoint) => checkpoint.sourceFloorId === upperFloor)
        .map((checkpoint) => checkpoint.id),
    );
    const report = expectCodes(
      (run) => {
        const index = run.segmentResults.findIndex((result) =>
          upperCheckpointIds.has(result.toCheckpointId),
        );
        expect(index).toBeGreaterThanOrEqual(0);
        terminalMiss(run, index);
      },
      ['critic.floor_not_reached'],
      'fail',
    );
    expect(report.metrics.reachedFloors).toBe(report.metrics.requiredFloors - 1);
  });

  it('detects an untraversed required stair run from cross-level arrival evidence', () => {
    const checkpointById = new Map(
      plan.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint] as const),
    );
    const report = expectCodes(
      (run) => {
        const index = run.segmentResults.findIndex((result) => {
          const from = checkpointById.get(result.fromCheckpointId);
          const to = checkpointById.get(result.toCheckpointId);
          return (
            result.traversal === 'stair' &&
            from !== undefined &&
            to !== undefined &&
            from.level !== to.level
          );
        });
        expect(index).toBeGreaterThanOrEqual(0);
        terminalMiss(run, index);
      },
      ['critic.stair_not_traversed'],
      'fail',
    );
    expect(report.metrics.traversedStairs).toBe(0);
  });

  it('detects sanitized new errors and incomplete console evidence', () => {
    const report = expectCodes(
      (run) => {
        addConsoleEntry(run, 'error');
        run.consoleEvidence.evidenceComplete = false;
      },
      ['critic.console_error_new', 'critic.console_evidence_incomplete'],
      'fail',
    );
    expect(report.metrics.consoleErrorCount).toBe(1);
    expect(report.evidenceCompleteness.consoleEvidenceComplete).toBe(false);
  });

  it('emits aggregate console findings when the retained sanitized summary is empty', () => {
    const report = expectCodes(
      (run) => {
        run.consoleEvidence.newErrorCount = 7;
        run.consoleEvidence.newWarningCount = 9;
        run.consoleEvidence.entries = [];
      },
      ['critic.console_error_new', 'critic.console_warning_new'],
      'fail',
    );
    expect(
      report.findings.filter((finding) => finding.code === 'critic.console_error_new'),
    ).toHaveLength(1);
    expect(
      report.findings.filter((finding) => finding.code === 'critic.console_warning_new'),
    ).toHaveLength(1);
    expect(report.metrics.consoleErrorCount).toBe(7);
    expect(report.metrics.consoleWarningCount).toBe(9);
  });

  it('detects failed Stop, missing Edit restoration, snapshot drift, and non-noop reconciliation', () => {
    const report = expectCodes(
      (run) => {
        run.stop.requested = false;
        run.stop.acknowledgmentCertain = false;
        run.stop.observedEditRestored = false;
        run.stop.failureCode = 'stop-uncertain';
        run.editIntegrity.postPlayEditSnapshotSha256 = CHANGED_EDIT_HASH;
        run.editIntegrity.exactMatch = false;
        run.editIntegrity.finalManifestNoopOperationCount = 1;
        run.summary.status = 'failed_to_stop';
      },
      [
        'critic.run_incomplete',
        'critic.playtest_stop_failed',
        'critic.edit_not_restored',
        'critic.edit_snapshot_changed',
        'critic.manifest_not_noop',
      ],
      'fail',
    );
    expect(report.metrics.editHashMatch).toBe(false);
    expect(report.evidenceCompleteness.stopEvidenceComplete).toBe(false);
  });

  it.each([
    [
      'uncertain navigation acknowledgment',
      'critic.navigation_ack_uncertain',
      (run: PlaytestRunReport): void => {
        run.segmentResults[0]!.navigation.acknowledgmentCertain = false;
      },
    ],
    [
      'excessive arrival velocity',
      'critic.arrival_velocity_high',
      (run: PlaytestRunReport): void => {
        run.segmentResults[0]!.navigation.finalVelocityMagnitude =
          plan.agent.maximumHorizontalSpeed + 1;
      },
    ],
    [
      'nearby unmanaged blocker',
      'critic.unmanaged_blocker_nearby',
      (run: PlaytestRunReport): void => {
        run.segmentResults[0]!.clearance.unmanagedBlockerCount = 1;
      },
    ],
    [
      'disproportionate path detour',
      'critic.path_detour_high',
      (run: PlaytestRunReport): void => {
        run.segmentResults[0]!.path.totalPathDistance = 1_000_000;
      },
    ],
    [
      'unavailable optional capture',
      'critic.capture_unavailable',
      (run: PlaytestRunReport): void => {
        const capture = run.viewportEvidence.find(
          (evidence) => evidence.checkpointId === plan.captureCheckpoints[0],
        );
        expect(capture).toBeDefined();
        run.viewportEvidence = run.viewportEvidence.filter(
          (evidence) => evidence.checkpointId !== plan.captureCheckpoints[0],
        );
      },
    ],
  ] as const)('emits a warning for %s', (_label, expectedCode, mutate) => {
    expectCodes(mutate, [expectedCode], 'pass_with_warnings');
  });

  it('covers start identity, start state, ready-character, and setup hard rules', () => {
    const report = expectCodes(
      (run) => {
        run.start.observedPlayRunning = false;
        run.start.identityProbePassed = false;
        run.start.characterReady = false;
        run.start.failureCode = 'play-not-observed';
        run.setup.attempted = false;
        run.setup.succeeded = false;
        run.setup.failureCode = 'setup-failed';
        delete run.setup.verifiedPosition;
        run.stop.requested = false;
        run.stop.acknowledgmentCertain = false;
        run.stop.observedEditRestored = false;
        run.stop.failureCode = 'none';
        run.environment.playDataModelsUsed = ['Edit'];
        run.segmentResults.forEach(makeUnattempted);
        run.viewportEvidence = [];
        run.summary.status = 'failed_to_start';
      },
      [
        'critic.run_incomplete',
        'critic.playtest_start_failed',
        'critic.play_simulation_identity_unproved',
        'critic.character_missing',
        'critic.setup_failed',
      ],
      'fail',
    );
    const falseUnobservedClaims = new Set<CriticFindingCode>([
      'critic.path_not_successful',
      'critic.arrival_not_reached',
      'critic.support_missing',
      'critic.head_clearance_blocked',
      'critic.body_clearance_blocked',
    ]);
    expect(
      report.findings.some(
        (finding) =>
          falseUnobservedClaims.has(finding.code) ||
          (finding.code === 'critic.character_missing' && finding.relatedSegmentIds.length > 0),
      ),
    ).toBe(false);
  });

  it('produces deterministic IDs, published ordering, exact metrics, and no executable repair content', () => {
    const mutate = (run: PlaytestRunReport): void => {
      const first = run.segmentResults.at(-1)!;
      first.path.status = 'failed';
      first.path.jumpWaypointCount = 0;
      first.path.waypointCount = 0;
      first.path.totalPathDistance = 0;
      delete first.path.waypointDigestSha256;
      first.navigation.requestedOnce = false;
      first.navigation.acknowledgmentCertain = false;
      delete first.navigation.finalPosition;
      delete first.navigation.horizontalError;
      delete first.navigation.verticalError;
      delete first.navigation.finalVelocityMagnitude;
      first.navigation.independentlyReached = false;
      first.arrival.status = 'not_observed';
      delete first.arrival.observedPosition;
      delete first.arrival.horizontalError;
      delete first.arrival.verticalError;
      first.character.alive = false;
      first.character.health = 0;
      first.character.humanoidState = 'dead';
      first.clearance.supported = false;
      first.clearance.headClear = false;
      first.clearance.bodyClear = false;
      delete first.clearance.supportEntityId;
      first.clearance.unmanagedBlockerCount = 1;
      first.failureCodes = [
        'body-blocked',
        'character-dead',
        'head-blocked',
        'path-failed',
        'support-missing',
      ];
      addConsoleEntry(run, 'error');
      addConsoleEntry(run, 'warning');
      run.consoleEvidence.evidenceComplete = false;
      run.viewportEvidence = run.viewportEvidence.slice(1);
      run.editIntegrity.postPlayEditSnapshotSha256 = CHANGED_EDIT_HASH;
      run.editIntegrity.exactMatch = false;
      run.editIntegrity.finalManifestNoopOperationCount = 1;
    };
    const first = evaluateVariant(mutate);
    const second = evaluateVariant(mutate);

    expect(second).toEqual(first);
    expect(hashCriticReport(second)).toBe(hashCriticReport(first));
    expect(first.findings.map((finding) => finding.id)).toHaveLength(
      new Set(first.findings.map((finding) => finding.id)).size,
    );
    expect(
      first.findings.every((finding) => /^critic-finding-[0-9a-f]{20}$/.test(finding.id)),
    ).toBe(true);
    expect(first.findings).toEqual([...first.findings].sort(byPublishedFindingOrder));
    expect(first.metrics).toMatchObject({
      pathSuccessCount: cleanRun.segmentResults.length - 1,
      pathFailureCount: 1,
      arrivalSuccessCount: cleanRun.segmentResults.length - 1,
      arrivalFailureCount: 0,
      clearanceSuccessCount: cleanRun.segmentResults.length - 1,
      clearanceFailureCount: 0,
      consoleErrorCount: 1,
      consoleWarningCount: 1,
      editHashMatch: false,
    });
    for (const finding of first.findings) {
      expect(finding).toMatchObject(CRITIC_RULES[finding.code]);
    }
    expect(validateCriticReport(first).valid).toBe(true);
    expect(
      objectKeys(first).filter((key) => /repair|changeset|script|luau|executable/i.test(key)),
    ).toEqual([]);
    expect(first).not.toHaveProperty('repair');
    expect(first).not.toHaveProperty('changeSet');
    expect(first).not.toHaveProperty('operations');
  });
});
