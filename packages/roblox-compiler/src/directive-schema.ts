import { Type, type Static } from '@sinclair/typebox';

import { deepFreeze } from './deep-freeze.js';

export const ROBLOX_DIRECTIVE_KEY = 'worldwright.roblox' as const;
export const ROBLOX_DIRECTIVE_VERSION = '0.1.0' as const;
export const ROBLOX_DIRECTIVE_SCHEMA_ID = 'urn:worldwright:roblox-directive:0.1.0' as const;

export const ROBLOX_CONTAINER_CLASSES = Object.freeze(['Folder', 'Model'] as const);
export const ROBLOX_PRIMITIVE_CLASSES = Object.freeze([
  'Part',
  'WedgePart',
  'CornerWedgePart',
] as const);
export const ROBLOX_PART_SHAPES = Object.freeze(['Block', 'Ball', 'Cylinder'] as const);
export const ROBLOX_MATERIALS = Object.freeze([
  'SmoothPlastic',
  'Concrete',
  'Brick',
  'Wood',
  'WoodPlanks',
  'Slate',
  'Cobblestone',
  'Metal',
  'Glass',
  'Neon',
  'Grass',
  'Sand',
  'Rock',
  'Marble',
  'Granite',
] as const);

export const RobloxMaterialSchema = Type.Union([
  Type.Literal('SmoothPlastic'),
  Type.Literal('Concrete'),
  Type.Literal('Brick'),
  Type.Literal('Wood'),
  Type.Literal('WoodPlanks'),
  Type.Literal('Slate'),
  Type.Literal('Cobblestone'),
  Type.Literal('Metal'),
  Type.Literal('Glass'),
  Type.Literal('Neon'),
  Type.Literal('Grass'),
  Type.Literal('Sand'),
  Type.Literal('Rock'),
  Type.Literal('Marble'),
  Type.Literal('Granite'),
]);

export const RobloxColorSchema = Type.Object(
  {
    r: Type.Integer({ minimum: 0, maximum: 255 }),
    g: Type.Integer({ minimum: 0, maximum: 255 }),
    b: Type.Integer({ minimum: 0, maximum: 255 }),
  },
  { additionalProperties: false },
);

export const RobloxPartShapeSchema = Type.Union([
  Type.Literal('Block'),
  Type.Literal('Ball'),
  Type.Literal('Cylinder'),
]);

const primitiveFields = {
  schemaVersion: Type.Literal(ROBLOX_DIRECTIVE_VERSION),
  mode: Type.Literal('primitive'),
  material: RobloxMaterialSchema,
  color: RobloxColorSchema,
  transparency: Type.Number({ minimum: 0, maximum: 1 }),
  canCollide: Type.Boolean(),
  canQuery: Type.Boolean(),
  canTouch: Type.Boolean(),
  castShadow: Type.Boolean(),
} as const;

export const RobloxContainerDirectiveSchema = Type.Object(
  {
    schemaVersion: Type.Literal(ROBLOX_DIRECTIVE_VERSION),
    mode: Type.Literal('container'),
    className: Type.Union([Type.Literal('Folder'), Type.Literal('Model')]),
  },
  { additionalProperties: false },
);

export const RobloxPartDirectiveSchema = Type.Object(
  {
    ...primitiveFields,
    className: Type.Literal('Part'),
    shape: RobloxPartShapeSchema,
  },
  { additionalProperties: false },
);

export const RobloxWedgeDirectiveSchema = Type.Object(
  {
    ...primitiveFields,
    className: Type.Literal('WedgePart'),
  },
  { additionalProperties: false },
);

export const RobloxCornerWedgeDirectiveSchema = Type.Object(
  {
    ...primitiveFields,
    className: Type.Literal('CornerWedgePart'),
  },
  { additionalProperties: false },
);

export const RobloxDirectiveSchema = Type.Union(
  [
    RobloxContainerDirectiveSchema,
    RobloxPartDirectiveSchema,
    RobloxWedgeDirectiveSchema,
    RobloxCornerWedgeDirectiveSchema,
  ],
  {
    $id: ROBLOX_DIRECTIVE_SCHEMA_ID,
    $schema: 'https://json-schema.org/draft/2020-12/schema',
  },
);

for (const schema of [
  RobloxMaterialSchema,
  RobloxColorSchema,
  RobloxPartShapeSchema,
  RobloxContainerDirectiveSchema,
  RobloxPartDirectiveSchema,
  RobloxWedgeDirectiveSchema,
  RobloxCornerWedgeDirectiveSchema,
  RobloxDirectiveSchema,
]) {
  deepFreeze(schema);
}

export type RobloxContainerDirective = Static<typeof RobloxContainerDirectiveSchema>;
export type RobloxPartDirective = Static<typeof RobloxPartDirectiveSchema>;
export type RobloxWedgeDirective = Static<typeof RobloxWedgeDirectiveSchema>;
export type RobloxCornerWedgeDirective = Static<typeof RobloxCornerWedgeDirectiveSchema>;
export type RobloxDirective = Static<typeof RobloxDirectiveSchema>;
