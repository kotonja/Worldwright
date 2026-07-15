import { diagnostic, sortDiagnostics, type RobloxDiagnostic } from './diagnostics.js';
import { jsonValuesEqual } from './json.js';
import {
  hashRobloxSnapshot,
  normalizeRobloxChangeSet,
  normalizeRobloxManagedNode,
  normalizeRobloxSnapshot,
} from './normalize.js';
import { planRobloxSnapshotTransition } from './reconcile.js';
import { validateRobloxChangeSet, validateRobloxSnapshot } from './contract-validation.js';
import type {
  RobloxChangeOperation,
  RobloxManagedNode,
  RobloxSnapshot,
  SimulationResult,
} from './types.js';

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

function wrapInvalid(
  diagnostics: readonly RobloxDiagnostic[],
  code: 'simulation.snapshot_invalid' | 'simulation.change_set_invalid',
): RobloxDiagnostic[] {
  return diagnostics.map((entry) =>
    diagnostic(code, entry.path, `${entry.code}: ${entry.message}`, entry.relatedId),
  );
}

function resultGraphDiagnostic(entry: Readonly<RobloxDiagnostic>): RobloxDiagnostic {
  switch (entry.code) {
    case 'contract.parent_missing':
      return diagnostic('simulation.parent_missing', entry.path, entry.message, entry.relatedId);
    case 'contract.parent_cycle':
      return diagnostic('simulation.parent_cycle', entry.path, entry.message, entry.relatedId);
    default:
      return diagnostic(
        'simulation.snapshot_invalid',
        entry.path,
        `${entry.code}: ${entry.message}`,
        entry.relatedId,
      );
  }
}

function createResultSnapshot(
  base: Readonly<RobloxSnapshot>,
  nodes: readonly RobloxManagedNode[],
): RobloxSnapshot {
  const roots = nodes.filter((node) => node.parentId === undefined);
  return normalizeRobloxSnapshot({
    schemaVersion: base.schemaVersion,
    projectId: base.projectId,
    target: base.target,
    ...(roots.length === 1 ? { rootNodeId: roots[0]!.id } : {}),
    nodes: [...nodes],
    unmanagedRoots: [...base.unmanagedRoots],
  });
}

/** Purely applies and verifies a complete change set against an independent snapshot value. */
export function simulateRobloxChangeSet(
  snapshotInput: unknown,
  changeSetInput: unknown,
): SimulationResult {
  const snapshotValidation = validateRobloxSnapshot(snapshotInput);
  const changeSetValidation = validateRobloxChangeSet(changeSetInput);
  if (!snapshotValidation.valid || !changeSetValidation.valid) {
    return {
      success: false,
      diagnostics: sortDiagnostics([
        ...(snapshotValidation.valid
          ? []
          : wrapInvalid(snapshotValidation.diagnostics, 'simulation.snapshot_invalid')),
        ...(changeSetValidation.valid
          ? []
          : wrapInvalid(changeSetValidation.diagnostics, 'simulation.change_set_invalid')),
      ]),
    };
  }

  const snapshot = normalizeRobloxSnapshot(snapshotValidation.value);
  const changeSet = normalizeRobloxChangeSet(changeSetValidation.value);
  if (snapshot.projectId !== changeSet.preconditions.projectId) {
    return {
      success: false,
      diagnostics: [
        diagnostic(
          'simulation.project_mismatch',
          '/preconditions/projectId',
          'The change set project does not match the snapshot project.',
        ),
      ],
    };
  }
  if (snapshot.target.service !== changeSet.preconditions.target.service) {
    return {
      success: false,
      diagnostics: [
        diagnostic(
          'simulation.target_mismatch',
          '/preconditions/target',
          'The change set target does not match the snapshot target.',
        ),
      ],
    };
  }

  const actualBaseHash = hashRobloxSnapshot(snapshot);
  if (actualBaseHash !== changeSet.preconditions.baseSnapshotHash) {
    return {
      success: false,
      diagnostics: [
        diagnostic(
          'simulation.stale_snapshot',
          '/preconditions/baseSnapshotHash',
          'The complete snapshot hash does not match the change-set precondition.',
        ),
      ],
    };
  }

  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const affectedIds = new Set<string>();
  const diagnostics: RobloxDiagnostic[] = [];
  changeSet.operations.forEach((operation, operationIndex) => {
    const id = operationNodeId(operation);
    if (affectedIds.has(id)) {
      diagnostics.push(
        diagnostic(
          'simulation.change_set_invalid',
          `/operations/${operationIndex}`,
          `Managed node "${id}" is affected more than once.`,
          id,
        ),
      );
      return;
    }
    affectedIds.add(id);

    switch (operation.type) {
      case 'create':
        if (byId.has(id)) {
          diagnostics.push(
            diagnostic(
              'simulation.before_state_mismatch',
              `/operations/${operationIndex}/node/id`,
              `Create expected managed node "${id}" to be absent.`,
              id,
            ),
          );
        } else {
          byId.set(id, normalizeRobloxManagedNode(operation.node));
        }
        break;
      case 'update': {
        const current = byId.get(id);
        if (current === undefined || !jsonValuesEqual(current, operation.before)) {
          diagnostics.push(
            diagnostic(
              'simulation.before_state_mismatch',
              `/operations/${operationIndex}/before`,
              `Update before-state does not match managed node "${id}".`,
              id,
            ),
          );
        } else {
          byId.set(id, normalizeRobloxManagedNode(operation.after));
        }
        break;
      }
      case 'delete': {
        const current = byId.get(id);
        if (current === undefined || !jsonValuesEqual(current, operation.before)) {
          diagnostics.push(
            diagnostic(
              'simulation.before_state_mismatch',
              `/operations/${operationIndex}/before`,
              `Delete before-state does not match managed node "${id}".`,
              id,
            ),
          );
        } else {
          byId.delete(id);
        }
        break;
      }
    }
  });
  if (diagnostics.length > 0) {
    return { success: false, diagnostics: sortDiagnostics(diagnostics) };
  }

  const resultSnapshot = createResultSnapshot(snapshot, [...byId.values()]);
  const resultValidation = validateRobloxSnapshot(resultSnapshot);
  if (!resultValidation.valid) {
    return {
      success: false,
      diagnostics: sortDiagnostics(resultValidation.diagnostics.map(resultGraphDiagnostic)),
    };
  }
  const normalizedResult = normalizeRobloxSnapshot(resultValidation.value);
  const expectedTransition = planRobloxSnapshotTransition(snapshot, normalizedResult);
  if (!expectedTransition.success) {
    return {
      success: false,
      diagnostics: expectedTransition.diagnostics.map((entry) =>
        diagnostic(
          entry.code === 'plan.unmanaged_descendant_conflict'
            ? 'simulation.unmanaged_descendant_conflict'
            : 'simulation.change_set_invalid',
          entry.path,
          entry.message,
          entry.relatedId,
        ),
      ),
    };
  }
  if (!jsonValuesEqual(expectedTransition.operations, changeSet.operations)) {
    return {
      success: false,
      diagnostics: [
        diagnostic(
          'simulation.operation_order_invalid',
          '/operations',
          'Operations do not match the required create, update, and delete execution order.',
        ),
      ],
    };
  }

  const actualResultHash = hashRobloxSnapshot(normalizedResult);
  if (actualResultHash !== changeSet.preconditions.resultSnapshotHash) {
    return {
      success: false,
      diagnostics: [
        diagnostic(
          'simulation.result_hash_mismatch',
          '/preconditions/resultSnapshotHash',
          'The simulated complete result snapshot does not match the expected hash.',
        ),
      ],
    };
  }

  return { success: true, snapshot: normalizedResult, diagnostics: [] };
}
