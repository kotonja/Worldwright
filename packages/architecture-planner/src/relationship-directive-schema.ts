import { Type, type Static } from '@sinclair/typebox';

import { deepFreeze } from './json.js';

export const ARCHITECTURE_RELATIONSHIP_DIRECTIVE_KEY = 'worldwright.architecture' as const;
export const ARCHITECTURE_RELATIONSHIP_DIRECTIVE_VERSION = '0.1.0' as const;
export const ARCHITECTURE_RELATIONSHIP_DIRECTIVE_SCHEMA_ID =
  'urn:worldwright:architecture-relationship-directive:0.1.0' as const;

const JSON_SCHEMA_DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

const commonFields = {
  schemaVersion: Type.Literal(ARCHITECTURE_RELATIONSHIP_DIRECTIVE_VERSION),
  mode: Type.Literal('adjacency'),
  weight: Type.Integer({ minimum: 1, maximum: 100 }),
} as const;

export const ArchitectureRequiredAdjacencyDirectiveSchema = Type.Object(
  {
    ...commonFields,
    requirement: Type.Literal('required'),
    connection: Type.Union([Type.Literal('door'), Type.Literal('near')]),
  },
  { additionalProperties: false },
);

export const ArchitecturePreferredAdjacencyDirectiveSchema = Type.Object(
  {
    ...commonFields,
    requirement: Type.Literal('preferred'),
    connection: Type.Union([Type.Literal('door'), Type.Literal('near')]),
  },
  { additionalProperties: false },
);

export const ArchitectureAvoidAdjacencyDirectiveSchema = Type.Object(
  {
    ...commonFields,
    requirement: Type.Literal('avoid'),
    connection: Type.Literal('none'),
  },
  { additionalProperties: false },
);

export const ArchitectureRelationshipDirectiveSchema = Type.Union(
  [
    ArchitectureRequiredAdjacencyDirectiveSchema,
    ArchitecturePreferredAdjacencyDirectiveSchema,
    ArchitectureAvoidAdjacencyDirectiveSchema,
  ],
  {
    $id: ARCHITECTURE_RELATIONSHIP_DIRECTIVE_SCHEMA_ID,
    $schema: JSON_SCHEMA_DRAFT_2020_12,
  },
);

for (const schema of [
  ArchitectureRequiredAdjacencyDirectiveSchema,
  ArchitecturePreferredAdjacencyDirectiveSchema,
  ArchitectureAvoidAdjacencyDirectiveSchema,
  ArchitectureRelationshipDirectiveSchema,
]) {
  deepFreeze(schema);
}

export type ArchitectureRequiredAdjacencyDirective = Static<
  typeof ArchitectureRequiredAdjacencyDirectiveSchema
>;
export type ArchitecturePreferredAdjacencyDirective = Static<
  typeof ArchitecturePreferredAdjacencyDirectiveSchema
>;
export type ArchitectureAvoidAdjacencyDirective = Static<
  typeof ArchitectureAvoidAdjacencyDirectiveSchema
>;
export type ArchitectureAdjacencyDirective = Static<typeof ArchitectureRelationshipDirectiveSchema>;
export type ArchitectureRelationshipDirective = ArchitectureAdjacencyDirective;
