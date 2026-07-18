import { createHash } from 'node:crypto';

import {
  hashPlaytestPlan,
  validatePlaytestPlanAgainstSources,
  type PlaytestCheckpoint,
  type PlaytestPlan,
  type PlaytestSegment,
} from '@worldwright/playtest-critic';
import {
  hashRobloxChangeSet,
  hashRobloxManifest,
  hashRobloxSnapshot,
  planRobloxChangeSet,
  validateRobloxChangeSet,
  validateRobloxManifest,
  type RobloxChangeSet,
  type RobloxManifest,
  type RobloxSnapshot,
} from '@worldwright/roblox-compiler';

import { connectReadOnlyStudioMcpAdapter, type StudioMcpRobloxAdapter } from '../adapter.js';
import { parseStudioBridgeResponse } from '../bridge/response.js';
import { buildProbeProgram } from '../bridge/snapshot-program.js';
import {
  STUDIO_MCP_PLAYTEST_CHARACTER_TIMEOUT_MS,
  STUDIO_MCP_PLAYTEST_MAX_PATH_WAYPOINTS,
  STUDIO_MCP_PLAYTEST_MAX_SEGMENTS,
  STUDIO_MCP_PLAYTEST_NAVIGATION_TIMEOUT_MS,
  STUDIO_MCP_PLAYTEST_POLL_INTERVAL_MS,
  STUDIO_MCP_PLAYTEST_START_TIMEOUT_MS,
  STUDIO_MCP_PLAYTEST_STATE_TRANSITION_TIMEOUT_MS,
  STUDIO_MCP_PLAYTEST_STOP_TIMEOUT_MS,
  STUDIO_MCP_PLAYTEST_TOTAL_TIMEOUT_MS,
} from '../constants.js';
import {
  createStudioReconnectState,
  StudioExactSessionLease,
  type StudioMcpClientFactory,
  type StudioReconnectState,
} from '../connection/session-lease.js';
import { StudioAdapterError, studioDiagnostic } from '../diagnostics.js';
import { inspectJsonCompatibility } from '../json.js';
import {
  captureStudioViewport,
  connectStudioPlaytestMcp,
  executeFixedStudioBridgeProgram,
  executeFixedStudioPlaytestProgram,
  invokeStudioCharacterNavigation,
  invokeStudioPlaytestStartStop,
  poisonStudioMcpClient,
  readStudioConsoleText,
  type StudioMcpClient,
} from '../mcp/client.js';
import type { StudioMcpImageResult } from '../mcp/result.js';
import {
  assertSandboxStudioProbe,
  selectStudioSession,
  type StudioSandboxProbe,
  type StudioSessionSummary,
} from '../mcp/session.js';
import { createSandboxLeaseRecord } from '../sandbox-lease/record.js';
import { buildSandboxLeaseProgram } from '../sandbox-lease/program.js';
import { buildBoundSandboxSnapshotRequest } from '../sandbox-lease/request.js';
import { parseStudioSandboxLeaseResponse } from '../sandbox-lease/response.js';
import type { StudioSandboxLeaseRecord } from '../sandbox-lease/types.js';
import { snapshotFromStudioCompact } from '../snapshot.js';
import { createStudioPlaytestCaptureEvidence } from './evidence.js';
import { assessStudioPlaytestArrival, type StudioPlaytestArrivalAssessment } from './navigation.js';
import { buildStudioPlaytestProbeProgram } from './program.js';
import {
  buildStudioPlaytestCharacterSetupRequest,
  buildStudioPlaytestClearanceProbeRequest,
  buildStudioPlaytestIdentityProbeRequest,
  buildStudioPlaytestPathProbeRequest,
  buildStudioPlaytestPlayerStateRequest,
} from './request.js';
import { parseStudioPlaytestProbeResponse } from './response.js';
import { readStudioPlaytestSessionState, waitForStudioPlaytestSessionPhase } from './session.js';
import {
  observeStudioConsoleText,
  sanitizeStudioConsoleObservations,
  type SanitizedStudioConsoleEvidence,
  type StudioConsoleObservation,
} from './console.js';
import type {
  StudioPlaytestCaptureEvidence,
  StudioPlaytestCharacterSetupSuccess,
  StudioPlaytestClearanceProbeSuccess,
  StudioPlaytestFloor,
  StudioPlaytestIdentity,
  StudioPlaytestIdentityProbeSuccess,
  StudioPlaytestPathProbeSuccess,
  StudioPlaytestPlayerStateSuccess,
  StudioPlaytestProbeAction,
  StudioPlaytestProbeRequest,
  StudioPlaytestProbeResponse,
  StudioPlaytestVector,
} from './types.js';

const CONTROLLER_CONSTRUCTION_TOKEN = Symbol('worldwright.studioPlaytest.controllerConstruction');
const IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

type ProbeSuccess<A extends StudioPlaytestProbeAction> = Extract<
  StudioPlaytestProbeResponse,
  { readonly action: A; readonly ok: true }
>;

export interface StudioPlaytestControllerPreparationInput {
  readonly studioId: string;
  readonly sandboxLeaseId: string;
  readonly sandboxChangeSet: unknown;
  readonly desiredManifest: unknown;
  readonly architecturePlan: unknown;
  readonly playtestPlan: unknown;
  readonly confirmedPlaytestPlanSha256: string;
}

export interface StudioPlaytestPreflightEvidence {
  readonly prePlayEditSnapshotSha256: string;
  readonly desiredManifestSha256: string;
  readonly finalManifestNoopOperationCount: 0;
  readonly exactStudioSelected: true;
  readonly sandboxLeaseVerified: true;
}

export interface StudioPlaytestStartEvidence {
  readonly requested: true;
  readonly acknowledgmentCertain: boolean;
  readonly observedPlayRunning: true;
  readonly identityProbePassed: true;
  readonly characterReady: boolean;
}

export interface StudioPlaytestNavigationEvidence {
  readonly segmentId: string;
  readonly requestedOnce: true;
  readonly acknowledgmentCertain: boolean;
  readonly independentlyReached: boolean;
  readonly finalState: StudioPlaytestPlayerStateSuccess;
  readonly arrival: StudioPlaytestArrivalAssessment;
}

export type StudioPlaytestPathPreflightEvidence =
  | Readonly<{
      segmentId: string;
      preflightPassed: true;
      character: StudioPlaytestPlayerStateSuccess;
      path: StudioPlaytestPathProbeSuccess;
    }>
  | Readonly<{
      segmentId: string;
      preflightPassed: false;
      character: StudioPlaytestPlayerStateSuccess;
      status: 'dead' | 'fell' | 'wrong_floor' | 'not_at_checkpoint' | 'unsupported';
    }>;

export interface StudioPlaytestStopEvidence {
  readonly requested: true;
  readonly acknowledgmentCertain: boolean;
  readonly observedEditRestored: true;
  readonly identityVerifiedBeforeSecondStop: boolean;
}

export interface StudioPlaytestEditIntegrityEvidence {
  readonly prePlayEditSnapshotSha256: string;
  readonly postPlayEditSnapshotSha256: string;
  readonly exactMatch: true;
  readonly finalManifestNoopOperationCount: 0;
}

export interface StudioPlaytestStopAndIntegrityEvidence {
  readonly stop: StudioPlaytestStopEvidence;
  readonly editIntegrity: StudioPlaytestEditIntegrityEvidence;
}

interface PreparedControllerContext {
  readonly sandboxChangeSet: RobloxChangeSet;
  readonly desiredManifest: RobloxManifest;
  readonly sandboxLeaseId: string;
  readonly identity: StudioPlaytestIdentity;
  readonly playtestPlan: PlaytestPlan;
  readonly checkpointById: ReadonlyMap<string, PlaytestCheckpoint>;
  readonly floors: readonly StudioPlaytestFloor[];
  readonly captureCheckpointIds: ReadonlySet<string>;
  readonly captureSink?: StudioPlaytestCaptureSink;
  readonly consoleSink?: StudioPlaytestConsoleSink;
  readonly preflight: StudioPlaytestPreflightEvidence;
}

/** @internal A live runner may inject only a pre-reserved private evidence sink. */
export type StudioPlaytestCaptureSink = (
  image: Readonly<StudioMcpImageResult>,
  evidenceId: string,
  checkpointId: string,
) => Promise<StudioPlaytestCaptureEvidence>;

/** @internal Raw bounded console text may flow only to a private pre-reserved sink. */
export type StudioPlaytestConsoleSink = (
  phase: 'baseline' | 'final',
  text: string,
) => Promise<void>;

/** @internal Live runner-only private evidence boundary. */
export interface StudioPlaytestPrivateEvidenceSinks {
  readonly capture: StudioPlaytestCaptureSink;
  readonly console: StudioPlaytestConsoleSink;
}

export interface StudioPlaytestControllerTestingOptions {
  readonly client: StudioMcpClient;
  readonly session: StudioSessionSummary;
  readonly connectClient: StudioMcpClientFactory;
  readonly sandboxChangeSet: RobloxChangeSet;
  readonly desiredManifest: RobloxManifest;
  readonly sandboxLeaseId: string;
  readonly identity: StudioPlaytestIdentity;
  readonly playtestPlan: PlaytestPlan;
  readonly prePlaySnapshotHash: string;
  readonly verifyPostStop?: () => Promise<StudioPlaytestEditIntegrityEvidence>;
  readonly captureSink?: StudioPlaytestCaptureSink;
  readonly consoleSink?: StudioPlaytestConsoleSink;
}

function usage(path: string, message: string): never {
  throw new StudioAdapterError([studioDiagnostic('studio.usage_invalid', path, message)]);
}

function playtestFailure(
  code:
    | 'studio.playtest_identity_mismatch'
    | 'studio.playtest_probe_invalid'
    | 'studio.playtest_character_unavailable'
    | 'studio.playtest_path_failed'
    | 'studio.playtest_clearance_failed'
    | 'studio.playtest_state_invalid'
    | 'studio.playtest_start_uncertain'
    | 'studio.playtest_navigation_uncertain'
    | 'studio.playtest_stop_uncertain',
  path: string,
  message: string,
): never {
  throw new StudioAdapterError([studioDiagnostic(code, path, message)]);
}

function isStudioStateLaneTransportFailure(error: unknown): boolean {
  return (
    error instanceof StudioAdapterError &&
    error.diagnostics.length > 0 &&
    error.diagnostics.every(
      (diagnostic) =>
        diagnostic.toolName === 'get_studio_state' &&
        (diagnostic.code === 'studio.tool_call_failed' ||
          diagnostic.code === 'studio.tool_timeout'),
    )
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function assertCanonicalIdentifier(value: string, path: string): void {
  if (value.length > 128 || !IDENTIFIER.test(value)) {
    usage(path, 'Playtest controller identifiers must be canonical and bounded.');
  }
}

function successResponse<A extends StudioPlaytestProbeAction>(
  request: Extract<StudioPlaytestProbeRequest, { readonly action: A }>,
  response: StudioPlaytestProbeResponse,
): ProbeSuccess<A> {
  if (!response.ok) {
    throw new StudioAdapterError([
      studioDiagnostic(
        response.diagnostic.code,
        `/playtest/${request.action}`,
        `The fixed Studio playtest ${request.action} action failed (${response.diagnostic.code}).`,
      ),
    ]);
  }
  if (response.action !== request.action) {
    playtestFailure(
      'studio.playtest_probe_invalid',
      '/playtest/action',
      'The fixed Studio playtest response action is invalid.',
    );
  }
  return response as ProbeSuccess<A>;
}

function normalizeCaptureIds(values: readonly string[]): ReadonlySet<string> {
  if (values.length > 8 || new Set(values).size !== values.length) {
    usage(
      '/captureCheckpointIds',
      'Playtest capture checkpoints must be unique and at most eight.',
    );
  }
  for (const [index, value] of values.entries()) {
    assertCanonicalIdentifier(value, `/captureCheckpointIds/${index}`);
  }
  return new Set(values);
}

function derivePlanFloors(plan: Readonly<PlaytestPlan>): readonly StudioPlaytestFloor[] {
  const byLevel = new Map<number, StudioPlaytestFloor>();
  for (const checkpoint of plan.checkpoints) {
    const candidate: StudioPlaytestFloor = {
      floorId: checkpoint.sourceFloorId,
      level: checkpoint.level,
      finishedFloorElevation: checkpoint.expectedFinishedFloorElevation,
    };
    const existing = byLevel.get(candidate.level);
    if (
      existing !== undefined &&
      (existing.floorId !== candidate.floorId ||
        existing.finishedFloorElevation !== candidate.finishedFloorElevation)
    ) {
      usage('/playtestPlan/checkpoints', 'The Playtest Plan has ambiguous floor classification.');
    }
    byLevel.set(candidate.level, candidate);
  }
  return Object.freeze([...byLevel.values()].sort((left, right) => left.level - right.level));
}

function checkpointIndex(plan: Readonly<PlaytestPlan>): ReadonlyMap<string, PlaytestCheckpoint> {
  return new Map(plan.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint] as const));
}

function validatePreparationInput(input: Readonly<StudioPlaytestControllerPreparationInput>): {
  readonly changeSet: RobloxChangeSet;
  readonly manifest: RobloxManifest;
  readonly playtestPlan: PlaytestPlan;
  readonly lease: StudioSandboxLeaseRecord;
  readonly captureCheckpointIds: ReadonlySet<string>;
} {
  if (inspectJsonCompatibility(input) !== undefined) {
    usage('/preparation', 'Studio playtest preparation must be a plain JSON-compatible value.');
  }
  const planValidation = validatePlaytestPlanAgainstSources(
    input.playtestPlan,
    input.architecturePlan,
    input.desiredManifest,
  );
  if (!planValidation.valid) {
    usage(
      '/playtestPlan',
      'The exact Playtest Plan is not trusted-bound to its Architecture Plan and Manifest.',
    );
  }
  const playtestPlan = planValidation.value;
  const playtestPlanSha256 = hashPlaytestPlan(playtestPlan);
  if (input.confirmedPlaytestPlanSha256 !== playtestPlanSha256) {
    usage(
      '/confirmedPlaytestPlanSha256',
      'The full canonical Playtest Plan hash confirmation must match exactly.',
    );
  }
  const changeSetValidation = validateRobloxChangeSet(input.sandboxChangeSet);
  if (!changeSetValidation.valid) {
    usage('/sandboxChangeSet', 'The complete sandbox Change Set is invalid.');
  }
  const manifestValidation = validateRobloxManifest(input.desiredManifest);
  if (!manifestValidation.valid)
    usage('/desiredManifest', 'The desired Roblox Manifest is invalid.');
  const changeSet = changeSetValidation.value;
  const manifest = manifestValidation.value;
  const manifestHash = hashRobloxManifest(manifest);
  if (
    playtestPlan.source.projectId !== manifest.source.projectId ||
    playtestPlan.source.robloxManifestSha256 !== manifestHash ||
    playtestPlan.source.manifestSourceWorldSpecSha256 !== manifest.source.worldSpecHash ||
    playtestPlan.source.manifestRootNodeId !== manifest.rootNodeId ||
    playtestPlan.source.expectedManagedInstanceCount !== manifest.nodes.length ||
    playtestPlan.source.robloxManifestSchemaVersion !== manifest.schemaVersion ||
    playtestPlan.source.robloxCompilerVersion !== manifest.compilerVersion
  ) {
    usage('/playtestPlan/source', 'The Playtest Plan is not bound to the exact desired Manifest.');
  }
  if (
    changeSet.preconditions.projectId !== manifest.source.projectId ||
    changeSet.preconditions.desiredManifestHash !== manifestHash
  ) {
    usage(
      '/sandboxChangeSet/preconditions',
      'The sandbox Change Set is not integrity-bound to the desired Manifest.',
    );
  }
  const lease = createSandboxLeaseRecord(
    manifest.source.projectId,
    hashRobloxChangeSet(changeSet),
    () => input.sandboxLeaseId,
  );
  return {
    changeSet,
    manifest,
    playtestPlan,
    lease,
    captureCheckpointIds: normalizeCaptureIds(playtestPlan.captureCheckpoints),
  };
}

function verifyManifestNoop(
  snapshot: Readonly<RobloxSnapshot>,
  manifest: Readonly<RobloxManifest>,
): 0 {
  const plan = planRobloxChangeSet(snapshot, manifest);
  if (!plan.success || plan.changeSet.summary.total !== 0) {
    playtestFailure(
      'studio.playtest_identity_mismatch',
      '/preflight/manifest',
      'The lease-bound Studio world does not exactly reconcile as the desired Manifest no-op.',
    );
  }
  return 0;
}

function verifyNoUnmanagedRoots(snapshot: Readonly<RobloxSnapshot>, path: string): void {
  if (snapshot.unmanagedRoots.length !== 0) {
    playtestFailure(
      'studio.playtest_identity_mismatch',
      path,
      'Live architectural playtest planning requires zero protected unmanaged roots.',
    );
  }
}

async function readPreflightSnapshot(
  studioId: string,
  sandboxLeaseId: string,
  changeSet: Readonly<RobloxChangeSet>,
  manifest: Readonly<RobloxManifest>,
): Promise<Readonly<{ snapshot: RobloxSnapshot; hash: string }>> {
  let adapter: StudioMcpRobloxAdapter | undefined;
  try {
    adapter = await connectReadOnlyStudioMcpAdapter(studioId);
    const snapshot = await adapter.readLeaseBoundSnapshot(
      { projectId: manifest.source.projectId, target: manifest.target },
      hashRobloxChangeSet(changeSet),
      sandboxLeaseId,
    );
    const hash = hashRobloxSnapshot(snapshot);
    verifyNoUnmanagedRoots(snapshot, '/preflight/unmanagedRoots');
    if (hash !== changeSet.preconditions.resultSnapshotHash) {
      playtestFailure(
        'studio.playtest_identity_mismatch',
        '/preflight/snapshot',
        'The lease-bound Edit snapshot is not the exact applied Change Set result.',
      );
    }
    verifyManifestNoop(snapshot, manifest);
    return Object.freeze({ snapshot, hash });
  } finally {
    await adapter?.close();
  }
}

export class StudioPlaytestController {
  readonly #lease: StudioExactSessionLease;
  readonly #context: PreparedControllerContext;
  readonly #reconnectState: StudioReconnectState = createStudioReconnectState();
  readonly #pathTargets = new Map<string, string>();
  readonly #navigationAttempts = new Set<string>();
  readonly #reachedSegments = new Set<string>();
  readonly #clearanceObservations = new Set<string>();
  readonly #segmentPreflightObservations = new Set<string>();
  readonly #capturedCheckpoints = new Set<string>();
  readonly #reachedCheckpointIds = new Set<string>();
  readonly #verifyPostStopOverride:
    | (() => Promise<StudioPlaytestEditIntegrityEvidence>)
    | undefined;
  #started = false;
  #startRequested = false;
  #identityVerified = false;
  #setupAttempted = false;
  #stopSequenceStarted = false;
  #stopEvidence: StudioPlaytestStopAndIntegrityEvidence | undefined;
  #baselineConsoleObservation: StudioConsoleObservation | undefined;
  #runDeadline: number | undefined;
  #nextSegmentIndex = 0;
  #traversalStopped = false;
  #closed = false;

  /** @internal Construct only through a safe preparation factory. */
  public constructor(
    token: symbol,
    client: StudioMcpClient,
    session: StudioSessionSummary,
    context: PreparedControllerContext,
    connectClient: StudioMcpClientFactory = connectStudioPlaytestMcp,
    verifyPostStopOverride?: () => Promise<StudioPlaytestEditIntegrityEvidence>,
  ) {
    if (token !== CONTROLLER_CONSTRUCTION_TOKEN) {
      usage('/controller', 'Studio playtest controllers require a verified preparation factory.');
    }
    this.#lease = new StudioExactSessionLease(client, session, connectClient);
    this.#context = context;
    this.#verifyPostStopOverride = verifyPostStopOverride;
  }

  public get preflightEvidence(): StudioPlaytestPreflightEvidence {
    return this.#context.preflight;
  }

  #assertOpen(): void {
    if (this.#closed) usage('/controller', 'The Studio playtest controller is closed.');
  }

  #assertRunning(): void {
    this.#assertOpen();
    if (!this.#started || !this.#identityVerified || this.#stopEvidence !== undefined) {
      usage('/controller', 'The Studio playtest controller does not own a running simulation.');
    }
    if (this.#runDeadline === undefined || Date.now() > this.#runDeadline) {
      playtestFailure(
        'studio.playtest_state_invalid',
        '/controller/totalWait',
        'The bounded total playtest duration was exceeded.',
      );
    }
  }

  #remainingRunTime(): number {
    return Math.max(0, (this.#runDeadline ?? Date.now()) - Date.now());
  }

  #checkpoint(checkpointId: string): PlaytestCheckpoint {
    const checkpoint = this.#context.checkpointById.get(checkpointId);
    if (checkpoint === undefined) {
      playtestFailure(
        'studio.playtest_probe_invalid',
        '/playtestPlan/checkpoints',
        'The validated Playtest Plan references a missing checkpoint.',
      );
    }
    return checkpoint;
  }

  #nextSegment(segmentId: string): PlaytestSegment {
    if (this.#traversalStopped) {
      usage('/traversal', 'Traversal stopped after hard segment evidence and cannot resume.');
    }
    if (!this.#reachedCheckpointIds.has(this.#context.playtestPlan.setup.checkpointId)) {
      usage('/traversal', 'Traversal requires the exact confirmed Plan setup checkpoint first.');
    }
    const segment = this.#context.playtestPlan.segments[this.#nextSegmentIndex];
    if (segment === undefined || segment.id !== segmentId) {
      usage('/segmentId', 'Segments must be observed once in exact confirmed Plan order.');
    }
    return segment;
  }

  async #assertStoppedSandboxOnClient(client: StudioMcpClient): Promise<StudioSandboxProbe> {
    await selectStudioSession(client, this.#lease.studioId);
    const state = readStudioPlaytestSessionState(await client.getStudioStateText());
    if (state.phase !== 'stopped_edit') {
      playtestFailure(
        'studio.playtest_state_invalid',
        '/preStart/state',
        'Studio must be in stopped Edit before the one play start request.',
      );
    }
    const response = parseStudioBridgeResponse(
      await executeFixedStudioBridgeProgram(client, buildProbeProgram()),
      'probe',
    );
    if (!response.ok || response.action !== 'probe') {
      playtestFailure(
        'studio.playtest_state_invalid',
        '/preStart/probe',
        'The fixed Edit sandbox probe did not return a valid success response.',
      );
    }
    const probe = assertSandboxStudioProbe({
      studioId: this.#lease.studioId,
      placeName: response.probe.placeName,
      placeId: response.probe.placeId,
      gameId: response.probe.gameId,
      dataModelMode: 'Edit',
      playtesting: response.probe.isRunning,
      editExecutionAvailable: response.probe.isEditAvailable,
    });
    const leaseRequest = buildBoundSandboxSnapshotRequest(this.#context.identity.sandboxLease);
    const leaseResponse = parseStudioSandboxLeaseResponse(
      await executeFixedStudioBridgeProgram(client, buildSandboxLeaseProgram(leaseRequest)),
      leaseRequest,
    );
    if (!leaseResponse.ok || leaseResponse.action !== 'bound_snapshot') {
      playtestFailure(
        'studio.playtest_identity_mismatch',
        '/preStart/boundSnapshot',
        'The exact selected playtest lane could not revalidate the private lease-bound Edit snapshot.',
      );
    }
    const snapshot = snapshotFromStudioCompact(
      leaseResponse.compactSnapshot,
      this.#context.desiredManifest.source.projectId,
    );
    verifyNoUnmanagedRoots(snapshot, '/preStart/unmanagedRoots');
    if (hashRobloxSnapshot(snapshot) !== this.#context.preflight.prePlayEditSnapshotSha256) {
      playtestFailure(
        'studio.playtest_identity_mismatch',
        '/preStart/boundSnapshot',
        'The immediate lease-bound Edit snapshot differs from the reviewed pre-Play base.',
      );
    }
    verifyManifestNoop(snapshot, this.#context.desiredManifest);
    return probe;
  }

  async #probeOnClient<A extends StudioPlaytestProbeAction>(
    client: StudioMcpClient,
    request: Extract<StudioPlaytestProbeRequest, { readonly action: A }>,
  ): Promise<ProbeSuccess<A>> {
    await selectStudioSession(client, this.#lease.studioId);
    const response = parseStudioPlaytestProbeResponse(
      await executeFixedStudioPlaytestProgram(client, buildStudioPlaytestProbeProgram(request)),
      request,
    );
    return successResponse(request, response);
  }

  #probe<A extends StudioPlaytestProbeAction>(
    request: Extract<StudioPlaytestProbeRequest, { readonly action: A }>,
  ): Promise<ProbeSuccess<A>> {
    return this.#probeOnClient(this.#lease.currentClient(), request);
  }

  #identityProbe(
    client = this.#lease.currentClient(),
  ): Promise<StudioPlaytestIdentityProbeSuccess> {
    return this.#probeOnClient(
      client,
      buildStudioPlaytestIdentityProbeRequest(this.#context.identity),
    );
  }

  async #runningStateOnClient(client: StudioMcpClient): Promise<void> {
    const state = readStudioPlaytestSessionState(await client.getStudioStateText());
    if (state.phase !== 'running_server') {
      playtestFailure(
        'studio.playtest_state_invalid',
        '/state',
        'The exact Studio session is not running with the Server data model available.',
      );
    }
  }

  async #reconnectForRunningObservation(): Promise<StudioMcpClient> {
    const observation = await this.#lease.clientForVerifiedObservation(
      this.#reconnectState,
      async (candidate) => {
        await this.#runningStateOnClient(candidate);
        return this.#identityProbe(candidate);
      },
    );
    return observation.client;
  }

  /** Send one Start request, then prove exact running Server identity before ownership. */
  public async start(): Promise<StudioPlaytestStartEvidence> {
    this.#assertOpen();
    if (this.#startRequested) usage('/start', 'A Studio playtest may be started at most once.');
    await selectStudioSession(this.#lease.currentClient(), this.#lease.studioId);
    const baselineConsoleText = await readStudioConsoleText(this.#lease.currentClient());
    await this.#context.consoleSink?.('baseline', baselineConsoleText);
    this.#baselineConsoleObservation = observeStudioConsoleText(baselineConsoleText, 'Edit');
    // The lease-bound snapshot/no-op is intentionally the last call before Start.
    await this.#assertStoppedSandboxOnClient(this.#lease.currentClient());
    this.#runDeadline =
      Date.now() +
      Math.min(
        STUDIO_MCP_PLAYTEST_TOTAL_TIMEOUT_MS,
        this.#context.playtestPlan.limits.maximumTotalPlaytestWaitMilliseconds,
      );
    let acknowledgmentCertain = true;
    let startAcknowledged = false;
    let identity: StudioPlaytestIdentityProbeSuccess;
    this.#startRequested = true;
    try {
      await invokeStudioPlaytestStartStop(
        this.#lease.currentClient(),
        true,
        STUDIO_MCP_PLAYTEST_START_TIMEOUT_MS,
      );
      startAcknowledged = true;
      await waitForStudioPlaytestSessionPhase(
        () => this.#lease.currentClient().getStudioStateText(),
        'running_server',
        {
          timeoutMs: Math.min(
            STUDIO_MCP_PLAYTEST_STATE_TRANSITION_TIMEOUT_MS,
            this.#context.playtestPlan.limits.maximumStartStopTransitionWaitMilliseconds,
          ),
        },
      );
      identity = await this.#identityProbe();
    } catch (error) {
      const failedClient = this.#lease.currentClient();
      if (!failedClient.poisoned) {
        if (!startAcknowledged || !isStudioStateLaneTransportFailure(error)) throw error;
        await poisonStudioMcpClient(failedClient);
      }
      if (!startAcknowledged) {
        acknowledgmentCertain = false;
        await this.#lease.markUncertainMutation(this.#reconnectState);
      }
      const observation = await this.#lease.clientForVerifiedObservation(
        this.#reconnectState,
        async (candidate) => readStudioPlaytestSessionState(await candidate.getStudioStateText()),
      );
      if (observation.verified?.phase === 'stopped_edit') {
        playtestFailure(
          'studio.playtest_start_uncertain',
          '/start',
          'The uncertain Start left Studio stopped; v0.1 will not send another Start request.',
        );
      }
      if (observation.verified?.phase !== 'running_server') {
        playtestFailure(
          'studio.playtest_start_uncertain',
          '/start',
          'The uncertain Start could not be resolved to a safe running Server state.',
        );
      }
      identity = await this.#identityProbe(observation.client);
    }
    this.#identityVerified = true;
    this.#started = true;
    return Object.freeze({
      requested: true,
      acknowledgmentCertain,
      observedPlayRunning: true,
      identityProbePassed: true,
      characterReady: identity.characterReady,
    });
  }

  /** Wait for exactly one living Player character using only fixed identity probes. */
  public async waitForCharacter(): Promise<StudioPlaytestIdentityProbeSuccess> {
    this.#assertRunning();
    const boundedTimeout = Math.min(
      STUDIO_MCP_PLAYTEST_CHARACTER_TIMEOUT_MS,
      this.#context.playtestPlan.limits.maximumCharacterLoadWaitMilliseconds,
    );
    const deadline = Date.now() + Math.min(boundedTimeout, this.#remainingRunTime());
    for (;;) {
      const identity = await this.#identityProbe();
      this.#assertRunning();
      if (identity.playerCount > 1) {
        playtestFailure(
          'studio.playtest_character_unavailable',
          '/character/playerCount',
          'Exactly one local test Player is required.',
        );
      }
      if (identity.playerCount === 1 && identity.characterReady) return identity;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        playtestFailure(
          'studio.playtest_character_unavailable',
          '/character',
          'The single living test character did not become ready within the bounded wait.',
        );
      }
      await sleep(Math.min(STUDIO_MCP_PLAYTEST_POLL_INTERVAL_MS, remaining));
    }
  }

  /** Execute the sole play-only setup pivot once. */
  public async setupCharacter(): Promise<StudioPlaytestCharacterSetupSuccess> {
    this.#assertRunning();
    if (this.#setupAttempted) usage('/setup', 'Character setup may run at most once.');
    this.#setupAttempted = true;
    const response = await this.#probe(
      buildStudioPlaytestCharacterSetupRequest(
        this.#context.identity,
        this.#context.playtestPlan.setup.worldPosition,
      ),
    );
    this.#assertRunning();
    this.#reachedCheckpointIds.add(this.#context.playtestPlan.setup.checkpointId);
    return response;
  }

  public async observePlayerState(): Promise<StudioPlaytestPlayerStateSuccess> {
    this.#assertRunning();
    const response = await this.#probe(
      buildStudioPlaytestPlayerStateRequest(
        this.#context.identity,
        this.#context.floors,
        this.#context.playtestPlan.agent,
      ),
    );
    this.#assertRunning();
    return response;
  }

  /** Perform exactly one fixed PathfindingService preflight for a segment. */
  public async probeNextPath(segmentId: string): Promise<StudioPlaytestPathPreflightEvidence> {
    this.#assertRunning();
    const segment = this.#nextSegment(segmentId);
    if (this.#pathTargets.has(segmentId)) {
      usage('/path', 'Pathfinding preflight may run at most once per segment.');
    }
    if (this.#pathTargets.size >= STUDIO_MCP_PLAYTEST_MAX_SEGMENTS) {
      usage('/path', 'The bounded playtest segment limit was reached.');
    }
    if (this.#segmentPreflightObservations.has(segmentId)) {
      usage('/path/preflight', 'The segment preflight may run at most once.');
    }
    const from = this.#checkpoint(segment.fromCheckpointId);
    const state = await this.observePlayerState();
    this.#segmentPreflightObservations.add(segmentId);
    const sourceAssessment = assessStudioPlaytestArrival(
      state,
      from.worldPosition,
      segment.expectedFromLevel,
      from.expectedFinishedFloorElevation,
      this.#context.playtestPlan.agent,
    );
    if (!state.alive || !state.supported || !sourceAssessment.independentlyReached) {
      this.#traversalStopped = true;
      this.#pathTargets.set(segmentId, '');
      const status = !state.alive
        ? 'dead'
        : !state.supported
          ? 'unsupported'
          : sourceAssessment.status === 'fell'
            ? 'fell'
            : sourceAssessment.status === 'wrong_floor'
              ? 'wrong_floor'
              : 'not_at_checkpoint';
      return Object.freeze({
        segmentId,
        preflightPassed: false,
        character: state,
        status,
      });
    }
    const target = this.#checkpoint(segment.toCheckpointId);
    const response = await this.#probe(
      buildStudioPlaytestPathProbeRequest(this.#context.identity, {
        fromCheckpointId: segment.fromCheckpointId,
        targetCheckpointId: segment.toCheckpointId,
        fromWorldPosition: { ...from.worldPosition },
        targetWorldPosition: { ...target.worldPosition },
        agent: { ...this.#context.playtestPlan.agent },
        maximumRetainedWaypoints: Math.min(
          STUDIO_MCP_PLAYTEST_MAX_PATH_WAYPOINTS,
          this.#context.playtestPlan.limits.maximumPathWaypointsRetainedPerSegment,
        ),
      }),
    );
    this.#assertRunning();
    if (response.status === 'success') this.#pathTargets.set(segmentId, segment.toCheckpointId);
    else {
      this.#pathTargets.set(segmentId, '');
      this.#traversalStopped = true;
    }
    return Object.freeze({ segmentId, preflightPassed: true, character: state, path: response });
  }

  async #waitForIndependentArrival(
    targetWorldPosition: Readonly<StudioPlaytestVector>,
    expectedLevel: number,
    expectedFinishedFloorElevation: number,
    timeoutMs: number,
  ): Promise<
    Readonly<{ state: StudioPlaytestPlayerStateSuccess; arrival: StudioPlaytestArrivalAssessment }>
  > {
    const deadline = Date.now() + Math.min(timeoutMs, this.#remainingRunTime());
    for (;;) {
      const state = await this.observePlayerState();
      const arrival = assessStudioPlaytestArrival(
        state,
        targetWorldPosition,
        expectedLevel,
        expectedFinishedFloorElevation,
        this.#context.playtestPlan.agent,
      );
      if (arrival.status !== 'moving') return Object.freeze({ state, arrival });
      const remaining = deadline - Date.now();
      if (remaining <= 0) return Object.freeze({ state, arrival });
      await sleep(Math.min(STUDIO_MCP_PLAYTEST_POLL_INTERVAL_MS, remaining));
    }
  }

  /** Send one navigation request, never retry it, and independently observe arrival. */
  public async navigateSegment(segmentId: string): Promise<StudioPlaytestNavigationEvidence> {
    this.#assertRunning();
    const segment = this.#nextSegment(segmentId);
    if (this.#navigationAttempts.has(segmentId)) {
      usage('/navigation', 'Character navigation may run at most once per segment.');
    }
    if (this.#pathTargets.get(segmentId) !== segment.toCheckpointId) {
      playtestFailure(
        'studio.playtest_path_failed',
        '/navigation/path',
        'Navigation requires one successful matching path preflight.',
      );
    }
    const boundedTimeout = Math.min(
      STUDIO_MCP_PLAYTEST_NAVIGATION_TIMEOUT_MS,
      this.#context.playtestPlan.limits.maximumNavigationWaitMillisecondsPerSegment,
    );
    const segmentDeadline = Date.now() + Math.min(boundedTimeout, this.#remainingRunTime());
    const target = this.#checkpoint(segment.toCheckpointId);
    this.#navigationAttempts.add(segmentId);
    try {
      await this.#identityProbe();
    } catch (error) {
      if (this.#lease.currentClient().poisoned) {
        await this.#reconnectForRunningObservation();
      }
      throw error;
    }
    this.#assertRunning();
    const navigationTimeoutMs = segmentDeadline - Date.now();
    if (navigationTimeoutMs <= 0) {
      playtestFailure(
        'studio.playtest_state_invalid',
        '/navigation/totalWait',
        'The bounded playtest duration expired before navigation could be issued.',
      );
    }
    let acknowledgmentCertain = true;
    try {
      await invokeStudioCharacterNavigation(
        this.#lease.currentClient(),
        target.worldPosition,
        navigationTimeoutMs,
      );
    } catch (error) {
      if (!this.#lease.currentClient().poisoned) throw error;
      acknowledgmentCertain = false;
      await this.#lease.markUncertainMutation(this.#reconnectState);
      await this.#reconnectForRunningObservation();
    }
    const observed = await this.#waitForIndependentArrival(
      target.worldPosition,
      segment.expectedToLevel,
      target.expectedFinishedFloorElevation,
      Math.max(0, segmentDeadline - Date.now()),
    );
    this.#assertRunning();
    if (observed.arrival.independentlyReached) {
      this.#reachedSegments.add(segmentId);
      this.#reachedCheckpointIds.add(segment.toCheckpointId);
    } else {
      this.#traversalStopped = true;
    }
    return Object.freeze({
      segmentId,
      requestedOnce: true,
      acknowledgmentCertain,
      independentlyReached: observed.arrival.independentlyReached,
      finalState: observed.state,
      arrival: observed.arrival,
    });
  }

  /** Observe read-only support and clearance only after independent arrival. */
  public async observeClearance(segmentId: string): Promise<StudioPlaytestClearanceProbeSuccess> {
    this.#assertRunning();
    const segment = this.#nextSegment(segmentId);
    if (!this.#reachedSegments.has(segmentId)) {
      usage('/clearance', 'Clearance observation requires independent segment arrival.');
    }
    if (this.#clearanceObservations.has(segmentId)) {
      usage('/clearance', 'Clearance may be observed at most once per reached segment.');
    }
    this.#clearanceObservations.add(segmentId);
    const target = this.#checkpoint(segment.toCheckpointId);
    const response = await this.#probe(
      buildStudioPlaytestClearanceProbeRequest(this.#context.identity, {
        checkpointId: segment.toCheckpointId,
        expectedFinishedFloorElevation: target.expectedFinishedFloorElevation,
        agent: { ...this.#context.playtestPlan.agent },
      }),
    );
    this.#assertRunning();
    this.#nextSegmentIndex += 1;
    if (!response.supported || !response.bodyClear || !response.headClear) {
      this.#traversalStopped = true;
    }
    return response;
  }

  /** Capture only one of the pre-authorized Plan checkpoints, at most once. */
  public async captureCheckpoint(checkpointId: string): Promise<StudioPlaytestCaptureEvidence> {
    this.#assertRunning();
    if (!this.#context.captureCheckpointIds.has(checkpointId)) {
      usage('/capture/checkpointId', 'The checkpoint is not in the confirmed Plan capture set.');
    }
    if (!this.#reachedCheckpointIds.has(checkpointId)) {
      usage('/capture/checkpointId', 'The confirmed Plan checkpoint has not been reached yet.');
    }
    if (this.#capturedCheckpoints.has(checkpointId)) {
      usage('/capture/checkpointId', 'A Plan checkpoint may be captured at most once.');
    }
    this.#capturedCheckpoints.add(checkpointId);
    await this.#identityProbe();
    const evidenceId = `viewport-${createHash('sha256')
      .update(checkpointId, 'utf8')
      .digest('hex')
      .slice(0, 32)}`;
    let evidence: StudioPlaytestCaptureEvidence;
    try {
      const image = await captureStudioViewport(this.#lease.currentClient(), {
        captureId: evidenceId.replaceAll('-', '_'),
      });
      evidence =
        this.#context.captureSink === undefined
          ? await createStudioPlaytestCaptureEvidence(image, evidenceId, checkpointId)
          : await this.#context.captureSink(image, evidenceId, checkpointId);
    } catch {
      if (this.#lease.currentClient().poisoned) {
        // A capture timeout is optional evidence loss, but its dead transport is
        // not reusable. Reconnect only after proving the exact running identity.
        await this.#reconnectForRunningObservation();
      }
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.capture_unavailable',
          '/capture',
          'The one authorized viewport capture attempt was unavailable.',
        ),
      ]);
    }
    this.#assertRunning();
    return evidence;
  }

  /** Return only bounded hashes and classifications; raw console messages remain private. */
  public async collectConsoleEvidence(): Promise<SanitizedStudioConsoleEvidence> {
    this.#assertRunning();
    if (this.#baselineConsoleObservation === undefined) {
      usage('/console', 'The pre-Start console baseline is unavailable.');
    }
    await this.#identityProbe();
    const finalConsoleText = await readStudioConsoleText(this.#lease.currentClient());
    this.#assertRunning();
    await this.#context.consoleSink?.('final', finalConsoleText);
    const finalObservation = observeStudioConsoleText(finalConsoleText, 'Server');
    const evidence = sanitizeStudioConsoleObservations(
      this.#baselineConsoleObservation,
      finalObservation,
    );
    this.#baselineConsoleObservation = undefined;
    return evidence;
  }

  async #verifyPostStop(): Promise<StudioPlaytestEditIntegrityEvidence> {
    if (this.#verifyPostStopOverride !== undefined) return this.#verifyPostStopOverride();
    let adapter: StudioMcpRobloxAdapter | undefined;
    try {
      adapter = await connectReadOnlyStudioMcpAdapter(this.#lease.studioId);
      const snapshot = await adapter.readLeaseBoundSnapshot(
        {
          projectId: this.#context.desiredManifest.source.projectId,
          target: this.#context.desiredManifest.target,
        },
        hashRobloxChangeSet(this.#context.sandboxChangeSet),
        this.#context.sandboxLeaseId,
      );
      const postHash = hashRobloxSnapshot(snapshot);
      verifyNoUnmanagedRoots(snapshot, '/postStop/unmanagedRoots');
      if (postHash !== this.#context.preflight.prePlayEditSnapshotSha256) {
        playtestFailure(
          'studio.playtest_identity_mismatch',
          '/postStop/snapshot',
          'The post-Stop lease-bound Edit snapshot differs from the pre-Play snapshot.',
        );
      }
      const finalManifestNoopOperationCount = verifyManifestNoop(
        snapshot,
        this.#context.desiredManifest,
      );
      return Object.freeze({
        prePlayEditSnapshotSha256: this.#context.preflight.prePlayEditSnapshotSha256,
        postPlayEditSnapshotSha256: postHash,
        exactMatch: true,
        finalManifestNoopOperationCount,
      });
    } finally {
      await adapter?.close();
    }
  }

  /** Stop safely, resolving one uncertain acknowledgment by observed exact-session state. */
  public async stopAndVerify(): Promise<StudioPlaytestStopAndIntegrityEvidence> {
    this.#assertOpen();
    if (this.#stopEvidence !== undefined) return this.#stopEvidence;
    if (!this.#identityVerified || !this.#started) {
      usage('/stop', 'Worldwright may stop only a play simulation whose identity it proved.');
    }
    if (this.#stopSequenceStarted) {
      usage('/stop', 'The bounded Stop sequence has already begun and cannot be re-entered.');
    }
    let acknowledgmentCertain = true;
    let identityVerifiedBeforeSecondStop = false;
    let stopClient = this.#lease.currentClient();
    try {
      await this.#identityProbe(stopClient);
    } catch (error) {
      if (!stopClient.poisoned) throw error;
      // No Stop request has been sent. Replace only the poisoned read lane,
      // then re-prove the exact running identity before the one authorized Stop.
      stopClient = await this.#reconnectForRunningObservation();
    }
    this.#stopSequenceStarted = true;
    try {
      await invokeStudioPlaytestStartStop(stopClient, false, STUDIO_MCP_PLAYTEST_STOP_TIMEOUT_MS);
    } catch {
      acknowledgmentCertain = false;
      await this.#lease.markUncertainMutation(this.#reconnectState);
      const observation = await this.#lease.clientForVerifiedObservation(
        this.#reconnectState,
        async (candidate) => readStudioPlaytestSessionState(await candidate.getStudioStateText()),
      );
      if (observation.verified?.phase === 'running_server') {
        await this.#identityProbe(observation.client);
        identityVerifiedBeforeSecondStop = true;
        try {
          await invokeStudioPlaytestStartStop(
            observation.client,
            false,
            STUDIO_MCP_PLAYTEST_STOP_TIMEOUT_MS,
          );
          await waitForStudioPlaytestSessionPhase(
            () => observation.client.getStudioStateText(),
            'stopped_edit',
            {
              timeoutMs: Math.min(
                STUDIO_MCP_PLAYTEST_STATE_TRANSITION_TIMEOUT_MS,
                this.#context.playtestPlan.limits.maximumStartStopTransitionWaitMilliseconds,
              ),
            },
          );
        } catch {
          if (!observation.client.poisoned) {
            playtestFailure(
              'studio.playtest_stop_uncertain',
              '/stop',
              'The single observed-state Stop did not restore Edit within the bounded wait.',
            );
          }
          await this.#lease.markUncertainMutation(this.#reconnectState);
          const finalObservation = await this.#lease.clientForVerifiedObservation(
            this.#reconnectState,
            async (candidate) =>
              readStudioPlaytestSessionState(await candidate.getStudioStateText()),
          );
          if (finalObservation.verified?.phase !== 'stopped_edit') {
            playtestFailure(
              'studio.playtest_stop_uncertain',
              '/stop',
              'The uncertain observed-state Stop could not be resolved to stopped Edit.',
            );
          }
        }
      } else if (observation.verified?.phase !== 'stopped_edit') {
        playtestFailure(
          'studio.playtest_stop_uncertain',
          '/stop',
          'The uncertain Stop could not be resolved to the bounded playtest lifecycle.',
        );
      }
    }
    if (acknowledgmentCertain) {
      try {
        await waitForStudioPlaytestSessionPhase(
          () => stopClient.getStudioStateText(),
          'stopped_edit',
          {
            timeoutMs: Math.min(
              STUDIO_MCP_PLAYTEST_STATE_TRANSITION_TIMEOUT_MS,
              this.#context.playtestPlan.limits.maximumStartStopTransitionWaitMilliseconds,
            ),
          },
        );
      } catch (error) {
        if (!stopClient.poisoned) {
          if (!isStudioStateLaneTransportFailure(error)) throw error;
          await poisonStudioMcpClient(stopClient);
        }
        // The Stop acknowledgment was certain, so reconnect only to classify
        // the exact session. Never issue a second Stop from this branch.
        const observation = await this.#lease.clientForVerifiedObservation(
          this.#reconnectState,
          async (candidate) => readStudioPlaytestSessionState(await candidate.getStudioStateText()),
        );
        if (observation.verified?.phase !== 'stopped_edit') {
          playtestFailure(
            'studio.playtest_stop_uncertain',
            '/stop',
            'The acknowledged Stop could not be observed in stopped Edit after reconnect.',
          );
        }
      }
    }
    this.#started = false;
    await this.#lease.close();
    const editIntegrity = await this.#verifyPostStop();
    const stop = Object.freeze({
      requested: true as const,
      acknowledgmentCertain,
      observedEditRestored: true as const,
      identityVerifiedBeforeSecondStop,
    });
    this.#stopEvidence = Object.freeze({ stop, editIntegrity });
    return this.#stopEvidence;
  }

  /** Closing a proved running controller always performs the verified Stop path. */
  public async close(): Promise<void> {
    if (this.#closed) return;
    try {
      if (this.#startRequested && !this.#identityVerified && this.#stopEvidence === undefined) {
        let client = this.#lease.currentClient();
        if (client.poisoned) {
          client = (
            await this.#lease.clientForVerifiedObservation(
              this.#reconnectState,
              async (candidate) =>
                readStudioPlaytestSessionState(await candidate.getStudioStateText()),
            )
          ).client;
        }
        await selectStudioSession(client, this.#lease.studioId);
        const state = readStudioPlaytestSessionState(await client.getStudioStateText());
        if (state.phase === 'running_server') {
          await this.#identityProbe(client);
          this.#identityVerified = true;
          this.#started = true;
        } else if (state.phase !== 'stopped_edit') {
          playtestFailure(
            'studio.playtest_state_invalid',
            '/close/state',
            'The unresolved Start did not leave a safely classifiable Studio state.',
          );
        }
      }
      if (
        this.#identityVerified &&
        this.#started &&
        this.#stopEvidence === undefined &&
        !this.#stopSequenceStarted
      ) {
        await this.stopAndVerify();
      } else if (this.#stopEvidence === undefined) {
        await this.#lease.close();
      }
    } catch (error) {
      await this.#lease.close();
      throw error;
    } finally {
      this.#baselineConsoleObservation = undefined;
      this.#closed = true;
    }
  }
}

/**
 * Verify the exact lease-bound Edit world and Manifest no-op before exposing a
 * high-level playtest controller. Private Studio and lease IDs are never returned.
 */
export async function prepareStudioPlaytestController(
  input: Readonly<StudioPlaytestControllerPreparationInput>,
): Promise<StudioPlaytestController> {
  return prepareStudioPlaytestControllerInternal(input);
}

/** @internal Live runner only; absent from the package root API. */
export async function prepareStudioPlaytestControllerWithCaptureSink(
  input: Readonly<StudioPlaytestControllerPreparationInput>,
  captureSink: StudioPlaytestCaptureSink,
): Promise<StudioPlaytestController> {
  return prepareStudioPlaytestControllerInternal(input, captureSink);
}

/** @internal Live runner only; absent from the package root API. */
export async function prepareStudioPlaytestControllerWithPrivateEvidenceSinks(
  input: Readonly<StudioPlaytestControllerPreparationInput>,
  sinks: Readonly<StudioPlaytestPrivateEvidenceSinks>,
): Promise<StudioPlaytestController> {
  return prepareStudioPlaytestControllerInternal(input, sinks.capture, sinks.console);
}

async function prepareStudioPlaytestControllerInternal(
  input: Readonly<StudioPlaytestControllerPreparationInput>,
  captureSink?: StudioPlaytestCaptureSink,
  consoleSink?: StudioPlaytestConsoleSink,
): Promise<StudioPlaytestController> {
  const validated = validatePreparationInput(input);
  const preflight = await readPreflightSnapshot(
    input.studioId,
    input.sandboxLeaseId,
    validated.changeSet,
    validated.manifest,
  );
  const evidence: StudioPlaytestPreflightEvidence = Object.freeze({
    prePlayEditSnapshotSha256: preflight.hash,
    desiredManifestSha256: hashRobloxManifest(validated.manifest),
    finalManifestNoopOperationCount: 0,
    exactStudioSelected: true,
    sandboxLeaseVerified: true,
  });
  const context: PreparedControllerContext = {
    sandboxChangeSet: validated.changeSet,
    desiredManifest: validated.manifest,
    sandboxLeaseId: input.sandboxLeaseId,
    identity: {
      projectId: validated.manifest.source.projectId,
      rootNodeId: validated.manifest.rootNodeId,
      manifestSourceWorldSpecSha256: validated.manifest.source.worldSpecHash,
      expectedManagedNodeCount: validated.manifest.nodes.length,
      sandboxLease: validated.lease,
      playtestPlanSha256: hashPlaytestPlan(validated.playtestPlan),
    },
    playtestPlan: validated.playtestPlan,
    checkpointById: checkpointIndex(validated.playtestPlan),
    floors: derivePlanFloors(validated.playtestPlan),
    captureCheckpointIds: validated.captureCheckpointIds,
    ...(captureSink === undefined ? {} : { captureSink }),
    ...(consoleSink === undefined ? {} : { consoleSink }),
    preflight: evidence,
  };
  const client = await connectStudioPlaytestMcp();
  try {
    const session = await selectStudioSession(client, input.studioId);
    return new StudioPlaytestController(
      CONTROLLER_CONSTRUCTION_TOKEN,
      client,
      session,
      context,
      connectStudioPlaytestMcp,
    );
  } catch (error) {
    await client.close();
    throw error;
  }
}

/** @internal Offline fake-MCP construction; exported only from the testing subpath. */
export function createStudioPlaytestControllerForTesting(
  options: Readonly<StudioPlaytestControllerTestingOptions>,
): StudioPlaytestController {
  const context: PreparedControllerContext = {
    sandboxChangeSet: options.sandboxChangeSet,
    desiredManifest: options.desiredManifest,
    sandboxLeaseId: options.sandboxLeaseId,
    identity: options.identity,
    playtestPlan: options.playtestPlan,
    checkpointById: checkpointIndex(options.playtestPlan),
    floors: derivePlanFloors(options.playtestPlan),
    captureCheckpointIds: normalizeCaptureIds(options.playtestPlan.captureCheckpoints),
    ...(options.captureSink === undefined ? {} : { captureSink: options.captureSink }),
    ...(options.consoleSink === undefined ? {} : { consoleSink: options.consoleSink }),
    preflight: Object.freeze({
      prePlayEditSnapshotSha256: options.prePlaySnapshotHash,
      desiredManifestSha256: hashRobloxManifest(options.desiredManifest),
      finalManifestNoopOperationCount: 0,
      exactStudioSelected: true,
      sandboxLeaseVerified: true,
    }),
  };
  return new StudioPlaytestController(
    CONTROLLER_CONSTRUCTION_TOKEN,
    options.client,
    options.session,
    context,
    options.connectClient,
    options.verifyPostStop,
  );
}
