import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { TSchema } from '@sinclair/typebox';
import { format } from 'prettier';

import { CriticReportSchema } from '../src/critic/contract-schema.js';
import { PlaytestPlanSchema } from '../src/plan/contract-schema.js';
import { PlaytestRunReportSchema } from '../src/run/contract-schema.js';

export interface SchemaArtifact {
  readonly label: string;
  readonly path: string;
  readonly schema: TSchema;
}

export const schemaArtifacts: readonly SchemaArtifact[] = [
  {
    label: 'Playtest Plan',
    path: fileURLToPath(new URL('../schema/playtest-plan-0.1.0.schema.json', import.meta.url)),
    schema: PlaytestPlanSchema,
  },
  {
    label: 'Playtest Run Report',
    path: fileURLToPath(
      new URL('../schema/playtest-run-report-0.1.0.schema.json', import.meta.url),
    ),
    schema: PlaytestRunReportSchema,
  },
  {
    label: 'Critic Report',
    path: fileURLToPath(new URL('../schema/critic-report-0.1.0.schema.json', import.meta.url)),
    schema: CriticReportSchema,
  },
];

export async function renderSchemaArtifact(schema: Readonly<TSchema>): Promise<string> {
  return format(JSON.stringify(schema), { parser: 'json', printWidth: 100 });
}

export async function generatePlaytestCriticSchemas(): Promise<void> {
  for (const artifact of schemaArtifacts) {
    await mkdir(dirname(artifact.path), { recursive: true });
    await writeFile(artifact.path, await renderSchemaArtifact(artifact.schema), 'utf8');
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  void generatePlaytestCriticSchemas().catch((error: unknown) => {
    process.stderr.write(
      `Playtest Critic schema generation failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
