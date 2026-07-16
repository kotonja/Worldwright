import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { TSchema } from '@sinclair/typebox';

import {
  StudioApplyReceiptSchema,
  StudioBridgeRequestSchema,
  StudioBridgeResponseSchema,
} from '../src/contract-schema.js';

export interface StudioSchemaArtifact {
  readonly label: string;
  readonly path: string;
  readonly schema: TSchema;
}

export const studioSchemaArtifacts: readonly StudioSchemaArtifact[] = [
  {
    label: 'Studio bridge request',
    path: fileURLToPath(
      new URL('../schema/studio-bridge-request-0.1.0.schema.json', import.meta.url),
    ),
    schema: StudioBridgeRequestSchema,
  },
  {
    label: 'Studio bridge response',
    path: fileURLToPath(
      new URL('../schema/studio-bridge-response-0.1.0.schema.json', import.meta.url),
    ),
    schema: StudioBridgeResponseSchema,
  },
  {
    label: 'Studio Apply Receipt',
    path: fileURLToPath(
      new URL('../schema/studio-apply-receipt-0.1.0.schema.json', import.meta.url),
    ),
    schema: StudioApplyReceiptSchema,
  },
];

export function renderStudioSchemaArtifact(schema: Readonly<TSchema>): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

export async function generateStudioSchemas(): Promise<void> {
  for (const artifact of studioSchemaArtifacts) {
    await mkdir(dirname(artifact.path), { recursive: true });
    await writeFile(artifact.path, renderStudioSchemaArtifact(artifact.schema), 'utf8');
  }
}

const entryPath = process.argv[1];
const isMain =
  entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href;

if (isMain) {
  void generateStudioSchemas().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Studio adapter schema generation failed: ${message}\n`);
    process.exitCode = 1;
  });
}
