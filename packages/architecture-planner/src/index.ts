export {
  ARCHITECTURE_ENTITY_DIRECTIVE_KEY,
  ARCHITECTURE_ENTITY_DIRECTIVE_SCHEMA_ID,
  ARCHITECTURE_ENTITY_DIRECTIVE_VERSION,
  ARCHITECTURE_MAX_STEPS_PER_RUN,
  ARCHITECTURE_MAX_WINDOWS_PER_ROOM,
  ArchitectureBuildingDirectiveSchema,
  ArchitectureColorProfileSchema,
  ArchitectureEntityDirectiveSchema,
  ArchitectureFloorDirectiveSchema,
  ArchitectureFootprintSchema,
  ArchitectureMaterialProfileSchema,
  ArchitectureRoomDirectiveSchema,
  ArchitectureRoomWindowsSchema,
  ArchitectureStairDirectiveSchema,
  ArchitectureWorldOriginSchema,
} from './entity-directive-schema.js';
export type {
  ArchitectureBuildingDirective,
  ArchitectureColorProfile,
  ArchitectureEntityDirective,
  ArchitectureFloorDirective,
  ArchitectureFootprint,
  ArchitectureMaterialProfile,
  ArchitectureRoomDirective,
  ArchitectureRoomWindows,
  ArchitectureStairDirective,
  ArchitectureWorldOrigin,
} from './entity-directive-schema.js';

export {
  ARCHITECTURE_RELATIONSHIP_DIRECTIVE_KEY,
  ARCHITECTURE_RELATIONSHIP_DIRECTIVE_SCHEMA_ID,
  ARCHITECTURE_RELATIONSHIP_DIRECTIVE_VERSION,
  ArchitectureAvoidAdjacencyDirectiveSchema,
  ArchitecturePreferredAdjacencyDirectiveSchema,
  ArchitectureRelationshipDirectiveSchema,
  ArchitectureRequiredAdjacencyDirectiveSchema,
} from './relationship-directive-schema.js';
export type {
  ArchitectureAdjacencyDirective,
  ArchitectureAvoidAdjacencyDirective,
  ArchitecturePreferredAdjacencyDirective,
  ArchitectureRelationshipDirective,
  ArchitectureRequiredAdjacencyDirective,
} from './relationship-directive-schema.js';

export {
  ARCHITECTURE_MAX_PLAN_CIRCULATION_EDGE_COUNT,
  ARCHITECTURE_MAX_PLAN_EXTERIOR_WALLS_PER_ROOM,
  ARCHITECTURE_MAX_PLAN_FLOOR_COUNT,
  ARCHITECTURE_MAX_PLAN_OPENING_COUNT,
  ARCHITECTURE_MAX_PLAN_OPENINGS_PER_FLOOR,
  ARCHITECTURE_MAX_PLAN_OPENINGS_PER_WALL,
  ARCHITECTURE_MAX_PLAN_SPACE_COUNT,
  ARCHITECTURE_MAX_PLAN_SPACES_PER_FLOOR,
  ARCHITECTURE_MAX_PLAN_STAIR_RUN_COUNT,
  ARCHITECTURE_MAX_PLAN_WALL_COUNT,
  ARCHITECTURE_MAX_PLAN_WALLS_PER_FLOOR,
  ARCHITECTURE_PLAN_SCHEMA_ID,
  ARCHITECTURE_PLAN_VERSION,
  ARCHITECTURE_PLANNER_VERSION,
  ArchitectureCirculationEdgeSchema,
  ArchitectureCorridorSpaceSchema,
  ArchitectureFloorPlanSchema,
  ArchitectureIdentifierSchema,
  ArchitectureLandingGeometrySchema,
  ArchitectureOpeningSchema,
  ArchitecturePlanBuildingSchema,
  ArchitecturePlanMetricsSchema,
  ArchitecturePlanSchema,
  ArchitecturePlanScoreSchema,
  ArchitecturePlanSourceSchema,
  ArchitectureRectangleSchema,
  ArchitectureRoomSpaceSchema,
  ArchitectureSha256Schema,
  ArchitectureSpaceSchema,
  ArchitectureStairHallSpaceSchema,
  ArchitectureStairRunSchema,
  ArchitectureWallSchema,
} from './plan-schema.js';
export type {
  ArchitectureCirculationEdge,
  ArchitectureCorridorSpace,
  ArchitectureFloorPlan,
  ArchitectureIdentifier,
  ArchitectureLandingGeometry,
  ArchitectureOpening,
  ArchitecturePlan,
  ArchitecturePlanBuilding,
  ArchitecturePlanMetrics,
  ArchitecturePlanScore,
  ArchitecturePlanSource,
  ArchitectureRectangle,
  ArchitectureRoomSpace,
  ArchitectureSpace,
  ArchitectureStairHallSpace,
  ArchitectureStairRun,
  ArchitectureWall,
} from './plan-schema.js';

export {
  architectureDiagnostic,
  formatArchitectureDiagnostics,
  hasArchitectureErrors,
  sortArchitectureDiagnostics,
} from './diagnostics.js';
export type {
  ArchitectureDiagnostic,
  ArchitectureDiagnosticCode,
  ArchitectureDiagnosticSeverity,
} from './diagnostics.js';

export {
  validateArchitectureEntityDirective,
  validateArchitectureEntityDirectiveForKind,
  validateArchitecturePlan,
  validateArchitectureRelationshipDirective,
} from './directive-validation.js';
export {
  normalizeArchitectureEntityDirective,
  normalizeArchitecturePlan,
  normalizeArchitectureRelationshipDirective,
  stringifyArchitecturePlan,
} from './normalize.js';
export { hashArchitecturePlan, hashSourceWorldSpec, hashWorldSpecSource } from './hashing.js';
export {
  ARCHITECTURE_GENERATED_ID_PREFIX,
  ARCHITECTURE_IDENTIFIER_MAX_LENGTH,
  ARCHITECTURE_IDENTIFIER_PATTERN,
  ArchitectureGeneratedIdError,
  createGeneratedId,
  isReservedArchitectureId,
} from './generated-id.js';

export { evaluateArchitecturePlan } from './plan-evaluation.js';
export type { ArchitecturePlanEvaluationResult } from './plan-evaluation.js';
export { planAndEmitArchitectureWorldSpec, planArchitectureWorldSpec } from './planner.js';
export type {
  ArchitecturePlanAndEmissionResult,
  ArchitecturePlanningFailure,
  ArchitecturePlanningResult,
  ArchitecturePlanningSuccess,
} from './planner.js';
export {
  ARCHITECTURE_MAX_GENERATED_ENTITY_COUNT,
  ARCHITECTURE_MAX_PRIMITIVE_COUNT,
  ArchitectureEmissionCapacityError,
  emitArchitectureWorldSpec,
} from './emit-worldspec.js';
export type {
  ArchitectureEmissionFailure,
  ArchitectureEmissionResult,
  ArchitectureEmissionSuccess,
} from './emit-worldspec.js';

export { ARCHITECTURE_MAX_RELATIONSHIP_DIRECTIVES } from './source-profile.js';

export { ARCHITECTURE_SOLVER_BEAM_WIDTH } from './solver.js';
export {
  ARCHITECTURE_MAX_SCORE_COMPONENT,
  addArchitectureScoreComponent,
  sumArchitectureScoreComponents,
  toArchitectureScoreComponent,
} from './score-arithmetic.js';
export type * from './types.js';
