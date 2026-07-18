import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildPlaytestCriticFixtureArtifacts } from './generate-fixtures.js';

export async function checkPlaytestCriticFixtures(): Promise<boolean> {
  let current = true;
  for (const artifact of await buildPlaytestCriticFixtureArtifacts()) {
    const committed = await readFile(artifact.path, 'utf8').catch(() => undefined);
    if (committed !== artifact.content) {
      process.stderr.write(
        `${artifact.label} fixture drift detected. Run pnpm fixture:generate.\n`,
      );
      current = false;
    }
  }
  if (current) process.stdout.write('Playtest Critic fixture artifacts are current.\n');
  return current;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  void checkPlaytestCriticFixtures().then((current) => {
    if (!current) process.exitCode = 1;
  });
}
