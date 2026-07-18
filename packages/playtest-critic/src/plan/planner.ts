import { createHash } from 'node:crypto';

import type {
  ArchitectureCirculationEdge,
  ArchitectureFloorPlan,
  ArchitectureOpening,
  ArchitecturePlan,
  ArchitectureRoomSpace,
  ArchitectureSpace,
  ArchitectureStairHallSpace,
} from '@worldwright/architecture-planner';

import {
  PLAYTEST_AGENT_PROFILE,
  PLAYTEST_CRITIC_VERSION,
  PLAYTEST_LIMITS,
  PLAYTEST_PLAN_VERSION,
} from '../constants.js';
import {
  playtestDiagnostic,
  sortPlaytestDiagnostics,
  type PlaytestValidationResult,
} from '../diagnostic.js';
import { compareCodePoints } from '../json.js';
import {
  exteriorOpeningPoint,
  localToWorld,
  openingSidePoint,
  rectangleCenter,
  rectangleCenterHasAgentClearance,
  rootLocalY,
  safeStairHallPoint,
  stairHallApproachContainsPoint,
  type LocalPoint,
} from './coordinates.js';
import type {
  PlaytestCheckpoint,
  PlaytestPlan,
  PlaytestSegment,
  PlaytestVector3,
} from './contract-schema.js';
import { bindPlaytestSource } from './source.js';
import { validatePlaytestPlan } from './validate.js';

interface DraftGraphEdge {
  readonly left: string;
  readonly right: string;
  readonly sourceCirculationEdgeId: string;
  readonly traversal: PlaytestSegment['traversal'];
}

interface CheckpointContext {
  readonly plan: ArchitecturePlan;
  readonly checkpoints: Map<string, PlaytestCheckpoint>;
  readonly graphEdges: DraftGraphEdge[];
  readonly anchorByNode: Map<string, string>;
  readonly stairHallAnchorsByNode: Map<string, Map<string, string>>;
  readonly floorById: ReadonlyMap<string, ArchitectureFloorPlan>;
  readonly spaceById: ReadonlyMap<string, ArchitectureSpace>;
  readonly openingById: ReadonlyMap<string, ArchitectureOpening>;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function derivedId(kind: string, ...parts: readonly string[]): string {
  return `pt-${kind}-${digest(JSON.stringify(parts)).slice(0, 20)}`;
}

function position(
  plan: Readonly<ArchitecturePlan>,
  floor: Readonly<ArchitectureFloorPlan>,
  x: number,
  z: number,
  supportOffset = 0,
): { readonly localPosition: PlaytestVector3; readonly worldPosition: PlaytestVector3 } {
  const localPosition: LocalPoint = {
    x,
    y: rootLocalY(plan, floor.finishedFloorElevation, supportOffset),
    z,
  };
  return { localPosition, worldPosition: localToWorld(plan, localPosition) };
}

function addCheckpoint(context: CheckpointContext, checkpoint: PlaytestCheckpoint): void {
  if (context.checkpoints.has(checkpoint.id)) {
    throw new Error(`Duplicate generated checkpoint ${checkpoint.id}.`);
  }
  context.checkpoints.set(checkpoint.id, checkpoint);
}

function addEdge(
  context: CheckpointContext,
  left: string,
  right: string,
  source: Readonly<ArchitectureCirculationEdge>,
  traversal: PlaytestSegment['traversal'] = source.traversal,
): void {
  context.graphEdges.push({
    left,
    right,
    sourceCirculationEdgeId: source.id,
    traversal,
  });
}

function createAnchors(context: CheckpointContext): {
  readonly exteriorCheckpointId: string;
  readonly entranceRoom: ArchitectureRoomSpace;
  readonly exteriorOpening: ArchitectureOpening;
  readonly exteriorEdge: ArchitectureCirculationEdge;
} {
  const rooms = context.plan.spaces.filter(
    (space): space is ArchitectureRoomSpace => space.type === 'room',
  );
  const entranceRoom = rooms.find((room) => room.isEntrance);
  if (entranceRoom === undefined) throw new Error('Exactly one entrance room is required.');
  for (const room of rooms) {
    const floor = context.floorById.get(room.floorId);
    if (floor === undefined) throw new Error(`Room ${room.id} references a missing floor.`);
    const center = rectangleCenter(room.rectangle);
    const id = derivedId('room', room.id);
    addCheckpoint(context, {
      id,
      type: 'room_center',
      sourceSemanticId: room.id,
      sourceFloorId: room.floorId,
      level: floor.level,
      ...position(context.plan, floor, center.x, center.z),
      expectedFinishedFloorElevation: floor.finishedFloorElevation,
      required: true,
      roomId: room.id,
    });
    context.anchorByNode.set(room.id, id);
  }
  for (const corridor of context.plan.spaces.filter((space) => space.type === 'corridor')) {
    const floor = context.floorById.get(corridor.floorId);
    if (floor === undefined) throw new Error(`Corridor ${corridor.id} references a missing floor.`);
    const center = rectangleCenter(corridor.rectangle);
    const id = derivedId('corridor', corridor.id);
    addCheckpoint(context, {
      id,
      type: 'corridor',
      sourceSemanticId: corridor.id,
      sourceFloorId: corridor.floorId,
      level: floor.level,
      ...position(context.plan, floor, center.x, center.z),
      expectedFinishedFloorElevation: floor.finishedFloorElevation,
      required: true,
      corridorId: corridor.id,
      circulationNodeId: corridor.id,
    });
    context.anchorByNode.set(corridor.id, id);
  }
  for (const hall of context.plan.spaces.filter(
    (space): space is ArchitectureStairHallSpace => space.type === 'stair_hall',
  )) {
    const floor = context.floorById.get(hall.floorId);
    const runs = context.plan.stairRuns
      .filter(
        (candidate) =>
          candidate.sourceStairRouteId === hall.sourceStairRouteId &&
          (candidate.fromFloorId === hall.floorId || candidate.toFloorId === hall.floorId),
      )
      .sort((left, right) => compareCodePoints(left.id, right.id));
    const openingEdge = context.plan.circulationEdges.find(
      (edge) =>
        edge.sourceType === 'opening' && (edge.fromNodeId === hall.id || edge.toNodeId === hall.id),
    );
    const opening =
      openingEdge === undefined ? undefined : context.openingById.get(openingEdge.sourceId);
    const wall =
      opening === undefined
        ? undefined
        : context.plan.walls.find((candidate) => candidate.id === opening.wallId);
    const hallSide =
      opening === undefined || wall === undefined
        ? undefined
        : openingSidePoint(opening, wall, hall);
    if (
      floor === undefined ||
      runs.length === 0 ||
      hallSide === undefined ||
      openingEdge === undefined
    ) {
      throw new Error(`Stair hall ${hall.id} has no deterministic clear-space checkpoint.`);
    }
    const runAnchors = new Map<string, string>();
    for (const run of runs) {
      const center = safeStairHallPoint(hall, run, context.plan.building.corridorAxis, hallSide);
      if (center === undefined)
        throw new Error(`Stair hall ${hall.id} has no safe checkpoint for ${run.id}.`);
      const id = derivedId('hall', hall.id, run.id);
      addCheckpoint(context, {
        id,
        type: 'stair_hall',
        sourceSemanticId: hall.id,
        sourceFloorId: hall.floorId,
        level: floor.level,
        ...position(context.plan, floor, center.x, center.z),
        expectedFinishedFloorElevation: floor.finishedFloorElevation,
        required: true,
        circulationNodeId: hall.id,
        stairRunId: run.id,
        openingId: openingEdge.sourceId,
      });
      runAnchors.set(run.id, id);
    }
    context.stairHallAnchorsByNode.set(hall.id, runAnchors);
    const firstAnchor = runAnchors.values().next().value as string | undefined;
    if (firstAnchor !== undefined) context.anchorByNode.set(hall.id, firstAnchor);
  }

  const exteriorEdge = context.plan.circulationEdges.find((edge) => {
    if (edge.sourceType !== 'opening') return false;
    const opening = context.openingById.get(edge.sourceId);
    const wall =
      opening === undefined
        ? undefined
        : context.plan.walls.find((value) => value.id === opening.wallId);
    return (
      opening !== undefined &&
      wall?.exterior === true &&
      (edge.fromNodeId === entranceRoom.id || edge.toNodeId === entranceRoom.id)
    );
  });
  if (exteriorEdge === undefined)
    throw new Error('Entrance room has no exterior circulation edge.');
  const exteriorOpening = context.openingById.get(exteriorEdge.sourceId);
  const exteriorWall =
    exteriorOpening === undefined
      ? undefined
      : context.plan.walls.find((wall) => wall.id === exteriorOpening.wallId);
  const exteriorPoint =
    exteriorOpening === undefined || exteriorWall === undefined
      ? undefined
      : exteriorOpeningPoint(exteriorOpening, exteriorWall, entranceRoom);
  const floor = context.floorById.get(entranceRoom.floorId);
  if (
    exteriorOpening === undefined ||
    exteriorWall === undefined ||
    exteriorPoint === undefined ||
    floor === undefined
  ) {
    throw new Error('Exterior setup checkpoint cannot be derived safely.');
  }
  const exteriorNodeId =
    exteriorEdge.fromNodeId === entranceRoom.id ? exteriorEdge.toNodeId : exteriorEdge.fromNodeId;
  const exteriorCheckpointId = derivedId('exterior', exteriorOpening.id);
  addCheckpoint(context, {
    id: exteriorCheckpointId,
    type: 'exterior_entrance',
    sourceSemanticId: exteriorOpening.id,
    sourceFloorId: floor.id,
    level: floor.level,
    ...position(context.plan, floor, exteriorPoint.x, exteriorPoint.z),
    expectedFinishedFloorElevation: floor.finishedFloorElevation,
    required: true,
    openingId: exteriorOpening.id,
    circulationNodeId: exteriorNodeId,
    roomId: entranceRoom.id,
  });
  context.anchorByNode.set(exteriorNodeId, exteriorCheckpointId);
  return { exteriorCheckpointId, entranceRoom, exteriorOpening, exteriorEdge };
}

function thresholdForSpace(
  context: CheckpointContext,
  opening: Readonly<ArchitectureOpening>,
  edge: Readonly<ArchitectureCirculationEdge>,
  space: Readonly<ArchitectureSpace>,
): PlaytestCheckpoint {
  const floor = context.floorById.get(space.floorId);
  const wall = context.plan.walls.find((candidate) => candidate.id === opening.wallId);
  const point = wall === undefined ? undefined : openingSidePoint(opening, wall, space);
  if (floor === undefined || wall === undefined || point === undefined) {
    throw new Error(`Opening ${opening.id} has no safe point inside ${space.id}.`);
  }
  const base = {
    id: derivedId(space.type === 'corridor' ? 'corridor-door' : 'threshold', opening.id, space.id),
    sourceSemanticId: opening.id,
    sourceFloorId: floor.id,
    level: floor.level,
    ...position(context.plan, floor, point.x, point.z),
    expectedFinishedFloorElevation: floor.finishedFloorElevation,
    required: true,
  } as const;
  if (space.type === 'room') {
    return {
      ...base,
      type: 'opening_threshold',
      openingId: opening.id,
      circulationNodeId: edge.id,
      roomId: space.id,
    };
  }
  if (space.type === 'corridor') {
    return {
      ...base,
      type: 'corridor',
      corridorId: space.id,
      circulationNodeId: space.id,
      openingId: opening.id,
    };
  }
  throw new Error(`Stair-hall threshold ${opening.id} is not part of the v0.1 checkpoint model.`);
}

function addOpeningMicrograph(
  context: CheckpointContext,
  edge: Readonly<ArchitectureCirculationEdge>,
  entrance: Readonly<{
    entranceRoom: ArchitectureRoomSpace;
    exteriorEdge: ArchitectureCirculationEdge;
  }>,
): void {
  if (edge.sourceType !== 'opening') return;
  const opening = context.openingById.get(edge.sourceId);
  if (opening === undefined) throw new Error(`Opening edge ${edge.id} has no opening.`);
  const fromSpace = context.spaceById.get(edge.fromNodeId);
  const toSpace = context.spaceById.get(edge.toNodeId);
  if (edge.id === entrance.exteriorEdge.id) {
    const roomSide = thresholdForSpace(context, opening, edge, entrance.entranceRoom);
    addCheckpoint(context, roomSide);
    const exteriorAnchor = context.anchorByNode.get(
      edge.fromNodeId === entrance.entranceRoom.id ? edge.toNodeId : edge.fromNodeId,
    );
    const roomAnchor = context.anchorByNode.get(entrance.entranceRoom.id);
    if (exteriorAnchor === undefined || roomAnchor === undefined)
      throw new Error('Entrance anchors are missing.');
    addEdge(context, exteriorAnchor, roomSide.id, edge, 'door');
    addEdge(context, roomSide.id, roomAnchor, edge, 'door');
    return;
  }
  if (fromSpace === undefined || toSpace === undefined) {
    throw new Error(`Opening ${opening.id} does not resolve to two plan spaces.`);
  }
  const fromAnchor = context.anchorByNode.get(fromSpace.id);
  const toAnchor = context.anchorByNode.get(toSpace.id);
  if (fromAnchor === undefined || toAnchor === undefined)
    throw new Error(`Opening ${opening.id} has missing anchors.`);

  if (fromSpace.type === 'stair_hall' || toSpace.type === 'stair_hall') {
    const hall: ArchitectureStairHallSpace =
      fromSpace.type === 'stair_hall' ? fromSpace : (toSpace as ArchitectureStairHallSpace);
    const wall = context.plan.walls.find((candidate) => candidate.id === opening.wallId);
    const hallSide = wall === undefined ? undefined : openingSidePoint(opening, wall, hall);
    const hallAnchors = context.stairHallAnchorsByNode.get(hall.id);
    const other = fromSpace.type === 'stair_hall' ? toAnchor : fromAnchor;
    if (
      hallSide === undefined ||
      hallAnchors === undefined ||
      [...hallAnchors.keys()].some((runId) => {
        const run = context.plan.stairRuns.find((candidate) => candidate.id === runId);
        return (
          run === undefined ||
          !stairHallApproachContainsPoint(hall, run, context.plan.building.corridorAxis, hallSide)
        );
      })
    ) {
      throw new Error(
        `Stair-hall opening ${opening.id} does not approach its retained landing clear space.`,
      );
    }
    for (const hallAnchor of hallAnchors.values())
      addEdge(context, other, hallAnchor, edge, 'open');
    return;
  }
  const fromThreshold = thresholdForSpace(context, opening, edge, fromSpace);
  const toThreshold = thresholdForSpace(context, opening, edge, toSpace);
  addCheckpoint(context, fromThreshold);
  addCheckpoint(context, toThreshold);
  addEdge(
    context,
    fromAnchor,
    fromThreshold.id,
    edge,
    fromSpace.type === 'corridor' ? 'corridor' : 'door',
  );
  addEdge(context, fromThreshold.id, toThreshold.id, edge, 'door');
  addEdge(
    context,
    toThreshold.id,
    toAnchor,
    edge,
    toSpace.type === 'corridor' ? 'corridor' : 'door',
  );
}

function addStairMicrograph(
  context: CheckpointContext,
  edge: Readonly<ArchitectureCirculationEdge>,
): void {
  if (edge.sourceType !== 'stair_run') return;
  const run = context.plan.stairRuns.find((candidate) => candidate.id === edge.sourceId);
  const lowerFloor = run === undefined ? undefined : context.floorById.get(run.fromFloorId);
  const upperFloor = run === undefined ? undefined : context.floorById.get(run.toFloorId);
  const lowerAnchor =
    run === undefined
      ? undefined
      : (context.stairHallAnchorsByNode.get(edge.fromNodeId)?.get(run.id) ??
        context.anchorByNode.get(edge.fromNodeId));
  const upperAnchor =
    run === undefined
      ? undefined
      : (context.stairHallAnchorsByNode.get(edge.toNodeId)?.get(run.id) ??
        context.anchorByNode.get(edge.toNodeId));
  if (
    run === undefined ||
    lowerFloor === undefined ||
    upperFloor === undefined ||
    lowerAnchor === undefined ||
    upperAnchor === undefined
  ) {
    throw new Error(`Stair circulation edge ${edge.id} does not resolve.`);
  }
  if (
    !rectangleCenterHasAgentClearance(run.landing.lower) ||
    !rectangleCenterHasAgentClearance(run.landing.upper)
  ) {
    throw new Error(
      `Stair run ${run.id} landing centers do not contain the fixed agent clearance envelope.`,
    );
  }
  const lowerCenter = rectangleCenter(run.landing.lower);
  const upperCenter = rectangleCenter(run.landing.upper);
  const lowestLevel = Math.min(...context.plan.floors.map((floor) => floor.level));
  const lowerId = derivedId('landing-lower', run.id);
  const upperId = derivedId('landing-upper', run.id);
  addCheckpoint(context, {
    id: lowerId,
    type: 'stair_landing',
    sourceSemanticId: run.id,
    sourceFloorId: lowerFloor.id,
    level: lowerFloor.level,
    ...position(
      context.plan,
      lowerFloor,
      lowerCenter.x,
      lowerCenter.z,
      lowerFloor.level === lowestLevel ? context.plan.building.slabThickness : 0,
    ),
    expectedFinishedFloorElevation: lowerFloor.finishedFloorElevation,
    required: true,
    circulationNodeId: edge.fromNodeId,
    stairRunId: run.id,
    landing: 'lower',
  });
  addCheckpoint(context, {
    id: upperId,
    type: 'stair_landing',
    sourceSemanticId: run.id,
    sourceFloorId: upperFloor.id,
    level: upperFloor.level,
    ...position(context.plan, upperFloor, upperCenter.x, upperCenter.z),
    expectedFinishedFloorElevation: upperFloor.finishedFloorElevation,
    required: true,
    circulationNodeId: edge.toNodeId,
    stairRunId: run.id,
    landing: 'upper',
  });
  addEdge(context, lowerAnchor, lowerId, edge, 'stair');
  addEdge(context, lowerId, upperId, edge, 'stair');
  addEdge(context, upperId, upperAnchor, edge, 'stair');
}

function graphAdjacency(
  edges: readonly DraftGraphEdge[],
): ReadonlyMap<string, readonly { id: string; edge: DraftGraphEdge }[]> {
  const result = new Map<string, { id: string; edge: DraftGraphEdge }[]>();
  const add = (from: string, to: string, edge: DraftGraphEdge): void => {
    const values = result.get(from);
    if (values === undefined) result.set(from, [{ id: to, edge }]);
    else values.push({ id: to, edge });
  };
  for (const edge of edges) {
    add(edge.left, edge.right, edge);
    add(edge.right, edge.left, edge);
  }
  for (const values of result.values()) {
    values.sort(
      (left, right) =>
        compareCodePoints(left.id, right.id) ||
        compareCodePoints(left.edge.sourceCirculationEdgeId, right.edge.sourceCirculationEdgeId),
    );
  }
  return result;
}

function shortestPath(
  start: string,
  target: string,
  adjacency: ReadonlyMap<string, readonly { id: string; edge: DraftGraphEdge }[]>,
): readonly { from: string; to: string; edge: DraftGraphEdge }[] | undefined {
  if (start === target) return [];
  const queue = [start];
  let cursor = 0;
  const previous = new Map<string, { from: string; edge: DraftGraphEdge }>();
  previous.set(start, {
    from: start,
    edge: { left: start, right: start, sourceCirculationEdgeId: start, traversal: 'open' },
  });
  while (cursor < queue.length && !previous.has(target)) {
    const current = queue[cursor++];
    if (current === undefined) break;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (previous.has(neighbor.id)) continue;
      previous.set(neighbor.id, { from: current, edge: neighbor.edge });
      queue.push(neighbor.id);
    }
  }
  if (!previous.has(target)) return undefined;
  const reversed: { from: string; to: string; edge: DraftGraphEdge }[] = [];
  let current = target;
  while (current !== start) {
    const entry = previous.get(current);
    if (entry === undefined) return undefined;
    reversed.push({ from: entry.from, to: current, edge: entry.edge });
    current = entry.from;
  }
  return reversed.reverse();
}

function targetCheckpointOrder(
  context: CheckpointContext,
  exteriorCheckpointId: string,
  entranceRoomId: string,
): readonly string[] {
  const result = [exteriorCheckpointId];
  const used = new Set(result);
  const entranceAnchor = context.anchorByNode.get(entranceRoomId);
  if (entranceAnchor === undefined) throw new Error('Entrance room anchor is missing.');
  result.push(entranceAnchor);
  used.add(entranceAnchor);
  const zoneRank = new Map<string, number>([
    ['public', 0],
    ['service', 1],
    ['private', 2],
  ]);
  for (const floor of [...context.plan.floors].sort(
    (left, right) => left.level - right.level || compareCodePoints(left.id, right.id),
  )) {
    const rooms = context.plan.spaces
      .filter(
        (space): space is ArchitectureRoomSpace =>
          space.type === 'room' && space.floorId === floor.id,
      )
      .sort(
        (left, right) =>
          (zoneRank.get(left.zone) ?? 3) - (zoneRank.get(right.zone) ?? 3) ||
          compareCodePoints(left.id, right.id),
      );
    for (const room of rooms) {
      const anchor = context.anchorByNode.get(room.id);
      if (anchor !== undefined && !used.has(anchor)) {
        result.push(anchor);
        used.add(anchor);
      }
    }
    const remainder = [...context.checkpoints.values()]
      .filter((checkpoint) => checkpoint.sourceFloorId === floor.id && !used.has(checkpoint.id))
      .map((checkpoint) => checkpoint.id)
      .sort(compareCodePoints);
    for (const checkpointId of remainder) {
      result.push(checkpointId);
      used.add(checkpointId);
    }
  }
  return result;
}

function buildSegments(context: CheckpointContext, targets: readonly string[]): PlaytestSegment[] {
  const adjacency = graphAdjacency(context.graphEdges);
  const route: { from: string; to: string; edge: DraftGraphEdge }[] = [];
  let current = targets[0];
  if (current === undefined) return [];
  const traversed = new Set<string>([current]);
  for (const target of targets.slice(1)) {
    if (traversed.has(target)) continue;
    const path = shortestPath(current, target, adjacency);
    if (path === undefined) throw new Error(`No route exists from ${current} to ${target}.`);
    route.push(...path);
    for (const step of path) {
      traversed.add(step.from);
      traversed.add(step.to);
    }
    current = target;
  }
  if (route.length > PLAYTEST_LIMITS.maximumRouteSegments) {
    throw new Error('Derived route exceeds the v0.1 segment limit.');
  }
  return route.map((step, sequence) => {
    const from = context.checkpoints.get(step.from);
    const to = context.checkpoints.get(step.to);
    if (from === undefined || to === undefined)
      throw new Error('Route references a missing checkpoint.');
    return {
      id: derivedId(
        'segment',
        String(sequence),
        step.from,
        step.to,
        step.edge.sourceCirculationEdgeId,
      ),
      sequence,
      fromCheckpointId: step.from,
      toCheckpointId: step.to,
      sourceCirculationEdgeId: step.edge.sourceCirculationEdgeId,
      traversal: step.edge.traversal,
      expectedFromLevel: from.level,
      expectedToLevel: to.level,
      maximumNavigationAttempts: 1,
      pathfindingRequired: true,
      independentArrivalVerificationRequired: true,
      clearanceVerificationRequired: true,
    };
  });
}

function dimension(idsInput: readonly string[]): { ids: string[]; count: number } {
  const ids = [...new Set(idsInput)].sort(compareCodePoints);
  return { ids, count: ids.length };
}

function selectCaptures(
  context: CheckpointContext,
  exteriorCheckpointId: string,
  entranceRoomId: string,
  segments: readonly PlaytestSegment[],
): string[] {
  const candidates = [
    exteriorCheckpointId,
    context.anchorByNode.get(entranceRoomId),
    ...context.plan.floors.flatMap((floor) => {
      const corridor = context.plan.spaces.find(
        (space) => space.type === 'corridor' && space.floorId === floor.id,
      );
      const hall = context.plan.spaces.find(
        (space) => space.type === 'stair_hall' && space.floorId === floor.id,
      );
      return [
        corridor === undefined ? undefined : context.anchorByNode.get(corridor.id),
        hall === undefined ? undefined : context.anchorByNode.get(hall.id),
      ];
    }),
    segments.at(-1)?.toCheckpointId,
  ].filter((value): value is string => value !== undefined);
  return [...new Set(candidates)].slice(0, PLAYTEST_LIMITS.maximumCaptures);
}

export function buildPlaytestPlan(
  architecturePlanInput: unknown,
  manifestInput: unknown,
): PlaytestValidationResult<PlaytestPlan> {
  const binding = bindPlaytestSource(architecturePlanInput, manifestInput);
  if (!binding.valid) return binding;
  const plan = binding.value.architecturePlan;
  try {
    const context: CheckpointContext = {
      plan,
      checkpoints: new Map(),
      graphEdges: [],
      anchorByNode: new Map(),
      stairHallAnchorsByNode: new Map(),
      floorById: new Map(plan.floors.map((floor) => [floor.id, floor] as const)),
      spaceById: new Map(plan.spaces.map((space) => [space.id, space] as const)),
      openingById: new Map(plan.openings.map((opening) => [opening.id, opening] as const)),
    };
    const entrance = createAnchors(context);
    for (const edge of plan.circulationEdges) addOpeningMicrograph(context, edge, entrance);
    for (const edge of plan.circulationEdges) addStairMicrograph(context, edge);
    if (context.checkpoints.size > PLAYTEST_LIMITS.maximumCheckpoints) {
      return {
        valid: false,
        diagnostics: [
          playtestDiagnostic(
            'playtest.limit_exceeded',
            '/checkpoints',
            'Derived checkpoints exceed the v0.1 limit.',
          ),
        ],
      };
    }
    const targets = targetCheckpointOrder(
      context,
      entrance.exteriorCheckpointId,
      entrance.entranceRoom.id,
    );
    const segments = buildSegments(context, targets);
    const checkpoints = [...context.checkpoints.values()].sort((left, right) =>
      compareCodePoints(left.id, right.id),
    );
    const roomIds = plan.spaces.filter((space) => space.type === 'room').map((space) => space.id);
    const corridorIds = plan.spaces
      .filter((space) => space.type === 'corridor')
      .map((space) => space.id);
    const doorOpeningIds = plan.circulationEdges
      .filter((edge) => edge.sourceType === 'opening')
      .map((edge) => edge.sourceId);
    const setupCheckpoint = context.checkpoints.get(entrance.exteriorCheckpointId);
    if (setupCheckpoint === undefined) throw new Error('Setup checkpoint is missing.');
    const result: PlaytestPlan = {
      schemaVersion: PLAYTEST_PLAN_VERSION,
      criticVersion: PLAYTEST_CRITIC_VERSION,
      source: binding.value.source,
      agent: { ...PLAYTEST_AGENT_PROFILE },
      setup: {
        checkpointId: setupCheckpoint.id,
        worldPosition: { ...setupCheckpoint.worldPosition },
        expectedLevel: setupCheckpoint.level,
        sourceFloorId: setupCheckpoint.sourceFloorId,
        expectedFinishedFloorElevation: setupCheckpoint.expectedFinishedFloorElevation,
        exteriorEntranceOpeningId: entrance.exteriorOpening.id,
        entranceRoomId: entrance.entranceRoom.id,
        excludedFromScoring: true,
      },
      checkpoints,
      segments,
      captureCheckpoints: selectCaptures(
        context,
        entrance.exteriorCheckpointId,
        entrance.entranceRoom.id,
        segments,
      ),
      requiredCoverage: {
        rooms: dimension(roomIds),
        floors: dimension(plan.floors.map((floor) => floor.id)),
        corridors: dimension(corridorIds),
        stairRuns: dimension(plan.stairRuns.map((run) => run.id)),
        openings: dimension(doorOpeningIds),
        checkpoints: dimension(
          checkpoints
            .filter((checkpoint) => checkpoint.required)
            .map((checkpoint) => checkpoint.id),
        ),
        segments: dimension(segments.map((segment) => segment.id)),
      },
      limits: { ...PLAYTEST_LIMITS },
    };
    return validatePlaytestPlan(result);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Playtest checkpoint generation failed.';
    const routeLimitExceeded = message === 'Derived route exceeds the v0.1 segment limit.';
    const code = routeLimitExceeded
      ? 'playtest.limit_exceeded'
      : message.startsWith('No route')
        ? 'playtest.route_disconnected'
        : 'playtest.checkpoint_infeasible';
    return {
      valid: false,
      diagnostics: sortPlaytestDiagnostics([
        playtestDiagnostic(code, routeLimitExceeded ? '/segments' : '', message),
      ]),
    };
  }
}
