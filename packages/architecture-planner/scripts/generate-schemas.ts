import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { TSchema } from '@sinclair/typebox';

import { ArchitectureEntityDirectiveSchema } from '../src/entity-directive-schema.js';
import { ArchitecturePlanSchema } from '../src/plan-schema.js';
import { ArchitectureRelationshipDirectiveSchema } from '../src/relationship-directive-schema.js';

export interface SchemaArtifact {
  readonly label: string;
  readonly path: string;
  readonly schema: TSchema;
}

export const schemaArtifacts: readonly SchemaArtifact[] = [
  {
    label: 'Architecture entity directive',
    path: fileURLToPath(
      new URL('../schema/architecture-entity-directive-0.1.0.schema.json', import.meta.url),
    ),
    schema: ArchitectureEntityDirectiveSchema,
  },
  {
    label: 'Architecture relationship directive',
    path: fileURLToPath(
      new URL('../schema/architecture-relationship-directive-0.1.0.schema.json', import.meta.url),
    ),
    schema: ArchitectureRelationshipDirectiveSchema,
  },
  {
    label: 'Architecture Plan',
    path: fileURLToPath(new URL('../schema/architecture-plan-0.1.0.schema.json', import.meta.url)),
    schema: ArchitecturePlanSchema,
  },
];

export function renderSchemaArtifact(schema: Readonly<TSchema>): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

export async function generateArchitecturePlannerSchemas(): Promise<void> {
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
  void generateArchitecturePlannerSchemas().catch((error: unknown) => {
    process.stderr.write(`Architecture planner schema generation failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
