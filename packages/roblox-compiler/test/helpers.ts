import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { WorldSpec } from '@worldwright/worldspec';

import { compileWorldSpecToRobloxManifest } from '../src/compile.js';
import type {
  RobloxManagedNode,
  RobloxManifest,
  RobloxSnapshot,
  RobloxUnmanagedRoot,
} from '../src/types.js';

const fixtureCandidates = [
  new URL('../fixtures/worldspec/primitive-courtyard.worldspec.json', import.meta.url),
  new URL('../fixtures/input/primitive-courtyard.worldspec.json', import.meta.url),
];

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function primitiveFixturePath(): string {
  const fixture = fixtureCandidates.find((candidate) => existsSync(fileURLToPath(candidate)));
  if (fixture === undefined) {
    throw new Error('The authored primitive-courtyard WorldSpec fixture is missing.');
  }
  return fileURLToPath(fixture);
}

export function loadPrimitiveWorldSpec(): WorldSpec {
  return JSON.parse(readFileSync(primitiveFixturePath(), 'utf8')) as WorldSpec;
}

export function compilePrimitiveFixture(): RobloxManifest {
  const result = compileWorldSpecToRobloxManifest(loadPrimitiveWorldSpec());
  if (!result.success) {
    throw new Error(`Primitive fixture did not compile: ${JSON.stringify(result.diagnostics)}`);
  }
  return result.manifest;
}

export function snapshotFromManifest(
  manifest: Readonly<RobloxManifest>,
  unmanagedRoots: readonly RobloxUnmanagedRoot[] = [],
): RobloxSnapshot {
  return {
    schemaVersion: '0.1.0',
    projectId: manifest.source.projectId,
    target: { ...manifest.target },
    rootNodeId: manifest.rootNodeId,
    nodes: clone(manifest.nodes),
    unmanagedRoots: clone([...unmanagedRoots]),
  };
}

export function emptySnapshotForManifest(manifest: Readonly<RobloxManifest>): RobloxSnapshot {
  return {
    schemaVersion: '0.1.0',
    projectId: manifest.source.projectId,
    target: { ...manifest.target },
    nodes: [],
    unmanagedRoots: [],
  };
}

export function nodeById(manifest: Readonly<RobloxManifest>, id: string): RobloxManagedNode {
  const node = manifest.nodes.find((entry) => entry.id === id);
  if (node === undefined) throw new Error(`Missing managed node: ${id}`);
  return node;
}

export function deepContainerManifest(count: number): RobloxManifest {
  const sourceHash = '1'.repeat(64);
  const nodes: RobloxManagedNode[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `node-${String(index).padStart(4, '0')}`;
    const parentId = index === 0 ? undefined : `node-${String(index - 1).padStart(4, '0')}`;
    nodes.push({
      id,
      entityKind: index === 0 ? 'world' : 'structure',
      name: `Node ${index}`,
      ...(parentId === undefined ? {} : { parentId }),
      attributes: {
        WorldwrightManaged: true,
        WorldwrightProjectId: 'project-scale',
        WorldwrightEntityId: id,
        WorldwrightEntityKind: index === 0 ? 'world' : 'structure',
        WorldwrightCompilerVersion: '0.1.0',
        ...(index === 0 ? { WorldwrightSourceHash: sourceHash } : {}),
      },
      className: 'Folder',
      properties: {},
    });
  }

  return {
    schemaVersion: '0.1.0',
    compilerVersion: '0.1.0',
    source: {
      worldSpecSchemaVersion: '0.1.0',
      projectId: 'project-scale',
      worldSpecHash: sourceHash,
    },
    target: { service: 'Workspace' },
    rootNodeId: 'node-0000',
    nodes,
    measurements: { instances: count, containers: count, primitives: 0 },
  };
}
