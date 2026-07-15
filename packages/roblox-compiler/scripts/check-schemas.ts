import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { renderSchemaArtifact, schemaArtifacts } from './generate-schemas.js';

export async function checkRobloxCompilerSchemas(): Promise<boolean> {
  let current = true;

  for (const artifact of schemaArtifacts) {
    let committed: string;
    try {
      committed = await readFile(artifact.path, 'utf8');
    } catch {
      process.stderr.write(
        `${artifact.label} schema artifact is missing. Run pnpm schema:generate and commit the result.\n`,
      );
      current = false;
      continue;
    }

    if (committed !== renderSchemaArtifact(artifact.schema)) {
      process.stderr.write(
        `${artifact.label} schema drift detected. Run pnpm schema:generate and commit the result.\n`,
      );
      current = false;
    }
  }

  if (current) {
    process.stdout.write('Roblox compiler schema artifacts are current.\n');
  }
  return current;
}

const entryPath = process.argv[1];
const isMain =
  entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href;

if (isMain) {
  void checkRobloxCompilerSchemas().then(
    (matches: boolean) => {
      if (!matches) process.exitCode = 1;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Roblox compiler schema drift check failed: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
