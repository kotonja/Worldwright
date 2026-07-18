import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { renderSchemaArtifact, schemaArtifacts } from './generate-schemas.js';

export async function checkPlaytestCriticSchemas(): Promise<boolean> {
  let current = true;
  for (const artifact of schemaArtifacts) {
    const committed = await readFile(artifact.path, 'utf8').catch(() => undefined);
    if (committed !== (await renderSchemaArtifact(artifact.schema))) {
      process.stderr.write(`${artifact.label} schema drift detected. Run pnpm schema:generate.\n`);
      current = false;
    }
  }
  if (current) process.stdout.write('Playtest Critic schema artifacts are current.\n');
  return current;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  void checkPlaytestCriticSchemas().then((current) => {
    if (!current) process.exitCode = 1;
  });
}
