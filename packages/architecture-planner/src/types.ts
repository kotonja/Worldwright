import type { ArchitectureDiagnostic } from './diagnostics.js';

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
export type {
  ArchitectureAdjacencyDirective,
  ArchitectureAvoidAdjacencyDirective,
  ArchitecturePreferredAdjacencyDirective,
  ArchitectureRelationshipDirective,
  ArchitectureRequiredAdjacencyDirective,
} from './relationship-directive-schema.js';
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
export type { ArchitectureDiagnostic } from './diagnostics.js';
export type { JsonValue } from './json.js';

export interface ArchitectureValidationSuccess<T> {
  readonly valid: true;
  readonly value: T;
  readonly diagnostics: readonly ArchitectureDiagnostic[];
}

export interface ArchitectureValidationFailure {
  readonly valid: false;
  readonly diagnostics: readonly ArchitectureDiagnostic[];
}

export type ArchitectureValidationResult<T> =
  | ArchitectureValidationSuccess<T>
  | ArchitectureValidationFailure;
