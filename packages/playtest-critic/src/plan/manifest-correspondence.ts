import type {
  ArchitectureOpening,
  ArchitecturePlan,
  ArchitectureRectangle,
  ArchitectureStairRun,
  ArchitectureWall,
} from '@worldwright/architecture-planner';
import { createGeneratedId } from '@worldwright/architecture-planner';
import type { RobloxManagedNode, RobloxManifest } from '@worldwright/roblox-compiler';

import { playtestDiagnostic, type PlaytestDiagnostic } from '../diagnostic.js';
import { compareCodePoints } from '../json.js';

interface ExpectedPart {
  readonly id: string;
  readonly name: string;
  readonly position: Readonly<{ x: number; y: number; z: number }>;
  readonly rotationY: number;
  readonly size: Readonly<{ x: number; y: number; z: number }>;
  readonly material: string;
  readonly color: Readonly<{ r: number; g: number; b: number }>;
  readonly transparency: number;
  readonly canCollide: boolean;
  readonly canTouch: boolean;
  readonly castShadow: boolean;
}

interface WallPanel {
  readonly id: string;
  readonly offset: number;
  readonly width: number;
  readonly bottom: number;
  readonly height: number;
}

function normalizeYaw(value: number): number {
  const normalized = ((value % 360) + 360) % 360;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function worldPoint(
  plan: Readonly<ArchitecturePlan>,
  x: number,
  z: number,
): { readonly x: number; readonly z: number } {
  const origin = plan.building.worldOrigin;
  switch (plan.building.yawDegrees) {
    case 0:
      return { x: origin.x + x, z: origin.z + z };
    case 90:
      return { x: origin.x - z, z: origin.z + x };
    case 180:
      return { x: origin.x - x, z: origin.z - z };
    case 270:
      return { x: origin.x + z, z: origin.z - x };
  }
}

function wallPanels(
  wall: Readonly<ArchitectureWall>,
  openings: readonly ArchitectureOpening[],
): readonly WallPanel[] {
  const ordered = [...openings].sort(
    (left, right) => left.offset - right.offset || compareCodePoints(left.id, right.id),
  );
  const panels: WallPanel[] = [];
  const add = (offset: number, width: number, bottom: number, height: number): void => {
    if (width > 0 && height > 0)
      panels.push({
        id: createGeneratedId([
          'wall-panel',
          wall.id,
          Object.is(offset, -0) ? '0' : String(offset),
          String(width),
          Object.is(bottom, -0) ? '0' : String(bottom),
          String(height),
        ]),
        offset,
        width,
        bottom,
        height,
      });
  };
  let cursor = 0;
  for (const opening of ordered) {
    const top = opening.bottom + opening.height;
    add(cursor, opening.offset - cursor, 0, wall.height);
    add(opening.offset, opening.width, 0, opening.bottom);
    add(opening.offset, opening.width, top, wall.height - top);
    cursor = opening.offset + opening.width;
  }
  add(cursor, wall.end - wall.start - cursor, 0, wall.height);
  return panels.sort((left, right) => compareCodePoints(left.id, right.id));
}

function expectedPart(
  plan: Readonly<ArchitecturePlan>,
  id: string,
  name: string,
  local: Readonly<{
    centerX: number;
    centerY: number;
    centerZ: number;
    sizeX: number;
    sizeY: number;
    sizeZ: number;
    localYaw: number;
  }>,
  appearance: Readonly<{
    material: string;
    color: Readonly<{ r: number; g: number; b: number }>;
    transparency: number;
    canCollide: boolean;
    canTouch: boolean;
    castShadow: boolean;
  }>,
): ExpectedPart {
  const point = worldPoint(plan, local.centerX, local.centerZ);
  return {
    id,
    name,
    position: { x: point.x, y: local.centerY, z: point.z },
    rotationY: normalizeYaw(plan.building.yawDegrees + local.localYaw),
    size: { x: local.sizeX, y: local.sizeY, z: local.sizeZ },
    ...appearance,
  };
}

function wallExpectedParts(
  plan: Readonly<ArchitecturePlan>,
  wall: Readonly<ArchitectureWall>,
  openings: readonly ArchitectureOpening[],
  floorElevation: number,
  firstOrdinal: number,
): readonly ExpectedPart[] {
  const exterior = wall.kind === 'exterior';
  const appearance = {
    material: exterior
      ? plan.building.materials.exteriorWall
      : plan.building.materials.interiorWall,
    color: exterior ? plan.building.colors.exteriorWall : plan.building.colors.interiorWall,
    transparency: 0,
    canCollide: true,
    canTouch: true,
    castShadow: true,
  } as const;
  return wallPanels(wall, openings).map((panel, index) =>
    expectedPart(
      plan,
      panel.id,
      `Wall Panel ${String(firstOrdinal + index)}`,
      wall.axis === 'x'
        ? {
            centerX: wall.start + panel.offset + panel.width / 2,
            centerY: floorElevation + panel.bottom + panel.height / 2,
            centerZ: wall.constant,
            sizeX: panel.width,
            sizeY: panel.height,
            sizeZ: wall.thickness,
            localYaw: 0,
          }
        : {
            centerX: wall.constant,
            centerY: floorElevation + panel.bottom + panel.height / 2,
            centerZ: wall.start + panel.offset + panel.width / 2,
            sizeX: panel.width,
            sizeY: panel.height,
            sizeZ: wall.thickness,
            localYaw: 90,
          },
      appearance,
    ),
  );
}

function windowExpectedPart(
  plan: Readonly<ArchitecturePlan>,
  wall: Readonly<ArchitectureWall>,
  opening: Readonly<ArchitectureOpening>,
  floorElevation: number,
  ordinal: number,
): ExpectedPart {
  const center = wall.start + opening.offset + opening.width / 2;
  const thinDepth = Math.min(wall.thickness, 0.25);
  return expectedPart(
    plan,
    createGeneratedId(['window-glass', opening.id]),
    `Window Glass ${String(ordinal)}`,
    wall.axis === 'x'
      ? {
          centerX: center,
          centerY: floorElevation + opening.bottom + opening.height / 2,
          centerZ: wall.constant,
          sizeX: opening.width,
          sizeY: opening.height,
          sizeZ: thinDepth,
          localYaw: 0,
        }
      : {
          centerX: wall.constant,
          centerY: floorElevation + opening.bottom + opening.height / 2,
          centerZ: center,
          sizeX: opening.width,
          sizeY: opening.height,
          sizeZ: thinDepth,
          localYaw: 90,
        },
    {
      material: plan.building.materials.window,
      color: plan.building.colors.window,
      transparency: plan.building.windowTransparency,
      canCollide: false,
      canTouch: false,
      castShadow: false,
    },
  );
}

function stairStepExpectedPart(
  plan: Readonly<ArchitecturePlan>,
  run: Readonly<ArchitectureStairRun>,
  index: number,
  floorElevation: number,
): ExpectedPart {
  const height = run.riserHeight * (index + 1);
  const lower = run.landing.lower;
  const local = (() => {
    switch (run.direction) {
      case 'positive_x':
        return {
          centerX: lower.x + lower.width + run.treadDepth * (index + 0.5),
          centerY: floorElevation + height / 2,
          centerZ: run.core.z + run.core.depth / 2,
          sizeX: run.treadDepth,
          sizeY: height,
          sizeZ: run.clearWidth,
          localYaw: 0,
        };
      case 'negative_x':
        return {
          centerX: lower.x - run.treadDepth * (index + 0.5),
          centerY: floorElevation + height / 2,
          centerZ: run.core.z + run.core.depth / 2,
          sizeX: run.treadDepth,
          sizeY: height,
          sizeZ: run.clearWidth,
          localYaw: 0,
        };
      case 'positive_z':
        return {
          centerX: run.core.x + run.core.width / 2,
          centerY: floorElevation + height / 2,
          centerZ: lower.z + lower.depth + run.treadDepth * (index + 0.5),
          sizeX: run.clearWidth,
          sizeY: height,
          sizeZ: run.treadDepth,
          localYaw: 0,
        };
      case 'negative_z':
        return {
          centerX: run.core.x + run.core.width / 2,
          centerY: floorElevation + height / 2,
          centerZ: lower.z - run.treadDepth * (index + 0.5),
          sizeX: run.clearWidth,
          sizeY: height,
          sizeZ: run.treadDepth,
          localYaw: 0,
        };
    }
  })();
  return expectedPart(
    plan,
    createGeneratedId(['stair-step', run.id, String(index + 1)]),
    `Stair Step ${String(index + 1)}`,
    local,
    {
      material: plan.building.materials.stair,
      color: plan.building.colors.stair,
      transparency: 0,
      canCollide: true,
      canTouch: true,
      castShadow: true,
    },
  );
}

function landingExpectedPart(
  plan: Readonly<ArchitecturePlan>,
  rectangle: Readonly<ArchitectureRectangle>,
  floorElevation: number,
  aboveCompleteSlab: boolean,
  sourceStairRouteId: string,
  floorId: string,
  level: number,
): ExpectedPart {
  return expectedPart(
    plan,
    createGeneratedId([
      'stair-landing',
      sourceStairRouteId,
      floorId,
      String(rectangle.x),
      String(rectangle.z),
      String(rectangle.width),
      String(rectangle.depth),
    ]),
    `Stair Landing Level ${String(level)}`,
    {
      centerX: rectangle.x + rectangle.width / 2,
      centerY: floorElevation + (aboveCompleteSlab ? 1 : -1) * (plan.building.slabThickness / 2),
      centerZ: rectangle.z + rectangle.depth / 2,
      sizeX: rectangle.width,
      sizeY: plan.building.slabThickness,
      sizeZ: rectangle.depth,
      localYaw: 0,
    },
    {
      material: plan.building.materials.stair,
      color: plan.building.colors.stair,
      transparency: 0,
      canCollide: true,
      canTouch: true,
      castShadow: true,
    },
  );
}

function subtractRectangle(
  outer: Readonly<ArchitectureRectangle>,
  cut: Readonly<ArchitectureRectangle>,
): readonly ArchitectureRectangle[] {
  const x = Math.max(outer.x, cut.x);
  const z = Math.max(outer.z, cut.z);
  const right = Math.min(outer.x + outer.width, cut.x + cut.width);
  const far = Math.min(outer.z + outer.depth, cut.z + cut.depth);
  if (right <= x || far <= z) return [{ ...outer }];
  const pieces: ArchitectureRectangle[] = [];
  const outerRight = outer.x + outer.width;
  const outerFar = outer.z + outer.depth;
  if (z > outer.z) pieces.push({ x: outer.x, z: outer.z, width: outer.width, depth: z - outer.z });
  if (far < outerFar)
    pieces.push({ x: outer.x, z: far, width: outer.width, depth: outerFar - far });
  if (x > outer.x) pieces.push({ x: outer.x, z, width: x - outer.x, depth: far - z });
  if (right < outerRight) pieces.push({ x: right, z, width: outerRight - right, depth: far - z });
  return pieces;
}

function slabExpectedParts(
  plan: Readonly<ArchitecturePlan>,
  floor: Readonly<ArchitecturePlan['floors'][number]>,
): readonly ExpectedPart[] {
  const arrivingRun = plan.stairRuns.find((run) => run.toFloorId === floor.id);
  const panels =
    floor.level === 0 || floor.stairCore === undefined || arrivingRun === undefined
      ? [{ ...floor.footprint }]
      : subtractRectangle(floor.footprint, floor.stairCore);
  return panels.map((panel, index) =>
    expectedPart(
      plan,
      createGeneratedId(['slab-panel', floor.id, String(index + 1)]),
      `Slab Panel ${String(floor.level)}-${String(index + 1)}`,
      {
        centerX: panel.x + panel.width / 2,
        centerY: floor.finishedFloorElevation - plan.building.slabThickness / 2,
        centerZ: panel.z + panel.depth / 2,
        sizeX: panel.width,
        sizeY: plan.building.slabThickness,
        sizeZ: panel.depth,
        localYaw: 0,
      },
      {
        material: plan.building.materials.floor,
        color: plan.building.colors.floor,
        transparency: 0,
        canCollide: true,
        canTouch: true,
        castShadow: true,
      },
    ),
  );
}

function sameVector(
  actual: Readonly<{ x: number; y: number; z: number }>,
  expected: Readonly<{ x: number; y: number; z: number }>,
): boolean {
  return actual.x === expected.x && actual.y === expected.y && actual.z === expected.z;
}

function matchesPart(node: Readonly<RobloxManagedNode>, expected: Readonly<ExpectedPart>): boolean {
  if (node.className !== 'Part' || node.entityKind !== 'object') return false;
  const properties = node.properties;
  return (
    node.id === expected.id &&
    node.name === expected.name &&
    sameVector(properties.position, expected.position) &&
    sameVector(properties.size, expected.size) &&
    properties.rotationEulerDegreesXYZ.x === 0 &&
    properties.rotationEulerDegreesXYZ.y === expected.rotationY &&
    properties.rotationEulerDegreesXYZ.z === 0 &&
    properties.anchored &&
    properties.shape === 'Block' &&
    properties.material === expected.material &&
    properties.color.r === expected.color.r &&
    properties.color.g === expected.color.g &&
    properties.color.b === expected.color.b &&
    properties.transparency === expected.transparency &&
    properties.canCollide === expected.canCollide &&
    properties.canQuery &&
    properties.canTouch === expected.canTouch &&
    properties.castShadow === expected.castShadow
  );
}

function samePartSet(
  actual: readonly RobloxManagedNode[],
  expected: readonly ExpectedPart[],
): boolean {
  if (actual.length !== expected.length) return false;
  const consumed = new Set<number>();
  for (const expectedPart of expected) {
    const index = actual.findIndex(
      (node, candidateIndex) => !consumed.has(candidateIndex) && matchesPart(node, expectedPart),
    );
    if (index < 0) return false;
    consumed.add(index);
  }
  return true;
}

function containerMatches(
  node: Readonly<RobloxManagedNode> | undefined,
  entityKind: RobloxManagedNode['entityKind'],
  className: 'Folder' | 'Model',
  parentId: string | undefined,
  expectedName?: string,
): boolean {
  return (
    node !== undefined &&
    node.entityKind === entityKind &&
    node.className === className &&
    node.parentId === parentId &&
    (expectedName === undefined || node.name === expectedName)
  );
}

function managedIdentityMatches(
  node: Readonly<RobloxManagedNode>,
  projectId: string,
  rootId: string,
  rootSourceHash: string,
): boolean {
  return (
    node.attributes.WorldwrightManaged === true &&
    node.attributes.WorldwrightProjectId === projectId &&
    node.attributes.WorldwrightEntityId === node.id &&
    node.attributes.WorldwrightEntityKind === node.entityKind &&
    node.attributes.WorldwrightCompilerVersion === '0.1.0' &&
    (node.id === rootId
      ? node.attributes.WorldwrightSourceHash === rootSourceHash
      : node.attributes.WorldwrightSourceHash === undefined)
  );
}

function geometryDiagnostic(sourceId: string, message: string): PlaytestDiagnostic {
  return playtestDiagnostic('playtest.geometry_missing', '/nodes', message, sourceId);
}

/**
 * Proves exact structural and primitive geometry correspondence that is derivable from the closed
 * Architecture Plan and Manifest contracts. The authored source WorldSpec itself is intentionally
 * not reconstructed here; its hash and the distinct emitted Manifest source hash are retained by
 * the caller as separate integrity roots.
 */
export function manifestCorrespondenceDiagnostics(
  plan: Readonly<ArchitecturePlan>,
  manifest: Readonly<RobloxManifest>,
): readonly PlaytestDiagnostic[] {
  const diagnostics: PlaytestDiagnostic[] = [];
  const nodes = new Map(manifest.nodes.map((node) => [node.id, node] as const));
  const children = (parentId: string): readonly RobloxManagedNode[] =>
    manifest.nodes.filter((node) => node.parentId === parentId);

  for (const node of manifest.nodes) {
    if (
      !managedIdentityMatches(
        node,
        manifest.source.projectId,
        manifest.rootNodeId,
        manifest.source.worldSpecHash,
      )
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.manifest_structure_mismatch',
          '/nodes',
          'A managed node has substituted ownership or stable identity metadata.',
          node.id,
        ),
      );
    }
  }

  const building = nodes.get(plan.source.buildingEntityId);
  if (
    building === undefined ||
    building.entityKind !== 'structure' ||
    building.className !== 'Model'
  ) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.manifest_structure_mismatch',
        '/nodes',
        'The plan building is not the exact expected Manifest Model container.',
        plan.source.buildingEntityId,
      ),
    );
  }

  const stairRouteIds = [...new Set(plan.stairRuns.map((run) => run.sourceStairRouteId))].sort(
    compareCodePoints,
  );
  const expectedBuildingChildren = [...plan.floors.map((floor) => floor.id), ...stairRouteIds].sort(
    compareCodePoints,
  );
  const actualBuildingChildren = children(plan.source.buildingEntityId)
    .map((node) => node.id)
    .sort(compareCodePoints);
  if (
    expectedBuildingChildren.length !== actualBuildingChildren.length ||
    expectedBuildingChildren.some((id, index) => id !== actualBuildingChildren[index])
  ) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.manifest_structure_mismatch',
        '/nodes',
        'The plan building has substituted or extra direct managed children.',
        plan.source.buildingEntityId,
      ),
    );
  }

  const floorById = new Map(plan.floors.map((floor) => [floor.id, floor] as const));
  for (const floor of plan.floors) {
    if (!containerMatches(nodes.get(floor.id), 'floor', 'Folder', plan.source.buildingEntityId)) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.semantic_node_missing',
          '/nodes',
          'A source floor is not the exact expected Manifest Folder container.',
          floor.id,
        ),
      );
    }
    const knownChildren = new Set([
      ...plan.spaces.filter((space) => space.floorId === floor.id).map((space) => space.id),
      ...plan.walls.filter((wall) => wall.floorId === floor.id).map((wall) => wall.id),
    ]);
    const slabGroupId = createGeneratedId(['slab-group', floor.id]);
    const slabGroups = children(floor.id).filter((node) => !knownChildren.has(node.id));
    const slabGroup = slabGroups[0];
    if (
      slabGroups.length !== 1 ||
      slabGroup === undefined ||
      slabGroup.id !== slabGroupId ||
      slabGroup.name !== `Floor Slab Level ${String(floor.level)}` ||
      slabGroup.entityKind !== 'object' ||
      slabGroup.className !== 'Model'
    ) {
      diagnostics.push(
        geometryDiagnostic(floor.id, 'Floor slab container topology is missing or stale.'),
      );
    } else {
      const slabChildren = children(slabGroup.id);
      if (
        slabChildren.some((node) => node.className !== 'Part') ||
        !samePartSet(slabChildren, slabExpectedParts(plan, floor))
      ) {
        diagnostics.push(
          geometryDiagnostic(
            floor.id,
            'Floor slab support geometry is missing, stale, or substituted.',
          ),
        );
      }
    }
  }
  for (const space of plan.spaces) {
    const expectedKind = space.type === 'room' ? 'room' : 'route';
    const expectedClass = space.type === 'stair_hall' ? 'Model' : 'Folder';
    const floor = floorById.get(space.floorId);
    const expectedName =
      space.type === 'room' || floor === undefined
        ? undefined
        : space.type === 'corridor'
          ? `Corridor Level ${String(floor.level)}`
          : `Stair Hall Level ${String(floor.level)}`;
    if (
      !containerMatches(
        nodes.get(space.id),
        expectedKind,
        expectedClass,
        space.floorId,
        expectedName,
      )
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.semantic_node_missing',
          '/nodes',
          'A source room or circulation space is not the exact expected Manifest container.',
          space.id,
        ),
      );
    }
  }

  let wallPanelOrdinal = 0;
  const windowOrdinalById = new Map<string, number>();
  let windowOrdinal = 0;
  for (const wall of plan.walls) {
    for (const opening of plan.openings
      .filter((candidate) => candidate.wallId === wall.id)
      .sort((left, right) => left.offset - right.offset || compareCodePoints(left.id, right.id))) {
      if (opening.type === 'window') windowOrdinalById.set(opening.id, ++windowOrdinal);
    }
  }
  for (const wall of plan.walls) {
    const node = nodes.get(wall.id);
    const floor = floorById.get(wall.floorId);
    const wallName = `${wall.kind[0]?.toUpperCase() ?? ''}${wall.kind.slice(1)} Wall`;
    if (!containerMatches(node, 'object', 'Model', wall.floorId, wallName) || floor === undefined) {
      diagnostics.push(
        geometryDiagnostic(wall.id, 'A logical wall container is missing or stale.'),
      );
      continue;
    }
    const openings = plan.openings.filter((opening) => opening.wallId === wall.id);
    const wallChildren = children(wall.id);
    const parts = wallChildren.filter((child) => child.className === 'Part');
    const expectedParts = wallExpectedParts(
      plan,
      wall,
      openings,
      floor.finishedFloorElevation,
      wallPanelOrdinal + 1,
    );
    wallPanelOrdinal += expectedParts.length;
    const openingIds = new Set(openings.map((opening) => opening.id));
    if (
      wallChildren.length !== parts.length + openingIds.size ||
      wallChildren.some((child) => child.className !== 'Part' && !openingIds.has(child.id)) ||
      !samePartSet(parts, expectedParts)
    ) {
      diagnostics.push(
        geometryDiagnostic(
          wall.id,
          'A logical wall has stale, missing, or substituted panel geometry.',
        ),
      );
    }
  }

  const wallById = new Map(plan.walls.map((wall) => [wall.id, wall] as const));
  for (const opening of plan.openings) {
    const node = nodes.get(opening.id);
    const wall = wallById.get(opening.wallId);
    const floor = floorById.get(opening.floorId);
    const openingName = opening.type === 'door' ? 'Door Opening' : 'Window Opening';
    if (
      !containerMatches(node, 'interaction', 'Folder', opening.wallId, openingName) ||
      wall === undefined
    ) {
      diagnostics.push(geometryDiagnostic(opening.id, 'An opening container is missing or stale.'));
      continue;
    }
    const openingChildren = children(opening.id);
    const parts = openingChildren.filter((child) => child.className === 'Part');
    const expected =
      opening.type === 'window' && floor !== undefined
        ? [
            windowExpectedPart(
              plan,
              wall,
              opening,
              floor.finishedFloorElevation,
              windowOrdinalById.get(opening.id) ?? 0,
            ),
          ]
        : [];
    if (openingChildren.length !== parts.length || !samePartSet(parts, expected)) {
      diagnostics.push(
        geometryDiagnostic(opening.id, 'An opening has stale, missing, or substituted geometry.'),
      );
    }
  }

  const lowestLevel = Math.min(...plan.floors.map((floor) => floor.level));
  const expectedLandings = new Map<string, ExpectedPart[]>();
  for (const run of plan.stairRuns) {
    const fromFloor = floorById.get(run.fromFloorId);
    const toFloor = floorById.get(run.toFloorId);
    const route = nodes.get(run.sourceStairRouteId);
    if (
      route === undefined ||
      route.entityKind !== 'route' ||
      route.className !== 'Model' ||
      (route.id !== plan.source.buildingEntityId && route.parentId !== plan.source.buildingEntityId)
    ) {
      diagnostics.push(
        geometryDiagnostic(
          run.sourceStairRouteId,
          'A source stair-route container is missing or stale.',
        ),
      );
    }
    if (
      !containerMatches(
        nodes.get(run.id),
        'route',
        'Model',
        run.sourceStairRouteId,
        `Stair Run ${String(fromFloor?.level ?? '')}-${String(toFloor?.level ?? '')}`,
      )
    ) {
      diagnostics.push(geometryDiagnostic(run.id, 'A stair-run container is missing or stale.'));
      continue;
    }
    if (fromFloor === undefined || toFloor === undefined) {
      diagnostics.push(
        geometryDiagnostic(run.id, 'A stair run references missing floor geometry.'),
      );
      continue;
    }
    const expectedSteps = Array.from({ length: run.stepCount }, (_, index) =>
      stairStepExpectedPart(plan, run, index, fromFloor.finishedFloorElevation),
    );
    const runChildren = children(run.id);
    const actualSteps = runChildren.filter((child) => child.className === 'Part');
    if (runChildren.length !== actualSteps.length || !samePartSet(actualSteps, expectedSteps)) {
      diagnostics.push(
        geometryDiagnostic(run.id, 'A stair run has stale, missing, or substituted step geometry.'),
      );
    }
    for (const [floor, rectangle] of [
      [fromFloor, run.landing.lower],
      [toFloor, run.landing.upper],
    ] as const) {
      const values = expectedLandings.get(run.sourceStairRouteId) ?? [];
      const expected = landingExpectedPart(
        plan,
        rectangle,
        floor.finishedFloorElevation,
        floor.level === lowestLevel,
        run.sourceStairRouteId,
        floor.id,
        floor.level,
      );
      if (!values.some((value) => sameVector(value.position, expected.position)))
        values.push(expected);
      expectedLandings.set(run.sourceStairRouteId, values);
    }
  }
  for (const [routeId, expected] of expectedLandings) {
    const routeChildren = children(routeId);
    const runIds = new Set(
      plan.stairRuns.filter((run) => run.sourceStairRouteId === routeId).map((run) => run.id),
    );
    const actual = routeChildren.filter((child) => child.className === 'Part');
    if (
      routeChildren.length !== actual.length + runIds.size ||
      routeChildren.some((child) => child.className !== 'Part' && !runIds.has(child.id)) ||
      !samePartSet(actual, expected)
    ) {
      diagnostics.push(
        geometryDiagnostic(
          routeId,
          'A stair route has stale, missing, or substituted landing geometry.',
        ),
      );
    }
  }

  if (
    manifest.measurements.instances !== plan.metrics.estimatedGeneratedWorldSpecEntityCount ||
    manifest.measurements.primitives !== plan.metrics.estimatedPrimitiveCount ||
    manifest.nodes.length !== plan.metrics.estimatedGeneratedWorldSpecEntityCount
  ) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.manifest_structure_mismatch',
        '/measurements',
        'Manifest counts do not match the exact Architecture Plan emission estimates.',
      ),
    );
  }
  return diagnostics;
}
