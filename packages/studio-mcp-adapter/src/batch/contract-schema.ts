import { Type } from '@sinclair/typebox';

import {
  STUDIO_BATCH_PROTOCOL_VERSION,
  STUDIO_BATCH_REQUEST_SCHEMA_ID,
  STUDIO_BATCH_RESPONSE_SCHEMA_ID,
  STUDIO_MCP_MAX_BATCH_OPERATIONS,
  STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS,
  STUDIO_MCP_MAX_NODE_STATE_BYTES,
} from '../constants.js';
import {
  StudioBridgeDiagnosticSchema,
  StudioBridgeManagedNodeSchema,
  StudioBridgeParentStateSchema,
  StudioIdentifierSchema,
  StudioSha256Schema,
} from '../contract-schema.js';

const JSON_SCHEMA_DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const OPERATION_ID_PATTERN = '^(?:create|update|delete):[a-z][a-z0-9]*(?:-[a-z0-9]+)*$';

export const StudioBatchOperationIdSchema = Type.String({
  minLength: 1,
  maxLength: 135,
  pattern: OPERATION_ID_PATTERN,
});

const stateJson = () => Type.String({ minLength: 1, maxLength: STUDIO_MCP_MAX_NODE_STATE_BYTES });

export const StudioBatchCreateOperationSchema = Type.Object(
  {
    type: Type.Literal('create'),
    operationId: StudioBatchOperationIdSchema,
    node: StudioBridgeManagedNodeSchema,
    stateJson: stateJson(),
    stateHash: StudioSha256Schema,
    parentState: Type.Optional(StudioBridgeParentStateSchema),
  },
  { additionalProperties: false },
);

export const StudioBatchUpdateOperationSchema = Type.Object(
  {
    type: Type.Literal('update'),
    operationId: StudioBatchOperationIdSchema,
    before: StudioBridgeManagedNodeSchema,
    after: StudioBridgeManagedNodeSchema,
    beforeStateJson: stateJson(),
    beforeStateHash: StudioSha256Schema,
    afterStateJson: stateJson(),
    afterStateHash: StudioSha256Schema,
    beforeParentState: Type.Optional(StudioBridgeParentStateSchema),
    afterParentState: Type.Optional(StudioBridgeParentStateSchema),
  },
  { additionalProperties: false },
);

export const StudioBatchDeleteOperationSchema = Type.Object(
  {
    type: Type.Literal('delete'),
    operationId: StudioBatchOperationIdSchema,
    before: StudioBridgeManagedNodeSchema,
    beforeStateJson: stateJson(),
    beforeStateHash: StudioSha256Schema,
  },
  { additionalProperties: false },
);

export const StudioBatchOperationSchema = Type.Union([
  StudioBatchCreateOperationSchema,
  StudioBatchUpdateOperationSchema,
  StudioBatchDeleteOperationSchema,
]);

export const StudioBatchRequestSchema = Type.Object(
  {
    protocolVersion: Type.Literal(STUDIO_BATCH_PROTOCOL_VERSION),
    action: Type.Literal('apply_chunk'),
    projectId: StudioIdentifierSchema,
    changeSetHash: StudioSha256Schema,
    chunkId: StudioSha256Schema,
    chunkIndex: Type.Integer({
      minimum: 0,
      maximum: STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS - 1,
    }),
    operations: Type.Array(StudioBatchOperationSchema, {
      minItems: 1,
      maxItems: STUDIO_MCP_MAX_BATCH_OPERATIONS,
    }),
  },
  {
    $id: STUDIO_BATCH_REQUEST_SCHEMA_ID,
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    additionalProperties: false,
  },
);

const responseBase = {
  protocolVersion: Type.Literal(STUDIO_BATCH_PROTOCOL_VERSION),
  action: Type.Literal('apply_chunk'),
  changeSetHash: StudioSha256Schema,
  chunkId: StudioSha256Schema,
  chunkIndex: Type.Integer({
    minimum: 0,
    maximum: STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS - 1,
  }),
  operationsAttempted: Type.Integer({ minimum: 0, maximum: STUDIO_MCP_MAX_BATCH_OPERATIONS }),
  operationsApplied: Type.Integer({ minimum: 0, maximum: STUDIO_MCP_MAX_BATCH_OPERATIONS }),
  completedOperationIds: Type.Array(StudioBatchOperationIdSchema, {
    maxItems: STUDIO_MCP_MAX_BATCH_OPERATIONS,
  }),
} as const;

export const StudioBatchSuccessResponseSchema = Type.Object(
  {
    ...responseBase,
    ok: Type.Literal(true),
  },
  { additionalProperties: false },
);

export const StudioBatchFailureResponseSchema = Type.Object(
  {
    ...responseBase,
    ok: Type.Literal(false),
    failedOperationId: Type.Optional(StudioBatchOperationIdSchema),
    localRestoreSucceeded: Type.Boolean(),
    diagnostic: StudioBridgeDiagnosticSchema,
  },
  { additionalProperties: false },
);

export const StudioBatchResponseSchema = Type.Union(
  [StudioBatchSuccessResponseSchema, StudioBatchFailureResponseSchema],
  {
    $id: STUDIO_BATCH_RESPONSE_SCHEMA_ID,
    $schema: JSON_SCHEMA_DRAFT_2020_12,
  },
);

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

deepFreeze(StudioBatchRequestSchema);
deepFreeze(StudioBatchResponseSchema);
