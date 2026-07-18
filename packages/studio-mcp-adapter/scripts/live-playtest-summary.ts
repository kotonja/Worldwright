import { CRITIC_RULES } from '@worldwright/playtest-critic';

import { compareCodePoints } from '../src/diagnostics.js';
import {
  hashCanonicalJson,
  inspectJsonCompatibility,
  stringifyCanonicalJson,
  type JsonValue,
} from '../src/json.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const CRITIC_FINDING_CODES = new Set(Object.keys(CRITIC_RULES));

function invalid(subject: string): never {
  throw new Error(`The ${subject} does not satisfy its strict identity-free contract.`);
}

function reviewedInput(
  input: Readonly<ReviewedLivePlaytestSequenceInput>,
): ReviewedLivePlaytestSequenceInput {
  if (
    inspectJsonCompatibility(input) !== undefined ||
    !SHA256.test(input.architecturePlanSha256) ||
    !SHA256.test(input.playtestPlanSha256) ||
    !SHA256.test(input.robloxManifestSha256) ||
    !SHA256.test(input.sandboxChangeSetSha256) ||
    !IDENTIFIER.test(input.projectId) ||
    !IDENTIFIER.test(input.manifestRootNodeId) ||
    !Number.isSafeInteger(input.expectedManagedNodeCount) ||
    input.expectedManagedNodeCount < 1 ||
    input.expectedManagedNodeCount > 4096 ||
    !Number.isSafeInteger(input.checkpointCount) ||
    input.checkpointCount < 1 ||
    input.checkpointCount > 128 ||
    !Number.isSafeInteger(input.segmentCount) ||
    input.segmentCount < 1 ||
    input.segmentCount > 256 ||
    !Number.isSafeInteger(input.captureCount) ||
    input.captureCount < 0 ||
    input.captureCount > 8
  ) {
    return invalid('reviewed live playtest sequence input');
  }
  return Object.freeze({
    architecturePlanSha256: input.architecturePlanSha256,
    playtestPlanSha256: input.playtestPlanSha256,
    robloxManifestSha256: input.robloxManifestSha256,
    sandboxChangeSetSha256: input.sandboxChangeSetSha256,
    projectId: input.projectId,
    manifestRootNodeId: input.manifestRootNodeId,
    expectedManagedNodeCount: input.expectedManagedNodeCount,
    checkpointCount: input.checkpointCount,
    segmentCount: input.segmentCount,
    captureCount: input.captureCount,
  });
}

export interface ReviewedLivePlaytestSequenceInput {
  readonly architecturePlanSha256: string;
  readonly playtestPlanSha256: string;
  readonly robloxManifestSha256: string;
  readonly sandboxChangeSetSha256: string;
  readonly projectId: string;
  readonly manifestRootNodeId: string;
  readonly expectedManagedNodeCount: number;
  readonly checkpointCount: number;
  readonly segmentCount: number;
  readonly captureCount: number;
}

export interface ReviewedLivePlaytestSequence extends ReviewedLivePlaytestSequenceInput {
  readonly schemaVersion: '0.1.0';
  readonly action: 'worldwright-live-playtest-smoke';
  readonly requiresExactStudioId: true;
  readonly requiresPrivateSandboxLeaseId: true;
  readonly appliesReviewedSandboxChangeSet: true;
  readonly requiresManifestNoopBeforePlay: true;
  readonly navigationAttemptsPerSegment: 1;
  readonly automaticRepair: false;
  readonly phases: readonly [
    'apply-reviewed-change-set',
    'lease-bound-edit-preflight',
    'start-and-prove-play-identity',
    'setup-and-traverse',
    'collect-private-evidence',
    'verified-stop',
    'lease-bound-edit-integrity',
    'pure-critic',
  ];
}

export function buildReviewedLivePlaytestSequence(
  input: Readonly<ReviewedLivePlaytestSequenceInput>,
): ReviewedLivePlaytestSequence {
  const phases = [
    'apply-reviewed-change-set',
    'lease-bound-edit-preflight',
    'start-and-prove-play-identity',
    'setup-and-traverse',
    'collect-private-evidence',
    'verified-stop',
    'lease-bound-edit-integrity',
    'pure-critic',
  ] as const;
  const safeInput = reviewedInput(input);
  return Object.freeze({
    schemaVersion: '0.1.0',
    action: 'worldwright-live-playtest-smoke',
    ...safeInput,
    requiresExactStudioId: true,
    requiresPrivateSandboxLeaseId: true,
    appliesReviewedSandboxChangeSet: true,
    requiresManifestNoopBeforePlay: true,
    navigationAttemptsPerSegment: 1,
    automaticRepair: false,
    phases: Object.freeze(phases),
  });
}

function normalizeReviewedLivePlaytestSequence(
  sequence: Readonly<ReviewedLivePlaytestSequence>,
): ReviewedLivePlaytestSequence {
  const normalized = buildReviewedLivePlaytestSequence(sequence);
  if (
    sequence.schemaVersion !== normalized.schemaVersion ||
    sequence.action !== normalized.action ||
    sequence.requiresExactStudioId !== true ||
    sequence.requiresPrivateSandboxLeaseId !== true ||
    sequence.appliesReviewedSandboxChangeSet !== true ||
    sequence.requiresManifestNoopBeforePlay !== true ||
    sequence.navigationAttemptsPerSegment !== 1 ||
    sequence.automaticRepair !== false ||
    !Array.isArray(sequence.phases) ||
    sequence.phases.length !== normalized.phases.length ||
    normalized.phases.some((phase, index) => phase !== sequence.phases[index])
  ) {
    return invalid('reviewed live playtest sequence');
  }
  return normalized;
}

export function stringifyReviewedLivePlaytestSequence(
  sequence: Readonly<ReviewedLivePlaytestSequence>,
): string {
  return stringifyCanonicalJson(
    normalizeReviewedLivePlaytestSequence(sequence) as unknown as JsonValue,
  );
}

export function hashReviewedLivePlaytestSequence(
  sequence: Readonly<ReviewedLivePlaytestSequence>,
): string {
  return hashCanonicalJson(normalizeReviewedLivePlaytestSequence(sequence) as unknown as JsonValue);
}

export function requireReviewedLivePlaytestConfirmation(
  sequence: Readonly<ReviewedLivePlaytestSequence>,
  confirmation: string | undefined,
): void {
  if (confirmation !== hashReviewedLivePlaytestSequence(sequence)) {
    throw new Error('The full reviewed live playtest sequence hash confirmation is required.');
  }
}

export interface SanitizedLivePlaytestSummary {
  readonly schemaVersion: '0.1.0';
  readonly placeId: 0;
  readonly gameId: 0;
  readonly prePlayEditSnapshotSha256: string;
  readonly postPlayEditSnapshotSha256: string;
  readonly playtestPlanSha256: string;
  readonly robloxManifestSha256: string;
  readonly sandboxChangeSetSha256: string;
  readonly expectedBuildResultSnapshotSha256: string;
  readonly observedBuildResultSnapshotSha256: string;
  readonly buildOperationsPlanned: number;
  readonly buildOperationsApplied: number;
  readonly buildChunksPlanned: number;
  readonly buildChunksCompleted: number;
  readonly buildMutationExecuteCalls: number;
  readonly buildSandboxLeaseClaimCalls: number;
  readonly checkpointCount: number;
  readonly segmentCount: number;
  readonly segmentsReached: number;
  readonly pathSuccessCount: number;
  readonly roomCountReached: number;
  readonly roomCountRequired: number;
  readonly floorCountReached: number;
  readonly floorCountRequired: number;
  readonly stairRunCountTraversed: number;
  readonly stairRunCountRequired: number;
  readonly pathFailureCount: number;
  readonly navigationSuccessCount: number;
  readonly navigationFailureCount: number;
  readonly characterSurvived: boolean;
  readonly clearanceSuccessCount: number;
  readonly clearanceFailureCount: number;
  readonly consoleErrorCount: number;
  readonly consoleWarningCount: number;
  readonly criticStatus: 'pass' | 'pass_with_warnings' | 'fail';
  readonly criticFindingCodes: readonly string[];
  readonly finalManifestNoopOperationCount: number;
  readonly playtestRunReportSha256: string;
  readonly criticReportSha256: string;
  readonly viewportEvidence: readonly Readonly<{
    evidenceId: string;
    checkpointId: string;
    mediaType: 'image/jpeg';
    sha256: string;
    byteLength: number;
  }>[];
}

export interface SanitizedLivePlaytestPreStartReview {
  readonly schemaVersion: '0.1.0';
  readonly action: 'worldwright-live-playtest-pre-start-review';
  readonly projectId: string;
  readonly architecturePlanSha256: string;
  readonly playtestPlanSha256: string;
  readonly robloxManifestSha256: string;
  readonly sandboxChangeSetSha256: string;
  readonly roomCount: number;
  readonly floorCount: number;
  readonly stairRunCount: number;
  readonly checkpointCount: number;
  readonly segmentCount: number;
  readonly captureCount: number;
  readonly exactEditSnapshotSha256: string;
  readonly sandboxLeaseMatched: true;
}

export function stringifySanitizedLivePlaytestPreStartReview(
  review: Readonly<SanitizedLivePlaytestPreStartReview>,
): string {
  if (
    inspectJsonCompatibility(review) !== undefined ||
    review.schemaVersion !== '0.1.0' ||
    review.action !== 'worldwright-live-playtest-pre-start-review' ||
    !IDENTIFIER.test(review.projectId) ||
    ![
      review.architecturePlanSha256,
      review.playtestPlanSha256,
      review.robloxManifestSha256,
      review.sandboxChangeSetSha256,
      review.exactEditSnapshotSha256,
    ].every((hash) => SHA256.test(hash)) ||
    !Number.isSafeInteger(review.roomCount) ||
    review.roomCount < 0 ||
    review.roomCount > 128 ||
    !Number.isSafeInteger(review.floorCount) ||
    review.floorCount < 0 ||
    review.floorCount > 3 ||
    !Number.isSafeInteger(review.stairRunCount) ||
    review.stairRunCount < 0 ||
    review.stairRunCount > 8 ||
    !Number.isSafeInteger(review.checkpointCount) ||
    review.checkpointCount < 1 ||
    review.checkpointCount > 128 ||
    !Number.isSafeInteger(review.segmentCount) ||
    review.segmentCount < 1 ||
    review.segmentCount > 256 ||
    !Number.isSafeInteger(review.captureCount) ||
    review.captureCount < 0 ||
    review.captureCount > 8 ||
    review.sandboxLeaseMatched !== true
  ) {
    return invalid('sanitized live playtest pre-Start review');
  }
  return stringifyCanonicalJson({
    schemaVersion: '0.1.0',
    action: 'worldwright-live-playtest-pre-start-review',
    projectId: review.projectId,
    architecturePlanSha256: review.architecturePlanSha256,
    playtestPlanSha256: review.playtestPlanSha256,
    robloxManifestSha256: review.robloxManifestSha256,
    sandboxChangeSetSha256: review.sandboxChangeSetSha256,
    roomCount: review.roomCount,
    floorCount: review.floorCount,
    stairRunCount: review.stairRunCount,
    checkpointCount: review.checkpointCount,
    segmentCount: review.segmentCount,
    captureCount: review.captureCount,
    exactEditSnapshotSha256: review.exactEditSnapshotSha256,
    sandboxLeaseMatched: true,
  });
}

function normalizeSanitizedLivePlaytestSummary(
  summary: Readonly<SanitizedLivePlaytestSummary>,
): SanitizedLivePlaytestSummary {
  if (
    inspectJsonCompatibility(summary) !== undefined ||
    summary.schemaVersion !== '0.1.0' ||
    summary.placeId !== 0 ||
    summary.gameId !== 0
  ) {
    return invalid('sanitized live playtest summary');
  }
  const hashes = [
    summary.prePlayEditSnapshotSha256,
    summary.postPlayEditSnapshotSha256,
    summary.playtestPlanSha256,
    summary.robloxManifestSha256,
    summary.sandboxChangeSetSha256,
    summary.expectedBuildResultSnapshotSha256,
    summary.observedBuildResultSnapshotSha256,
    summary.playtestRunReportSha256,
    summary.criticReportSha256,
    ...summary.viewportEvidence.map((entry) => entry.sha256),
  ];
  const counts = [
    summary.buildOperationsPlanned,
    summary.buildOperationsApplied,
    summary.buildChunksPlanned,
    summary.buildChunksCompleted,
    summary.buildMutationExecuteCalls,
    summary.buildSandboxLeaseClaimCalls,
    summary.checkpointCount,
    summary.segmentCount,
    summary.segmentsReached,
    summary.pathSuccessCount,
    summary.roomCountReached,
    summary.roomCountRequired,
    summary.floorCountReached,
    summary.floorCountRequired,
    summary.stairRunCountTraversed,
    summary.stairRunCountRequired,
    summary.pathFailureCount,
    summary.navigationSuccessCount,
    summary.navigationFailureCount,
    summary.clearanceSuccessCount,
    summary.clearanceFailureCount,
    summary.consoleErrorCount,
    summary.consoleWarningCount,
    summary.finalManifestNoopOperationCount,
  ];
  const findingCodesSorted = [...summary.criticFindingCodes].sort(compareCodePoints);
  const findingSeverities = summary.criticFindingCodes.map(
    (code) => CRITIC_RULES[code as keyof typeof CRITIC_RULES]?.severity,
  );
  const criticErrorCount = findingSeverities.filter((severity) => severity === 'error').length;
  const criticWarningCount = findingSeverities.filter((severity) => severity === 'warning').length;
  const viewportIds = summary.viewportEvidence.map((entry) => entry.evidenceId);
  const viewportCheckpointIds = summary.viewportEvidence.map((entry) => entry.checkpointId);
  const healthyOutcome =
    summary.roomCountReached === summary.roomCountRequired &&
    summary.floorCountReached === summary.floorCountRequired &&
    summary.stairRunCountTraversed === summary.stairRunCountRequired &&
    summary.segmentsReached === summary.segmentCount &&
    summary.pathSuccessCount === summary.segmentCount &&
    summary.pathFailureCount === 0 &&
    summary.navigationSuccessCount === summary.segmentCount &&
    summary.navigationFailureCount === 0 &&
    summary.characterSurvived &&
    summary.clearanceSuccessCount === summary.segmentCount &&
    summary.clearanceFailureCount === 0 &&
    summary.consoleErrorCount === 0 &&
    summary.finalManifestNoopOperationCount === 0 &&
    summary.prePlayEditSnapshotSha256 === summary.postPlayEditSnapshotSha256;
  if (
    hashes.some((hash) => !SHA256.test(hash)) ||
    counts.some((count) => !Number.isSafeInteger(count) || count < 0 || count > 4096) ||
    typeof summary.characterSurvived !== 'boolean' ||
    !['pass', 'pass_with_warnings', 'fail'].includes(summary.criticStatus) ||
    summary.expectedBuildResultSnapshotSha256 !== summary.observedBuildResultSnapshotSha256 ||
    summary.buildOperationsPlanned !== 400 ||
    summary.buildOperationsApplied !== 400 ||
    summary.buildChunksPlanned !== 13 ||
    summary.buildChunksCompleted !== 13 ||
    summary.buildMutationExecuteCalls > 16 ||
    summary.buildSandboxLeaseClaimCalls !== 1 ||
    summary.segmentsReached > summary.segmentCount ||
    summary.pathSuccessCount + summary.pathFailureCount > summary.segmentCount ||
    summary.navigationSuccessCount + summary.navigationFailureCount > summary.segmentCount ||
    summary.clearanceSuccessCount + summary.clearanceFailureCount > summary.segmentCount ||
    summary.roomCountReached > summary.roomCountRequired ||
    summary.floorCountReached > summary.floorCountRequired ||
    summary.stairRunCountTraversed > summary.stairRunCountRequired ||
    new Set(summary.criticFindingCodes).size !== summary.criticFindingCodes.length ||
    summary.criticFindingCodes.some((code) => !CRITIC_FINDING_CODES.has(code)) ||
    findingCodesSorted.some((code, index) => code !== summary.criticFindingCodes[index]) ||
    (summary.criticStatus !== 'fail' && !healthyOutcome) ||
    (summary.criticStatus === 'pass' &&
      (summary.criticFindingCodes.length !== 0 || summary.consoleWarningCount !== 0)) ||
    (summary.criticStatus === 'pass_with_warnings' &&
      (criticErrorCount !== 0 || criticWarningCount === 0)) ||
    (summary.criticStatus === 'fail' && criticErrorCount === 0) ||
    summary.viewportEvidence.length > 8 ||
    new Set(viewportIds).size !== viewportIds.length ||
    new Set(viewportCheckpointIds).size !== viewportCheckpointIds.length ||
    summary.viewportEvidence.some(
      (entry) =>
        entry.evidenceId.length > 128 ||
        entry.checkpointId.length > 128 ||
        !IDENTIFIER.test(entry.evidenceId) ||
        !IDENTIFIER.test(entry.checkpointId) ||
        entry.mediaType !== 'image/jpeg' ||
        !Number.isSafeInteger(entry.byteLength) ||
        entry.byteLength < 1 ||
        entry.byteLength > 4 * 1024 * 1024,
    )
  ) {
    return invalid('sanitized live playtest summary');
  }
  return Object.freeze({
    schemaVersion: '0.1.0',
    placeId: 0,
    gameId: 0,
    prePlayEditSnapshotSha256: summary.prePlayEditSnapshotSha256,
    postPlayEditSnapshotSha256: summary.postPlayEditSnapshotSha256,
    playtestPlanSha256: summary.playtestPlanSha256,
    robloxManifestSha256: summary.robloxManifestSha256,
    sandboxChangeSetSha256: summary.sandboxChangeSetSha256,
    expectedBuildResultSnapshotSha256: summary.expectedBuildResultSnapshotSha256,
    observedBuildResultSnapshotSha256: summary.observedBuildResultSnapshotSha256,
    buildOperationsPlanned: summary.buildOperationsPlanned,
    buildOperationsApplied: summary.buildOperationsApplied,
    buildChunksPlanned: summary.buildChunksPlanned,
    buildChunksCompleted: summary.buildChunksCompleted,
    buildMutationExecuteCalls: summary.buildMutationExecuteCalls,
    buildSandboxLeaseClaimCalls: summary.buildSandboxLeaseClaimCalls,
    checkpointCount: summary.checkpointCount,
    segmentCount: summary.segmentCount,
    segmentsReached: summary.segmentsReached,
    pathSuccessCount: summary.pathSuccessCount,
    roomCountReached: summary.roomCountReached,
    roomCountRequired: summary.roomCountRequired,
    floorCountReached: summary.floorCountReached,
    floorCountRequired: summary.floorCountRequired,
    stairRunCountTraversed: summary.stairRunCountTraversed,
    stairRunCountRequired: summary.stairRunCountRequired,
    pathFailureCount: summary.pathFailureCount,
    navigationSuccessCount: summary.navigationSuccessCount,
    navigationFailureCount: summary.navigationFailureCount,
    characterSurvived: summary.characterSurvived,
    clearanceSuccessCount: summary.clearanceSuccessCount,
    clearanceFailureCount: summary.clearanceFailureCount,
    consoleErrorCount: summary.consoleErrorCount,
    consoleWarningCount: summary.consoleWarningCount,
    criticStatus: summary.criticStatus,
    criticFindingCodes: Object.freeze([...summary.criticFindingCodes]),
    finalManifestNoopOperationCount: summary.finalManifestNoopOperationCount,
    playtestRunReportSha256: summary.playtestRunReportSha256,
    criticReportSha256: summary.criticReportSha256,
    viewportEvidence: Object.freeze(
      summary.viewportEvidence.map((entry) =>
        Object.freeze({
          evidenceId: entry.evidenceId,
          checkpointId: entry.checkpointId,
          mediaType: entry.mediaType,
          sha256: entry.sha256,
          byteLength: entry.byteLength,
        }),
      ),
    ),
  });
}

export function stringifySanitizedLivePlaytestSummary(
  summary: Readonly<SanitizedLivePlaytestSummary>,
): string {
  return stringifyCanonicalJson(
    normalizeSanitizedLivePlaytestSummary(summary) as unknown as JsonValue,
  );
}
