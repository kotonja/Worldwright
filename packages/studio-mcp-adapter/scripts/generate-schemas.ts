import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { TSchema } from '@sinclair/typebox';

import {
  StudioBatchRequestSchema,
  StudioBatchResponseSchema,
} from '../src/batch/contract-schema.js';
import {
  StudioApplyReceiptSchema,
  StudioBridgeRequestSchema,
  StudioBridgeResponseSchema,
} from '../src/contract-schema.js';
import {
  StudioProgressReportSchema,
  StudioTransportReportSchema,
} from '../src/report-contract-schema.js';
import {
  StudioPlaytestProbeRequestSchema,
  StudioPlaytestProbeResponseSchema,
} from '../src/playtest/contract-schema.js';
import {
  StudioSandboxLeaseRecordSchema,
  StudioSandboxLeaseRequestSchema,
  StudioSandboxLeaseResponseSchema,
} from '../src/sandbox-lease/contract-schema.js';

export interface StudioSchemaArtifact {
  readonly label: string;
  readonly path: string;
  readonly schema: TSchema;
}

export const studioSchemaArtifacts: readonly StudioSchemaArtifact[] = [
  {
    label: 'Studio playtest probe request',
    path: fileURLToPath(
      new URL('../schema/studio-playtest-probe-request-0.1.0.schema.json', import.meta.url),
    ),
    schema: StudioPlaytestProbeRequestSchema,
  },
  {
    label: 'Studio playtest probe response',
    path: fileURLToPath(
      new URL('../schema/studio-playtest-probe-response-0.1.0.schema.json', import.meta.url),
    ),
    schema: StudioPlaytestProbeResponseSchema,
  },
  {
    label: 'Studio sandbox lease record',
    path: fileURLToPath(
      new URL('../schema/studio-sandbox-lease-record-0.1.0.schema.json', import.meta.url),
    ),
    schema: StudioSandboxLeaseRecordSchema,
  },
  {
    label: 'Studio sandbox lease request',
    path: fileURLToPath(
      new URL('../schema/studio-sandbox-lease-request-0.1.0.schema.json', import.meta.url),
    ),
    schema: StudioSandboxLeaseRequestSchema,
  },
  {
    label: 'Studio sandbox lease response',
    path: fileURLToPath(
      new URL('../schema/studio-sandbox-lease-response-0.1.0.schema.json', import.meta.url),
    ),
    schema: StudioSandboxLeaseResponseSchema,
  },
  {
    label: 'Studio progress report',
    path: fileURLToPath(
      new URL('../schema/studio-progress-report-0.1.0.schema.json', import.meta.url),
    ),
    schema: StudioProgressReportSchema,
  },
  {
    label: 'Studio transport report',
    path: fileURLToPath(
      new URL('../schema/studio-transport-report-0.1.0.schema.json', import.meta.url),
    ),
    schema: StudioTransportReportSchema,
  },
  {
    label: 'Studio batch request',
    path: fileURLToPath(
      new URL('../schema/studio-batch-request-0.1.0.schema.json', import.meta.url),
    ),
    schema: StudioBatchRequestSchema,
  },
  {
    label: 'Studio batch response',
    path: fileURLToPath(
      new URL('../schema/studio-batch-response-0.1.0.schema.json', import.meta.url),
    ),
    schema: StudioBatchResponseSchema,
  },
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
