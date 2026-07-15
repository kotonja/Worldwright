import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { renderWorldSpecSchema, schemaArtifactPath } from './generate-schema.js';

export async function checkWorldSpecSchema(): Promise<boolean> {
  let committed: string;

  try {
    committed = await readFile(schemaArtifactPath, 'utf8');
  } catch {
    process.stderr.write(
      'WorldSpec schema artifact is missing. Run pnpm schema:generate and commit the result.\n',
    );
    return false;
  }

  if (committed !== renderWorldSpecSchema()) {
    process.stderr.write(
      'WorldSpec schema drift detected. Run pnpm schema:generate and commit the result.\n',
    );
    return false;
  }

  process.stdout.write('WorldSpec schema artifact is current.\n');
  return true;
}

const entryPath = process.argv[1];
const isMain =
  entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href;

if (isMain) {
  void checkWorldSpecSchema().then(
    (matches: boolean) => {
      if (!matches) {
        process.exitCode = 1;
      }
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Schema drift check failed: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
