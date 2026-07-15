import { Type, type Static } from '@sinclair/typebox';
import { RobloxColorSchema, RobloxMaterialSchema } from '@worldwright/roblox-compiler';

import { deepFreeze } from './json.js';

export const ARCHITECTURE_ENTITY_DIRECTIVE_KEY = 'worldwright.architecture' as const;
export const ARCHITECTURE_ENTITY_DIRECTIVE_VERSION = '0.1.0' as const;
export const ARCHITECTURE_ENTITY_DIRECTIVE_SCHEMA_ID =
  'urn:worldwright:architecture-entity-directive:0.1.0' as const;
export const ARCHITECTURE_MAX_WINDOWS_PER_ROOM = 64;
export const ARCHITECTURE_MAX_STEPS_PER_RUN = 256;

const MAX_SAFE_INTEGER = 9_007_199_254_740_991;
const JSON_SCHEMA_DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const WORLD_SPEC_IDENTIFIER_PATTERN = '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$';
const WORLD_SPEC_IDENTIFIER_MAX_LENGTH = 128;

const IdentifierSchema = Type.String({
  maxLength: WORLD_SPEC_IDENTIFIER_MAX_LENGTH,
  pattern: WORLD_SPEC_IDENTIFIER_PATTERN,
});

const PositiveSafeIntegerSchema = Type.Integer({ minimum: 1, maximum: MAX_SAFE_INTEGER });
const PositiveNumberSchema = Type.Number({ exclusiveMinimum: 0 });
const NonNegativeNumberSchema = Type.Number({ minimum: 0 });

export const ArchitectureFootprintSchema = Type.Object(
  {
    width: PositiveSafeIntegerSchema,
    depth: PositiveSafeIntegerSchema,
  },
  { additionalProperties: false },
);

export const ArchitectureWorldOriginSchema = Type.Object(
  {
    x: Type.Number(),
    y: Type.Number(),
    z: Type.Number(),
  },
  { additionalProperties: false },
);

export const ArchitectureMaterialProfileSchema = Type.Object(
  {
    exteriorWall: RobloxMaterialSchema,
    interiorWall: RobloxMaterialSchema,
    floor: RobloxMaterialSchema,
    stair: RobloxMaterialSchema,
    window: RobloxMaterialSchema,
  },
  { additionalProperties: false },
);

export const ArchitectureColorProfileSchema = Type.Object(
  {
    exteriorWall: RobloxColorSchema,
    interiorWall: RobloxColorSchema,
    floor: RobloxColorSchema,
    stair: RobloxColorSchema,
    window: RobloxColorSchema,
  },
  { additionalProperties: false },
);

export const ArchitectureBuildingDirectiveSchema = Type.Object(
  {
    schemaVersion: Type.Literal(ARCHITECTURE_ENTITY_DIRECTIVE_VERSION),
    mode: Type.Literal('building'),
    topology: Type.Literal('double_loaded_spine'),
    footprint: ArchitectureFootprintSchema,
    origin: ArchitectureWorldOriginSchema,
    yawDegrees: Type.Union([
      Type.Literal(0),
      Type.Literal(90),
      Type.Literal(180),
      Type.Literal(270),
    ]),
    gridSize: PositiveSafeIntegerSchema,
    corridorAxis: Type.Union([Type.Literal('auto'), Type.Literal('x'), Type.Literal('z')]),
    entranceEnd: Type.Union([Type.Literal('negative'), Type.Literal('positive')]),
    floorToFloorHeight: PositiveNumberSchema,
    defaultClearHeight: PositiveNumberSchema,
    exteriorWallThickness: PositiveNumberSchema,
    interiorWallThickness: PositiveNumberSchema,
    slabThickness: PositiveNumberSchema,
    corridorWidth: PositiveNumberSchema,
    defaultDoorWidth: PositiveNumberSchema,
    defaultDoorHeight: PositiveNumberSchema,
    defaultWindowWidth: PositiveNumberSchema,
    defaultWindowHeight: PositiveNumberSchema,
    defaultWindowSillHeight: NonNegativeNumberSchema,
    openingEndClearance: NonNegativeNumberSchema,
    materials: ArchitectureMaterialProfileSchema,
    colors: ArchitectureColorProfileSchema,
    windowTransparency: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);

export const ArchitectureFloorDirectiveSchema = Type.Object(
  {
    schemaVersion: Type.Literal(ARCHITECTURE_ENTITY_DIRECTIVE_VERSION),
    mode: Type.Literal('floor'),
    level: Type.Integer({ minimum: 0, maximum: 2 }),
    clearHeight: PositiveNumberSchema,
  },
  { additionalProperties: false },
);

export const ArchitectureRoomWindowsSchema = Type.Object(
  {
    minimum: Type.Integer({ minimum: 0, maximum: ARCHITECTURE_MAX_WINDOWS_PER_ROOM }),
    preferred: Type.Integer({ minimum: 0, maximum: ARCHITECTURE_MAX_WINDOWS_PER_ROOM }),
  },
  { additionalProperties: false },
);

export const ArchitectureRoomDirectiveSchema = Type.Object(
  {
    schemaVersion: Type.Literal(ARCHITECTURE_ENTITY_DIRECTIVE_VERSION),
    mode: Type.Literal('room'),
    minimumArea: PositiveNumberSchema,
    preferredArea: PositiveNumberSchema,
    maximumArea: PositiveNumberSchema,
    minimumSpan: PositiveNumberSchema,
    maximumAspectRatio: Type.Number({ minimum: 1 }),
    zone: Type.Union([Type.Literal('public'), Type.Literal('private'), Type.Literal('service')]),
    isEntrance: Type.Boolean(),
    doorWidth: Type.Optional(PositiveNumberSchema),
    windows: ArchitectureRoomWindowsSchema,
  },
  { additionalProperties: false },
);

export const ArchitectureStairDirectiveSchema = Type.Object(
  {
    schemaVersion: Type.Literal(ARCHITECTURE_ENTITY_DIRECTIVE_VERSION),
    mode: Type.Literal('stair'),
    floorIds: Type.Array(IdentifierSchema, { minItems: 2, maxItems: 3, uniqueItems: true }),
    coreWidth: PositiveNumberSchema,
    coreLength: PositiveNumberSchema,
    preferredSide: Type.Union([
      Type.Literal('auto'),
      Type.Literal('negative'),
      Type.Literal('positive'),
    ]),
    position: Type.Literal('rear'),
    maximumRiserHeight: PositiveNumberSchema,
    minimumTreadDepth: PositiveNumberSchema,
  },
  { additionalProperties: false },
);

export const ArchitectureEntityDirectiveSchema = Type.Union(
  [
    ArchitectureBuildingDirectiveSchema,
    ArchitectureFloorDirectiveSchema,
    ArchitectureRoomDirectiveSchema,
    ArchitectureStairDirectiveSchema,
  ],
  {
    $id: ARCHITECTURE_ENTITY_DIRECTIVE_SCHEMA_ID,
    $schema: JSON_SCHEMA_DRAFT_2020_12,
  },
);

for (const schema of [
  ArchitectureFootprintSchema,
  ArchitectureWorldOriginSchema,
  ArchitectureMaterialProfileSchema,
  ArchitectureColorProfileSchema,
  ArchitectureBuildingDirectiveSchema,
  ArchitectureFloorDirectiveSchema,
  ArchitectureRoomWindowsSchema,
  ArchitectureRoomDirectiveSchema,
  ArchitectureStairDirectiveSchema,
  ArchitectureEntityDirectiveSchema,
]) {
  deepFreeze(schema);
}

export type ArchitectureFootprint = Static<typeof ArchitectureFootprintSchema>;
export type ArchitectureWorldOrigin = Static<typeof ArchitectureWorldOriginSchema>;
export type ArchitectureMaterialProfile = Static<typeof ArchitectureMaterialProfileSchema>;
export type ArchitectureColorProfile = Static<typeof ArchitectureColorProfileSchema>;
export type ArchitectureBuildingDirective = Static<typeof ArchitectureBuildingDirectiveSchema>;
export type ArchitectureFloorDirective = Static<typeof ArchitectureFloorDirectiveSchema>;
export type ArchitectureRoomWindows = Static<typeof ArchitectureRoomWindowsSchema>;
export type ArchitectureRoomDirective = Static<typeof ArchitectureRoomDirectiveSchema>;
export type ArchitectureStairDirective = Static<typeof ArchitectureStairDirectiveSchema>;
export type ArchitectureEntityDirective = Static<typeof ArchitectureEntityDirectiveSchema>;
