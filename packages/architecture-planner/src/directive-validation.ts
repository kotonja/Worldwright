import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import type { WorldEntity } from '@worldwright/worldspec';

import {
  ArchitectureBuildingDirectiveSchema,
  ArchitectureEntityDirectiveSchema,
  ArchitectureFloorDirectiveSchema,
  ArchitectureRoomDirectiveSchema,
  ArchitectureStairDirectiveSchema,
  type ArchitectureBuildingDirective,
  type ArchitectureEntityDirective,
  type ArchitectureRoomDirective,
} from './entity-directive-schema.js';
import {
  architectureDiagnostic,
  sortArchitectureDiagnostics,
  type ArchitectureDiagnostic,
  type ArchitectureDiagnosticCode,
} from './diagnostics.js';
import { isGridAligned } from './grid.js';
import { appendPointer, compareCodePoints, inspectJsonCompatibility } from './json.js';
import {
  normalizeArchitectureEntityDirective,
  normalizeArchitecturePlan,
  normalizeArchitectureRelationshipDirective,
} from './normalize.js';
import {
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
  ArchitecturePlanSchema,
  type ArchitecturePlan,
} from './plan-schema.js';
import {
  ArchitectureRelationshipDirectiveSchema,
  type ArchitectureRelationshipDirective,
} from './relationship-directive-schema.js';
import { sumArchitectureScoreComponents } from './score-arithmetic.js';
import type { ArchitectureValidationResult } from './types.js';

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictNumbers: true,
  validateFormats: false,
});

const checkArchitectureEntityDirective = ajv.compile<ArchitectureEntityDirective>(
  ArchitectureEntityDirectiveSchema,
);
const checkBuildingDirective = ajv.compile(ArchitectureBuildingDirectiveSchema);
const checkFloorDirective = ajv.compile(ArchitectureFloorDirectiveSchema);
const checkRoomDirective = ajv.compile(ArchitectureRoomDirectiveSchema);
const checkStairDirective = ajv.compile(ArchitectureStairDirectiveSchema);
const checkArchitectureRelationshipDirective = ajv.compile<ArchitectureRelationshipDirective>(
  ArchitectureRelationshipDirectiveSchema,
);
const checkArchitecturePlan = ajv.compile<ArchitecturePlan>(ArchitecturePlanSchema);

function record(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function errorParameter(error: ErrorObject, key: string): string | undefined {
  const value = (error.params as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function schemaErrorPath(error: ErrorObject): string {
  const property =
    error.keyword === 'required'
      ? errorParameter(error, 'missingProperty')
      : error.keyword === 'additionalProperties'
        ? errorParameter(error, 'additionalProperty')
        : undefined;
  return property === undefined ? error.instancePath : appendPointer(error.instancePath, property);
}

function schemaErrorPriority(error: ErrorObject): number {
  switch (error.keyword) {
    case 'additionalProperties':
      return 0;
    case 'required':
      return 1;
    case 'type':
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'exclusiveMaximum':
    case 'minLength':
    case 'maxLength':
    case 'pattern':
    case 'minItems':
    case 'maxItems':
    case 'uniqueItems':
      return 2;
    case 'const':
    case 'enum':
      return 3;
    default:
      return 4;
  }
}

function mostUsefulSchemaError(
  errors: readonly ErrorObject[] | null | undefined,
): ErrorObject | undefined {
  return [...(errors ?? [])].sort((left, right) => {
    const byPriority = schemaErrorPriority(left) - schemaErrorPriority(right);
    if (byPriority !== 0) return byPriority;
    const byPath = compareCodePoints(schemaErrorPath(left), schemaErrorPath(right));
    if (byPath !== 0) return byPath;
    return compareCodePoints(left.keyword, right.keyword);
  })[0];
}

function schemaErrorMessage(error: ErrorObject | undefined, subject: string): string {
  if (error === undefined) return `Value does not satisfy the ${subject} contract.`;
  switch (error.keyword) {
    case 'additionalProperties':
      return `Property is not allowed by the ${subject} contract.`;
    case 'required':
      return `Required ${subject} property is missing.`;
    case 'type':
      return `${subject} value has the wrong type.`;
    case 'const':
    case 'enum':
      return `${subject} value is not an allowed choice.`;
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'exclusiveMaximum':
      return `${subject} number is outside the allowed range.`;
    case 'minLength':
    case 'maxLength':
    case 'pattern':
      return `${subject} string is outside the allowed format.`;
    case 'minItems':
    case 'maxItems':
    case 'uniqueItems':
      return `${subject} array does not satisfy its bounds.`;
    default:
      return `Value does not satisfy the ${subject} contract.`;
  }
}

function schemaFailure<T>(
  input: unknown,
  validator: ValidateFunction<T>,
  code: ArchitectureDiagnosticCode,
  subject: string,
): ArchitectureValidationResult<T> | undefined {
  const issue = inspectJsonCompatibility(input);
  if (issue !== undefined) {
    return {
      valid: false,
      diagnostics: [
        architectureDiagnostic(code, issue.path, `Value is not JSON-compatible: ${issue.reason}.`),
      ],
    };
  }
  if (validator(input)) return undefined;
  const error = mostUsefulSchemaError(validator.errors);
  return {
    valid: false,
    diagnostics: [
      architectureDiagnostic(
        code,
        error === undefined ? '' : schemaErrorPath(error),
        schemaErrorMessage(error, subject),
      ),
    ],
  };
}

function ownArrayValue(value: unknown, key: string): readonly unknown[] | undefined {
  const valueRecord = record(value);
  if (valueRecord === undefined) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(valueRecord, key);
  return descriptor !== undefined && 'value' in descriptor && Array.isArray(descriptor.value)
    ? descriptor.value
    : undefined;
}

function ownArrayElementValue(values: readonly unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function planCollectionBoundDiagnostic(input: unknown): ArchitectureDiagnostic | undefined {
  const topLevelBounds = [
    ['floors', ARCHITECTURE_MAX_PLAN_FLOOR_COUNT],
    ['spaces', ARCHITECTURE_MAX_PLAN_SPACE_COUNT],
    ['walls', ARCHITECTURE_MAX_PLAN_WALL_COUNT],
    ['openings', ARCHITECTURE_MAX_PLAN_OPENING_COUNT],
    ['stairRuns', ARCHITECTURE_MAX_PLAN_STAIR_RUN_COUNT],
    ['circulationEdges', ARCHITECTURE_MAX_PLAN_CIRCULATION_EDGE_COUNT],
  ] as const;
  for (const [key, maximum] of topLevelBounds) {
    const values = ownArrayValue(input, key);
    if (values !== undefined && values.length > maximum) {
      return architectureDiagnostic(
        'architecture.plan_invalid',
        `/${key}`,
        `Architecture Plan ${key} may contain at most ${String(maximum)} items.`,
      );
    }
  }

  const floors = ownArrayValue(input, 'floors') ?? [];
  for (let index = 0; index < floors.length; index += 1) {
    for (const [key, maximum] of [
      ['spaceIds', ARCHITECTURE_MAX_PLAN_SPACES_PER_FLOOR],
      ['wallIds', ARCHITECTURE_MAX_PLAN_WALLS_PER_FLOOR],
      ['openingIds', ARCHITECTURE_MAX_PLAN_OPENINGS_PER_FLOOR],
      ['stairRunIds', ARCHITECTURE_MAX_PLAN_STAIR_RUN_COUNT],
    ] as const) {
      const values = ownArrayValue(ownArrayElementValue(floors, index), key);
      if (values !== undefined && values.length > maximum) {
        return architectureDiagnostic(
          'architecture.plan_invalid',
          `/floors/${String(index)}/${key}`,
          `Architecture Plan floor ${key} may contain at most ${String(maximum)} items.`,
        );
      }
    }
  }

  const spaces = ownArrayValue(input, 'spaces') ?? [];
  for (let index = 0; index < spaces.length; index += 1) {
    const exteriorWallIds = ownArrayValue(ownArrayElementValue(spaces, index), 'exteriorWallIds');
    if (
      exteriorWallIds !== undefined &&
      exteriorWallIds.length > ARCHITECTURE_MAX_PLAN_EXTERIOR_WALLS_PER_ROOM
    ) {
      return architectureDiagnostic(
        'architecture.plan_invalid',
        `/spaces/${String(index)}/exteriorWallIds`,
        `An Architecture Plan room may reference at most ${String(ARCHITECTURE_MAX_PLAN_EXTERIOR_WALLS_PER_ROOM)} exterior walls.`,
      );
    }
  }

  const walls = ownArrayValue(input, 'walls') ?? [];
  for (let index = 0; index < walls.length; index += 1) {
    const openingIds = ownArrayValue(ownArrayElementValue(walls, index), 'openingIds');
    if (openingIds !== undefined && openingIds.length > ARCHITECTURE_MAX_PLAN_OPENINGS_PER_WALL) {
      return architectureDiagnostic(
        'architecture.plan_invalid',
        `/walls/${String(index)}/openingIds`,
        `An Architecture Plan wall may reference at most ${String(ARCHITECTURE_MAX_PLAN_OPENINGS_PER_WALL)} openings.`,
      );
    }
  }
  return undefined;
}

function selectedEntityValidator(input: unknown): ValidateFunction<unknown> {
  const inputRecord = record(input);
  const modeDescriptor =
    inputRecord === undefined ? undefined : Object.getOwnPropertyDescriptor(inputRecord, 'mode');
  const mode =
    modeDescriptor !== undefined && 'value' in modeDescriptor ? modeDescriptor.value : undefined;
  switch (mode) {
    case 'building':
      return checkBuildingDirective;
    case 'floor':
      return checkFloorDirective;
    case 'room':
      return checkRoomDirective;
    case 'stair':
      return checkStairDirective;
    default:
      return checkArchitectureEntityDirective;
  }
}

function buildingSemanticDiagnostics(
  directive: Readonly<ArchitectureBuildingDirective>,
): ArchitectureDiagnostic[] {
  const diagnostics: ArchitectureDiagnostic[] = [];
  const alignedFields: readonly [string, number][] = [
    ['/footprint/width', directive.footprint.width],
    ['/footprint/depth', directive.footprint.depth],
    ['/exteriorWallThickness', directive.exteriorWallThickness],
    ['/interiorWallThickness', directive.interiorWallThickness],
    ['/corridorWidth', directive.corridorWidth],
    ['/defaultDoorWidth', directive.defaultDoorWidth],
    ['/defaultWindowWidth', directive.defaultWindowWidth],
    ['/openingEndClearance', directive.openingEndClearance],
  ];
  for (const [path, value] of alignedFields) {
    if (!isGridAligned(value, directive.gridSize)) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.grid_misaligned',
          path,
          'Horizontal architecture measurements must align exactly to gridSize.',
        ),
      );
    }
  }

  const interiorWidth = directive.footprint.width - 2 * directive.exteriorWallThickness;
  const interiorDepth = directive.footprint.depth - 2 * directive.exteriorWallThickness;
  if (!(interiorWidth > 0) || !(interiorDepth > 0)) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.directive_invalid',
        '/footprint',
        'The interior envelope must remain positive after exterior wall thickness.',
      ),
    );
  } else {
    const requiredCrossSpan = directive.corridorWidth + 2 * directive.interiorWallThickness;
    const minimumTwoBandSpan = 2 * directive.gridSize;
    const xAxisFits = interiorDepth - requiredCrossSpan >= minimumTwoBandSpan;
    const zAxisFits = interiorWidth - requiredCrossSpan >= minimumTwoBandSpan;
    const selectedAxisFails =
      (directive.corridorAxis === 'x' && !xAxisFits) ||
      (directive.corridorAxis === 'z' && !zAxisFits) ||
      (directive.corridorAxis === 'auto' && !xAxisFits && !zAxisFits);
    if (selectedAxisFails) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.directive_invalid',
          '/corridorWidth',
          'The corridor and its two boundary walls must leave at least one grid cell for each room band.',
        ),
      );
    }
  }

  return diagnostics;
}

function roomSemanticDiagnostics(
  directive: Readonly<ArchitectureRoomDirective>,
): ArchitectureDiagnostic[] {
  const diagnostics: ArchitectureDiagnostic[] = [];
  if (
    directive.minimumArea > directive.preferredArea ||
    directive.preferredArea > directive.maximumArea
  ) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.room_invalid',
        '/preferredArea',
        'Room areas must satisfy minimumArea <= preferredArea <= maximumArea.',
      ),
    );
  }
  if (directive.windows.minimum > directive.windows.preferred) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.room_invalid',
        '/windows/preferred',
        'Preferred window count must be at least the minimum window count.',
      ),
    );
  }
  return diagnostics;
}

/** Validates one unknown strict architecture entity directive at the JSON trust boundary. */
export function validateArchitectureEntityDirective(
  input: unknown,
): ArchitectureValidationResult<ArchitectureEntityDirective> {
  try {
    const schemaResult = schemaFailure(
      input,
      selectedEntityValidator(input),
      'architecture.directive_invalid',
      'architecture entity directive',
    );
    if (schemaResult !== undefined) {
      return schemaResult as ArchitectureValidationResult<ArchitectureEntityDirective>;
    }
    const directive = input as ArchitectureEntityDirective;
    const diagnostics =
      directive.mode === 'building'
        ? buildingSemanticDiagnostics(directive)
        : directive.mode === 'room'
          ? roomSemanticDiagnostics(directive)
          : [];
    return diagnostics.length === 0
      ? { valid: true, value: normalizeArchitectureEntityDirective(directive), diagnostics }
      : { valid: false, diagnostics: sortArchitectureDiagnostics(diagnostics) };
  } catch {
    return {
      valid: false,
      diagnostics: [
        architectureDiagnostic(
          'architecture.directive_invalid',
          '',
          'Architecture entity directive input could not be safely inspected.',
        ),
      ],
    };
  }
}

const expectedKindByMode = {
  building: 'structure',
  floor: 'floor',
  room: 'room',
  stair: 'route',
} as const;

export function validateArchitectureEntityDirectiveForKind(
  input: unknown,
  entityKind: WorldEntity['kind'],
): ArchitectureValidationResult<ArchitectureEntityDirective> {
  const result = validateArchitectureEntityDirective(input);
  if (!result.valid) return result;
  if (expectedKindByMode[result.value.mode] === entityKind) return result;
  return {
    valid: false,
    diagnostics: [
      architectureDiagnostic(
        'architecture.directive_invalid',
        '/mode',
        `Architecture ${result.value.mode} directives are not allowed on ${entityKind} entities.`,
      ),
    ],
  };
}

/** Validates one unknown strict room-adjacency relationship directive. */
export function validateArchitectureRelationshipDirective(
  input: unknown,
): ArchitectureValidationResult<ArchitectureRelationshipDirective> {
  try {
    const schemaResult = schemaFailure(
      input,
      checkArchitectureRelationshipDirective,
      'architecture.relationship_invalid',
      'architecture relationship directive',
    );
    if (schemaResult !== undefined) return schemaResult;
    return {
      valid: true,
      value: normalizeArchitectureRelationshipDirective(input as ArchitectureRelationshipDirective),
      diagnostics: [],
    };
  } catch {
    return {
      valid: false,
      diagnostics: [
        architectureDiagnostic(
          'architecture.relationship_invalid',
          '',
          'Architecture relationship directive input could not be safely inspected.',
        ),
      ],
    };
  }
}

function planSemanticDiagnostics(plan: Readonly<ArchitecturePlan>): ArchitectureDiagnostic[] {
  const diagnostics: ArchitectureDiagnostic[] = [];
  const ids = new Map<string, string>();
  const collections: readonly [string, readonly { readonly id: string }[]][] = [
    ['/floors', plan.floors],
    ['/spaces', plan.spaces],
    ['/walls', plan.walls],
    ['/openings', plan.openings],
    ['/stairRuns', plan.stairRuns],
    ['/circulationEdges', plan.circulationEdges],
  ];
  for (const [path, values] of collections) {
    values.forEach((value, index) => {
      const firstPath = ids.get(value.id);
      if (firstPath === undefined) {
        ids.set(value.id, `${path}/${index}/id`);
      } else {
        diagnostics.push(
          architectureDiagnostic(
            'architecture.plan_invalid',
            `${path}/${index}/id`,
            `Architecture Plan IDs must be globally unique; first declared at ${firstPath}.`,
            value.id,
          ),
        );
      }
    });
  }

  const floorIds = new Set(plan.floors.map((floor) => floor.id));
  const spaceIds = new Set(plan.spaces.map((space) => space.id));
  const wallById = new Map(plan.walls.map((wall) => [wall.id, wall] as const));
  const openingById = new Map(plan.openings.map((opening) => [opening.id, opening] as const));
  const stairRunIds = new Set(plan.stairRuns.map((run) => run.id));
  for (const [index, space] of plan.spaces.entries()) {
    if (!floorIds.has(space.floorId)) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          `/spaces/${index}/floorId`,
          'Space floorId does not resolve to a plan floor.',
          space.id,
        ),
      );
    }
  }

  for (const [index, wall] of plan.walls.entries()) {
    if (!floorIds.has(wall.floorId)) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          `/walls/${index}/floorId`,
          'Wall floorId does not resolve to a plan floor.',
          wall.id,
        ),
      );
    }
    for (const adjacentId of [wall.firstSpaceId, wall.secondSpaceId]) {
      if (adjacentId !== undefined && !spaceIds.has(adjacentId)) {
        diagnostics.push(
          architectureDiagnostic(
            'architecture.plan_invalid',
            `/walls/${index}`,
            'Wall adjacent-space ID does not resolve.',
            wall.id,
          ),
        );
      }
    }
    const resolvedOpeningIds = plan.openings
      .filter((opening) => opening.wallId === wall.id)
      .map((opening) => opening.id)
      .sort(compareCodePoints);
    const recordedOpeningIds = [...wall.openingIds].sort(compareCodePoints);
    if (
      resolvedOpeningIds.length !== recordedOpeningIds.length ||
      resolvedOpeningIds.some((id, openingIndex) => id !== recordedOpeningIds[openingIndex])
    ) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          `/walls/${index}/openingIds`,
          'Wall openingIds must exactly match openings that reference the wall.',
          wall.id,
        ),
      );
    }
  }

  const openingsByWall = new Map<string, ArchitecturePlan['openings'][number][]>();
  for (const [index, opening] of plan.openings.entries()) {
    const wall = wallById.get(opening.wallId);
    if (wall === undefined) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          `/openings/${index}/wallId`,
          'Opening wallId does not resolve to a logical wall.',
          opening.id,
        ),
      );
      continue;
    }
    if (
      opening.floorId !== wall.floorId ||
      opening.offset + opening.width > wall.end - wall.start ||
      opening.bottom + opening.height > wall.height
    ) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          `/openings/${index}`,
          'Opening floor or bounds do not match its logical wall.',
          opening.id,
        ),
      );
    }
    if (opening.type === 'window' && wall.exterior !== true) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          `/openings/${index}/type`,
          'Window openings are allowed only on exterior walls.',
          opening.id,
        ),
      );
    }
    const values = openingsByWall.get(wall.id) ?? [];
    values.push(opening);
    openingsByWall.set(wall.id, values);
  }
  for (const [wallId, openings] of openingsByWall) {
    openings.sort(
      (left, right) => left.offset - right.offset || compareCodePoints(left.id, right.id),
    );
    for (let index = 1; index < openings.length; index += 1) {
      if (openings[index]!.offset < openings[index - 1]!.offset + openings[index - 1]!.width) {
        diagnostics.push(
          architectureDiagnostic(
            'architecture.plan_invalid',
            '/openings',
            'Openings on one wall must not overlap.',
            wallId,
          ),
        );
      }
    }
  }

  for (const [index, floor] of plan.floors.entries()) {
    const resolvedSpaces = plan.spaces
      .filter((space) => space.floorId === floor.id)
      .map((space) => space.id);
    const resolvedWalls = plan.walls
      .filter((wall) => wall.floorId === floor.id)
      .map((wall) => wall.id);
    const resolvedOpenings = plan.openings
      .filter((opening) => opening.floorId === floor.id)
      .map((opening) => opening.id);
    const resolvedRuns = plan.stairRuns
      .filter((run) => run.fromFloorId === floor.id || run.toFloorId === floor.id)
      .map((run) => run.id);
    for (const [field, recorded, resolved] of [
      ['spaceIds', floor.spaceIds, resolvedSpaces],
      ['wallIds', floor.wallIds, resolvedWalls],
      ['openingIds', floor.openingIds, resolvedOpenings],
      ['stairRunIds', floor.stairRunIds, resolvedRuns],
    ] as const) {
      const left = [...recorded].sort(compareCodePoints);
      const right = [...resolved].sort(compareCodePoints);
      if (left.length !== right.length || left.some((id, valueIndex) => id !== right[valueIndex])) {
        diagnostics.push(
          architectureDiagnostic(
            'architecture.plan_invalid',
            `/floors/${index}/${field}`,
            `Floor ${field} must exactly match resolved plan objects.`,
            floor.id,
          ),
        );
      }
    }
  }

  for (const [index, run] of plan.stairRuns.entries()) {
    if (
      !floorIds.has(run.fromFloorId) ||
      !floorIds.has(run.toFloorId) ||
      run.fromFloorId === run.toFloorId
    ) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          `/stairRuns/${index}`,
          'Stair run floor IDs must resolve to two different plan floors.',
          run.id,
        ),
      );
    }
  }
  for (const [index, edge] of plan.circulationEdges.entries()) {
    const sourceResolves =
      edge.sourceType === 'opening'
        ? openingById.has(edge.sourceId)
        : stairRunIds.has(edge.sourceId);
    if (!sourceResolves) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          `/circulationEdges/${index}/sourceId`,
          'Circulation edge sourceId does not resolve.',
          edge.id,
        ),
      );
    }
  }

  const rooms = plan.spaces.filter((space) => space.type === 'room');
  const corridors = plan.spaces.filter((space) => space.type === 'corridor');
  const intrinsicMetrics = {
    floorCount: plan.floors.length,
    roomCount: rooms.length,
    grossOuterArea:
      plan.building.outerFootprint.width * plan.building.outerFootprint.depth * plan.floors.length,
    clearRoomArea: rooms.reduce((total, room) => total + room.clearArea, 0),
    corridorArea: corridors.reduce(
      (total, corridor) => total + corridor.rectangle.width * corridor.rectangle.depth,
      0,
    ),
    stairArea: plan.spaces
      .filter((space) => space.type === 'stair_hall')
      .reduce(
        (total, stairHall) => total + stairHall.rectangle.width * stairHall.rectangle.depth,
        0,
      ),
    maximumRoomAspectRatio: rooms.reduce((maximum, room) => Math.max(maximum, room.aspectRatio), 1),
    doorCount: plan.openings.filter((opening) => opening.type === 'door').length,
    windowCount: plan.openings.filter((opening) => opening.type === 'window').length,
    stairRunCount: plan.stairRuns.length,
  };
  for (const [key, expected] of Object.entries(intrinsicMetrics) as [
    keyof typeof intrinsicMetrics,
    number,
  ][]) {
    if (Math.abs(plan.metrics[key] - expected) > Number.EPSILON * Math.max(1, expected)) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          `/metrics/${key}`,
          'Architecture Plan intrinsic metric has drifted from plan contents.',
        ),
      );
    }
  }
  const expectedEfficiency =
    intrinsicMetrics.grossOuterArea === 0
      ? 0
      : intrinsicMetrics.clearRoomArea / intrinsicMetrics.grossOuterArea;
  if (
    Math.abs(plan.metrics.clearAreaEfficiency - expectedEfficiency) >
    Number.EPSILON * Math.max(1, expectedEfficiency)
  ) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.plan_invalid',
        '/metrics/clearAreaEfficiency',
        'Clear-area efficiency has drifted from plan contents.',
      ),
    );
  }
  for (const [satisfied, total] of [
    [plan.metrics.requiredAdjacencySatisfied, plan.metrics.requiredAdjacencyTotal],
    [plan.metrics.preferredAdjacencySatisfied, plan.metrics.preferredAdjacencyTotal],
    [plan.metrics.avoidedAdjacencySatisfied, plan.metrics.avoidedAdjacencyTotal],
  ] as const) {
    if (satisfied > total) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          '/metrics',
          'Satisfied adjacency counts cannot exceed their totals.',
        ),
      );
    }
  }
  const expectedScoreTotal = sumArchitectureScoreComponents([
    plan.score.areaDeviation,
    plan.score.aspectRatio,
    plan.score.preferredAdjacency,
    plan.score.preferredWindows,
    plan.score.nearDistance,
    plan.score.zoneOrdering,
  ]);
  if (plan.score.total !== expectedScoreTotal) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.plan_invalid',
        '/score/total',
        'Score total must equal the sum of all non-seed score components.',
      ),
    );
  }

  plan.walls.forEach((wall, index) => {
    if (!(wall.start < wall.end)) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          `/walls/${index}/end`,
          'Canonical wall start must be less than end.',
          wall.id,
        ),
      );
    }
  });

  const expectedLevels = plan.floors.map((_floor, index) => index);
  const levels = [...plan.floors].sort((left, right) => left.level - right.level);
  levels.forEach((floor, index) => {
    if (floor.level !== expectedLevels[index]) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.plan_invalid',
          `/floors/${index}/level`,
          'Architecture Plan floor levels must begin at zero and remain contiguous.',
          floor.id,
        ),
      );
    }
  });
  return sortArchitectureDiagnostics(diagnostics);
}

/** Validates an unknown Architecture Plan schema before any emission or evaluation. */
export function validateArchitecturePlan(
  input: unknown,
): ArchitectureValidationResult<ArchitecturePlan> {
  try {
    const boundDiagnostic = planCollectionBoundDiagnostic(input);
    if (boundDiagnostic !== undefined) {
      return { valid: false, diagnostics: [boundDiagnostic] };
    }
    const schemaResult = schemaFailure(
      input,
      checkArchitecturePlan,
      'architecture.plan_invalid',
      'Architecture Plan',
    );
    if (schemaResult !== undefined) return schemaResult;
    const plan = input as ArchitecturePlan;
    const diagnostics = planSemanticDiagnostics(plan);
    return diagnostics.length === 0
      ? { valid: true, value: normalizeArchitecturePlan(plan), diagnostics }
      : { valid: false, diagnostics };
  } catch {
    return {
      valid: false,
      diagnostics: [
        architectureDiagnostic(
          'architecture.plan_invalid',
          '',
          'Architecture Plan input could not be safely inspected.',
        ),
      ],
    };
  }
}
