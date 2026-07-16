import { Buffer } from 'node:buffer';

import type { RobloxManagedNode } from '@worldwright/roblox-compiler';

import {
  STUDIO_MCP_ADAPTER_VERSION,
  STUDIO_MCP_ENGINE_EPSILON,
  STUDIO_MCP_MAX_NODE_STATE_BYTES,
} from './constants.js';
import { StudioAdapterError, studioDiagnostic } from './diagnostics.js';
import {
  hashCanonicalJson,
  inspectJsonCompatibility,
  stringifyCanonicalJson,
  type JsonValue,
} from './json.js';
import type { StudioRawManagedNode } from './types.js';

export interface CanonicalNodeMetadata {
  readonly json: string;
  readonly hash: string;
}

function drift(nodeId: string, propertyName: string, message?: string): never {
  throw new StudioAdapterError([
    studioDiagnostic(
      'studio.engine_state_drift',
      `/nodes/${nodeId}/${propertyName}`,
      message ?? `Live ${propertyName} differs from the stored managed-node state.`,
      { relatedId: nodeId },
    ),
  ]);
}

function metadataInvalid(nodeId: string, message: string): never {
  throw new StudioAdapterError([
    studioDiagnostic('studio.adapter_metadata_invalid', `/nodes/${nodeId}`, message, {
      relatedId: nodeId,
    }),
  ]);
}

export function canonicalNodeMetadata(node: Readonly<RobloxManagedNode>): CanonicalNodeMetadata {
  const issue = inspectJsonCompatibility(node);
  if (issue !== undefined) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.adapter_metadata_invalid',
        issue.path,
        `Managed node is not JSON-compatible: ${issue.reason}.`,
        { relatedId: node.id },
      ),
    ]);
  }
  const json = stringifyCanonicalJson(node as JsonValue);
  if (Buffer.byteLength(json, 'utf8') > STUDIO_MCP_MAX_NODE_STATE_BYTES) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.adapter_metadata_too_large',
        `/nodes/${node.id}`,
        `Canonical managed-node state exceeds ${STUDIO_MCP_MAX_NODE_STATE_BYTES} bytes.`,
        { relatedId: node.id },
      ),
    ]);
  }
  return { json, hash: hashCanonicalJson(node as JsonValue) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= STUDIO_MCP_ENGINE_EPSILON;
}

function numericArray(value: unknown, length: number): readonly number[] | undefined {
  return Array.isArray(value) && value.length === length && value.every(finiteNumber)
    ? value
    : undefined;
}

function expectedCFrame(node: Readonly<RobloxManagedNode>): readonly number[] | undefined {
  if (node.className === 'Folder' || node.className === 'Model') return undefined;
  const { position, rotationEulerDegreesXYZ: rotation } = node.properties;
  const x = (rotation.x * Math.PI) / 180;
  const y = (rotation.y * Math.PI) / 180;
  const z = (rotation.z * Math.PI) / 180;
  const cx = Math.cos(x);
  const sx = Math.sin(x);
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cz = Math.cos(z);
  const sz = Math.sin(z);
  return [
    position.x,
    position.y,
    position.z,
    cy * cz,
    -cy * sz,
    sy,
    cx * sz + sx * sy * cz,
    cx * cz - sx * sy * sz,
    -sx * cy,
    sx * sz - cx * sy * cz,
    sx * cz + cx * sy * sz,
    cx * cy,
  ];
}

function compareNumberArray(
  nodeId: string,
  propertyName: string,
  actualValue: unknown,
  expected: readonly number[],
): void {
  const actual = numericArray(actualValue, expected.length);
  if (
    actual === undefined ||
    actual.some((component, index) => !nearlyEqual(component, expected[index]!))
  ) {
    drift(nodeId, propertyName);
  }
}

function verifyPrimitiveProperties(
  raw: Readonly<StudioRawManagedNode>,
  node: Readonly<RobloxManagedNode>,
): void {
  if (node.className === 'Folder' || node.className === 'Model') {
    if (!isRecord(raw.properties) || Object.keys(raw.properties).length !== 0) {
      drift(node.id, 'properties');
    }
    return;
  }
  const actual = raw.properties;
  if (!isRecord(actual)) drift(node.id, 'properties');
  const cframe = expectedCFrame(node)!;
  compareNumberArray(node.id, 'CFrame', actual['cframe'], cframe);
  compareNumberArray(node.id, 'Size', actual['size'], [
    node.properties.size.x,
    node.properties.size.y,
    node.properties.size.z,
  ]);
  compareNumberArray(node.id, 'Color', actual['color'], [
    node.properties.color.r / 255,
    node.properties.color.g / 255,
    node.properties.color.b / 255,
  ]);
  if (actual['anchored'] !== node.properties.anchored) drift(node.id, 'Anchored');
  if (actual['material'] !== node.properties.material) drift(node.id, 'Material');
  if (
    !finiteNumber(actual['transparency']) ||
    !nearlyEqual(actual['transparency'], node.properties.transparency)
  ) {
    drift(node.id, 'Transparency');
  }
  if (actual['canCollide'] !== node.properties.canCollide) drift(node.id, 'CanCollide');
  if (actual['canQuery'] !== node.properties.canQuery) drift(node.id, 'CanQuery');
  if (actual['canTouch'] !== node.properties.canTouch) drift(node.id, 'CanTouch');
  if (actual['castShadow'] !== node.properties.castShadow) drift(node.id, 'CastShadow');
  if (node.className === 'Part') {
    if (actual['shape'] !== node.properties.shape) drift(node.id, 'Shape');
  } else if ('shape' in actual) {
    drift(node.id, 'Shape');
  }
}

function parseStoredNode(raw: Readonly<StudioRawManagedNode>): RobloxManagedNode {
  if (Buffer.byteLength(raw.stateJson, 'utf8') > STUDIO_MCP_MAX_NODE_STATE_BYTES) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.adapter_metadata_too_large',
        `/nodes/${raw.entityId}`,
        `Stored managed-node state exceeds ${STUDIO_MCP_MAX_NODE_STATE_BYTES} bytes.`,
        { relatedId: raw.entityId },
      ),
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.stateJson) as unknown;
  } catch {
    metadataInvalid(raw.entityId, 'Stored managed-node JSON is malformed.');
  }
  const issue = inspectJsonCompatibility(parsed);
  if (issue !== undefined || !isRecord(parsed)) {
    metadataInvalid(raw.entityId, 'Stored managed-node JSON is not a plain JSON object.');
  }
  const canonical = stringifyCanonicalJson(parsed as JsonValue);
  if (canonical !== raw.stateJson) {
    metadataInvalid(raw.entityId, 'Stored managed-node JSON is not canonical.');
  }
  if (hashCanonicalJson(parsed as JsonValue) !== raw.stateHash) {
    metadataInvalid(raw.entityId, 'Stored managed-node state hash does not match its JSON.');
  }
  return parsed as unknown as RobloxManagedNode;
}

export function verifyStudioRawNode(raw: Readonly<StudioRawManagedNode>): RobloxManagedNode {
  if (raw.adapterVersion !== STUDIO_MCP_ADAPTER_VERSION) {
    metadataInvalid(raw.entityId, 'Studio adapter metadata version is missing or unsupported.');
  }
  const node = parseStoredNode(raw);
  if (node.id !== raw.entityId)
    metadataInvalid(raw.entityId, 'Stored node ID does not match the public entity ID.');
  if (node.attributes?.WorldwrightProjectId !== raw.projectId) {
    metadataInvalid(raw.entityId, 'Stored project ID does not match the public project ID.');
  }
  if (node.attributes?.WorldwrightEntityId !== raw.entityId) {
    metadataInvalid(raw.entityId, 'Stored entity attribute does not match the public entity ID.');
  }
  if (node.attributes?.WorldwrightEntityKind !== raw.entityKind)
    drift(raw.entityId, 'WorldwrightEntityKind');
  if (node.attributes?.WorldwrightCompilerVersion !== raw.compilerVersion)
    drift(raw.entityId, 'WorldwrightCompilerVersion');
  if (node.attributes?.WorldwrightManaged !== true) drift(raw.entityId, 'WorldwrightManaged');
  if (node.attributes?.WorldwrightSourceHash !== raw.sourceHash)
    drift(raw.entityId, 'WorldwrightSourceHash');
  if (node.className !== raw.className) drift(raw.entityId, 'ClassName');
  if (node.name !== raw.name) drift(raw.entityId, 'Name');
  const expectedParentKind = node.parentId === undefined ? 'Workspace' : 'managed';
  if (raw.parentKind !== expectedParentKind || raw.parentEntityId !== node.parentId) {
    drift(raw.entityId, 'Parent');
  }
  verifyPrimitiveProperties(raw, node);
  return structuredClone(node);
}
