import { Type } from '@sinclair/typebox';

import {
  STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS,
  STUDIO_MCP_MAX_BATCH_OPERATIONS,
  STUDIO_MCP_MAX_RECONNECTS_PER_TRANSACTION,
  STUDIO_PROGRESS_REPORT_SCHEMA_ID,
  STUDIO_PROGRESS_REPORT_VERSION,
  STUDIO_TRANSPORT_REPORT_SCHEMA_ID,
  STUDIO_TRANSPORT_REPORT_VERSION,
} from './constants.js';
import {
  StudioIdentifierSchema,
  StudioSha256Schema,
  StudioTargetSchema,
} from './contract-schema.js';
import { StudioBatchOperationIdSchema } from './batch/contract-schema.js';

const JSON_SCHEMA_DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const count = (maximum = STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS) =>
  Type.Integer({ minimum: 0, maximum });
const MAX_COMPENSATION_OPERATION_ATTEMPTS =
  STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS + STUDIO_MCP_MAX_BATCH_OPERATIONS;
const MAX_COMPENSATION_CHUNK_ATTEMPTS =
  STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS + STUDIO_MCP_MAX_BATCH_OPERATIONS;
const MAX_MUTATION_EXECUTE_CALLS =
  STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS + MAX_COMPENSATION_CHUNK_ATTEMPTS;

export const StudioProgressDiagnosticSchema = Type.Object(
  {
    code: Type.String({ pattern: '^progress\\.[a-z][a-z0-9_]*$', maxLength: 128 }),
    severity: Type.Literal('error'),
    path: Type.String({ maxLength: 2048 }),
    message: Type.String({ minLength: 1, maxLength: 1024 }),
    relatedId: Type.Optional(StudioIdentifierSchema),
  },
  { additionalProperties: false },
);

const progressSuccessCommon = {
  schemaVersion: Type.Literal(STUDIO_PROGRESS_REPORT_VERSION),
  projectId: StudioIdentifierSchema,
  target: StudioTargetSchema,
  baseSnapshotHash: StudioSha256Schema,
  observedSnapshotHash: StudioSha256Schema,
  changeSetHash: StudioSha256Schema,
  operationsTotal: count(),
  appliedPrefixLength: count(),
} as const;

const StudioProgressBaseSchema = Type.Object(
  {
    ...progressSuccessCommon,
    classification: Type.Literal('base'),
    nextOperationId: Type.Optional(StudioBatchOperationIdSchema),
  },
  { additionalProperties: false },
);
const StudioProgressPrefixSchema = Type.Object(
  {
    ...progressSuccessCommon,
    classification: Type.Literal('prefix'),
    nextOperationId: StudioBatchOperationIdSchema,
  },
  { additionalProperties: false },
);
const StudioProgressCompleteSchema = Type.Object(
  { ...progressSuccessCommon, classification: Type.Literal('complete') },
  { additionalProperties: false },
);
const StudioProgressUnsafeSchema = Type.Object(
  {
    schemaVersion: Type.Literal(STUDIO_PROGRESS_REPORT_VERSION),
    classification: Type.Literal('unsafe'),
    projectId: Type.Optional(StudioIdentifierSchema),
    target: Type.Optional(StudioTargetSchema),
    baseSnapshotHash: Type.Optional(StudioSha256Schema),
    observedSnapshotHash: Type.Optional(StudioSha256Schema),
    changeSetHash: Type.Optional(StudioSha256Schema),
    operationsTotal: Type.Optional(count()),
    diagnostics: Type.Array(StudioProgressDiagnosticSchema, { minItems: 1, maxItems: 32 }),
  },
  { additionalProperties: false },
);

export const StudioProgressReportSchema = Type.Union(
  [
    StudioProgressBaseSchema,
    StudioProgressPrefixSchema,
    StudioProgressCompleteSchema,
    StudioProgressUnsafeSchema,
  ],
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: STUDIO_PROGRESS_REPORT_SCHEMA_ID,
    title: 'Worldwright Studio Progress Report 0.1.0',
  },
);

export const StudioTransportFinalOutcomeSchema = Type.Union([
  Type.Literal('applied'),
  Type.Literal('noop'),
  Type.Literal('failed-restored'),
  Type.Literal('failed-unsafe'),
  Type.Literal('failed-unrestored'),
]);

export const StudioTransportReportSchema = Type.Object(
  {
    schemaVersion: Type.Literal(STUDIO_TRANSPORT_REPORT_VERSION),
    mode: Type.Literal('chunked'),
    changeSetHash: StudioSha256Schema,
    operationsPlanned: count(),
    operationsAttempted: count(),
    operationsAppliedBeforeFailure: count(),
    chunksPlanned: count(STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS),
    chunksAttempted: count(STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS),
    chunksCompleted: count(STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS),
    sandboxLeaseClaimCalls: count(1),
    mutationExecuteCalls: count(MAX_MUTATION_EXECUTE_CALLS),
    uncertainTransportEvents: count(STUDIO_MCP_MAX_RECONNECTS_PER_TRANSACTION + 1),
    reconnectAttempts: count(STUDIO_MCP_MAX_RECONNECTS_PER_TRANSACTION),
    reconnectsSucceeded: count(STUDIO_MCP_MAX_RECONNECTS_PER_TRANSACTION),
    compensationOperationsAttempted: count(MAX_COMPENSATION_OPERATION_ATTEMPTS),
    compensationOperationsApplied: count(MAX_COMPENSATION_OPERATION_ATTEMPTS),
    compensationChunksAttempted: count(MAX_COMPENSATION_CHUNK_ATTEMPTS),
    compensationChunksCompleted: count(STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS),
    finalOutcome: StudioTransportFinalOutcomeSchema,
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: STUDIO_TRANSPORT_REPORT_SCHEMA_ID,
    title: 'Worldwright Studio Transport Report 0.1.0',
    additionalProperties: false,
  },
);
