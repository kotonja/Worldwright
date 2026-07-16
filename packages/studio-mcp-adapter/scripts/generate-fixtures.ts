import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { ApplyResult, RobloxManagedNode, RobloxManifest } from '@worldwright/roblox-compiler';

import { canonicalNodeMetadata } from '../src/engine-state.js';
import { buildStudioApplyReceipt } from '../src/receipt.js';
import { stringifyStudioApplyReceipt, stringifyStudioBridgeResponse } from '../src/normalize.js';
import type {
  StudioBridgeResponse,
  StudioRawManagedNode,
  StudioReceiptContext,
} from '../src/types.js';

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
        mediaType: 'image/png',
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

function expectedCFrame(node: Readonly<RobloxManagedNode>): number[] {
  if (node.className === 'Folder' || node.className === 'Model') return [];
  const { position, rotationEulerDegreesXYZ: rotation } = node.properties;
  const x = (rotation.x * Math.PI) / 180;
  const y = (rotation.y * Math.PI) / 180;
  const z = (rotation.z * Math.PI) / 180;
  const cx = Math.cos(x);
  const sx = Math.sin(x);
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cz = Math.cos(z);
  const sz = Math.sin(z);
  return [
    position.x,
    position.y,
    position.z,
    cy * cz,
    -cy * sz,
    sy,
    cx * sz + sx * sy * cz,
    cx * cz - sx * sy * sz,
    -sx * cy,
    sx * sz - cx * sy * cz,
    sx * cz + cx * sy * sz,
    cx * cy,
  ];
}

function rawNode(node: Readonly<RobloxManagedNode>): StudioRawManagedNode {
  const metadata = canonicalNodeMetadata(node);
  const common = {
    entityId: node.id,
    projectId: node.attributes.WorldwrightProjectId,
    name: node.name,
    parentKind: node.parentId === undefined ? ('Workspace' as const) : ('managed' as const),
    ...(node.parentId === undefined ? {} : { parentEntityId: node.parentId }),
    entityKind: node.entityKind,
    compilerVersion: node.attributes.WorldwrightCompilerVersion,
    ...(node.attributes.WorldwrightSourceHash === undefined
      ? {}
      : { sourceHash: node.attributes.WorldwrightSourceHash }),
    adapterVersion: '0.1.0' as const,
    stateJson: metadata.json,
    stateHash: metadata.hash,
  };
  if (node.className === 'Folder' || node.className === 'Model') {
    return { ...common, className: node.className, properties: {} };
  }
  return {
    ...common,
    className: node.className,
    properties: {
      cframe: expectedCFrame(node),
      size: [node.properties.size.x, node.properties.size.y, node.properties.size.z],
      anchored: node.properties.anchored,
      ...(node.className === 'Part' ? { shape: node.properties.shape } : {}),
      material: node.properties.material,
      color: [
        node.properties.color.r / 255,
        node.properties.color.g / 255,
        node.properties.color.b / 255,
      ],
      transparency: node.properties.transparency,
      canCollide: node.properties.canCollide,
      canQuery: node.properties.canQuery,
      canTouch: node.properties.canTouch,
      castShadow: node.properties.castShadow,
    },
  };
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
  const rawNodes = manifest.nodes.map((node) => rawNode(node));
  const root = rawNodes.find((node) => node.entityId === manifest.rootNodeId)!;
  const primitive = rawNodes.find(
    (
      node,
    ): node is Extract<
      StudioRawManagedNode,
      { className: 'Part' | 'WedgePart' | 'CornerWedgePart' }
    > => node.className !== 'Folder' && node.className !== 'Model',
  )!;
  const driftedPrimitive = structuredClone(primitive);
  driftedPrimitive.properties.cframe[0]! += 0.25;
  return [
    bridgeArtifact('Empty project bridge response', 'empty-project.response.json', {
      protocolVersion: '0.1.0',
      action: 'snapshot',
      ok: true,
      snapshot: { projectId: manifest.source.projectId, nodes: [], unmanagedRoots: [] },
    }),
    bridgeArtifact('Cliffwatch project bridge response', 'cliffwatch-project.response.json', {
      protocolVersion: '0.1.0',
      action: 'snapshot',
      ok: true,
      snapshot: { projectId: manifest.source.projectId, nodes: rawNodes, unmanagedRoots: [] },
    }),
    bridgeArtifact('Unmanaged child bridge response', 'unmanaged-child.response.json', {
      protocolVersion: '0.1.0',
      action: 'snapshot',
      ok: true,
      snapshot: {
        projectId: manifest.source.projectId,
        nodes: [root],
        unmanagedRoots: [
          {
            parentEntityId: root.entityId,
            className: 'Folder',
            name: 'Creator Content',
            structuralPath: `${root.entityId}/1/Folder/Creator Content`,
            ordinal: 1,
          },
        ],
      },
    }),
    bridgeArtifact('Engine drift bridge response', 'engine-drift.response.json', {
      protocolVersion: '0.1.0',
      action: 'snapshot',
      ok: true,
      snapshot: {
        projectId: manifest.source.projectId,
        nodes: [driftedPrimitive],
        unmanagedRoots: [],
      },
    }),
  ];
}

export function renderStudioFixtures(): readonly StudioFixtureArtifact[] {
  return [...renderStudioBridgeFixtures(), ...renderStudioReceiptFixtures()];
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
