import {
  ROBLOX_CHANGE_SET_VERSION,
  ROBLOX_COMPILER_VERSION,
  ROBLOX_SNAPSHOT_VERSION,
} from './contract-schema.js';
import { diagnostic, sortDiagnostics, type RobloxDiagnostic } from './diagnostics.js';
import { compareCodePoints, jsonValuesEqual } from './json.js';
import {
  hashRobloxManifest,
  hashRobloxSnapshot,
  normalizeRobloxManagedNode,
  normalizeRobloxManifest,
  normalizeRobloxSnapshot,
} from './normalize.js';
import { validateRobloxManifest, validateRobloxSnapshot } from './contract-validation.js';
import type {
  PlanResult,
  RobloxChangeOperation,
  RobloxChangeSet,
  RobloxManagedNode,
  RobloxManifest,
  RobloxSnapshot,
} from './types.js';

export type SnapshotTransitionResult =
  | {
      readonly success: true;
      readonly operations: readonly RobloxChangeOperation[];
    }
  | {
      readonly success: false;
      readonly diagnostics: readonly RobloxDiagnostic[];
    };

function nodeMap(nodes: readonly RobloxManagedNode[]): Map<string, RobloxManagedNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

function nodeIndexMap(nodes: readonly RobloxManagedNode[]): Map<string, number> {
  return new Map(nodes.map((node, index) => [node.id, index]));
}

function depthsById(
  nodes: readonly RobloxManagedNode[],
  rootNodeId: string | undefined,
): Map<string, number> {
  const depths = new Map<string, number>();
  if (rootNodeId === undefined) return depths;

  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId !== undefined) {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node.id);
      children.set(node.parentId, siblings);
    }
  }
  for (const siblings of children.values()) siblings.sort(compareCodePoints);

  depths.set(rootNodeId, 0);
  const queue = [rootNodeId];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const parentId = queue[cursor]!;
    const parentDepth = depths.get(parentId)!;
    for (const childId of children.get(parentId) ?? []) {
      if (!depths.has(childId)) {
        depths.set(childId, parentDepth + 1);
        queue.push(childId);
      }
    }
  }
  return depths;
}

function protectedWitnessById(
  snapshot: Readonly<RobloxSnapshot>,
  depths: ReadonlyMap<string, number>,
): Map<string, string> {
  const witnessById = new Map<string, string>();
  for (const unmanaged of snapshot.unmanagedRoots) {
    const current = witnessById.get(unmanaged.parentNodeId);
    if (current === undefined || compareCodePoints(unmanaged.snapshotId, current) < 0) {
      witnessById.set(unmanaged.parentNodeId, unmanaged.snapshotId);
    }
  }

  const byDescendingDepth = [...snapshot.nodes].sort((left, right) => {
    const byDepth = (depths.get(right.id) ?? 0) - (depths.get(left.id) ?? 0);
    return byDepth !== 0 ? byDepth : compareCodePoints(left.id, right.id);
  });
  for (const node of byDescendingDepth) {
    const witness = witnessById.get(node.id);
    if (witness === undefined || node.parentId === undefined) continue;
    const parentWitness = witnessById.get(node.parentId);
    if (parentWitness === undefined || compareCodePoints(witness, parentWitness) < 0) {
      witnessById.set(node.parentId, witness);
    }
  }
  return witnessById;
}

function operationNodeId(operation: Readonly<RobloxChangeOperation>): string {
  switch (operation.type) {
    case 'create':
      return operation.node.id;
    case 'update':
      return operation.after.id;
    case 'delete':
      return operation.before.id;
  }
}

export function canonicalOperationOrder(
  operations: readonly RobloxChangeOperation[],
  currentDepths: ReadonlyMap<string, number>,
  desiredDepths: ReadonlyMap<string, number>,
): RobloxChangeOperation[] {
  const phase = (operation: Readonly<RobloxChangeOperation>): number => {
    switch (operation.type) {
      case 'create':
        return 0;
      case 'update':
        return 1;
      case 'delete':
        return 2;
    }
  };

  return [...operations].sort((left, right) => {
    const byPhase = phase(left) - phase(right);
    if (byPhase !== 0) return byPhase;
    const leftId = operationNodeId(left);
    const rightId = operationNodeId(right);
    const leftDepth =
      left.type === 'delete' ? (currentDepths.get(leftId) ?? 0) : (desiredDepths.get(leftId) ?? 0);
    const rightDepth =
      right.type === 'delete'
        ? (currentDepths.get(rightId) ?? 0)
        : (desiredDepths.get(rightId) ?? 0);
    const byDepth = left.type === 'delete' ? rightDepth - leftDepth : leftDepth - rightDepth;
    return byDepth !== 0 ? byDepth : compareCodePoints(leftId, rightId);
  });
}

/** Internal pure planner used by public reconciliation and verified compensation. */
export function planRobloxSnapshotTransition(
  currentInput: Readonly<RobloxSnapshot>,
  desiredInput: Readonly<RobloxSnapshot>,
  desiredInputIndexById?: ReadonlyMap<string, number>,
): SnapshotTransitionResult {
  const current = normalizeRobloxSnapshot(currentInput);
  const desired = normalizeRobloxSnapshot(desiredInput);
  const diagnostics: RobloxDiagnostic[] = [];

  if (current.projectId !== desired.projectId) {
    diagnostics.push(
      diagnostic(
        'plan.project_mismatch',
        '/projectId',
        'Current and desired snapshots belong to different projects.',
      ),
    );
  }
  if (current.target.service !== desired.target.service) {
    diagnostics.push(
      diagnostic(
        'plan.target_mismatch',
        '/target',
        'Current and desired snapshots use different targets.',
      ),
    );
  }
  if (
    current.rootNodeId !== undefined &&
    desired.rootNodeId !== undefined &&
    current.rootNodeId !== desired.rootNodeId
  ) {
    diagnostics.push(
      diagnostic(
        'plan.root_change_unsupported',
        '/rootNodeId',
        'Replacing a non-empty managed root requires an explicit future migration.',
        desired.rootNodeId,
      ),
    );
  }
  if (diagnostics.length > 0) {
    return { success: false, diagnostics: sortDiagnostics(diagnostics) };
  }

  const currentById = nodeMap(current.nodes);
  const desiredById = nodeMap(desired.nodes);
  const desiredIndexById = desiredInputIndexById ?? nodeIndexMap(desired.nodes);
  const currentDepths = depthsById(current.nodes, current.rootNodeId);
  const desiredDepths = depthsById(desired.nodes, desired.rootNodeId);
  const protectedById = protectedWitnessById(current, currentDepths);
  const operations: RobloxChangeOperation[] = [];
  const allIds = new Set([...currentById.keys(), ...desiredById.keys()]);

  for (const id of [...allIds].sort(compareCodePoints)) {
    const before = currentById.get(id);
    const after = desiredById.get(id);
    if (before === undefined && after !== undefined) {
      operations.push({
        id: `create:${id}`,
        type: 'create',
        node: normalizeRobloxManagedNode(after),
      });
      continue;
    }
    if (before !== undefined && after === undefined) {
      const witness = protectedById.get(id);
      if (witness !== undefined) {
        diagnostics.push(
          diagnostic(
            'plan.unmanaged_descendant_conflict',
            '/unmanagedRoots',
            `Managed node "${id}" cannot be deleted because its subtree contains unmanaged content.`,
            witness,
          ),
        );
      } else {
        operations.push({
          id: `delete:${id}`,
          type: 'delete',
          before: normalizeRobloxManagedNode(before),
        });
      }
      continue;
    }
    if (before === undefined || after === undefined) continue;

    if (before.className !== after.className) {
      diagnostics.push(
        diagnostic(
          'plan.class_change_unsupported',
          `/nodes/${desiredIndexById.get(id)!}/className`,
          `Managed node "${id}" cannot change class from ${before.className} to ${after.className}.`,
          id,
        ),
      );
      continue;
    }
    if (jsonValuesEqual(before, after)) continue;

    if (before.parentId !== after.parentId) {
      const witness = protectedById.get(id);
      if (witness !== undefined) {
        diagnostics.push(
          diagnostic(
            'plan.unmanaged_descendant_conflict',
            `/nodes/${desiredIndexById.get(id)!}/parentId`,
            `Managed node "${id}" cannot be reparented because its subtree contains unmanaged content.`,
            witness,
          ),
        );
        continue;
      }
    }
    operations.push({
      id: `update:${id}`,
      type: 'update',
      before: normalizeRobloxManagedNode(before),
      after: normalizeRobloxManagedNode(after),
    });
  }

  if (diagnostics.length > 0) {
    return { success: false, diagnostics: sortDiagnostics(diagnostics) };
  }
  return {
    success: true,
    operations: canonicalOperationOrder(operations, currentDepths, desiredDepths),
  };
}

function wrapValidationDiagnostics(
  diagnostics: readonly RobloxDiagnostic[],
  code: 'plan.manifest_invalid' | 'plan.snapshot_invalid',
): RobloxDiagnostic[] {
  return diagnostics.map((entry) =>
    diagnostic(code, entry.path, `${entry.code}: ${entry.message}`, entry.relatedId),
  );
}

/** Produces a deterministic, side-effect-free desired-state change set. */
export function planRobloxChangeSet(currentInput: unknown, desiredInput: unknown): PlanResult {
  const currentValidation = validateRobloxSnapshot(currentInput);
  const desiredValidation = validateRobloxManifest(desiredInput);
  const validationDiagnostics = [
    ...(currentValidation.valid
      ? []
      : wrapValidationDiagnostics(currentValidation.diagnostics, 'plan.snapshot_invalid')),
    ...(desiredValidation.valid
      ? []
      : wrapValidationDiagnostics(desiredValidation.diagnostics, 'plan.manifest_invalid')),
  ];
  if (!currentValidation.valid || !desiredValidation.valid) {
    return { success: false, diagnostics: sortDiagnostics(validationDiagnostics) };
  }

  const current = normalizeRobloxSnapshot(currentValidation.value);
  const manifest = normalizeRobloxManifest(desiredValidation.value);
  const desiredInputIndexById = nodeIndexMap((desiredInput as RobloxManifest).nodes);
  if (current.projectId !== manifest.source.projectId) {
    return {
      success: false,
      diagnostics: [
        diagnostic(
          'plan.project_mismatch',
          '/projectId',
          'The snapshot project does not match the manifest source project.',
        ),
      ],
    };
  }
  if (current.target.service !== manifest.target.service) {
    return {
      success: false,
      diagnostics: [
        diagnostic(
          'plan.target_mismatch',
          '/target',
          'The snapshot target does not match the manifest target.',
        ),
      ],
    };
  }

  const expectedSnapshot: RobloxSnapshot = normalizeRobloxSnapshot({
    schemaVersion: ROBLOX_SNAPSHOT_VERSION,
    projectId: manifest.source.projectId,
    target: manifest.target,
    rootNodeId: manifest.rootNodeId,
    nodes: manifest.nodes,
    unmanagedRoots: current.unmanagedRoots,
  });
  const transition = planRobloxSnapshotTransition(current, expectedSnapshot, desiredInputIndexById);
  if (!transition.success) return transition;

  const creates = transition.operations.filter((operation) => operation.type === 'create').length;
  const updates = transition.operations.filter((operation) => operation.type === 'update').length;
  const deletes = transition.operations.filter((operation) => operation.type === 'delete').length;
  const changeSet: RobloxChangeSet = {
    schemaVersion: ROBLOX_CHANGE_SET_VERSION,
    compilerVersion: ROBLOX_COMPILER_VERSION,
    preconditions: {
      projectId: manifest.source.projectId,
      target: manifest.target,
      baseSnapshotHash: hashRobloxSnapshot(current),
      desiredManifestHash: hashRobloxManifest(manifest),
      resultSnapshotHash: hashRobloxSnapshot(expectedSnapshot),
    },
    operations: [...transition.operations],
    summary: {
      creates,
      updates,
      deletes,
      total: transition.operations.length,
    },
  };
  return { success: true, changeSet, expectedSnapshot, diagnostics: [] };
}
