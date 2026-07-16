import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { renderStudioSchemaArtifact, studioSchemaArtifacts } from './generate-schemas.js';

export async function checkStudioSchemas(): Promise<boolean> {
  let current = true;
  for (const artifact of studioSchemaArtifacts) {
    let committed: string;
    try {
      committed = await readFile(artifact.path, 'utf8');
    } catch {
      process.stderr.write(
        `${artifact.label} schema is missing. Run pnpm schema:generate and commit the result.\n`,
      );
      current = false;
      continue;
    }
    if (committed !== renderStudioSchemaArtifact(artifact.schema)) {
      process.stderr.write(
        `${artifact.label} schema drift detected. Run pnpm schema:generate and commit the result.\n`,
      );
      current = false;
    }
  }
  if (current) process.stdout.write('Studio adapter schema artifacts are current.\n');
  return current;
}

const entryPath = process.argv[1];
const isMain =
  entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href;

if (isMain) {
  void checkStudioSchemas().then(
    (current) => {
      if (!current) process.exitCode = 1;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Studio adapter schema drift check failed: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
