import { Type, type TSchema, type TTuple } from '@sinclair/typebox';
import {
  ROBLOX_COMPILER_VERSION,
  RobloxManifestSchema,
  RobloxMaterialSchema,
  RobloxPartShapeSchema,
} from '@worldwright/roblox-compiler';

import {
  STUDIO_APPLY_RECEIPT_SCHEMA_ID,
  STUDIO_APPLY_RECEIPT_VERSION,
  STUDIO_BRIDGE_PROTOCOL_VERSION,
  STUDIO_BRIDGE_REQUEST_SCHEMA_ID,
  STUDIO_BRIDGE_RESPONSE_SCHEMA_ID,
  STUDIO_MCP_ADAPTER_VERSION,
  STUDIO_MCP_MAX_CAPTURE_BYTES,
  STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS,
  STUDIO_MCP_MAX_MANAGED_NODES,
  STUDIO_MCP_MAX_INSTANCE_NAME_CODE_POINTS,
  STUDIO_MCP_MAX_NODE_STATE_BYTES,
  STUDIO_MCP_MAX_RECEIPT_DIAGNOSTICS,
  STUDIO_MCP_VIEWPORT_MEDIA_TYPE,
} from './constants.js';
import { STUDIO_DIAGNOSTIC_CODES, type StudioDiagnosticCode } from './diagnostics.js';

const JSON_SCHEMA_DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const MAX_SAFE_INTEGER = 9_007_199_254_740_991;
const IDENTIFIER_PATTERN = '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$';
const SHA_256_PATTERN = '^[0-9a-f]{64}$';
const DIAGNOSTIC_CODE_PATTERN = '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$';

export const StudioIdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: IDENTIFIER_PATTERN,
});
export const StudioSha256Schema = Type.String({ pattern: SHA_256_PATTERN });
export const StudioTargetSchema = Type.Object(
  { service: Type.Literal('Workspace') },
  { additionalProperties: false },
);

export const StudioEntityKindSchema = Type.Union([
  Type.Literal('world'),
  Type.Literal('region'),
  Type.Literal('district'),
  Type.Literal('parcel'),
  Type.Literal('structure'),
  Type.Literal('floor'),
  Type.Literal('room'),
  Type.Literal('route'),
  Type.Literal('terrain'),
  Type.Literal('landmark'),
  Type.Literal('object'),
  Type.Literal('spawn'),
  Type.Literal('interaction'),
]);

/** The bridge carries the existing public compiler node contract without redefining it. */
export const StudioBridgeManagedNodeSchema = RobloxManifestSchema.properties.nodes.items;

/** Exact managed-parent state observed by the enclosing compiler transaction. */
export const StudioBridgeParentStateSchema = Type.Object(
  {
    node: StudioBridgeManagedNodeSchema,
    stateJson: Type.String({ minLength: 1, maxLength: STUDIO_MCP_MAX_NODE_STATE_BYTES }),
    stateHash: StudioSha256Schema,
  },
  { additionalProperties: false },
);

const requestBase = { protocolVersion: Type.Literal(STUDIO_BRIDGE_PROTOCOL_VERSION) } as const;
export const StudioBridgeProbeRequestSchema = Type.Object(
  { ...requestBase, action: Type.Literal('probe') },
  { additionalProperties: false },
);
export const StudioBridgeSnapshotRequestSchema = Type.Object(
  {
    ...requestBase,
    action: Type.Literal('snapshot'),
    projectId: StudioIdentifierSchema,
  },
  { additionalProperties: false },
);
export const StudioBridgeCreateRequestSchema = Type.Object(
  {
    ...requestBase,
    action: Type.Literal('create'),
    projectId: StudioIdentifierSchema,
    node: StudioBridgeManagedNodeSchema,
    stateJson: Type.String({ minLength: 1, maxLength: STUDIO_MCP_MAX_NODE_STATE_BYTES }),
    stateHash: StudioSha256Schema,
    parentState: Type.Optional(StudioBridgeParentStateSchema),
  },
  { additionalProperties: false },
);
export const StudioBridgeUpdateRequestSchema = Type.Object(
  {
    ...requestBase,
    action: Type.Literal('update'),
    projectId: StudioIdentifierSchema,
    before: StudioBridgeManagedNodeSchema,
    after: StudioBridgeManagedNodeSchema,
    beforeStateJson: Type.String({ minLength: 1, maxLength: STUDIO_MCP_MAX_NODE_STATE_BYTES }),
    beforeStateHash: StudioSha256Schema,
    afterStateJson: Type.String({ minLength: 1, maxLength: STUDIO_MCP_MAX_NODE_STATE_BYTES }),
    afterStateHash: StudioSha256Schema,
    beforeParentState: Type.Optional(StudioBridgeParentStateSchema),
    afterParentState: Type.Optional(StudioBridgeParentStateSchema),
  },
  { additionalProperties: false },
);
export const StudioBridgeDeleteRequestSchema = Type.Object(
  {
    ...requestBase,
    action: Type.Literal('delete'),
    projectId: StudioIdentifierSchema,
    before: StudioBridgeManagedNodeSchema,
    beforeStateJson: Type.String({ minLength: 1, maxLength: STUDIO_MCP_MAX_NODE_STATE_BYTES }),
    beforeStateHash: StudioSha256Schema,
  },
  { additionalProperties: false },
);
export const StudioBridgeRequestSchema = Type.Union(
  [
    StudioBridgeProbeRequestSchema,
    StudioBridgeSnapshotRequestSchema,
    StudioBridgeCreateRequestSchema,
    StudioBridgeUpdateRequestSchema,
    StudioBridgeDeleteRequestSchema,
  ],
  {
    $id: STUDIO_BRIDGE_REQUEST_SCHEMA_ID,
    $schema: JSON_SCHEMA_DRAFT_2020_12,
  },
);

const finiteTuple = (length: number) =>
  Type.Array(Type.Number(), { minItems: length, maxItems: length });
const RawContainerPropertiesSchema = Type.Object({}, { additionalProperties: false });
const RawPrimitivePropertiesSchema = Type.Object(
  {
    cframe: finiteTuple(12),
    size: finiteTuple(3),
    anchored: Type.Boolean(),
    shape: Type.Optional(RobloxPartShapeSchema),
    material: RobloxMaterialSchema,
    color: Type.Array(Type.Number({ minimum: 0, maximum: 1 }), {
      minItems: 3,
      maxItems: 3,
    }),
    transparency: Type.Number({ minimum: 0, maximum: 1 }),
    canCollide: Type.Boolean(),
    canQuery: Type.Boolean(),
    canTouch: Type.Boolean(),
    castShadow: Type.Boolean(),
  },
  { additionalProperties: false },
);
const rawNodeFields = {
  entityId: StudioIdentifierSchema,
  projectId: StudioIdentifierSchema,
  name: Type.String({ minLength: 1, maxLength: STUDIO_MCP_MAX_INSTANCE_NAME_CODE_POINTS }),
  parentKind: Type.Union([
    Type.Literal('Workspace'),
    Type.Literal('managed'),
    Type.Literal('other'),
  ]),
  parentEntityId: Type.Optional(StudioIdentifierSchema),
  entityKind: StudioEntityKindSchema,
  compilerVersion: Type.Literal(ROBLOX_COMPILER_VERSION),
  sourceHash: Type.Optional(StudioSha256Schema),
  adapterVersion: Type.Literal(STUDIO_MCP_ADAPTER_VERSION),
  stateJson: Type.String({ minLength: 1, maxLength: STUDIO_MCP_MAX_NODE_STATE_BYTES }),
  stateHash: StudioSha256Schema,
} as const;
export const StudioRawManagedNodeSchema = Type.Union([
  Type.Object(
    {
      ...rawNodeFields,
      className: Type.Literal('Folder'),
      properties: RawContainerPropertiesSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...rawNodeFields,
      className: Type.Literal('Model'),
      properties: RawContainerPropertiesSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...rawNodeFields,
      className: Type.Union([
        Type.Literal('Part'),
        Type.Literal('WedgePart'),
        Type.Literal('CornerWedgePart'),
      ]),
      properties: RawPrimitivePropertiesSchema,
    },
    { additionalProperties: false },
  ),
]);
export const StudioRawUnmanagedRootSchema = Type.Object(
  {
    parentEntityId: StudioIdentifierSchema,
    className: Type.String({ minLength: 1, maxLength: 100 }),
    name: Type.String({ minLength: 1, maxLength: STUDIO_MCP_MAX_INSTANCE_NAME_CODE_POINTS }),
    structuralPath: Type.String({ minLength: 1, maxLength: 2048 }),
    ordinal: Type.Integer({ minimum: 1, maximum: MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
export const StudioProbeSchema = Type.Object(
  {
    placeName: Type.String({ minLength: 1, maxLength: 256 }),
    placeId: Type.Integer({ minimum: 0, maximum: MAX_SAFE_INTEGER }),
    gameId: Type.Integer({ minimum: 0, maximum: MAX_SAFE_INTEGER }),
    isRunning: Type.Boolean(),
    isEditAvailable: Type.Boolean(),
  },
  { additionalProperties: false },
);
export const StudioRawSnapshotSchema = Type.Object(
  {
    projectId: StudioIdentifierSchema,
    nodes: Type.Array(StudioRawManagedNodeSchema, { maxItems: STUDIO_MCP_MAX_MANAGED_NODES }),
    unmanagedRoots: Type.Array(StudioRawUnmanagedRootSchema, {
      maxItems: STUDIO_MCP_MAX_MANAGED_NODES,
    }),
  },
  { additionalProperties: false },
);

const compactIndex = Type.Integer({ minimum: 0, maximum: MAX_SAFE_INTEGER });
const compactOptionalIndex = Type.Integer({ minimum: -1, maximum: MAX_SAFE_INTEGER });
const compactIdTokenIndices = Type.Array(compactIndex, { minItems: 1, maxItems: 64 });
const compactNodePrefix = [compactIdTokenIndices, compactOptionalIndex] as const;
const compactNodeSuffix = [compactIndex, compactIndex, compactOptionalIndex] as const;
const compactPrimitiveSuffix = [
  compactIndex,
  compactIndex,
  compactIndex,
  compactIndex,
  compactIndex,
  compactIndex,
  compactIndex,
  compactIndex,
  compactIndex,
  compactIndex,
  compactIndex,
  compactIndex,
  compactIndex,
  compactIndex,
  Type.Integer({ minimum: 0, maximum: 31 }),
] as const;

function draft2020Tuple<T extends TSchema[]>(items: [...T]): TTuple<T> {
  const legacy = Type.Tuple(items);
  const draft2020 = {
    ...legacy,
    prefixItems: legacy.items,
  } as TTuple<T> & { items?: unknown; additionalItems?: unknown };
  delete draft2020.items;
  delete draft2020.additionalItems;
  return draft2020;
}

export const StudioCompactContainerNodeSchema = draft2020Tuple([
  ...compactNodePrefix,
  Type.Union([Type.Literal(0), Type.Literal(1)]),
  ...compactNodeSuffix,
]);
export const StudioCompactPartNodeSchema = draft2020Tuple([
  ...compactNodePrefix,
  Type.Literal(2),
  ...compactNodeSuffix,
  ...compactPrimitiveSuffix,
  compactIndex,
]);
export const StudioCompactWedgeNodeSchema = draft2020Tuple([
  ...compactNodePrefix,
  Type.Union([Type.Literal(3), Type.Literal(4)]),
  ...compactNodeSuffix,
  ...compactPrimitiveSuffix,
  Type.Literal(-1),
]);
export const StudioCompactManagedNodeSchema = Type.Union([
  StudioCompactContainerNodeSchema,
  StudioCompactPartNodeSchema,
  StudioCompactWedgeNodeSchema,
]);
export const StudioCompactUnmanagedRootSchema = draft2020Tuple([
  compactIndex,
  compactIndex,
  compactIndex,
  Type.Integer({ minimum: 1, maximum: MAX_SAFE_INTEGER }),
]);
export const StudioCompactNameSchema = draft2020Tuple([
  Type.Integer({ minimum: 0, maximum: STUDIO_MCP_MAX_INSTANCE_NAME_CODE_POINTS }),
  Type.String({ minLength: 1, maxLength: STUDIO_MCP_MAX_INSTANCE_NAME_CODE_POINTS }),
]);
export const StudioCompactSnapshotSchema = Type.Object(
  {
    projectId: StudioIdentifierSchema,
    idTokens: Type.Array(Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-z0-9]+$' }), {
      maxItems: STUDIO_MCP_MAX_MANAGED_NODES * 64,
    }),
    names: Type.Array(StudioCompactNameSchema, {
      maxItems: STUDIO_MCP_MAX_MANAGED_NODES * 2,
    }),
    entityKinds: Type.Array(StudioEntityKindSchema, { maxItems: 13 }),
    sourceHashes: Type.Array(StudioSha256Schema, { maxItems: STUDIO_MCP_MAX_MANAGED_NODES }),
    numbers: Type.Array(Type.Number(), { maxItems: STUDIO_MCP_MAX_MANAGED_NODES * 13 }),
    materials: Type.Array(RobloxMaterialSchema, { maxItems: 15 }),
    shapes: Type.Array(RobloxPartShapeSchema, { maxItems: 3 }),
    nodes: Type.Array(StudioCompactManagedNodeSchema, {
      maxItems: STUDIO_MCP_MAX_MANAGED_NODES,
    }),
    unmanagedClasses: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
      maxItems: STUDIO_MCP_MAX_MANAGED_NODES,
    }),
    unmanagedRoots: Type.Array(StudioCompactUnmanagedRootSchema, {
      maxItems: STUDIO_MCP_MAX_MANAGED_NODES,
    }),
    stateHashesZ85: Type.String({
      maxLength: STUDIO_MCP_MAX_MANAGED_NODES * 40,
      pattern: '^[0-9a-zA-Z.\\-:+=^!/*?&<>()\\[\\]{}@%$#]*$',
    }),
  },
  { additionalProperties: false },
);
export const StudioBridgeDiagnosticCodeSchema = Type.Unsafe<StudioDiagnosticCode>({
  type: 'string',
  enum: [...STUDIO_DIAGNOSTIC_CODES],
});
export const StudioBridgeDiagnosticSchema = Type.Object(
  {
    code: StudioBridgeDiagnosticCodeSchema,
    message: Type.String({ minLength: 1, maxLength: 1024 }),
    nodeId: Type.Optional(StudioIdentifierSchema),
    property: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
const responseBase = { protocolVersion: Type.Literal(STUDIO_BRIDGE_PROTOCOL_VERSION) } as const;
export const StudioBridgeProbeSuccessSchema = Type.Object(
  {
    ...responseBase,
    action: Type.Literal('probe'),
    ok: Type.Literal(true),
    probe: StudioProbeSchema,
  },
  { additionalProperties: false },
);
export const StudioBridgeSnapshotSuccessSchema = Type.Object(
  {
    ...responseBase,
    action: Type.Literal('snapshot'),
    ok: Type.Literal(true),
    compactSnapshot: StudioCompactSnapshotSchema,
  },
  { additionalProperties: false },
);
export const StudioBridgeMutationSuccessSchema = Type.Object(
  {
    ...responseBase,
    action: Type.Union([Type.Literal('create'), Type.Literal('update'), Type.Literal('delete')]),
    ok: Type.Literal(true),
    nodeId: StudioIdentifierSchema,
  },
  { additionalProperties: false },
);
export const StudioBridgeFailureSchema = Type.Object(
  {
    ...responseBase,
    action: Type.Union([
      Type.Literal('probe'),
      Type.Literal('snapshot'),
      Type.Literal('create'),
      Type.Literal('update'),
      Type.Literal('delete'),
    ]),
    ok: Type.Literal(false),
    diagnostic: StudioBridgeDiagnosticSchema,
  },
  { additionalProperties: false },
);
export const StudioBridgeResponseSchema = Type.Union(
  [
    StudioBridgeProbeSuccessSchema,
    StudioBridgeSnapshotSuccessSchema,
    StudioBridgeMutationSuccessSchema,
    StudioBridgeFailureSchema,
  ],
  {
    $id: STUDIO_BRIDGE_RESPONSE_SCHEMA_ID,
    $schema: JSON_SCHEMA_DRAFT_2020_12,
  },
);

export const StudioReceiptDiagnosticSchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 128, pattern: DIAGNOSTIC_CODE_PATTERN }),
    severity: Type.Union([Type.Literal('error'), Type.Literal('warning')]),
    path: Type.String({ maxLength: 1024 }),
    message: Type.String({ minLength: 1, maxLength: 1024 }),
    relatedId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
export const StudioViewportEvidenceSchema = Type.Object(
  {
    mediaType: Type.Literal(STUDIO_MCP_VIEWPORT_MEDIA_TYPE),
    sha256: StudioSha256Schema,
    byteLength: Type.Integer({ minimum: 1, maximum: STUDIO_MCP_MAX_CAPTURE_BYTES }),
  },
  { additionalProperties: false },
);
export const StudioReceiptStudioSchema = Type.Object(
  {
    studioId: Type.String({ minLength: 1, maxLength: 256 }),
    placeName: Type.String({ minLength: 1, maxLength: 256 }),
    placeId: Type.Literal(0),
    gameId: Type.Literal(0),
  },
  { additionalProperties: false },
);
export const StudioRollbackResultSchema = Type.Union([
  Type.Object(
    { attempted: Type.Literal(false), succeeded: Type.Literal(false) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      attempted: Type.Literal(true),
      succeeded: Type.Literal(true),
      restoredSnapshotHash: StudioSha256Schema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      attempted: Type.Literal(true),
      succeeded: Type.Literal(false),
      diagnostics: Type.Array(StudioReceiptDiagnosticSchema, {
        minItems: 1,
        maxItems: STUDIO_MCP_MAX_RECEIPT_DIAGNOSTICS,
      }),
      observedAfterRollbackSnapshotHash: Type.Optional(StudioSha256Schema),
    },
    { additionalProperties: false },
  ),
]);
const receiptCommon = {
  schemaVersion: Type.Literal(STUDIO_APPLY_RECEIPT_VERSION),
  adapterVersion: Type.Literal(STUDIO_MCP_ADAPTER_VERSION),
  studio: StudioReceiptStudioSchema,
  projectId: StudioIdentifierSchema,
  target: StudioTargetSchema,
  changeSetHash: StudioSha256Schema,
  baseSnapshotHash: StudioSha256Schema,
  desiredManifestHash: StudioSha256Schema,
  expectedResultSnapshotHash: StudioSha256Schema,
  operationsPlanned: Type.Integer({
    minimum: 0,
    maximum: STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS,
  }),
  operationsAttempted: Type.Integer({
    minimum: 0,
    maximum: STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS,
  }),
  diagnostics: Type.Array(StudioReceiptDiagnosticSchema, {
    maxItems: STUDIO_MCP_MAX_RECEIPT_DIAGNOSTICS,
  }),
  viewportEvidence: Type.Optional(StudioViewportEvidenceSchema),
} as const;
export const StudioAppliedReceiptSchema = Type.Object(
  {
    ...receiptCommon,
    status: Type.Literal('applied'),
    finalSnapshotHash: StudioSha256Schema,
  },
  { additionalProperties: false },
);
export const StudioNoopReceiptSchema = Type.Object(
  {
    ...receiptCommon,
    status: Type.Literal('noop'),
    finalSnapshotHash: StudioSha256Schema,
  },
  { additionalProperties: false },
);
export const StudioFailedReceiptSchema = Type.Object(
  {
    ...receiptCommon,
    status: Type.Literal('failed'),
    transactionStage: Type.Union([
      Type.Literal('change-set-validation'),
      Type.Literal('snapshot-read'),
      Type.Literal('snapshot-validation'),
      Type.Literal('stale-check'),
      Type.Literal('preflight'),
      Type.Literal('apply'),
      Type.Literal('verification'),
    ]),
    rollback: StudioRollbackResultSchema,
    observedFailureSnapshotHash: Type.Optional(StudioSha256Schema),
    finalSnapshotHash: Type.Optional(StudioSha256Schema),
  },
  { additionalProperties: false },
);
export const StudioApplyReceiptSchema = Type.Union(
  [StudioAppliedReceiptSchema, StudioNoopReceiptSchema, StudioFailedReceiptSchema],
  {
    $id: STUDIO_APPLY_RECEIPT_SCHEMA_ID,
    $schema: JSON_SCHEMA_DRAFT_2020_12,
  },
);

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor !== undefined && 'value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

for (const schema of [
  StudioBridgeRequestSchema,
  StudioBridgeResponseSchema,
  StudioApplyReceiptSchema,
]) {
  deepFreeze(schema);
}
