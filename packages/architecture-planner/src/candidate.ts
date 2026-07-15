import { createHash } from 'node:crypto';

import type { ArchitecturePlanScore, ArchitectureRectangle } from './plan-schema.js';
import type { ArchitectureSourceProfile } from './source-profile.js';

export type ArchitectureCorridorAxis = 'x' | 'z';
export type ArchitectureBandSide = 'negative' | 'positive';

export interface ArchitectureGridRectangle {
  /** Cell offset from the outer footprint's local minimum-X edge. */
  readonly x: number;
  /** Cell offset from the outer footprint's local minimum-Z edge. */
  readonly z: number;
  readonly width: number;
  readonly depth: number;
}

export interface ArchitectureGlobalCandidate {
  readonly corridorAxis: ArchitectureCorridorAxis;
  readonly stairSide?: ArchitectureBandSide;
  readonly negativeBandDepthCells: number;
  readonly positiveBandDepthCells: number;
  readonly signature: string;
}

export interface SolvedRoomPlacement {
  readonly roomId: string;
  readonly floorId: string;
  readonly side: ArchitectureBandSide;
  /** Zero-based order from the entrance-facing end toward the rear. */
  readonly sequenceIndex: number;
  readonly rectangleCells: ArchitectureGridRectangle;
  readonly clearArea: number;
  readonly aspectRatio: number;
}

export interface SolvedFloorLayout {
  readonly floorId: string;
  readonly level: number;
  readonly corridorCells: ArchitectureGridRectangle;
  readonly stairCoreCells?: ArchitectureGridRectangle;
  readonly negativeSequence: readonly string[];
  readonly positiveSequence: readonly string[];
  readonly rooms: readonly SolvedRoomPlacement[];
  readonly signature: string;
}

export interface SolvedLayout {
  readonly corridorAxis: ArchitectureCorridorAxis;
  readonly stairSide?: ArchitectureBandSide;
  readonly negativeBandDepthCells: number;
  readonly positiveBandDepthCells: number;
  readonly outerWidthCells: number;
  readonly outerDepthCells: number;
  readonly floors: readonly SolvedFloorLayout[];
  readonly score: ArchitecturePlanScore;
  readonly signature: string;
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Converts an edge-relative integer-cell rectangle into centered local stud coordinates. */
export function gridRectangleToLocalStuds(
  rectangle: ArchitectureGridRectangle,
  outerWidthCells: number,
  outerDepthCells: number,
  gridSize: number,
): ArchitectureRectangle {
  return {
    x: (rectangle.x - outerWidthCells / 2) * gridSize,
    z: (rectangle.z - outerDepthCells / 2) * gridSize,
    width: rectangle.width * gridSize,
    depth: rectangle.depth * gridSize,
  };
}

export function canonicalGlobalCandidateSignature(
  corridorAxis: ArchitectureCorridorAxis,
  stairSide: ArchitectureBandSide | undefined,
  negativeBandDepthCells: number,
  positiveBandDepthCells: number,
): string {
  return [
    `axis=${corridorAxis}`,
    `stair=${stairSide ?? 'none'}`,
    `negative=${String(negativeBandDepthCells)}`,
    `positive=${String(positiveBandDepthCells)}`,
  ].join('|');
}

/** Creates all documented global axis, stair-side, and odd-split alternatives. */
export function createGlobalCandidates(
  profile: ArchitectureSourceProfile,
): readonly ArchitectureGlobalCandidate[] {
  const building = profile.building;
  const gridSize = building.gridSize;
  const widthCells = building.footprint.width / gridSize;
  const depthCells = building.footprint.depth / gridSize;
  const exteriorCells = building.exteriorWallThickness / gridSize;
  const interiorWallCells = building.interiorWallThickness / gridSize;
  const corridorCells = building.corridorWidth / gridSize;
  const axes: readonly ArchitectureCorridorAxis[] =
    building.corridorAxis === 'auto' ? ['x', 'z'] : [building.corridorAxis];
  const stairSides: readonly (ArchitectureBandSide | undefined)[] =
    profile.stair === undefined
      ? [undefined]
      : profile.stair.directive.preferredSide === 'auto'
        ? ['negative', 'positive']
        : [profile.stair.directive.preferredSide];

  const candidates: ArchitectureGlobalCandidate[] = [];
  for (const corridorAxis of axes) {
    const perpendicularOuterCells = corridorAxis === 'x' ? depthCells : widthCells;
    const interiorPerpendicularCells = perpendicularOuterCells - 2 * exteriorCells;
    const combinedBandCells = interiorPerpendicularCells - corridorCells - 2 * interiorWallCells;
    if (!Number.isSafeInteger(combinedBandCells) || combinedBandCells < 2) continue;
    const smallerBand = Math.floor(combinedBandCells / 2);
    const largerBand = combinedBandCells - smallerBand;
    const splits: readonly (readonly [number, number])[] =
      smallerBand === largerBand
        ? [[smallerBand, largerBand]]
        : [
            [smallerBand, largerBand],
            [largerBand, smallerBand],
          ];
    for (const [negativeBandDepthCells, positiveBandDepthCells] of splits) {
      for (const stairSide of stairSides) {
        const signature = canonicalGlobalCandidateSignature(
          corridorAxis,
          stairSide,
          negativeBandDepthCells,
          positiveBandDepthCells,
        );
        candidates.push({
          corridorAxis,
          ...(stairSide === undefined ? {} : { stairSide }),
          negativeBandDepthCells,
          positiveBandDepthCells,
          signature,
        });
      }
    }
  }
  return candidates.sort((left, right) => compareCodePoints(left.signature, right.signature));
}

/** Seed is used only after the complete non-seed score ties. */
export function candidateSeedTieBreak(seed: number, signature: string): number {
  const digest = createHash('sha256')
    .update(`${String(seed)}\n${signature}`, 'utf8')
    .digest();
  // Forty-eight bits remain exactly representable and satisfy the schema's safe-integer bound.
  return digest.readUIntBE(0, 6);
}

export function canonicalSolvedLayoutSignature(
  globalCandidate: ArchitectureGlobalCandidate,
  floors: readonly SolvedFloorLayout[],
): string {
  return [
    globalCandidate.signature,
    ...[...floors]
      .sort(
        (left, right) => left.level - right.level || compareCodePoints(left.floorId, right.floorId),
      )
      .map((floor) => floor.signature),
  ].join('||');
}
