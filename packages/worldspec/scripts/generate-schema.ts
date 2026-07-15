import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WorldSpecSchema } from '../src/index.js';

export const schemaArtifactPath = fileURLToPath(
  new URL('../schema/worldspec-0.1.0.schema.json', import.meta.url),
);

export function renderWorldSpecSchema(): string {
  return `${JSON.stringify(WorldSpecSchema, null, 2)}\n`;
}

export async function generateWorldSpecSchema(): Promise<void> {
  await mkdir(dirname(schemaArtifactPath), { recursive: true });
  await writeFile(schemaArtifactPath, renderWorldSpecSchema(), 'utf8');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const entryPath = process.argv[1];
const isMain =
  entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href;

if (isMain) {
  void generateWorldSpecSchema().catch((error: unknown) => {
    process.stderr.write(`Schema generation failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
