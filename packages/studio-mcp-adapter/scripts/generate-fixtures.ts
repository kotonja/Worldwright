import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  classifyRobloxChangeSetProgress,
  planRobloxChangeSet,
  type ApplyResult,
  type RobloxManifest,
} from '@worldwright/roblox-compiler';

import { chunkStudioBatchOperations } from '../src/batch/chunk.js';
import {
  stringifyStudioBatchRequest,
  stringifyStudioBatchResponse,
} from '../src/batch/normalize.js';
import { buildStudioBatchOperations } from '../src/batch/request.js';
import { buildStudioApplyReceipt } from '../src/receipt.js';
import {
  buildStudioProgressReport,
  stringifyStudioProgressReport,
} from '../src/progress-report.js';
import {
  buildStudioTransportReport,
  stringifyStudioTransportReport,
} from '../src/transport-report.js';
import { stringifyStudioApplyReceipt, stringifyStudioBridgeResponse } from '../src/normalize.js';
import type { StudioBridgeResponse, StudioReceiptContext } from '../src/types.js';
import { compactSnapshotFixture } from './compact-snapshot-fixture.js';

export interface StudioReceiptFixtureArtifact {
  readonly label: string;
  readonly path: string;
  readonly content: string;
}

export type StudioFixtureArtifact = StudioReceiptFixtureArtifact;

const hashes = {
  changeSet: '1'.repeat(64),
  base: '2'.repeat(64),
  desired: '3'.repeat(64),
  expected: '4'.repeat(64),
  failure: '5'.repeat(64),
  viewport: '6'.repeat(64),
} as const;

const commonContext: StudioReceiptContext = {
  studio: {
    studioId: '[redacted]',
    placeName: 'Fixture Sandbox',
    placeId: 0,
    gameId: 0,
  },
  projectId: 'fixture-project',
  target: { service: 'Workspace' },
  changeSetHash: hashes.changeSet,
  baseSnapshotHash: hashes.base,
  desiredManifestHash: hashes.desired,
  expectedResultSnapshotHash: hashes.expected,
  operationsPlanned: 2,
};

function fixtureResult(status: 'applied' | 'noop' | 'rolled-back'): ApplyResult {
  switch (status) {
    case 'applied':
      return {
        success: true,
        status: 'applied',
        snapshot: {
          schemaVersion: '0.1.0',
          projectId: 'fixture-project',
          target: { service: 'Workspace' },
          nodes: [],
          unmanagedRoots: [],
        },
        diagnostics: [],
        operationsAttempted: 2,
        initialSnapshotHash: hashes.base,
        finalSnapshotHash: hashes.expected,
      };
    case 'noop':
      return {
        success: true,
        status: 'noop',
        snapshot: {
          schemaVersion: '0.1.0',
          projectId: 'fixture-project',
          target: { service: 'Workspace' },
          nodes: [],
          unmanagedRoots: [],
        },
        diagnostics: [],
        operationsAttempted: 0,
        initialSnapshotHash: hashes.base,
        finalSnapshotHash: hashes.base,
      };
    case 'rolled-back':
      return {
        success: false,
        stage: 'verification',
        diagnostics: [
          {
            code: 'transaction.verification_failed',
            severity: 'error',
            path: '',
            message: 'Observed snapshot did not match the expected result.',
          },
        ],
        operationsAttempted: 1,
        rollback: {
          attempted: true,
          succeeded: true,
          restoredSnapshotHash: hashes.base,
        },
        initialSnapshotHash: hashes.base,
        observedFailureSnapshotHash: hashes.failure,
      };
  }
}

export function renderStudioReceiptFixtures(): readonly StudioReceiptFixtureArtifact[] {
  const applied = buildStudioApplyReceipt(
    {
      ...commonContext,
      viewportEvidence: {
        mediaType: 'image/jpeg',
        sha256: hashes.viewport,
        byteLength: 1024,
      },
    },
    fixtureResult('applied'),
  );
  const noop = buildStudioApplyReceipt(
    { ...commonContext, expectedResultSnapshotHash: hashes.base, operationsPlanned: 0 },
    fixtureResult('noop'),
  );
  const rolledBack = buildStudioApplyReceipt(commonContext, fixtureResult('rolled-back'));
  return [
    {
      label: 'Applied Studio receipt',
      path: fileURLToPath(new URL('../fixtures/receipts/applied.receipt.json', import.meta.url)),
      content: stringifyStudioApplyReceipt(applied),
    },
    {
      label: 'No-op Studio receipt',
      path: fileURLToPath(new URL('../fixtures/receipts/noop.receipt.json', import.meta.url)),
      content: stringifyStudioApplyReceipt(noop),
    },
    {
      label: 'Rolled-back Studio receipt',
      path: fileURLToPath(
        new URL('../fixtures/receipts/rolled-back.receipt.json', import.meta.url),
      ),
      content: stringifyStudioApplyReceipt(rolledBack),
    },
  ];
}

function loadCliffwatchManifest(): RobloxManifest {
  return JSON.parse(
    readFileSync(
      new URL(
        '../../architecture-planner/fixtures/manifest/cliffwatch-mansion-blockout.manifest.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as RobloxManifest;
}

function bridgeArtifact(
  label: string,
  filename: string,
  response: StudioBridgeResponse,
): StudioFixtureArtifact {
  return {
    label,
    path: fileURLToPath(new URL(`../fixtures/bridge/${filename}`, import.meta.url)),
    content: stringifyStudioBridgeResponse(response),
  };
}

export function renderStudioBridgeFixtures(): readonly StudioFixtureArtifact[] {
  const manifest = loadCliffwatchManifest();
  const root = manifest.nodes.find((node) => node.id === manifest.rootNodeId)!;
  const primitive = manifest.nodes.find(
    (node) => node.className !== 'Folder' && node.className !== 'Model',
  )!;
  const unmanaged = {
    parentEntityId: root.id,
    className: 'Folder',
    name: 'Creator Content',
    structuralPath: `${root.id}/Folder/Creator Content/1`,
    ordinal: 1,
  } as const;
  return [
    bridgeArtifact('Empty project bridge response', 'empty-project.response.json', {
      protocolVersion: '0.1.0',
      action: 'snapshot',
      ok: true,
      compactSnapshot: compactSnapshotFixture(manifest.source.projectId, [], []),
    }),
    bridgeArtifact('Cliffwatch project bridge response', 'cliffwatch-project.response.json', {
      protocolVersion: '0.1.0',
      action: 'snapshot',
      ok: true,
      compactSnapshot: compactSnapshotFixture(manifest.source.projectId, manifest.nodes, []),
    }),
    bridgeArtifact('Unmanaged child bridge response', 'unmanaged-child.response.json', {
      protocolVersion: '0.1.0',
      action: 'snapshot',
      ok: true,
      compactSnapshot: compactSnapshotFixture(manifest.source.projectId, [root], [unmanaged]),
    }),
    bridgeArtifact('Engine drift bridge response', 'engine-drift.response.json', {
      protocolVersion: '0.1.0',
      action: 'snapshot',
      ok: false,
      diagnostic: {
        code: 'studio.engine_state_drift',
        message: 'Managed instance state is invalid.',
        nodeId: primitive.id,
        property: 'CFrame',
      },
    }),
  ];
}

function loadCourtyardManifest(): RobloxManifest {
  return JSON.parse(
    readFileSync(
      new URL(
        '../../roblox-compiler/fixtures/manifest/primitive-courtyard.manifest.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as RobloxManifest;
}

function renderStudioBatchAndReportFixtures(): readonly StudioFixtureArtifact[] {
  const manifest = loadCourtyardManifest();
  const base = {
    schemaVersion: '0.1.0' as const,
    projectId: manifest.source.projectId,
    target: { service: 'Workspace' as const },
    nodes: [],
    unmanagedRoots: [],
  };
  const plan = planRobloxChangeSet(base, manifest);
  if (!plan.success) throw new Error('Studio batch fixture planning invariant failed.');
  const request = chunkStudioBatchOperations({
    projectId: manifest.source.projectId,
    changeSetHash: 'a'.repeat(64),
    operations: buildStudioBatchOperations(plan.changeSet.operations, []),
  })[0]!.request;
  const response = {
    protocolVersion: '0.1.0' as const,
    action: 'apply_chunk' as const,
    ok: true as const,
    changeSetHash: request.changeSetHash,
    chunkId: request.chunkId,
    chunkIndex: request.chunkIndex,
    operationsAttempted: request.operations.length,
    operationsApplied: request.operations.length,
    completedOperationIds: request.operations.map((operation) => operation.operationId),
  };
  const progress = buildStudioProgressReport(
    classifyRobloxChangeSetProgress(base, base, plan.changeSet),
  );
  const transport = buildStudioTransportReport(
    {
      changeSetHash: request.changeSetHash,
      operationsPlanned: request.operations.length,
      operationsAttempted: request.operations.length,
      operationsAppliedBeforeFailure: request.operations.length,
      chunksPlanned: 1,
      chunksAttempted: 1,
      chunksCompleted: 1,
      mutationExecuteCalls: 1,
      uncertainTransportEvents: 0,
      reconnectAttempts: 0,
      reconnectsSucceeded: 0,
      compensationOperationsAttempted: 0,
      compensationOperationsApplied: 0,
      compensationChunksAttempted: 0,
      compensationChunksCompleted: 0,
    },
    'applied',
  );
  return [
    {
      label: 'Studio batch request',
      path: fileURLToPath(new URL('../fixtures/batch/create.request.json', import.meta.url)),
      content: stringifyStudioBatchRequest(request),
    },
    {
      label: 'Studio batch response',
      path: fileURLToPath(new URL('../fixtures/batch/create.response.json', import.meta.url)),
      content: stringifyStudioBatchResponse(response),
    },
    {
      label: 'Studio base progress report',
      path: fileURLToPath(new URL('../fixtures/progress/base.progress.json', import.meta.url)),
      content: stringifyStudioProgressReport(progress),
    },
    {
      label: 'Studio applied transport report',
      path: fileURLToPath(
        new URL('../fixtures/transport-reports/applied.transport-report.json', import.meta.url),
      ),
      content: stringifyStudioTransportReport(transport),
    },
  ];
}

export function renderStudioFixtures(): readonly StudioFixtureArtifact[] {
  return [
    ...renderStudioBridgeFixtures(),
    ...renderStudioReceiptFixtures(),
    ...renderStudioBatchAndReportFixtures(),
  ];
}

export async function generateStudioFixtures(): Promise<void> {
  for (const artifact of renderStudioFixtures()) {
    await mkdir(dirname(artifact.path), { recursive: true });
    await writeFile(artifact.path, artifact.content, 'utf8');
  }
}

const entryPath = process.argv[1];
const isMain =
  entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href;

if (isMain) {
  void generateStudioFixtures().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Studio adapter fixture generation failed: ${message}\n`);
    process.exitCode = 1;
  });
}
