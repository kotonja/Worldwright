import { readFileSync } from 'node:fs';

import { hashPlaytestPlan } from '@worldwright/playtest-critic';
import { hashRobloxChangeSet } from '@worldwright/roblox-compiler';
import { describe, expect, it } from 'vitest';

import {
  hashReviewedLivePlaytestSequence,
  requireReviewedLivePlaytestConfirmation,
  stringifySanitizedLivePlaytestPreStartReview,
  stringifyReviewedLivePlaytestSequence,
  stringifySanitizedLivePlaytestSummary,
  type SanitizedLivePlaytestSummary,
} from '../scripts/live-playtest-summary.js';
import {
  reviewLivePlaytestArtifacts,
  startStudioPlaytestAfterSanitizedReview,
} from '../scripts/live-playtest-runner.js';

function read(relative: string): unknown {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as unknown;
}

function artifacts() {
  return {
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
  };
}

function summary(): SanitizedLivePlaytestSummary {
  return {
    schemaVersion: '0.1.0',
    placeId: 0,
    gameId: 0,
    prePlayEditSnapshotSha256: '0'.repeat(64),
    postPlayEditSnapshotSha256: '0'.repeat(64),
    playtestPlanSha256: '1'.repeat(64),
    robloxManifestSha256: '2'.repeat(64),
    sandboxChangeSetSha256: '3'.repeat(64),
    expectedBuildResultSnapshotSha256: '4'.repeat(64),
    observedBuildResultSnapshotSha256: '4'.repeat(64),
    buildOperationsPlanned: 400,
    buildOperationsApplied: 400,
    buildChunksPlanned: 13,
    buildChunksCompleted: 13,
    buildMutationExecuteCalls: 13,
    buildSandboxLeaseClaimCalls: 1,
    checkpointCount: 55,
    segmentCount: 100,
    segmentsReached: 100,
    pathSuccessCount: 100,
    roomCountReached: 13,
    roomCountRequired: 13,
    floorCountReached: 2,
    floorCountRequired: 2,
    stairRunCountTraversed: 1,
    stairRunCountRequired: 1,
    pathFailureCount: 0,
    navigationSuccessCount: 100,
    navigationFailureCount: 0,
    characterSurvived: true,
    clearanceSuccessCount: 100,
    clearanceFailureCount: 0,
    consoleErrorCount: 0,
    consoleWarningCount: 0,
    criticStatus: 'pass',
    criticFindingCodes: [],
    finalManifestNoopOperationCount: 0,
    playtestRunReportSha256: '5'.repeat(64),
    criticReportSha256: '6'.repeat(64),
    viewportEvidence: [],
  };
}

describe('Milestone 5 reviewed live playtest summaries', () => {
  it('binds the exact checked-in Architecture Plan, Playtest Plan, Manifest, and Change Set', () => {
    const reviewed = reviewLivePlaytestArtifacts(artifacts());
    expect(reviewed.sequence).toMatchObject({
      playtestPlanSha256: hashPlaytestPlan(reviewed.playtestPlan),
      sandboxChangeSetSha256: hashRobloxChangeSet(reviewed.sandboxChangeSet),
      expectedManagedNodeCount: 400,
      segmentCount: 100,
    });
    const hash = hashReviewedLivePlaytestSequence(reviewed.sequence);
    expect(() => requireReviewedLivePlaytestConfirmation(reviewed.sequence, hash)).not.toThrow();
    expect(() =>
      requireReviewedLivePlaytestConfirmation(reviewed.sequence, hash.slice(0, 32)),
    ).toThrow(/full reviewed/u);
  });

  it('rejects trusted-source drift before any live connection', () => {
    const input = artifacts();
    const plan = structuredClone(input.playtestPlan) as Record<string, unknown>;
    const setup = structuredClone(plan.setup) as Record<string, unknown>;
    setup.worldPosition = { x: 0, y: 0, z: 0 };
    plan.setup = setup;
    expect(() => reviewLivePlaytestArtifacts({ ...input, playtestPlan: plan })).toThrow(
      /artifacts are invalid/u,
    );
  });

  it('drops injected Studio, lease, and path fields from sequence serialization and hashing', () => {
    const reviewed = reviewLivePlaytestArtifacts(artifacts());
    const injected = {
      ...reviewed.sequence,
      studioId: 'private-studio',
      sandboxLeaseId: 'a'.repeat(64),
      outputPath: 'C:/private/path',
      nested: { leaseId: 'b'.repeat(64) },
    };
    const serialized = stringifyReviewedLivePlaytestSequence(injected);
    expect(serialized).not.toContain('private-studio');
    expect(serialized).not.toContain('sandboxLeaseId');
    expect(serialized).not.toContain('outputPath');
    expect(hashReviewedLivePlaytestSequence(injected)).toBe(
      hashReviewedLivePlaytestSequence(reviewed.sequence),
    );
  });

  it('serializes an exact allowlisted sanitized summary and drops runtime extras', () => {
    const injected = {
      ...summary(),
      studioId: 'private-studio',
      leaseId: 'a'.repeat(64),
      rawConsole: 'private raw output',
      localPath: 'C:/private/path',
    };
    const serialized = stringifySanitizedLivePlaytestSummary(injected);
    expect(serialized).not.toContain('private-studio');
    expect(serialized).not.toContain('leaseId');
    expect(serialized).not.toContain('rawConsole');
    expect(serialized).not.toContain('localPath');
    expect(JSON.parse(serialized)).toEqual(summary());
  });

  it('requires Critic status to agree with the severities of its exact finding codes', () => {
    expect(() =>
      stringifySanitizedLivePlaytestSummary({
        ...summary(),
        criticStatus: 'pass_with_warnings',
        criticFindingCodes: ['critic.console_error_new'],
      }),
    ).toThrow(/strict identity-free contract/u);
    expect(() =>
      stringifySanitizedLivePlaytestSummary({
        ...summary(),
        criticStatus: 'fail',
        criticFindingCodes: ['critic.capture_unavailable'],
      }),
    ).toThrow(/strict identity-free contract/u);
    expect(() =>
      stringifySanitizedLivePlaytestSummary({
        ...summary(),
        criticStatus: 'pass_with_warnings',
        criticFindingCodes: ['critic.capture_unavailable'],
      }),
    ).not.toThrow();
  });

  it('awaits the sanitized pre-Start review before issuing the sole Start call', async () => {
    const events: string[] = [];
    const review = {
      schemaVersion: '0.1.0' as const,
      action: 'worldwright-live-playtest-pre-start-review' as const,
      projectId: 'project-cliffwatch-mansion',
      architecturePlanSha256: '0'.repeat(64),
      playtestPlanSha256: '1'.repeat(64),
      robloxManifestSha256: '2'.repeat(64),
      sandboxChangeSetSha256: '3'.repeat(64),
      roomCount: 13,
      floorCount: 2,
      stairRunCount: 1,
      checkpointCount: 55,
      segmentCount: 100,
      captureCount: 7,
      exactEditSnapshotSha256: '4'.repeat(64),
      sandboxLeaseMatched: true as const,
    };
    const result = await startStudioPlaytestAfterSanitizedReview(
      {
        start: async () => {
          events.push('start');
          return {
            requested: true as const,
            acknowledgmentCertain: true,
            observedPlayRunning: true as const,
            identityProbePassed: true as const,
            characterReady: true,
          };
        },
      },
      review,
      async (value) => {
        await Promise.resolve();
        events.push('review');
        const injected: typeof value & Record<string, unknown> = {
          ...value,
          studioId: 'private-studio',
          sandboxLeaseId: 'a'.repeat(64),
          localPath: 'C:/private/path',
        };
        const serialized = stringifySanitizedLivePlaytestPreStartReview(injected);
        expect(serialized).not.toContain('private-studio');
        expect(serialized).not.toContain('sandboxLeaseId');
        expect(serialized).not.toContain('localPath');
      },
    );
    expect(events).toEqual(['review', 'start']);
    expect(result.requested).toBe(true);
  });
});
