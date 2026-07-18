import {
  normalizeWorldSpec,
  validateWorldSpec,
  type WorldConstraint,
  type WorldEntity,
  type WorldRelationship,
  type WorldSpec,
} from '@worldwright/worldspec';

import {
  architectureDiagnostic,
  hasArchitectureErrors,
  sortArchitectureDiagnostics,
  type ArchitectureDiagnostic,
} from './diagnostics.js';
import {
  ARCHITECTURE_ENTITY_DIRECTIVE_KEY,
  ARCHITECTURE_MAX_STEPS_PER_RUN,
  ARCHITECTURE_MAX_WINDOWS_PER_ROOM,
  type ArchitectureBuildingDirective,
  type ArchitectureEntityDirective,
  type ArchitectureFloorDirective,
  type ArchitectureRoomDirective,
  type ArchitectureStairDirective,
} from './entity-directive-schema.js';
import { ARCHITECTURE_MAX_BAND_LENGTH_CELLS } from './allocation.js';
import {
  validateArchitectureEntityDirective,
  validateArchitectureRelationshipDirective,
} from './directive-validation.js';
import { ARCHITECTURE_GENERATED_ID_PREFIX } from './generated-id.js';
import {
  ARCHITECTURE_RELATIONSHIP_DIRECTIVE_KEY,
  type ArchitectureAdjacencyDirective,
} from './relationship-directive-schema.js';
import { calculateStairLandingDepth } from './stairs.js';

export const ARCHITECTURE_MAX_FLOORS = 3;
export const ARCHITECTURE_MAX_ROOMS_PER_FLOOR = 32;
export const ARCHITECTURE_MAX_RELATIONSHIP_DIRECTIVES = 512;

export interface ArchitectureSourceRoom {
  readonly entity: WorldEntity;
  readonly directive: ArchitectureRoomDirective;
}

export interface ArchitectureSourceFloor {
  readonly entity: WorldEntity;
  readonly directive: ArchitectureFloorDirective;
  readonly rooms: readonly ArchitectureSourceRoom[];
}

export interface ArchitectureSourceStair {
  readonly entity: WorldEntity;
  readonly directive: ArchitectureStairDirective;
}

export interface ArchitectureSourceAdjacency {
  readonly relationship: WorldRelationship;
  readonly directive: ArchitectureAdjacencyDirective;
}

export interface ArchitectureSourceProfile {
  readonly source: WorldSpec;
  readonly buildingEntity: WorldEntity;
  readonly building: ArchitectureBuildingDirective;
  readonly floors: readonly ArchitectureSourceFloor[];
  readonly stair?: ArchitectureSourceStair;
  readonly adjacencies: readonly ArchitectureSourceAdjacency[];
  readonly supportedConstraints: readonly WorldConstraint[];
}

export type ArchitectureSourceProfileResult =
  | {
      readonly valid: true;
      readonly value: ArchitectureSourceProfile;
      readonly diagnostics: readonly ArchitectureDiagnostic[];
    }
  | {
      readonly valid: false;
      readonly diagnostics: readonly ArchitectureDiagnostic[];
    };

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function appendPath(prefix: string, suffix: string): string {
  if (suffix === '') return prefix;
  return `${prefix}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

function entityIndexById(worldSpec: WorldSpec): ReadonlyMap<string, number> {
  return new Map(worldSpec.entities.map((entity, index) => [entity.id, index] as const));
}

function relationshipIndexById(worldSpec: WorldSpec): ReadonlyMap<string, number> {
  return new Map(
    worldSpec.relationships.map((relationship, index) => [relationship.id, index] as const),
  );
}

function pathForEntity(indexById: ReadonlyMap<string, number>, entityId: string): string {
  const index = indexById.get(entityId);
  return index === undefined ? '/entities' : `/entities/${index}`;
}

function isGridAligned(value: number, gridSize: number): boolean {
  if (!Number.isFinite(value) || !Number.isSafeInteger(gridSize) || gridSize <= 0) return false;
  const cells = value / gridSize;
  return Number.isSafeInteger(cells);
}

export function architectureStudsToCells(value: number, gridSize: number): number | undefined {
  return isGridAligned(value, gridSize) ? value / gridSize : undefined;
}

function allGridAligned(values: readonly number[], gridSize: number): boolean {
  return values.every((value) => isGridAligned(value, gridSize));
}

function descendantsOf(worldSpec: WorldSpec, buildingId: string): ReadonlySet<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const entity of worldSpec.entities) {
    if (entity.parentId === undefined) continue;
    const children = childrenByParent.get(entity.parentId) ?? [];
    children.push(entity.id);
    childrenByParent.set(entity.parentId, children);
  }
  const result = new Set<string>();
  const pending = [buildingId];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || result.has(current)) continue;
    result.add(current);
    for (const child of childrenByParent.get(current) ?? []) pending.push(child);
  }
  return result;
}

function constraintAffectsBuilding(
  constraint: WorldConstraint,
  buildingIds: ReadonlySet<string>,
): boolean {
  return [...constraint.subjectIds, ...constraint.targetIds].some((id) => buildingIds.has(id));
}

function directiveDiagnosticPath(
  basePath: string,
  diagnostic: ArchitectureDiagnostic,
): ArchitectureDiagnostic {
  return {
    ...diagnostic,
    path: appendPath(basePath, diagnostic.path),
  };
}

interface ValidatedEntityDirective {
  readonly entity: WorldEntity;
  readonly directive: ArchitectureEntityDirective;
}

/** Validates WorldSpec first, then extracts the deliberately narrow planner v0.1 profile. */
export function extractArchitectureSourceProfile(input: unknown): ArchitectureSourceProfileResult {
  const worldSpecResult = validateWorldSpec(input);
  if (!worldSpecResult.valid) {
    return {
      valid: false,
      diagnostics: worldSpecResult.diagnostics.map((entry) =>
        architectureDiagnostic(
          'architecture.worldspec_invalid',
          entry.path,
          `Source WorldSpec failed validation (${entry.code}): ${entry.message}`,
          entry.relatedId,
        ),
      ),
    };
  }

  // WorldSpec validation proves JSON compatibility. Normalization supplies a deep-independent,
  // deterministic value so no profile object retains caller-owned mutable arrays or objects.
  const source = normalizeWorldSpec(worldSpecResult.value);
  const architectureRelationshipDirectiveCount = source.relationships.reduce(
    (count, relationship) =>
      count +
      (relationship.attributes[ARCHITECTURE_RELATIONSHIP_DIRECTIVE_KEY] === undefined ? 0 : 1),
    0,
  );
  if (architectureRelationshipDirectiveCount > ARCHITECTURE_MAX_RELATIONSHIP_DIRECTIVES) {
    return {
      valid: false,
      diagnostics: [
        architectureDiagnostic(
          'architecture.capacity_exceeded',
          '/relationships',
          `Planner v0.1 accepts at most ${ARCHITECTURE_MAX_RELATIONSHIP_DIRECTIVES} architecture relationship directives.`,
        ),
      ],
    };
  }
  const diagnostics: ArchitectureDiagnostic[] = [];
  const entityIndexes = entityIndexById(source);
  const relationshipIndexes = relationshipIndexById(source);
  const entityById = new Map(source.entities.map((entity) => [entity.id, entity] as const));

  const sourceIds: { readonly id: string; readonly path: string }[] = [
    { id: source.project.id, path: '/project/id' },
    ...source.references.map((reference, index) => ({
      id: reference.id,
      path: `/references/${index}/id`,
    })),
    ...source.entities.map((entity) => ({
      id: entity.id,
      path: `${pathForEntity(entityIndexes, entity.id)}/id`,
    })),
    ...source.relationships.map((relationship, index) => ({
      id: relationship.id,
      path: `/relationships/${index}/id`,
    })),
    ...source.constraints.map((constraint, index) => ({
      id: constraint.id,
      path: `/constraints/${index}/id`,
    })),
    ...source.locks.map((lock, index) => ({ id: lock.id, path: `/locks/${index}/id` })),
  ];
  for (const entry of sourceIds) {
    if (!entry.id.startsWith(ARCHITECTURE_GENERATED_ID_PREFIX)) continue;
    diagnostics.push(
      architectureDiagnostic(
        'architecture.reserved_id_conflict',
        entry.path,
        `Source IDs beginning with "${ARCHITECTURE_GENERATED_ID_PREFIX}" are reserved for planner output.`,
        entry.id,
      ),
    );
  }

  const validatedDirectives: ValidatedEntityDirective[] = [];
  for (const entity of source.entities) {
    const basePath = `${pathForEntity(entityIndexes, entity.id)}/attributes/${ARCHITECTURE_ENTITY_DIRECTIVE_KEY}`;
    const rawDirective = entity.attributes[ARCHITECTURE_ENTITY_DIRECTIVE_KEY];
    if (rawDirective === undefined) continue;
    const result = validateArchitectureEntityDirective(rawDirective);
    if (!result.valid) {
      diagnostics.push(
        ...result.diagnostics.map((entry) => directiveDiagnosticPath(basePath, entry)),
      );
      continue;
    }
    validatedDirectives.push({ entity, directive: result.value });
  }

  const buildingEntries = validatedDirectives.filter(
    (entry): entry is ValidatedEntityDirective & { directive: ArchitectureBuildingDirective } =>
      entry.directive.mode === 'building',
  );
  if (buildingEntries.length === 0) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.directive_missing',
        '/entities',
        'Exactly one structure must contain a valid architecture building directive.',
      ),
    );
  } else if (buildingEntries.length > 1) {
    for (const entry of buildingEntries) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.multiple_buildings',
          `${pathForEntity(entityIndexes, entry.entity.id)}/attributes/${ARCHITECTURE_ENTITY_DIRECTIVE_KEY}`,
          'Planner v0.1 accepts exactly one building directive per source WorldSpec.',
          entry.entity.id,
        ),
      );
    }
  }

  if (buildingEntries.length !== 1) {
    return { valid: false, diagnostics: sortArchitectureDiagnostics(diagnostics) };
  }
  const buildingEntry = buildingEntries[0]!;
  const buildingEntity = buildingEntry.entity;
  const building = buildingEntry.directive;
  const buildingPath = pathForEntity(entityIndexes, buildingEntity.id);
  if (buildingEntity.kind !== 'structure') {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.directive_invalid',
        `${buildingPath}/kind`,
        'A building directive is allowed only on a structure entity.',
        buildingEntity.id,
      ),
    );
  }

  const buildingIds = descendantsOf(source, buildingEntity.id);
  const sourceRoomIds = new Set<string>();

  for (const entity of source.entities) {
    const entityPath = pathForEntity(entityIndexes, entity.id);
    if (entity.attributes['worldwright.roblox'] !== undefined) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.roblox_directive_conflict',
          `${entityPath}/attributes/worldwright.roblox`,
          'The planning source must not contain a pre-authored worldwright.roblox directive.',
          entity.id,
        ),
      );
    }
  }

  // The only supported ancestor chain is world -> optional region -> optional parcel -> structure.
  let ancestor =
    buildingEntity.parentId === undefined ? undefined : entityById.get(buildingEntity.parentId);
  const ancestorKinds: string[] = [];
  while (ancestor !== undefined && ancestor.id !== source.rootEntityId) {
    ancestorKinds.push(ancestor.kind);
    if (ancestor.kind !== 'region' && ancestor.kind !== 'parcel') {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.profile_invalid',
          pathForEntity(entityIndexes, ancestor.id),
          'Only region and parcel entities may appear between the world root and planned structure.',
          ancestor.id,
        ),
      );
    }
    ancestor = ancestor.parentId === undefined ? undefined : entityById.get(ancestor.parentId);
  }
  if (
    ancestorKinds.filter((kind) => kind === 'region').length > 1 ||
    ancestorKinds.filter((kind) => kind === 'parcel').length > 1 ||
    (ancestorKinds.includes('region') &&
      ancestorKinds.includes('parcel') &&
      ancestorKinds.indexOf('parcel') > ancestorKinds.indexOf('region'))
  ) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.profile_invalid',
        buildingPath,
        'The planned structure may have at most one parcel beneath at most one region ancestor.',
        buildingEntity.id,
      ),
    );
  }

  const directChildren = source.entities.filter((entity) => entity.parentId === buildingEntity.id);
  const floorEntities = directChildren.filter((entity) => entity.kind === 'floor');
  const routeEntities = directChildren.filter((entity) => entity.kind === 'route');
  for (const child of directChildren) {
    if (child.kind !== 'floor' && child.kind !== 'route') {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.profile_invalid',
          pathForEntity(entityIndexes, child.id),
          'Only planned floors and the optional stair route may be direct children of the building.',
          child.id,
        ),
      );
    }
  }

  const directiveByEntityId = new Map(
    validatedDirectives.map((entry) => [entry.entity.id, entry.directive] as const),
  );
  const floors: ArchitectureSourceFloor[] = [];
  const seenLevels = new Set<number>();
  for (const floorEntity of floorEntities) {
    const floorPath = pathForEntity(entityIndexes, floorEntity.id);
    const directive = directiveByEntityId.get(floorEntity.id);
    if (directive?.mode !== 'floor') {
      diagnostics.push(
        architectureDiagnostic(
          directive === undefined
            ? 'architecture.directive_missing'
            : 'architecture.directive_invalid',
          `${floorPath}/attributes/${ARCHITECTURE_ENTITY_DIRECTIVE_KEY}`,
          'Every direct floor child requires a floor architecture directive.',
          floorEntity.id,
        ),
      );
      continue;
    }
    if (seenLevels.has(directive.level)) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.floor_invalid',
          `${floorPath}/attributes/${ARCHITECTURE_ENTITY_DIRECTIVE_KEY}/level`,
          `Floor level ${directive.level} is duplicated.`,
          floorEntity.id,
        ),
      );
    }
    seenLevels.add(directive.level);

    const childEntities = source.entities.filter((entity) => entity.parentId === floorEntity.id);
    const rooms: ArchitectureSourceRoom[] = [];
    for (const child of childEntities) {
      const childPath = pathForEntity(entityIndexes, child.id);
      if (child.kind !== 'room') {
        diagnostics.push(
          architectureDiagnostic(
            'architecture.profile_invalid',
            childPath,
            'A planned floor may contain only direct room children.',
            child.id,
          ),
        );
        continue;
      }
      const roomDirective = directiveByEntityId.get(child.id);
      if (roomDirective?.mode !== 'room') {
        diagnostics.push(
          architectureDiagnostic(
            roomDirective === undefined
              ? 'architecture.directive_missing'
              : 'architecture.directive_invalid',
            `${childPath}/attributes/${ARCHITECTURE_ENTITY_DIRECTIVE_KEY}`,
            'Every direct room child requires a room architecture directive.',
            child.id,
          ),
        );
        continue;
      }
      sourceRoomIds.add(child.id);
      rooms.push({ entity: child, directive: roomDirective });
    }
    rooms.sort((left, right) => compareCodePoints(left.entity.id, right.entity.id));
    if (rooms.length < 2 || rooms.length > ARCHITECTURE_MAX_ROOMS_PER_FLOOR) {
      diagnostics.push(
        architectureDiagnostic(
          rooms.length > ARCHITECTURE_MAX_ROOMS_PER_FLOOR
            ? 'architecture.capacity_exceeded'
            : 'architecture.floor_invalid',
          floorPath,
          `Each floor must contain between 2 and ${ARCHITECTURE_MAX_ROOMS_PER_FLOOR} planned rooms.`,
          floorEntity.id,
        ),
      );
    }
    floors.push({ entity: floorEntity, directive, rooms });
  }
  floors.sort(
    (left, right) =>
      left.directive.level - right.directive.level ||
      compareCodePoints(left.entity.id, right.entity.id),
  );

  if (floors.length < 1 || floors.length > ARCHITECTURE_MAX_FLOORS) {
    diagnostics.push(
      architectureDiagnostic(
        floors.length > ARCHITECTURE_MAX_FLOORS
          ? 'architecture.capacity_exceeded'
          : 'architecture.floor_invalid',
        buildingPath,
        `Planner v0.1 supports one through ${ARCHITECTURE_MAX_FLOORS} floors.`,
        buildingEntity.id,
      ),
    );
  }
  floors.forEach((floor, index) => {
    if (floor.directive.level !== index) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.floor_invalid',
          `${pathForEntity(entityIndexes, floor.entity.id)}/attributes/${ARCHITECTURE_ENTITY_DIRECTIVE_KEY}/level`,
          'Floor levels must be contiguous and begin at level 0.',
          floor.entity.id,
        ),
      );
    }
    if (floor.directive.clearHeight + building.slabThickness > building.floorToFloorHeight) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.floor_invalid',
          `${pathForEntity(entityIndexes, floor.entity.id)}/attributes/${ARCHITECTURE_ENTITY_DIRECTIVE_KEY}/clearHeight`,
          'Floor clear height plus slab thickness must not exceed floor-to-floor height.',
          floor.entity.id,
        ),
      );
    }
    if (floor.directive.clearHeight < building.defaultDoorHeight) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.opening_infeasible',
          `${pathForEntity(entityIndexes, floor.entity.id)}/attributes/${ARCHITECTURE_ENTITY_DIRECTIVE_KEY}/clearHeight`,
          'Floor clear height must accommodate the default door height.',
          floor.entity.id,
        ),
      );
    }
    const requiresWindow = floor.rooms.some((room) => room.directive.windows.minimum > 0);
    const defaultWindowTop = building.defaultWindowSillHeight + building.defaultWindowHeight;
    if (requiresWindow && floor.directive.clearHeight < defaultWindowTop) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.opening_infeasible',
          `${pathForEntity(entityIndexes, floor.entity.id)}/attributes/${ARCHITECTURE_ENTITY_DIRECTIVE_KEY}/clearHeight`,
          'A floor with required windows must accommodate the complete default window above its sill.',
          floor.entity.id,
        ),
      );
    }
  });

  // Reject any unsupported nested descendant, including grandchildren beneath rooms.
  const acceptedDescendants = new Set<string>([
    buildingEntity.id,
    ...floorEntities.map((entity) => entity.id),
    ...routeEntities.map((entity) => entity.id),
    ...floors.flatMap((floor) => floor.rooms.map((room) => room.entity.id)),
  ]);
  for (const id of buildingIds) {
    if (!acceptedDescendants.has(id)) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.profile_invalid',
          pathForEntity(entityIndexes, id),
          'This descendant kind or nesting shape is not supported inside a planned building.',
          id,
        ),
      );
    }
  }

  let stair: ArchitectureSourceStair | undefined;
  if (floors.length > 1) {
    if (routeEntities.length !== 1) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.stair_required',
          buildingPath,
          'A multi-floor building requires exactly one direct stair route child.',
          buildingEntity.id,
        ),
      );
    } else {
      const stairEntity = routeEntities[0]!;
      const stairDirective = directiveByEntityId.get(stairEntity.id);
      if (stairDirective?.mode !== 'stair') {
        diagnostics.push(
          architectureDiagnostic(
            stairDirective === undefined
              ? 'architecture.directive_missing'
              : 'architecture.directive_invalid',
            `${pathForEntity(entityIndexes, stairEntity.id)}/attributes/${ARCHITECTURE_ENTITY_DIRECTIVE_KEY}`,
            'The multi-floor stair route requires a stair architecture directive.',
            stairEntity.id,
          ),
        );
      } else {
        stair = { entity: stairEntity, directive: stairDirective };
        const expectedFloorIds = floors.map((floor) => floor.entity.id);
        if (
          expectedFloorIds.length !== stairDirective.floorIds.length ||
          expectedFloorIds.some((id, index) => stairDirective.floorIds[index] !== id)
        ) {
          diagnostics.push(
            architectureDiagnostic(
              'architecture.stair_infeasible',
              `${pathForEntity(entityIndexes, stairEntity.id)}/attributes/${ARCHITECTURE_ENTITY_DIRECTIVE_KEY}/floorIds`,
              'Stair floorIds must exactly match all planned floors in level order.',
              stairEntity.id,
            ),
          );
        }
      }
    }
  } else if (routeEntities.length > 0) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.profile_invalid',
        pathForEntity(entityIndexes, routeEntities[0]!.id),
        'A single-floor building must not contain a planner stair route.',
        routeEntities[0]!.id,
      ),
    );
  }

  const entranceRooms = floors.flatMap((floor) =>
    floor.rooms.filter((room) => room.directive.isEntrance).map((room) => ({ floor, room })),
  );
  if (entranceRooms.length !== 1 || entranceRooms[0]?.floor.directive.level !== 0) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.room_invalid',
        buildingPath,
        'Exactly one planned room must be the entrance, and it must belong to level 0.',
        entranceRooms[0]?.room.entity.id,
      ),
    );
  }

  const horizontalBuildingValues = [
    building.footprint.width,
    building.footprint.depth,
    building.exteriorWallThickness,
    building.interiorWallThickness,
    building.corridorWidth,
    building.defaultDoorWidth,
    building.defaultWindowWidth,
    building.openingEndClearance,
  ];
  if (!allGridAligned(horizontalBuildingValues, building.gridSize)) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.grid_misaligned',
        `${buildingPath}/attributes/${ARCHITECTURE_ENTITY_DIRECTIVE_KEY}`,
        'All horizontal building dimensions must align to gridSize.',
        buildingEntity.id,
      ),
    );
  }
  const widthCells = architectureStudsToCells(building.footprint.width, building.gridSize);
  const depthCells = architectureStudsToCells(building.footprint.depth, building.gridSize);
  if (
    widthCells !== undefined &&
    depthCells !== undefined &&
    (widthCells > ARCHITECTURE_MAX_BAND_LENGTH_CELLS ||
      depthCells > ARCHITECTURE_MAX_BAND_LENGTH_CELLS)
  ) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.capacity_exceeded',
        `${buildingPath}/attributes/${ARCHITECTURE_ENTITY_DIRECTIVE_KEY}/footprint`,
        `Footprint dimensions may not exceed ${ARCHITECTURE_MAX_BAND_LENGTH_CELLS} grid cells.`,
        buildingEntity.id,
      ),
    );
  }
  const interiorWidth = building.footprint.width - 2 * building.exteriorWallThickness;
  const interiorDepth = building.footprint.depth - 2 * building.exteriorWallThickness;
  if (interiorWidth <= 0 || interiorDepth <= 0) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.profile_invalid',
        `${buildingPath}/attributes/${ARCHITECTURE_ENTITY_DIRECTIVE_KEY}/footprint`,
        'Exterior wall thickness leaves no positive interior envelope.',
        buildingEntity.id,
      ),
    );
  }
  const corridorCrossSpan = building.corridorWidth + 2 * building.interiorWallThickness;
  const minimumTwoBandSpan = 2 * building.gridSize;
  const corridorFits =
    building.corridorAxis === 'x'
      ? interiorDepth - corridorCrossSpan >= minimumTwoBandSpan
      : building.corridorAxis === 'z'
        ? interiorWidth - corridorCrossSpan >= minimumTwoBandSpan
        : interiorWidth - corridorCrossSpan >= minimumTwoBandSpan ||
          interiorDepth - corridorCrossSpan >= minimumTwoBandSpan;
  if (!corridorFits) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.profile_invalid',
        `${buildingPath}/attributes/${ARCHITECTURE_ENTITY_DIRECTIVE_KEY}/corridorWidth`,
        'The corridor and its two boundary walls must leave at least one grid cell for each room band.',
        buildingEntity.id,
      ),
    );
  }

  const cellArea = building.gridSize * building.gridSize;
  const grossFootprintArea = building.footprint.width * building.footprint.depth;
  if (
    !Number.isSafeInteger(cellArea) ||
    !Number.isSafeInteger(grossFootprintArea) ||
    !Number.isSafeInteger(grossFootprintArea * Math.max(1, floors.length))
  ) {
    diagnostics.push(
      architectureDiagnostic(
        'architecture.arithmetic_overflow',
        `${buildingPath}/attributes/${ARCHITECTURE_ENTITY_DIRECTIVE_KEY}/footprint`,
        'Grid-cell or gross-area arithmetic exceeds the safe-integer planning range.',
        buildingEntity.id,
      ),
    );
  }
  for (const floor of floors) {
    for (const room of floor.rooms) {
      const roomPath = `${pathForEntity(entityIndexes, room.entity.id)}/attributes/${ARCHITECTURE_ENTITY_DIRECTIVE_KEY}`;
      const directive = room.directive;
      if (
        directive.minimumArea > directive.preferredArea ||
        directive.preferredArea > directive.maximumArea ||
        directive.windows.minimum > directive.windows.preferred
      ) {
        diagnostics.push(
          architectureDiagnostic(
            'architecture.room_invalid',
            roomPath,
            'Room areas and window counts must be ordered minimum <= preferred <= maximum.',
            room.entity.id,
          ),
        );
      }
      if (
        directive.windows.minimum > ARCHITECTURE_MAX_WINDOWS_PER_ROOM ||
        directive.windows.preferred > ARCHITECTURE_MAX_WINDOWS_PER_ROOM
      ) {
        diagnostics.push(
          architectureDiagnostic(
            'architecture.capacity_exceeded',
            `${roomPath}/windows`,
            `A room may request at most ${ARCHITECTURE_MAX_WINDOWS_PER_ROOM} windows.`,
            room.entity.id,
          ),
        );
      }
      const horizontalValues = [
        directive.minimumSpan,
        directive.doorWidth ?? building.defaultDoorWidth,
      ];
      if (
        !allGridAligned(horizontalValues, building.gridSize) ||
        !Number.isSafeInteger(cellArea) ||
        ![directive.minimumArea, directive.preferredArea, directive.maximumArea].every(
          (area) => Number.isSafeInteger(area) && Number.isSafeInteger(area / cellArea),
        )
      ) {
        diagnostics.push(
          architectureDiagnostic(
            'architecture.grid_misaligned',
            roomPath,
            'Room spans, door width, and area targets must align to the building grid.',
            room.entity.id,
          ),
        );
      }
    }
  }
  if (stair !== undefined) {
    const stairPath = `${pathForEntity(entityIndexes, stair.entity.id)}/attributes/${ARCHITECTURE_ENTITY_DIRECTIVE_KEY}`;
    if (
      !allGridAligned([stair.directive.coreWidth, stair.directive.coreLength], building.gridSize)
    ) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.grid_misaligned',
          stairPath,
          'Stair core dimensions must align to the building grid.',
          stair.entity.id,
        ),
      );
    }
    const adjacentRise = building.floorToFloorHeight;
    const stepCount = Math.ceil(adjacentRise / stair.directive.maximumRiserHeight);
    if (
      !Number.isSafeInteger(stepCount) ||
      stepCount <= 0 ||
      stepCount > ARCHITECTURE_MAX_STEPS_PER_RUN
    ) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.capacity_exceeded',
          `${stairPath}/maximumRiserHeight`,
          `A stair run may contain at most ${ARCHITECTURE_MAX_STEPS_PER_RUN} steps.`,
          stair.entity.id,
        ),
      );
    } else {
      const landingDepth = calculateStairLandingDepth(
        stair.directive.coreLength,
        stair.directive.minimumTreadDepth,
      );
      const availableRunLength = stair.directive.coreLength - 2 * landingDepth;
      if (stepCount * stair.directive.minimumTreadDepth > availableRunLength) {
        diagnostics.push(
          architectureDiagnostic(
            'architecture.stair_infeasible',
            stairPath,
            'A straight stair run cannot satisfy riser and tread limits after reserving both deterministic landings.',
            stair.entity.id,
          ),
        );
      }
    }
  }

  const floorIdByRoomId = new Map<string, string>();
  for (const floor of floors) {
    for (const room of floor.rooms) floorIdByRoomId.set(room.entity.id, floor.entity.id);
  }
  const adjacencies: ArchitectureSourceAdjacency[] = [];
  const architectureAdjacencyPairs = new Set<string>();
  for (const relationship of source.relationships) {
    const rawDirective = relationship.attributes[ARCHITECTURE_RELATIONSHIP_DIRECTIVE_KEY];
    if (rawDirective === undefined) continue;
    const relationshipIndex = relationshipIndexes.get(relationship.id);
    const basePath = `${relationshipIndex === undefined ? '/relationships' : `/relationships/${relationshipIndex}`}/attributes/${ARCHITECTURE_RELATIONSHIP_DIRECTIVE_KEY}`;
    const directiveResult = validateArchitectureRelationshipDirective(rawDirective);
    if (!directiveResult.valid) {
      diagnostics.push(
        ...directiveResult.diagnostics.map((entry) => directiveDiagnosticPath(basePath, entry)),
      );
      continue;
    }
    const directive = directiveResult.value;
    if (
      relationship.type !== 'adjacent_to' ||
      relationship.directed ||
      !sourceRoomIds.has(relationship.sourceId) ||
      !sourceRoomIds.has(relationship.targetId)
    ) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.relationship_invalid',
          basePath,
          'Architecture adjacency directives are allowed only on undirected planned room-to-room adjacent_to relationships.',
          relationship.id,
        ),
      );
      continue;
    }
    if (
      directive.connection === 'door' &&
      floorIdByRoomId.get(relationship.sourceId) !== floorIdByRoomId.get(relationship.targetId)
    ) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.relationship_invalid',
          basePath,
          'A door adjacency relationship must connect two rooms on the same floor.',
          relationship.id,
        ),
      );
      continue;
    }
    const pair =
      compareCodePoints(relationship.sourceId, relationship.targetId) <= 0
        ? `${relationship.sourceId}\u0000${relationship.targetId}`
        : `${relationship.targetId}\u0000${relationship.sourceId}`;
    if (architectureAdjacencyPairs.has(pair)) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.relationship_invalid',
          basePath,
          'Planner v0.1 accepts at most one architecture adjacency directive for an unordered room pair.',
          relationship.id,
        ),
      );
      continue;
    }
    architectureAdjacencyPairs.add(pair);
    adjacencies.push({ relationship, directive });
  }
  adjacencies.sort((left, right) => compareCodePoints(left.relationship.id, right.relationship.id));

  for (const lock of source.locks) {
    if (buildingIds.has(lock.entityId)) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.lock_unsupported',
          `/locks/${source.locks.findIndex((candidate) => candidate.id === lock.id)}`,
          'Planner v0.1 cannot safely interpret locks targeting the planned building.',
          lock.id,
        ),
      );
    }
  }

  const supportedConstraints: WorldConstraint[] = [];
  for (const constraint of source.constraints) {
    if (!constraintAffectsBuilding(constraint, buildingIds)) continue;
    const allRoomIds = [...constraint.subjectIds, ...constraint.targetIds].every((id) =>
      sourceRoomIds.has(id),
    );
    if (
      constraint.type === 'reachability' &&
      allRoomIds &&
      constraint.subjectIds.length > 0 &&
      constraint.targetIds.length > 0 &&
      Object.keys(constraint.parameters).length === 0
    ) {
      supportedConstraints.push(constraint);
      continue;
    }
    const constraintIndex = source.constraints.findIndex(
      (candidate) => candidate.id === constraint.id,
    );
    diagnostics.push(
      architectureDiagnostic(
        constraint.severity === 'error'
          ? 'architecture.constraint_unsupported'
          : 'architecture.constraint_unevaluated',
        `/constraints/${constraintIndex}`,
        constraint.severity === 'error'
          ? 'This error-severity constraint is not supported by planner v0.1.'
          : 'This warning-severity constraint is preserved but was not evaluated by planner v0.1.',
        constraint.id,
        constraint.severity,
      ),
    );
  }

  // Directives are never silently accepted in the wrong semantic location.
  const acceptedDirectiveIds = new Set<string>([
    buildingEntity.id,
    ...floors.map((floor) => floor.entity.id),
    ...floors.flatMap((floor) => floor.rooms.map((room) => room.entity.id)),
    ...(stair === undefined ? [] : [stair.entity.id]),
  ]);
  for (const entry of validatedDirectives) {
    if (!acceptedDirectiveIds.has(entry.entity.id)) {
      diagnostics.push(
        architectureDiagnostic(
          'architecture.directive_invalid',
          `${pathForEntity(entityIndexes, entry.entity.id)}/attributes/${ARCHITECTURE_ENTITY_DIRECTIVE_KEY}`,
          'Architecture directive mode does not match a supported entity location.',
          entry.entity.id,
        ),
      );
    }
  }

  const sortedDiagnostics = sortArchitectureDiagnostics(diagnostics);
  if (hasArchitectureErrors(sortedDiagnostics)) {
    return { valid: false, diagnostics: sortedDiagnostics };
  }
  return {
    valid: true,
    value: {
      source,
      buildingEntity,
      building,
      floors,
      ...(stair === undefined ? {} : { stair }),
      adjacencies,
      supportedConstraints,
    },
    diagnostics: sortedDiagnostics,
  };
}
