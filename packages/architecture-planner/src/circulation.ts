import { createGeneratedId } from './generated-id.js';
import type {
  ArchitectureCirculationEdge,
  ArchitectureOpening,
  ArchitectureSpace,
  ArchitectureStairRun,
} from './types.js';

export interface CirculationBuildInput {
  readonly openings: readonly ArchitectureOpening[];
  readonly stairRuns: readonly ArchitectureStairRun[];
  readonly spaces: readonly ArchitectureSpace[];
  readonly usedIds?: ReadonlySet<string>;
}

export interface CirculationEvaluation {
  readonly allRoomsReachable: boolean;
  readonly allRequiredNodesReachable: boolean;
  readonly reachableNodeIds: readonly string[];
  readonly unreachableNodeIds: readonly string[];
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pairKey(left: string, right: string): string {
  return [left, right].sort(compareCodePoints).join('|');
}

/** Creates graph edges only from explicit openings and stair runs. */
export function buildCirculationEdges(
  input: Readonly<CirculationBuildInput>,
): readonly ArchitectureCirculationEdge[] {
  const used = new Set(input.usedIds);
  const stairHallIds = new Set(
    input.spaces.filter((space) => space.type === 'stair_hall').map((space) => space.id),
  );
  const stairHallByFloor = new Map(
    input.spaces
      .filter((space) => space.type === 'stair_hall')
      .map((space) => [space.floorId, space.id] as const),
  );
  const edges: ArchitectureCirculationEdge[] = [];
  const seen = new Set<string>();

  for (const opening of [...input.openings].sort((left, right) =>
    compareCodePoints(left.id, right.id),
  )) {
    if (opening.type !== 'door') continue;
    const key = `opening|${pairKey(opening.fromNodeId, opening.toNodeId)}|${opening.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const id = createGeneratedId(['circulation', 'opening', opening.id], used);
    used.add(id);
    edges.push({
      id,
      sourceType: 'opening',
      sourceId: opening.id,
      fromNodeId: opening.fromNodeId,
      toNodeId: opening.toNodeId,
      traversal:
        stairHallIds.has(opening.fromNodeId) || stairHallIds.has(opening.toNodeId)
          ? 'open'
          : 'door',
    });
  }

  for (const run of [...input.stairRuns].sort((left, right) =>
    compareCodePoints(left.id, right.id),
  )) {
    const fromNodeId = stairHallByFloor.get(run.fromFloorId);
    const toNodeId = stairHallByFloor.get(run.toFloorId);
    if (fromNodeId === undefined || toNodeId === undefined) {
      throw new Error(`Stair run ${run.id} does not resolve to aligned stair halls.`);
    }
    const key = `stair|${pairKey(fromNodeId, toNodeId)}|${run.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const id = createGeneratedId(['circulation', 'stair-run', run.id], used);
    used.add(id);
    edges.push({
      id,
      sourceType: 'stair_run',
      sourceId: run.id,
      fromNodeId,
      toNodeId,
      traversal: 'stair',
    });
  }
  return edges.sort((left, right) => compareCodePoints(left.id, right.id));
}

/** Iterative graph traversal; rectangle contact never creates an implicit connection. */
export function evaluateCirculation(
  exteriorEntranceNodeId: string,
  spaces: readonly ArchitectureSpace[],
  edges: readonly ArchitectureCirculationEdge[],
): CirculationEvaluation {
  const adjacency = new Map<string, Set<string>>();
  const add = (from: string, to: string): void => {
    const neighbors = adjacency.get(from);
    if (neighbors === undefined) adjacency.set(from, new Set([to]));
    else neighbors.add(to);
  };
  for (const edge of edges) {
    add(edge.fromNodeId, edge.toNodeId);
    add(edge.toNodeId, edge.fromNodeId);
  }

  const reachable = new Set<string>();
  const queue: string[] = [exteriorEntranceNodeId];
  let cursor = 0;
  reachable.add(exteriorEntranceNodeId);
  while (cursor < queue.length) {
    const current = queue[cursor];
    cursor += 1;
    if (current === undefined) continue;
    const neighbors = [...(adjacency.get(current) ?? [])].sort(compareCodePoints);
    for (const neighbor of neighbors) {
      if (reachable.has(neighbor)) continue;
      reachable.add(neighbor);
      queue.push(neighbor);
    }
  }

  const required = spaces.map((space) => space.id).sort(compareCodePoints);
  const unreachableNodeIds = required.filter((id) => !reachable.has(id));
  const roomIds = spaces
    .filter((space) => space.type === 'room')
    .map((space) => space.id)
    .sort(compareCodePoints);
  return {
    allRoomsReachable: roomIds.every((id) => reachable.has(id)),
    allRequiredNodesReachable: unreachableNodeIds.length === 0,
    reachableNodeIds: [...reachable].sort(compareCodePoints),
    unreachableNodeIds,
  };
}
