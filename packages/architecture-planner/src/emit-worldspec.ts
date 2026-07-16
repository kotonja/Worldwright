import { createHash } from 'node:crypto';

import {
  ROBLOX_DIRECTIVE_KEY,
  ROBLOX_DIRECTIVE_VERSION,
  compileWorldSpecToRobloxManifest,
  type RobloxManifest,
} from '@worldwright/roblox-compiler';
import {
  normalizeWorldSpec,
  stringifyWorldSpec,
  validateWorldSpec,
  type JsonValue,
  type Provenance,
  type WorldEntity,
  type WorldSpec,
} from '@worldwright/worldspec';

import { architectureDiagnostic, sortArchitectureDiagnostics } from './diagnostics.js';
import { validateArchitecturePlan } from './directive-validation.js';
import { ArchitectureGeneratedIdError, createGeneratedId } from './generated-id.js';
import { hashArchitecturePlan } from './hashing.js';
import { evaluateArchitecturePlan } from './plan-evaluation.js';
import { decomposeWallPanels, type WallPanel } from './walls.js';
import { buildUniqueStairLandingPlacements, buildUpperSlabPanels } from './stairs.js';
import type {
  ArchitectureDiagnostic,
  ArchitectureOpening,
  ArchitecturePlan,
  ArchitectureRectangle,
  ArchitectureStairRun,
  ArchitectureWall,
} from './types.js';

export interface ArchitectureEmissionSuccess {
  readonly success: true;
  readonly worldSpec: WorldSpec;
  readonly manifest: RobloxManifest;
  readonly architecturePlanHash: string;
  readonly diagnostics: readonly ArchitectureDiagnostic[];
}

export interface ArchitectureEmissionFailure {
  readonly success: false;
  readonly diagnostics: readonly ArchitectureDiagnostic[];
}

export type ArchitectureEmissionResult = ArchitectureEmissionSuccess | ArchitectureEmissionFailure;

export interface ArchitectureEmissionCounts {
  readonly generatedEntityCount: number;
  readonly primitiveCount: number;
  readonly totalDerivedEntityCount: number;
}

export const ARCHITECTURE_MAX_GENERATED_ENTITY_COUNT = 16_384;
export const ARCHITECTURE_MAX_PRIMITIVE_COUNT = 12_288;

export class ArchitectureEmissionCapacityError extends Error {
  readonly code = 'architecture.capacity_exceeded' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ArchitectureEmissionCapacityError';
  }
}

interface EntityAccumulator {
  readonly entities: WorldEntity[];
  readonly usedIds: Set<string>;
  primitiveCount: number;
}

interface PrimitiveGeometry {
  readonly centerX: number;
  readonly centerY: number;
  readonly centerZ: number;
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  readonly localYaw: 0 | 90;
}

type RobloxMaterialName =
  | 'SmoothPlastic'
  | 'Concrete'
  | 'Brick'
  | 'Wood'
  | 'WoodPlanks'
  | 'Slate'
  | 'Cobblestone'
  | 'Metal'
  | 'Glass'
  | 'Neon'
  | 'Grass'
  | 'Sand'
  | 'Rock'
  | 'Marble'
  | 'Granite';

interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sourceHash(source: Readonly<WorldSpec>): string {
  return sha256Hex(stringifyWorldSpec(source));
}

function normalizeYaw(value: number): number {
  const normalized = ((value % 360) + 360) % 360;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function transformLocalPoint(
  plan: Readonly<ArchitecturePlan>,
  localX: number,
  localZ: number,
): { readonly x: number; readonly z: number } {
  const origin = plan.building.worldOrigin;
  switch (plan.building.yawDegrees) {
    case 0:
      return { x: origin.x + localX, z: origin.z + localZ };
    case 90:
      return { x: origin.x - localZ, z: origin.z + localX };
    case 180:
      return { x: origin.x - localX, z: origin.z - localZ };
    case 270:
      return { x: origin.x + localZ, z: origin.z - localX };
  }
}

function center(rectangle: Readonly<ArchitectureRectangle>): {
  readonly x: number;
  readonly z: number;
} {
  return { x: rectangle.x + rectangle.width / 2, z: rectangle.z + rectangle.depth / 2 };
}

function containerDirective(className: 'Folder' | 'Model'): JsonValue {
  return { schemaVersion: ROBLOX_DIRECTIVE_VERSION, mode: 'container', className };
}

function primitiveDirective(
  material: RobloxMaterialName,
  color: Readonly<RgbColor>,
  transparency: number,
  collision: boolean,
  castShadow: boolean,
): JsonValue {
  return {
    schemaVersion: ROBLOX_DIRECTIVE_VERSION,
    mode: 'primitive',
    className: 'Part',
    shape: 'Block',
    material,
    color: { r: color.r, g: color.g, b: color.b },
    transparency,
    canCollide: collision,
    canQuery: true,
    canTouch: collision,
    castShadow,
  };
}

function generatedProvenance(source: Readonly<Provenance> | undefined, note: string): Provenance {
  return {
    classification: 'invented',
    referenceIds: [...(source?.referenceIds ?? [])].sort(compareCodePoints),
    confidence: 1,
    notes: note,
  };
}

function generatedAttributes(
  role: string,
  planHash: string,
  directive: JsonValue,
  sourceId?: string,
): Record<string, JsonValue> {
  return {
    'worldwright.architecture.generated': {
      schemaVersion: '0.1.0',
      plannerVersion: '0.1.0',
      architecturePlanHash: planHash,
      role,
      ...(sourceId === undefined ? {} : { sourceId }),
    },
    [ROBLOX_DIRECTIVE_KEY]: directive,
  };
}

function addEntity(accumulator: EntityAccumulator, entity: WorldEntity): void {
  if (accumulator.usedIds.has(entity.id)) {
    throw new ArchitectureGeneratedIdError(
      `Generated entity ID collides with the source namespace: ${entity.id}`,
    );
  }
  accumulator.usedIds.add(entity.id);
  accumulator.entities.push(entity);
}

function generatedId(accumulator: EntityAccumulator, parts: readonly string[]): string {
  return createGeneratedId(parts, accumulator.usedIds);
}

function semanticGeometry(
  plan: Readonly<ArchitecturePlan>,
  rectangle: Readonly<ArchitectureRectangle>,
  bottomY: number,
  height: number,
): Pick<WorldEntity, 'transform' | 'bounds'> {
  const localCenter = center(rectangle);
  const world = transformLocalPoint(plan, localCenter.x, localCenter.z);
  return {
    transform: {
      position: { x: world.x, y: bottomY + height / 2, z: world.z },
      rotationEulerDegrees: { x: 0, y: plan.building.yawDegrees, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    bounds: { size: { x: rectangle.width, y: height, z: rectangle.depth } },
  };
}

function primitiveGeometryEntity(
  plan: Readonly<ArchitecturePlan>,
  id: string,
  name: string,
  parentId: string,
  geometry: Readonly<PrimitiveGeometry>,
  material: RobloxMaterialName,
  color: Readonly<RgbColor>,
  transparency: number,
  collision: boolean,
  castShadow: boolean,
  provenance: Readonly<Provenance>,
  role: string,
  planHash: string,
  sourceId?: string,
): WorldEntity {
  const world = transformLocalPoint(plan, geometry.centerX, geometry.centerZ);
  return {
    id,
    kind: 'object',
    name,
    parentId,
    provenance: { ...provenance, referenceIds: [...provenance.referenceIds] },
    transform: {
      position: { x: world.x, y: geometry.centerY, z: world.z },
      rotationEulerDegrees: {
        x: 0,
        y: normalizeYaw(plan.building.yawDegrees + geometry.localYaw),
        z: 0,
      },
      scale: { x: 1, y: 1, z: 1 },
    },
    bounds: {
      size: { x: geometry.sizeX, y: geometry.sizeY, z: geometry.sizeZ },
    },
    tags: ['architecture-blockout', role],
    attributes: generatedAttributes(
      role,
      planHash,
      primitiveDirective(material, color, transparency, collision, castShadow),
      sourceId,
    ),
  };
}

function sourceContainerClass(entity: Readonly<WorldEntity>): 'Folder' | 'Model' {
  switch (entity.kind) {
    case 'structure':
    case 'route':
      return 'Model';
    default:
      return 'Folder';
  }
}

function sourceEntityGeometry(
  entity: Readonly<WorldEntity>,
  plan: Readonly<ArchitecturePlan>,
): Pick<WorldEntity, 'transform' | 'bounds'> | undefined {
  const floor = plan.floors.find((candidate) => candidate.id === entity.id);
  if (floor !== undefined) {
    return semanticGeometry(plan, floor.footprint, floor.finishedFloorElevation, floor.clearHeight);
  }
  const space = plan.spaces.find((candidate) => candidate.id === entity.id);
  if (space !== undefined) {
    const owningFloor = plan.floors.find((candidate) => candidate.id === space.floorId);
    if (owningFloor !== undefined) {
      return semanticGeometry(
        plan,
        space.rectangle,
        owningFloor.finishedFloorElevation,
        owningFloor.clearHeight,
      );
    }
  }
  if (entity.id === plan.source.buildingEntityId) {
    const topFloor = [...plan.floors].sort((left, right) => right.level - left.level)[0];
    if (topFloor !== undefined) {
      const height =
        topFloor.finishedFloorElevation + topFloor.clearHeight - plan.building.worldOrigin.y;
      return semanticGeometry(
        plan,
        plan.building.outerFootprint,
        plan.building.worldOrigin.y,
        height,
      );
    }
  }
  const stair = plan.spaces.find(
    (candidate) => candidate.type === 'stair_hall' && candidate.sourceStairRouteId === entity.id,
  );
  if (stair !== undefined) {
    const topFloor = [...plan.floors].sort((left, right) => right.level - left.level)[0];
    if (topFloor !== undefined) {
      const height =
        topFloor.finishedFloorElevation + topFloor.clearHeight - plan.building.worldOrigin.y;
      return semanticGeometry(plan, stair.rectangle, plan.building.worldOrigin.y, height);
    }
  }
  return undefined;
}

function preserveSourceEntities(
  source: Readonly<WorldSpec>,
  plan: Readonly<ArchitecturePlan>,
  planHash: string,
): WorldEntity[] {
  return source.entities.map((entity) => {
    const geometry = sourceEntityGeometry(entity, plan);
    const attributes: Record<string, JsonValue> = {
      ...entity.attributes,
      [ROBLOX_DIRECTIVE_KEY]: containerDirective(sourceContainerClass(entity)),
      ...(entity.id === plan.source.buildingEntityId
        ? {
            'worldwright.architecture.result': {
              schemaVersion: '0.1.0',
              plannerVersion: plan.plannerVersion,
              sourceWorldSpecHash: plan.source.worldSpecHash,
              architecturePlanHash: planHash,
            },
          }
        : {}),
    };
    return {
      ...entity,
      provenance: { ...entity.provenance, referenceIds: [...entity.provenance.referenceIds] },
      tags: [...entity.tags],
      attributes,
      ...(geometry ?? {}),
    };
  });
}

function addSpaceEntities(
  plan: Readonly<ArchitecturePlan>,
  planHash: string,
  sourceById: ReadonlyMap<string, WorldEntity>,
  accumulator: EntityAccumulator,
): void {
  for (const space of plan.spaces) {
    if (space.type === 'room') continue;
    const floor = plan.floors.find((candidate) => candidate.id === space.floorId);
    if (floor === undefined) throw new Error(`Space ${space.id} has no floor.`);
    const source =
      space.type === 'stair_hall'
        ? sourceById.get(space.sourceStairRouteId)
        : sourceById.get(space.floorId);
    addEntity(accumulator, {
      id: space.id,
      kind: 'route',
      name:
        space.type === 'corridor'
          ? `Corridor Level ${floor.level}`
          : `Stair Hall Level ${floor.level}`,
      parentId: space.floorId,
      provenance: generatedProvenance(
        source?.provenance,
        'Deterministic clear-space circulation blockout generated from the authored program.',
      ),
      ...semanticGeometry(plan, space.rectangle, floor.finishedFloorElevation, floor.clearHeight),
      tags: ['architecture-blockout', space.type],
      attributes: generatedAttributes(
        space.type,
        planHash,
        containerDirective(space.type === 'corridor' ? 'Folder' : 'Model'),
        space.type === 'stair_hall' ? space.sourceStairRouteId : space.floorId,
      ),
    });
  }
}

function wallPanelGeometry(
  wall: Readonly<ArchitectureWall>,
  panel: Readonly<WallPanel>,
  finishedFloorElevation: number,
): PrimitiveGeometry {
  if (wall.axis === 'x') {
    return {
      centerX: wall.start + panel.offset + panel.width / 2,
      centerY: finishedFloorElevation + panel.bottom + panel.height / 2,
      centerZ: wall.constant,
      sizeX: panel.width,
      sizeY: panel.height,
      sizeZ: wall.thickness,
      localYaw: 0,
    };
  }
  return {
    centerX: wall.constant,
    centerY: finishedFloorElevation + panel.bottom + panel.height / 2,
    centerZ: wall.start + panel.offset + panel.width / 2,
    sizeX: panel.width,
    sizeY: panel.height,
    sizeZ: wall.thickness,
    localYaw: 90,
  };
}

function openingGeometry(
  wall: Readonly<ArchitectureWall>,
  opening: Readonly<ArchitectureOpening>,
  finishedFloorElevation: number,
): PrimitiveGeometry {
  const thinDepth = Math.min(wall.thickness, 0.25);
  if (wall.axis === 'x') {
    return {
      centerX: wall.start + opening.offset + opening.width / 2,
      centerY: finishedFloorElevation + opening.bottom + opening.height / 2,
      centerZ: wall.constant,
      sizeX: opening.width,
      sizeY: opening.height,
      sizeZ: thinDepth,
      localYaw: 0,
    };
  }
  return {
    centerX: wall.constant,
    centerY: finishedFloorElevation + opening.bottom + opening.height / 2,
    centerZ: wall.start + opening.offset + opening.width / 2,
    sizeX: opening.width,
    sizeY: opening.height,
    sizeZ: thinDepth,
    localYaw: 90,
  };
}

function addWallsAndOpenings(
  plan: Readonly<ArchitecturePlan>,
  planHash: string,
  sourceById: ReadonlyMap<string, WorldEntity>,
  accumulator: EntityAccumulator,
): void {
  const openingsByWall = new Map<string, ArchitectureOpening[]>();
  for (const opening of plan.openings) {
    const existing = openingsByWall.get(opening.wallId);
    if (existing === undefined) openingsByWall.set(opening.wallId, [opening]);
    else existing.push(opening);
  }
  let wallPanelOrdinal = 0;
  let windowGlassOrdinal = 0;
  for (const wall of plan.walls) {
    const floor = plan.floors.find((candidate) => candidate.id === wall.floorId);
    if (floor === undefined) throw new Error(`Wall ${wall.id} has no floor.`);
    const nearestSource = sourceById.get(wall.firstSpaceId ?? '') ?? sourceById.get(wall.floorId);
    addEntity(accumulator, {
      id: wall.id,
      kind: 'object',
      name: `${wall.kind[0]?.toUpperCase() ?? ''}${wall.kind.slice(1)} Wall`,
      parentId: wall.floorId,
      provenance: generatedProvenance(
        nearestSource?.provenance,
        'Logical wall generated deterministically from selected room clear-space rectangles.',
      ),
      tags: ['architecture-blockout', 'logical-wall', wall.kind],
      attributes: generatedAttributes(
        'logical-wall',
        planHash,
        containerDirective('Model'),
        wall.floorId,
      ),
    });
    const wallOpenings = [...(openingsByWall.get(wall.id) ?? [])].sort(
      (left, right) => left.offset - right.offset || compareCodePoints(left.id, right.id),
    );
    const panels = decomposeWallPanels(wall, wallOpenings, accumulator.usedIds);
    for (const panel of panels) {
      wallPanelOrdinal += 1;
      const material =
        wall.kind === 'exterior'
          ? plan.building.materials.exteriorWall
          : plan.building.materials.interiorWall;
      const color =
        wall.kind === 'exterior'
          ? plan.building.colors.exteriorWall
          : plan.building.colors.interiorWall;
      addEntity(
        accumulator,
        primitiveGeometryEntity(
          plan,
          panel.id,
          `Wall Panel ${String(wallPanelOrdinal)}`,
          wall.id,
          wallPanelGeometry(wall, panel, floor.finishedFloorElevation),
          material,
          color,
          0,
          true,
          true,
          generatedProvenance(
            nearestSource?.provenance,
            'Invented Roblox-native wall panel generated by subtracting explicit openings.',
          ),
          'wall-panel',
          planHash,
          wall.id,
        ),
      );
      accumulator.primitiveCount += 1;
    }
    for (const value of wallOpenings) {
      addEntity(accumulator, {
        id: value.id,
        kind: 'interaction',
        name: value.type === 'door' ? 'Door Opening' : 'Window Opening',
        parentId: wall.id,
        provenance: generatedProvenance(
          nearestSource?.provenance,
          'Explicit deterministic blockout opening; door openings remain empty in v0.1.',
        ),
        tags: ['architecture-blockout', `${value.type}-opening`],
        attributes: generatedAttributes(
          `${value.type}-opening`,
          planHash,
          containerDirective('Folder'),
          value.sourceId,
        ),
      });
      if (value.type !== 'window') continue;
      windowGlassOrdinal += 1;
      const glassId = generatedId(accumulator, ['window-glass', value.id]);
      addEntity(
        accumulator,
        primitiveGeometryEntity(
          plan,
          glassId,
          `Window Glass ${String(windowGlassOrdinal)}`,
          value.id,
          openingGeometry(wall, value, floor.finishedFloorElevation),
          plan.building.materials.window,
          plan.building.colors.window,
          plan.building.windowTransparency,
          false,
          false,
          generatedProvenance(
            nearestSource?.provenance,
            'Invented non-collidable window-glass blockout generated for an explicit opening.',
          ),
          'window-glass',
          planHash,
          value.id,
        ),
      );
      accumulator.primitiveCount += 1;
    }
  }
}

function addSlabs(
  plan: Readonly<ArchitecturePlan>,
  planHash: string,
  sourceById: ReadonlyMap<string, WorldEntity>,
  accumulator: EntityAccumulator,
): void {
  for (const floor of [...plan.floors].sort(
    (left, right) => left.level - right.level || compareCodePoints(left.id, right.id),
  )) {
    const groupId = generatedId(accumulator, ['slab-group', floor.id]);
    const source = sourceById.get(floor.id);
    addEntity(accumulator, {
      id: groupId,
      kind: 'object',
      name: `Floor Slab Level ${floor.level}`,
      parentId: floor.id,
      provenance: generatedProvenance(
        source?.provenance,
        'Deterministic floor-slab group generated from the selected architectural plan.',
      ),
      tags: ['architecture-blockout', 'slab-group'],
      attributes: generatedAttributes(
        'slab-group',
        planHash,
        containerDirective('Model'),
        floor.id,
      ),
    });

    const arrivingRun = plan.stairRuns.find((run) => run.toFloorId === floor.id);
    const panels =
      floor.level === 0 || floor.stairCore === undefined || arrivingRun === undefined
        ? [{ ...floor.footprint }]
        : buildUpperSlabPanels(floor.footprint, floor.stairCore, arrivingRun.landing.upper);
    panels.forEach((panel, index) => {
      const id = generatedId(accumulator, ['slab-panel', floor.id, String(index + 1)]);
      const localCenter = center(panel);
      addEntity(
        accumulator,
        primitiveGeometryEntity(
          plan,
          id,
          `Slab Panel ${floor.level}-${index + 1}`,
          groupId,
          {
            centerX: localCenter.x,
            centerY: floor.finishedFloorElevation - plan.building.slabThickness / 2,
            centerZ: localCenter.z,
            sizeX: panel.width,
            sizeY: plan.building.slabThickness,
            sizeZ: panel.depth,
            localYaw: 0,
          },
          plan.building.materials.floor,
          plan.building.colors.floor,
          0,
          true,
          true,
          generatedProvenance(
            source?.provenance,
            'Invented anchored floor-slab panel generated from exact rectangle subtraction.',
          ),
          'slab-panel',
          planHash,
          floor.id,
        ),
      );
      accumulator.primitiveCount += 1;
    });
  }
}

function stepGeometry(
  run: Readonly<ArchitectureStairRun>,
  index: number,
  fromElevation: number,
): PrimitiveGeometry {
  const height = run.riserHeight * (index + 1);
  const lower = run.landing.lower;
  switch (run.direction) {
    case 'positive_x':
      return {
        centerX: lower.x + lower.width + run.treadDepth * (index + 0.5),
        centerY: fromElevation + height / 2,
        centerZ: run.core.z + run.core.depth / 2,
        sizeX: run.treadDepth,
        sizeY: height,
        sizeZ: run.clearWidth,
        localYaw: 0,
      };
    case 'negative_x':
      return {
        centerX: lower.x - run.treadDepth * (index + 0.5),
        centerY: fromElevation + height / 2,
        centerZ: run.core.z + run.core.depth / 2,
        sizeX: run.treadDepth,
        sizeY: height,
        sizeZ: run.clearWidth,
        localYaw: 0,
      };
    case 'positive_z':
      return {
        centerX: run.core.x + run.core.width / 2,
        centerY: fromElevation + height / 2,
        centerZ: lower.z + lower.depth + run.treadDepth * (index + 0.5),
        sizeX: run.clearWidth,
        sizeY: height,
        sizeZ: run.treadDepth,
        localYaw: 0,
      };
    case 'negative_z':
      return {
        centerX: run.core.x + run.core.width / 2,
        centerY: fromElevation + height / 2,
        centerZ: lower.z - run.treadDepth * (index + 0.5),
        sizeX: run.clearWidth,
        sizeY: height,
        sizeZ: run.treadDepth,
        localYaw: 0,
      };
  }
}

function addStairs(
  plan: Readonly<ArchitecturePlan>,
  planHash: string,
  sourceById: ReadonlyMap<string, WorldEntity>,
  accumulator: EntityAccumulator,
): void {
  for (const run of plan.stairRuns) {
    const fromFloor = plan.floors.find((floor) => floor.id === run.fromFloorId);
    const toFloor = plan.floors.find((floor) => floor.id === run.toFloorId);
    if (fromFloor === undefined || toFloor === undefined) {
      throw new Error(`Stair run ${run.id} references a missing floor.`);
    }
    const source = sourceById.get(run.sourceStairRouteId);
    addEntity(accumulator, {
      id: run.id,
      kind: 'route',
      name: `Stair Run ${fromFloor.level}-${toFloor.level}`,
      parentId: run.sourceStairRouteId,
      provenance: generatedProvenance(
        source?.provenance,
        'Deterministic straight-run stair blockout; not a claim of building-code compliance.',
      ),
      tags: ['architecture-blockout', 'stair-run'],
      attributes: generatedAttributes(
        'stair-run',
        planHash,
        containerDirective('Model'),
        run.sourceStairRouteId,
      ),
    });
    for (let index = 0; index < run.stepCount; index += 1) {
      const id = generatedId(accumulator, ['stair-step', run.id, String(index + 1)]);
      addEntity(
        accumulator,
        primitiveGeometryEntity(
          plan,
          id,
          `Stair Step ${index + 1}`,
          run.id,
          stepGeometry(run, index, fromFloor.finishedFloorElevation),
          plan.building.materials.stair,
          plan.building.colors.stair,
          0,
          true,
          true,
          generatedProvenance(
            source?.provenance,
            'Invented anchored stair-step blockout generated from bounded riser and tread values.',
          ),
          'stair-step',
          planHash,
          run.id,
        ),
      );
      accumulator.primitiveCount += 1;
    }
  }

  const landings = buildUniqueStairLandingPlacements(
    plan.floors.map((floor) => ({
      floorId: floor.id,
      level: floor.level,
      finishedFloorElevation: floor.finishedFloorElevation,
    })),
    plan.stairRuns,
  );
  for (const landing of landings) {
    const id = generatedId(accumulator, [
      'stair-landing',
      landing.sourceStairRouteId,
      landing.floorId,
      String(landing.rectangle.x),
      String(landing.rectangle.z),
      String(landing.rectangle.width),
      String(landing.rectangle.depth),
    ]);
    const localCenter = center(landing.rectangle);
    const source = sourceById.get(landing.sourceStairRouteId);
    addEntity(
      accumulator,
      primitiveGeometryEntity(
        plan,
        id,
        `Stair Landing Level ${landing.level}`,
        landing.sourceStairRouteId,
        {
          centerX: localCenter.x,
          centerY:
            landing.finishedFloorElevation +
            (landing.aboveCompleteSlab ? 1 : -1) * (plan.building.slabThickness / 2),
          centerZ: localCenter.z,
          sizeX: landing.rectangle.width,
          sizeY: plan.building.slabThickness,
          sizeZ: landing.rectangle.depth,
          localYaw: 0,
        },
        plan.building.materials.stair,
        plan.building.colors.stair,
        0,
        true,
        true,
        generatedProvenance(
          source?.provenance,
          landing.aboveCompleteSlab
            ? 'Invented anchored starting landing placed directly above the complete base slab.'
            : 'Invented anchored arrival landing emitted once inside the subtracted stair core.',
        ),
        'stair-landing',
        planHash,
        landing.sourceStairRouteId,
      ),
    );
    accumulator.primitiveCount += 1;
  }
}

function countWallPanels(
  wall: Readonly<ArchitectureWall>,
  openings: readonly ArchitectureOpening[],
): number {
  const wallLength = wall.end - wall.start;
  const ordered = [...openings].sort(
    (left, right) => left.offset - right.offset || compareCodePoints(left.id, right.id),
  );
  let cursor = 0;
  let count = 0;
  const addPanel = (width: number, height: number): void => {
    if (width > 0 && height > 0) count += 1;
  };

  for (const opening of ordered) {
    const end = opening.offset + opening.width;
    const top = opening.bottom + opening.height;
    if (
      opening.offset < 0 ||
      opening.width <= 0 ||
      end > wallLength ||
      opening.bottom < 0 ||
      opening.height <= 0 ||
      top > wall.height ||
      opening.offset < cursor
    ) {
      throw new Error(`Opening ${opening.id} is outside or overlaps on wall ${wall.id}.`);
    }
    addPanel(opening.offset - cursor, wall.height);
    addPanel(opening.width, opening.bottom);
    addPanel(opening.width, wall.height - top);
    cursor = end;
  }
  addPanel(wallLength - cursor, wall.height);
  return count;
}

function safeCountSum(label: string, values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(total + value)) {
      throw new ArchitectureEmissionCapacityError(
        `${label} arithmetic exceeds the safe non-negative integer range.`,
      );
    }
    total += value;
  }
  return total;
}

export function assertArchitectureEmissionWithinLimits(
  counts: Pick<ArchitectureEmissionCounts, 'generatedEntityCount' | 'primitiveCount'>,
): void {
  if (
    !Number.isSafeInteger(counts.generatedEntityCount) ||
    counts.generatedEntityCount < 0 ||
    !Number.isSafeInteger(counts.primitiveCount) ||
    counts.primitiveCount < 0
  ) {
    throw new ArchitectureEmissionCapacityError(
      'Architecture emission counts must be safe non-negative integers.',
    );
  }
  if (counts.generatedEntityCount > ARCHITECTURE_MAX_GENERATED_ENTITY_COUNT) {
    throw new ArchitectureEmissionCapacityError(
      `Architecture emission would generate ${String(counts.generatedEntityCount)} entities, exceeding the limit ${ARCHITECTURE_MAX_GENERATED_ENTITY_COUNT}.`,
    );
  }
  if (counts.primitiveCount > ARCHITECTURE_MAX_PRIMITIVE_COUNT) {
    throw new ArchitectureEmissionCapacityError(
      `Architecture emission would generate ${String(counts.primitiveCount)} primitives, exceeding the limit ${ARCHITECTURE_MAX_PRIMITIVE_COUNT}.`,
    );
  }
}

function preflightArchitectureEmissionCounts(
  plan: Readonly<ArchitecturePlan>,
): Pick<ArchitectureEmissionCounts, 'generatedEntityCount' | 'primitiveCount'> {
  const openingsByWall = new Map<string, ArchitectureOpening[]>();
  for (const opening of plan.openings) {
    const existing = openingsByWall.get(opening.wallId);
    if (existing === undefined) openingsByWall.set(opening.wallId, [opening]);
    else existing.push(opening);
  }
  const wallPanelCount = safeCountSum(
    'Wall-panel count',
    plan.walls.map((wall) => countWallPanels(wall, openingsByWall.get(wall.id) ?? [])),
  );
  const windowGlassCount = plan.openings.filter((opening) => opening.type === 'window').length;
  const slabPanelCount = safeCountSum(
    'Slab-panel count',
    plan.floors.map((floor) => {
      const arrivingRun = plan.stairRuns.find((run) => run.toFloorId === floor.id);
      return floor.level === 0 || floor.stairCore === undefined || arrivingRun === undefined
        ? 1
        : buildUpperSlabPanels(floor.footprint, floor.stairCore, arrivingRun.landing.upper).length;
    }),
  );
  const stairStepCount = safeCountSum(
    'Stair-step count',
    plan.stairRuns.map((run) => run.stepCount),
  );
  const stairLandingCount = buildUniqueStairLandingPlacements(
    plan.floors.map((floor) => ({
      floorId: floor.id,
      level: floor.level,
      finishedFloorElevation: floor.finishedFloorElevation,
    })),
    plan.stairRuns,
  ).length;
  const primitiveCount = safeCountSum('Primitive count', [
    wallPanelCount,
    windowGlassCount,
    slabPanelCount,
    stairStepCount,
    stairLandingCount,
  ]);
  const generatedEntityCount = safeCountSum('Generated-entity count', [
    plan.spaces.filter((space) => space.type !== 'room').length,
    plan.walls.length,
    wallPanelCount,
    plan.openings.length,
    windowGlassCount,
    plan.floors.length,
    slabPanelCount,
    plan.stairRuns.length,
    stairStepCount,
    stairLandingCount,
  ]);
  const counts = { generatedEntityCount, primitiveCount };
  assertArchitectureEmissionWithinLimits(counts);
  return counts;
}

function buildDerivedWorldSpec(
  source: Readonly<WorldSpec>,
  plan: Readonly<ArchitecturePlan>,
  planHash: string,
): {
  readonly worldSpec: WorldSpec;
  readonly primitiveCount: number;
  readonly generatedCount: number;
} {
  const expectedCounts = preflightArchitectureEmissionCounts(plan);
  const sourceNamespace = new Set<string>([
    source.project.id,
    ...source.references.map((entry) => entry.id),
    ...source.entities.map((entry) => entry.id),
    ...source.relationships.map((entry) => entry.id),
    ...source.constraints.map((entry) => entry.id),
    ...source.locks.map((entry) => entry.id),
  ]);
  const preserved = preserveSourceEntities(source, plan, planHash);
  const accumulator: EntityAccumulator = {
    entities: [],
    usedIds: sourceNamespace,
    primitiveCount: 0,
  };
  const sourceById = new Map(source.entities.map((entity) => [entity.id, entity] as const));
  addSpaceEntities(plan, planHash, sourceById, accumulator);
  addWallsAndOpenings(plan, planHash, sourceById, accumulator);
  addSlabs(plan, planHash, sourceById, accumulator);
  addStairs(plan, planHash, sourceById, accumulator);
  if (
    accumulator.entities.length !== expectedCounts.generatedEntityCount ||
    accumulator.primitiveCount !== expectedCounts.primitiveCount
  ) {
    throw new Error('Architecture emission preflight counts do not match exact expansion counts.');
  }

  const worldSpec: WorldSpec = {
    ...source,
    project: { ...source.project },
    intent: {
      ...source.intent,
      mustHave: [...source.intent.mustHave],
      mustNotHave: [...source.intent.mustNotHave],
      preferences: [...source.intent.preferences],
    },
    references: source.references.map((reference) => ({ ...reference })),
    style: {
      ...source.style,
      architecture: [...source.style.architecture],
      shapeLanguage: [...source.style.shapeLanguage],
      materialFamilies: [...source.style.materialFamilies],
      palette: [...source.style.palette],
      lighting: [...source.style.lighting],
      exclusions: [...source.style.exclusions],
    },
    entities: [...preserved, ...accumulator.entities],
    relationships: source.relationships.map((relationship) => ({
      ...relationship,
      attributes: { ...relationship.attributes },
    })),
    constraints: source.constraints.map((constraint) => ({
      ...constraint,
      subjectIds: [...constraint.subjectIds],
      targetIds: [...constraint.targetIds],
      parameters: { ...constraint.parameters },
    })),
    locks: source.locks.map((lock) => ({ ...lock, fieldPaths: [...lock.fieldPaths] })),
    budgets: {
      ...source.budgets,
      targetDevices: [...source.budgets.targetDevices],
      ...(source.budgets.limits === undefined ? {} : { limits: { ...source.budgets.limits } }),
    },
  };
  return {
    worldSpec,
    primitiveCount: accumulator.primitiveCount,
    generatedCount: accumulator.entities.length,
  };
}

function invalidDiagnostics(message: string): ArchitectureEmissionFailure {
  return {
    success: false,
    diagnostics: [architectureDiagnostic('architecture.emission_invalid', '', message)],
  };
}

/** Converts bounded construction failures into stable public emission diagnostics. */
export function architectureEmissionFailureFromError(error: unknown): ArchitectureEmissionFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ArchitectureGeneratedIdError) {
    return {
      success: false,
      diagnostics: [
        architectureDiagnostic(
          'architecture.generated_id_collision',
          '/entities',
          `Architecture generated-ID emission failed: ${message}`,
        ),
      ],
    };
  }
  if (error instanceof ArchitectureEmissionCapacityError) {
    return {
      success: false,
      diagnostics: [architectureDiagnostic('architecture.capacity_exceeded', '/metrics', message)],
    };
  }
  return invalidDiagnostics(message);
}

/** Emits and compiler-verifies one plan against the exact canonical source it was planned from. */
export function emitArchitectureWorldSpec(
  sourceInput: unknown,
  architecturePlanInput: unknown,
): ArchitectureEmissionResult {
  const sourceResult = validateWorldSpec(sourceInput);
  if (!sourceResult.valid) {
    return {
      success: false,
      diagnostics: sortArchitectureDiagnostics(
        sourceResult.diagnostics.map((entry) =>
          architectureDiagnostic(
            'architecture.worldspec_invalid',
            entry.path,
            `${entry.code}: ${entry.message}`,
            entry.relatedId,
          ),
        ),
      ),
    };
  }
  const planResult = validateArchitecturePlan(architecturePlanInput);
  if (!planResult.valid) return { success: false, diagnostics: planResult.diagnostics };
  const source = normalizeWorldSpec(sourceResult.value);
  const actualSourceHash = sourceHash(source);
  if (actualSourceHash !== planResult.value.source.worldSpecHash) {
    return {
      success: false,
      diagnostics: [
        architectureDiagnostic(
          'architecture.plan_stale',
          '/source/worldSpecHash',
          'Architecture Plan source hash does not match the canonical source WorldSpec.',
          planResult.value.source.buildingEntityId,
        ),
      ],
    };
  }
  const semanticEvaluation = evaluateArchitecturePlan(source, planResult.value);
  if (!semanticEvaluation.valid) {
    return { success: false, diagnostics: semanticEvaluation.diagnostics };
  }
  const plan = semanticEvaluation.value;
  if (
    source.project.id !== plan.source.projectId ||
    source.schemaVersion !== plan.source.worldSpecSchemaVersion
  ) {
    return invalidDiagnostics('Architecture Plan source identity does not match the WorldSpec.');
  }

  try {
    const planHash = hashArchitecturePlan(plan);
    const built = buildDerivedWorldSpec(source, plan, planHash);
    if (
      plan.metrics.estimatedGeneratedWorldSpecEntityCount !== built.worldSpec.entities.length ||
      plan.metrics.estimatedPrimitiveCount !== built.primitiveCount
    ) {
      return {
        success: false,
        diagnostics: [
          architectureDiagnostic(
            'architecture.plan_invalid',
            '/metrics',
            'Architecture Plan emission estimates do not match exact derived entity and primitive counts.',
          ),
        ],
      };
    }
    const instanceLimit = source.budgets.limits?.instances;
    if (instanceLimit !== undefined && built.worldSpec.entities.length > instanceLimit) {
      return {
        success: false,
        diagnostics: [
          architectureDiagnostic(
            'architecture.instance_budget_exceeded',
            '/budgets/limits/instances',
            `Derived WorldSpec requires ${built.worldSpec.entities.length} instances, exceeding budget ${instanceLimit}.`,
          ),
        ],
      };
    }
    const emittedValidation = validateWorldSpec(built.worldSpec);
    if (!emittedValidation.valid) {
      return {
        success: false,
        diagnostics: sortArchitectureDiagnostics(
          emittedValidation.diagnostics.map((entry) =>
            architectureDiagnostic(
              'architecture.emission_invalid',
              entry.path,
              `${entry.code}: ${entry.message}`,
              entry.relatedId,
            ),
          ),
        ),
      };
    }
    const normalized = normalizeWorldSpec(emittedValidation.value);
    const compilation = compileWorldSpecToRobloxManifest(normalized);
    if (!compilation.success) {
      return {
        success: false,
        diagnostics: sortArchitectureDiagnostics(
          compilation.diagnostics.map((entry) =>
            architectureDiagnostic(
              'architecture.emission_invalid',
              entry.path,
              `${entry.code}: ${entry.message}`,
              entry.relatedId,
            ),
          ),
        ),
      };
    }
    const warnings = [
      ...semanticEvaluation.diagnostics,
      ...compilation.diagnostics.map((entry) =>
        architectureDiagnostic(
          'architecture.emission_invalid',
          entry.path,
          `${entry.code}: ${entry.message}`,
          entry.relatedId,
          'warning',
        ),
      ),
    ];
    return {
      success: true,
      worldSpec: normalized,
      manifest: compilation.manifest,
      architecturePlanHash: planHash,
      diagnostics: sortArchitectureDiagnostics(warnings),
    };
  } catch (error: unknown) {
    return architectureEmissionFailureFromError(error);
  }
}

/** Computes exact generated/primitive counts with the same bounded preflight used by emission. */
export function countArchitectureEmissionEntities(
  source: Readonly<WorldSpec>,
  plan: Readonly<ArchitecturePlan>,
): ArchitectureEmissionCounts {
  const counts = preflightArchitectureEmissionCounts(plan);
  return {
    generatedEntityCount: counts.generatedEntityCount,
    primitiveCount: counts.primitiveCount,
    totalDerivedEntityCount: safeCountSum('Derived-entity count', [
      source.entities.length,
      counts.generatedEntityCount,
    ]),
  };
}
