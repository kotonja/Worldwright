import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ROBLOX_SNAPSHOT_VERSION,
  compileWorldSpecToRobloxManifest,
  normalizeRobloxSnapshot,
  planRobloxChangeSet,
  simulateRobloxChangeSet,
  stringifyRobloxChangeSet,
  stringifyRobloxManifest,
  stringifyRobloxSnapshot,
  type RobloxManifest,
  type RobloxSnapshot,
} from '@worldwright/roblox-compiler';
import { stringifyWorldSpec } from '@worldwright/worldspec';

import { emitArchitectureWorldSpec } from '../src/emit-worldspec.js';
import { stringifyArchitecturePlan } from '../src/normalize.js';
import { planArchitectureWorldSpec } from '../src/planner.js';

export interface ArchitectureFixtureArtifact {
  readonly label: string;
  readonly path: string;
  readonly content: string;
}

export const cliffwatchMansionInputPath = fileURLToPath(
  new URL('../fixtures/input/cliffwatch-mansion-program.worldspec.json', import.meta.url),
);

const planArtifactPath = fileURLToPath(
  new URL('../fixtures/plans/cliffwatch-mansion.architecture-plan.json', import.meta.url),
);
const worldSpecArtifactPath = fileURLToPath(
  new URL('../fixtures/worldspec/cliffwatch-mansion-blockout.worldspec.json', import.meta.url),
);
const manifestArtifactPath = fileURLToPath(
  new URL('../fixtures/manifest/cliffwatch-mansion-blockout.manifest.json', import.meta.url),
);
const emptySnapshotArtifactPath = fileURLToPath(
  new URL('../fixtures/snapshots/empty-cliffwatch.snapshot.json', import.meta.url),
);
const createChangeSetArtifactPath = fileURLToPath(
  new URL('../fixtures/change-sets/create-cliffwatch-blockout.change-set.json', import.meta.url),
);

function diagnosticCodes(diagnostics: readonly { readonly code: string }[]): string {
  const codes = diagnostics.map((entry) => entry.code).join(', ');
  return codes.length === 0 ? 'unknown error' : codes;
}

function canonicalEmptySnapshot(manifest: Readonly<RobloxManifest>): RobloxSnapshot {
  return normalizeRobloxSnapshot({
    schemaVersion: ROBLOX_SNAPSHOT_VERSION,
    projectId: manifest.source.projectId,
    target: manifest.target,
    nodes: [],
    unmanagedRoots: [],
  });
}

async function parseAuthoredInput(): Promise<unknown> {
  const source = await readFile(cliffwatchMansionInputPath, 'utf8');
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error('Cliffwatch mansion authored input is not valid JSON.');
  }
}

/** Renders and verifies the complete deterministic Milestone 2 fixture pipeline in memory. */
export async function renderArchitecturePlannerFixtures(): Promise<
  readonly ArchitectureFixtureArtifact[]
> {
  const sourceInput = await parseAuthoredInput();
  const planning = planArchitectureWorldSpec(sourceInput);
  if (!planning.success) {
    throw new Error(
      `Cliffwatch mansion planning failed: ${diagnosticCodes(planning.diagnostics)}.`,
    );
  }
  const repeatPlanning = planArchitectureWorldSpec(sourceInput);
  if (!repeatPlanning.success) {
    throw new Error(
      `Repeated Cliffwatch mansion planning failed: ${diagnosticCodes(repeatPlanning.diagnostics)}.`,
    );
  }
  const planContent = stringifyArchitecturePlan(planning.plan);
  if (planContent !== stringifyArchitecturePlan(repeatPlanning.plan)) {
    throw new Error('Cliffwatch mansion planning was not byte-deterministic.');
  }
  if (!planning.plan.metrics.allRoomsReachable) {
    throw new Error('Cliffwatch mansion plan did not prove that every room is reachable.');
  }
  if (
    planning.plan.metrics.requiredAdjacencySatisfied !==
    planning.plan.metrics.requiredAdjacencyTotal
  ) {
    throw new Error('Cliffwatch mansion plan did not satisfy every required adjacency.');
  }
  if (
    planning.plan.metrics.avoidedAdjacencySatisfied !== planning.plan.metrics.avoidedAdjacencyTotal
  ) {
    throw new Error('Cliffwatch mansion plan violated an avoided adjacency.');
  }

  const emission = emitArchitectureWorldSpec(sourceInput, planning.plan);
  if (!emission.success) {
    throw new Error(
      `Cliffwatch mansion emission failed: ${diagnosticCodes(emission.diagnostics)}.`,
    );
  }
  const worldSpecContent = stringifyWorldSpec(emission.worldSpec);
  const repeatEmission = emitArchitectureWorldSpec(sourceInput, repeatPlanning.plan);
  if (!repeatEmission.success) {
    throw new Error(
      `Repeated Cliffwatch mansion emission failed: ${diagnosticCodes(repeatEmission.diagnostics)}.`,
    );
  }
  if (
    worldSpecContent !== stringifyWorldSpec(repeatEmission.worldSpec) ||
    emission.architecturePlanHash !== repeatEmission.architecturePlanHash
  ) {
    throw new Error('Cliffwatch mansion emission was not byte-deterministic.');
  }

  const compilation = compileWorldSpecToRobloxManifest(emission.worldSpec);
  if (!compilation.success) {
    throw new Error(
      `Cliffwatch mansion compilation failed: ${diagnosticCodes(compilation.diagnostics)}.`,
    );
  }
  const manifestContent = stringifyRobloxManifest(compilation.manifest);
  if (manifestContent !== stringifyRobloxManifest(emission.manifest)) {
    throw new Error('Emission and independent compiler verification produced different manifests.');
  }
  if (
    planning.plan.metrics.estimatedGeneratedWorldSpecEntityCount !==
    emission.worldSpec.entities.length
  ) {
    throw new Error('Plan entity-count estimate does not match the emitted WorldSpec.');
  }
  if (
    planning.plan.metrics.estimatedPrimitiveCount !== compilation.manifest.measurements.primitives
  ) {
    throw new Error('Plan primitive-count estimate does not match the compiled Manifest.');
  }

  const emptySnapshot = canonicalEmptySnapshot(compilation.manifest);
  const changePlan = planRobloxChangeSet(emptySnapshot, compilation.manifest);
  if (!changePlan.success) {
    throw new Error(
      `Cliffwatch create-from-empty reconciliation failed: ${diagnosticCodes(changePlan.diagnostics)}.`,
    );
  }
  if (changePlan.changeSet.operations.length === 0) {
    throw new Error('Cliffwatch create-from-empty change set unexpectedly contains no operations.');
  }
  const simulation = simulateRobloxChangeSet(emptySnapshot, changePlan.changeSet);
  if (!simulation.success) {
    throw new Error(
      `Cliffwatch create-from-empty simulation failed: ${diagnosticCodes(simulation.diagnostics)}.`,
    );
  }
  if (
    stringifyRobloxSnapshot(simulation.snapshot) !==
    stringifyRobloxSnapshot(changePlan.expectedSnapshot)
  ) {
    throw new Error('Simulated Cliffwatch result differs from the reconciler expected snapshot.');
  }

  return [
    {
      label: 'Cliffwatch mansion Architecture Plan',
      path: planArtifactPath,
      content: planContent,
    },
    {
      label: 'Cliffwatch mansion derived WorldSpec',
      path: worldSpecArtifactPath,
      content: worldSpecContent,
    },
    {
      label: 'Cliffwatch mansion Roblox Manifest',
      path: manifestArtifactPath,
      content: manifestContent,
    },
    {
      label: 'Cliffwatch canonical empty snapshot',
      path: emptySnapshotArtifactPath,
      content: stringifyRobloxSnapshot(emptySnapshot),
    },
    {
      label: 'Cliffwatch create-from-empty change set',
      path: createChangeSetArtifactPath,
      content: stringifyRobloxChangeSet(changePlan.changeSet),
    },
  ];
}

export async function generateArchitecturePlannerFixtures(): Promise<void> {
  const artifacts = await renderArchitecturePlannerFixtures();
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
  void generateArchitecturePlannerFixtures().catch((error: unknown) => {
    process.stderr.write(
      `Architecture planner fixture generation failed: ${errorMessage(error)}\n`,
    );
    process.exitCode = 1;
  });
}
