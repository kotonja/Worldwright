import { Type, type Static } from '@sinclair/typebox';
import { WORLD_SPEC_VERSION } from '@worldwright/worldspec';

import {
  ARCHITECTURE_MAX_STEPS_PER_RUN,
  ArchitectureColorProfileSchema,
  ArchitectureMaterialProfileSchema,
  ArchitectureWorldOriginSchema,
} from './entity-directive-schema.js';
import { deepFreeze } from './json.js';
import { ARCHITECTURE_MAX_SCORE_COMPONENT } from './score-arithmetic.js';

export const ARCHITECTURE_PLAN_VERSION = '0.1.0' as const;
export const ARCHITECTURE_PLANNER_VERSION = '0.1.0' as const;
export const ARCHITECTURE_PLAN_SCHEMA_ID = 'urn:worldwright:architecture-plan:0.1.0' as const;

// These collection bounds follow from the supported 3-floor / 32-room-per-floor
// profile, the 64-window-per-room cap, and the bounded relationship profile.
export const ARCHITECTURE_MAX_PLAN_FLOOR_COUNT = 3;
export const ARCHITECTURE_MAX_PLAN_SPACE_COUNT = 102;
export const ARCHITECTURE_MAX_PLAN_WALL_COUNT = 309;
export const ARCHITECTURE_MAX_PLAN_OPENING_COUNT = 6_756;
export const ARCHITECTURE_MAX_PLAN_STAIR_RUN_COUNT = 2;
export const ARCHITECTURE_MAX_PLAN_CIRCULATION_EDGE_COUNT = 614;
export const ARCHITECTURE_MAX_PLAN_SPACES_PER_FLOOR = 34;
export const ARCHITECTURE_MAX_PLAN_WALLS_PER_FLOOR = 103;
export const ARCHITECTURE_MAX_PLAN_OPENINGS_PER_FLOOR = 2_594;
export const ARCHITECTURE_MAX_PLAN_EXTERIOR_WALLS_PER_ROOM = 3;
export const ARCHITECTURE_MAX_PLAN_OPENINGS_PER_WALL = 65;

const MAX_SAFE_INTEGER = ARCHITECTURE_MAX_SCORE_COMPONENT;
const SHA_256_PATTERN = '^[0-9a-f]{64}$';
const JSON_SCHEMA_DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const WORLD_SPEC_IDENTIFIER_PATTERN = '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$';
const WORLD_SPEC_IDENTIFIER_MAX_LENGTH = 128;

export const ArchitectureIdentifierSchema = Type.String({
  maxLength: WORLD_SPEC_IDENTIFIER_MAX_LENGTH,
  pattern: WORLD_SPEC_IDENTIFIER_PATTERN,
});

export const ArchitectureSha256Schema = Type.String({ pattern: SHA_256_PATTERN });

export const ArchitectureRectangleSchema = Type.Object(
  {
    x: Type.Number(),
    z: Type.Number(),
    width: Type.Number({ exclusiveMinimum: 0 }),
    depth: Type.Number({ exclusiveMinimum: 0 }),
  },
  { additionalProperties: false },
);

export const ArchitecturePlanSourceSchema = Type.Object(
  {
    worldSpecSchemaVersion: Type.Literal(WORLD_SPEC_VERSION),
    projectId: ArchitectureIdentifierSchema,
    worldSpecHash: ArchitectureSha256Schema,
    buildingEntityId: ArchitectureIdentifierSchema,
  },
  { additionalProperties: false },
);

export const ArchitecturePlanBuildingSchema = Type.Object(
  {
    topology: Type.Literal('double_loaded_spine'),
    outerFootprint: ArchitectureRectangleSchema,
    interiorEnvelope: ArchitectureRectangleSchema,
    localOrigin: Type.Literal('footprint_center'),
    worldOrigin: ArchitectureWorldOriginSchema,
    yawDegrees: Type.Union([
      Type.Literal(0),
      Type.Literal(90),
      Type.Literal(180),
      Type.Literal(270),
    ]),
    gridSize: Type.Integer({ minimum: 1, maximum: MAX_SAFE_INTEGER }),
    corridorAxis: Type.Union([Type.Literal('x'), Type.Literal('z')]),
    entranceEnd: Type.Union([Type.Literal('negative'), Type.Literal('positive')]),
    floorToFloorHeight: Type.Number({ exclusiveMinimum: 0 }),
    defaultClearHeight: Type.Number({ exclusiveMinimum: 0 }),
    exteriorWallThickness: Type.Number({ exclusiveMinimum: 0 }),
    interiorWallThickness: Type.Number({ exclusiveMinimum: 0 }),
    slabThickness: Type.Number({ exclusiveMinimum: 0 }),
    corridorWidth: Type.Number({ exclusiveMinimum: 0 }),
    defaultDoorWidth: Type.Number({ exclusiveMinimum: 0 }),
    defaultDoorHeight: Type.Number({ exclusiveMinimum: 0 }),
    defaultWindowWidth: Type.Number({ exclusiveMinimum: 0 }),
    defaultWindowHeight: Type.Number({ exclusiveMinimum: 0 }),
    defaultWindowSillHeight: Type.Number({ minimum: 0 }),
    openingEndClearance: Type.Number({ minimum: 0 }),
    materials: ArchitectureMaterialProfileSchema,
    colors: ArchitectureColorProfileSchema,
    windowTransparency: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);

export const ArchitectureFloorPlanSchema = Type.Object(
  {
    id: ArchitectureIdentifierSchema,
    level: Type.Integer({ minimum: 0, maximum: 2 }),
    finishedFloorElevation: Type.Number(),
    clearHeight: Type.Number({ exclusiveMinimum: 0 }),
    footprint: ArchitectureRectangleSchema,
    corridor: ArchitectureRectangleSchema,
    stairCore: Type.Optional(ArchitectureRectangleSchema),
    spaceIds: Type.Array(ArchitectureIdentifierSchema, {
      minItems: 1,
      maxItems: ARCHITECTURE_MAX_PLAN_SPACES_PER_FLOOR,
      uniqueItems: true,
    }),
    wallIds: Type.Array(ArchitectureIdentifierSchema, {
      maxItems: ARCHITECTURE_MAX_PLAN_WALLS_PER_FLOOR,
      uniqueItems: true,
    }),
    openingIds: Type.Array(ArchitectureIdentifierSchema, {
      maxItems: ARCHITECTURE_MAX_PLAN_OPENINGS_PER_FLOOR,
      uniqueItems: true,
    }),
    stairRunIds: Type.Array(ArchitectureIdentifierSchema, {
      maxItems: ARCHITECTURE_MAX_PLAN_STAIR_RUN_COUNT,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

const commonSpaceFields = {
  id: ArchitectureIdentifierSchema,
  floorId: ArchitectureIdentifierSchema,
  rectangle: ArchitectureRectangleSchema,
} as const;

export const ArchitectureRoomSpaceSchema = Type.Object(
  {
    ...commonSpaceFields,
    type: Type.Literal('room'),
    zone: Type.Union([Type.Literal('public'), Type.Literal('private'), Type.Literal('service')]),
    isEntrance: Type.Boolean(),
    provenance: Type.Union([
      Type.Literal('observed'),
      Type.Literal('inferred'),
      Type.Literal('invented'),
    ]),
    corridorDoorOpeningId: ArchitectureIdentifierSchema,
    exteriorWallIds: Type.Array(ArchitectureIdentifierSchema, {
      minItems: 1,
      maxItems: ARCHITECTURE_MAX_PLAN_EXTERIOR_WALLS_PER_ROOM,
      uniqueItems: true,
    }),
    clearArea: Type.Number({ exclusiveMinimum: 0 }),
    aspectRatio: Type.Number({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const ArchitectureCorridorSpaceSchema = Type.Object(
  {
    ...commonSpaceFields,
    type: Type.Literal('corridor'),
  },
  { additionalProperties: false },
);

export const ArchitectureStairHallSpaceSchema = Type.Object(
  {
    ...commonSpaceFields,
    type: Type.Literal('stair_hall'),
    sourceStairRouteId: ArchitectureIdentifierSchema,
  },
  { additionalProperties: false },
);

export const ArchitectureSpaceSchema = Type.Union([
  ArchitectureRoomSpaceSchema,
  ArchitectureCorridorSpaceSchema,
  ArchitectureStairHallSpaceSchema,
]);

export const ArchitectureWallSchema = Type.Object(
  {
    id: ArchitectureIdentifierSchema,
    floorId: ArchitectureIdentifierSchema,
    kind: Type.Union([
      Type.Literal('exterior'),
      Type.Literal('corridor'),
      Type.Literal('divider'),
      Type.Literal('stair'),
    ]),
    axis: Type.Union([Type.Literal('x'), Type.Literal('z')]),
    constant: Type.Number(),
    start: Type.Number(),
    end: Type.Number(),
    thickness: Type.Number({ exclusiveMinimum: 0 }),
    height: Type.Number({ exclusiveMinimum: 0 }),
    firstSpaceId: Type.Optional(ArchitectureIdentifierSchema),
    secondSpaceId: Type.Optional(ArchitectureIdentifierSchema),
    exterior: Type.Optional(Type.Literal(true)),
    openingIds: Type.Array(ArchitectureIdentifierSchema, {
      maxItems: ARCHITECTURE_MAX_PLAN_OPENINGS_PER_WALL,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

export const ArchitectureOpeningSchema = Type.Object(
  {
    id: ArchitectureIdentifierSchema,
    floorId: ArchitectureIdentifierSchema,
    wallId: ArchitectureIdentifierSchema,
    type: Type.Union([Type.Literal('door'), Type.Literal('window')]),
    offset: Type.Number({ minimum: 0 }),
    width: Type.Number({ exclusiveMinimum: 0 }),
    bottom: Type.Number({ minimum: 0 }),
    height: Type.Number({ exclusiveMinimum: 0 }),
    sourceId: ArchitectureIdentifierSchema,
    fromNodeId: ArchitectureIdentifierSchema,
    toNodeId: ArchitectureIdentifierSchema,
  },
  { additionalProperties: false },
);

export const ArchitectureLandingGeometrySchema = Type.Object(
  {
    lower: ArchitectureRectangleSchema,
    upper: ArchitectureRectangleSchema,
  },
  { additionalProperties: false },
);

export const ArchitectureStairRunSchema = Type.Object(
  {
    id: ArchitectureIdentifierSchema,
    sourceStairRouteId: ArchitectureIdentifierSchema,
    fromFloorId: ArchitectureIdentifierSchema,
    toFloorId: ArchitectureIdentifierSchema,
    core: ArchitectureRectangleSchema,
    direction: Type.Union([
      Type.Literal('negative_x'),
      Type.Literal('positive_x'),
      Type.Literal('negative_z'),
      Type.Literal('positive_z'),
    ]),
    stepCount: Type.Integer({ minimum: 1, maximum: ARCHITECTURE_MAX_STEPS_PER_RUN }),
    riserHeight: Type.Number({ exclusiveMinimum: 0 }),
    treadDepth: Type.Number({ exclusiveMinimum: 0 }),
    clearWidth: Type.Number({ exclusiveMinimum: 0 }),
    landing: ArchitectureLandingGeometrySchema,
  },
  { additionalProperties: false },
);

export const ArchitectureCirculationEdgeSchema = Type.Object(
  {
    id: ArchitectureIdentifierSchema,
    sourceType: Type.Union([Type.Literal('opening'), Type.Literal('stair_run')]),
    sourceId: ArchitectureIdentifierSchema,
    fromNodeId: ArchitectureIdentifierSchema,
    toNodeId: ArchitectureIdentifierSchema,
    traversal: Type.Union([Type.Literal('door'), Type.Literal('open'), Type.Literal('stair')]),
  },
  { additionalProperties: false },
);

const CountSchema = Type.Integer({ minimum: 0, maximum: MAX_SAFE_INTEGER });

export const ArchitecturePlanMetricsSchema = Type.Object(
  {
    floorCount: CountSchema,
    roomCount: CountSchema,
    grossOuterArea: Type.Number({ minimum: 0 }),
    clearRoomArea: Type.Number({ minimum: 0 }),
    corridorArea: Type.Number({ minimum: 0 }),
    stairArea: Type.Number({ minimum: 0 }),
    clearAreaEfficiency: Type.Number({ minimum: 0, maximum: 1 }),
    requiredAdjacencyTotal: CountSchema,
    requiredAdjacencySatisfied: CountSchema,
    preferredAdjacencyTotal: CountSchema,
    preferredAdjacencySatisfied: CountSchema,
    avoidedAdjacencyTotal: CountSchema,
    avoidedAdjacencySatisfied: CountSchema,
    maximumRoomAspectRatio: Type.Number({ minimum: 1 }),
    doorCount: CountSchema,
    windowCount: CountSchema,
    stairRunCount: CountSchema,
    allRoomsReachable: Type.Boolean(),
    estimatedGeneratedWorldSpecEntityCount: CountSchema,
    estimatedPrimitiveCount: CountSchema,
  },
  { additionalProperties: false },
);

const ScoreComponentSchema = Type.Integer({ minimum: 0, maximum: MAX_SAFE_INTEGER });

export const ArchitecturePlanScoreSchema = Type.Object(
  {
    total: ScoreComponentSchema,
    areaDeviation: ScoreComponentSchema,
    aspectRatio: ScoreComponentSchema,
    preferredAdjacency: ScoreComponentSchema,
    preferredWindows: ScoreComponentSchema,
    nearDistance: ScoreComponentSchema,
    zoneOrdering: ScoreComponentSchema,
    seedTieBreak: ScoreComponentSchema,
  },
  { additionalProperties: false },
);

export const ArchitecturePlanSchema = Type.Object(
  {
    schemaVersion: Type.Literal(ARCHITECTURE_PLAN_VERSION),
    plannerVersion: Type.Literal(ARCHITECTURE_PLANNER_VERSION),
    source: ArchitecturePlanSourceSchema,
    building: ArchitecturePlanBuildingSchema,
    floors: Type.Array(ArchitectureFloorPlanSchema, {
      minItems: 1,
      maxItems: ARCHITECTURE_MAX_PLAN_FLOOR_COUNT,
    }),
    spaces: Type.Array(ArchitectureSpaceSchema, {
      minItems: 1,
      maxItems: ARCHITECTURE_MAX_PLAN_SPACE_COUNT,
    }),
    walls: Type.Array(ArchitectureWallSchema, { maxItems: ARCHITECTURE_MAX_PLAN_WALL_COUNT }),
    openings: Type.Array(ArchitectureOpeningSchema, {
      maxItems: ARCHITECTURE_MAX_PLAN_OPENING_COUNT,
    }),
    stairRuns: Type.Array(ArchitectureStairRunSchema, {
      maxItems: ARCHITECTURE_MAX_PLAN_STAIR_RUN_COUNT,
    }),
    circulationEdges: Type.Array(ArchitectureCirculationEdgeSchema, {
      maxItems: ARCHITECTURE_MAX_PLAN_CIRCULATION_EDGE_COUNT,
    }),
    metrics: ArchitecturePlanMetricsSchema,
    score: ArchitecturePlanScoreSchema,
  },
  {
    $id: ARCHITECTURE_PLAN_SCHEMA_ID,
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    additionalProperties: false,
  },
);

for (const schema of [
  ArchitectureIdentifierSchema,
  ArchitectureSha256Schema,
  ArchitectureRectangleSchema,
  ArchitecturePlanSourceSchema,
  ArchitecturePlanBuildingSchema,
  ArchitectureFloorPlanSchema,
  ArchitectureRoomSpaceSchema,
  ArchitectureCorridorSpaceSchema,
  ArchitectureStairHallSpaceSchema,
  ArchitectureSpaceSchema,
  ArchitectureWallSchema,
  ArchitectureOpeningSchema,
  ArchitectureLandingGeometrySchema,
  ArchitectureStairRunSchema,
  ArchitectureCirculationEdgeSchema,
  ArchitecturePlanMetricsSchema,
  ArchitecturePlanScoreSchema,
  ArchitecturePlanSchema,
]) {
  deepFreeze(schema);
}

export type ArchitectureIdentifier = Static<typeof ArchitectureIdentifierSchema>;
export type ArchitectureRectangle = Static<typeof ArchitectureRectangleSchema>;
export type ArchitecturePlanSource = Static<typeof ArchitecturePlanSourceSchema>;
export type ArchitecturePlanBuilding = Static<typeof ArchitecturePlanBuildingSchema>;
export type ArchitectureFloorPlan = Static<typeof ArchitectureFloorPlanSchema>;
export type ArchitectureRoomSpace = Static<typeof ArchitectureRoomSpaceSchema>;
export type ArchitectureCorridorSpace = Static<typeof ArchitectureCorridorSpaceSchema>;
export type ArchitectureStairHallSpace = Static<typeof ArchitectureStairHallSpaceSchema>;
export type ArchitectureSpace = Static<typeof ArchitectureSpaceSchema>;
export type ArchitectureWall = Static<typeof ArchitectureWallSchema>;
export type ArchitectureOpening = Static<typeof ArchitectureOpeningSchema>;
export type ArchitectureLandingGeometry = Static<typeof ArchitectureLandingGeometrySchema>;
export type ArchitectureStairRun = Static<typeof ArchitectureStairRunSchema>;
export type ArchitectureCirculationEdge = Static<typeof ArchitectureCirculationEdgeSchema>;
export type ArchitecturePlanMetrics = Static<typeof ArchitecturePlanMetricsSchema>;
export type ArchitecturePlanScore = Static<typeof ArchitecturePlanScoreSchema>;
export type ArchitecturePlan = Static<typeof ArchitecturePlanSchema>;
