import { ARCHITECTURE_MAX_STEPS_PER_RUN } from './entity-directive-schema.js';
import { createGeneratedId } from './generated-id.js';
import type { ArchitectureRectangle, ArchitectureStairRun } from './types.js';

export interface StairFloorInput {
  readonly floorId: string;
  readonly level: number;
  readonly finishedFloorElevation: number;
}

export interface StairRunBuildInput {
  readonly sourceStairRouteId: string;
  readonly floors: readonly StairFloorInput[];
  readonly core: Readonly<ArchitectureRectangle>;
  readonly corridorAxis: 'x' | 'z';
  readonly maximumRiserHeight: number;
  readonly minimumTreadDepth: number;
  readonly usedIds?: ReadonlySet<string>;
}

export interface StairLandingPlacement {
  readonly floorId: string;
  readonly level: number;
  readonly finishedFloorElevation: number;
  readonly sourceStairRouteId: string;
  readonly rectangle: ArchitectureRectangle;
  readonly aboveCompleteSlab: boolean;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function contained(
  inner: Readonly<ArchitectureRectangle>,
  outer: Readonly<ArchitectureRectangle>,
): boolean {
  return (
    inner.x >= outer.x &&
    inner.z >= outer.z &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.z + inner.depth <= outer.z + outer.depth
  );
}

function intersect(
  left: Readonly<ArchitectureRectangle>,
  right: Readonly<ArchitectureRectangle>,
): ArchitectureRectangle | undefined {
  const x = Math.max(left.x, right.x);
  const z = Math.max(left.z, right.z);
  const rightX = Math.min(left.x + left.width, right.x + right.width);
  const farZ = Math.min(left.z + left.depth, right.z + right.depth);
  return rightX > x && farZ > z ? { x, z, width: rightX - x, depth: farZ - z } : undefined;
}

/** Pure orthogonal rectangle subtraction producing at most four non-overlapping rectangles. */
export function subtractRectangle(
  outer: Readonly<ArchitectureRectangle>,
  cut: Readonly<ArchitectureRectangle>,
): readonly ArchitectureRectangle[] {
  if (!(outer.width > 0) || !(outer.depth > 0) || !(cut.width > 0) || !(cut.depth > 0)) {
    throw new Error('Rectangle subtraction requires positive rectangles.');
  }
  const overlap = intersect(outer, cut);
  if (overlap === undefined) return [{ ...outer }];
  const pieces: ArchitectureRectangle[] = [];
  const outerRight = outer.x + outer.width;
  const outerFar = outer.z + outer.depth;
  const overlapRight = overlap.x + overlap.width;
  const overlapFar = overlap.z + overlap.depth;

  if (overlap.z > outer.z) {
    pieces.push({ x: outer.x, z: outer.z, width: outer.width, depth: overlap.z - outer.z });
  }
  if (overlapFar < outerFar) {
    pieces.push({ x: outer.x, z: overlapFar, width: outer.width, depth: outerFar - overlapFar });
  }
  if (overlap.x > outer.x) {
    pieces.push({
      x: outer.x,
      z: overlap.z,
      width: overlap.x - outer.x,
      depth: overlap.depth,
    });
  }
  if (overlapRight < outerRight) {
    pieces.push({
      x: overlapRight,
      z: overlap.z,
      width: outerRight - overlapRight,
      depth: overlap.depth,
    });
  }
  return pieces;
}

export function rectangleArea(rectangle: Readonly<ArchitectureRectangle>): number {
  return rectangle.width * rectangle.depth;
}

function landings(
  core: Readonly<ArchitectureRectangle>,
  corridorAxis: 'x' | 'z',
  landingDepth: number,
  positive: boolean,
): { readonly lower: ArchitectureRectangle; readonly upper: ArchitectureRectangle } {
  if (corridorAxis === 'x') {
    const negativeLanding = { x: core.x, z: core.z, width: landingDepth, depth: core.depth };
    const positiveLanding = {
      x: core.x + core.width - landingDepth,
      z: core.z,
      width: landingDepth,
      depth: core.depth,
    };
    return positive
      ? { lower: negativeLanding, upper: positiveLanding }
      : { lower: positiveLanding, upper: negativeLanding };
  }
  const negativeLanding = { x: core.x, z: core.z, width: core.width, depth: landingDepth };
  const positiveLanding = {
    x: core.x,
    z: core.z + core.depth - landingDepth,
    width: core.width,
    depth: landingDepth,
  };
  return positive
    ? { lower: negativeLanding, upper: positiveLanding }
    : { lower: positiveLanding, upper: negativeLanding };
}

/** Builds aligned, deterministic straight stair runs for every adjacent floor pair. */
export function buildStairRuns(
  input: Readonly<StairRunBuildInput>,
): readonly ArchitectureStairRun[] {
  if (input.maximumRiserHeight <= 0 || input.minimumTreadDepth <= 0) {
    throw new Error('Stair limits must be positive.');
  }
  const floors = [...input.floors].sort(
    (left, right) => left.level - right.level || compareCodePoints(left.floorId, right.floorId),
  );
  const used = new Set(input.usedIds);
  const runs: ArchitectureStairRun[] = [];
  const runLength = input.corridorAxis === 'x' ? input.core.width : input.core.depth;
  const clearWidth = input.corridorAxis === 'x' ? input.core.depth : input.core.width;
  const landingDepth = Math.max(input.minimumTreadDepth, Math.min(runLength / 4, 2));

  for (let index = 0; index + 1 < floors.length; index += 1) {
    const from = floors[index];
    const to = floors[index + 1];
    if (from === undefined || to === undefined || to.level !== from.level + 1) {
      throw new Error('Stair floors must be contiguous.');
    }
    const rise = to.finishedFloorElevation - from.finishedFloorElevation;
    if (!Number.isFinite(rise) || rise <= 0) {
      throw new Error(`A straight stair run does not fit from ${from.floorId} to ${to.floorId}.`);
    }
    const stepCount = Math.ceil(rise / input.maximumRiserHeight);
    if (
      !Number.isSafeInteger(stepCount) ||
      stepCount <= 0 ||
      stepCount > ARCHITECTURE_MAX_STEPS_PER_RUN
    ) {
      throw new Error(
        `A straight stair run may contain at most ${ARCHITECTURE_MAX_STEPS_PER_RUN} steps.`,
      );
    }
    const availableRunLength = runLength - landingDepth * 2;
    const riserHeight = rise / stepCount;
    const treadDepth = availableRunLength / stepCount;
    if (
      !Number.isFinite(riserHeight) ||
      riserHeight <= 0 ||
      riserHeight > input.maximumRiserHeight ||
      !Number.isFinite(treadDepth) ||
      treadDepth < input.minimumTreadDepth ||
      clearWidth <= 0
    ) {
      throw new Error(`A straight stair run does not fit from ${from.floorId} to ${to.floorId}.`);
    }
    const positive = index % 2 === 0;
    const landing = landings(input.core, input.corridorAxis, landingDepth, positive);
    if (!contained(landing.lower, input.core) || !contained(landing.upper, input.core)) {
      throw new Error('Stair landing escaped its core.');
    }
    const id = createGeneratedId(
      ['stair-run', input.sourceStairRouteId, from.floorId, to.floorId],
      used,
    );
    used.add(id);
    runs.push({
      id,
      sourceStairRouteId: input.sourceStairRouteId,
      fromFloorId: from.floorId,
      toFloorId: to.floorId,
      core: { ...input.core },
      direction:
        input.corridorAxis === 'x'
          ? positive
            ? 'positive_x'
            : 'negative_x'
          : positive
            ? 'positive_z'
            : 'negative_z',
      stepCount,
      riserHeight,
      treadDepth,
      clearWidth,
      landing,
    });
  }
  return runs;
}

function landingKey(floorId: string, rectangle: Readonly<ArchitectureRectangle>): string {
  return JSON.stringify([floorId, rectangle.x, rectangle.z, rectangle.width, rectangle.depth]);
}

/** Returns one deterministic landing placement for each distinct floor-space rectangle. */
export function buildUniqueStairLandingPlacements(
  floorsInput: readonly StairFloorInput[],
  runsInput: readonly ArchitectureStairRun[],
): readonly StairLandingPlacement[] {
  const floors = [...floorsInput].sort(
    (left, right) => left.level - right.level || compareCodePoints(left.floorId, right.floorId),
  );
  const floorById = new Map(floors.map((floor) => [floor.floorId, floor] as const));
  const lowestLevel = floors[0]?.level;
  const placements = new Map<string, StairLandingPlacement>();
  const runs = [...runsInput].sort((left, right) => compareCodePoints(left.id, right.id));

  for (const run of runs) {
    const entries = [
      { floorId: run.fromFloorId, rectangle: run.landing.lower },
      { floorId: run.toFloorId, rectangle: run.landing.upper },
    ] as const;
    for (const entry of entries) {
      const floor = floorById.get(entry.floorId);
      if (floor === undefined) {
        throw new Error(`Stair run ${run.id} references a missing floor.`);
      }
      const key = landingKey(floor.floorId, entry.rectangle);
      const existing = placements.get(key);
      if (existing !== undefined && existing.sourceStairRouteId !== run.sourceStairRouteId) {
        throw new Error(
          `Distinct stair routes claim the same landing rectangle on ${floor.floorId}.`,
        );
      }
      if (existing !== undefined) continue;
      placements.set(key, {
        floorId: floor.floorId,
        level: floor.level,
        finishedFloorElevation: floor.finishedFloorElevation,
        sourceStairRouteId: run.sourceStairRouteId,
        rectangle: { ...entry.rectangle },
        aboveCompleteSlab: floor.level === lowestLevel,
      });
    }
  }

  return [...placements.values()].sort(
    (left, right) =>
      left.level - right.level ||
      compareCodePoints(left.floorId, right.floorId) ||
      left.rectangle.x - right.rectangle.x ||
      left.rectangle.z - right.rectangle.z ||
      left.rectangle.width - right.rectangle.width ||
      left.rectangle.depth - right.rectangle.depth ||
      compareCodePoints(left.sourceStairRouteId, right.sourceStairRouteId),
  );
}

/** Returns upper-floor slab panels after the full stair core is subtracted. */
export function buildUpperSlabPanels(
  footprint: Readonly<ArchitectureRectangle>,
  stairCore: Readonly<ArchitectureRectangle>,
  retainedLanding: Readonly<ArchitectureRectangle>,
): readonly ArchitectureRectangle[] {
  if (!contained(stairCore, footprint) || !contained(retainedLanding, stairCore)) {
    throw new Error('Stair opening or landing is outside the floor footprint.');
  }
  return subtractRectangle(footprint, stairCore).filter(
    (panel) => panel.width > 0 && panel.depth > 0,
  );
}
