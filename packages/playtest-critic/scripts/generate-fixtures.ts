import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { evaluatePlaytestRun } from '../src/critic/evaluate.js';
import { stringifyCriticReport } from '../src/critic/hashing.js';
import type { CriticReport } from '../src/critic/contract-schema.js';
import type { PlaytestPlan } from '../src/plan/contract-schema.js';
import { hashPlaytestPlan, stringifyPlaytestPlan } from '../src/plan/hashing.js';
import { buildPlaytestPlan } from '../src/plan/planner.js';
import type { PlaytestRunReport } from '../src/run/contract-schema.js';
import { stringifyPlaytestRunReport } from '../src/run/hashing.js';
import { validatePlaytestRunReportAgainstPlan } from '../src/run/validate.js';
import { compareCodePoints } from '../src/json.js';

const architecturePlanPath = fileURLToPath(
  new URL(
    '../../architecture-planner/fixtures/plans/cliffwatch-mansion.architecture-plan.json',
    import.meta.url,
  ),
);
const manifestPath = fileURLToPath(
  new URL(
    '../../architecture-planner/fixtures/manifest/cliffwatch-mansion-blockout.manifest.json',
    import.meta.url,
  ),
);

export interface FixtureArtifact {
  readonly label: string;
  readonly path: string;
  readonly content: string;
}

function sha(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex');
}

function clone<T>(value: Readonly<T>): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function directDistance(
  left: Readonly<{ worldPosition: { x: number; y: number; z: number } }>,
  right: Readonly<{ worldPosition: { x: number; y: number; z: number } }>,
): number {
  return Math.hypot(
    right.worldPosition.x - left.worldPosition.x,
    right.worldPosition.y - left.worldPosition.y,
    right.worldPosition.z - left.worldPosition.z,
  );
}

export function buildPassRun(plan: Readonly<PlaytestPlan>): PlaytestRunReport {
  const checkpointById = new Map(
    plan.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint] as const),
  );
  const captureByCheckpoint = new Map(
    plan.captureCheckpoints.map(
      (checkpointId) =>
        [checkpointId, `evidence-viewport-${sha(checkpointId).slice(0, 16)}`] as const,
    ),
  );
  const snapshot = sha('cliffwatch-edit-snapshot');
  const segmentResults = plan.segments.map((segment) => {
    const from = checkpointById.get(segment.fromCheckpointId);
    const to = checkpointById.get(segment.toCheckpointId);
    if (from === undefined || to === undefined)
      throw new Error('Fixture segment references a missing checkpoint.');
    const viewportEvidenceId = captureByCheckpoint.get(to.id);
    return {
      segmentId: segment.id,
      sequence: segment.sequence,
      fromCheckpointId: segment.fromCheckpointId,
      toCheckpointId: segment.toCheckpointId,
      traversal: segment.traversal,
      path: {
        status: 'success' as const,
        waypointCount: 2,
        totalPathDistance: directDistance(from, to),
        jumpWaypointCount: 0,
        waypointDigestSha256: sha(`waypoints:${segment.id}`),
      },
      navigation: {
        requestedOnce: true,
        acknowledgmentCertain: true,
        independentlyReached: true,
        finalPosition: { ...to.worldPosition },
        horizontalError: 0,
        verticalError: 0,
        finalVelocityMagnitude: 0,
      },
      arrival: {
        status: 'reached' as const,
        targetPosition: { ...to.worldPosition },
        observedPosition: { ...to.worldPosition },
        horizontalError: 0,
        verticalError: 0,
      },
      character: {
        observed: true,
        alive: true,
        health: 100,
        maximumHealth: 100,
        humanoidState: 'running' as const,
        fallDetected: false,
        expectedLevel: to.level,
        observedLevel: to.level,
      },
      clearance: {
        observed: true,
        supported: true,
        headClear: true,
        bodyClear: true,
        supportEntityId: to.sourceFloorId,
        managedBlockerIds: [],
        unmanagedBlockerCount: 0,
      },
      ...(viewportEvidenceId === undefined ? {} : { viewportEvidenceId }),
      failureCodes: [],
    };
  });
  return {
    schemaVersion: '0.1.0',
    criticVersion: '0.1.0',
    source: {
      playtestPlanSha256: hashPlaytestPlan(plan),
      architecturePlanSha256: plan.source.architecturePlanSha256,
      robloxManifestSha256: plan.source.robloxManifestSha256,
      projectId: plan.source.projectId,
      manifestRootNodeId: plan.source.manifestRootNodeId,
      manifestSourceWorldSpecSha256: plan.source.manifestSourceWorldSpecSha256,
    },
    environment: {
      placeId: 0,
      gameId: 0,
      editBaseSnapshotSha256: snapshot,
      managedNodeCount: plan.source.expectedManagedInstanceCount,
      playDataModelsUsed: ['Client', 'Edit', 'Server'],
      exactStudioSelected: true,
      sandboxLeaseVerified: true,
    },
    start: {
      requested: true,
      acknowledgmentCertain: true,
      observedPlayRunning: true,
      identityProbePassed: true,
      characterReady: true,
      failureCode: 'none',
    },
    setup: {
      attempted: true,
      succeeded: true,
      requestedPosition: { ...plan.setup.worldPosition },
      verifiedPosition: { ...plan.setup.worldPosition },
      excludedFromScoring: true,
      failureCode: 'none',
    },
    segmentResults,
    consoleEvidence: {
      baselineEvidenceSha256: sha('console-baseline'),
      finalEvidenceSha256: sha('console-final-clean'),
      evidenceComplete: true,
      newErrorCount: 0,
      newWarningCount: 0,
      entries: [],
    },
    viewportEvidence: plan.captureCheckpoints.map((checkpointId) => ({
      evidenceId: captureByCheckpoint.get(checkpointId)!,
      checkpointId,
      mediaType: 'image/jpeg' as const,
      sha256: sha(`viewport:${checkpointId}`),
      byteLength: 1024 + checkpointId.length,
    })),
    coverage: {
      requiredCheckpointCount: plan.requiredCoverage.checkpoints.count,
      reachedCheckpointCount: plan.requiredCoverage.checkpoints.count,
      missedCheckpointIds: [],
      requiredRoomCount: plan.requiredCoverage.rooms.count,
      reachedRoomCount: plan.requiredCoverage.rooms.count,
      missedRoomIds: [],
      requiredFloorCount: plan.requiredCoverage.floors.count,
      reachedFloorCount: plan.requiredCoverage.floors.count,
      missedFloorIds: [],
      requiredStairRunCount: plan.requiredCoverage.stairRuns.count,
      traversedStairRunCount: plan.requiredCoverage.stairRuns.count,
      missedStairRunIds: [],
    },
    stop: {
      requested: true,
      acknowledgmentCertain: true,
      observedEditRestored: true,
      identityVerifiedBeforeSecondStop: false,
      failureCode: 'none',
    },
    editIntegrity: {
      prePlayEditSnapshotSha256: snapshot,
      postPlayEditSnapshotSha256: snapshot,
      exactMatch: true,
      finalManifestNoopOperationCount: 0,
    },
    summary: {
      status: 'completed',
      segmentsPlanned: plan.segments.length,
      segmentsAttempted: plan.segments.length,
      segmentsReached: plan.segments.length,
      allRequiredCoverageReached: true,
      characterSurvived: true,
      pathFailures: 0,
      arrivalFailures: 0,
      clearanceFailures: 0,
      consoleErrors: 0,
      consoleWarnings: 0,
      editIntegrityPassed: true,
    },
  };
}

function failedSegment(plan: Readonly<PlaytestPlan>, run: PlaytestRunReport, index: number): void {
  const result = run.segmentResults[index];
  if (result === undefined) throw new Error('Fixture failure segment is missing.');
  const source = plan.checkpoints.find((checkpoint) => checkpoint.id === result.fromCheckpointId);
  if (source === undefined) throw new Error('Fixture failure source checkpoint is missing.');
  result.path.status = 'failed';
  result.path.waypointCount = 0;
  result.path.totalPathDistance = 0;
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
  result.character.observed = true;
  result.character.alive = true;
  result.character.health = 100;
  result.character.maximumHealth = 100;
  result.character.humanoidState = 'running';
  result.character.fallDetected = false;
  result.character.expectedLevel = source.level;
  result.character.observedLevel = source.level;
  result.clearance.observed = false;
  result.clearance.supported = false;
  result.clearance.headClear = false;
  result.clearance.bodyClear = false;
  delete result.clearance.supportEntityId;
  result.failureCodes = ['path-failed'];
  delete result.viewportEvidenceId;
  for (const later of run.segmentResults.slice(index + 1)) {
    const laterSource = plan.checkpoints.find(
      (checkpoint) => checkpoint.id === later.fromCheckpointId,
    );
    if (laterSource === undefined)
      throw new Error('Fixture unattempted source checkpoint is missing.');
    later.path.status = 'not_attempted';
    later.path.waypointCount = 0;
    later.path.totalPathDistance = 0;
    later.path.jumpWaypointCount = 0;
    delete later.path.waypointDigestSha256;
    later.navigation.requestedOnce = false;
    later.navigation.acknowledgmentCertain = false;
    later.navigation.independentlyReached = false;
    delete later.navigation.finalPosition;
    delete later.navigation.horizontalError;
    delete later.navigation.verticalError;
    delete later.navigation.finalVelocityMagnitude;
    later.arrival.status = 'not_observed';
    delete later.arrival.observedPosition;
    delete later.arrival.horizontalError;
    delete later.arrival.verticalError;
    later.character.observed = false;
    later.character.alive = false;
    later.character.health = 0;
    later.character.maximumHealth = 0;
    later.character.humanoidState = 'unknown';
    later.character.fallDetected = false;
    later.character.expectedLevel = laterSource.level;
    delete later.character.observedLevel;
    later.clearance.observed = false;
    later.clearance.supported = false;
    later.clearance.headClear = false;
    later.clearance.bodyClear = false;
    delete later.clearance.supportEntityId;
    later.clearance.managedBlockerIds = [];
    later.clearance.unmanagedBlockerCount = 0;
    later.failureCodes = [];
    delete later.viewportEvidenceId;
  }
}

function deriveCoverageAndSummary(plan: Readonly<PlaytestPlan>, run: PlaytestRunReport): void {
  run.environment.playDataModelsUsed = [
    'Edit',
    'Server',
    ...(run.segmentResults.some((result) => result.navigation.requestedOnce)
      ? (['Client'] as const)
      : []),
  ];
  const reached = new Set<string>(run.setup.succeeded ? [plan.setup.checkpointId] : []);
  for (const result of run.segmentResults)
    if (result.arrival.status === 'reached' && result.navigation.independentlyReached)
      reached.add(result.toCheckpointId);
  const missedCheckpointIds = plan.requiredCoverage.checkpoints.ids
    .filter((id) => !reached.has(id))
    .sort(compareCodePoints);
  const reachedCheckpoints = plan.checkpoints.filter((checkpoint) => reached.has(checkpoint.id));
  const reachedRooms = [
    ...new Set(
      reachedCheckpoints.flatMap((checkpoint) =>
        checkpoint.type === 'room_center' ? [checkpoint.roomId] : [],
      ),
    ),
  ].sort(compareCodePoints);
  const reachedFloors = [
    ...new Set(reachedCheckpoints.map((checkpoint) => checkpoint.sourceFloorId)),
  ].sort(compareCodePoints);
  const checkpointById = new Map(
    plan.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint] as const),
  );
  const reachedStairs = new Set<string>();
  for (const result of run.segmentResults) {
    if (
      result.arrival.status !== 'reached' ||
      !result.navigation.independentlyReached ||
      result.traversal !== 'stair'
    )
      continue;
    const from = checkpointById.get(result.fromCheckpointId);
    const to = checkpointById.get(result.toCheckpointId);
    if (
      from?.type === 'stair_landing' &&
      to?.type === 'stair_landing' &&
      from.level !== to.level &&
      from.stairRunId === to.stairRunId
    )
      reachedStairs.add(from.stairRunId);
  }
  const missedRoomIds = plan.requiredCoverage.rooms.ids.filter((id) => !reachedRooms.includes(id));
  const missedFloorIds = plan.requiredCoverage.floors.ids.filter(
    (id) => !reachedFloors.includes(id),
  );
  const missedStairRunIds = plan.requiredCoverage.stairRuns.ids.filter(
    (id) => !reachedStairs.has(id),
  );
  run.coverage = {
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
    traversedStairRunCount: reachedStairs.size,
    missedStairRunIds,
  };
  const reachedCaptureIds = new Set(
    run.segmentResults
      .filter((result) => result.arrival.status === 'reached')
      .map((result) => result.viewportEvidenceId)
      .filter((value): value is string => value !== undefined),
  );
  const setupCapture = run.viewportEvidence.find(
    (evidence) => evidence.checkpointId === plan.setup.checkpointId,
  )?.evidenceId;
  if (setupCapture !== undefined && run.setup.succeeded) reachedCaptureIds.add(setupCapture);
  run.viewportEvidence = run.viewportEvidence.filter((evidence) =>
    reachedCaptureIds.has(evidence.evidenceId),
  );
  run.summary.segmentsAttempted = run.segmentResults.filter(
    (result) => result.path.status !== 'not_attempted',
  ).length;
  run.summary.segmentsReached = run.segmentResults.filter(
    (result) => result.arrival.status === 'reached',
  ).length;
  run.summary.pathFailures = run.segmentResults.filter(
    (result) => result.path.status === 'failed',
  ).length;
  run.summary.arrivalFailures = run.segmentResults.filter(
    (result) => result.arrival.status === 'missed',
  ).length;
  run.summary.clearanceFailures = run.segmentResults.filter(
    (result) =>
      result.clearance.observed &&
      (!result.clearance.supported || !result.clearance.headClear || !result.clearance.bodyClear),
  ).length;
  run.summary.allRequiredCoverageReached =
    missedCheckpointIds.length === 0 &&
    missedRoomIds.length === 0 &&
    missedFloorIds.length === 0 &&
    missedStairRunIds.length === 0;
  run.summary.status =
    run.summary.segmentsAttempted < plan.segments.length ? 'aborted' : 'completed';
}

interface ScenarioRuns {
  readonly pass: PlaytestRunReport;
  readonly blockedDoor: PlaytestRunReport;
  readonly stairFailure: PlaytestRunReport;
  readonly consoleError: PlaytestRunReport;
}

function buildScenarioRuns(plan: Readonly<PlaytestPlan>): ScenarioRuns {
  const pass = buildPassRun(plan);
  const blockedDoor = clone(pass);
  const doorIndex = plan.segments.findIndex((segment) => segment.traversal === 'door');
  failedSegment(plan, blockedDoor, doorIndex);
  deriveCoverageAndSummary(plan, blockedDoor);

  const stairFailure = clone(pass);
  const checkpointById = new Map(
    plan.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint] as const),
  );
  const stairIndex = plan.segments.findIndex((segment) => {
    const from = checkpointById.get(segment.fromCheckpointId);
    const to = checkpointById.get(segment.toCheckpointId);
    return (
      segment.traversal === 'stair' &&
      from !== undefined &&
      to !== undefined &&
      from.level !== to.level
    );
  });
  failedSegment(plan, stairFailure, stairIndex);
  deriveCoverageAndSummary(plan, stairFailure);

  const consoleError = clone(pass);
  consoleError.consoleEvidence.entries = [
    {
      evidenceId: 'evidence-console-error-0001',
      severity: 'error',
      dataModelSource: 'Server',
      messageSha256: sha('sanitized-console-error'),
      classificationCode: 'console-error',
      isNew: true,
    },
  ];
  consoleError.consoleEvidence.newErrorCount = 1;
  consoleError.consoleEvidence.finalEvidenceSha256 = sha('console-final-error');
  consoleError.summary.consoleErrors = 1;
  return { pass, blockedDoor, stairFailure, consoleError };
}

function assertValidRun(
  plan: Readonly<PlaytestPlan>,
  run: Readonly<PlaytestRunReport>,
  label: string,
): void {
  const validation = validatePlaytestRunReportAgainstPlan(plan, run);
  if (!validation.valid)
    throw new Error(
      `${label} Run Report is invalid: ${validation.diagnostics.map((value) => value.message).join('; ')}`,
    );
}

function evaluate(
  plan: Readonly<PlaytestPlan>,
  run: Readonly<PlaytestRunReport>,
  label: string,
): CriticReport {
  const result = evaluatePlaytestRun(plan, run);
  if (!result.valid)
    throw new Error(
      `${label} Critic evaluation failed: ${result.diagnostics.map((value) => value.message).join('; ')}`,
    );
  return result.value;
}

export async function buildPlaytestCriticFixtureArtifacts(): Promise<readonly FixtureArtifact[]> {
  const [architecturePlan, manifest] = await Promise.all([
    readFile(architecturePlanPath, 'utf8').then((value) => JSON.parse(value) as unknown),
    readFile(manifestPath, 'utf8').then((value) => JSON.parse(value) as unknown),
  ]);
  const planResult = buildPlaytestPlan(architecturePlan, manifest);
  if (!planResult.valid)
    throw new Error(
      planResult.diagnostics.map((value) => `${value.code}: ${value.message}`).join('; '),
    );
  const plan = planResult.value;
  const runs = buildScenarioRuns(plan);
  for (const [label, run] of Object.entries(runs)) assertValidRun(plan, run, label);
  const critics = Object.fromEntries(
    Object.entries(runs).map(([label, run]) => [label, evaluate(plan, run, label)]),
  ) as Record<string, CriticReport>;
  const root = (relative: string) =>
    fileURLToPath(new URL(`../fixtures/${relative}`, import.meta.url));
  return [
    {
      label: 'Cliffwatch Playtest Plan',
      path: root('plans/cliffwatch.playtest-plan.json'),
      content: stringifyPlaytestPlan(plan),
    },
    {
      label: 'Cliffwatch pass Run Report',
      path: root('run-reports/cliffwatch-pass.playtest-run.json'),
      content: stringifyPlaytestRunReport(runs.pass),
    },
    {
      label: 'Blocked-door Run Report',
      path: root('run-reports/blocked-door.playtest-run.json'),
      content: stringifyPlaytestRunReport(runs.blockedDoor),
    },
    {
      label: 'Stair-failure Run Report',
      path: root('run-reports/stair-failure.playtest-run.json'),
      content: stringifyPlaytestRunReport(runs.stairFailure),
    },
    {
      label: 'Console-error Run Report',
      path: root('run-reports/console-error.playtest-run.json'),
      content: stringifyPlaytestRunReport(runs.consoleError),
    },
    {
      label: 'Cliffwatch pass Critic Report',
      path: root('critic-reports/cliffwatch-pass.critic.json'),
      content: stringifyCriticReport(critics.pass!),
    },
    {
      label: 'Blocked-door Critic Report',
      path: root('critic-reports/blocked-door.critic.json'),
      content: stringifyCriticReport(critics.blockedDoor!),
    },
    {
      label: 'Stair-failure Critic Report',
      path: root('critic-reports/stair-failure.critic.json'),
      content: stringifyCriticReport(critics.stairFailure!),
    },
    {
      label: 'Console-error Critic Report',
      path: root('critic-reports/console-error.critic.json'),
      content: stringifyCriticReport(critics.consoleError!),
    },
  ];
}

export async function generatePlaytestCriticFixtures(): Promise<void> {
  for (const artifact of await buildPlaytestCriticFixtureArtifacts()) {
    await mkdir(dirname(artifact.path), { recursive: true });
    await writeFile(artifact.path, artifact.content, 'utf8');
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  void generatePlaytestCriticFixtures().catch((error: unknown) => {
    process.stderr.write(
      `Playtest Critic fixture generation failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
