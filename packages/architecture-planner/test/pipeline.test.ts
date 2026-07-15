import { describe, expect, it } from 'vitest';

import {
  ROBLOX_SNAPSHOT_VERSION,
  hashRobloxManifest,
  hashRobloxSnapshot,
  planRobloxChangeSet,
  simulateRobloxChangeSet,
  stringifyRobloxChangeSet,
  stringifyRobloxManifest,
  stringifyRobloxSnapshot,
  type RobloxManifest,
  type RobloxSnapshot,
} from '@worldwright/roblox-compiler';
import {
  normalizeWorldSpec,
  stringifyWorldSpec,
  validateWorldSpec,
  type JsonValue,
  type WorldEntity,
} from '@worldwright/worldspec';

import { validateArchitecturePlan } from '../src/directive-validation.js';
import {
  ARCHITECTURE_MAX_GENERATED_ENTITY_COUNT,
  ARCHITECTURE_MAX_PRIMITIVE_COUNT,
  ArchitectureEmissionCapacityError,
  architectureEmissionFailureFromError,
  assertArchitectureEmissionWithinLimits,
  emitArchitectureWorldSpec,
} from '../src/emit-worldspec.js';
import {
  ARCHITECTURE_IDENTIFIER_PATTERN,
  ARCHITECTURE_IDENTIFIER_MAX_LENGTH,
  ArchitectureGeneratedIdError,
} from '../src/generated-id.js';
import { hashArchitecturePlan } from '../src/hashing.js';
import { stringifyArchitecturePlan } from '../src/normalize.js';
import { validateOpeningIntervals } from '../src/openings.js';
import { planArchitectureWorldSpec } from '../src/planner.js';
import type { ArchitecturePlan, ArchitectureRoomDirective } from '../src/types.js';
import { architectureDirective, clone, loadMansionProgram } from './helpers.js';

interface PlannedPipeline {
  readonly plan: ArchitecturePlan;
  readonly manifest: RobloxManifest;
  readonly worldSpec: ReturnType<typeof normalizeWorldSpec>;
  readonly architecturePlanHash: string;
}

function planAndEmit(source = loadMansionProgram()): PlannedPipeline {
  const planning = planArchitectureWorldSpec(source);
  if (!planning.success) {
    throw new Error(
      `Planning failed: ${planning.diagnostics.map((entry) => entry.code).join(', ')}`,
    );
  }
  const emission = emitArchitectureWorldSpec(source, planning.plan);
  if (!emission.success) {
    throw new Error(
      `Emission failed: ${emission.diagnostics.map((entry) => entry.code).join(', ')}`,
    );
  }
  return {
    plan: planning.plan,
    manifest: emission.manifest,
    worldSpec: emission.worldSpec,
    architecturePlanHash: emission.architecturePlanHash,
  };
}

function emptySnapshot(manifest: Readonly<RobloxManifest>): RobloxSnapshot {
  return {
    schemaVersion: ROBLOX_SNAPSHOT_VERSION,
    projectId: manifest.source.projectId,
    target: manifest.target,
    nodes: [],
    unmanagedRoots: [],
  };
}

function objectValue(
  value: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, JsonValue>>)
    : undefined;
}

function generatedRole(entity: Readonly<WorldEntity>): string | undefined {
  const metadata = objectValue(entity.attributes['worldwright.architecture.generated']);
  return typeof metadata?.role === 'string' ? metadata.role : undefined;
}

interface WorldAxisAlignedBox {
  readonly minimumX: number;
  readonly maximumX: number;
  readonly minimumY: number;
  readonly maximumY: number;
  readonly minimumZ: number;
  readonly maximumZ: number;
}

function worldAxisAlignedBox(entity: Readonly<WorldEntity>): WorldAxisAlignedBox {
  if (entity.transform === undefined || entity.bounds === undefined) {
    throw new Error(`Entity ${entity.id} has no emitted geometry.`);
  }
  const yaw = ((entity.transform.rotationEulerDegrees.y % 360) + 360) % 360;
  const quarterTurn = yaw === 90 || yaw === 270;
  const sizeX = quarterTurn ? entity.bounds.size.z : entity.bounds.size.x;
  const sizeZ = quarterTurn ? entity.bounds.size.x : entity.bounds.size.z;
  return {
    minimumX: entity.transform.position.x - sizeX / 2,
    maximumX: entity.transform.position.x + sizeX / 2,
    minimumY: entity.transform.position.y - entity.bounds.size.y / 2,
    maximumY: entity.transform.position.y + entity.bounds.size.y / 2,
    minimumZ: entity.transform.position.z - sizeZ / 2,
    maximumZ: entity.transform.position.z + sizeZ / 2,
  };
}

function positiveVolumeOverlap(left: WorldAxisAlignedBox, right: WorldAxisAlignedBox): boolean {
  return (
    Math.min(left.maximumX, right.maximumX) > Math.max(left.minimumX, right.minimumX) &&
    Math.min(left.maximumY, right.maximumY) > Math.max(left.minimumY, right.minimumY) &&
    Math.min(left.maximumZ, right.maximumZ) > Math.max(left.minimumZ, right.minimumZ)
  );
}

describe('complete offline mansion pipeline', () => {
  it('plans the same normalized source byte-identically without mutation', () => {
    const source = loadMansionProgram();
    const before = JSON.stringify(source);
    const first = planArchitectureWorldSpec(source);
    const second = planArchitectureWorldSpec(source);
    expect(JSON.stringify(source)).toBe(before);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(stringifyArchitecturePlan(first.plan)).toBe(stringifyArchitecturePlan(second.plan));
    expect(hashArchitecturePlan(first.plan)).toBe(hashArchitecturePlan(second.plan));
    expect(first.plan.metrics).toMatchObject({
      floorCount: 2,
      roomCount: 13,
      requiredAdjacencyTotal: 3,
      requiredAdjacencySatisfied: 3,
      avoidedAdjacencyTotal: 1,
      avoidedAdjacencySatisfied: 1,
      stairRunCount: 1,
      allRoomsReachable: true,
    });
    expect(first.plan.metrics.doorCount).toBeGreaterThanOrEqual(15);
    expect(first.plan.metrics.windowCount).toBeGreaterThanOrEqual(13);
    expect(validateArchitecturePlan(first.plan).valid).toBe(true);
  });

  it('produces an internally complete plan with exact references, geometry, metrics, and score', () => {
    const source = loadMansionProgram();
    const { plan, manifest } = planAndEmit(source);
    const floorById = new Map(plan.floors.map((floor) => [floor.id, floor]));
    const spaceById = new Map(plan.spaces.map((space) => [space.id, space]));
    const wallById = new Map(plan.walls.map((wall) => [wall.id, wall]));
    const openingById = new Map(plan.openings.map((opening) => [opening.id, opening]));
    const stairRunById = new Map(plan.stairRuns.map((run) => [run.id, run]));

    for (const floor of plan.floors) {
      expect(floor.spaceIds).toEqual(
        plan.spaces
          .filter((space) => space.floorId === floor.id)
          .map((space) => space.id)
          .sort(),
      );
      expect(floor.wallIds).toEqual(
        plan.walls
          .filter((wall) => wall.floorId === floor.id)
          .map((wall) => wall.id)
          .sort(),
      );
      expect(floor.openingIds).toEqual(
        plan.openings
          .filter((opening) => opening.floorId === floor.id)
          .map((opening) => opening.id)
          .sort(),
      );
      expect(floor.stairRunIds.every((id) => stairRunById.has(id))).toBe(true);
      const corridorLength =
        plan.building.corridorAxis === 'x' ? floor.corridor.width : floor.corridor.depth;
      const envelopeLength =
        plan.building.corridorAxis === 'x'
          ? plan.building.interiorEnvelope.width
          : plan.building.interiorEnvelope.depth;
      expect(corridorLength).toBe(envelopeLength);
    }

    for (const space of plan.spaces) {
      expect(floorById.has(space.floorId)).toBe(true);
      expect(space.rectangle.width).toBeGreaterThan(0);
      expect(space.rectangle.depth).toBeGreaterThan(0);
      const envelope = plan.building.interiorEnvelope;
      expect(space.rectangle.x).toBeGreaterThanOrEqual(envelope.x);
      expect(space.rectangle.z).toBeGreaterThanOrEqual(envelope.z);
      expect(space.rectangle.x + space.rectangle.width).toBeLessThanOrEqual(
        envelope.x + envelope.width,
      );
      expect(space.rectangle.z + space.rectangle.depth).toBeLessThanOrEqual(
        envelope.z + envelope.depth,
      );
      if (space.type === 'room') {
        expect(openingById.has(space.corridorDoorOpeningId)).toBe(true);
        expect(space.exteriorWallIds.every((id) => wallById.get(id)?.kind === 'exterior')).toBe(
          true,
        );
        expect(space.clearArea).toBe(space.rectangle.width * space.rectangle.depth);
        expect(space.aspectRatio).toBe(
          Math.max(space.rectangle.width, space.rectangle.depth) /
            Math.min(space.rectangle.width, space.rectangle.depth),
        );
      }
    }

    const rooms = plan.spaces.filter((space) => space.type === 'room');
    for (let leftIndex = 0; leftIndex < rooms.length; leftIndex += 1) {
      const left = rooms[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < rooms.length; rightIndex += 1) {
        const right = rooms[rightIndex]!;
        if (left.floorId !== right.floorId) continue;
        const overlaps =
          left.rectangle.x < right.rectangle.x + right.rectangle.width &&
          right.rectangle.x < left.rectangle.x + left.rectangle.width &&
          left.rectangle.z < right.rectangle.z + right.rectangle.depth &&
          right.rectangle.z < left.rectangle.z + left.rectangle.depth;
        expect(overlaps).toBe(false);
      }
    }

    for (const wall of plan.walls) {
      expect(floorById.has(wall.floorId)).toBe(true);
      expect(wall.start).toBeLessThan(wall.end);
      if (wall.firstSpaceId !== undefined) expect(spaceById.has(wall.firstSpaceId)).toBe(true);
      if (wall.secondSpaceId !== undefined) expect(spaceById.has(wall.secondSpaceId)).toBe(true);
      expect(wall.openingIds.every((id) => openingById.get(id)?.wallId === wall.id)).toBe(true);
      expect(
        validateOpeningIntervals(
          wall,
          plan.openings.filter((opening) => opening.wallId === wall.id),
        ),
      ).toBe(true);
    }
    for (const opening of plan.openings) {
      const wall = wallById.get(opening.wallId);
      expect(wall?.floorId).toBe(opening.floorId);
      if (opening.type === 'window') expect(wall?.kind).toBe('exterior');
    }
    for (const run of plan.stairRuns) {
      const from = floorById.get(run.fromFloorId)!;
      const to = floorById.get(run.toFloorId)!;
      expect(to.level).toBe(from.level + 1);
      expect(from.stairCore).toEqual(run.core);
      expect(to.stairCore).toEqual(run.core);
      expect(run.riserHeight).toBeLessThanOrEqual(1);
      expect(run.treadDepth).toBeGreaterThanOrEqual(1);
    }

    const clearRoomArea = rooms.reduce((sum, room) => sum + room.clearArea, 0);
    const corridorArea = plan.spaces
      .filter((space) => space.type === 'corridor')
      .reduce((sum, space) => sum + space.rectangle.width * space.rectangle.depth, 0);
    const stairArea = plan.spaces
      .filter((space) => space.type === 'stair_hall')
      .reduce((sum, space) => sum + space.rectangle.width * space.rectangle.depth, 0);
    const grossOuterArea =
      plan.floors.length * plan.building.outerFootprint.width * plan.building.outerFootprint.depth;
    expect(plan.metrics).toMatchObject({
      floorCount: plan.floors.length,
      roomCount: rooms.length,
      grossOuterArea,
      clearRoomArea,
      corridorArea,
      stairArea,
      doorCount: plan.openings.filter((opening) => opening.type === 'door').length,
      windowCount: plan.openings.filter((opening) => opening.type === 'window').length,
      stairRunCount: plan.stairRuns.length,
      estimatedGeneratedWorldSpecEntityCount: manifest.nodes.length,
    });
    expect(plan.metrics.maximumRoomAspectRatio).toBe(
      Math.max(...rooms.map((room) => room.aspectRatio)),
    );
    expect(plan.metrics.clearAreaEfficiency).toBe(clearRoomArea / grossOuterArea);
    const preferredWindowPenalty = rooms.reduce((sum, room) => {
      const directive = architectureDirective(source, room.id) as ArchitectureRoomDirective;
      const exteriorWallLength =
        plan.building.corridorAxis === 'x' ? room.rectangle.width : room.rectangle.depth;
      const fittingWindowCount = Math.max(
        0,
        Math.floor(
          (exteriorWallLength - 2 * plan.building.openingEndClearance) /
            plan.building.defaultWindowWidth,
        ),
      );
      return sum + Math.max(0, directive.windows.preferred - fittingWindowCount);
    }, 0);
    expect(plan.score.preferredWindows).toBe(preferredWindowPenalty);
    expect(plan.score.total).toBe(
      plan.score.areaDeviation +
        plan.score.aspectRatio +
        plan.score.preferredAdjacency +
        plan.score.preferredWindows +
        plan.score.nearDistance +
        plan.score.zoneOrdering,
    );
  });

  it('saturates large schema-valid soft-area scores consistently across planning and validation', () => {
    const source = loadMansionProgram();
    const largeAreaTarget = 9_007_199_254_740_000;
    for (const entity of source.entities.filter((candidate) => candidate.kind === 'room')) {
      const directive = architectureDirective(source, entity.id) as ArchitectureRoomDirective;
      directive.preferredArea = largeAreaTarget;
      directive.maximumArea = largeAreaTarget;
    }

    const planning = planArchitectureWorldSpec(source);

    expect(planning.success).toBe(true);
    if (!planning.success) return;
    expect(planning.plan.score.areaDeviation).toBe(Number.MAX_SAFE_INTEGER);
    expect(planning.plan.score.total).toBe(Number.MAX_SAFE_INTEGER);
    expect(validateArchitecturePlan(planning.plan).valid).toBe(true);
  });

  it('keeps feasible geometry when room maxima are widened beyond bounded band capacity', () => {
    const source = loadMansionProgram();
    for (const entity of source.entities.filter((candidate) => candidate.kind === 'room')) {
      const directive = architectureDirective(source, entity.id) as ArchitectureRoomDirective;
      directive.maximumArea = 9_007_199_254_740_000;
      directive.maximumAspectRatio = 1_000_000;
    }

    const planning = planArchitectureWorldSpec(source);

    expect(planning.success).toBe(true);
    if (!planning.success) return;
    expect(validateArchitecturePlan(planning.plan).valid).toBe(true);
    expect(planning.plan.metrics.roomCount).toBe(13);
  });

  it('emits deterministically without mutating either source or plan', () => {
    const source = loadMansionProgram();
    const planning = planArchitectureWorldSpec(source);
    expect(planning.success).toBe(true);
    if (!planning.success) return;
    const sourceBefore = JSON.stringify(source);
    const planBefore = stringifyArchitecturePlan(planning.plan);
    const first = emitArchitectureWorldSpec(source, planning.plan);
    const second = emitArchitectureWorldSpec(source, planning.plan);
    expect(JSON.stringify(source)).toBe(sourceBefore);
    expect(stringifyArchitecturePlan(planning.plan)).toBe(planBefore);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(stringifyWorldSpec(first.worldSpec)).toBe(stringifyWorldSpec(second.worldSpec));
    expect(stringifyRobloxManifest(first.manifest)).toBe(stringifyRobloxManifest(second.manifest));
    expect(first.architecturePlanHash).toBe(hashArchitecturePlan(planning.plan));
  });

  it('preserves authored semantics while adding explicit compiler containers', () => {
    const source = normalizeWorldSpec(loadMansionProgram());
    const pipeline = planAndEmit(source);
    const outputById = new Map(pipeline.worldSpec.entities.map((entity) => [entity.id, entity]));
    for (const authored of source.entities) {
      const output = outputById.get(authored.id);
      expect(output).toBeDefined();
      expect(output).toMatchObject({
        id: authored.id,
        kind: authored.kind,
        name: authored.name,
        provenance: authored.provenance,
        tags: authored.tags,
      });
      expect(output?.parentId).toBe(authored.parentId);
      for (const [key, value] of Object.entries(authored.attributes)) {
        expect(output?.attributes[key]).toEqual(value);
      }
      expect(objectValue(output?.attributes['worldwright.roblox'])?.mode).toBe('container');
    }
    expect(pipeline.worldSpec.relationships).toEqual(source.relationships);
    expect(pipeline.worldSpec.constraints).toEqual(source.constraints);
    expect(pipeline.worldSpec.locks).toEqual(source.locks);
  });

  it('emits only strict managed Roblox classes and intended primitive roles', () => {
    const pipeline = planAndEmit();
    expect(validateWorldSpec(pipeline.worldSpec).valid).toBe(true);
    expect(pipeline.manifest.nodes).toHaveLength(pipeline.worldSpec.entities.length);
    expect(
      pipeline.worldSpec.entities.every(
        (entity) => entity.attributes['worldwright.roblox'] !== undefined,
      ),
    ).toBe(true);

    const generated = pipeline.worldSpec.entities.filter(
      (entity) => generatedRole(entity) !== undefined,
    );
    const byRole = (role: string): WorldEntity[] =>
      generated.filter((entity) => generatedRole(entity) === role);
    expect(byRole('wall-panel').length).toBeGreaterThan(0);
    expect(byRole('slab-panel').length).toBeGreaterThan(0);
    expect(byRole('window-glass').length).toBeGreaterThan(0);
    expect(byRole('stair-step').length).toBeGreaterThan(0);
    expect(byRole('stair-landing').length).toBe(pipeline.plan.floors.length);

    for (const entity of [
      ...byRole('wall-panel'),
      ...byRole('slab-panel'),
      ...byRole('stair-step'),
      ...byRole('stair-landing'),
    ]) {
      const directive = objectValue(entity.attributes['worldwright.roblox']);
      expect(directive).toMatchObject({
        mode: 'primitive',
        className: 'Part',
        shape: 'Block',
        canCollide: true,
      });
      expect(entity.provenance.classification).toBe('invented');
    }
    for (const glass of byRole('window-glass')) {
      expect(objectValue(glass.attributes['worldwright.roblox'])).toMatchObject({
        mode: 'primitive',
        className: 'Part',
        material: 'Glass',
        canCollide: false,
      });
    }

    const allowedClasses = new Set(['Folder', 'Model', 'Part', 'WedgePart', 'CornerWedgePart']);
    expect(pipeline.manifest.nodes.every((node) => allowedClasses.has(node.className))).toBe(true);
    for (const node of pipeline.manifest.nodes) {
      if (node.className !== 'Folder' && node.className !== 'Model') {
        expect(node.properties.anchored).toBe(true);
      }
      expect(Object.keys(node.attributes).every((key) => key.startsWith('Worldwright'))).toBe(true);
    }
    expect(stringifyRobloxManifest(pipeline.manifest)).not.toMatch(
      /"className": "(?:LocalScript|ModuleScript|Script)"|https?:\/\/|rbxasset/u,
    );
  });

  it('emits slab panels and unique stair landings without positive-volume overlap', () => {
    const pipeline = planAndEmit();
    const geometry = pipeline.worldSpec.entities.filter((entity) => {
      const role = generatedRole(entity);
      return role === 'slab-panel' || role === 'stair-landing';
    });
    expect(geometry.filter((entity) => generatedRole(entity) === 'stair-landing')).toHaveLength(
      pipeline.plan.floors.length,
    );
    for (let leftIndex = 0; leftIndex < geometry.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < geometry.length; rightIndex += 1) {
        const left = geometry[leftIndex]!;
        const right = geometry[rightIndex]!;
        expect(
          positiveVolumeOverlap(worldAxisAlignedBox(left), worldAxisAlignedBox(right)),
          `${left.id} overlaps ${right.id}`,
        ).toBe(false);
      }
    }
  });

  it('enforces exact generated-entity and primitive expansion caps', () => {
    expect(() =>
      assertArchitectureEmissionWithinLimits({
        generatedEntityCount: ARCHITECTURE_MAX_GENERATED_ENTITY_COUNT + 1,
        primitiveCount: 0,
      }),
    ).toThrow(ArchitectureEmissionCapacityError);
    expect(() =>
      assertArchitectureEmissionWithinLimits({
        generatedEntityCount: 0,
        primitiveCount: ARCHITECTURE_MAX_PRIMITIVE_COUNT + 1,
      }),
    ).toThrow(ArchitectureEmissionCapacityError);
    expect(() =>
      assertArchitectureEmissionWithinLimits({
        generatedEntityCount: ARCHITECTURE_MAX_GENERATED_ENTITY_COUNT,
        primitiveCount: ARCHITECTURE_MAX_PRIMITIVE_COUNT,
      }),
    ).not.toThrow();
  });

  it('maps generated-ID construction failures to the specific emission diagnostic', () => {
    const result = architectureEmissionFailureFromError(
      new ArchitectureGeneratedIdError('forced collision for diagnostic coverage'),
    );
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'architecture.generated_id_collision',
        path: '/entities',
      }),
    ]);
  });

  it('uses valid unique generated IDs and compact plan-integrity metadata', () => {
    const pipeline = planAndEmit();
    const ids = pipeline.worldSpec.entities.map((entity) => entity.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(ARCHITECTURE_IDENTIFIER_PATTERN);
      expect(id.length).toBeLessThanOrEqual(ARCHITECTURE_IDENTIFIER_MAX_LENGTH);
    }
    const generated = pipeline.worldSpec.entities.filter((entity) =>
      entity.id.startsWith('archgen-'),
    );
    expect(generated.length).toBeGreaterThan(0);
    expect(generated.every((entity) => entity.provenance.classification === 'invented')).toBe(true);
    expect(generated.every((entity) => (entity.provenance.notes?.length ?? 0) > 0)).toBe(true);

    const building = pipeline.worldSpec.entities.find(
      (entity) => entity.id === pipeline.plan.source.buildingEntityId,
    )!;
    const resultMetadata = objectValue(building.attributes['worldwright.architecture.result']);
    expect(resultMetadata).toEqual({
      schemaVersion: '0.1.0',
      plannerVersion: '0.1.0',
      sourceWorldSpecHash: pipeline.plan.source.worldSpecHash,
      architecturePlanHash: pipeline.architecturePlanHash,
    });
    expect(resultMetadata).not.toHaveProperty('spaces');
    expect(resultMetadata).not.toHaveProperty('walls');
  });

  it('rejects stale source hashes before emission', () => {
    const source = loadMansionProgram();
    const planning = planArchitectureWorldSpec(source);
    expect(planning.success).toBe(true);
    if (!planning.success) return;
    const changed = clone(source);
    changed.intent.summary = `${changed.intent.summary} changed`;
    const result = emitArchitectureWorldSpec(changed, planning.plan);
    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'architecture.plan_stale',
        path: '/source/worldSpecHash',
      }),
    );
    expect(result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true);
  });

  it('enforces the exact estimated instance budget', () => {
    const baseline = planAndEmit();
    const exact = loadMansionProgram();
    exact.budgets.limits = {
      ...exact.budgets.limits,
      instances: baseline.plan.metrics.estimatedGeneratedWorldSpecEntityCount,
    };
    expect(planArchitectureWorldSpec(exact).success).toBe(true);

    const insufficient = clone(exact);
    insufficient.budgets.limits!.instances =
      baseline.plan.metrics.estimatedGeneratedWorldSpecEntityCount - 1;
    const result = planArchitectureWorldSpec(insufficient);
    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'architecture.instance_budget_exceeded' }),
    );
  });

  it('does not copy arbitrary semantic attributes into Roblox managed attributes', () => {
    const source = loadMansionProgram();
    const foyer = source.entities.find((entity) => entity.id === 'foyer-grand')!;
    foyer.attributes['author.private-note'] = 'semantic only';
    const pipeline = planAndEmit(source);
    const node = pipeline.manifest.nodes.find((candidate) => candidate.id === foyer.id)!;
    expect(node.attributes).not.toHaveProperty('author.private-note');
    expect(
      pipeline.worldSpec.entities.find((entity) => entity.id === foyer.id)?.attributes,
    ).toHaveProperty('author.private-note', 'semantic only');
  });

  it('remains stable when authored entity and relationship arrays are reordered', () => {
    const source = loadMansionProgram();
    const reordered = clone(source);
    reordered.entities.reverse();
    reordered.relationships.reverse();
    const first = planAndEmit(source);
    const second = planAndEmit(reordered);
    expect(stringifyArchitecturePlan(second.plan)).toBe(stringifyArchitecturePlan(first.plan));
    expect(stringifyWorldSpec(second.worldSpec)).toBe(stringifyWorldSpec(first.worldSpec));
    expect(stringifyRobloxManifest(second.manifest)).toBe(stringifyRobloxManifest(first.manifest));
  });

  it('reconciles and purely simulates the complete create-from-empty change set', () => {
    const pipeline = planAndEmit();
    const snapshot = emptySnapshot(pipeline.manifest);
    const first = planRobloxChangeSet(snapshot, pipeline.manifest);
    const second = planRobloxChangeSet(snapshot, pipeline.manifest);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(stringifyRobloxChangeSet(first.changeSet)).toBe(
      stringifyRobloxChangeSet(second.changeSet),
    );
    expect(first.changeSet.operations).toHaveLength(pipeline.manifest.nodes.length);
    expect(first.changeSet.operations.every((operation) => operation.type === 'create')).toBe(true);
    expect(first.changeSet.preconditions.desiredManifestHash).toBe(
      hashRobloxManifest(pipeline.manifest),
    );

    const simulated = simulateRobloxChangeSet(snapshot, first.changeSet);
    expect(simulated.success).toBe(true);
    if (!simulated.success) return;
    expect(stringifyRobloxSnapshot(simulated.snapshot)).toBe(
      stringifyRobloxSnapshot(first.expectedSnapshot),
    );
    expect(hashRobloxSnapshot(simulated.snapshot)).toBe(
      first.changeSet.preconditions.resultSnapshotHash,
    );
  });
});
