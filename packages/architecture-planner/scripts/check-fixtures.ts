import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { renderArchitecturePlannerFixtures } from './generate-fixtures.js';

/** Re-renders every derived fixture and compares its exact canonical bytes with the repository. */
export async function checkArchitecturePlannerFixtures(): Promise<boolean> {
  const artifacts = await renderArchitecturePlannerFixtures();
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

  if (current) process.stdout.write('Architecture planner fixture artifacts are current.\n');
  return current;
}

const entryPath = process.argv[1];
const isMain =
  entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href;

if (isMain) {
  void checkArchitecturePlannerFixtures().then(
    (matches: boolean) => {
      if (!matches) process.exitCode = 1;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Architecture planner fixture drift check failed: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
