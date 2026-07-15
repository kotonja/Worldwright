import { describe, expect, it } from 'vitest';

import {
  validateRobloxChangeSet,
  validateRobloxManifest,
  validateRobloxSnapshot,
} from '../src/contract-validation.js';
import {
  normalizeRobloxChangeSet,
  normalizeRobloxManifest,
  normalizeRobloxSnapshot,
} from '../src/normalize.js';
import { planRobloxChangeSet } from '../src/reconcile.js';
import type { RobloxChangeSet, RobloxManagedNode } from '../src/types.js';
import {
  clone,
  compilePrimitiveFixture,
  emptySnapshotForManifest,
  nodeById,
  snapshotFromManifest,
} from './helpers.js';

function diagnosticCodes(result: {
  readonly diagnostics: readonly { readonly code: string }[];
}): string[] {
  return result.diagnostics.map((entry) => entry.code);
}

function changeSetForFixture(): RobloxChangeSet {
  const manifest = compilePrimitiveFixture();
  const plan = planRobloxChangeSet(emptySnapshotForManifest(manifest), manifest);
  if (!plan.success) throw new Error(JSON.stringify(plan.diagnostics));
  return plan.changeSet;
}

describe('Roblox compiler contract validation', () => {
  it('accepts generated manifest, populated snapshot, and generated change set contracts', () => {
    const manifest = compilePrimitiveFixture();
    const snapshot = snapshotFromManifest(manifest);
    const changeSet = changeSetForFixture();

    expect(validateRobloxManifest(manifest)).toEqual({
      valid: true,
      value: manifest,
      diagnostics: [],
    });
    expect(validateRobloxSnapshot(snapshot)).toEqual({
      valid: true,
      value: snapshot,
      diagnostics: [],
    });
    expect(validateRobloxChangeSet(changeSet)).toEqual({
      valid: true,
      value: changeSet,
      diagnostics: [],
    });
  });

  it('returns independent normalized values without mutating caller-owned contracts', () => {
    const manifest = compilePrimitiveFixture();
    manifest.nodes.reverse();
    const snapshot = snapshotFromManifest(manifest);
    snapshot.nodes.reverse();
    const changeSet = changeSetForFixture();

    const manifestResult = validateRobloxManifest(manifest);
    const snapshotResult = validateRobloxSnapshot(snapshot);
    const changeSetResult = validateRobloxChangeSet(changeSet);

    expect(manifestResult.valid).toBe(true);
    expect(snapshotResult.valid).toBe(true);
    expect(changeSetResult.valid).toBe(true);
    if (!manifestResult.valid || !snapshotResult.valid || !changeSetResult.valid) {
      throw new Error('Expected all generated contracts to validate.');
    }

    expect(manifestResult.value).toEqual(normalizeRobloxManifest(manifest));
    expect(snapshotResult.value).toEqual(normalizeRobloxSnapshot(snapshot));
    expect(changeSetResult.value).toEqual(normalizeRobloxChangeSet(changeSet));
    expect(manifestResult.value).not.toBe(manifest);
    expect(snapshotResult.value).not.toBe(snapshot);
    expect(changeSetResult.value).not.toBe(changeSet);
    expect(manifestResult.value.nodes[0]).not.toBe(manifest.nodes[0]);
    expect(snapshotResult.value.nodes[0]).not.toBe(snapshot.nodes[0]);
    expect(changeSetResult.value.operations[0]).not.toBe(changeSet.operations[0]);
  });

  it('enforces strict top-level manifest, snapshot, and change-set objects', () => {
    const manifest = compilePrimitiveFixture();
    (manifest as unknown as Record<string, unknown>).unknown = true;
    expect(diagnosticCodes(validateRobloxManifest(manifest))).toEqual(['contract.schema_invalid']);

    const snapshot = snapshotFromManifest(compilePrimitiveFixture());
    (snapshot as unknown as Record<string, unknown>).timestamp = 'not-allowed';
    expect(diagnosticCodes(validateRobloxSnapshot(snapshot))).toEqual(['contract.schema_invalid']);

    const changeSet = changeSetForFixture();
    (changeSet as unknown as Record<string, unknown>).hash = '2'.repeat(64);
    expect(diagnosticCodes(validateRobloxChangeSet(changeSet))).toEqual([
      'contract.schema_invalid',
    ]);
  });

  it('rejects unknown node and property fields', () => {
    const unknownNodeField = compilePrimitiveFixture();
    const wall = nodeById(unknownNodeField, 'north-wall');
    (wall as unknown as Record<string, unknown>).tags = ['not-in-contract'];
    expect(diagnosticCodes(validateRobloxManifest(unknownNodeField))).toEqual([
      'contract.schema_invalid',
    ]);

    const unknownProperty = compilePrimitiveFixture();
    const part = nodeById(unknownProperty, 'north-wall');
    (part.properties as unknown as Record<string, unknown>).reflectance = 0.5;
    expect(diagnosticCodes(validateRobloxManifest(unknownProperty))).toEqual([
      'contract.schema_invalid',
    ]);
  });

  it('reports exact discriminated node and operation schema paths', () => {
    const expectPath = (
      result: { readonly diagnostics: readonly { readonly path: string }[] },
      path: string,
    ): void => {
      expect(result.diagnostics).toEqual([expect.objectContaining({ path })]);
    };

    for (const [field, value] of [
      ['material', 'ForceField'],
      ['shape', 'BadShape'],
      ['className', 'MeshPart'],
    ] as const) {
      const manifest = compilePrimitiveFixture();
      const index = manifest.nodes.findIndex((node) => node.id === 'north-wall');
      const node = manifest.nodes[index];
      if (node?.className !== 'Part') throw new Error('Expected fixture Part.');
      if (field === 'className') {
        (node as unknown as Record<string, unknown>).className = value;
      } else {
        (node.properties as unknown as Record<string, unknown>)[field] = value;
      }
      expectPath(
        validateRobloxManifest(manifest),
        `/nodes/${index}/${field === 'className' ? '' : 'properties/'}${field}`,
      );
    }

    const snapshot = snapshotFromManifest(compilePrimitiveFixture());
    const snapshotIndex = snapshot.nodes.findIndex((node) => node.id === 'north-wall');
    const snapshotNode = snapshot.nodes[snapshotIndex];
    if (snapshotNode?.className !== 'Part') throw new Error('Expected snapshot Part.');
    (snapshotNode.properties as unknown as Record<string, unknown>).material = 'ForceField';
    expectPath(validateRobloxSnapshot(snapshot), `/nodes/${snapshotIndex}/properties/material`);

    const manifest = compilePrimitiveFixture();
    const createPlan = planRobloxChangeSet(emptySnapshotForManifest(manifest), manifest);
    if (!createPlan.success) throw new Error(JSON.stringify(createPlan.diagnostics));
    const createIndex = createPlan.changeSet.operations.findIndex(
      (operation) => operation.type === 'create' && operation.node.className === 'Part',
    );
    const create = createPlan.changeSet.operations[createIndex];
    if (create?.type !== 'create' || create.node.className !== 'Part') {
      throw new Error('Expected create Part operation.');
    }
    (create.node.properties as unknown as Record<string, unknown>).material = 'ForceField';
    expectPath(
      validateRobloxChangeSet(createPlan.changeSet),
      `/operations/${createIndex}/node/properties/material`,
    );

    const updateSnapshot = snapshotFromManifest(manifest);
    const updateNode = nodeById({ ...manifest, nodes: updateSnapshot.nodes }, 'north-wall');
    updateNode.name = 'Observed old name';
    const updatePlan = planRobloxChangeSet(updateSnapshot, manifest);
    if (!updatePlan.success) throw new Error(JSON.stringify(updatePlan.diagnostics));
    const update = updatePlan.changeSet.operations[0];
    if (update?.type !== 'update' || update.before.className !== 'Part') {
      throw new Error('Expected update Part operation.');
    }
    (update.before.properties as unknown as Record<string, unknown>).material = 'ForceField';
    expectPath(
      validateRobloxChangeSet(updatePlan.changeSet),
      '/operations/0/before/properties/material',
    );

    const deleteSnapshot = snapshotFromManifest(manifest);
    const obsolete = clone(nodeById(manifest, 'north-wall'));
    obsolete.id = 'obsolete-wall';
    obsolete.name = 'Obsolete Wall';
    obsolete.attributes.WorldwrightEntityId = obsolete.id;
    deleteSnapshot.nodes.push(obsolete);
    const deletePlan = planRobloxChangeSet(deleteSnapshot, manifest);
    if (!deletePlan.success) throw new Error(JSON.stringify(deletePlan.diagnostics));
    const deletion = deletePlan.changeSet.operations[0];
    if (deletion?.type !== 'delete' || deletion.before.className !== 'Part') {
      throw new Error('Expected delete Part operation.');
    }
    (deletion.before.properties as unknown as Record<string, unknown>).material = 'ForceField';
    expectPath(
      validateRobloxChangeSet(deletePlan.changeSet),
      '/operations/0/before/properties/material',
    );
  });

  it('rejects duplicate node IDs independently of exact measurements', () => {
    const manifest = compilePrimitiveFixture();
    const duplicate = clone(nodeById(manifest, 'north-wall'));
    manifest.nodes.push(duplicate);
    manifest.measurements.instances += 1;
    manifest.measurements.primitives += 1;

    const result = validateRobloxManifest(manifest);

    expect(result.valid).toBe(false);
    expect(diagnosticCodes(result)).toContain('contract.id_duplicate');
  });

  it('rejects missing parents and unmanaged roots whose managed parent is missing', () => {
    const manifest = compilePrimitiveFixture();
    const node = nodeById(manifest, 'north-wall');
    node.parentId = 'missing-parent';
    const manifestResult = validateRobloxManifest(manifest);
    expect(manifestResult.valid).toBe(false);
    expect(diagnosticCodes(manifestResult)).toContain('contract.parent_missing');

    const validManifest = compilePrimitiveFixture();
    const snapshot = snapshotFromManifest(validManifest, [
      { snapshotId: 'unmanaged-1', parentNodeId: 'missing-parent', name: 'User Model' },
    ]);
    const snapshotResult = validateRobloxSnapshot(snapshot);
    expect(snapshotResult.valid).toBe(false);
    expect(diagnosticCodes(snapshotResult)).toContain('contract.parent_missing');
  });

  it('detects parent cycles iteratively with stable diagnostics', () => {
    const manifest = compilePrimitiveFixture();
    nodeById(manifest, 'courtyard-region').parentId = 'courtyard-structure';
    nodeById(manifest, 'courtyard-structure').parentId = 'courtyard-region';

    const first = validateRobloxManifest(manifest);
    const second = validateRobloxManifest(clone(manifest));

    expect(first.valid).toBe(false);
    expect(diagnosticCodes(first)).toContain('contract.parent_cycle');
    expect(second).toEqual(first);
  });

  it('rejects an absent, missing, primitive, or parented managed root', () => {
    const missing = compilePrimitiveFixture();
    missing.rootNodeId = 'missing-root';
    expect(diagnosticCodes(validateRobloxManifest(missing))).toContain('contract.root_invalid');

    const primitive = compilePrimitiveFixture();
    primitive.rootNodeId = 'north-wall';
    expect(diagnosticCodes(validateRobloxManifest(primitive))).toContain('contract.root_invalid');

    const parented = compilePrimitiveFixture();
    nodeById(parented, parented.rootNodeId).parentId = 'courtyard-region';
    expect(diagnosticCodes(validateRobloxManifest(parented))).toContain('contract.root_invalid');

    const snapshot = snapshotFromManifest(compilePrimitiveFixture());
    delete snapshot.rootNodeId;
    expect(diagnosticCodes(validateRobloxSnapshot(snapshot))).toContain('contract.root_invalid');
  });

  it('rejects incorrect managed project, entity ID, and entity-kind metadata', () => {
    const manifest = compilePrimitiveFixture();
    const node = nodeById(manifest, 'north-wall');
    node.attributes.WorldwrightProjectId = 'other-project';
    node.attributes.WorldwrightEntityId = 'different-entity';
    node.attributes.WorldwrightEntityKind = 'room';

    const result = validateRobloxManifest(manifest);

    expect(result.valid).toBe(false);
    expect(diagnosticCodes(result)).toEqual([
      'contract.metadata_invalid',
      'contract.metadata_invalid',
      'contract.metadata_invalid',
    ]);
  });

  it('requires source hash metadata on the root, matches it to the manifest, and forbids it elsewhere', () => {
    const missing = compilePrimitiveFixture();
    delete nodeById(missing, missing.rootNodeId).attributes.WorldwrightSourceHash;
    expect(diagnosticCodes(validateRobloxManifest(missing))).toContain('contract.metadata_invalid');

    const mismatched = compilePrimitiveFixture();
    nodeById(mismatched, mismatched.rootNodeId).attributes.WorldwrightSourceHash = '2'.repeat(64);
    expect(diagnosticCodes(validateRobloxManifest(mismatched))).toContain(
      'contract.metadata_invalid',
    );

    const wrongNode = compilePrimitiveFixture();
    nodeById(wrongNode, 'north-wall').attributes.WorldwrightSourceHash = '3'.repeat(64);
    expect(diagnosticCodes(validateRobloxManifest(wrongNode))).toContain(
      'contract.metadata_invalid',
    );
  });

  it('rejects invalid class/property combinations', () => {
    const manifest = compilePrimitiveFixture();
    const part = nodeById(manifest, 'north-wall');
    (part as unknown as { className: string }).className = 'WedgePart';

    const result = validateRobloxManifest(manifest);

    expect(result.valid).toBe(false);
    expect(diagnosticCodes(result)).toEqual(['contract.schema_invalid']);
  });

  it('rejects children of primitive nodes', () => {
    const manifest = compilePrimitiveFixture();
    nodeById(manifest, 'entry-left-pier').parentId = 'north-wall';

    const result = validateRobloxManifest(manifest);

    expect(result.valid).toBe(false);
    expect(diagnosticCodes(result)).toContain('contract.metadata_invalid');
  });

  it('rejects manifest measurement and change-set summary drift', () => {
    const manifest = compilePrimitiveFixture();
    manifest.measurements.instances -= 1;
    expect(diagnosticCodes(validateRobloxManifest(manifest))).toContain(
      'contract.measurements_invalid',
    );

    const changeSet = changeSetForFixture();
    changeSet.summary.creates -= 1;
    expect(diagnosticCodes(validateRobloxChangeSet(changeSet))).toContain(
      'contract.measurements_invalid',
    );
  });

  it('accepts the canonical empty snapshot', () => {
    const snapshot = emptySnapshotForManifest(compilePrimitiveFixture());

    expect(validateRobloxSnapshot(snapshot)).toEqual({
      valid: true,
      value: snapshot,
      diagnostics: [],
    });
  });

  it('rejects non-JSON in-memory values and cycles without exposing an exception', () => {
    const manifest = compilePrimitiveFixture();
    const root = nodeById(manifest, manifest.rootNodeId) as RobloxManagedNode;
    (root as unknown as Record<string, unknown>).execute = (): void => undefined;
    const manifestResult = validateRobloxManifest(manifest);
    expect(manifestResult.valid).toBe(false);
    expect(diagnosticCodes(manifestResult)).toEqual(['contract.schema_invalid']);

    const snapshot = snapshotFromManifest(compilePrimitiveFixture());
    (snapshot as unknown as Record<string, unknown>).self = snapshot;
    const snapshotResult = validateRobloxSnapshot(snapshot);
    expect(snapshotResult.valid).toBe(false);
    expect(diagnosticCodes(snapshotResult)).toEqual(['contract.schema_invalid']);
  });

  it('returns deterministic diagnostics for identical tampered input', () => {
    const manifest = compilePrimitiveFixture();
    nodeById(manifest, 'north-wall').attributes.WorldwrightProjectId = 'other-project';
    nodeById(manifest, 'south-wall').parentId = 'missing-parent';
    manifest.measurements.containers = 0;

    const first = validateRobloxManifest(manifest);
    const second = validateRobloxManifest(clone(manifest));

    expect(first.valid).toBe(false);
    expect(second).toEqual(first);
    expect(first.diagnostics).toEqual(
      [...first.diagnostics].sort((left, right) => {
        const byPath = left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
        if (byPath !== 0) return byPath;
        return left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
      }),
    );
  });

  it('rejects semantic change-set operation ID, identity, and no-op update tampering', () => {
    const valid = changeSetForFixture();
    const first = valid.operations[0];
    if (first === undefined || first.type !== 'create')
      throw new Error('Expected a create operation.');
    first.id = 'create:different-node';
    expect(diagnosticCodes(validateRobloxChangeSet(valid))).toContain('contract.operation_invalid');

    const manifest = compilePrimitiveFixture();
    const current = snapshotFromManifest(manifest);
    const before = clone(nodeById(manifest, 'north-wall'));
    const invalidUpdate: RobloxChangeSet = {
      schemaVersion: '0.1.0',
      compilerVersion: '0.1.0',
      preconditions: {
        projectId: manifest.source.projectId,
        target: { service: 'Workspace' },
        baseSnapshotHash: '0'.repeat(64),
        desiredManifestHash: '1'.repeat(64),
        resultSnapshotHash: '2'.repeat(64),
      },
      operations: [{ id: `update:${before.id}`, type: 'update', before, after: clone(before) }],
      summary: { creates: 0, updates: 1, deletes: 0, total: 1 },
    };
    expect(validateRobloxSnapshot(current).valid).toBe(true);
    expect(diagnosticCodes(validateRobloxChangeSet(invalidUpdate))).toContain(
      'contract.operation_invalid',
    );
  });
});
