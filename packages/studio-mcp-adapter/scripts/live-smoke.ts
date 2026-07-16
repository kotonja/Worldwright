import { mkdir, open, readFile, unlink, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
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
import { createViewportEvidence } from '../src/capture.js';
import { sanitizedErrorMessage } from '../src/diagnostics.js';
import { assertSandboxStudioProbe, type StudioSandboxProbe } from '../src/mcp/session.js';
import { stringifyStudioApplyReceipt } from '../src/normalize.js';
import { buildStudioApplyReceipt } from '../src/receipt.js';
import { applyStudioChangeSetWithPostMutationFault } from '../src/testing.js';
import type { StudioReceiptContext, StudioViewportEvidence } from '../src/types.js';
import { hashStudioApplyReceipt } from '../src/hashing.js';
import { hashCanonicalJson, stringifyCanonicalJson, type JsonValue } from '../src/json.js';
import { validateStudioApplyReceipt } from '../src/validate.js';
import {
  assertLiveSmokeSequenceAuthorization,
  classifyLiveSmokeInitialState,
  formatLiveSmokeAuthorizationReview,
  formatLiveSmokePreMutationReview,
  hashLiveSmokeAuthorizationEnvelope,
  isLiveSmokeReviewRequest,
  parseLiveSmokeArguments,
  type LiveSmokeAuthorizationEnvelope,
} from './live-smoke-helpers.js';

const evidenceDirectory = fileURLToPath(
  new URL('../../../.worldwright/live-milestone-3/', import.meta.url),
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
  'applied.receipt.json',
  'noop.receipt.json',
  'rollback.receipt.json',
  'summary.json',
  'viewport.png',
] as const;
type ReservedEvidenceName = (typeof reservedEvidenceNames)[number];

interface ReservedEvidenceTarget {
  readonly handle: FileHandle;
  readonly path: string;
}

async function loadManifest(): Promise<RobloxManifest> {
  const input: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  const validation = validateRobloxManifest(input);
  if (!validation.valid) throw new Error('The checked-in Cliffwatch manifest is invalid.');
  return normalizeRobloxManifest(validation.value);
}

async function loadReviewedCreateChangeSet(manifest: Readonly<RobloxManifest>): Promise<{
  readonly changeSet: RobloxChangeSet;
  readonly emptySnapshot: RobloxSnapshot;
}> {
  const changeSetInput: unknown = JSON.parse(await readFile(reviewedChangeSetPath, 'utf8'));
  const changeSetValidation = validateRobloxChangeSet(changeSetInput);
  if (!changeSetValidation.valid) {
    throw new Error('The reviewed Cliffwatch change-set fixture is invalid.');
  }
  const emptySnapshotInput: unknown = JSON.parse(await readFile(reviewedEmptySnapshotPath, 'utf8'));
  const emptySnapshotValidation = validateRobloxSnapshot(emptySnapshotInput);
  if (!emptySnapshotValidation.valid) {
    throw new Error('The reviewed Cliffwatch empty-snapshot fixture is invalid.');
  }
  const independentlyPlanned = planOrThrow(emptySnapshotValidation.value, manifest);
  if (
    hashRobloxChangeSet(independentlyPlanned) !== hashRobloxChangeSet(changeSetValidation.value) ||
    changeSetValidation.value.preconditions.desiredManifestHash !== hashRobloxManifest(manifest)
  ) {
    throw new Error('The reviewed Cliffwatch fixtures do not describe one exact transition.');
  }
  return {
    changeSet: changeSetValidation.value,
    emptySnapshot: emptySnapshotValidation.value,
  };
}

function planOrThrow(
  snapshot: Readonly<RobloxSnapshot>,
  manifest: Readonly<RobloxManifest>,
): RobloxChangeSet {
  const plan = planRobloxChangeSet(snapshot, manifest);
  if (!plan.success) {
    throw new Error(
      `Live reconciliation failed safely: ${plan.diagnostics[0]?.code ?? 'unknown'}.`,
    );
  }
  return plan.changeSet;
}

function modifiedDisplayNameManifest(manifest: Readonly<RobloxManifest>): RobloxManifest {
  const selected = manifest.nodes.find((node) => node.className === 'Part');
  if (selected === undefined)
    throw new Error('Cliffwatch has no harmless display-name update target.');
  return {
    ...structuredClone(manifest),
    nodes: manifest.nodes.map((node) =>
      node.id === selected.id
        ? { ...structuredClone(node), name: `${node.name} Live Check` }
        : structuredClone(node),
    ),
  };
}

function simulateOrThrow(
  snapshot: Readonly<RobloxSnapshot>,
  changeSet: Readonly<RobloxChangeSet>,
  label: string,
): RobloxSnapshot {
  const simulation = simulateRobloxChangeSet(snapshot, changeSet);
  if (!simulation.success) {
    throw new Error(`${label} could not be simulated from the reviewed fixtures.`);
  }
  return simulation.snapshot;
}

function reviewedLiveSequence(
  emptySnapshot: Readonly<RobloxSnapshot>,
  manifest: Readonly<RobloxManifest>,
  createChangeSet: Readonly<RobloxChangeSet>,
): {
  readonly canonicalSnapshot: RobloxSnapshot;
  readonly canonicalNoopPlan: RobloxChangeSet;
  readonly modifiedManifest: RobloxManifest;
  readonly updatePlan: RobloxChangeSet;
  readonly modifiedSnapshot: RobloxSnapshot;
  readonly repairPlan: RobloxChangeSet;
  readonly envelope: LiveSmokeAuthorizationEnvelope;
  readonly envelopeHash: string;
} {
  const canonicalSnapshot = simulateOrThrow(emptySnapshot, createChangeSet, 'Create transition');
  const canonicalHash = hashRobloxSnapshot(canonicalSnapshot);
  if (canonicalHash !== createChangeSet.preconditions.resultSnapshotHash) {
    throw new Error('Reviewed create simulation did not produce the canonical snapshot hash.');
  }
  const canonicalNoopPlan = planOrThrow(canonicalSnapshot, manifest);
  if (canonicalNoopPlan.operations.length !== 0) {
    throw new Error('Reviewed canonical snapshot does not reconcile as a no-op.');
  }
  const modifiedManifest = modifiedDisplayNameManifest(manifest);
  const updatePlan = planOrThrow(canonicalSnapshot, modifiedManifest);
  const updateOperation = updatePlan.operations[0];
  if (updatePlan.operations.length !== 1 || updateOperation?.type !== 'update') {
    throw new Error('Reviewed display-name transition is not exactly one update.');
  }
  const modifiedSnapshot = simulateOrThrow(canonicalSnapshot, updatePlan, 'Update transition');
  const repairPlan = planOrThrow(modifiedSnapshot, manifest);
  const repairOperation = repairPlan.operations[0];
  if (
    repairPlan.operations.length !== 1 ||
    repairOperation?.type !== 'update' ||
    repairOperation.before.id !== updateOperation.after.id ||
    repairOperation.after.id !== updateOperation.before.id ||
    hashCanonicalJson(repairOperation.before as unknown as JsonValue) !==
      hashCanonicalJson(updateOperation.after as unknown as JsonValue) ||
    hashCanonicalJson(repairOperation.after as unknown as JsonValue) !==
      hashCanonicalJson(updateOperation.before as unknown as JsonValue)
  ) {
    throw new Error('Reviewed repair is not the exact inverse one-node update.');
  }
  const repairedSnapshot = simulateOrThrow(modifiedSnapshot, repairPlan, 'Repair transition');
  if (hashRobloxSnapshot(repairedSnapshot) !== canonicalHash) {
    throw new Error('Reviewed inverse repair does not restore the canonical snapshot.');
  }
  const envelope: LiveSmokeAuthorizationEnvelope = {
    schemaVersion: '0.1.0',
    sequence: 'worldwright-milestone-3-live-smoke-v1',
    projectId: manifest.source.projectId,
    createChangeSetHash: hashRobloxChangeSet(createChangeSet),
    canonicalSnapshotHash: canonicalHash,
    canonicalNoopChangeSetHash: hashRobloxChangeSet(canonicalNoopPlan),
    updateNodeId: updateOperation.before.id,
    updateChangeSetHash: hashRobloxChangeSet(updatePlan),
    modifiedSnapshotHash: hashRobloxSnapshot(modifiedSnapshot),
    repairChangeSetHash: hashRobloxChangeSet(repairPlan),
    faultChangeSetHash: hashRobloxChangeSet(updatePlan),
    captureMediaType: 'image/png',
    steps: [
      'initial-reconciliation',
      'canonical-noop',
      'one-node-display-name-update',
      'exact-inverse-repair',
      'post-update-fault',
      'verified-compensation',
      'png-viewport-capture',
      'final-canonical-noop',
    ],
  };
  return {
    canonicalSnapshot,
    canonicalNoopPlan,
    modifiedManifest,
    updatePlan,
    modifiedSnapshot,
    repairPlan,
    envelope,
    envelopeHash: hashLiveSmokeAuthorizationEnvelope(envelope),
  };
}

function receiptContext(
  probe: Readonly<StudioSandboxProbe>,
  changeSet: Readonly<RobloxChangeSet>,
  evidence?: Readonly<StudioViewportEvidence>,
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
    ...(evidence === undefined ? {} : { viewportEvidence: evidence }),
  };
}

function requireSuccess(
  result: Readonly<ApplyResult>,
  label: string,
): asserts result is Extract<ApplyResult, { success: true }> {
  if (!result.success) throw new Error(`${label} failed safely at ${result.stage}.`);
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
      throw new Error(
        'Live evidence already exists; archive or remove the untracked prior evidence before mutation.',
      );
    }
    throw new Error('The live evidence destination could not be reserved safely.');
  }
}

async function writeReservedEvidence(
  targets: ReadonlyMap<ReservedEvidenceName, ReservedEvidenceTarget>,
  name: ReservedEvidenceName,
  content: string | Uint8Array,
): Promise<void> {
  const target = targets.get(name);
  if (target === undefined) throw new Error('A required live evidence target was not reserved.');
  await target.handle.writeFile(content);
  await target.handle.sync();
  await target.handle.close();
}

function assertReceiptValidation(receipt: unknown, label: string): void {
  const validation = validateStudioApplyReceipt(receipt);
  if (!validation.valid) throw new Error(`${label} did not satisfy the strict receipt contract.`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const manifest = await loadManifest();
  const reviewed = await loadReviewedCreateChangeSet(manifest);
  const sequence = reviewedLiveSequence(reviewed.emptySnapshot, manifest, reviewed.changeSet);
  if (isLiveSmokeReviewRequest(args)) {
    process.stdout.write(
      formatLiveSmokeAuthorizationReview(sequence.envelope, sequence.envelopeHash),
    );
    return;
  }
  const { studioId, confirmation } = parseLiveSmokeArguments(args);
  const canonicalResultHash = sequence.envelope.canonicalSnapshotHash;
  const reviewedCreateChangeSetHash = sequence.envelope.createChangeSetHash;
  assertLiveSmokeSequenceAuthorization(confirmation, sequence.envelopeHash);
  const evidenceTargets = await reserveEvidenceTargets();
  let evidenceComplete = false;
  let adapter: Awaited<ReturnType<typeof connectSelectedStudioMcpAdapter>> | undefined;
  try {
    adapter = await connectSelectedStudioMcpAdapter(studioId);
    const probe = assertSandboxStudioProbe(await adapter.probeSelectedStudio());
    const scope = {
      projectId: manifest.source.projectId,
      target: { service: 'Workspace' as const },
    };
    const initial = await adapter.readSnapshot(scope);
    const initialHash = hashRobloxSnapshot(initial);
    const initialState = classifyLiveSmokeInitialState(
      initial.nodes.length,
      initialHash,
      canonicalResultHash,
    );

    const initialPlan = planOrThrow(initial, manifest);
    const initialPlanHash = hashRobloxChangeSet(initialPlan);
    const expectedInitialPlanHash =
      initialState === 'empty'
        ? reviewedCreateChangeSetHash
        : sequence.envelope.canonicalNoopChangeSetHash;
    if (initialPlanHash !== expectedInitialPlanHash) {
      throw new Error('The live initial plan does not match its exact reviewed transition.');
    }
    process.stderr.write(
      formatLiveSmokePreMutationReview({
        studioId,
        placeName: probe.placeName,
        initialState,
        changeSet: initialPlan,
        plannedChangeSetHash: initialPlanHash,
        authorizationEnvelope: sequence.envelope,
        authorizationEnvelopeHash: sequence.envelopeHash,
      }),
    );
    const initialResult = await adapter.applyChangeSet(initialPlan);
    requireSuccess(initialResult, 'Initial Cliffwatch apply');
    const finalCreated = await adapter.readSnapshot(scope);
    const finalCreatedHash = hashRobloxSnapshot(finalCreated);
    if (
      finalCreatedHash !== initialPlan.preconditions.resultSnapshotHash ||
      finalCreatedHash !== canonicalResultHash
    ) {
      throw new Error('Initial live result hash does not match the reviewed Cliffwatch result.');
    }

    const noOpPlan = planOrThrow(finalCreated, manifest);
    if (
      noOpPlan.operations.length !== 0 ||
      hashRobloxChangeSet(noOpPlan) !== sequence.envelope.canonicalNoopChangeSetHash
    ) {
      throw new Error('Second live plan was not the exact reviewed no-op.');
    }
    const noOpResult = await adapter.applyChangeSet(noOpPlan);
    requireSuccess(noOpResult, 'No-op apply');
    if (noOpResult.status !== 'noop' || noOpResult.operationsAttempted !== 0) {
      throw new Error('No-op transaction attempted a mutation.');
    }

    const updatePlan = planOrThrow(finalCreated, sequence.modifiedManifest);
    if (hashRobloxChangeSet(updatePlan) !== sequence.envelope.updateChangeSetHash) {
      throw new Error('Harmless display-name plan was not the exact reviewed update.');
    }
    const updateResult = await adapter.applyChangeSet(updatePlan);
    requireSuccess(updateResult, 'One-node update');
    if (updateResult.finalSnapshotHash !== updatePlan.preconditions.resultSnapshotHash) {
      throw new Error('One-node update result hash mismatch.');
    }

    const modifiedSnapshot = await adapter.readSnapshot(scope);
    if (
      hashRobloxSnapshot(modifiedSnapshot) !== sequence.envelope.modifiedSnapshotHash ||
      hashRobloxSnapshot(modifiedSnapshot) !== updatePlan.preconditions.resultSnapshotHash
    ) {
      throw new Error('One-node update did not produce the exact reviewed modified snapshot.');
    }
    const repairPlan = planOrThrow(modifiedSnapshot, manifest);
    if (hashRobloxChangeSet(repairPlan) !== sequence.envelope.repairChangeSetHash) {
      throw new Error('Repair plan was not the exact reviewed inverse update.');
    }
    const repairResult = await adapter.applyChangeSet(repairPlan);
    requireSuccess(repairResult, 'Original-manifest repair');
    if (repairResult.finalSnapshotHash !== canonicalResultHash) {
      throw new Error('Repair did not restore the canonical Cliffwatch hash.');
    }

    const preFault = await adapter.readSnapshot(scope);
    const preFaultHash = hashRobloxSnapshot(preFault);
    if (preFaultHash !== canonicalResultHash) {
      throw new Error('Controlled-failure base is not the canonical reviewed snapshot.');
    }
    const faultPlan = planOrThrow(preFault, sequence.modifiedManifest);
    if (hashRobloxChangeSet(faultPlan) !== sequence.envelope.faultChangeSetHash) {
      throw new Error('Controlled-failure plan was not the exact reviewed one-node update.');
    }
    const faultResult = await applyStudioChangeSetWithPostMutationFault(
      adapter,
      faultPlan,
      'update',
    );
    if (
      faultResult.success ||
      faultResult.stage !== 'apply' ||
      faultResult.operationsAttempted !== 1 ||
      !faultResult.rollback.attempted ||
      !faultResult.rollback.succeeded ||
      faultResult.rollback.restoredSnapshotHash !== preFaultHash ||
      faultResult.observedFailureSnapshotHash !== faultPlan.preconditions.resultSnapshotHash
    ) {
      throw new Error('Controlled post-update failure did not verify exact compensation.');
    }

    const restored = await adapter.readSnapshot(scope);
    const restoredHashBeforeCapture = hashRobloxSnapshot(restored);
    if (
      restoredHashBeforeCapture !== canonicalResultHash ||
      restoredHashBeforeCapture !== preFaultHash
    ) {
      throw new Error('Post-fault sandbox is not the exact original Cliffwatch state.');
    }

    const capture = await adapter.captureViewport({ captureId: 'worldwright-milestone-3' });
    if (capture.mediaType !== 'image/png') {
      throw new Error('Studio viewport evidence was not a PNG image.');
    }
    const viewportEvidence = createViewportEvidence(capture.mediaType, capture.bytes);

    const finalSnapshot = await adapter.readSnapshot(scope);
    const restoredHash = hashRobloxSnapshot(finalSnapshot);
    if (restoredHash !== canonicalResultHash || restoredHash !== preFaultHash) {
      throw new Error('Final post-capture snapshot is not the exact canonical state.');
    }
    const finalNoOp = planOrThrow(finalSnapshot, manifest);
    if (
      finalNoOp.operations.length !== 0 ||
      hashRobloxChangeSet(finalNoOp) !== sequence.envelope.canonicalNoopChangeSetHash
    ) {
      throw new Error('Final post-capture state is not the exact reviewed no-op.');
    }

    const appliedSource = initialResult.status === 'applied' ? initialResult : repairResult;
    const appliedPlan = initialResult.status === 'applied' ? initialPlan : repairPlan;
    const appliedReceipt = buildStudioApplyReceipt(
      receiptContext(probe, appliedPlan, viewportEvidence),
      appliedSource,
    );
    const noOpReceipt = buildStudioApplyReceipt(receiptContext(probe, noOpPlan), noOpResult);
    const rollbackReceipt = buildStudioApplyReceipt(receiptContext(probe, faultPlan), faultResult);
    assertReceiptValidation(appliedReceipt, 'Applied receipt');
    assertReceiptValidation(noOpReceipt, 'No-op receipt');
    assertReceiptValidation(rollbackReceipt, 'Rollback receipt');
    const summary = {
      schemaVersion: '0.1.0',
      placeId: probe.placeId,
      gameId: probe.gameId,
      initialState,
      initialTransactionStatus: initialResult.status,
      baseSnapshotHash: initialPlan.preconditions.baseSnapshotHash,
      initialPlanSummary: initialPlan.summary,
      createOperationCount: initialPlan.summary.creates,
      reviewedCreateChangeSetHash,
      initialPlanHash,
      authorizationEnvelopeHash: sequence.envelopeHash,
      authorizationMatchedReviewedLiveSequence: true,
      expectedResultHash: canonicalResultHash,
      observedResultHash: finalCreatedHash,
      noOpOperations: noOpPlan.operations.length,
      finalNoOpOperations: finalNoOp.operations.length,
      updateResultHash: updateResult.finalSnapshotHash,
      repairResultHash: repairResult.finalSnapshotHash,
      controlledFailureHash: faultResult.observedFailureSnapshotHash,
      restoredHash,
      viewportEvidence,
      receiptsValidated: ['applied', 'noop', 'rollback'],
      liveOwnershipBoundaryCheck: 'not-run-manual-setup-required',
      receiptHashes: {
        applied: hashStudioApplyReceipt(appliedReceipt),
        noop: hashStudioApplyReceipt(noOpReceipt),
        rollback: hashStudioApplyReceipt(rollbackReceipt),
      },
    } as const;
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
      'rollback.receipt.json',
      stringifyStudioApplyReceipt(rollbackReceipt),
    );
    await writeReservedEvidence(
      evidenceTargets,
      'summary.json',
      stringifyCanonicalJson(summary as JsonValue),
    );
    await writeReservedEvidence(evidenceTargets, 'viewport.png', capture.bytes);
    evidenceComplete = true;
    process.stdout.write(
      stringifyCanonicalJson({ success: true, ...summary } as unknown as JsonValue),
    );
  } finally {
    await adapter?.close().catch(() => undefined);
    await cleanupEvidenceTargets(evidenceTargets, evidenceComplete);
  }
}

try {
  await run();
} catch (error: unknown) {
  process.stderr.write(`${sanitizedErrorMessage(error)}\n`);
  process.exitCode = 1;
}
