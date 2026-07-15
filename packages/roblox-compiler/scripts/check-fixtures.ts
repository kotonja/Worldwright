import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { renderRobloxCompilerFixtures } from './generate-fixtures.js';

export async function checkRobloxCompilerFixtures(): Promise<boolean> {
  const artifacts = await renderRobloxCompilerFixtures();
  let current = true;

  for (const artifact of artifacts) {
    let committed: string;
    try {
      committed = await readFile(artifact.path, 'utf8');
    } catch {
      process.stderr.write(
        `${artifact.label} fixture artifact is missing. Run pnpm fixture:generate and commit the result.\n`,
      );
      current = false;
      continue;
    }

    if (committed !== artifact.content) {
      process.stderr.write(
        `${artifact.label} fixture drift detected. Run pnpm fixture:generate and commit the result.\n`,
      );
      current = false;
    }
  }

  if (current) {
    process.stdout.write('Roblox compiler fixture artifacts are current.\n');
  }
  return current;
}

const entryPath = process.argv[1];
const isMain =
  entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href;

if (isMain) {
  void checkRobloxCompilerFixtures().then(
    (matches: boolean) => {
      if (!matches) process.exitCode = 1;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Roblox compiler fixture drift check failed: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
