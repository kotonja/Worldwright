import { mkdir, open, readFile, unlink, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyRobloxChangeSetProgress,
  hashRobloxChangeSet,
  hashRobloxManifest,
  hashRobloxSnapshot,
  normalizeRobloxManifest,
  planRobloxChangeSet,
  simulateRobloxChangeSet,
  validateRobloxChangeSet,
  validateRobloxManifest,
  validateRobloxSnapshot,
  type ApplyResult,
  type RobloxChangeSet,
  type RobloxManifest,
  type RobloxSnapshot,
} from '@worldwright/roblox-compiler';

import { connectSelectedStudioMcpAdapter } from '../src/adapter.js';
import {
  buildStudioBatchOperations,
  buildStudioApplyReceipt,
  chunkStudioBatchOperations,
  createViewportEvidence,
  hashStudioTransportReport,
  stringifyStudioTransportReport,
  validateStudioTransportReport,
  type StudioChangeSetApplyEvidence,
  type StudioReceiptContext,
  type StudioTransportReport,
  type StudioViewportEvidence,
} from '../src/index.js';
import {
  STUDIO_MCP_MAX_BATCH_OPERATIONS,
  STUDIO_MCP_MAX_BATCH_PAYLOAD_BYTES,
  STUDIO_MCP_VIEWPORT_MEDIA_TYPE,
} from '../src/constants.js';
import { sanitizedErrorMessage, StudioAdapterError, studioDiagnostic } from '../src/diagnostics.js';
import { hashStudioApplyReceipt } from '../src/hashing.js';
import { hashCanonicalJson, stringifyCanonicalJson, type JsonValue } from '../src/json.js';
import { assertSandboxStudioProbe, type StudioSandboxProbe } from '../src/mcp/session.js';
import { stringifyStudioApplyReceipt } from '../src/normalize.js';
import { applyStudioChangeSetWithLostBatchAcknowledgment } from '../src/testing.js';
import { validateStudioApplyReceipt } from '../src/validate.js';
import { buildBatchLiveShareableSummary } from './live-batch-summary.js';

const EXPECTED_CREATE_CHANGE_SET_HASH =
  '599144839b4739a212f4d700df5a90e63bec6e69db63cd5123e24fd472b794d0';
const EXPECTED_CANONICAL_SNAPSHOT_HASH =
  '581cfe62f6d900daca990b621437567993a7178bbf35450e751b762057275bf8';
const EXPECTED_CANONICAL_NOOP_CHANGE_SET_HASH =
  '12722113e14824a7cec4e26d15fedfe5bd405ed0482cc55ebaad5c8facf758bb';
const EXPECTED_MODIFIED_SNAPSHOT_HASH =
  '50182d9ba65551edc1c5359b4987e42c6fb1268f3399a9717ab7206b61161b54';
const EXPECTED_CREATE_OPERATION_COUNT = 400;
const EXPECTED_CREATE_CHUNK_COUNT = 13;
const MAX_REVIEWED_CREATE_MUTATION_CALLS = 16;
// Used only to account for the fixed-width private field during offline chunk
// review. It is never claimed, sent to Studio, or emitted as evidence.
const LEASE_WIDTH_SIZING_VALUE = '0'.repeat(64);

const evidenceDirectory = fileURLToPath(
  new URL('../../../.worldwright/live-milestone-4/', import.meta.url),
);
const manifestPath = new URL(
  '../../architecture-planner/fixtures/manifest/cliffwatch-mansion-blockout.manifest.json',
  import.meta.url,
);
const reviewedChangeSetPath = new URL(
  '../../architecture-planner/fixtures/change-sets/create-cliffwatch-blockout.change-set.json',
  import.meta.url,
);
const reviewedEmptySnapshotPath = new URL(
  '../../architecture-planner/fixtures/snapshots/empty-cliffwatch.snapshot.json',
  import.meta.url,
);

const reservedEvidenceNames = [
  'authorization.json',
  'applied.receipt.json',
  'noop.receipt.json',
  'lost-response-rollback.receipt.json',
  'create.transport-report.json',
  'noop.transport-report.json',
  'update.transport-report.json',
  'repair.transport-report.json',
  'lost-response.transport-report.json',
  'summary.json',
  'viewport.jpg',
] as const;
type ReservedEvidenceName = (typeof reservedEvidenceNames)[number];

interface ReservedEvidenceTarget {
  readonly handle: FileHandle;
  readonly path: string;
}

interface ReviewedChunk {
  readonly chunkIndex: number;
  readonly operationCount: number;
  readonly chunkId: string;
  readonly canonicalRequestBytes: number;
}

interface BatchLiveAuthorizationEnvelope {
  readonly schemaVersion: '0.1.0';
  readonly sequence: 'worldwright-milestone-4-batch-live-smoke-v2';
  readonly projectId: string;
  readonly createOperationCount: 400;
  readonly maxBatchOperations: number;
  readonly maxBatchPayloadBytes: number;
  readonly maximumCreateMutationExecuteCalls: 16;
  readonly emptySnapshotHash: string;
  readonly desiredManifestHash: string;
  readonly createChangeSetHash: string;
  readonly createChunkCount: number;
  readonly createChunks: readonly ReviewedChunk[];
  readonly canonicalSnapshotHash: string;
  readonly canonicalNoopChangeSetHash: string;
  readonly updateNodeId: string;
  readonly updateChangeSetHash: string;
  readonly modifiedSnapshotHash: string;
  readonly repairChangeSetHash: string;
  readonly lostResponseChangeSetHash: string;
  readonly captureMediaType: 'image/jpeg';
  readonly steps: readonly [
    'empty-sandbox-gate',
    'transaction-scoped-sandbox-lease-claim',
    'chunked-400-create',
    'canonical-noop',
    'one-node-display-name-update',
    'exact-inverse-repair',
    'controlled-post-chunk-response-loss',
    'exact-session-reconnect-and-lease-bound-snapshot',
    'exact-prefix-classification',
    'verified-conservative-compensation',
    'jpeg-viewport-capture',
    'final-canonical-noop',
  ];
}

interface ReviewedSequence {
  readonly emptySnapshot: RobloxSnapshot;
  readonly manifest: RobloxManifest;
  readonly createChangeSet: RobloxChangeSet;
  readonly canonicalSnapshot: RobloxSnapshot;
  readonly canonicalNoopPlan: RobloxChangeSet;
  readonly modifiedManifest: RobloxManifest;
  readonly updatePlan: RobloxChangeSet;
  readonly modifiedSnapshot: RobloxSnapshot;
  readonly repairPlan: RobloxChangeSet;
  readonly envelope: BatchLiveAuthorizationEnvelope;
  readonly envelopeHash: string;
}

function liveSmokeError(message: string): StudioAdapterError {
  return new StudioAdapterError([studioDiagnostic('studio.transaction_failed', '', message)]);
}

function planOrThrow(
  snapshot: Readonly<RobloxSnapshot>,
  manifest: Readonly<RobloxManifest>,
): RobloxChangeSet {
  const plan = planRobloxChangeSet(snapshot, manifest);
  if (!plan.success) {
    throw liveSmokeError(
      `Live reconciliation failed safely: ${plan.diagnostics[0]?.code ?? 'unknown'}.`,
    );
  }
  return plan.changeSet;
}

function simulateOrThrow(
  snapshot: Readonly<RobloxSnapshot>,
  changeSet: Readonly<RobloxChangeSet>,
  label: string,
): RobloxSnapshot {
  const simulation = simulateRobloxChangeSet(snapshot, changeSet);
  if (!simulation.success) throw liveSmokeError(`${label} could not be simulated safely.`);
  return simulation.snapshot;
}

function modifiedDisplayNameManifest(manifest: Readonly<RobloxManifest>): RobloxManifest {
  const selected = manifest.nodes.find((node) => node.className === 'Part');
  if (selected === undefined) {
    throw liveSmokeError('Cliffwatch has no reviewed harmless display-name update target.');
  }
  return {
    ...structuredClone(manifest),
    nodes: manifest.nodes.map((node) =>
      node.id === selected.id
        ? { ...structuredClone(node), name: `${node.name} Live Check` }
        : structuredClone(node),
    ),
  };
}

function assertHash(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw liveSmokeError(`${label} drifted from the director-reviewed canonical value.`);
  }
}

function assertExactInverse(
  updatePlan: Readonly<RobloxChangeSet>,
  repairPlan: Readonly<RobloxChangeSet>,
): void {
  const update = updatePlan.operations[0];
  const repair = repairPlan.operations[0];
  if (
    updatePlan.operations.length !== 1 ||
    repairPlan.operations.length !== 1 ||
    update?.type !== 'update' ||
    repair?.type !== 'update' ||
    repair.before.id !== update.after.id ||
    repair.after.id !== update.before.id ||
    hashCanonicalJson(repair.before as unknown as JsonValue) !==
      hashCanonicalJson(update.after as unknown as JsonValue) ||
    hashCanonicalJson(repair.after as unknown as JsonValue) !==
      hashCanonicalJson(update.before as unknown as JsonValue)
  ) {
    throw liveSmokeError('The reviewed repair is not the exact inverse one-node update.');
  }
}

async function loadReviewedSequence(): Promise<ReviewedSequence> {
  const manifestInput: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  const manifestValidation = validateRobloxManifest(manifestInput);
  if (!manifestValidation.valid) {
    throw liveSmokeError('The checked-in Cliffwatch manifest is invalid.');
  }
  const manifest = normalizeRobloxManifest(manifestValidation.value);

  const createInput: unknown = JSON.parse(await readFile(reviewedChangeSetPath, 'utf8'));
  const createValidation = validateRobloxChangeSet(createInput);
  if (!createValidation.valid) {
    throw liveSmokeError('The checked-in Cliffwatch create Change Set is invalid.');
  }
  const createChangeSet = createValidation.value;

  const emptyInput: unknown = JSON.parse(await readFile(reviewedEmptySnapshotPath, 'utf8'));
  const emptyValidation = validateRobloxSnapshot(emptyInput);
  if (!emptyValidation.valid) {
    throw liveSmokeError('The checked-in Cliffwatch empty Snapshot is invalid.');
  }
  const emptySnapshot = emptyValidation.value;

  const independentlyPlanned = planOrThrow(emptySnapshot, manifest);
  assertHash(
    hashRobloxChangeSet(independentlyPlanned),
    hashRobloxChangeSet(createChangeSet),
    'Independently planned create Change Set',
  );
  assertHash(
    createChangeSet.preconditions.desiredManifestHash,
    hashRobloxManifest(manifest),
    'Create Change Set desired manifest',
  );
  assertHash(
    hashRobloxChangeSet(createChangeSet),
    EXPECTED_CREATE_CHANGE_SET_HASH,
    'Cliffwatch create Change Set hash',
  );
  if (
    createChangeSet.operations.length !== EXPECTED_CREATE_OPERATION_COUNT ||
    createChangeSet.summary.creates !== EXPECTED_CREATE_OPERATION_COUNT ||
    createChangeSet.summary.total !== EXPECTED_CREATE_OPERATION_COUNT
  ) {
    throw liveSmokeError('Cliffwatch create operation count drifted from 400.');
  }

  const canonicalSnapshot = simulateOrThrow(emptySnapshot, createChangeSet, 'Create transition');
  assertHash(
    hashRobloxSnapshot(canonicalSnapshot),
    EXPECTED_CANONICAL_SNAPSHOT_HASH,
    'Canonical Cliffwatch Snapshot hash',
  );
  assertHash(
    createChangeSet.preconditions.resultSnapshotHash,
    EXPECTED_CANONICAL_SNAPSHOT_HASH,
    'Create Change Set result Snapshot hash',
  );

  const canonicalNoopPlan = planOrThrow(canonicalSnapshot, manifest);
  if (canonicalNoopPlan.operations.length !== 0) {
    throw liveSmokeError('The canonical Cliffwatch Snapshot does not reconcile as a no-op.');
  }
  assertHash(
    hashRobloxChangeSet(canonicalNoopPlan),
    EXPECTED_CANONICAL_NOOP_CHANGE_SET_HASH,
    'Canonical no-op Change Set hash',
  );

  const modifiedManifest = modifiedDisplayNameManifest(manifest);
  const updatePlan = planOrThrow(canonicalSnapshot, modifiedManifest);
  const modifiedSnapshot = simulateOrThrow(canonicalSnapshot, updatePlan, 'Display-name update');
  assertHash(
    hashRobloxSnapshot(modifiedSnapshot),
    EXPECTED_MODIFIED_SNAPSHOT_HASH,
    'One-node modified Snapshot hash',
  );
  const repairPlan = planOrThrow(modifiedSnapshot, manifest);
  assertExactInverse(updatePlan, repairPlan);
  const repairedSnapshot = simulateOrThrow(modifiedSnapshot, repairPlan, 'Inverse repair');
  assertHash(
    hashRobloxSnapshot(repairedSnapshot),
    EXPECTED_CANONICAL_SNAPSHOT_HASH,
    'Repaired canonical Snapshot hash',
  );

  const batchOperations = buildStudioBatchOperations(
    createChangeSet.operations,
    emptySnapshot.nodes,
  );
  const chunks = chunkStudioBatchOperations({
    projectId: createChangeSet.preconditions.projectId,
    changeSetHash: hashRobloxChangeSet(createChangeSet),
    sandboxLeaseId: LEASE_WIDTH_SIZING_VALUE,
    operations: batchOperations,
  });
  if (
    chunks.length !== EXPECTED_CREATE_CHUNK_COUNT ||
    chunks.length > MAX_REVIEWED_CREATE_MUTATION_CALLS
  ) {
    throw liveSmokeError('The reviewed 400-create transition is not exactly 13 mutation chunks.');
  }
  const reviewedChunks = chunks.map((chunk) => ({
    chunkIndex: chunk.chunkIndex,
    operationCount: chunk.operationIds.length,
    chunkId: chunk.chunkId,
    canonicalRequestBytes: chunk.canonicalRequestBytes,
  }));

  const update = updatePlan.operations[0];
  if (update?.type !== 'update' || updatePlan.operations.length !== 1) {
    throw liveSmokeError('The harmless reviewed transition is not exactly one update.');
  }
  const envelope: BatchLiveAuthorizationEnvelope = {
    schemaVersion: '0.1.0',
    sequence: 'worldwright-milestone-4-batch-live-smoke-v2',
    projectId: manifest.source.projectId,
    createOperationCount: EXPECTED_CREATE_OPERATION_COUNT,
    maxBatchOperations: STUDIO_MCP_MAX_BATCH_OPERATIONS,
    maxBatchPayloadBytes: STUDIO_MCP_MAX_BATCH_PAYLOAD_BYTES,
    maximumCreateMutationExecuteCalls: MAX_REVIEWED_CREATE_MUTATION_CALLS,
    emptySnapshotHash: hashRobloxSnapshot(emptySnapshot),
    desiredManifestHash: hashRobloxManifest(manifest),
    createChangeSetHash: hashRobloxChangeSet(createChangeSet),
    createChunkCount: reviewedChunks.length,
    createChunks: reviewedChunks,
    canonicalSnapshotHash: hashRobloxSnapshot(canonicalSnapshot),
    canonicalNoopChangeSetHash: hashRobloxChangeSet(canonicalNoopPlan),
    updateNodeId: update.before.id,
    updateChangeSetHash: hashRobloxChangeSet(updatePlan),
    modifiedSnapshotHash: hashRobloxSnapshot(modifiedSnapshot),
    repairChangeSetHash: hashRobloxChangeSet(repairPlan),
    lostResponseChangeSetHash: hashRobloxChangeSet(updatePlan),
    captureMediaType: STUDIO_MCP_VIEWPORT_MEDIA_TYPE,
    steps: [
      'empty-sandbox-gate',
      'transaction-scoped-sandbox-lease-claim',
      'chunked-400-create',
      'canonical-noop',
      'one-node-display-name-update',
      'exact-inverse-repair',
      'controlled-post-chunk-response-loss',
      'exact-session-reconnect-and-lease-bound-snapshot',
      'exact-prefix-classification',
      'verified-conservative-compensation',
      'jpeg-viewport-capture',
      'final-canonical-noop',
    ],
  };
  return {
    emptySnapshot,
    manifest,
    createChangeSet,
    canonicalSnapshot,
    canonicalNoopPlan,
    modifiedManifest,
    updatePlan,
    modifiedSnapshot,
    repairPlan,
    envelope,
    envelopeHash: hashCanonicalJson(envelope as unknown as JsonValue),
  };
}

function normalizedArgs(args: readonly string[]): readonly string[] {
  return args[0] === '--' ? args.slice(1) : args;
}

function isReviewRequest(args: readonly string[]): boolean {
  const values = normalizedArgs(args);
  return values.length === 1 && values[0] === '--review';
}

function parseLiveArguments(args: readonly string[]): {
  readonly studioId: string;
  readonly confirmation: string;
} {
  const usage =
    'Usage:\n  pnpm studio:batch-live-smoke -- --review\n  pnpm studio:batch-live-smoke -- --studio-id <exact-id> --confirm <full-reviewed-sequence-sha256>';
  const values = normalizedArgs(args);
  if (values.length !== 4) throw liveSmokeError(usage);
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (
      (name !== '--studio-id' && name !== '--confirm') ||
      value === undefined ||
      value.length === 0 ||
      parsed.has(name)
    ) {
      throw liveSmokeError(usage);
    }
    parsed.set(name, value);
  }
  const studioId = parsed.get('--studio-id');
  const confirmation = parsed.get('--confirm');
  if (studioId === undefined || confirmation === undefined) throw liveSmokeError(usage);
  return { studioId, confirmation };
}

function assertAuthorization(confirmation: string, envelopeHash: string): void {
  if (!/^[0-9a-f]{64}$/u.test(confirmation) || confirmation !== envelopeHash) {
    throw liveSmokeError(
      'The --confirm value must equal the complete lowercase reviewed live-sequence SHA-256.',
    );
  }
}

function requireSuccessfulEvidence(
  evidence: Readonly<StudioChangeSetApplyEvidence>,
  label: string,
): asserts evidence is StudioChangeSetApplyEvidence & {
  readonly result: Extract<ApplyResult, { success: true }>;
} {
  if (!evidence.result.success) {
    throw liveSmokeError(`${label} failed safely at ${evidence.result.stage}.`);
  }
}

function assertTransportReport(
  report: unknown,
  label: string,
): asserts report is StudioTransportReport {
  const validation = validateStudioTransportReport(report);
  if (!validation.valid) {
    throw liveSmokeError(`${label} did not satisfy the strict Studio Transport Report contract.`);
  }
}

function receiptContext(
  probe: Readonly<StudioSandboxProbe>,
  changeSet: Readonly<RobloxChangeSet>,
  viewportEvidence?: Readonly<StudioViewportEvidence>,
): StudioReceiptContext {
  return {
    studio: {
      studioId: probe.studioId,
      placeName: probe.placeName,
      placeId: 0,
      gameId: 0,
    },
    projectId: changeSet.preconditions.projectId,
    target: changeSet.preconditions.target,
    changeSetHash: hashRobloxChangeSet(changeSet),
    baseSnapshotHash: changeSet.preconditions.baseSnapshotHash,
    desiredManifestHash: changeSet.preconditions.desiredManifestHash,
    expectedResultSnapshotHash: changeSet.preconditions.resultSnapshotHash,
    operationsPlanned: changeSet.operations.length,
    ...(viewportEvidence === undefined ? {} : { viewportEvidence }),
  };
}

function assertReceipt(receipt: unknown, label: string): void {
  const validation = validateStudioApplyReceipt(receipt);
  if (!validation.valid) {
    throw liveSmokeError(`${label} did not satisfy the strict receipt contract.`);
  }
}

async function reserveEvidenceTargets(): Promise<
  ReadonlyMap<ReservedEvidenceName, ReservedEvidenceTarget>
> {
  await mkdir(evidenceDirectory, { recursive: true });
  const targets = new Map<ReservedEvidenceName, ReservedEvidenceTarget>();
  try {
    for (const name of reservedEvidenceNames) {
      const path = resolve(evidenceDirectory, name);
      targets.set(name, { path, handle: await open(path, 'wx') });
    }
    return targets;
  } catch (error: unknown) {
    await cleanupEvidenceTargets(targets, false);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw liveSmokeError(
        'Milestone 4 live evidence already exists; archive or remove it before mutation.',
      );
    }
    throw liveSmokeError('The Milestone 4 live evidence destination could not be reserved safely.');
  }
}

async function cleanupEvidenceTargets(
  targets: ReadonlyMap<ReservedEvidenceName, ReservedEvidenceTarget>,
  keep: boolean,
): Promise<void> {
  await Promise.all(
    [...targets.values()].map(async (target) => {
      await target.handle.close().catch(() => undefined);
      if (!keep) await unlink(target.path).catch(() => undefined);
    }),
  );
}

async function writeReservedEvidence(
  targets: ReadonlyMap<ReservedEvidenceName, ReservedEvidenceTarget>,
  name: ReservedEvidenceName,
  content: string | Uint8Array,
): Promise<void> {
  const target = targets.get(name);
  if (target === undefined) {
    throw liveSmokeError('A required live evidence target was not reserved.');
  }
  await target.handle.writeFile(content);
  await target.handle.sync();
  await target.handle.close();
}

function offlineReview(sequence: Readonly<ReviewedSequence>): string {
  return stringifyCanonicalJson({
    review: 'Worldwright Milestone 4 offline batch live-sequence authorization',
    authorizationEnvelope: sequence.envelope,
    requiredLiveSequenceConfirmationHash: sequence.envelopeHash,
    canonicalFixtureChecksPassed: true,
    connectionAttempted: false,
    mutationAttempted: false,
  } as unknown as JsonValue);
}

function preMutationReview(
  sequence: Readonly<ReviewedSequence>,
  probe: Readonly<StudioSandboxProbe>,
  initialHash: string,
): string {
  return stringifyCanonicalJson({
    review: 'Worldwright Milestone 4 live pre-mutation review',
    placeId: probe.placeId,
    gameId: probe.gameId,
    editMode: probe.dataModelMode,
    playtesting: probe.playtesting,
    exactEmptySnapshotHash: initialHash,
    operations: sequence.createChangeSet.summary,
    createChangeSetHash: sequence.envelope.createChangeSetHash,
    baseSnapshotHash: sequence.createChangeSet.preconditions.baseSnapshotHash,
    desiredManifestHash: sequence.envelope.desiredManifestHash,
    expectedResultSnapshotHash: sequence.envelope.canonicalSnapshotHash,
    createChunkCount: sequence.envelope.createChunkCount,
    createChunks: sequence.envelope.createChunks,
    requiredLiveSequenceConfirmationHash: sequence.envelopeHash,
    authorization: 'exact-full-reviewed-live-sequence-hash-matched',
  } as unknown as JsonValue);
}

async function runLive(sequence: Readonly<ReviewedSequence>, studioId: string): Promise<void> {
  const evidenceTargets = await reserveEvidenceTargets();
  let evidenceComplete = false;
  let adapter: Awaited<ReturnType<typeof connectSelectedStudioMcpAdapter>> | undefined;
  try {
    adapter = await connectSelectedStudioMcpAdapter(studioId);
    const probe = assertSandboxStudioProbe(await adapter.probeSelectedStudio());
    const scope = {
      projectId: sequence.manifest.source.projectId,
      target: { service: 'Workspace' as const },
    };

    const initialSnapshot = await adapter.readSnapshot(scope);
    const initialHash = hashRobloxSnapshot(initialSnapshot);
    if (
      initialSnapshot.nodes.length !== 0 ||
      initialSnapshot.unmanagedRoots.length !== 0 ||
      initialHash !== sequence.envelope.emptySnapshotHash
    ) {
      throw liveSmokeError(
        'The selected sandbox is not the exact fresh empty Cliffwatch project snapshot; no mutation was attempted.',
      );
    }
    const liveCreatePlan = planOrThrow(initialSnapshot, sequence.manifest);
    assertHash(
      hashRobloxChangeSet(liveCreatePlan),
      sequence.envelope.createChangeSetHash,
      'Live empty-sandbox create plan',
    );
    const liveChunks = chunkStudioBatchOperations({
      projectId: liveCreatePlan.preconditions.projectId,
      changeSetHash: hashRobloxChangeSet(liveCreatePlan),
      sandboxLeaseId: LEASE_WIDTH_SIZING_VALUE,
      operations: buildStudioBatchOperations(liveCreatePlan.operations, initialSnapshot.nodes),
    });
    if (
      liveChunks.length !== sequence.envelope.createChunks.length ||
      !liveChunks.every((chunk, index) => {
        const reviewed = sequence.envelope.createChunks[index];
        return (
          reviewed !== undefined &&
          chunk.chunkId === reviewed.chunkId &&
          chunk.canonicalRequestBytes === reviewed.canonicalRequestBytes &&
          chunk.operationIds.length === reviewed.operationCount
        );
      })
    ) {
      throw liveSmokeError(
        'The live create chunk plan differs from the exact reviewed chunk sequence.',
      );
    }
    process.stderr.write(preMutationReview(sequence, probe, initialHash));

    const createEvidence = await adapter.applyChangeSetDetailed(liveCreatePlan);
    requireSuccessfulEvidence(createEvidence, 'Chunked 400-node create');
    assertTransportReport(createEvidence.transportReport, 'Create transport report');
    if (
      createEvidence.result.status !== 'applied' ||
      createEvidence.result.operationsAttempted !== EXPECTED_CREATE_OPERATION_COUNT ||
      createEvidence.result.finalSnapshotHash !== sequence.envelope.canonicalSnapshotHash ||
      createEvidence.transportReport.operationsAppliedBeforeFailure !==
        EXPECTED_CREATE_OPERATION_COUNT ||
      createEvidence.transportReport.chunksPlanned !== sequence.envelope.createChunks.length ||
      createEvidence.transportReport.chunksCompleted !== sequence.envelope.createChunks.length ||
      createEvidence.transportReport.mutationExecuteCalls !==
        sequence.envelope.createChunks.length ||
      createEvidence.transportReport.mutationExecuteCalls > MAX_REVIEWED_CREATE_MUTATION_CALLS ||
      createEvidence.transportReport.sandboxLeaseClaimCalls !== 1 ||
      createEvidence.transportReport.uncertainTransportEvents !== 0
    ) {
      throw liveSmokeError(
        'The live 400-node chunked apply did not match the reviewed call-count proof.',
      );
    }

    const createdSnapshot = await adapter.readSnapshot(scope);
    const createdHash = hashRobloxSnapshot(createdSnapshot);
    assertHash(
      createdHash,
      sequence.envelope.canonicalSnapshotHash,
      'Observed live create result Snapshot',
    );

    const noOpPlan = planOrThrow(createdSnapshot, sequence.manifest);
    assertHash(
      hashRobloxChangeSet(noOpPlan),
      sequence.envelope.canonicalNoopChangeSetHash,
      'Live canonical no-op Change Set',
    );
    const noOpEvidence = await adapter.applyChangeSetDetailed(noOpPlan);
    requireSuccessfulEvidence(noOpEvidence, 'Canonical no-op apply');
    assertTransportReport(noOpEvidence.transportReport, 'No-op transport report');
    if (
      noOpEvidence.result.status !== 'noop' ||
      noOpEvidence.result.operationsAttempted !== 0 ||
      noOpEvidence.transportReport.mutationExecuteCalls !== 0 ||
      noOpEvidence.transportReport.sandboxLeaseClaimCalls !== 0
    ) {
      throw liveSmokeError('The canonical no-op transaction attempted a mutation.');
    }

    const updatePlan = planOrThrow(createdSnapshot, sequence.modifiedManifest);
    assertHash(
      hashRobloxChangeSet(updatePlan),
      sequence.envelope.updateChangeSetHash,
      'Live harmless display-name update Change Set',
    );
    const updateEvidence = await adapter.applyChangeSetDetailed(updatePlan);
    requireSuccessfulEvidence(updateEvidence, 'One-node display-name update');
    assertTransportReport(updateEvidence.transportReport, 'Update transport report');
    if (
      updateEvidence.result.operationsAttempted !== 1 ||
      updateEvidence.transportReport.mutationExecuteCalls !== 1 ||
      updateEvidence.transportReport.sandboxLeaseClaimCalls !== 1 ||
      updateEvidence.result.finalSnapshotHash !== sequence.envelope.modifiedSnapshotHash
    ) {
      throw liveSmokeError(
        'The one-node update did not produce the exact reviewed modified state.',
      );
    }
    const modifiedSnapshot = await adapter.readSnapshot(scope);
    assertHash(
      hashRobloxSnapshot(modifiedSnapshot),
      sequence.envelope.modifiedSnapshotHash,
      'Observed one-node modified Snapshot',
    );

    const repairPlan = planOrThrow(modifiedSnapshot, sequence.manifest);
    assertHash(
      hashRobloxChangeSet(repairPlan),
      sequence.envelope.repairChangeSetHash,
      'Live exact inverse repair Change Set',
    );
    const repairEvidence = await adapter.applyChangeSetDetailed(repairPlan);
    requireSuccessfulEvidence(repairEvidence, 'Exact inverse repair');
    assertTransportReport(repairEvidence.transportReport, 'Repair transport report');
    if (
      repairEvidence.result.operationsAttempted !== 1 ||
      repairEvidence.transportReport.mutationExecuteCalls !== 1 ||
      repairEvidence.transportReport.sandboxLeaseClaimCalls !== 1 ||
      repairEvidence.result.finalSnapshotHash !== sequence.envelope.canonicalSnapshotHash
    ) {
      throw liveSmokeError('The exact inverse repair did not restore the canonical state.');
    }

    const preLossSnapshot = await adapter.readSnapshot(scope);
    assertHash(
      hashRobloxSnapshot(preLossSnapshot),
      sequence.envelope.canonicalSnapshotHash,
      'Controlled response-loss base Snapshot',
    );
    const lostResponsePlan = planOrThrow(preLossSnapshot, sequence.modifiedManifest);
    assertHash(
      hashRobloxChangeSet(lostResponsePlan),
      sequence.envelope.lostResponseChangeSetHash,
      'Controlled response-loss Change Set',
    );
    const lostResponseEvidence = await applyStudioChangeSetWithLostBatchAcknowledgment(
      adapter,
      lostResponsePlan,
    );
    assertTransportReport(lostResponseEvidence.transportReport, 'Lost-response transport report');
    const lostResult = lostResponseEvidence.result;
    if (
      lostResult.success ||
      lostResult.stage !== 'apply' ||
      lostResult.operationsAttempted !== 1 ||
      lostResult.observedFailureSnapshotHash !== sequence.envelope.modifiedSnapshotHash ||
      !lostResult.rollback.attempted ||
      !lostResult.rollback.succeeded ||
      lostResult.rollback.restoredSnapshotHash !== sequence.envelope.canonicalSnapshotHash ||
      lostResponseEvidence.transportReport.uncertainTransportEvents !== 1 ||
      lostResponseEvidence.transportReport.reconnectAttempts !== 1 ||
      lostResponseEvidence.transportReport.reconnectsSucceeded !== 1 ||
      lostResponseEvidence.transportReport.sandboxLeaseClaimCalls !== 1 ||
      lostResponseEvidence.transportReport.compensationOperationsAttempted !== 1 ||
      lostResponseEvidence.transportReport.compensationOperationsApplied !== 1 ||
      lostResponseEvidence.transportReport.compensationChunksAttempted !== 1 ||
      lostResponseEvidence.transportReport.compensationChunksCompleted !== 1 ||
      lostResponseEvidence.transportReport.mutationExecuteCalls !== 2 ||
      lostResponseEvidence.transportReport.finalOutcome !== 'failed-restored'
    ) {
      throw liveSmokeError(
        'Controlled response loss did not reconnect and verify conservative compensation.',
      );
    }

    const observedProgress = classifyRobloxChangeSetProgress(
      sequence.canonicalSnapshot,
      sequence.modifiedSnapshot,
      lostResponsePlan,
    );
    if (
      !observedProgress.success ||
      observedProgress.classification !== 'complete' ||
      observedProgress.appliedPrefixLength !== 1 ||
      observedProgress.observedSnapshotHash !== lostResult.observedFailureSnapshotHash
    ) {
      throw liveSmokeError(
        'The lost-response observation was not the exact authorized complete prefix.',
      );
    }

    const restoredSnapshot = await adapter.readSnapshot(scope);
    const restoredHash = hashRobloxSnapshot(restoredSnapshot);
    assertHash(
      restoredHash,
      sequence.envelope.canonicalSnapshotHash,
      'Post-compensation restored Snapshot',
    );

    const capture = await adapter.captureViewport({
      captureId: 'worldwright-milestone-4-batch-recovery',
    });
    if (capture.mediaType !== sequence.envelope.captureMediaType) {
      throw liveSmokeError('Studio viewport evidence did not match the reviewed media type.');
    }
    const viewportEvidence = createViewportEvidence(capture.mediaType, capture.bytes);

    const finalSnapshot = await adapter.readSnapshot(scope);
    const finalHash = hashRobloxSnapshot(finalSnapshot);
    assertHash(finalHash, sequence.envelope.canonicalSnapshotHash, 'Final live Snapshot');
    const finalNoOpPlan = planOrThrow(finalSnapshot, sequence.manifest);
    if (
      finalNoOpPlan.operations.length !== 0 ||
      hashRobloxChangeSet(finalNoOpPlan) !== sequence.envelope.canonicalNoopChangeSetHash
    ) {
      throw liveSmokeError('Final live reconciliation is not the exact canonical no-op.');
    }

    const appliedReceipt = buildStudioApplyReceipt(
      receiptContext(probe, liveCreatePlan, viewportEvidence),
      createEvidence.result,
    );
    const noOpReceipt = buildStudioApplyReceipt(
      receiptContext(probe, noOpPlan),
      noOpEvidence.result,
    );
    const rollbackReceipt = buildStudioApplyReceipt(
      receiptContext(probe, lostResponsePlan),
      lostResponseEvidence.result,
    );
    assertReceipt(appliedReceipt, 'Applied receipt');
    assertReceipt(noOpReceipt, 'No-op receipt');
    assertReceipt(rollbackReceipt, 'Lost-response rollback receipt');

    const reports = {
      create: createEvidence.transportReport,
      noop: noOpEvidence.transportReport,
      update: updateEvidence.transportReport,
      repair: repairEvidence.transportReport,
      lostResponse: lostResponseEvidence.transportReport,
    } as const;
    const transportReportHashes = {
      create: hashStudioTransportReport(reports.create),
      noop: hashStudioTransportReport(reports.noop),
      update: hashStudioTransportReport(reports.update),
      repair: hashStudioTransportReport(reports.repair),
      lostResponse: hashStudioTransportReport(reports.lostResponse),
    } as const;
    const receiptHashes = {
      applied: hashStudioApplyReceipt(appliedReceipt),
      noop: hashStudioApplyReceipt(noOpReceipt),
      lostResponseRollback: hashStudioApplyReceipt(rollbackReceipt),
    } as const;
    const summary = buildBatchLiveShareableSummary({
      placeId: probe.placeId,
      gameId: probe.gameId,
      authorizationEnvelopeHash: sequence.envelopeHash,
      createOperationCount: EXPECTED_CREATE_OPERATION_COUNT,
      createChunkCount: createEvidence.transportReport.chunksCompleted,
      createMutationExecuteCallCount: createEvidence.transportReport.mutationExecuteCalls,
      createChangeSetHash: sequence.envelope.createChangeSetHash,
      createChunkIds: sequence.envelope.createChunks.map((chunk) => chunk.chunkId),
      expectedResultHash: sequence.envelope.canonicalSnapshotHash,
      observedResultHash: createdHash,
      noOpChangeSetHash: sequence.envelope.canonicalNoopChangeSetHash,
      noOpMutationExecuteCallCount: noOpEvidence.transportReport.mutationExecuteCalls,
      noOpSandboxLeaseClaimCallCount: noOpEvidence.transportReport.sandboxLeaseClaimCalls,
      updateResultHash: updateEvidence.result.finalSnapshotHash,
      repairResultHash: repairEvidence.result.finalSnapshotHash,
      controlledResponseLossObservedHash: lostResult.observedFailureSnapshotHash,
      observedProgressClassification: observedProgress.classification,
      observedAppliedPrefixLength: observedProgress.appliedPrefixLength,
      reconnectCount: lostResponseEvidence.transportReport.reconnectsSucceeded,
      compensationAttempted: lostResult.rollback.attempted,
      compensationSucceeded: lostResult.rollback.succeeded,
      restoredHash,
      finalHash,
      finalNoOpOperations: finalNoOpPlan.operations.length,
      transportReportHashes,
      receiptHashes,
      viewportEvidence,
    });

    await writeReservedEvidence(
      evidenceTargets,
      'authorization.json',
      stringifyCanonicalJson({
        authorizationEnvelope: sequence.envelope,
        authorizationEnvelopeHash: sequence.envelopeHash,
      } as unknown as JsonValue),
    );
    await writeReservedEvidence(
      evidenceTargets,
      'applied.receipt.json',
      stringifyStudioApplyReceipt(appliedReceipt),
    );
    await writeReservedEvidence(
      evidenceTargets,
      'noop.receipt.json',
      stringifyStudioApplyReceipt(noOpReceipt),
    );
    await writeReservedEvidence(
      evidenceTargets,
      'lost-response-rollback.receipt.json',
      stringifyStudioApplyReceipt(rollbackReceipt),
    );
    await writeReservedEvidence(
      evidenceTargets,
      'create.transport-report.json',
      stringifyStudioTransportReport(reports.create),
    );
    await writeReservedEvidence(
      evidenceTargets,
      'noop.transport-report.json',
      stringifyStudioTransportReport(reports.noop),
    );
    await writeReservedEvidence(
      evidenceTargets,
      'update.transport-report.json',
      stringifyStudioTransportReport(reports.update),
    );
    await writeReservedEvidence(
      evidenceTargets,
      'repair.transport-report.json',
      stringifyStudioTransportReport(reports.repair),
    );
    await writeReservedEvidence(
      evidenceTargets,
      'lost-response.transport-report.json',
      stringifyStudioTransportReport(reports.lostResponse),
    );
    await writeReservedEvidence(
      evidenceTargets,
      'summary.json',
      stringifyCanonicalJson(summary as unknown as JsonValue),
    );
    await writeReservedEvidence(evidenceTargets, 'viewport.jpg', capture.bytes);
    evidenceComplete = true;
    process.stdout.write(
      stringifyCanonicalJson({ success: true, ...summary } as unknown as JsonValue),
    );
  } finally {
    await adapter?.close().catch(() => undefined);
    await cleanupEvidenceTargets(evidenceTargets, evidenceComplete);
  }
}

async function run(): Promise<void> {
  const sequence = await loadReviewedSequence();
  const args = process.argv.slice(2);
  if (isReviewRequest(args)) {
    process.stdout.write(offlineReview(sequence));
    return;
  }
  const { studioId, confirmation } = parseLiveArguments(args);
  assertAuthorization(confirmation, sequence.envelopeHash);
  await runLive(sequence, studioId);
}

try {
  await run();
} catch (error: unknown) {
  process.stderr.write(`${sanitizedErrorMessage(error)}\n`);
  process.exitCode = 1;
}
