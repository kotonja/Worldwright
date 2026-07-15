import { Type, type Static } from '@sinclair/typebox';

export const WORLD_SPEC_VERSION = '0.1.0' as const;
export const WORLD_SPEC_SCHEMA_ID = 'urn:worldwright:worldspec:0.1.0' as const;

export const WORLD_SPEC_IDENTIFIER_PATTERN = '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$';
export const WORLD_SPEC_IDENTIFIER_MAX_LENGTH = 128;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const JSON_VALUE_REFERENCE = '#/$defs/jsonValue';

const JsonValueSchema = Type.Unsafe<JsonValue>({ $ref: JSON_VALUE_REFERENCE });
const JsonObjectSchema = Type.Record(Type.String(), JsonValueSchema);

const IdentifierSchema = Type.String({
  maxLength: WORLD_SPEC_IDENTIFIER_MAX_LENGTH,
  pattern: WORLD_SPEC_IDENTIFIER_PATTERN,
});

const TextSchema = Type.String({ minLength: 1 });
const TextListSchema = Type.Array(TextSchema);
const IdentifierSetSchema = Type.Array(IdentifierSchema, { uniqueItems: true });

export const ProjectSchema = Type.Object(
  {
    id: IdentifierSchema,
    name: TextSchema,
    description: Type.Optional(TextSchema),
    seed: Type.Integer({ minimum: 0 }),
    units: Type.Literal('studs'),
    upAxis: Type.Literal('Y'),
  },
  { additionalProperties: false },
);

export const IntentSchema = Type.Object(
  {
    summary: TextSchema,
    mustHave: TextListSchema,
    mustNotHave: TextListSchema,
    preferences: TextListSchema,
  },
  { additionalProperties: false },
);

export const ReferenceSchema = Type.Object(
  {
    id: IdentifierSchema,
    kind: Type.Union([
      Type.Literal('image'),
      Type.Literal('sketch'),
      Type.Literal('floor_plan'),
      Type.Literal('heightmap'),
      Type.Literal('existing_place'),
      Type.Literal('text'),
    ]),
    role: TextSchema,
    uri: Type.Optional(TextSchema),
    influence: Type.Number({ minimum: 0, maximum: 1 }),
    notes: Type.Optional(TextSchema),
  },
  { additionalProperties: false },
);

export const StyleDnaSchema = Type.Object(
  {
    architecture: TextListSchema,
    shapeLanguage: TextListSchema,
    materialFamilies: TextListSchema,
    palette: TextListSchema,
    detailDensity: Type.Union([
      Type.Literal('low'),
      Type.Literal('medium'),
      Type.Literal('high'),
      Type.Literal('hero'),
    ]),
    aging: Type.Union([
      Type.Literal('pristine'),
      Type.Literal('light'),
      Type.Literal('moderate'),
      Type.Literal('heavy'),
    ]),
    lighting: TextListSchema,
    exclusions: TextListSchema,
  },
  { additionalProperties: false },
);

export const ProvenanceSchema = Type.Object(
  {
    classification: Type.Union([
      Type.Literal('observed'),
      Type.Literal('inferred'),
      Type.Literal('invented'),
    ]),
    referenceIds: IdentifierSetSchema,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    notes: Type.Optional(TextSchema),
  },
  { additionalProperties: false },
);

const Vector3Schema = Type.Object(
  {
    x: Type.Number(),
    y: Type.Number(),
    z: Type.Number(),
  },
  { additionalProperties: false },
);

const PositiveVector3Schema = Type.Object(
  {
    x: Type.Number({ exclusiveMinimum: 0 }),
    y: Type.Number({ exclusiveMinimum: 0 }),
    z: Type.Number({ exclusiveMinimum: 0 }),
  },
  { additionalProperties: false },
);

export const TransformSchema = Type.Object(
  {
    position: Vector3Schema,
    rotationEulerDegrees: Vector3Schema,
    scale: PositiveVector3Schema,
  },
  { additionalProperties: false },
);

export const BoundsSchema = Type.Object(
  {
    size: PositiveVector3Schema,
  },
  { additionalProperties: false },
);

export const EntitySchema = Type.Object(
  {
    id: IdentifierSchema,
    kind: Type.Union([
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
    ]),
    name: TextSchema,
    parentId: Type.Optional(IdentifierSchema),
    provenance: ProvenanceSchema,
    transform: Type.Optional(TransformSchema),
    bounds: Type.Optional(BoundsSchema),
    tags: Type.Array(TextSchema, { uniqueItems: true }),
    attributes: JsonObjectSchema,
  },
  { additionalProperties: false },
);

export const RelationshipSchema = Type.Object(
  {
    id: IdentifierSchema,
    type: Type.Union([
      Type.Literal('contains'),
      Type.Literal('adjacent_to'),
      Type.Literal('connects_to'),
      Type.Literal('supports'),
      Type.Literal('depends_on'),
      Type.Literal('visible_from'),
      Type.Literal('serves'),
      Type.Literal('aligned_with'),
    ]),
    sourceId: IdentifierSchema,
    targetId: IdentifierSchema,
    directed: Type.Boolean(),
    attributes: JsonObjectSchema,
  },
  { additionalProperties: false },
);

export const ConstraintSchema = Type.Object(
  {
    id: IdentifierSchema,
    type: Type.Union([
      Type.Literal('reachability'),
      Type.Literal('adjacency'),
      Type.Literal('clearance'),
      Type.Literal('containment'),
      Type.Literal('alignment'),
      Type.Literal('preservation'),
      Type.Literal('performance'),
      Type.Literal('style'),
      Type.Literal('custom'),
    ]),
    severity: Type.Union([Type.Literal('error'), Type.Literal('warning')]),
    source: Type.Union([
      Type.Literal('user'),
      Type.Literal('system'),
      Type.Literal('reference'),
      Type.Literal('inference'),
    ]),
    description: TextSchema,
    subjectIds: IdentifierSetSchema,
    targetIds: IdentifierSetSchema,
    parameters: JsonObjectSchema,
  },
  { additionalProperties: false },
);

export const LockSchema = Type.Object(
  {
    id: IdentifierSchema,
    entityId: IdentifierSchema,
    // Emptiness is deliberately checked semantically so callers receive lock.path_empty.
    fieldPaths: Type.Array(Type.String(), { uniqueItems: true }),
    owner: Type.Union([Type.Literal('user'), Type.Literal('system')]),
    reason: Type.Optional(TextSchema),
  },
  { additionalProperties: false },
);

const BudgetLimitsSchema = Type.Object(
  {
    instances: Type.Optional(Type.Integer({ minimum: 1 })),
    triangles: Type.Optional(Type.Integer({ minimum: 1 })),
    textureMemoryMegabytes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  },
  { additionalProperties: false },
);

export const BudgetsSchema = Type.Object(
  {
    targetDevices: Type.Array(
      Type.Union([
        Type.Literal('desktop'),
        Type.Literal('mobile'),
        Type.Literal('console'),
        Type.Literal('vr'),
      ]),
      { minItems: 1, uniqueItems: true },
    ),
    qualityTier: Type.Union([
      Type.Literal('draft'),
      Type.Literal('standard'),
      Type.Literal('high'),
      Type.Literal('cinematic'),
    ]),
    streaming: Type.Union([
      Type.Literal('disabled'),
      Type.Literal('preferred'),
      Type.Literal('required'),
    ]),
    limits: Type.Optional(BudgetLimitsSchema),
  },
  { additionalProperties: false },
);

const JsonValueDefinition = {
  anyOf: [
    { type: 'null' },
    { type: 'boolean' },
    { type: 'number' },
    { type: 'string' },
    { type: 'array', items: { $ref: JSON_VALUE_REFERENCE } },
    { type: 'object', additionalProperties: { $ref: JSON_VALUE_REFERENCE } },
  ],
} as const;

export const WorldSpecSchema = Type.Object(
  {
    schemaVersion: Type.Literal(WORLD_SPEC_VERSION),
    project: ProjectSchema,
    intent: IntentSchema,
    references: Type.Array(ReferenceSchema),
    style: StyleDnaSchema,
    rootEntityId: IdentifierSchema,
    entities: Type.Array(EntitySchema),
    relationships: Type.Array(RelationshipSchema),
    constraints: Type.Array(ConstraintSchema),
    locks: Type.Array(LockSchema),
    budgets: BudgetsSchema,
  },
  {
    $id: WORLD_SPEC_SCHEMA_ID,
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: { jsonValue: JsonValueDefinition },
    additionalProperties: false,
  },
);

export type WorldSpecFromSchema = Static<typeof WorldSpecSchema>;
