import { compareCodePoints } from './json.js';
import type { RobloxManagedNode, RobloxSnapshot } from './types.js';

export interface RobloxOwnershipAnalysis {
  readonly protectedWitnessByNodeId: ReadonlyMap<string, string>;
}

export function managedNodeDepths(
  nodes: readonly RobloxManagedNode[],
  rootNodeId: string | undefined,
): Map<string, number> {
  const depths = new Map<string, number>();
  if (rootNodeId === undefined) return depths;

  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId === undefined) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.id);
    children.set(node.parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort(compareCodePoints);

  depths.set(rootNodeId, 0);
  const queue = [rootNodeId];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const parentId = queue[cursor]!;
    const parentDepth = depths.get(parentId)!;
    for (const childId of children.get(parentId) ?? []) {
      if (depths.has(childId)) continue;
      depths.set(childId, parentDepth + 1);
      queue.push(childId);
    }
  }
  return depths;
}

/** Maps every protected managed node to its deterministic unmanaged-root witness. */
export function analyzeRobloxSnapshotOwnership(
  snapshot: Readonly<RobloxSnapshot>,
): RobloxOwnershipAnalysis {
  const depths = managedNodeDepths(snapshot.nodes, snapshot.rootNodeId);
  const protectedWitnessByNodeId = new Map<string, string>();
  for (const unmanaged of snapshot.unmanagedRoots) {
    const current = protectedWitnessByNodeId.get(unmanaged.parentNodeId);
    if (current === undefined || compareCodePoints(unmanaged.snapshotId, current) < 0) {
      protectedWitnessByNodeId.set(unmanaged.parentNodeId, unmanaged.snapshotId);
    }
  }

  const byDescendingDepth = [...snapshot.nodes].sort((left, right) => {
    const byDepth = (depths.get(right.id) ?? 0) - (depths.get(left.id) ?? 0);
    return byDepth !== 0 ? byDepth : compareCodePoints(left.id, right.id);
  });
  for (const node of byDescendingDepth) {
    const witness = protectedWitnessByNodeId.get(node.id);
    if (witness === undefined || node.parentId === undefined) continue;
    const parentWitness = protectedWitnessByNodeId.get(node.parentId);
    if (parentWitness === undefined || compareCodePoints(witness, parentWitness) < 0) {
      protectedWitnessByNodeId.set(node.parentId, witness);
    }
  }

  return { protectedWitnessByNodeId };
}
