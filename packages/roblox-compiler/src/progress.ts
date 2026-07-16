import { validateRobloxChangeSet, validateRobloxSnapshot } from './contract-validation.js';
import { diagnostic, sortDiagnostics } from './diagnostics.js';
import { compareCodePoints, jsonValuesEqual } from './json.js';
import {
  hashRobloxChangeSet,
  hashRobloxSnapshot,
  normalizeRobloxChangeSet,
  normalizeRobloxManagedNode,
  normalizeRobloxSnapshot,
} from './normalize.js';
import { simulateRobloxChangeSet } from './simulate.js';
import type {
  RobloxChangeOperation,
  RobloxChangeSet,
  RobloxChangeSetProgressFailure,
  RobloxChangeSetProgressResult,
  RobloxChangeSetProgressSuccess,
  RobloxManagedNode,
  RobloxSnapshot,
} from './types.js';

function operationNodeId(operation: Readonly<RobloxChangeOperation>): string {
  switch (operation.type) {
    case 'create':
      return operation.node.id;
    case 'update':
      return operation.before.id;
    case 'delete':
      return operation.before.id;
  }
}

function wrappedDiagnostics(
  code:
    | 'progress.base_snapshot_invalid'
    | 'progress.observed_snapshot_invalid'
    | 'progress.change_set_invalid'
    | 'progress.operation_precondition_invalid',
  diagnostics: readonly {
    readonly code: string;
    readonly path: string;
    readonly message: string;
    readonly relatedId?: string;
  }[],
) {
  return diagnostics.map((entry) =>
    diagnostic(code, entry.path, `${entry.code}: ${entry.message}`, entry.relatedId),
  );
}

interface ProgressMetadata {
  readonly projectId: string;
  readonly target: Readonly<RobloxSnapshot['target']>;
  readonly baseSnapshotHash: string;
  readonly observedSnapshotHash: string;
  readonly changeSetHash: string;
  readonly operationsTotal: number;
}

function unsafe(
  diagnostics: readonly ReturnType<typeof diagnostic>[],
  metadata?: Readonly<ProgressMetadata>,
): RobloxChangeSetProgressFailure {
  return {
    success: false,
    classification: 'unsafe',
    diagnostics: sortDiagnostics(diagnostics),
    ...(metadata === undefined
      ? {}
      : {
          projectId: metadata.projectId,
          target: { service: 'Workspace' },
          baseSnapshotHash: metadata.baseSnapshotHash,
          observedSnapshotHash: metadata.observedSnapshotHash,
          changeSetHash: metadata.changeSetHash,
          operationsTotal: metadata.operationsTotal,
        }),
  };
}

function success(
  classification: RobloxChangeSetProgressSuccess['classification'],
  appliedPrefixLength: number,
  changeSet: Readonly<RobloxChangeSet>,
  metadata: Readonly<ProgressMetadata>,
): RobloxChangeSetProgressSuccess {
  const nextOperation = changeSet.operations[appliedPrefixLength];
  return {
    success: true,
    classification,
    projectId: metadata.projectId,
    target: { service: 'Workspace' },
    baseSnapshotHash: metadata.baseSnapshotHash,
    observedSnapshotHash: metadata.observedSnapshotHash,
    changeSetHash: metadata.changeSetHash,
    operationsTotal: metadata.operationsTotal,
    appliedPrefixLength,
    ...(nextOperation === undefined ? {} : { nextOperationId: nextOperation.id }),
    diagnostics: [],
  };
}

function nodesMatch(
  left: Readonly<RobloxManagedNode> | undefined,
  right: Readonly<RobloxManagedNode> | undefined,
): boolean {
  return jsonValuesEqual(left, right);
}

function expectedTargetStates(
  operation: Readonly<RobloxChangeOperation>,
): readonly (Readonly<RobloxManagedNode> | undefined)[] {
  switch (operation.type) {
    case 'create':
      return [undefined, operation.node];
    case 'update':
      return [operation.before, operation.after];
    case 'delete':
      return [operation.before, undefined];
  }
}

function outsidePrefixEnvelopeDiagnostics(
  base: Readonly<RobloxSnapshot>,
  observed: Readonly<RobloxSnapshot>,
  changeSet: Readonly<RobloxChangeSet>,
) {
  const diagnostics: ReturnType<typeof diagnostic>[] = [];
  const baseById = new Map(base.nodes.map((node) => [node.id, node]));
  const observedById = new Map(observed.nodes.map((node) => [node.id, node]));
  const operationByNodeId = new Map(
    changeSet.operations.map((operation) => [operationNodeId(operation), operation]),
  );
  const nodeIds = [...new Set([...baseById.keys(), ...observedById.keys()])].sort(
    compareCodePoints,
  );
  for (const nodeId of nodeIds) {
    const operation = operationByNodeId.get(nodeId);
    const observedNode = observedById.get(nodeId);
    if (operation === undefined) {
      if (!nodesMatch(baseById.get(nodeId), observedNode)) {
        diagnostics.push(
          diagnostic(
            'progress.not_exact_prefix',
            `/nodes/${nodeId}`,
            'Observed managed state contains a change unrelated to the authorized operation sequence.',
            nodeId,
          ),
        );
      }
      continue;
    }
    if (!expectedTargetStates(operation).some((state) => nodesMatch(state, observedNode))) {
      diagnostics.push(
        diagnostic(
          'progress.not_exact_prefix',
          `/nodes/${nodeId}`,
          'Observed operation target is in neither its exact before state nor its exact after state.',
          nodeId,
        ),
      );
    }
  }
  return diagnostics;
}

function applyExpectedOperation(
  expectedById: Map<string, RobloxManagedNode>,
  operation: Readonly<RobloxChangeOperation>,
  operationIndex: number,
) {
  const nodeId = operationNodeId(operation);
  const current = expectedById.get(nodeId);
  switch (operation.type) {
    case 'create':
      if (current !== undefined) {
        return diagnostic(
          'progress.operation_precondition_invalid',
          `/operations/${operationIndex}/node`,
          'Create operation does not start from an absent managed node.',
          nodeId,
        );
      }
      expectedById.set(nodeId, normalizeRobloxManagedNode(operation.node));
      return undefined;
    case 'update':
      if (!nodesMatch(current, operation.before)) {
        return diagnostic(
          'progress.operation_precondition_invalid',
          `/operations/${operationIndex}/before`,
          'Update operation before state does not match its exact expected prefix state.',
          nodeId,
        );
      }
      expectedById.set(nodeId, normalizeRobloxManagedNode(operation.after));
      return undefined;
    case 'delete':
      if (!nodesMatch(current, operation.before)) {
        return diagnostic(
          'progress.operation_precondition_invalid',
          `/operations/${operationIndex}/before`,
          'Delete operation before state does not match its exact expected prefix state.',
          nodeId,
        );
      }
      expectedById.delete(nodeId);
      return undefined;
  }
}

/** Classifies an observed complete snapshot against the exact canonical operation prefix it equals. */
export function classifyRobloxChangeSetProgress(
  baseSnapshotInput: unknown,
  observedSnapshotInput: unknown,
  changeSetInput: unknown,
): RobloxChangeSetProgressResult {
  const baseValidation = validateRobloxSnapshot(baseSnapshotInput);
  const observedValidation = validateRobloxSnapshot(observedSnapshotInput);
  const changeSetValidation = validateRobloxChangeSet(changeSetInput);
  if (!baseValidation.valid || !observedValidation.valid || !changeSetValidation.valid) {
    return unsafe([
      ...(baseValidation.valid
        ? []
        : wrappedDiagnostics('progress.base_snapshot_invalid', baseValidation.diagnostics)),
      ...(observedValidation.valid
        ? []
        : wrappedDiagnostics('progress.observed_snapshot_invalid', observedValidation.diagnostics)),
      ...(changeSetValidation.valid
        ? []
        : wrappedDiagnostics('progress.change_set_invalid', changeSetValidation.diagnostics)),
    ]);
  }

  const base = normalizeRobloxSnapshot(baseValidation.value);
  const observed = normalizeRobloxSnapshot(observedValidation.value);
  const changeSet = normalizeRobloxChangeSet(changeSetValidation.value);
  const metadata: ProgressMetadata = {
    projectId: changeSet.preconditions.projectId,
    target: { service: 'Workspace' },
    baseSnapshotHash: hashRobloxSnapshot(base),
    observedSnapshotHash: hashRobloxSnapshot(observed),
    changeSetHash: hashRobloxChangeSet(changeSet),
    operationsTotal: changeSet.operations.length,
  };

  const scopeDiagnostics: ReturnType<typeof diagnostic>[] = [];
  if (metadata.baseSnapshotHash !== changeSet.preconditions.baseSnapshotHash) {
    scopeDiagnostics.push(
      diagnostic(
        'progress.base_hash_mismatch',
        '/preconditions/baseSnapshotHash',
        'The normalized base snapshot does not match the change-set base hash.',
      ),
    );
  }
  if (
    base.projectId !== changeSet.preconditions.projectId ||
    observed.projectId !== changeSet.preconditions.projectId
  ) {
    scopeDiagnostics.push(
      diagnostic(
        'progress.project_mismatch',
        '/projectId',
        'Base, observed, and change-set project identities must match exactly.',
      ),
    );
  }
  if (
    !jsonValuesEqual(base.target, changeSet.preconditions.target) ||
    !jsonValuesEqual(observed.target, changeSet.preconditions.target)
  ) {
    scopeDiagnostics.push(
      diagnostic(
        'progress.target_mismatch',
        '/target',
        'Base, observed, and change-set targets must match exactly.',
      ),
    );
  }
  if (!jsonValuesEqual(base.unmanagedRoots, observed.unmanagedRoots)) {
    scopeDiagnostics.push(
      diagnostic(
        'progress.unmanaged_changed',
        '/unmanagedRoots',
        'Observed unmanaged-root boundaries differ from the exact base snapshot.',
      ),
    );
  }
  if (scopeDiagnostics.length > 0) return unsafe(scopeDiagnostics, metadata);

  const preflight = simulateRobloxChangeSet(base, changeSet);
  if (!preflight.success) {
    return unsafe(
      wrappedDiagnostics('progress.operation_precondition_invalid', preflight.diagnostics),
      metadata,
    );
  }

  const envelopeDiagnostics = outsidePrefixEnvelopeDiagnostics(base, observed, changeSet);
  if (envelopeDiagnostics.length > 0) return unsafe(envelopeDiagnostics, metadata);

  const expectedById = new Map(
    base.nodes.map((node) => [node.id, normalizeRobloxManagedNode(node)]),
  );
  const observedById = new Map(observed.nodes.map((node) => [node.id, node]));
  let mismatchCount = 0;
  for (const nodeId of new Set([...expectedById.keys(), ...observedById.keys()])) {
    if (!nodesMatch(expectedById.get(nodeId), observedById.get(nodeId))) mismatchCount += 1;
  }
  if (mismatchCount === 0) return success('base', 0, changeSet, metadata);

  for (let index = 0; index < changeSet.operations.length; index += 1) {
    const operation = changeSet.operations[index]!;
    const nodeId = operationNodeId(operation);
    const mismatchedBefore = !nodesMatch(expectedById.get(nodeId), observedById.get(nodeId));
    const operationDiagnostic = applyExpectedOperation(expectedById, operation, index);
    if (operationDiagnostic !== undefined) return unsafe([operationDiagnostic], metadata);
    const mismatchedAfter = !nodesMatch(expectedById.get(nodeId), observedById.get(nodeId));
    mismatchCount += Number(mismatchedAfter) - Number(mismatchedBefore);
    if (mismatchCount === 0) {
      const appliedPrefixLength = index + 1;
      return success(
        appliedPrefixLength === changeSet.operations.length ? 'complete' : 'prefix',
        appliedPrefixLength,
        changeSet,
        metadata,
      );
    }
  }

  return unsafe(
    [
      diagnostic(
        'progress.not_exact_prefix',
        '/nodes',
        'Observed managed state is not equal to any exact canonical operation prefix.',
      ),
    ],
    metadata,
  );
}
