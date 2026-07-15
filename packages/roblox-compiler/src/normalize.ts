import { createHash } from 'node:crypto';

import type {
  RobloxChangeOperation,
  RobloxChangeSet,
  RobloxManagedAttributes,
  RobloxManagedNode,
  RobloxManifest,
  RobloxSnapshot,
  RobloxUnmanagedRoot,
} from './types.js';
import { compareCodePoints, stringifyCanonicalJson, type JsonValue } from './json.js';

function canonicalNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function normalizeAttributes(
  attributes: Readonly<RobloxManagedAttributes>,
): RobloxManagedAttributes {
  return {
    WorldwrightManaged: true,
    WorldwrightProjectId: attributes.WorldwrightProjectId,
    WorldwrightEntityId: attributes.WorldwrightEntityId,
    WorldwrightEntityKind: attributes.WorldwrightEntityKind,
    WorldwrightCompilerVersion: attributes.WorldwrightCompilerVersion,
    ...(attributes.WorldwrightSourceHash === undefined
      ? {}
      : { WorldwrightSourceHash: attributes.WorldwrightSourceHash }),
  };
}

/** Returns a deep, independent managed node with intentional property ordering. */
export function normalizeRobloxManagedNode(node: Readonly<RobloxManagedNode>): RobloxManagedNode {
  const common = {
    id: node.id,
    entityKind: node.entityKind,
    name: node.name,
    ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
    attributes: normalizeAttributes(node.attributes),
  } as const;

  switch (node.className) {
    case 'Folder':
    case 'Model':
      return {
        ...common,
        className: node.className,
        properties: {},
      };
    case 'Part':
      return {
        ...common,
        className: 'Part',
        properties: {
          position: {
            x: canonicalNumber(node.properties.position.x),
            y: canonicalNumber(node.properties.position.y),
            z: canonicalNumber(node.properties.position.z),
          },
          rotationEulerDegreesXYZ: {
            x: canonicalNumber(node.properties.rotationEulerDegreesXYZ.x),
            y: canonicalNumber(node.properties.rotationEulerDegreesXYZ.y),
            z: canonicalNumber(node.properties.rotationEulerDegreesXYZ.z),
          },
          size: {
            x: canonicalNumber(node.properties.size.x),
            y: canonicalNumber(node.properties.size.y),
            z: canonicalNumber(node.properties.size.z),
          },
          anchored: true,
          shape: node.properties.shape,
          material: node.properties.material,
          color: {
            r: canonicalNumber(node.properties.color.r),
            g: canonicalNumber(node.properties.color.g),
            b: canonicalNumber(node.properties.color.b),
          },
          transparency: canonicalNumber(node.properties.transparency),
          canCollide: node.properties.canCollide,
          canQuery: node.properties.canQuery,
          canTouch: node.properties.canTouch,
          castShadow: node.properties.castShadow,
        },
      };
    case 'WedgePart':
    case 'CornerWedgePart':
      return {
        ...common,
        className: node.className,
        properties: {
          position: {
            x: canonicalNumber(node.properties.position.x),
            y: canonicalNumber(node.properties.position.y),
            z: canonicalNumber(node.properties.position.z),
          },
          rotationEulerDegreesXYZ: {
            x: canonicalNumber(node.properties.rotationEulerDegreesXYZ.x),
            y: canonicalNumber(node.properties.rotationEulerDegreesXYZ.y),
            z: canonicalNumber(node.properties.rotationEulerDegreesXYZ.z),
          },
          size: {
            x: canonicalNumber(node.properties.size.x),
            y: canonicalNumber(node.properties.size.y),
            z: canonicalNumber(node.properties.size.z),
          },
          anchored: true,
          material: node.properties.material,
          color: {
            r: canonicalNumber(node.properties.color.r),
            g: canonicalNumber(node.properties.color.g),
            b: canonicalNumber(node.properties.color.b),
          },
          transparency: canonicalNumber(node.properties.transparency),
          canCollide: node.properties.canCollide,
          canQuery: node.properties.canQuery,
          canTouch: node.properties.canTouch,
          castShadow: node.properties.castShadow,
        },
      };
  }
}

function normalizeUnmanagedRoot(root: Readonly<RobloxUnmanagedRoot>): RobloxUnmanagedRoot {
  return {
    snapshotId: root.snapshotId,
    parentNodeId: root.parentNodeId,
    name: root.name,
  };
}

export function normalizeRobloxManifest(input: Readonly<RobloxManifest>): RobloxManifest {
  return {
    schemaVersion: input.schemaVersion,
    compilerVersion: input.compilerVersion,
    source: {
      worldSpecSchemaVersion: input.source.worldSpecSchemaVersion,
      projectId: input.source.projectId,
      worldSpecHash: input.source.worldSpecHash,
    },
    target: { service: 'Workspace' },
    rootNodeId: input.rootNodeId,
    nodes: input.nodes
      .map((node) => normalizeRobloxManagedNode(node))
      .sort((left, right) => compareCodePoints(left.id, right.id)),
    measurements: {
      instances: canonicalNumber(input.measurements.instances),
      containers: canonicalNumber(input.measurements.containers),
      primitives: canonicalNumber(input.measurements.primitives),
    },
  };
}

export function normalizeRobloxSnapshot(input: Readonly<RobloxSnapshot>): RobloxSnapshot {
  return {
    schemaVersion: input.schemaVersion,
    projectId: input.projectId,
    target: { service: 'Workspace' },
    ...(input.rootNodeId === undefined ? {} : { rootNodeId: input.rootNodeId }),
    nodes: input.nodes
      .map((node) => normalizeRobloxManagedNode(node))
      .sort((left, right) => compareCodePoints(left.id, right.id)),
    unmanagedRoots: input.unmanagedRoots
      .map((root) => normalizeUnmanagedRoot(root))
      .sort((left, right) => {
        const byId = compareCodePoints(left.snapshotId, right.snapshotId);
        if (byId !== 0) return byId;
        const byParent = compareCodePoints(left.parentNodeId, right.parentNodeId);
        return byParent !== 0 ? byParent : compareCodePoints(left.name, right.name);
      }),
  };
}

function normalizeOperation(operation: Readonly<RobloxChangeOperation>): RobloxChangeOperation {
  switch (operation.type) {
    case 'create':
      return {
        id: operation.id,
        type: 'create',
        node: normalizeRobloxManagedNode(operation.node),
      };
    case 'update':
      return {
        id: operation.id,
        type: 'update',
        before: normalizeRobloxManagedNode(operation.before),
        after: normalizeRobloxManagedNode(operation.after),
      };
    case 'delete':
      return {
        id: operation.id,
        type: 'delete',
        before: normalizeRobloxManagedNode(operation.before),
      };
  }
}

export function normalizeRobloxChangeSet(input: Readonly<RobloxChangeSet>): RobloxChangeSet {
  return {
    schemaVersion: input.schemaVersion,
    compilerVersion: input.compilerVersion,
    preconditions: {
      projectId: input.preconditions.projectId,
      target: { service: 'Workspace' },
      baseSnapshotHash: input.preconditions.baseSnapshotHash,
      desiredManifestHash: input.preconditions.desiredManifestHash,
      resultSnapshotHash: input.preconditions.resultSnapshotHash,
    },
    operations: input.operations.map((operation) => normalizeOperation(operation)),
    summary: {
      creates: canonicalNumber(input.summary.creates),
      updates: canonicalNumber(input.summary.updates),
      deletes: canonicalNumber(input.summary.deletes),
      total: canonicalNumber(input.summary.total),
    },
  };
}

export function stringifyRobloxManifest(input: Readonly<RobloxManifest>): string {
  return stringifyCanonicalJson(normalizeRobloxManifest(input) as unknown as JsonValue);
}

export function stringifyRobloxSnapshot(input: Readonly<RobloxSnapshot>): string {
  return stringifyCanonicalJson(normalizeRobloxSnapshot(input) as unknown as JsonValue);
}

export function stringifyRobloxChangeSet(input: Readonly<RobloxChangeSet>): string {
  return stringifyCanonicalJson(normalizeRobloxChangeSet(input) as unknown as JsonValue);
}

export function sha256Hex(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

export function hashRobloxManifest(input: Readonly<RobloxManifest>): string {
  return sha256Hex(stringifyRobloxManifest(input));
}

export function hashRobloxSnapshot(input: Readonly<RobloxSnapshot>): string {
  return sha256Hex(stringifyRobloxSnapshot(input));
}

export function hashRobloxManagedSnapshotState(input: Readonly<RobloxSnapshot>): string {
  const normalized = normalizeRobloxSnapshot(input);
  return sha256Hex(
    stringifyCanonicalJson({
      ...(normalized.rootNodeId === undefined ? {} : { rootNodeId: normalized.rootNodeId }),
      nodes: normalized.nodes,
    } as unknown as JsonValue),
  );
}

export function hashRobloxChangeSet(input: Readonly<RobloxChangeSet>): string {
  return sha256Hex(stringifyRobloxChangeSet(input));
}
