import { readFileSync } from 'node:fs';

import {
  validatePlaytestRunReportAgainstPlan,
  type PlaytestRunReport,
  type PlaytestSegmentResult,
} from '@worldwright/playtest-critic';
import { describe, expect, it } from 'vitest';

import {
  buildFailedPathSegmentResult,
  buildFailedPreflightSegmentResult,
  buildLivePlaytestRunReportCandidate,
  buildObservedSegmentResult,
  buildUnattemptedSegmentResult,
  reviewLivePlaytestArtifacts,
  stringifyLiveEvidenceManifest,
  type LivePlaytestRunReportCandidateInput,
} from '../scripts/live-playtest-runner.js';
import type {
  StudioPlaytestNavigationEvidence,
  StudioPlaytestPathPreflightEvidence,
} from '../src/playtest/controller.js';
import type {
  StudioPlaytestPathProbeSuccess,
  StudioPlaytestPlayerStateSuccess,
} from '../src/playtest/types.js';

function read(relative: string): unknown {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as unknown;
}

const ARTIFACTS = reviewLivePlaytestArtifacts({
  architecturePlan: read(
    '../../architecture-planner/fixtures/plans/cliffwatch-mansion.architecture-plan.json',
  ),
  playtestPlan: read('../../playtest-critic/fixtures/plans/cliffwatch.playtest-plan.json'),
  manifest: read(
    '../../architecture-planner/fixtures/manifest/cliffwatch-mansion-blockout.manifest.json',
  ),
  sandboxChangeSet: read(
    '../../architecture-planner/fixtures/change-sets/create-cliffwatch-blockout.change-set.json',
  ),
});

const CLEAN_RUN = read(
  '../../playtest-critic/fixtures/run-reports/cliffwatch-pass.playtest-run.json',
) as PlaytestRunReport;

function playerState(
  overrides: Partial<StudioPlaytestPlayerStateSuccess> = {},
): StudioPlaytestPlayerStateSuccess {
  return {
    protocolVersion: '0.1.0',
    action: 'player_state',
    ok: true,
    position: { ...ARTIFACTS.playtestPlan.setup.worldPosition },
    linearVelocityMagnitude: 0,
    health: 100,
    maximumHealth: 100,
    humanoidState: 'Running',
    floorMaterial: 'Concrete',
    hasHumanoidRootPart: true,
    alive: true,
    supported: true,
    supportDistance: ARTIFACTS.playtestPlan.agent.rootHeightAboveFinishedFloor,
    managedSupportEntityId: 'floor-ground',
    currentLevel: 0,
    currentFloorId: 'floor-ground',
    ...overrides,
  };
}

function candidateInput(
  segmentResults: readonly PlaytestSegmentResult[],
  startAcknowledgmentCertain = true,
  stopAcknowledgmentCertain = true,
): LivePlaytestRunReportCandidateInput {
  return {
    architecturePlan: ARTIFACTS.architecturePlan,
    playtestPlan: ARTIFACTS.playtestPlan,
    manifest: ARTIFACTS.manifest,
    prePlayEditSnapshotSha256: CLEAN_RUN.editIntegrity.prePlayEditSnapshotSha256,
    startEvidence: {
      requested: true,
      acknowledgmentCertain: startAcknowledgmentCertain,
      observedPlayRunning: true,
      identityProbePassed: true,
      characterReady: true,
    },
    setupEvidence: {
      protocolVersion: '0.1.0',
      action: 'character_setup',
      ok: true,
      position: { ...ARTIFACTS.playtestPlan.setup.worldPosition },
      linearVelocityMagnitude: 0,
      angularVelocityMagnitude: 0,
    },
    consoleEvidence: { ...CLEAN_RUN.consoleEvidence },
    stopEvidence: {
      stop: {
        requested: true,
        acknowledgmentCertain: stopAcknowledgmentCertain,
        observedEditRestored: true,
        identityVerifiedBeforeSecondStop: false,
      },
      editIntegrity: {
        prePlayEditSnapshotSha256: CLEAN_RUN.editIntegrity.prePlayEditSnapshotSha256,
        postPlayEditSnapshotSha256: CLEAN_RUN.editIntegrity.postPlayEditSnapshotSha256!,
        exactMatch: true,
        finalManifestNoopOperationCount: 0,
      },
    },
    segmentResults,
    viewportEvidence: segmentResults === CLEAN_RUN.segmentResults ? CLEAN_RUN.viewportEvidence : [],
  };
}

function expectValidCandidate(input: LivePlaytestRunReportCandidateInput): PlaytestRunReport {
  const candidate = buildLivePlaytestRunReportCandidate(input);
  const validation = validatePlaytestRunReportAgainstPlan(ARTIFACTS.playtestPlan, candidate);
  expect(
    validation.valid,
    validation.valid ? undefined : JSON.stringify(validation.diagnostics),
  ).toBe(true);
  if (!validation.valid) throw new Error('expected valid candidate');
  return validation.value;
}

describe('Milestone 5 live runner strict Run Report construction', () => {
  it.each(['dead', 'fell', 'wrong_floor', 'not_at_checkpoint', 'unsupported'] as const)(
    'retains bounded source character evidence for a %s character preflight halt',
    (status) => {
      const source = ARTIFACTS.playtestPlan.checkpoints.find(
        (checkpoint) => checkpoint.id === ARTIFACTS.playtestPlan.segments[0]!.fromCheckpointId,
      )!;
      const character =
        status === 'dead'
          ? playerState({ alive: false, health: 0, humanoidState: 'Dead' })
          : status === 'wrong_floor'
            ? playerState({ currentLevel: source.level === 0 ? 1 : 0 })
            : status === 'unsupported'
              ? playerState({ supported: false })
              : playerState();
      const preflight: Extract<
        StudioPlaytestPathPreflightEvidence,
        { readonly preflightPassed: false }
      > = {
        segmentId: ARTIFACTS.playtestPlan.segments[0]!.id,
        preflightPassed: false,
        character,
        status,
      };
      const segmentResults = ARTIFACTS.playtestPlan.segments.map((_segment, index) =>
        index === 0
          ? buildFailedPreflightSegmentResult(ARTIFACTS.playtestPlan, index, preflight)
          : buildUnattemptedSegmentResult(ARTIFACTS.playtestPlan, index),
      );
      const result = expectValidCandidate(candidateInput(segmentResults));
      expect(result.segmentResults[0]).toMatchObject({
        path: { status: 'not_attempted' },
        navigation: { requestedOnce: false },
        arrival: { status: 'not_observed' },
        character: {
          observed: true,
          expectedLevel: source.level,
          fallDetected: status === 'fell',
        },
        clearance: { observed: false },
        failureCodes:
          status === 'dead'
            ? ['character-dead']
            : status === 'fell'
              ? ['character-fell']
              : status === 'wrong_floor'
                ? ['wrong-floor']
                : [],
      });
      expect(result.environment.playDataModelsUsed).toEqual(['Edit', 'Server']);
    },
  );

  it('retains source-floor character evidence when a cross-floor path probe fails', () => {
    const index = ARTIFACTS.playtestPlan.segments.findIndex(
      (segment) => segment.expectedFromLevel !== segment.expectedToLevel,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const segment = ARTIFACTS.playtestPlan.segments[index]!;
    const source = ARTIFACTS.playtestPlan.checkpoints.find(
      (checkpoint) => checkpoint.id === segment.fromCheckpointId,
    )!;
    const preflight: Extract<
      StudioPlaytestPathPreflightEvidence,
      { readonly preflightPassed: true }
    > = {
      segmentId: segment.id,
      preflightPassed: true,
      character: playerState({
        position: { ...source.worldPosition },
        currentLevel: source.level,
        currentFloorId: source.sourceFloorId,
      }),
      path: {
        protocolVersion: '0.1.0',
        action: 'path_probe',
        ok: true,
        status: 'no_path',
        waypointCount: 0,
        waypoints: [],
        totalPathDistance: 0,
        requiresJump: false,
        jumpWaypointCount: 0,
        fromCheckpointId: segment.fromCheckpointId,
        targetCheckpointId: segment.toCheckpointId,
      },
    };
    const results = ARTIFACTS.playtestPlan.segments.map((_planned, resultIndex) => {
      if (resultIndex < index) {
        const prior = structuredClone(CLEAN_RUN.segmentResults[resultIndex]!);
        delete prior.viewportEvidenceId;
        return prior;
      }
      return resultIndex === index
        ? buildFailedPathSegmentResult(ARTIFACTS.playtestPlan, resultIndex, preflight)
        : buildUnattemptedSegmentResult(ARTIFACTS.playtestPlan, resultIndex);
    });
    const result = expectValidCandidate(candidateInput(results));
    expect(result.segmentResults[index]).toMatchObject({
      path: { status: 'failed' },
      navigation: { requestedOnce: false },
      character: {
        observed: true,
        expectedLevel: source.level,
        observedLevel: source.level,
      },
      failureCodes: ['path-failed'],
    });
    expect(result.environment.playDataModelsUsed).toEqual(['Client', 'Edit', 'Server']);
  });

  it.each(['dead', 'wrong_floor'] as const)(
    'accepts an in-tolerance missed arrival when terminal %s evidence explains it',
    (terminalStatus) => {
      const index = ARTIFACTS.playtestPlan.segments.findIndex(
        (segment) => segment.expectedFromLevel !== segment.expectedToLevel,
      );
      expect(index).toBeGreaterThanOrEqual(0);
      const segment = ARTIFACTS.playtestPlan.segments[index]!;
      const from = ARTIFACTS.playtestPlan.checkpoints.find(
        (checkpoint) => checkpoint.id === segment.fromCheckpointId,
      )!;
      const target = ARTIFACTS.playtestPlan.checkpoints.find(
        (checkpoint) => checkpoint.id === segment.toCheckpointId,
      )!;
      const path: StudioPlaytestPathProbeSuccess = {
        protocolVersion: '0.1.0',
        action: 'path_probe',
        ok: true,
        status: 'success',
        waypointCount: 1,
        waypoints: [{ ...target.worldPosition }],
        totalPathDistance: Math.hypot(
          target.worldPosition.x - from.worldPosition.x,
          target.worldPosition.y - from.worldPosition.y,
          target.worldPosition.z - from.worldPosition.z,
        ),
        requiresJump: false,
        jumpWaypointCount: 0,
        fromCheckpointId: from.id,
        targetCheckpointId: target.id,
      };
      const navigation: StudioPlaytestNavigationEvidence = {
        segmentId: segment.id,
        requestedOnce: true,
        acknowledgmentCertain: true,
        independentlyReached: false,
        finalState: playerState({
          position: { ...target.worldPosition },
          currentLevel: terminalStatus === 'wrong_floor' ? from.level : target.level,
          currentFloorId:
            terminalStatus === 'wrong_floor' ? from.sourceFloorId : target.sourceFloorId,
          ...(terminalStatus === 'dead' ? { alive: false, health: 0, humanoidState: 'Dead' } : {}),
        }),
        arrival: {
          status: terminalStatus,
          horizontalError: 0,
          verticalError: 0,
          independentlyReached: false,
        },
      };
      const results = ARTIFACTS.playtestPlan.segments.map((_planned, resultIndex) => {
        if (resultIndex < index) {
          const prior = structuredClone(CLEAN_RUN.segmentResults[resultIndex]!);
          delete prior.viewportEvidenceId;
          return prior;
        }
        return resultIndex === index
          ? buildObservedSegmentResult(
              ARTIFACTS.playtestPlan,
              resultIndex,
              path,
              navigation,
              undefined,
              undefined,
            )
          : buildUnattemptedSegmentResult(ARTIFACTS.playtestPlan, resultIndex);
      });
      const result = expectValidCandidate(candidateInput(results));
      expect(result.segmentResults[index]).toMatchObject({
        arrival: { status: 'missed', horizontalError: 0, verticalError: 0 },
        failureCodes:
          terminalStatus === 'dead'
            ? ['arrival-missed', 'character-dead', 'navigation-failed']
            : ['arrival-missed', 'navigation-failed', 'wrong-floor'],
      });
    },
  );

  it('retains a missed navigation observation and emits exact deterministic failure codes', () => {
    const segment = ARTIFACTS.playtestPlan.segments[0]!;
    const from = ARTIFACTS.playtestPlan.checkpoints.find(
      (checkpoint) => checkpoint.id === segment.fromCheckpointId,
    )!;
    const target = ARTIFACTS.playtestPlan.checkpoints.find(
      (checkpoint) => checkpoint.id === segment.toCheckpointId,
    )!;
    const position = {
      x: target.worldPosition.x + ARTIFACTS.playtestPlan.agent.arrivalHorizontalTolerance + 1,
      y: target.worldPosition.y,
      z: target.worldPosition.z,
    };
    const horizontalError = Math.abs(position.x - target.worldPosition.x);
    const path: StudioPlaytestPathProbeSuccess = {
      protocolVersion: '0.1.0',
      action: 'path_probe',
      ok: true,
      status: 'success',
      waypointCount: 1,
      waypoints: [{ ...target.worldPosition }],
      totalPathDistance: Math.hypot(
        target.worldPosition.x - from.worldPosition.x,
        target.worldPosition.y - from.worldPosition.y,
        target.worldPosition.z - from.worldPosition.z,
      ),
      requiresJump: false,
      jumpWaypointCount: 0,
      fromCheckpointId: from.id,
      targetCheckpointId: target.id,
    };
    const navigation: StudioPlaytestNavigationEvidence = {
      segmentId: segment.id,
      requestedOnce: true,
      acknowledgmentCertain: true,
      independentlyReached: false,
      finalState: playerState({
        position,
        currentLevel: target.level,
        currentFloorId: target.sourceFloorId,
      }),
      arrival: {
        status: 'moving',
        horizontalError,
        verticalError: 0,
        independentlyReached: false,
      },
    };
    const segmentResults = ARTIFACTS.playtestPlan.segments.map((_planned, index) =>
      index === 0
        ? buildObservedSegmentResult(
            ARTIFACTS.playtestPlan,
            index,
            path,
            navigation,
            undefined,
            undefined,
          )
        : buildUnattemptedSegmentResult(ARTIFACTS.playtestPlan, index),
    );
    const result = expectValidCandidate(candidateInput(segmentResults));
    expect(result.segmentResults[0]).toMatchObject({
      navigation: { independentlyReached: false, finalPosition: position },
      arrival: { status: 'missed', observedPosition: position },
      failureCodes: ['arrival-missed', 'navigation-failed'],
    });
  });

  it.each([
    [false, true, 'start-uncertain', 'none'],
    [true, false, 'none', 'stop-uncertain'],
  ] as const)(
    'derives recovered lifecycle uncertainty exactly (start=%s, stop=%s)',
    (startCertain, stopCertain, expectedStartCode, expectedStopCode) => {
      const result = expectValidCandidate(
        candidateInput(CLEAN_RUN.segmentResults, startCertain, stopCertain),
      );
      expect(result.start.failureCode).toBe(expectedStartCode);
      expect(result.stop.failureCode).toBe(expectedStopCode);
    },
  );
});

describe('Milestone 5 evidence manifest', () => {
  it('contains exact fixed artifact digests without paths, raw text, Studio IDs, or lease IDs', () => {
    const roles = [
      'playtest-plan',
      'playtest-run-report',
      'critic-report',
      'sanitized-summary',
      'console-baseline-private',
      'console-final-private',
    ] as const;
    const serialized = stringifyLiveEvidenceManifest({
      artifacts: roles.map((role, index) => ({
        role,
        sha256: index.toString(16).repeat(64),
        byteLength: index,
      })),
      authorizedCaptureCheckpointIds: ARTIFACTS.playtestPlan.captureCheckpoints,
      viewportEvidence: [],
    });
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect(parsed.artifacts).toHaveLength(6);
    expect(parsed).toMatchObject({
      unavailableCaptureCheckpointIds: ARTIFACTS.playtestPlan.captureCheckpoints,
      viewportEvidence: [],
    });
    expect(serialized).not.toContain('C:/');
    expect(serialized).not.toContain('studioId');
    expect(serialized).not.toContain('leaseId');
    expect(serialized).not.toContain('private raw console text');
  });
});
