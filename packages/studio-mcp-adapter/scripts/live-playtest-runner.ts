import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  hashArchitecturePlan,
  validateArchitecturePlan,
  type ArchitecturePlan,
} from '@worldwright/architecture-planner';
import {
  evaluatePlaytestRun,
  hashCriticReport,
  hashPlaytestPlan,
  hashPlaytestRunReport,
  stringifyCriticReport,
  stringifyPlaytestPlan,
  stringifyPlaytestRunReport,
  validateCriticReportAgainstInputs,
  validatePlaytestPlanAgainstSources,
  validatePlaytestRunReportAgainstPlan,
  type PlaytestCheckpoint,
  type PlaytestPlan,
  type PlaytestRunReport,
  type PlaytestSegmentResult,
} from '@worldwright/playtest-critic';
import {
  hashRobloxChangeSet,
  hashRobloxManifest,
  validateRobloxChangeSet,
  validateRobloxManifest,
  type RobloxChangeSet,
  type RobloxManifest,
} from '@worldwright/roblox-compiler';

import { connectSelectedStudioMcpAdapterWithSandboxLeaseForLivePlaytest } from '../src/adapter.js';
import { STUDIO_MCP_PLAYTEST_MAX_CONSOLE_TOTAL_BYTES } from '../src/constants.js';
import { compareCodePoints, StudioAdapterError } from '../src/diagnostics.js';
import { hashCanonicalJson, stringifyCanonicalJson, type JsonValue } from '../src/json.js';
import {
  prepareStudioPlaytestControllerWithPrivateEvidenceSinks,
  type StudioPlaytestNavigationEvidence,
  type StudioPlaytestPathPreflightEvidence,
  type StudioPlaytestStartEvidence,
  type StudioPlaytestStopAndIntegrityEvidence,
} from '../src/playtest/controller.js';
import type { SanitizedStudioConsoleEvidence } from '../src/playtest/console.js';
import { createStudioPlaytestCaptureEvidence } from '../src/playtest/evidence.js';
import type { StudioMcpImageResult } from '../src/mcp/result.js';
import type {
  StudioPlaytestCaptureEvidence,
  StudioPlaytestCharacterSetupSuccess,
  StudioPlaytestClearanceProbeSuccess,
  StudioPlaytestPathProbeSuccess,
} from '../src/playtest/types.js';
import {
  buildReviewedLivePlaytestSequence,
  requireReviewedLivePlaytestConfirmation,
  stringifySanitizedLivePlaytestSummary,
  type ReviewedLivePlaytestSequence,
  type SanitizedLivePlaytestPreStartReview,
  type SanitizedLivePlaytestSummary,
} from './live-playtest-summary.js';

export interface ReviewedLivePlaytestArtifacts {
  readonly architecturePlan: ArchitecturePlan;
  readonly playtestPlan: PlaytestPlan;
  readonly manifest: RobloxManifest;
  readonly sandboxChangeSet: RobloxChangeSet;
  readonly sequence: ReviewedLivePlaytestSequence;
}

export interface LivePlaytestRunnerInput {
  readonly architecturePlan: unknown;
  readonly playtestPlan: unknown;
  readonly manifest: unknown;
  readonly sandboxChangeSet: unknown;
  readonly studioId: string;
  readonly sandboxLeaseId: string;
  readonly confirmedSequenceSha256: string;
  readonly confirmedPlaytestPlanSha256: string;
  readonly confirmedChangeSetSha256: string;
  readonly onPreStartReview?: (
    review: Readonly<SanitizedLivePlaytestPreStartReview>,
  ) => void | Promise<void>;
}

const LIVE_EVIDENCE_DIRECTORY = resolve('.worldwright/live-milestone-5');

interface ReservedLiveEvidence {
  readonly captureFiles: Map<string, FileHandle>;
  readonly privateConsoleArtifacts: Map<
    'console-baseline-private' | 'console-final-private',
    LiveEvidenceArtifact
  >;
  readonly runReport: FileHandle;
  readonly criticReport: FileHandle;
  readonly playtestPlan: FileHandle;
  readonly summary: FileHandle;
  readonly evidenceManifest: FileHandle;
  readonly rawConsoleBaseline: FileHandle;
  readonly rawConsoleFinal: FileHandle;
  readonly close: () => Promise<void>;
}

interface VerifiedLiveBuildEvidence {
  readonly expectedResultSnapshotSha256: string;
  readonly observedResultSnapshotSha256: string;
  readonly operationsPlanned: number;
  readonly operationsApplied: number;
  readonly chunksPlanned: number;
  readonly chunksCompleted: number;
  readonly mutationExecuteCalls: number;
  readonly sandboxLeaseClaimCalls: number;
}

export interface LiveEvidenceArtifact {
  readonly role:
    | 'playtest-plan'
    | 'playtest-run-report'
    | 'critic-report'
    | 'sanitized-summary'
    | 'console-baseline-private'
    | 'console-final-private';
  readonly sha256: string;
  readonly byteLength: number;
}

const LIVE_EVIDENCE_ARTIFACT_ROLES = [
  'console-baseline-private',
  'console-final-private',
  'critic-report',
  'playtest-plan',
  'playtest-run-report',
  'sanitized-summary',
] as const satisfies readonly LiveEvidenceArtifact['role'][];

export interface LiveEvidenceManifestInput {
  readonly artifacts: readonly LiveEvidenceArtifact[];
  readonly authorizedCaptureCheckpointIds: readonly string[];
  readonly viewportEvidence: readonly StudioPlaytestCaptureEvidence[];
}

/** @internal Emit only fixed roles, hashes, byte lengths, and sanitized capture records. */
export function stringifyLiveEvidenceManifest(input: Readonly<LiveEvidenceManifestInput>): string {
  const artifacts = [...input.artifacts].sort((left, right) =>
    compareCodePoints(left.role, right.role),
  );
  const actualRoles = artifacts.map((artifact) => artifact.role);
  if (
    actualRoles.length !== LIVE_EVIDENCE_ARTIFACT_ROLES.length ||
    actualRoles.some((role, index) => role !== LIVE_EVIDENCE_ARTIFACT_ROLES[index]) ||
    artifacts.some(
      (artifact) =>
        !/^[0-9a-f]{64}$/u.test(artifact.sha256) ||
        !Number.isSafeInteger(artifact.byteLength) ||
        artifact.byteLength < 0 ||
        artifact.byteLength > 16 * 1024 * 1024,
    )
  ) {
    throw new Error('The live evidence manifest requires all exact bounded artifact digests.');
  }
  const capturedCheckpointIds = new Set(input.viewportEvidence.map((entry) => entry.checkpointId));
  return stringifyCanonicalJson({
    schemaVersion: '0.1.0',
    artifacts: artifacts.map((artifact) => ({
      role: artifact.role,
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
    })),
    authorizedCaptureCheckpointIds: [...input.authorizedCaptureCheckpointIds],
    unavailableCaptureCheckpointIds: input.authorizedCaptureCheckpointIds.filter(
      (checkpointId) => !capturedCheckpointIds.has(checkpointId),
    ),
    viewportEvidence: input.viewportEvidence.map((entry) => ({
      evidenceId: entry.evidenceId,
      checkpointId: entry.checkpointId,
      mediaType: entry.mediaType,
      sha256: entry.sha256,
      byteLength: entry.byteLength,
    })),
  } as unknown as JsonValue);
}

function liveEvidenceArtifact(
  role: LiveEvidenceArtifact['role'],
  value: string | Uint8Array,
): LiveEvidenceArtifact {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  return Object.freeze({
    role,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
  });
}

async function reserveLiveEvidence(plan: Readonly<PlaytestPlan>): Promise<ReservedLiveEvidence> {
  await mkdir(LIVE_EVIDENCE_DIRECTORY, { recursive: true });
  const opened: Array<Readonly<{ path: string; handle: FileHandle }>> = [];
  try {
    for (const checkpointId of plan.captureCheckpoints) {
      const path = join(LIVE_EVIDENCE_DIRECTORY, `${checkpointId}.jpg`);
      opened.push({ path, handle: await open(path, 'wx') });
    }
    const runPath = join(LIVE_EVIDENCE_DIRECTORY, 'run-report.json');
    const criticPath = join(LIVE_EVIDENCE_DIRECTORY, 'critic-report.json');
    const planPath = join(LIVE_EVIDENCE_DIRECTORY, 'playtest-plan.json');
    const summaryPath = join(LIVE_EVIDENCE_DIRECTORY, 'summary.json');
    const manifestPath = join(LIVE_EVIDENCE_DIRECTORY, 'evidence-manifest.json');
    const baselinePath = join(LIVE_EVIDENCE_DIRECTORY, 'raw-console-baseline.private.json');
    const finalPath = join(LIVE_EVIDENCE_DIRECTORY, 'raw-console-final.private.json');
    opened.push({ path: runPath, handle: await open(runPath, 'wx') });
    opened.push({ path: criticPath, handle: await open(criticPath, 'wx') });
    opened.push({ path: planPath, handle: await open(planPath, 'wx') });
    opened.push({ path: summaryPath, handle: await open(summaryPath, 'wx') });
    opened.push({ path: manifestPath, handle: await open(manifestPath, 'wx') });
    opened.push({ path: baselinePath, handle: await open(baselinePath, 'wx') });
    opened.push({ path: finalPath, handle: await open(finalPath, 'wx') });
  } catch {
    await Promise.allSettled(opened.map(({ handle }) => handle.close()));
    await Promise.allSettled(opened.map(({ path }) => rm(path, { force: true })));
    throw new Error(
      'All confined live evidence outputs must be absent and reservable before Start.',
    );
  }
  const byPath = new Map(opened.map((entry) => [entry.path, entry.handle] as const));
  const captureFiles = new Map(
    plan.captureCheckpoints.map(
      (checkpointId) =>
        [checkpointId, byPath.get(join(LIVE_EVIDENCE_DIRECTORY, `${checkpointId}.jpg`))!] as const,
    ),
  );
  const runReport = byPath.get(join(LIVE_EVIDENCE_DIRECTORY, 'run-report.json'))!;
  const criticReport = byPath.get(join(LIVE_EVIDENCE_DIRECTORY, 'critic-report.json'))!;
  const playtestPlan = byPath.get(join(LIVE_EVIDENCE_DIRECTORY, 'playtest-plan.json'))!;
  const summary = byPath.get(join(LIVE_EVIDENCE_DIRECTORY, 'summary.json'))!;
  const evidenceManifest = byPath.get(join(LIVE_EVIDENCE_DIRECTORY, 'evidence-manifest.json'))!;
  const rawConsoleBaseline = byPath.get(
    join(LIVE_EVIDENCE_DIRECTORY, 'raw-console-baseline.private.json'),
  )!;
  const rawConsoleFinal = byPath.get(
    join(LIVE_EVIDENCE_DIRECTORY, 'raw-console-final.private.json'),
  )!;
  return {
    captureFiles,
    privateConsoleArtifacts: new Map(),
    runReport,
    criticReport,
    playtestPlan,
    summary,
    evidenceManifest,
    rawConsoleBaseline,
    rawConsoleFinal,
    close: async () => {
      await Promise.allSettled(opened.map(({ handle }) => handle.close()));
      await Promise.allSettled(
        [...captureFiles.keys()].map((checkpointId) =>
          rm(join(LIVE_EVIDENCE_DIRECTORY, `${checkpointId}.jpg`), { force: true }),
        ),
      );
    },
  };
}

async function writeReserved(handle: FileHandle, value: string | Uint8Array): Promise<void> {
  await handle.writeFile(value);
  await handle.sync();
  await handle.close();
}

function reservedCaptureSink(
  reservation: Readonly<ReservedLiveEvidence>,
): (
  image: Readonly<StudioMcpImageResult>,
  evidenceId: string,
  checkpointId: string,
) => Promise<StudioPlaytestCaptureEvidence> {
  return async (image, evidenceId, checkpointId) => {
    const handle = reservation.captureFiles.get(checkpointId);
    if (handle === undefined) {
      throw new Error('Viewport evidence was not pre-reserved for this confirmed checkpoint.');
    }
    const evidence = await createStudioPlaytestCaptureEvidence(image, evidenceId, checkpointId);
    try {
      await handle.writeFile(image.bytes);
      await handle.sync();
      await handle.close();
    } catch {
      throw new Error('A pre-reserved viewport evidence file could not be written exactly once.');
    }
    reservation.captureFiles.delete(checkpointId);
    return evidence;
  };
}

function reservedConsoleSink(
  reservation: Readonly<ReservedLiveEvidence>,
): (phase: 'baseline' | 'final', text: string) => Promise<void> {
  return async (phase, text) => {
    if (Buffer.byteLength(text, 'utf8') > STUDIO_MCP_PLAYTEST_MAX_CONSOLE_TOTAL_BYTES) {
      throw new Error('Raw private console evidence exceeds the fixed local evidence bound.');
    }
    const handle =
      phase === 'baseline' ? reservation.rawConsoleBaseline : reservation.rawConsoleFinal;
    const role = phase === 'baseline' ? 'console-baseline-private' : 'console-final-private';
    try {
      await writeReserved(handle, text);
      reservation.privateConsoleArtifacts.set(role, liveEvidenceArtifact(role, text));
    } catch {
      throw new Error('Raw private console evidence could not be written to its reservation.');
    }
  };
}

function isCaptureUnavailable(error: unknown): boolean {
  return (
    error instanceof StudioAdapterError &&
    error.diagnostics.length > 0 &&
    error.diagnostics.every((diagnostic) => diagnostic.code === 'studio.capture_unavailable')
  );
}

/** @internal The awaited sanitized review is an explicit gate before the sole Start call. */
export async function startStudioPlaytestAfterSanitizedReview(
  controller: Pick<
    Awaited<ReturnType<typeof prepareStudioPlaytestControllerWithPrivateEvidenceSinks>>,
    'start'
  >,
  review: Readonly<SanitizedLivePlaytestPreStartReview>,
  callback?: (value: Readonly<SanitizedLivePlaytestPreStartReview>) => void | Promise<void>,
): Promise<Awaited<ReturnType<typeof controller.start>>> {
  await callback?.(review);
  return controller.start();
}

function artifactFailure(): never {
  throw new Error('The reviewed live playtest artifacts are invalid or do not bind exactly.');
}

/** Validate all reviewed artifacts without opening MCP or retaining private live identity. */
export function reviewLivePlaytestArtifacts(
  input: Pick<
    LivePlaytestRunnerInput,
    'architecturePlan' | 'playtestPlan' | 'manifest' | 'sandboxChangeSet'
  >,
): ReviewedLivePlaytestArtifacts {
  const architectureValidation = validateArchitecturePlan(input.architecturePlan);
  const planValidation = validatePlaytestPlanAgainstSources(
    input.playtestPlan,
    input.architecturePlan,
    input.manifest,
  );
  const manifestValidation = validateRobloxManifest(input.manifest);
  const changeSetValidation = validateRobloxChangeSet(input.sandboxChangeSet);
  if (
    !architectureValidation.valid ||
    !planValidation.valid ||
    !manifestValidation.valid ||
    !changeSetValidation.valid
  ) {
    return artifactFailure();
  }
  const architecturePlan = architectureValidation.value;
  const playtestPlan = planValidation.value;
  const manifest = manifestValidation.value;
  const sandboxChangeSet = changeSetValidation.value;
  const architecturePlanSha256 = hashArchitecturePlan(architecturePlan);
  const playtestPlanSha256 = hashPlaytestPlan(playtestPlan);
  const robloxManifestSha256 = hashRobloxManifest(manifest);
  const sandboxChangeSetSha256 = hashRobloxChangeSet(sandboxChangeSet);
  if (
    playtestPlan.source.architecturePlanSha256 !== architecturePlanSha256 ||
    playtestPlan.source.robloxManifestSha256 !== robloxManifestSha256 ||
    playtestPlan.source.projectId !== architecturePlan.source.projectId ||
    playtestPlan.source.projectId !== manifest.source.projectId ||
    playtestPlan.source.manifestRootNodeId !== manifest.rootNodeId ||
    playtestPlan.source.manifestSourceWorldSpecSha256 !== manifest.source.worldSpecHash ||
    playtestPlan.source.expectedManagedInstanceCount !== manifest.nodes.length ||
    sandboxChangeSet.preconditions.projectId !== manifest.source.projectId ||
    sandboxChangeSet.preconditions.desiredManifestHash !== robloxManifestSha256
  ) {
    return artifactFailure();
  }
  return Object.freeze({
    architecturePlan,
    playtestPlan,
    manifest,
    sandboxChangeSet,
    sequence: buildReviewedLivePlaytestSequence({
      architecturePlanSha256,
      playtestPlanSha256,
      robloxManifestSha256,
      sandboxChangeSetSha256,
      projectId: manifest.source.projectId,
      manifestRootNodeId: manifest.rootNodeId,
      expectedManagedNodeCount: manifest.nodes.length,
      checkpointCount: playtestPlan.checkpoints.length,
      segmentCount: playtestPlan.segments.length,
      captureCount: playtestPlan.captureCheckpoints.length,
    }),
  });
}

type FailureCode = PlaytestSegmentResult['failureCodes'][number];

function humanoidState(value: string): PlaytestSegmentResult['character']['humanoidState'] {
  switch (value) {
    case 'Running':
      return 'running';
    case 'RunningNoPhysics':
      return 'running_no_physics';
    case 'Landed':
      return 'landed';
    case 'Freefall':
      return 'freefall';
    case 'FallingDown':
      return 'falling_down';
    case 'Dead':
      return 'dead';
    default:
      return 'unknown';
  }
}

/** @internal Pure Run Report sentinel builder used by the live runner and tests. */
export function buildUnattemptedSegmentResult(
  plan: Readonly<PlaytestPlan>,
  index: number,
): PlaytestSegmentResult {
  const segment = plan.segments[index]!;
  const source = plan.checkpoints.find((checkpoint) => checkpoint.id === segment.fromCheckpointId)!;
  const target = plan.checkpoints.find((checkpoint) => checkpoint.id === segment.toCheckpointId)!;
  return {
    segmentId: segment.id,
    sequence: segment.sequence,
    fromCheckpointId: segment.fromCheckpointId,
    toCheckpointId: segment.toCheckpointId,
    traversal: segment.traversal,
    path: {
      status: 'not_attempted',
      waypointCount: 0,
      totalPathDistance: 0,
      jumpWaypointCount: 0,
    },
    navigation: {
      requestedOnce: false,
      acknowledgmentCertain: false,
      independentlyReached: false,
    },
    arrival: { status: 'not_observed', targetPosition: { ...target.worldPosition } },
    character: {
      observed: false,
      alive: false,
      health: 0,
      maximumHealth: 0,
      humanoidState: 'unknown',
      fallDetected: false,
      expectedLevel: source.level,
    },
    clearance: {
      observed: false,
      supported: false,
      headClear: false,
      bodyClear: false,
      managedBlockerIds: [],
      unmanagedBlockerCount: 0,
    },
    failureCodes: [],
  };
}

/** @internal Pure failed-path Run Report builder used by the live runner and tests. */
export function buildFailedPathSegmentResult(
  plan: Readonly<PlaytestPlan>,
  index: number,
  preflight: Extract<StudioPlaytestPathPreflightEvidence, { readonly preflightPassed: true }>,
): PlaytestSegmentResult {
  const result = buildUnattemptedSegmentResult(plan, index);
  const source = plan.checkpoints.find(
    (checkpoint) => checkpoint.id === plan.segments[index]!.fromCheckpointId,
  )!;
  const path = preflight.path;
  const hasJumpEvidence = path.status === 'jump_required';
  return {
    ...result,
    path: hasJumpEvidence
      ? {
          status: 'failed',
          waypointCount: path.waypointCount,
          totalPathDistance: path.totalPathDistance,
          jumpWaypointCount: path.jumpWaypointCount,
          waypointDigestSha256: hashCanonicalJson(path.waypoints as unknown as JsonValue),
        }
      : { status: 'failed', waypointCount: 0, totalPathDistance: 0, jumpWaypointCount: 0 },
    character: {
      observed: true,
      alive: preflight.character.alive,
      health: preflight.character.health,
      maximumHealth: preflight.character.maximumHealth,
      humanoidState: humanoidState(preflight.character.humanoidState),
      fallDetected: false,
      expectedLevel: source.level,
      ...(preflight.character.currentLevel === undefined
        ? {}
        : { observedLevel: preflight.character.currentLevel }),
    },
    failureCodes: ['path-failed'],
  };
}

/**
 * @internal A failed character preflight ran neither path, navigation, arrival,
 * nor clearance probes, but its bounded source-checkpoint character observation
 * remains causal Run Report evidence.
 */
export function buildFailedPreflightSegmentResult(
  plan: Readonly<PlaytestPlan>,
  index: number,
  preflight: Extract<StudioPlaytestPathPreflightEvidence, { readonly preflightPassed: false }>,
): PlaytestSegmentResult {
  const result = buildUnattemptedSegmentResult(plan, index);
  const source = plan.checkpoints.find(
    (checkpoint) => checkpoint.id === plan.segments[index]!.fromCheckpointId,
  )!;
  const failureCodes: FailureCode[] = [];
  if (!preflight.character.alive || preflight.character.health <= 0)
    failureCodes.push('character-dead');
  if (preflight.status === 'fell') failureCodes.push('character-fell');
  if (
    preflight.character.currentLevel !== undefined &&
    preflight.character.currentLevel !== source.level
  )
    failureCodes.push('wrong-floor');
  return {
    ...result,
    character: {
      observed: true,
      alive: preflight.character.alive,
      health: preflight.character.health,
      maximumHealth: preflight.character.maximumHealth,
      humanoidState: humanoidState(preflight.character.humanoidState),
      fallDetected: preflight.status === 'fell',
      expectedLevel: source.level,
      ...(preflight.character.currentLevel === undefined
        ? {}
        : { observedLevel: preflight.character.currentLevel }),
    },
    failureCodes: [...new Set(failureCodes)].sort(compareCodePoints),
  };
}

/** @internal Pure observed-segment Run Report builder used by the live runner and tests. */
export function buildObservedSegmentResult(
  plan: Readonly<PlaytestPlan>,
  index: number,
  path: Readonly<StudioPlaytestPathProbeSuccess>,
  navigation: Readonly<StudioPlaytestNavigationEvidence>,
  clearance: Readonly<StudioPlaytestClearanceProbeSuccess> | undefined,
  viewportEvidenceId: string | undefined,
): PlaytestSegmentResult {
  const segment = plan.segments[index]!;
  const target = plan.checkpoints.find((checkpoint) => checkpoint.id === segment.toCheckpointId)!;
  const state = navigation.finalState;
  const reached = navigation.arrival.status === 'reached';
  const failureCodes: FailureCode[] = [];
  if (!reached) failureCodes.push('navigation-failed', 'arrival-missed');
  if (navigation.arrival.status === 'dead') failureCodes.push('character-dead');
  if (navigation.arrival.status === 'fell') failureCodes.push('character-fell');
  if (navigation.arrival.status === 'wrong_floor') failureCodes.push('wrong-floor');
  if (clearance !== undefined && !clearance.supported) failureCodes.push('support-missing');
  if (clearance !== undefined && !clearance.headClear) failureCodes.push('head-blocked');
  if (clearance !== undefined && !clearance.bodyClear) failureCodes.push('body-blocked');
  return {
    segmentId: segment.id,
    sequence: segment.sequence,
    fromCheckpointId: segment.fromCheckpointId,
    toCheckpointId: segment.toCheckpointId,
    traversal: segment.traversal,
    path: {
      status: 'success',
      waypointCount: path.waypointCount,
      totalPathDistance: path.totalPathDistance,
      jumpWaypointCount: path.jumpWaypointCount,
      waypointDigestSha256: hashCanonicalJson(path.waypoints as unknown as JsonValue),
    },
    navigation: {
      requestedOnce: true,
      acknowledgmentCertain: navigation.acknowledgmentCertain,
      independentlyReached: navigation.independentlyReached,
      finalPosition: { ...state.position },
      horizontalError: navigation.arrival.horizontalError,
      verticalError: navigation.arrival.verticalError,
      finalVelocityMagnitude: state.linearVelocityMagnitude,
    },
    arrival: {
      status: reached ? 'reached' : 'missed',
      targetPosition: { ...target.worldPosition },
      observedPosition: { ...state.position },
      horizontalError: navigation.arrival.horizontalError,
      verticalError: navigation.arrival.verticalError,
    },
    character: {
      observed: true,
      alive: state.alive,
      health: state.health,
      maximumHealth: state.maximumHealth,
      humanoidState: humanoidState(state.humanoidState),
      fallDetected: navigation.arrival.status === 'fell',
      expectedLevel: target.level,
      ...(state.currentLevel === undefined ? {} : { observedLevel: state.currentLevel }),
    },
    clearance:
      clearance === undefined
        ? {
            observed: false,
            supported: false,
            headClear: false,
            bodyClear: false,
            managedBlockerIds: [],
            unmanagedBlockerCount: 0,
          }
        : {
            observed: true,
            supported: clearance.supported,
            headClear: clearance.headClear,
            bodyClear: clearance.bodyClear,
            ...(clearance.managedSupportEntityId === undefined
              ? {}
              : { supportEntityId: clearance.managedSupportEntityId }),
            managedBlockerIds: [...clearance.managedBlockerIds],
            unmanagedBlockerCount: clearance.unmanagedBlockerCount,
          },
    ...(viewportEvidenceId === undefined ? {} : { viewportEvidenceId }),
    failureCodes: [...new Set(failureCodes)].sort(compareCodePoints),
  };
}

function checkpointSourceIds(
  checkpoints: readonly PlaytestCheckpoint[],
  reached: ReadonlySet<string>,
  type: 'room' | 'floor',
): readonly string[] {
  const values = checkpoints.filter((checkpoint) => reached.has(checkpoint.id));
  return [
    ...new Set(
      type === 'room'
        ? values.flatMap((checkpoint) =>
            checkpoint.type === 'room_center' ? [checkpoint.roomId] : [],
          )
        : values.map((checkpoint) => checkpoint.sourceFloorId),
    ),
  ].sort(compareCodePoints);
}

function coverage(
  plan: Readonly<PlaytestPlan>,
  segmentResults: readonly PlaytestSegmentResult[],
  setupSucceeded: boolean,
): PlaytestRunReport['coverage'] {
  const reached = new Set<string>();
  if (setupSucceeded) reached.add(plan.setup.checkpointId);
  for (const result of segmentResults) {
    if (result.arrival.status === 'reached' && result.navigation.independentlyReached) {
      reached.add(result.toCheckpointId);
    }
  }
  const missedCheckpointIds = plan.requiredCoverage.checkpoints.ids
    .filter((id) => !reached.has(id))
    .sort(compareCodePoints);
  const reachedRooms = checkpointSourceIds(plan.checkpoints, reached, 'room');
  const reachedFloors = checkpointSourceIds(plan.checkpoints, reached, 'floor');
  const checkpointById = new Map(
    plan.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint] as const),
  );
  const traversedStairs = new Set<string>();
  for (const result of segmentResults) {
    if (
      result.traversal !== 'stair' ||
      result.arrival.status !== 'reached' ||
      !result.navigation.independentlyReached
    ) {
      continue;
    }
    const from = checkpointById.get(result.fromCheckpointId);
    const to = checkpointById.get(result.toCheckpointId);
    if (
      from === undefined ||
      to === undefined ||
      from.level === to.level ||
      result.character.observedLevel !== to.level
    ) {
      continue;
    }
    const stairRunId =
      to.type === 'stair_landing' || to.type === 'stair_hall'
        ? to.stairRunId
        : from.type === 'stair_landing' || from.type === 'stair_hall'
          ? from.stairRunId
          : undefined;
    if (stairRunId !== undefined) traversedStairs.add(stairRunId);
  }
  return {
    requiredCheckpointCount: plan.requiredCoverage.checkpoints.count,
    reachedCheckpointCount: plan.requiredCoverage.checkpoints.count - missedCheckpointIds.length,
    missedCheckpointIds,
    requiredRoomCount: plan.requiredCoverage.rooms.count,
    reachedRoomCount: reachedRooms.length,
    missedRoomIds: plan.requiredCoverage.rooms.ids.filter((id) => !reachedRooms.includes(id)),
    requiredFloorCount: plan.requiredCoverage.floors.count,
    reachedFloorCount: reachedFloors.length,
    missedFloorIds: plan.requiredCoverage.floors.ids.filter((id) => !reachedFloors.includes(id)),
    requiredStairRunCount: plan.requiredCoverage.stairRuns.count,
    traversedStairRunCount: traversedStairs.size,
    missedStairRunIds: plan.requiredCoverage.stairRuns.ids.filter((id) => !traversedStairs.has(id)),
  };
}

function allRequiredCoverageReached(value: Readonly<PlaytestRunReport['coverage']>): boolean {
  return (
    value.missedCheckpointIds.length === 0 &&
    value.missedRoomIds.length === 0 &&
    value.missedFloorIds.length === 0 &&
    value.missedStairRunIds.length === 0
  );
}

export interface LivePlaytestRunReportCandidateInput {
  readonly architecturePlan: ArchitecturePlan;
  readonly playtestPlan: PlaytestPlan;
  readonly manifest: RobloxManifest;
  readonly prePlayEditSnapshotSha256: string;
  readonly startEvidence: StudioPlaytestStartEvidence;
  readonly setupEvidence: StudioPlaytestCharacterSetupSuccess;
  readonly consoleEvidence: SanitizedStudioConsoleEvidence;
  readonly stopEvidence: StudioPlaytestStopAndIntegrityEvidence;
  readonly segmentResults: readonly PlaytestSegmentResult[];
  readonly viewportEvidence: readonly StudioPlaytestCaptureEvidence[];
}

/** @internal Build the exact strict candidate which is then revalidated against the Plan. */
export function buildLivePlaytestRunReportCandidate(
  input: Readonly<LivePlaytestRunReportCandidateInput>,
): PlaytestRunReport {
  const attemptedResults = input.segmentResults.filter(
    (result) => result.path.status !== 'not_attempted',
  );
  const observedCharacterResults = input.segmentResults.filter(
    (result) => result.character.observed,
  );
  const navigationRequested = input.segmentResults.some(
    (result) => result.navigation.requestedOnce,
  );
  const attempted = attemptedResults.length;
  const reached = input.segmentResults.filter(
    (result) => result.arrival.status === 'reached',
  ).length;
  const pathFailures = input.segmentResults.filter(
    (result) => result.path.status === 'failed',
  ).length;
  const arrivalFailures = input.segmentResults.filter(
    (result) => result.arrival.status === 'missed',
  ).length;
  const clearanceFailures = input.segmentResults.filter(
    (result) =>
      result.clearance.observed &&
      (!result.clearance.supported || !result.clearance.headClear || !result.clearance.bodyClear),
  ).length;
  const runCoverage = coverage(input.playtestPlan, input.segmentResults, true);
  return {
    schemaVersion: '0.1.0',
    criticVersion: '0.1.0',
    source: {
      playtestPlanSha256: hashPlaytestPlan(input.playtestPlan),
      architecturePlanSha256: hashArchitecturePlan(input.architecturePlan),
      robloxManifestSha256: hashRobloxManifest(input.manifest),
      projectId: input.manifest.source.projectId,
      manifestRootNodeId: input.manifest.rootNodeId,
      manifestSourceWorldSpecSha256: input.manifest.source.worldSpecHash,
    },
    environment: {
      placeId: 0,
      gameId: 0,
      editBaseSnapshotSha256: input.prePlayEditSnapshotSha256,
      managedNodeCount: input.manifest.nodes.length,
      playDataModelsUsed: navigationRequested ? ['Client', 'Edit', 'Server'] : ['Edit', 'Server'],
      exactStudioSelected: true,
      sandboxLeaseVerified: true,
    },
    start: {
      requested: input.startEvidence.requested,
      acknowledgmentCertain: input.startEvidence.acknowledgmentCertain,
      observedPlayRunning: input.startEvidence.observedPlayRunning,
      identityProbePassed: input.startEvidence.identityProbePassed,
      characterReady: input.startEvidence.characterReady,
      failureCode: input.startEvidence.acknowledgmentCertain ? 'none' : 'start-uncertain',
    },
    setup: {
      attempted: true,
      succeeded: true,
      requestedPosition: { ...input.playtestPlan.setup.worldPosition },
      verifiedPosition: { ...input.setupEvidence.position },
      excludedFromScoring: true,
      failureCode: 'none',
    },
    segmentResults: input.segmentResults.map((result) => ({ ...result })),
    consoleEvidence: {
      ...input.consoleEvidence,
      entries: input.consoleEvidence.entries.map((entry) => ({ ...entry })),
    },
    viewportEvidence: input.viewportEvidence.map((entry) => ({ ...entry })),
    coverage: runCoverage,
    stop: {
      requested: input.stopEvidence.stop.requested,
      acknowledgmentCertain: input.stopEvidence.stop.acknowledgmentCertain,
      observedEditRestored: input.stopEvidence.stop.observedEditRestored,
      identityVerifiedBeforeSecondStop: input.stopEvidence.stop.identityVerifiedBeforeSecondStop,
      failureCode: input.stopEvidence.stop.acknowledgmentCertain ? 'none' : 'stop-uncertain',
    },
    editIntegrity: { ...input.stopEvidence.editIntegrity },
    summary: {
      status: attempted === input.playtestPlan.segments.length ? 'completed' : 'aborted',
      segmentsPlanned: input.playtestPlan.segments.length,
      segmentsAttempted: attempted,
      segmentsReached: reached,
      allRequiredCoverageReached: allRequiredCoverageReached(runCoverage),
      characterSurvived:
        input.startEvidence.characterReady &&
        observedCharacterResults.length > 0 &&
        observedCharacterResults.every(
          (result) =>
            result.character.alive && result.character.health > 0 && !result.character.fallDetected,
        ),
      pathFailures,
      arrivalFailures,
      clearanceFailures,
      consoleErrors: input.consoleEvidence.newErrorCount,
      consoleWarnings: input.consoleEvidence.newWarningCount,
      editIntegrityPassed:
        input.stopEvidence.editIntegrity.exactMatch &&
        input.stopEvidence.editIntegrity.finalManifestNoopOperationCount === 0,
    },
  };
}

/** Execute one confirmed private live sequence and return only its sanitized summary. */
export async function runReviewedLivePlaytest(
  input: Readonly<LivePlaytestRunnerInput>,
): Promise<SanitizedLivePlaytestSummary> {
  const reviewed = reviewLivePlaytestArtifacts(input);
  requireReviewedLivePlaytestConfirmation(reviewed.sequence, input.confirmedSequenceSha256);
  if (
    input.confirmedPlaytestPlanSha256 !== hashPlaytestPlan(reviewed.playtestPlan) ||
    input.confirmedChangeSetSha256 !== hashRobloxChangeSet(reviewed.sandboxChangeSet)
  ) {
    throw new Error(
      'Exact full Playtest Plan and complete Change Set hash confirmations are required.',
    );
  }

  const mutationAdapter = await connectSelectedStudioMcpAdapterWithSandboxLeaseForLivePlaytest(
    input.studioId,
    input.sandboxLeaseId,
  );
  let buildEvidence: VerifiedLiveBuildEvidence | undefined;
  try {
    const applied = await mutationAdapter.applyChangeSetDetailed(reviewed.sandboxChangeSet);
    const expectedResultSnapshotSha256 = reviewed.sandboxChangeSet.preconditions.resultSnapshotHash;
    if (
      !applied.result.success ||
      reviewed.sandboxChangeSet.operations.length !== 400 ||
      reviewed.sandboxChangeSet.operations.some((operation) => operation.type !== 'create') ||
      applied.result.finalSnapshotHash !== expectedResultSnapshotSha256 ||
      applied.transportReport.changeSetHash !== hashRobloxChangeSet(reviewed.sandboxChangeSet) ||
      applied.transportReport.operationsPlanned !== 400 ||
      applied.transportReport.operationsAppliedBeforeFailure !== 400 ||
      applied.transportReport.chunksPlanned !== 13 ||
      applied.transportReport.chunksCompleted !== 13 ||
      applied.transportReport.mutationExecuteCalls > 16 ||
      applied.transportReport.sandboxLeaseClaimCalls !== 1 ||
      applied.transportReport.finalOutcome !== 'applied'
    ) {
      throw new Error('The reviewed sandbox Change Set did not apply and verify exactly.');
    }
    buildEvidence = Object.freeze({
      expectedResultSnapshotSha256,
      observedResultSnapshotSha256: applied.result.finalSnapshotHash,
      operationsPlanned: applied.transportReport.operationsPlanned,
      operationsApplied: applied.transportReport.operationsAppliedBeforeFailure,
      chunksPlanned: applied.transportReport.chunksPlanned,
      chunksCompleted: applied.transportReport.chunksCompleted,
      mutationExecuteCalls: applied.transportReport.mutationExecuteCalls,
      sandboxLeaseClaimCalls: applied.transportReport.sandboxLeaseClaimCalls,
    });
  } finally {
    await mutationAdapter.close();
  }
  if (buildEvidence === undefined) {
    throw new Error('The reviewed sandbox build evidence is incomplete.');
  }

  const reservation = await reserveLiveEvidence(reviewed.playtestPlan);
  const serializedPlaytestPlan = stringifyPlaytestPlan(reviewed.playtestPlan);
  try {
    await writeReserved(reservation.playtestPlan, serializedPlaytestPlan);
  } catch {
    await reservation.close();
    throw new Error('The pre-reserved Playtest Plan evidence could not be written exactly once.');
  }
  let controller: Awaited<
    ReturnType<typeof prepareStudioPlaytestControllerWithPrivateEvidenceSinks>
  >;
  try {
    controller = await prepareStudioPlaytestControllerWithPrivateEvidenceSinks(
      {
        studioId: input.studioId,
        sandboxLeaseId: input.sandboxLeaseId,
        sandboxChangeSet: reviewed.sandboxChangeSet,
        desiredManifest: reviewed.manifest,
        architecturePlan: reviewed.architecturePlan,
        playtestPlan: reviewed.playtestPlan,
        confirmedPlaytestPlanSha256: input.confirmedPlaytestPlanSha256,
      },
      {
        capture: reservedCaptureSink(reservation),
        console: reservedConsoleSink(reservation),
      },
    );
  } catch (error) {
    await reservation.close();
    throw error;
  }
  let startEvidence: Awaited<ReturnType<typeof controller.start>> | undefined;
  let setupEvidence: Awaited<ReturnType<typeof controller.setupCharacter>> | undefined;
  let consoleEvidence: Awaited<ReturnType<typeof controller.collectConsoleEvidence>> | undefined;
  let stopEvidence: StudioPlaytestStopAndIntegrityEvidence | undefined;
  const segmentResults: PlaytestSegmentResult[] = [];
  const viewportEvidence: StudioPlaytestCaptureEvidence[] = [];
  const captureByCheckpoint = new Map<string, StudioPlaytestCaptureEvidence>();
  let runError: unknown;
  try {
    startEvidence = await startStudioPlaytestAfterSanitizedReview(
      controller,
      {
        schemaVersion: '0.1.0',
        action: 'worldwright-live-playtest-pre-start-review',
        projectId: reviewed.manifest.source.projectId,
        architecturePlanSha256: hashArchitecturePlan(reviewed.architecturePlan),
        playtestPlanSha256: hashPlaytestPlan(reviewed.playtestPlan),
        robloxManifestSha256: hashRobloxManifest(reviewed.manifest),
        sandboxChangeSetSha256: hashRobloxChangeSet(reviewed.sandboxChangeSet),
        roomCount: reviewed.playtestPlan.requiredCoverage.rooms.count,
        floorCount: reviewed.playtestPlan.requiredCoverage.floors.count,
        stairRunCount: reviewed.playtestPlan.requiredCoverage.stairRuns.count,
        checkpointCount: reviewed.playtestPlan.checkpoints.length,
        segmentCount: reviewed.playtestPlan.segments.length,
        captureCount: reviewed.playtestPlan.captureCheckpoints.length,
        exactEditSnapshotSha256: controller.preflightEvidence.prePlayEditSnapshotSha256,
        sandboxLeaseMatched: true,
      },
      input.onPreStartReview,
    );
    await controller.waitForCharacter();
    setupEvidence = await controller.setupCharacter();
    if (
      reviewed.playtestPlan.captureCheckpoints.includes(reviewed.playtestPlan.setup.checkpointId)
    ) {
      try {
        const capture = await controller.captureCheckpoint(
          reviewed.playtestPlan.setup.checkpointId,
        );
        viewportEvidence.push(capture);
        captureByCheckpoint.set(capture.checkpointId, capture);
      } catch (error) {
        if (!isCaptureUnavailable(error)) throw error;
      }
    }
    for (const [index, segment] of reviewed.playtestPlan.segments.entries()) {
      const preflight = await controller.probeNextPath(segment.id);
      if (!preflight.preflightPassed) {
        segmentResults.push(
          buildFailedPreflightSegmentResult(reviewed.playtestPlan, index, preflight),
        );
        break;
      }
      const path = preflight.path;
      if (path.status !== 'success') {
        segmentResults.push(buildFailedPathSegmentResult(reviewed.playtestPlan, index, preflight));
        break;
      }
      const navigation = await controller.navigateSegment(segment.id);
      const clearance = navigation.independentlyReached
        ? await controller.observeClearance(segment.id)
        : undefined;
      let capture: StudioPlaytestCaptureEvidence | undefined;
      if (
        navigation.independentlyReached &&
        clearance !== undefined &&
        reviewed.playtestPlan.captureCheckpoints.includes(segment.toCheckpointId) &&
        !captureByCheckpoint.has(segment.toCheckpointId)
      ) {
        try {
          capture = await controller.captureCheckpoint(segment.toCheckpointId);
          viewportEvidence.push(capture);
          captureByCheckpoint.set(capture.checkpointId, capture);
        } catch (error) {
          if (!isCaptureUnavailable(error)) throw error;
        }
      }
      segmentResults.push(
        buildObservedSegmentResult(
          reviewed.playtestPlan,
          index,
          path,
          navigation,
          clearance,
          capture?.evidenceId ?? captureByCheckpoint.get(segment.toCheckpointId)?.evidenceId,
        ),
      );
      if (
        !navigation.independentlyReached ||
        clearance === undefined ||
        !clearance.supported ||
        !clearance.bodyClear ||
        !clearance.headClear
      ) {
        break;
      }
    }
    while (segmentResults.length < reviewed.playtestPlan.segments.length) {
      segmentResults.push(
        buildUnattemptedSegmentResult(reviewed.playtestPlan, segmentResults.length),
      );
    }
    consoleEvidence = await controller.collectConsoleEvidence();
  } catch (error) {
    runError = error;
  } finally {
    if (startEvidence !== undefined) {
      try {
        stopEvidence = await controller.stopAndVerify();
      } catch (error) {
        if (runError === undefined) runError = error;
      }
    }
    try {
      await controller.close();
    } catch (error) {
      if (runError === undefined) runError = error;
    }
  }
  if (runError !== undefined) {
    await reservation.close();
    throw runError;
  }
  if (
    startEvidence === undefined ||
    setupEvidence === undefined ||
    consoleEvidence === undefined ||
    stopEvidence === undefined
  ) {
    await reservation.close();
    throw new Error('The live playtest did not produce complete bounded lifecycle evidence.');
  }

  const runCandidate = buildLivePlaytestRunReportCandidate({
    architecturePlan: reviewed.architecturePlan,
    playtestPlan: reviewed.playtestPlan,
    manifest: reviewed.manifest,
    prePlayEditSnapshotSha256: controller.preflightEvidence.prePlayEditSnapshotSha256,
    startEvidence,
    setupEvidence,
    consoleEvidence,
    stopEvidence,
    segmentResults,
    viewportEvidence,
  });
  const runValidation = validatePlaytestRunReportAgainstPlan(reviewed.playtestPlan, runCandidate);
  if (!runValidation.valid) {
    await reservation.close();
    throw new Error('The bounded Studio evidence did not form a valid strict Playtest Run Report.');
  }
  const runReport = runValidation.value;
  const evaluated = evaluatePlaytestRun(reviewed.playtestPlan, runReport);
  if (!evaluated.valid) {
    await reservation.close();
    throw new Error('The pure Critic could not evaluate the strict Run Report.');
  }
  const criticValidation = validateCriticReportAgainstInputs(
    reviewed.playtestPlan,
    runReport,
    evaluated.value,
  );
  if (!criticValidation.valid) {
    await reservation.close();
    throw new Error('The deterministic Critic Report failed exact revalidation.');
  }
  const criticReport = criticValidation.value;
  const sanitizedSummary: SanitizedLivePlaytestSummary = Object.freeze({
    schemaVersion: '0.1.0',
    placeId: 0,
    gameId: 0,
    prePlayEditSnapshotSha256: runReport.editIntegrity.prePlayEditSnapshotSha256,
    postPlayEditSnapshotSha256: runReport.editIntegrity.postPlayEditSnapshotSha256!,
    playtestPlanSha256: runReport.source.playtestPlanSha256,
    robloxManifestSha256: runReport.source.robloxManifestSha256,
    sandboxChangeSetSha256: hashRobloxChangeSet(reviewed.sandboxChangeSet),
    expectedBuildResultSnapshotSha256: buildEvidence.expectedResultSnapshotSha256,
    observedBuildResultSnapshotSha256: buildEvidence.observedResultSnapshotSha256,
    buildOperationsPlanned: buildEvidence.operationsPlanned,
    buildOperationsApplied: buildEvidence.operationsApplied,
    buildChunksPlanned: buildEvidence.chunksPlanned,
    buildChunksCompleted: buildEvidence.chunksCompleted,
    buildMutationExecuteCalls: buildEvidence.mutationExecuteCalls,
    buildSandboxLeaseClaimCalls: buildEvidence.sandboxLeaseClaimCalls,
    checkpointCount: reviewed.playtestPlan.checkpoints.length,
    segmentCount: reviewed.playtestPlan.segments.length,
    segmentsReached: runReport.summary.segmentsReached,
    pathSuccessCount: runReport.segmentResults.filter((result) => result.path.status === 'success')
      .length,
    roomCountReached: runReport.coverage.reachedRoomCount,
    roomCountRequired: runReport.coverage.requiredRoomCount,
    floorCountReached: runReport.coverage.reachedFloorCount,
    floorCountRequired: runReport.coverage.requiredFloorCount,
    stairRunCountTraversed: runReport.coverage.traversedStairRunCount,
    stairRunCountRequired: runReport.coverage.requiredStairRunCount,
    pathFailureCount: runReport.summary.pathFailures,
    navigationSuccessCount: runReport.segmentResults.filter(
      (result) => result.navigation.requestedOnce && result.navigation.independentlyReached,
    ).length,
    navigationFailureCount: runReport.segmentResults.filter(
      (result) => result.navigation.requestedOnce && !result.navigation.independentlyReached,
    ).length,
    characterSurvived: runReport.summary.characterSurvived,
    clearanceSuccessCount: runReport.segmentResults.filter(
      (result) =>
        result.clearance.observed &&
        result.clearance.supported &&
        result.clearance.bodyClear &&
        result.clearance.headClear,
    ).length,
    clearanceFailureCount: runReport.summary.clearanceFailures,
    consoleErrorCount: runReport.summary.consoleErrors,
    consoleWarningCount: runReport.summary.consoleWarnings,
    criticStatus: criticReport.status,
    criticFindingCodes: Object.freeze(
      [...new Set(criticReport.findings.map((finding) => finding.code))].sort(compareCodePoints),
    ),
    finalManifestNoopOperationCount: runReport.editIntegrity.finalManifestNoopOperationCount,
    playtestRunReportSha256: hashPlaytestRunReport(runReport),
    criticReportSha256: hashCriticReport(criticReport),
    viewportEvidence: Object.freeze(viewportEvidence.map((entry) => Object.freeze({ ...entry }))),
  });
  const serializedRunReport = stringifyPlaytestRunReport(runReport);
  const serializedCriticReport = stringifyCriticReport(criticReport);
  const serializedSummary = stringifySanitizedLivePlaytestSummary(sanitizedSummary);
  const baselineConsoleArtifact = reservation.privateConsoleArtifacts.get(
    'console-baseline-private',
  );
  const finalConsoleArtifact = reservation.privateConsoleArtifacts.get('console-final-private');
  if (baselineConsoleArtifact === undefined || finalConsoleArtifact === undefined) {
    await reservation.close();
    throw new Error('The private bounded console evidence digests are incomplete.');
  }
  const serializedEvidenceManifest = stringifyLiveEvidenceManifest({
    artifacts: [
      liveEvidenceArtifact('playtest-plan', serializedPlaytestPlan),
      liveEvidenceArtifact('playtest-run-report', serializedRunReport),
      liveEvidenceArtifact('critic-report', serializedCriticReport),
      liveEvidenceArtifact('sanitized-summary', serializedSummary),
      baselineConsoleArtifact,
      finalConsoleArtifact,
    ],
    authorizedCaptureCheckpointIds: reviewed.playtestPlan.captureCheckpoints,
    viewportEvidence: sanitizedSummary.viewportEvidence,
  });
  try {
    await writeReserved(reservation.runReport, serializedRunReport);
    await writeReserved(reservation.criticReport, serializedCriticReport);
    await writeReserved(reservation.evidenceManifest, serializedEvidenceManifest);
    await writeReserved(reservation.summary, serializedSummary);
  } catch {
    throw new Error('The pre-reserved strict live reports could not be written exactly once.');
  } finally {
    await reservation.close();
  }
  if (criticReport.status === 'fail') {
    throw new Error('The live playtest completed, but the pure Critic reported hard findings.');
  }
  return sanitizedSummary;
}
