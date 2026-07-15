import { createGeneratedId } from './generated-id.js';
import type {
  ArchitectureRectangle,
  ArchitectureRoomSpace,
  ArchitectureSpace,
  ArchitectureWall,
} from './types.js';

export interface LogicalWallBuildInput {
  readonly floorId: string;
  readonly spaces: readonly ArchitectureSpace[];
  readonly interiorEnvelope: Readonly<ArchitectureRectangle>;
  readonly corridorAxis: 'x' | 'z';
  readonly exteriorWallThickness: number;
  readonly interiorWallThickness: number;
  readonly wallHeight: number;
  readonly usedIds?: ReadonlySet<string>;
}

export interface LogicalWallBuildResult {
  readonly walls: readonly ArchitectureWall[];
  readonly roomExteriorWallIds: Readonly<Record<string, readonly string[]>>;
}

interface MutableBuildState {
  readonly usedIds: Set<string>;
  readonly walls: ArchitectureWall[];
  readonly keys: Set<string>;
  readonly exteriorByRoom: Map<string, string[]>;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function numberKey(value: number): string {
  return Object.is(value, -0) ? '0' : String(value);
}

function addExteriorWall(roomId: string, wallId: string, state: MutableBuildState): void {
  const existing = state.exteriorByRoom.get(roomId);
  if (existing === undefined) state.exteriorByRoom.set(roomId, [wallId]);
  else existing.push(wallId);
}

function nextId(state: MutableBuildState, parts: readonly string[]): string {
  const id = createGeneratedId(parts, state.usedIds);
  state.usedIds.add(id);
  return id;
}

interface AddWallInput {
  readonly floorId: string;
  readonly kind: ArchitectureWall['kind'];
  readonly axis: ArchitectureWall['axis'];
  readonly constant: number;
  readonly start: number;
  readonly end: number;
  readonly thickness: number;
  readonly height: number;
  readonly firstSpaceId?: string;
  readonly secondSpaceId?: string;
  readonly exterior?: true;
}

function addWall(input: Readonly<AddWallInput>, state: MutableBuildState): ArchitectureWall {
  if (!(input.start < input.end)) throw new Error('Logical wall length must be positive.');
  const adjacent = [input.firstSpaceId, input.secondSpaceId]
    .filter((value): value is string => value !== undefined)
    .sort(compareCodePoints);
  const key = [
    input.axis,
    numberKey(input.constant),
    numberKey(input.start),
    numberKey(input.end),
    ...adjacent,
  ].join('|');
  if (state.keys.has(key)) throw new Error(`Duplicate logical wall geometry: ${key}`);
  state.keys.add(key);

  const id = nextId(state, [
    'wall',
    input.floorId,
    input.kind,
    input.axis,
    numberKey(input.constant),
    numberKey(input.start),
    numberKey(input.end),
    ...adjacent,
  ]);
  const wall: ArchitectureWall = {
    id,
    floorId: input.floorId,
    kind: input.kind,
    axis: input.axis,
    constant: input.constant,
    start: input.start,
    end: input.end,
    thickness: input.thickness,
    height: input.height,
    ...(input.firstSpaceId === undefined ? {} : { firstSpaceId: input.firstSpaceId }),
    ...(input.secondSpaceId === undefined ? {} : { secondSpaceId: input.secondSpaceId }),
    ...(input.exterior === undefined ? {} : { exterior: true as const }),
    openingIds: [],
  };
  state.walls.push(wall);
  return wall;
}

function rectangle(space: Readonly<ArchitectureSpace>): ArchitectureRectangle {
  return space.rectangle;
}

function room(space: Readonly<ArchitectureSpace>): space is ArchitectureRoomSpace {
  return space.type === 'room';
}

function intervalsTouch(leftEnd: number, rightStart: number): boolean {
  return leftEnd === rightStart;
}

function buildXAxisWalls(
  input: Readonly<LogicalWallBuildInput>,
  corridor: Readonly<ArchitectureSpace>,
  sideSpaces: readonly ArchitectureSpace[],
  negativeSide: boolean,
  state: MutableBuildState,
): void {
  const envelope = input.interiorEnvelope;
  const outerConstant = negativeSide
    ? envelope.z - input.exteriorWallThickness / 2
    : envelope.z + envelope.depth + input.exteriorWallThickness / 2;
  const corridorConstant = negativeSide
    ? corridor.rectangle.z - input.interiorWallThickness / 2
    : corridor.rectangle.z + corridor.rectangle.depth + input.interiorWallThickness / 2;

  for (const space of sideSpaces) {
    const area = rectangle(space);
    const corridorWall = addWall(
      {
        floorId: input.floorId,
        kind: space.type === 'stair_hall' ? 'stair' : 'corridor',
        axis: 'x',
        constant: corridorConstant,
        start: area.x,
        end: area.x + area.width,
        thickness: input.interiorWallThickness,
        height: input.wallHeight,
        firstSpaceId: space.id,
        secondSpaceId: corridor.id,
      },
      state,
    );
    void corridorWall;

    const outside = addWall(
      {
        floorId: input.floorId,
        kind: 'exterior',
        axis: 'x',
        constant: outerConstant,
        start: area.x,
        end: area.x + area.width,
        thickness: input.exteriorWallThickness,
        height: input.wallHeight,
        firstSpaceId: space.id,
        exterior: true,
      },
      state,
    );
    if (room(space)) addExteriorWall(space.id, outside.id, state);
  }

  const ordered = [...sideSpaces].sort(
    (left, right) => left.rectangle.x - right.rectangle.x || compareCodePoints(left.id, right.id),
  );
  const bandStart = negativeSide ? outerConstant : corridorConstant;
  const bandEnd = negativeSide ? corridorConstant : outerConstant;
  const first = ordered[0];
  const last = ordered.at(-1);
  if (first === undefined || last === undefined) return;

  const front = addWall(
    {
      floorId: input.floorId,
      kind: 'exterior',
      axis: 'z',
      constant: envelope.x - input.exteriorWallThickness / 2,
      start: bandStart,
      end: bandEnd,
      thickness: input.exteriorWallThickness,
      height: input.wallHeight,
      firstSpaceId: first.id,
      exterior: true,
    },
    state,
  );
  if (room(first)) addExteriorWall(first.id, front.id, state);

  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const left = ordered[index];
    const right = ordered[index + 1];
    if (left === undefined || right === undefined) continue;
    const coordinate = left.rectangle.x + left.rectangle.width;
    if (!intervalsTouch(coordinate + input.interiorWallThickness, right.rectangle.x)) {
      throw new Error(`Unexplained room-band gap between ${left.id} and ${right.id}.`);
    }
    addWall(
      {
        floorId: input.floorId,
        kind: left.type === 'room' && right.type === 'room' ? 'divider' : 'stair',
        axis: 'z',
        constant: coordinate + input.interiorWallThickness / 2,
        start: bandStart,
        end: bandEnd,
        thickness: input.interiorWallThickness,
        height: input.wallHeight,
        firstSpaceId: left.id,
        secondSpaceId: right.id,
      },
      state,
    );
  }

  const rear = addWall(
    {
      floorId: input.floorId,
      kind: 'exterior',
      axis: 'z',
      constant: envelope.x + envelope.width + input.exteriorWallThickness / 2,
      start: bandStart,
      end: bandEnd,
      thickness: input.exteriorWallThickness,
      height: input.wallHeight,
      firstSpaceId: last.id,
      exterior: true,
    },
    state,
  );
  if (room(last)) addExteriorWall(last.id, rear.id, state);
}

function buildZAxisWalls(
  input: Readonly<LogicalWallBuildInput>,
  corridor: Readonly<ArchitectureSpace>,
  sideSpaces: readonly ArchitectureSpace[],
  negativeSide: boolean,
  state: MutableBuildState,
): void {
  const envelope = input.interiorEnvelope;
  const outerConstant = negativeSide
    ? envelope.x - input.exteriorWallThickness / 2
    : envelope.x + envelope.width + input.exteriorWallThickness / 2;
  const corridorConstant = negativeSide
    ? corridor.rectangle.x - input.interiorWallThickness / 2
    : corridor.rectangle.x + corridor.rectangle.width + input.interiorWallThickness / 2;

  for (const space of sideSpaces) {
    const area = rectangle(space);
    addWall(
      {
        floorId: input.floorId,
        kind: space.type === 'stair_hall' ? 'stair' : 'corridor',
        axis: 'z',
        constant: corridorConstant,
        start: area.z,
        end: area.z + area.depth,
        thickness: input.interiorWallThickness,
        height: input.wallHeight,
        firstSpaceId: space.id,
        secondSpaceId: corridor.id,
      },
      state,
    );

    const outside = addWall(
      {
        floorId: input.floorId,
        kind: 'exterior',
        axis: 'z',
        constant: outerConstant,
        start: area.z,
        end: area.z + area.depth,
        thickness: input.exteriorWallThickness,
        height: input.wallHeight,
        firstSpaceId: space.id,
        exterior: true,
      },
      state,
    );
    if (room(space)) addExteriorWall(space.id, outside.id, state);
  }

  const ordered = [...sideSpaces].sort(
    (left, right) => left.rectangle.z - right.rectangle.z || compareCodePoints(left.id, right.id),
  );
  const bandStart = negativeSide ? outerConstant : corridorConstant;
  const bandEnd = negativeSide ? corridorConstant : outerConstant;
  const first = ordered[0];
  const last = ordered.at(-1);
  if (first === undefined || last === undefined) return;

  const front = addWall(
    {
      floorId: input.floorId,
      kind: 'exterior',
      axis: 'x',
      constant: envelope.z - input.exteriorWallThickness / 2,
      start: bandStart,
      end: bandEnd,
      thickness: input.exteriorWallThickness,
      height: input.wallHeight,
      firstSpaceId: first.id,
      exterior: true,
    },
    state,
  );
  if (room(first)) addExteriorWall(first.id, front.id, state);

  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const left = ordered[index];
    const right = ordered[index + 1];
    if (left === undefined || right === undefined) continue;
    const coordinate = left.rectangle.z + left.rectangle.depth;
    if (!intervalsTouch(coordinate + input.interiorWallThickness, right.rectangle.z)) {
      throw new Error(`Unexplained room-band gap between ${left.id} and ${right.id}.`);
    }
    addWall(
      {
        floorId: input.floorId,
        kind: left.type === 'room' && right.type === 'room' ? 'divider' : 'stair',
        axis: 'x',
        constant: coordinate + input.interiorWallThickness / 2,
        start: bandStart,
        end: bandEnd,
        thickness: input.interiorWallThickness,
        height: input.wallHeight,
        firstSpaceId: left.id,
        secondSpaceId: right.id,
      },
      state,
    );
  }

  const rear = addWall(
    {
      floorId: input.floorId,
      kind: 'exterior',
      axis: 'x',
      constant: envelope.z + envelope.depth + input.exteriorWallThickness / 2,
      start: bandStart,
      end: bandEnd,
      thickness: input.exteriorWallThickness,
      height: input.wallHeight,
      firstSpaceId: last.id,
      exterior: true,
    },
    state,
  );
  if (room(last)) addExteriorWall(last.id, rear.id, state);
}

/** Builds canonical logical walls from already-selected, exactly tiled clear-space rectangles. */
export function buildLogicalWalls(input: Readonly<LogicalWallBuildInput>): LogicalWallBuildResult {
  const corridor = input.spaces.find((space) => space.type === 'corridor');
  if (corridor === undefined) throw new Error(`Floor ${input.floorId} has no corridor space.`);
  const nonCorridor = input.spaces.filter((space) => space.type !== 'corridor');
  const state: MutableBuildState = {
    usedIds: new Set(input.usedIds),
    walls: [],
    keys: new Set(),
    exteriorByRoom: new Map(),
  };

  if (input.corridorAxis === 'x') {
    const negative = nonCorridor.filter(
      (space) =>
        space.rectangle.z + space.rectangle.depth + input.interiorWallThickness ===
        corridor.rectangle.z,
    );
    const positive = nonCorridor.filter(
      (space) =>
        space.rectangle.z ===
        corridor.rectangle.z + corridor.rectangle.depth + input.interiorWallThickness,
    );
    if (negative.length + positive.length !== nonCorridor.length) {
      throw new Error(`Every floor ${input.floorId} space must touch the corridor.`);
    }
    buildXAxisWalls(input, corridor, negative, true, state);
    buildXAxisWalls(input, corridor, positive, false, state);
    addWall(
      {
        floorId: input.floorId,
        kind: 'exterior',
        axis: 'z',
        constant: input.interiorEnvelope.x - input.exteriorWallThickness / 2,
        start: corridor.rectangle.z,
        end: corridor.rectangle.z + corridor.rectangle.depth,
        thickness: input.exteriorWallThickness,
        height: input.wallHeight,
        firstSpaceId: corridor.id,
        exterior: true,
      },
      state,
    );
    addWall(
      {
        floorId: input.floorId,
        kind: 'exterior',
        axis: 'z',
        constant:
          input.interiorEnvelope.x + input.interiorEnvelope.width + input.exteriorWallThickness / 2,
        start: corridor.rectangle.z,
        end: corridor.rectangle.z + corridor.rectangle.depth,
        thickness: input.exteriorWallThickness,
        height: input.wallHeight,
        firstSpaceId: corridor.id,
        exterior: true,
      },
      state,
    );
  } else {
    const negative = nonCorridor.filter(
      (space) =>
        space.rectangle.x + space.rectangle.width + input.interiorWallThickness ===
        corridor.rectangle.x,
    );
    const positive = nonCorridor.filter(
      (space) =>
        space.rectangle.x ===
        corridor.rectangle.x + corridor.rectangle.width + input.interiorWallThickness,
    );
    if (negative.length + positive.length !== nonCorridor.length) {
      throw new Error(`Every floor ${input.floorId} space must touch the corridor.`);
    }
    buildZAxisWalls(input, corridor, negative, true, state);
    buildZAxisWalls(input, corridor, positive, false, state);
    addWall(
      {
        floorId: input.floorId,
        kind: 'exterior',
        axis: 'x',
        constant: input.interiorEnvelope.z - input.exteriorWallThickness / 2,
        start: corridor.rectangle.x,
        end: corridor.rectangle.x + corridor.rectangle.width,
        thickness: input.exteriorWallThickness,
        height: input.wallHeight,
        firstSpaceId: corridor.id,
        exterior: true,
      },
      state,
    );
    addWall(
      {
        floorId: input.floorId,
        kind: 'exterior',
        axis: 'x',
        constant:
          input.interiorEnvelope.z + input.interiorEnvelope.depth + input.exteriorWallThickness / 2,
        start: corridor.rectangle.x,
        end: corridor.rectangle.x + corridor.rectangle.width,
        thickness: input.exteriorWallThickness,
        height: input.wallHeight,
        firstSpaceId: corridor.id,
        exterior: true,
      },
      state,
    );
  }

  const walls = state.walls.sort((left, right) => compareCodePoints(left.id, right.id));
  const roomExteriorWallIds = Object.fromEntries(
    [...state.exteriorByRoom.entries()]
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([id, ids]) => [id, [...ids].sort(compareCodePoints)]),
  );
  return { walls, roomExteriorWallIds };
}

export interface WallPanel {
  readonly id: string;
  readonly wallId: string;
  readonly offset: number;
  readonly width: number;
  readonly bottom: number;
  readonly height: number;
}

export interface WallOpeningInterval {
  readonly id: string;
  readonly offset: number;
  readonly width: number;
  readonly bottom: number;
  readonly height: number;
}

/** Subtracts rectangular openings from one logical wall into non-overlapping panels. */
export function decomposeWallPanels(
  wall: Readonly<ArchitectureWall>,
  openings: readonly WallOpeningInterval[],
  usedIds?: ReadonlySet<string>,
): readonly WallPanel[] {
  const wallLength = wall.end - wall.start;
  const ordered = [...openings].sort(
    (left, right) => left.offset - right.offset || compareCodePoints(left.id, right.id),
  );
  let cursor = 0;
  const panels: WallPanel[] = [];
  const used = new Set(usedIds);
  const addPanel = (offset: number, width: number, bottom: number, height: number): void => {
    if (!(width > 0) || !(height > 0)) return;
    const id = createGeneratedId(
      [
        'wall-panel',
        wall.id,
        numberKey(offset),
        numberKey(width),
        numberKey(bottom),
        numberKey(height),
      ],
      used,
    );
    used.add(id);
    panels.push({ id, wallId: wall.id, offset, width, bottom, height });
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
    addPanel(cursor, opening.offset - cursor, 0, wall.height);
    addPanel(opening.offset, opening.width, 0, opening.bottom);
    addPanel(opening.offset, opening.width, top, wall.height - top);
    cursor = end;
  }
  addPanel(cursor, wallLength - cursor, 0, wall.height);
  return panels.sort((left, right) => compareCodePoints(left.id, right.id));
}

export function wallPanelArea(panels: readonly WallPanel[]): number {
  return panels.reduce((total, panel) => total + panel.width * panel.height, 0);
}
