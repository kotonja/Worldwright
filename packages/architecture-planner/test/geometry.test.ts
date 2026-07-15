import { describe, expect, it } from 'vitest';

import { buildCirculationEdges, evaluateCirculation } from '../src/circulation.js';
import { ARCHITECTURE_MAX_STEPS_PER_RUN } from '../src/entity-directive-schema.js';
import { buildOpenings, validateOpeningIntervals } from '../src/openings.js';
import {
  buildStairRuns,
  buildUniqueStairLandingPlacements,
  buildUpperSlabPanels,
  rectangleArea,
  subtractRectangle,
} from '../src/stairs.js';
import { buildLogicalWalls, decomposeWallPanels, wallPanelArea } from '../src/walls.js';
import type {
  ArchitectureOpening,
  ArchitectureRectangle,
  ArchitectureSpace,
  ArchitectureStairRun,
} from '../src/types.js';
import {
  makeCorridorSpace,
  makeOpening,
  makeRoomSpace,
  makeStairHallSpace,
  makeWall,
} from './helpers.js';

function rectanglesOverlap(
  left: Readonly<ArchitectureRectangle>,
  right: Readonly<ArchitectureRectangle>,
): boolean {
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.z < right.z + right.depth &&
    right.z < left.z + left.depth
  );
}

function testFloorSpaces(): ArchitectureSpace[] {
  return [
    makeRoomSpace(
      'room-a',
      'floor-ground',
      { x: 0, z: 0, width: 10, depth: 7 },
      {
        isEntrance: true,
      },
    ),
    makeRoomSpace('room-b', 'floor-ground', { x: 11, z: 0, width: 9, depth: 7 }),
    makeCorridorSpace('archgen-corridor-ground', 'floor-ground', {
      x: 0,
      z: 8,
      width: 20,
      depth: 4,
    }),
    makeRoomSpace('room-c', 'floor-ground', { x: 0, z: 13, width: 10, depth: 7 }),
    makeRoomSpace('room-d', 'floor-ground', { x: 11, z: 13, width: 9, depth: 7 }),
  ];
}

function buildTestWalls(spaces = testFloorSpaces()) {
  return buildLogicalWalls({
    floorId: 'floor-ground',
    spaces,
    interiorEnvelope: { x: 0, z: 0, width: 20, depth: 20 },
    corridorAxis: 'x',
    exteriorWallThickness: 1,
    interiorWallThickness: 1,
    wallHeight: 10,
  });
}

describe('logical walls and wall-panel subtraction', () => {
  it('builds canonical, unique walls with exact room exterior references', () => {
    const result = buildTestWalls();
    expect(result.walls).toHaveLength(16);
    expect(new Set(result.walls.map((wall) => wall.id)).size).toBe(result.walls.length);
    expect(result.walls.every((wall) => wall.start < wall.end)).toBe(true);
    expect(result.walls.map((wall) => wall.id)).toEqual(
      [...result.walls.map((wall) => wall.id)].sort(),
    );
    for (const roomId of ['room-a', 'room-b', 'room-c', 'room-d']) {
      expect(result.roomExteriorWallIds[roomId]).toHaveLength(2);
    }
  });

  it('rejects unexplained gaps in a room band', () => {
    const spaces = testFloorSpaces();
    const roomB = spaces.find((space) => space.id === 'room-b')!;
    roomB.rectangle.x = 12;
    roomB.rectangle.width = 8;
    expect(() => buildTestWalls(spaces)).toThrow(/Unexplained room-band gap/u);
  });

  it('subtracts a door into non-overlapping wall panels with exact area', () => {
    const wall = makeWall();
    const opening = makeOpening();
    const panels = decomposeWallPanels(wall, [opening]);
    expect(wallPanelArea(panels)).toBe(20 * 10 - 4 * 7);
    expect(new Set(panels.map((panel) => panel.id)).size).toBe(panels.length);
    for (let left = 0; left < panels.length; left += 1) {
      for (let right = left + 1; right < panels.length; right += 1) {
        const a = panels[left]!;
        const b = panels[right]!;
        expect(
          rectanglesOverlap(
            { x: a.offset, z: a.bottom, width: a.width, depth: a.height },
            { x: b.offset, z: b.bottom, width: b.width, depth: b.height },
          ),
        ).toBe(false);
      }
    }
  });

  it('emits lower and upper panels around a window and rejects overlap', () => {
    const wall = makeWall();
    const window = makeOpening({ type: 'window', offset: 4, width: 5, bottom: 2, height: 4 });
    const panels = decomposeWallPanels(wall, [window]);
    expect(panels.some((panel) => panel.bottom === 0 && panel.height === 2)).toBe(true);
    expect(panels.some((panel) => panel.bottom === 6 && panel.height === 4)).toBe(true);
    expect(wallPanelArea(panels)).toBe(20 * 10 - 5 * 4);
    expect(() =>
      decomposeWallPanels(wall, [
        window,
        makeOpening({ id: 'archgen-opening-overlap', offset: 8, width: 4 }),
      ]),
    ).toThrow(/outside or overlaps/u);
  });
});

describe('explicit opening construction', () => {
  it('places corridor, entrance, room-divider, and exterior window openings', () => {
    const spaces = testFloorSpaces();
    const wallResult = buildTestWalls(spaces);
    const result = buildOpenings({
      floorId: 'floor-ground',
      spaces,
      walls: wallResult.walls,
      roomRequirements: [
        { roomId: 'room-a', doorWidth: 3, minimumWindows: 1, preferredWindows: 3 },
        { roomId: 'room-b', doorWidth: 3, minimumWindows: 1, preferredWindows: 1 },
        { roomId: 'room-c', doorWidth: 3, minimumWindows: 1, preferredWindows: 1 },
        { roomId: 'room-d', doorWidth: 3, minimumWindows: 1, preferredWindows: 1 },
      ],
      doorAdjacencies: [
        {
          relationshipId: 'relationship-a-b',
          fromRoomId: 'room-a',
          toRoomId: 'room-b',
          requirement: 'required',
          connection: 'door',
        },
      ],
      entranceRoomId: 'room-a',
      exteriorEntranceNodeId: 'archgen-exterior-entrance',
      corridorAxis: 'x',
      entranceEnd: 'negative',
      defaultDoorWidth: 3,
      defaultDoorHeight: 7,
      defaultWindowWidth: 4,
      defaultWindowHeight: 4,
      defaultWindowSillHeight: 3,
      openingEndClearance: 1,
    });

    expect(result.openings.filter((opening) => opening.type === 'door')).toHaveLength(6);
    expect(result.openings.filter((opening) => opening.type === 'window')).toHaveLength(5);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'architecture.preference_unsatisfied',
        roomId: 'room-a',
      }),
    ]);
    expect(Object.keys(result.corridorDoorIds).sort()).toEqual([
      'room-a',
      'room-b',
      'room-c',
      'room-d',
    ]);
    for (const wall of result.walls) {
      const openings = result.openings.filter((opening) => opening.wallId === wall.id);
      expect(validateOpeningIntervals(wall, openings)).toBe(true);
      expect(wall.openingIds).toEqual(openings.map((opening) => opening.id).sort());
    }
  });

  it('fails required openings that do not fit and warns for a missing preferred divider', () => {
    const spaces = testFloorSpaces();
    const wallResult = buildTestWalls(spaces);
    const base = {
      floorId: 'floor-ground',
      spaces,
      walls: wallResult.walls,
      roomRequirements: [
        { roomId: 'room-a', doorWidth: 3, minimumWindows: 1, preferredWindows: 1 },
      ],
      doorAdjacencies: [],
      exteriorEntranceNodeId: 'archgen-exterior-entrance',
      corridorAxis: 'x' as const,
      entranceEnd: 'negative' as const,
      defaultDoorWidth: 3,
      defaultDoorHeight: 7,
      defaultWindowWidth: 4,
      defaultWindowHeight: 4,
      defaultWindowSillHeight: 3,
      openingEndClearance: 1,
    };
    expect(() =>
      buildOpenings({
        ...base,
        roomRequirements: [
          { roomId: 'room-a', doorWidth: 3, minimumWindows: 3, preferredWindows: 3 },
        ],
      }),
    ).toThrow(/Minimum windows do not fit/u);

    const preferred = buildOpenings({
      ...base,
      doorAdjacencies: [
        {
          relationshipId: 'relationship-a-c',
          fromRoomId: 'room-a',
          toRoomId: 'room-c',
          requirement: 'preferred',
          connection: 'door',
        },
      ],
    });
    expect(preferred.warnings).toContainEqual(
      expect.objectContaining({ code: 'architecture.preference_unsatisfied' }),
    );
  });

  it('detects invalid opening intervals', () => {
    const wall = makeWall();
    expect(
      validateOpeningIntervals(wall, [
        makeOpening({ offset: 2, width: 6 }),
        makeOpening({ id: 'archgen-second', offset: 7, width: 3 }),
      ]),
    ).toBe(false);
  });
});

describe('slab rectangle subtraction and aligned straight stairs', () => {
  it('subtracts a rectangle into bounded non-overlapping pieces with exact area', () => {
    const outer = { x: 0, z: 0, width: 10, depth: 8 };
    const cut = { x: 2, z: 2, width: 4, depth: 3 };
    const pieces = subtractRectangle(outer, cut);
    expect(pieces.reduce((sum, piece) => sum + rectangleArea(piece), 0)).toBe(68);
    for (let left = 0; left < pieces.length; left += 1) {
      for (let right = left + 1; right < pieces.length; right += 1) {
        expect(rectanglesOverlap(pieces[left]!, pieces[right]!)).toBe(false);
      }
    }
  });

  it('builds one deterministic straight run for each adjacent floor pair', () => {
    const runs = buildStairRuns({
      sourceStairRouteId: 'stair-main',
      floors: [
        { floorId: 'floor-upper', level: 1, finishedFloorElevation: 20 },
        { floorId: 'floor-ground', level: 0, finishedFloorElevation: 0 },
      ],
      core: { x: 5, z: 10, width: 30, depth: 10 },
      corridorAxis: 'x',
      maximumRiserHeight: 1,
      minimumTreadDepth: 1,
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      fromFloorId: 'floor-ground',
      toFloorId: 'floor-upper',
      direction: 'positive_x',
      stepCount: 20,
      riserHeight: 1,
      clearWidth: 10,
    });
    expect(runs[0]!.treadDepth).toBe(1.3);
    expect(runs[0]!.landing.lower).not.toEqual(runs[0]!.landing.upper);
  });

  it('builds two aligned runs with alternating directions for three floors', () => {
    const core = { x: 5, z: 10, width: 30, depth: 10 };
    const runs = buildStairRuns({
      sourceStairRouteId: 'stair-main',
      floors: [
        { floorId: 'floor-ground', level: 0, finishedFloorElevation: 0 },
        { floorId: 'floor-upper', level: 1, finishedFloorElevation: 20 },
        { floorId: 'floor-third', level: 2, finishedFloorElevation: 40 },
      ],
      core,
      corridorAxis: 'x',
      maximumRiserHeight: 1,
      minimumTreadDepth: 1,
    });
    expect(runs.map((run) => run.direction)).toEqual(['positive_x', 'negative_x']);
    expect(runs.every((run) => JSON.stringify(run.core) === JSON.stringify(core))).toBe(true);
    expect(runs.every((run) => run.riserHeight <= 1 && run.treadDepth >= 1)).toBe(true);

    const placements = buildUniqueStairLandingPlacements(
      [
        { floorId: 'floor-ground', level: 0, finishedFloorElevation: 0 },
        { floorId: 'floor-upper', level: 1, finishedFloorElevation: 20 },
        { floorId: 'floor-third', level: 2, finishedFloorElevation: 40 },
      ],
      runs,
    );
    expect(placements).toHaveLength(3);
    expect(placements.map((placement) => placement.floorId)).toEqual([
      'floor-ground',
      'floor-upper',
      'floor-third',
    ]);
    expect(placements.filter((placement) => placement.floorId === 'floor-upper')).toHaveLength(1);
    expect(placements.map((placement) => placement.aboveCompleteSlab)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('leaves the full stair core clear of upper slab panels for a separate arrival landing', () => {
    const footprint = { x: 0, z: 0, width: 40, depth: 30 };
    const core = { x: 5, z: 10, width: 30, depth: 10 };
    const landing = { x: 33, z: 10, width: 2, depth: 10 };
    const panels = buildUpperSlabPanels(footprint, core, landing);
    expect(panels.reduce((sum, panel) => sum + rectangleArea(panel), 0)).toBe(
      rectangleArea(footprint) - rectangleArea(core),
    );
    expect(panels.some((panel) => rectanglesOverlap(panel, landing))).toBe(false);
  });

  it('rejects a stair run above the practical step expansion cap', () => {
    expect(() =>
      buildStairRuns({
        sourceStairRouteId: 'stair-main',
        floors: [
          { floorId: 'floor-ground', level: 0, finishedFloorElevation: 0 },
          {
            floorId: 'floor-upper',
            level: 1,
            finishedFloorElevation: ARCHITECTURE_MAX_STEPS_PER_RUN + 1,
          },
        ],
        core: {
          x: 0,
          z: 0,
          width: (ARCHITECTURE_MAX_STEPS_PER_RUN + 1) * 2 + 4,
          depth: 8,
        },
        corridorAxis: 'x',
        maximumRiserHeight: 1,
        minimumTreadDepth: 1,
      }),
    ).toThrow(new RegExp(`at most ${String(ARCHITECTURE_MAX_STEPS_PER_RUN)} steps`, 'u'));
  });

  it('rejects a stair core too short for the required treads', () => {
    expect(() =>
      buildStairRuns({
        sourceStairRouteId: 'stair-main',
        floors: [
          { floorId: 'floor-ground', level: 0, finishedFloorElevation: 0 },
          { floorId: 'floor-upper', level: 1, finishedFloorElevation: 20 },
        ],
        core: { x: 0, z: 0, width: 10, depth: 8 },
        corridorAxis: 'x',
        maximumRiserHeight: 1,
        minimumTreadDepth: 1,
      }),
    ).toThrow(/does not fit/u);
  });
});

describe('explicit circulation graph', () => {
  function circulationFixture(): {
    readonly spaces: ArchitectureSpace[];
    readonly openings: ArchitectureOpening[];
    readonly stairRuns: readonly ArchitectureStairRun[];
  } {
    const spaces: ArchitectureSpace[] = [
      makeRoomSpace('room-ground', 'floor-ground', { x: 0, z: 0, width: 8, depth: 8 }),
      makeCorridorSpace('archgen-corridor-ground', 'floor-ground', {
        x: 0,
        z: 8,
        width: 20,
        depth: 4,
      }),
      makeStairHallSpace('archgen-stair-hall-ground', 'floor-ground', {
        x: 12,
        z: 0,
        width: 8,
        depth: 8,
      }),
      makeRoomSpace('room-upper', 'floor-upper', { x: 0, z: 0, width: 8, depth: 8 }),
      makeCorridorSpace('archgen-corridor-upper', 'floor-upper', {
        x: 0,
        z: 8,
        width: 20,
        depth: 4,
      }),
      makeStairHallSpace('archgen-stair-hall-upper', 'floor-upper', {
        x: 12,
        z: 0,
        width: 8,
        depth: 8,
      }),
    ];
    const pairs = [
      ['archgen-exterior-entrance', 'room-ground'],
      ['room-ground', 'archgen-corridor-ground'],
      ['archgen-corridor-ground', 'archgen-stair-hall-ground'],
      ['room-upper', 'archgen-corridor-upper'],
      ['archgen-corridor-upper', 'archgen-stair-hall-upper'],
    ] as const;
    const openings = pairs.map(([fromNodeId, toNodeId], index) =>
      makeOpening({
        id: `archgen-circulation-opening-${index + 1}`,
        fromNodeId,
        toNodeId,
      }),
    );
    const stairRuns = buildStairRuns({
      sourceStairRouteId: 'stair-main',
      floors: [
        { floorId: 'floor-ground', level: 0, finishedFloorElevation: 0 },
        { floorId: 'floor-upper', level: 1, finishedFloorElevation: 20 },
      ],
      core: { x: 0, z: 0, width: 30, depth: 10 },
      corridorAxis: 'x',
      maximumRiserHeight: 1,
      minimumTreadDepth: 1,
    });
    return { spaces, openings, stairRuns };
  }

  it('derives edges only from openings and stair runs and reaches every room', () => {
    const fixture = circulationFixture();
    const edges = buildCirculationEdges(fixture);
    expect(edges).toHaveLength(fixture.openings.length + fixture.stairRuns.length);
    expect(edges.filter((edge) => edge.traversal === 'stair')).toHaveLength(1);
    expect(edges.filter((edge) => edge.traversal === 'open')).toHaveLength(2);
    const evaluation = evaluateCirculation('archgen-exterior-entrance', fixture.spaces, edges);
    expect(evaluation.allRoomsReachable).toBe(true);
    expect(evaluation.allRequiredNodesReachable).toBe(true);
    expect(evaluation.unreachableNodeIds).toEqual([]);
  });

  it('reports an upper room unreachable when its explicit door edge is removed', () => {
    const fixture = circulationFixture();
    const edges = buildCirculationEdges({
      ...fixture,
      openings: fixture.openings.filter(
        (opening) => !(opening.fromNodeId === 'room-upper' || opening.toNodeId === 'room-upper'),
      ),
    });
    const evaluation = evaluateCirculation('archgen-exterior-entrance', fixture.spaces, edges);
    expect(evaluation.allRoomsReachable).toBe(false);
    expect(evaluation.unreachableNodeIds).toContain('room-upper');
  });
});
