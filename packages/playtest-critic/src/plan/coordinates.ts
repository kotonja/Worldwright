import type {
  ArchitectureOpening,
  ArchitecturePlan,
  ArchitectureRectangle,
  ArchitectureSpace,
  ArchitectureStairRun,
  ArchitectureWall,
} from '@worldwright/architecture-planner';

import { PLAYTEST_AGENT_PROFILE, PLAYTEST_CHECKPOINT_SAFE_OFFSET } from '../constants.js';
import type { PlaytestVector3 } from './contract-schema.js';

export interface LocalPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function rectangleCenter(rectangle: Readonly<ArchitectureRectangle>): {
  readonly x: number;
  readonly z: number;
} {
  return { x: rectangle.x + rectangle.width / 2, z: rectangle.z + rectangle.depth / 2 };
}

export function rectangleContainsPoint(
  rectangle: Readonly<ArchitectureRectangle>,
  point: Readonly<{ x: number; z: number }>,
  margin = 0,
): boolean {
  return (
    point.x >= rectangle.x + margin &&
    point.x <= rectangle.x + rectangle.width - margin &&
    point.z >= rectangle.z + margin &&
    point.z <= rectangle.z + rectangle.depth - margin
  );
}

/** The fixed agent must fit around a rectangle's deterministic center on both horizontal axes. */
export function rectangleCenterHasAgentClearance(
  rectangle: Readonly<ArchitectureRectangle>,
): boolean {
  return rectangleContainsPoint(
    rectangle,
    rectangleCenter(rectangle),
    PLAYTEST_AGENT_PROFILE.radius,
  );
}

export function localToWorld(
  plan: Readonly<ArchitecturePlan>,
  point: Readonly<LocalPoint>,
): PlaytestVector3 {
  const origin = plan.building.worldOrigin;
  switch (plan.building.yawDegrees) {
    case 0:
      return { x: origin.x + point.x, y: origin.y + point.y, z: origin.z + point.z };
    case 90:
      return { x: origin.x - point.z, y: origin.y + point.y, z: origin.z + point.x };
    case 180:
      return { x: origin.x - point.x, y: origin.y + point.y, z: origin.z - point.z };
    case 270:
      return { x: origin.x + point.z, y: origin.y + point.y, z: origin.z - point.x };
  }
}

export function rootLocalY(
  plan: Readonly<ArchitecturePlan>,
  finishedFloorElevation: number,
  supportOffset = 0,
): number {
  return (
    finishedFloorElevation +
    supportOffset +
    PLAYTEST_AGENT_PROFILE.rootHeightAboveFinishedFloor -
    plan.building.worldOrigin.y
  );
}

function openingCenter(
  opening: Readonly<ArchitectureOpening>,
  wall: Readonly<ArchitectureWall>,
): { readonly x: number; readonly z: number } {
  const along = wall.start + opening.offset + opening.width / 2;
  return wall.axis === 'x' ? { x: along, z: wall.constant } : { x: wall.constant, z: along };
}

export function openingSidePoint(
  opening: Readonly<ArchitectureOpening>,
  wall: Readonly<ArchitectureWall>,
  space: Readonly<ArchitectureSpace>,
): { readonly x: number; readonly z: number } | undefined {
  const center = openingCenter(opening, wall);
  const distance = wall.thickness / 2 + PLAYTEST_CHECKPOINT_SAFE_OFFSET;
  const candidates =
    wall.axis === 'x'
      ? [
          { x: center.x, z: center.z - distance },
          { x: center.x, z: center.z + distance },
        ]
      : [
          { x: center.x - distance, z: center.z },
          { x: center.x + distance, z: center.z },
        ];
  return candidates.find((candidate) => rectangleContainsPoint(space.rectangle, candidate));
}

export function exteriorOpeningPoint(
  opening: Readonly<ArchitectureOpening>,
  wall: Readonly<ArchitectureWall>,
  entranceRoom: Readonly<ArchitectureSpace>,
): { readonly x: number; readonly z: number } | undefined {
  const center = openingCenter(opening, wall);
  // The emitted slab ends at the exterior wall face. Keep the setup root inside the empty
  // aperture and slab footprint instead of placing it on unsupported exterior ground.
  const distance = Math.max(0, wall.thickness / 2 - 0.25);
  const candidates =
    wall.axis === 'x'
      ? [
          { x: center.x, z: center.z - distance },
          { x: center.x, z: center.z + distance },
        ]
      : [
          { x: center.x - distance, z: center.z },
          { x: center.x + distance, z: center.z },
        ];
  return candidates.find((candidate) => !rectangleContainsPoint(entranceRoom.rectangle, candidate));
}

function intersection(
  left: Readonly<ArchitectureRectangle>,
  right: Readonly<ArchitectureRectangle>,
): ArchitectureRectangle | undefined {
  const x = Math.max(left.x, right.x);
  const z = Math.max(left.z, right.z);
  const maxX = Math.min(left.x + left.width, right.x + right.width);
  const maxZ = Math.min(left.z + left.depth, right.z + right.depth);
  return maxX > x && maxZ > z ? { x, z, width: maxX - x, depth: maxZ - z } : undefined;
}

export function safeStairHallPoint(
  hall: Readonly<ArchitectureSpace>,
  run: Readonly<ArchitectureStairRun>,
  corridorAxis: 'x' | 'z',
  approachPoint?: Readonly<{ x: number; z: number }>,
): { readonly x: number; readonly z: number } | undefined {
  const overlap = intersection(hall.rectangle, run.core);
  if (overlap === undefined) return rectangleCenter(hall.rectangle);
  const approaches = stairHallApproaches(hall, overlap, corridorAxis);
  const approach =
    approachPoint === undefined
      ? approaches.length === 1
        ? approaches[0]
        : undefined
      : approaches.find((candidate) => rectangleContainsPoint(candidate, approachPoint));
  return approach === undefined ? undefined : rectangleCenter(approach);
}

function stairHallApproaches(
  hall: Readonly<ArchitectureSpace>,
  overlap: Readonly<ArchitectureRectangle>,
  corridorAxis: 'x' | 'z',
): readonly ArchitectureRectangle[] {
  const outer = hall.rectangle;
  const candidates =
    corridorAxis === 'x'
      ? [
          { x: outer.x, z: outer.z, width: outer.width, depth: overlap.z - outer.z },
          {
            x: outer.x,
            z: overlap.z + overlap.depth,
            width: outer.width,
            depth: outer.z + outer.depth - overlap.z - overlap.depth,
          },
        ]
      : [
          { x: outer.x, z: outer.z, width: overlap.x - outer.x, depth: outer.depth },
          {
            x: overlap.x + overlap.width,
            z: outer.z,
            width: outer.x + outer.width - overlap.x - overlap.width,
            depth: outer.depth,
          },
        ];
  return candidates.filter(
    (candidate) =>
      candidate.width >= PLAYTEST_AGENT_PROFILE.radius * 2 &&
      candidate.depth >= PLAYTEST_AGENT_PROFILE.radius * 2,
  );
}

export function stairHallApproachContainsPoint(
  hall: Readonly<ArchitectureSpace>,
  run: Readonly<ArchitectureStairRun>,
  corridorAxis: 'x' | 'z',
  point: Readonly<{ x: number; z: number }>,
): boolean {
  const overlap = intersection(hall.rectangle, run.core);
  return (
    overlap !== undefined &&
    stairHallApproaches(hall, overlap, corridorAxis).some((approach) =>
      rectangleContainsPoint(approach, point),
    )
  );
}
