import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ROBLOX_SNAPSHOT_VERSION } from '../src/contract-schema.js';
import { compileWorldSpecToRobloxManifest } from '../src/compile.js';
import {
  normalizeRobloxManagedNode,
  normalizeRobloxSnapshot,
  stringifyRobloxChangeSet,
  stringifyRobloxManifest,
  stringifyRobloxSnapshot,
} from '../src/normalize.js';
import { planRobloxChangeSet } from '../src/reconcile.js';
import type {
  RobloxManagedNode,
  RobloxManifest,
  RobloxPartNode,
  RobloxSnapshot,
} from '../src/types.js';

export interface FixtureArtifact {
  readonly label: string;
  readonly path: string;
  readonly content: string;
}

export const primitiveCourtyardInputPath = fileURLToPath(
  new URL('../fixtures/worldspec/primitive-courtyard.worldspec.json', import.meta.url),
);

const manifestArtifactPath = fileURLToPath(
  new URL('../fixtures/manifest/primitive-courtyard.manifest.json', import.meta.url),
);
const emptySnapshotArtifactPath = fileURLToPath(
  new URL('../fixtures/snapshots/empty.snapshot.json', import.meta.url),
);
const modifiedSnapshotArtifactPath = fileURLToPath(
  new URL('../fixtures/snapshots/modified.snapshot.json', import.meta.url),
);
const createChangeSetArtifactPath = fileURLToPath(
  new URL('../fixtures/change-sets/create-courtyard.change-set.json', import.meta.url),
);
const repairChangeSetArtifactPath = fileURLToPath(
  new URL('../fixtures/change-sets/repair-courtyard.change-set.json', import.meta.url),
);

function requirePartNode(manifest: Readonly<RobloxManifest>, id: string): RobloxPartNode {
  const node = manifest.nodes.find((candidate) => candidate.id === id);
  if (node === undefined || node.className !== 'Part') {
    throw new Error(`Fixture derivation expected managed Part node "${id}".`);
  }
  return node;
}

function createEmptySnapshot(manifest: Readonly<RobloxManifest>): RobloxSnapshot {
  return normalizeRobloxSnapshot({
    schemaVersion: ROBLOX_SNAPSHOT_VERSION,
    projectId: manifest.source.projectId,
    target: manifest.target,
    nodes: [],
    unmanagedRoots: [],
  });
}

function createModifiedSnapshot(manifest: Readonly<RobloxManifest>): RobloxSnapshot {
  const floor = requirePartNode(manifest, 'plaza-floor');
  const obsoleteTemplate = requirePartNode(manifest, 'courtyard-guide-orb');
  const modifiedFloor: RobloxPartNode = {
    ...floor,
    name: 'Legacy Concrete Plaza Floor',
    properties: {
      ...floor.properties,
      material: 'Concrete',
    },
  };
  const obsoleteNode: RobloxPartNode = {
    ...obsoleteTemplate,
    id: 'obsolete-courtyard-marker',
    entityKind: 'object',
    name: 'Obsolete Courtyard Marker',
    parentId: 'courtyard-details',
    attributes: {
      ...obsoleteTemplate.attributes,
      WorldwrightEntityId: 'obsolete-courtyard-marker',
      WorldwrightEntityKind: 'object',
    },
    properties: {
      ...obsoleteTemplate.properties,
      position: { x: 8, y: 1, z: 8 },
    },
  };
  const nodes: RobloxManagedNode[] = manifest.nodes.map((node) =>
    node.id === floor.id ? modifiedFloor : normalizeRobloxManagedNode(node),
  );
  nodes.push(obsoleteNode);

  return normalizeRobloxSnapshot({
    schemaVersion: ROBLOX_SNAPSHOT_VERSION,
    projectId: manifest.source.projectId,
    target: manifest.target,
    rootNodeId: manifest.rootNodeId,
    nodes,
    unmanagedRoots: [],
  });
}

async function compilePrimitiveCourtyard(): Promise<RobloxManifest> {
  const source = await readFile(primitiveCourtyardInputPath, 'utf8');
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    throw new Error('Primitive courtyard authored input is not valid JSON.');
  }

  const result = compileWorldSpecToRobloxManifest(input);
  if (!result.success) {
    const codes = result.diagnostics.map((entry) => entry.code).join(', ');
    throw new Error(`Primitive courtyard compilation failed: ${codes || 'unknown error'}.`);
  }
  return result.manifest;
}

export async function renderRobloxCompilerFixtures(): Promise<readonly FixtureArtifact[]> {
  const manifest = await compilePrimitiveCourtyard();
  const emptySnapshot = createEmptySnapshot(manifest);
  const modifiedSnapshot = createModifiedSnapshot(manifest);
  const createPlan = planRobloxChangeSet(emptySnapshot, manifest);
  if (!createPlan.success) {
    const codes = createPlan.diagnostics.map((entry) => entry.code).join(', ');
    throw new Error(`Empty-scene fixture planning failed: ${codes || 'unknown error'}.`);
  }
  const repairPlan = planRobloxChangeSet(modifiedSnapshot, manifest);
  if (!repairPlan.success) {
    const codes = repairPlan.diagnostics.map((entry) => entry.code).join(', ');
    throw new Error(`Modified-scene fixture planning failed: ${codes || 'unknown error'}.`);
  }

  return [
    {
      label: 'primitive courtyard manifest',
      path: manifestArtifactPath,
      content: stringifyRobloxManifest(manifest),
    },
    {
      label: 'empty scene snapshot',
      path: emptySnapshotArtifactPath,
      content: stringifyRobloxSnapshot(emptySnapshot),
    },
    {
      label: 'modified scene snapshot',
      path: modifiedSnapshotArtifactPath,
      content: stringifyRobloxSnapshot(modifiedSnapshot),
    },
    {
      label: 'empty-scene creation change set',
      path: createChangeSetArtifactPath,
      content: stringifyRobloxChangeSet(createPlan.changeSet),
    },
    {
      label: 'modified-scene repair change set',
      path: repairChangeSetArtifactPath,
      content: stringifyRobloxChangeSet(repairPlan.changeSet),
    },
  ];
}

export async function generateRobloxCompilerFixtures(): Promise<void> {
  const artifacts = await renderRobloxCompilerFixtures();
  for (const artifact of artifacts) {
    await mkdir(dirname(artifact.path), { recursive: true });
    await writeFile(artifact.path, artifact.content, 'utf8');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const entryPath = process.argv[1];
const isMain =
  entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href;

if (isMain) {
  void generateRobloxCompilerFixtures().catch((error: unknown) => {
    process.stderr.write(`Roblox compiler fixture generation failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
