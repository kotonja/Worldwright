import { createGeneratedId } from './generated-id.js';
import type {
  ArchitectureOpening,
  ArchitectureRoomSpace,
  ArchitectureSpace,
  ArchitectureWall,
} from './types.js';

export interface RoomOpeningRequirement {
  readonly roomId: string;
  readonly doorWidth: number;
  readonly minimumWindows: number;
  readonly preferredWindows: number;
}

export interface DoorAdjacencyRequirement {
  readonly relationshipId: string;
  readonly fromRoomId: string;
  readonly toRoomId: string;
  readonly requirement: 'required' | 'preferred';
  readonly connection: 'door';
}

export interface OpeningBuildInput {
  readonly floorId: string;
  readonly spaces: readonly ArchitectureSpace[];
  readonly walls: readonly ArchitectureWall[];
  readonly roomRequirements: readonly RoomOpeningRequirement[];
  readonly doorAdjacencies: readonly DoorAdjacencyRequirement[];
  readonly entranceRoomId?: string;
  readonly exteriorEntranceNodeId: string;
  readonly corridorAxis: 'x' | 'z';
  readonly entranceEnd: 'negative' | 'positive';
  readonly defaultDoorWidth: number;
  readonly defaultDoorHeight: number;
  readonly defaultWindowWidth: number;
  readonly defaultWindowHeight: number;
  readonly defaultWindowSillHeight: number;
  readonly openingEndClearance: number;
  readonly usedIds?: ReadonlySet<string>;
}

export interface OpeningBuildWarning {
  readonly code: 'architecture.preference_unsatisfied';
  readonly roomId: string;
  readonly message: string;
}

export interface OpeningBuildResult {
  readonly openings: readonly ArchitectureOpening[];
  readonly walls: readonly ArchitectureWall[];
  readonly corridorDoorIds: Readonly<Record<string, string>>;
  readonly warnings: readonly OpeningBuildWarning[];
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function roomSpace(spaces: readonly ArchitectureSpace[], roomId: string): ArchitectureRoomSpace {
  const room = spaces.find((space): space is ArchitectureRoomSpace => {
    return space.type === 'room' && space.id === roomId;
  });
  if (room === undefined) throw new Error(`Room ${roomId} has no planned placement.`);
  return room;
}

function nextId(parts: readonly string[], used: Set<string>): string {
  const id = createGeneratedId(parts, used);
  used.add(id);
  return id;
}

function wallLength(wall: Readonly<ArchitectureWall>): number {
  return wall.end - wall.start;
}

function adjacentTo(wall: Readonly<ArchitectureWall>, spaceId: string): boolean {
  return wall.firstSpaceId === spaceId || wall.secondSpaceId === spaceId;
}

function otherSpace(wall: Readonly<ArchitectureWall>, spaceId: string): string | undefined {
  if (wall.firstSpaceId === spaceId) return wall.secondSpaceId;
  if (wall.secondSpaceId === spaceId) return wall.firstSpaceId;
  return undefined;
}

function centeredOffset(
  wall: Readonly<ArchitectureWall>,
  width: number,
  clearance: number,
): number {
  const length = wallLength(wall);
  if (width + clearance * 2 > length) {
    throw new Error(`Opening width ${width} does not fit wall ${wall.id}.`);
  }
  return (length - width) / 2;
}

function opening(
  input: {
    readonly id: string;
    readonly floorId: string;
    readonly wallId: string;
    readonly type: 'door' | 'window';
    readonly offset: number;
    readonly width: number;
    readonly bottom: number;
    readonly height: number;
    readonly sourceId: string;
    readonly fromNodeId: string;
    readonly toNodeId: string;
  },
  wall: Readonly<ArchitectureWall>,
): ArchitectureOpening {
  if (
    input.offset < 0 ||
    input.offset + input.width > wallLength(wall) ||
    input.bottom < 0 ||
    input.bottom + input.height > wall.height
  ) {
    throw new Error(`Opening ${input.id} is outside wall ${wall.id}.`);
  }
  return { ...input };
}

function pairKey(left: string, right: string): string {
  return [left, right].sort(compareCodePoints).join('|');
}

function entranceFacadeWall(
  roomId: string,
  walls: readonly ArchitectureWall[],
  corridorAxis: 'x' | 'z',
  entranceEnd: 'negative' | 'positive',
): ArchitectureWall | undefined {
  const candidates = walls.filter(
    (wall) =>
      wall.exterior === true &&
      adjacentTo(wall, roomId) &&
      wall.axis === (corridorAxis === 'x' ? 'z' : 'x'),
  );
  return candidates.sort((left, right) => {
    const byCoordinate = left.constant - right.constant;
    if (byCoordinate !== 0) return entranceEnd === 'negative' ? byCoordinate : -byCoordinate;
    return compareCodePoints(left.id, right.id);
  })[0];
}

function roomExteriorWindowWall(
  roomId: string,
  walls: readonly ArchitectureWall[],
  corridorAxis: 'x' | 'z',
): ArchitectureWall | undefined {
  return walls
    .filter(
      (wall) => wall.exterior === true && adjacentTo(wall, roomId) && wall.axis === corridorAxis,
    )
    .sort(
      (left, right) => wallLength(right) - wallLength(left) || compareCodePoints(left.id, right.id),
    )[0];
}

/** Places all explicit v0.1 doors and windows on pre-built logical walls. */
export function buildOpenings(input: Readonly<OpeningBuildInput>): OpeningBuildResult {
  const used = new Set(input.usedIds);
  const openings: ArchitectureOpening[] = [];
  const openingIdsByWall = new Map<string, string[]>();
  const corridorDoorIds = new Map<string, string>();
  const warnings: OpeningBuildWarning[] = [];
  const corridor = input.spaces.find((space) => space.type === 'corridor');
  if (corridor === undefined) throw new Error(`Floor ${input.floorId} has no corridor.`);

  const add = (value: ArchitectureOpening): void => {
    const existing = openingIdsByWall.get(value.wallId);
    if (existing === undefined) openingIdsByWall.set(value.wallId, [value.id]);
    else existing.push(value.id);
    openings.push(value);
  };

  for (const requirement of [...input.roomRequirements].sort((left, right) =>
    compareCodePoints(left.roomId, right.roomId),
  )) {
    const room = roomSpace(input.spaces, requirement.roomId);
    const corridorWall = input.walls.find(
      (wall) =>
        wall.kind === 'corridor' &&
        adjacentTo(wall, room.id) &&
        otherSpace(wall, room.id) === corridor.id,
    );
    if (corridorWall === undefined) {
      throw new Error(`Room ${room.id} has no corridor wall.`);
    }
    const doorWidth = requirement.doorWidth || input.defaultDoorWidth;
    const doorId = nextId(['opening', 'corridor-door', room.id], used);
    add(
      opening(
        {
          id: doorId,
          floorId: input.floorId,
          wallId: corridorWall.id,
          type: 'door',
          offset: centeredOffset(corridorWall, doorWidth, input.openingEndClearance),
          width: doorWidth,
          bottom: 0,
          height: input.defaultDoorHeight,
          sourceId: room.id,
          fromNodeId: room.id,
          toNodeId: corridor.id,
        },
        corridorWall,
      ),
    );
    corridorDoorIds.set(room.id, doorId);

    const windowWall = roomExteriorWindowWall(room.id, input.walls, input.corridorAxis);
    if (windowWall === undefined) {
      if (requirement.minimumWindows > 0) {
        throw new Error(`Room ${room.id} has no exterior window wall.`);
      }
      continue;
    }
    const available = wallLength(windowWall) - input.openingEndClearance * 2;
    const windowFitsVertically =
      input.defaultWindowSillHeight + input.defaultWindowHeight <= windowWall.height;
    const maximumCount = windowFitsVertically
      ? Math.max(0, Math.floor(available / input.defaultWindowWidth))
      : 0;
    if (maximumCount < requirement.minimumWindows) {
      throw new Error(`Minimum windows do not fit room ${room.id}.`);
    }
    const count = Math.min(requirement.preferredWindows, maximumCount);
    if (count < requirement.preferredWindows) {
      warnings.push({
        code: 'architecture.preference_unsatisfied',
        roomId: room.id,
        message: `Room ${room.id} fits ${count} of ${requirement.preferredWindows} preferred windows.`,
      });
    }
    const remaining = available - count * input.defaultWindowWidth;
    const gap = count === 0 ? 0 : remaining / (count + 1);
    for (let index = 0; index < count; index += 1) {
      const offset =
        input.openingEndClearance + gap * (index + 1) + input.defaultWindowWidth * index;
      const id = nextId(['opening', 'window', room.id, String(index + 1)], used);
      add(
        opening(
          {
            id,
            floorId: input.floorId,
            wallId: windowWall.id,
            type: 'window',
            offset,
            width: input.defaultWindowWidth,
            bottom: input.defaultWindowSillHeight,
            height: input.defaultWindowHeight,
            sourceId: room.id,
            fromNodeId: room.id,
            toNodeId: 'exterior',
          },
          windowWall,
        ),
      );
    }
  }

  for (const stairHall of input.spaces
    .filter((space) => space.type === 'stair_hall')
    .sort((left, right) => compareCodePoints(left.id, right.id))) {
    const corridorWall = input.walls.find(
      (wall) =>
        wall.kind === 'stair' &&
        adjacentTo(wall, stairHall.id) &&
        otherSpace(wall, stairHall.id) === corridor.id,
    );
    if (corridorWall === undefined) {
      throw new Error(`Stair hall ${stairHall.id} has no explicit corridor wall.`);
    }
    const width = Math.min(
      input.defaultDoorWidth,
      wallLength(corridorWall) - input.openingEndClearance * 2,
    );
    if (width <= 0) throw new Error(`Stair-hall opening does not fit wall ${corridorWall.id}.`);
    const id = nextId(['opening', 'stair-hall', stairHall.id], used);
    add(
      opening(
        {
          id,
          floorId: input.floorId,
          wallId: corridorWall.id,
          type: 'door',
          offset: centeredOffset(corridorWall, width, input.openingEndClearance),
          width,
          bottom: 0,
          height: input.defaultDoorHeight,
          sourceId: stairHall.sourceStairRouteId,
          fromNodeId: corridor.id,
          toNodeId: stairHall.id,
        },
        corridorWall,
      ),
    );
  }

  if (input.entranceRoomId !== undefined) {
    const entrance = roomSpace(input.spaces, input.entranceRoomId);
    const facade = entranceFacadeWall(
      entrance.id,
      input.walls,
      input.corridorAxis,
      input.entranceEnd,
    );
    if (facade === undefined)
      throw new Error(`Entrance room ${entrance.id} has no entrance facade.`);
    const id = nextId(['opening', 'exterior-entrance', entrance.id], used);
    add(
      opening(
        {
          id,
          floorId: input.floorId,
          wallId: facade.id,
          type: 'door',
          offset: centeredOffset(facade, input.defaultDoorWidth, input.openingEndClearance),
          width: input.defaultDoorWidth,
          bottom: 0,
          height: input.defaultDoorHeight,
          sourceId: entrance.id,
          fromNodeId: input.exteriorEntranceNodeId,
          toNodeId: entrance.id,
        },
        facade,
      ),
    );
  }

  const seenPairs = new Set<string>();
  for (const adjacency of [...input.doorAdjacencies].sort((left, right) =>
    compareCodePoints(left.relationshipId, right.relationshipId),
  )) {
    const key = pairKey(adjacency.fromRoomId, adjacency.toRoomId);
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    const divider = input.walls.find(
      (wall) =>
        wall.kind === 'divider' &&
        adjacentTo(wall, adjacency.fromRoomId) &&
        adjacentTo(wall, adjacency.toRoomId),
    );
    if (divider === undefined) {
      if (adjacency.requirement === 'required') {
        throw new Error(
          `Required adjacency ${adjacency.relationshipId} has no shared divider wall.`,
        );
      }
      warnings.push({
        code: 'architecture.preference_unsatisfied',
        roomId: adjacency.fromRoomId,
        message: `Preferred door relationship ${adjacency.relationshipId} is not adjacent.`,
      });
      continue;
    }
    const id = nextId(['opening', 'room-door', adjacency.relationshipId], used);
    add(
      opening(
        {
          id,
          floorId: input.floorId,
          wallId: divider.id,
          type: 'door',
          offset: centeredOffset(divider, input.defaultDoorWidth, input.openingEndClearance),
          width: input.defaultDoorWidth,
          bottom: 0,
          height: input.defaultDoorHeight,
          sourceId: adjacency.relationshipId,
          fromNodeId: adjacency.fromRoomId,
          toNodeId: adjacency.toRoomId,
        },
        divider,
      ),
    );
  }

  const walls = input.walls.map((wall) => ({
    ...wall,
    openingIds: [...(openingIdsByWall.get(wall.id) ?? [])].sort(compareCodePoints),
  }));
  return {
    openings: openings.sort((left, right) => compareCodePoints(left.id, right.id)),
    walls: walls.sort((left, right) => compareCodePoints(left.id, right.id)),
    corridorDoorIds: Object.fromEntries(
      [...corridorDoorIds.entries()].sort(([left], [right]) => compareCodePoints(left, right)),
    ),
    warnings: warnings.sort(
      (left, right) =>
        compareCodePoints(left.roomId, right.roomId) ||
        compareCodePoints(left.message, right.message),
    ),
  };
}

/** Revalidates horizontal/vertical bounds and overlap for one wall's ordered openings. */
export function validateOpeningIntervals(
  wall: Readonly<ArchitectureWall>,
  openings: readonly ArchitectureOpening[],
): boolean {
  const ordered = [...openings].sort(
    (left, right) => left.offset - right.offset || compareCodePoints(left.id, right.id),
  );
  let previousEnd = 0;
  for (const value of ordered) {
    const end = value.offset + value.width;
    if (
      value.wallId !== wall.id ||
      value.offset < previousEnd ||
      value.offset < 0 ||
      value.width <= 0 ||
      end > wallLength(wall) ||
      value.bottom < 0 ||
      value.height <= 0 ||
      value.bottom + value.height > wall.height
    ) {
      return false;
    }
    previousEnd = end;
  }
  return true;
}
