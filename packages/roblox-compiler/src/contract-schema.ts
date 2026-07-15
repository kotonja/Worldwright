import { Type } from '@sinclair/typebox';

import {
  RobloxColorSchema,
  RobloxMaterialSchema,
  RobloxPartShapeSchema,
} from './directive-schema.js';
import { deepFreeze } from './deep-freeze.js';

export const ROBLOX_COMPILER_VERSION = '0.1.0' as const;
export const ROBLOX_MANIFEST_VERSION = '0.1.0' as const;
export const ROBLOX_SNAPSHOT_VERSION = '0.1.0' as const;
export const ROBLOX_CHANGE_SET_VERSION = '0.1.0' as const;
export const ROBLOX_SUPPORTED_WORLD_SPEC_VERSION = '0.1.0' as const;

export const ROBLOX_MANIFEST_SCHEMA_ID = 'urn:worldwright:roblox-manifest:0.1.0' as const;
export const ROBLOX_SNAPSHOT_SCHEMA_ID = 'urn:worldwright:roblox-snapshot:0.1.0' as const;
export const ROBLOX_CHANGE_SET_SCHEMA_ID = 'urn:worldwright:roblox-change-set:0.1.0' as const;

export const ROBLOX_IDENTIFIER_PATTERN = '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$';
export const ROBLOX_IDENTIFIER_MAX_LENGTH = 128;
export const ROBLOX_SHA_256_PATTERN = '^[0-9a-f]{64}$';

const ROBLOX_MAX_SAFE_INTEGER = 9_007_199_254_740_991;
const JSON_SCHEMA_DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

export const RobloxIdentifierSchema = Type.String({
  maxLength: ROBLOX_IDENTIFIER_MAX_LENGTH,
  pattern: ROBLOX_IDENTIFIER_PATTERN,
});

export const RobloxSha256Schema = Type.String({ pattern: ROBLOX_SHA_256_PATTERN });

export const RobloxTargetSchema = Type.Object(
  {
    service: Type.Literal('Workspace'),
  },
  { additionalProperties: false },
);

export const RobloxEntityKindSchema = Type.Union([
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

export const RobloxVector3Schema = Type.Object(
  {
    x: Type.Number(),
    y: Type.Number(),
    z: Type.Number(),
  },
  { additionalProperties: false },
);

export const RobloxPositiveVector3Schema = Type.Object(
  {
    x: Type.Number({ exclusiveMinimum: 0 }),
    y: Type.Number({ exclusiveMinimum: 0 }),
    z: Type.Number({ exclusiveMinimum: 0 }),
  },
  { additionalProperties: false },
);

export const RobloxManagedAttributesSchema = Type.Object(
  {
    WorldwrightManaged: Type.Literal(true),
    WorldwrightProjectId: RobloxIdentifierSchema,
    WorldwrightEntityId: RobloxIdentifierSchema,
    WorldwrightEntityKind: RobloxEntityKindSchema,
    WorldwrightCompilerVersion: Type.Literal(ROBLOX_COMPILER_VERSION),
    WorldwrightSourceHash: Type.Optional(RobloxSha256Schema),
  },
  { additionalProperties: false },
);

export const RobloxContainerPropertiesSchema = Type.Object({}, { additionalProperties: false });

const primitivePropertyFields = {
  position: RobloxVector3Schema,
  rotationEulerDegreesXYZ: RobloxVector3Schema,
  size: RobloxPositiveVector3Schema,
  anchored: Type.Literal(true),
  material: RobloxMaterialSchema,
  color: RobloxColorSchema,
  transparency: Type.Number({ minimum: 0, maximum: 1 }),
  canCollide: Type.Boolean(),
  canQuery: Type.Boolean(),
  canTouch: Type.Boolean(),
  castShadow: Type.Boolean(),
} as const;

export const RobloxPartPropertiesSchema = Type.Object(
  {
    ...primitivePropertyFields,
    shape: RobloxPartShapeSchema,
  },
  { additionalProperties: false },
);

export const RobloxWedgePartPropertiesSchema = Type.Object(primitivePropertyFields, {
  additionalProperties: false,
});

export const RobloxCornerWedgePartPropertiesSchema = Type.Object(primitivePropertyFields, {
  additionalProperties: false,
});

const managedNodeFields = {
  id: RobloxIdentifierSchema,
  entityKind: RobloxEntityKindSchema,
  name: Type.String({ minLength: 1 }),
  parentId: Type.Optional(RobloxIdentifierSchema),
  attributes: RobloxManagedAttributesSchema,
} as const;

export const RobloxFolderNodeSchema = Type.Object(
  {
    ...managedNodeFields,
    className: Type.Literal('Folder'),
    properties: RobloxContainerPropertiesSchema,
  },
  { additionalProperties: false },
);

export const RobloxModelNodeSchema = Type.Object(
  {
    ...managedNodeFields,
    className: Type.Literal('Model'),
    properties: RobloxContainerPropertiesSchema,
  },
  { additionalProperties: false },
);

export const RobloxPartNodeSchema = Type.Object(
  {
    ...managedNodeFields,
    className: Type.Literal('Part'),
    properties: RobloxPartPropertiesSchema,
  },
  { additionalProperties: false },
);

export const RobloxWedgePartNodeSchema = Type.Object(
  {
    ...managedNodeFields,
    className: Type.Literal('WedgePart'),
    properties: RobloxWedgePartPropertiesSchema,
  },
  { additionalProperties: false },
);

export const RobloxCornerWedgePartNodeSchema = Type.Object(
  {
    ...managedNodeFields,
    className: Type.Literal('CornerWedgePart'),
    properties: RobloxCornerWedgePartPropertiesSchema,
  },
  { additionalProperties: false },
);

export const RobloxContainerNodeSchema = Type.Union([
  RobloxFolderNodeSchema,
  RobloxModelNodeSchema,
]);

export const RobloxPrimitiveNodeSchema = Type.Union([
  RobloxPartNodeSchema,
  RobloxWedgePartNodeSchema,
  RobloxCornerWedgePartNodeSchema,
]);

export const RobloxManagedNodeSchema = Type.Union([
  RobloxFolderNodeSchema,
  RobloxModelNodeSchema,
  RobloxPartNodeSchema,
  RobloxWedgePartNodeSchema,
  RobloxCornerWedgePartNodeSchema,
]);

export const RobloxManifestSourceSchema = Type.Object(
  {
    worldSpecSchemaVersion: Type.Literal(ROBLOX_SUPPORTED_WORLD_SPEC_VERSION),
    projectId: RobloxIdentifierSchema,
    worldSpecHash: RobloxSha256Schema,
  },
  { additionalProperties: false },
);

export const RobloxManifestMeasurementsSchema = Type.Object(
  {
    instances: Type.Integer({ minimum: 0, maximum: ROBLOX_MAX_SAFE_INTEGER }),
    containers: Type.Integer({ minimum: 0, maximum: ROBLOX_MAX_SAFE_INTEGER }),
    primitives: Type.Integer({ minimum: 0, maximum: ROBLOX_MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);

export const RobloxManifestSchema = Type.Object(
  {
    schemaVersion: Type.Literal(ROBLOX_MANIFEST_VERSION),
    compilerVersion: Type.Literal(ROBLOX_COMPILER_VERSION),
    source: RobloxManifestSourceSchema,
    target: RobloxTargetSchema,
    rootNodeId: RobloxIdentifierSchema,
    nodes: Type.Array(RobloxManagedNodeSchema, { minItems: 1 }),
    measurements: RobloxManifestMeasurementsSchema,
  },
  {
    $id: ROBLOX_MANIFEST_SCHEMA_ID,
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    additionalProperties: false,
  },
);

export const RobloxUnmanagedRootSchema = Type.Object(
  {
    snapshotId: Type.String({ minLength: 1, maxLength: 128 }),
    parentNodeId: RobloxIdentifierSchema,
    name: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const RobloxSnapshotSchema = Type.Object(
  {
    schemaVersion: Type.Literal(ROBLOX_SNAPSHOT_VERSION),
    projectId: RobloxIdentifierSchema,
    target: RobloxTargetSchema,
    rootNodeId: Type.Optional(RobloxIdentifierSchema),
    nodes: Type.Array(RobloxManagedNodeSchema),
    unmanagedRoots: Type.Array(RobloxUnmanagedRootSchema),
  },
  {
    $id: ROBLOX_SNAPSHOT_SCHEMA_ID,
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    additionalProperties: false,
  },
);

const changeOperationId = (type: 'create' | 'update' | 'delete') =>
  Type.String({
    maxLength: type.length + 1 + ROBLOX_IDENTIFIER_MAX_LENGTH,
    pattern: `^${type}:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`,
  });

export const RobloxCreateOperationSchema = Type.Object(
  {
    id: changeOperationId('create'),
    type: Type.Literal('create'),
    node: RobloxManagedNodeSchema,
  },
  { additionalProperties: false },
);

export const RobloxUpdateOperationSchema = Type.Object(
  {
    id: changeOperationId('update'),
    type: Type.Literal('update'),
    before: RobloxManagedNodeSchema,
    after: RobloxManagedNodeSchema,
  },
  { additionalProperties: false },
);

export const RobloxDeleteOperationSchema = Type.Object(
  {
    id: changeOperationId('delete'),
    type: Type.Literal('delete'),
    before: RobloxManagedNodeSchema,
  },
  { additionalProperties: false },
);

export const RobloxChangeOperationSchema = Type.Union([
  RobloxCreateOperationSchema,
  RobloxUpdateOperationSchema,
  RobloxDeleteOperationSchema,
]);

export const RobloxChangeSetPreconditionsSchema = Type.Object(
  {
    projectId: RobloxIdentifierSchema,
    target: RobloxTargetSchema,
    baseSnapshotHash: RobloxSha256Schema,
    desiredManifestHash: RobloxSha256Schema,
    resultSnapshotHash: RobloxSha256Schema,
  },
  { additionalProperties: false },
);

export const RobloxChangeSetSummarySchema = Type.Object(
  {
    creates: Type.Integer({ minimum: 0, maximum: ROBLOX_MAX_SAFE_INTEGER }),
    updates: Type.Integer({ minimum: 0, maximum: ROBLOX_MAX_SAFE_INTEGER }),
    deletes: Type.Integer({ minimum: 0, maximum: ROBLOX_MAX_SAFE_INTEGER }),
    total: Type.Integer({ minimum: 0, maximum: ROBLOX_MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);

export const RobloxChangeSetSchema = Type.Object(
  {
    schemaVersion: Type.Literal(ROBLOX_CHANGE_SET_VERSION),
    compilerVersion: Type.Literal(ROBLOX_COMPILER_VERSION),
    preconditions: RobloxChangeSetPreconditionsSchema,
    operations: Type.Array(RobloxChangeOperationSchema),
    summary: RobloxChangeSetSummarySchema,
  },
  {
    $id: ROBLOX_CHANGE_SET_SCHEMA_ID,
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    additionalProperties: false,
  },
);

deepFreeze(RobloxManifestSchema);
deepFreeze(RobloxSnapshotSchema);
deepFreeze(RobloxChangeSetSchema);
