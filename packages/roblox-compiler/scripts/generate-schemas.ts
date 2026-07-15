import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { TSchema } from '@sinclair/typebox';

import {
  RobloxChangeSetSchema,
  RobloxManifestSchema,
  RobloxSnapshotSchema,
} from '../src/contract-schema.js';
import { RobloxDirectiveSchema } from '../src/directive-schema.js';

export interface SchemaArtifact {
  readonly label: string;
  readonly path: string;
  readonly schema: TSchema;
}

export const schemaArtifacts: readonly SchemaArtifact[] = [
  {
    label: 'Roblox directive',
    path: fileURLToPath(new URL('../schema/roblox-directive-0.1.0.schema.json', import.meta.url)),
    schema: RobloxDirectiveSchema,
  },
  {
    label: 'Roblox manifest',
    path: fileURLToPath(new URL('../schema/roblox-manifest-0.1.0.schema.json', import.meta.url)),
    schema: RobloxManifestSchema,
  },
  {
    label: 'Roblox snapshot',
    path: fileURLToPath(new URL('../schema/roblox-snapshot-0.1.0.schema.json', import.meta.url)),
    schema: RobloxSnapshotSchema,
  },
  {
    label: 'Roblox change set',
    path: fileURLToPath(new URL('../schema/roblox-change-set-0.1.0.schema.json', import.meta.url)),
    schema: RobloxChangeSetSchema,
  },
];

export function renderSchemaArtifact(schema: Readonly<TSchema>): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

export async function generateRobloxCompilerSchemas(): Promise<void> {
  for (const artifact of schemaArtifacts) {
    await mkdir(dirname(artifact.path), { recursive: true });
    await writeFile(artifact.path, renderSchemaArtifact(artifact.schema), 'utf8');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const entryPath = process.argv[1];
const isMain =
  entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href;

if (isMain) {
  void generateRobloxCompilerSchemas().catch((error: unknown) => {
    process.stderr.write(`Roblox compiler schema generation failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
