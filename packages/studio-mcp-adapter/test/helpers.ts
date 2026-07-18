import { readFileSync } from 'node:fs';

import type {
  RobloxManagedNode,
  RobloxManifest,
  RobloxSnapshot,
} from '@worldwright/roblox-compiler';

import { createStudioMcpAdapterForTesting, type StudioMcpRobloxAdapter } from '../src/adapter.js';
import type {
  StudioBatchOperation,
  StudioBatchRequest,
  StudioBatchResponse,
} from '../src/batch/types.js';
import {
  STUDIO_BATCH_RESPONSE_PREFIX,
  STUDIO_BRIDGE_RESPONSE_PREFIX,
  STUDIO_SANDBOX_LEASE_RESPONSE_PREFIX,
} from '../src/constants.js';
import { compareCodePoints } from '../src/diagnostics.js';
import { canonicalNodeMetadata } from '../src/engine-state.js';
import { canonicalizeJsonValue, type JsonValue } from '../src/json.js';
import type { AllowedStudioMcpToolName } from '../src/mcp/capabilities.js';
import {
  sandboxLeaseRecordsEqual,
  stringifySandboxLeaseRecord,
} from '../src/sandbox-lease/normalize.js';
import { parseSandboxLeaseAttribute } from '../src/sandbox-lease/record.js';
import type {
  SandboxLeaseIdFactory,
  StudioSandboxLeaseAction,
  StudioSandboxLeaseRecord,
  StudioSandboxLeaseRequest,
  StudioSandboxLeaseResponse,
} from '../src/sandbox-lease/types.js';
import { connectStudioMcpForTesting } from '../src/testing.js';
import { compactSnapshotFixture } from '../scripts/compact-snapshot-fixture.js';
import type {
  StudioBridgeRequest,
  StudioBridgeParentState,
  StudioBridgeResponse,
  StudioRawManagedNode,
  StudioRawUnmanagedRoot,
} from '../src/types.js';
import { VALID_JPEG_BYTES } from './image-fixtures.js';

export function loadCourtyardManifest(): RobloxManifest {
  return JSON.parse(
    readFileSync(
      new URL(
        '../../roblox-compiler/fixtures/manifest/primitive-courtyard.manifest.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as RobloxManifest;
}

export function emptySnapshot(manifest: Readonly<RobloxManifest>): RobloxSnapshot {
  return {
    schemaVersion: '0.1.0',
    projectId: manifest.source.projectId,
    target: { service: 'Workspace' },
    nodes: [],
    unmanagedRoots: [],
  };
}

function extractPayload(
  source: string,
): StudioBridgeRequest | StudioBatchRequest | StudioSandboxLeaseRequest {
  const marker = 'local payloadJson = ';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('Fixed bridge payload marker is missing.');
  const literal = source.slice(start + marker.length);
  const match = /^\[(=*)\[([\s\S]*?)\]\1\]/u.exec(literal);
  if (match === null) throw new Error('Fixed bridge payload literal is malformed.');
  return JSON.parse(match[2]!) as
    | StudioBridgeRequest
    | StudioBatchRequest
    | StudioSandboxLeaseRequest;
}

function cframe(node: Readonly<RobloxManagedNode>): number[] {
  if (node.className === 'Folder' || node.className === 'Model') return [];
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

export function rawNode(node: Readonly<RobloxManagedNode>): StudioRawManagedNode {
  const metadata = canonicalNodeMetadata(node);
  const common = {
    entityId: node.id,
    projectId: node.attributes.WorldwrightProjectId,
    className: node.className,
    name: node.name,
    parentKind: node.parentId === undefined ? ('Workspace' as const) : ('managed' as const),
    ...(node.parentId === undefined ? {} : { parentEntityId: node.parentId }),
    entityKind: node.entityKind,
    compilerVersion: node.attributes.WorldwrightCompilerVersion,
    ...(node.attributes.WorldwrightSourceHash === undefined
      ? {}
      : { sourceHash: node.attributes.WorldwrightSourceHash }),
    adapterVersion: '0.1.0' as const,
    stateJson: metadata.json,
    stateHash: metadata.hash,
  };
  if (node.className === 'Folder' || node.className === 'Model') {
    return { ...common, className: node.className, properties: {} };
  }
  return {
    ...common,
    className: node.className,
    properties: {
      cframe: cframe(node),
      size: [node.properties.size.x, node.properties.size.y, node.properties.size.z],
      anchored: node.properties.anchored,
      ...(node.className === 'Part' ? { shape: node.properties.shape } : {}),
      material: node.properties.material,
      color: [
        node.properties.color.r / 255,
        node.properties.color.g / 255,
        node.properties.color.b / 255,
      ],
      transparency: node.properties.transparency,
      canCollide: node.properties.canCollide,
      canQuery: node.properties.canQuery,
      canTouch: node.properties.canTouch,
      castShadow: node.properties.castShadow,
    },
  };
}

function validToolList(): readonly unknown[] {
  return [
    { name: 'list_roblox_studios', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'set_active_studio',
      inputSchema: {
        type: 'object',
        properties: { studio_id: { type: 'string' } },
        required: ['studio_id'],
      },
    },
    { name: 'get_studio_state', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'execute_luau',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          datamodel_type: { type: 'string', enum: ['Edit', 'Client', 'Server'] },
        },
        required: ['code', 'datamodel_type'],
      },
    },
    {
      name: 'screen_capture',
      inputSchema: {
        type: 'object',
        properties: { capture_id: { type: 'string' } },
        required: ['capture_id'],
      },
    },
    { name: 'search_game_tree', inputSchema: { type: 'object', properties: {} } },
    { name: 'inspect_instance', inputSchema: { type: 'object', properties: {} } },
  ];
}

function frame(response: StudioBridgeResponse): string {
  return `${STUDIO_BRIDGE_RESPONSE_PREFIX}${JSON.stringify(canonicalizeJsonValue(response as JsonValue))}\n`;
}

function batchFrame(response: StudioBatchResponse): string {
  return `${STUDIO_BATCH_RESPONSE_PREFIX}${JSON.stringify(canonicalizeJsonValue(response as JsonValue))}\n`;
}

function sandboxLeaseFrame(response: StudioSandboxLeaseResponse): string {
  return `${STUDIO_SANDBOX_LEASE_RESPONSE_PREFIX}${JSON.stringify(canonicalizeJsonValue(response as JsonValue))}\n`;
}

export interface FakeStudioOptions {
  readonly placeId?: number;
  readonly gameId?: number;
  readonly running?: boolean;
  readonly initialNodes?: readonly RobloxManagedNode[];
  readonly unmanagedRoots?: readonly StudioRawUnmanagedRoot[];
  readonly throwAfter?: 'create' | 'update' | 'delete';
  readonly mutationAuthorized?: boolean;
  readonly publishBeforeAction?: 'snapshot' | 'create' | 'update' | 'delete';
  readonly parentDriftBeforeAction?: Readonly<{
    action: 'create' | 'update';
    parentId: string;
    name: string;
  }>;
  readonly ownershipConflictBeforeAction?: Readonly<{
    action: 'create' | 'update' | 'delete';
    code: 'studio.identity_invalid' | 'studio.root_invalid';
  }>;
  readonly beforeReconnect?: (protocol: FakeStudioProtocol) => void;
  readonly beforeBatch?: (
    protocol: FakeStudioProtocol,
    request: Readonly<StudioBatchRequest>,
  ) => void;
  readonly afterBatch?: (
    protocol: FakeStudioProtocol,
    request: Readonly<StudioBatchRequest>,
  ) => void;
  readonly leaseIdFactory?: SandboxLeaseIdFactory;
  readonly initialSandboxLeaseAttribute?: unknown;
  /** A distinct DataModel can retain the same exact Studio and sandbox facts on reconnect. */
  readonly reconnectDataModel?: Readonly<{
    readonly initialNodes?: readonly RobloxManagedNode[];
    readonly sandboxLeaseAttribute?: unknown;
  }>;
}

interface FakeStudioSharedState {
  readonly nodes: Map<string, RobloxManagedNode>;
  readonly workspace: { sandboxLeaseAttribute: unknown };
  readonly calls: Array<{
    readonly tool: AllowedStudioMcpToolName;
    readonly argumentsValue: Readonly<Record<string, unknown>>;
  }>;
}

export class FakeStudioProtocol {
  readonly nodes: Map<string, RobloxManagedNode>;
  readonly calls: FakeStudioSharedState['calls'];
  readonly workspace: FakeStudioSharedState['workspace'];
  readonly unmanagedRoots: readonly StudioRawUnmanagedRoot[];
  placeId: number;
  gameId: number;
  running: boolean;
  readonly throwAfter: 'create' | 'update' | 'delete' | undefined;
  readonly publishBeforeAction: 'snapshot' | 'create' | 'update' | 'delete' | undefined;
  readonly parentDriftBeforeAction:
    | Readonly<{ action: 'create' | 'update'; parentId: string; name: string }>
    | undefined;
  readonly ownershipConflictBeforeAction:
    | Readonly<{
        action: 'create' | 'update' | 'delete';
        code: 'studio.identity_invalid' | 'studio.root_invalid';
      }>
    | undefined;
  readonly beforeBatch:
    | ((protocol: FakeStudioProtocol, request: Readonly<StudioBatchRequest>) => void)
    | undefined;
  readonly afterBatch:
    | ((protocol: FakeStudioProtocol, request: Readonly<StudioBatchRequest>) => void)
    | undefined;
  #faultThrown = false;
  #publicationInjected = false;
  #parentDriftInjected = false;
  #ownershipConflictInjected = false;
  #active = true;
  public closed = false;

  public constructor(
    options: Readonly<FakeStudioOptions> = {},
    sharedState?: Readonly<FakeStudioSharedState>,
  ) {
    this.nodes = sharedState?.nodes ?? new Map<string, RobloxManagedNode>();
    this.calls = sharedState?.calls ?? [];
    this.workspace = sharedState?.workspace ?? {
      sandboxLeaseAttribute: options.initialSandboxLeaseAttribute,
    };
    if (sharedState === undefined) {
      for (const node of options.initialNodes ?? []) this.nodes.set(node.id, structuredClone(node));
    }
    this.unmanagedRoots = structuredClone(options.unmanagedRoots ?? []);
    this.placeId = options.placeId ?? 0;
    this.gameId = options.gameId ?? 0;
    this.running = options.running ?? false;
    this.throwAfter = options.throwAfter;
    this.publishBeforeAction = options.publishBeforeAction;
    this.parentDriftBeforeAction = options.parentDriftBeforeAction;
    this.ownershipConflictBeforeAction = options.ownershipConflictBeforeAction;
    this.beforeBatch = options.beforeBatch;
    this.afterBatch = options.afterBatch;
  }

  public async connect(): Promise<void> {}

  public async listTools(): Promise<unknown> {
    return { tools: validToolList() };
  }

  public simulateExternalSessionSwitch(): void {
    this.#active = false;
  }

  public get sandboxLeaseAttribute(): unknown {
    return this.workspace.sandboxLeaseAttribute;
  }

  public set sandboxLeaseAttribute(value: unknown) {
    this.workspace.sandboxLeaseAttribute = value;
  }

  #text(text: string): unknown {
    return { content: [{ type: 'text', text }], isError: false };
  }

  #bridgeFailure(
    request: StudioBridgeRequest,
    code:
      | 'studio.published_place_forbidden'
      | 'studio.edit_mode_required'
      | 'studio.create_failed'
      | 'studio.update_failed'
      | 'studio.delete_failed'
      | 'studio.engine_state_drift'
      | 'studio.identity_invalid'
      | 'studio.root_invalid',
    message: string,
  ): unknown {
    return this.#text(
      frame({
        protocolVersion: '0.1.0',
        action: request.action,
        ok: false,
        diagnostic: { code, message },
      }),
    );
  }

  #sandboxLeaseFailure(
    action: StudioSandboxLeaseAction,
    code:
      | 'studio.published_place_forbidden'
      | 'studio.edit_mode_required'
      | 'studio.sandbox_lease_invalid'
      | 'studio.sandbox_lease_conflict'
      | 'studio.sandbox_identity_mismatch',
    message: string,
  ): unknown {
    return this.#text(
      sandboxLeaseFrame({
        protocolVersion: '0.1.0',
        action,
        ok: false,
        diagnostic: { code, message },
      }),
    );
  }

  #compactSnapshot(projectId: string) {
    return compactSnapshotFixture(
      projectId,
      [...this.nodes.values()]
        .filter((node) => node.attributes.WorldwrightProjectId === projectId)
        .sort((left, right) => compareCodePoints(left.id, right.id)),
      this.unmanagedRoots,
    );
  }

  #currentSandboxLease(
    action: StudioSandboxLeaseAction,
    malformedCode: 'studio.sandbox_lease_invalid' | 'studio.sandbox_identity_mismatch',
  ):
    | { readonly ok: true; readonly record?: StudioSandboxLeaseRecord }
    | { readonly ok: false; readonly response: unknown } {
    try {
      const record = parseSandboxLeaseAttribute(this.workspace.sandboxLeaseAttribute);
      return record === undefined ? { ok: true } : { ok: true, record };
    } catch {
      return {
        ok: false,
        response: this.#sandboxLeaseFailure(
          action,
          malformedCode,
          malformedCode === 'studio.sandbox_lease_invalid'
            ? 'The existing sandbox lease attribute is invalid.'
            : 'The loaded sandbox does not carry the exact transaction lease.',
        ),
      };
    }
  }

  #executeSandboxLease(request: Readonly<StudioSandboxLeaseRequest>): unknown {
    if (this.placeId !== 0 || this.gameId !== 0) {
      return this.#sandboxLeaseFailure(
        request.action,
        'studio.published_place_forbidden',
        'Sandbox leases are forbidden in published places.',
      );
    }
    if (this.running) {
      return this.#sandboxLeaseFailure(
        request.action,
        'studio.edit_mode_required',
        'Sandbox leases require stopped Edit mode.',
      );
    }
    const parsed = this.#currentSandboxLease(
      request.action,
      request.action === 'bound_snapshot'
        ? 'studio.sandbox_identity_mismatch'
        : 'studio.sandbox_lease_invalid',
    );
    if (!parsed.ok) return parsed.response;
    const record = parsed.record;

    switch (request.action) {
      case 'read_lease':
        return this.#text(
          sandboxLeaseFrame({
            protocolVersion: '0.1.0',
            action: 'read_lease',
            ok: true,
            leasePresent: record !== undefined,
            ...(record === undefined ? {} : { lease: record }),
          }),
        );
      case 'claim_lease': {
        const expectedMatches =
          request.expectedLeasePresent === (record !== undefined) &&
          (record === undefined ||
            (request.expectedLease !== undefined &&
              sandboxLeaseRecordsEqual(record, request.expectedLease)));
        if (!expectedMatches) {
          return this.#sandboxLeaseFailure(
            'claim_lease',
            'studio.sandbox_lease_conflict',
            'The sandbox lease changed before compare-and-set claim.',
          );
        }
        const next = stringifySandboxLeaseRecord(request.newLease);
        this.workspace.sandboxLeaseAttribute = next;
        if (this.workspace.sandboxLeaseAttribute !== next) {
          return this.#sandboxLeaseFailure(
            'claim_lease',
            'studio.sandbox_lease_conflict',
            'The sandbox lease claim could not be verified.',
          );
        }
        return this.#text(
          sandboxLeaseFrame({
            protocolVersion: '0.1.0',
            action: 'claim_lease',
            ok: true,
          }),
        );
      }
      case 'bound_snapshot':
        if (record === undefined || !sandboxLeaseRecordsEqual(record, request.lease)) {
          return this.#sandboxLeaseFailure(
            'bound_snapshot',
            'studio.sandbox_identity_mismatch',
            'The loaded sandbox does not carry the exact transaction lease.',
          );
        }
        return this.#text(
          sandboxLeaseFrame({
            protocolVersion: '0.1.0',
            action: 'bound_snapshot',
            ok: true,
            compactSnapshot: this.#compactSnapshot(request.lease.projectId),
          }),
        );
    }
  }

  #maybeFault(action: 'create' | 'update' | 'delete'): void {
    if (!this.#faultThrown && this.throwAfter === action) {
      this.#faultThrown = true;
      throw new Error('private fake transport failure');
    }
  }

  #maybeDriftParent(action: 'create' | 'update'): void {
    const drift = this.parentDriftBeforeAction;
    if (this.#parentDriftInjected || drift === undefined || drift.action !== action) return;
    const parent = this.nodes.get(drift.parentId);
    if (parent === undefined) return;
    this.#parentDriftInjected = true;
    this.nodes.set(parent.id, { ...parent, name: drift.name });
  }

  #parentStateMatches(
    parentId: string | undefined,
    parentState: Readonly<StudioBridgeParentState> | undefined,
  ): boolean {
    if (parentId === undefined) return parentState === undefined;
    if (parentState === undefined || parentState.node.id !== parentId) return false;
    const current = this.nodes.get(parentId);
    return (
      current !== undefined &&
      canonicalNodeMetadata(current).hash === parentState.stateHash &&
      canonicalNodeMetadata(parentState.node).hash === parentState.stateHash
    );
  }

  #singleRequestFromBatch(
    request: Readonly<StudioBatchRequest>,
    operation: Readonly<StudioBatchOperation>,
  ): StudioBridgeRequest {
    const common = { protocolVersion: '0.1.0' as const, projectId: request.projectId };
    switch (operation.type) {
      case 'create':
        return {
          ...common,
          action: 'create',
          node: operation.node,
          stateJson: operation.stateJson,
          stateHash: operation.stateHash,
          ...(operation.parentState === undefined ? {} : { parentState: operation.parentState }),
        };
      case 'update':
        return {
          ...common,
          action: 'update',
          before: operation.before,
          after: operation.after,
          beforeStateJson: operation.beforeStateJson,
          beforeStateHash: operation.beforeStateHash,
          afterStateJson: operation.afterStateJson,
          afterStateHash: operation.afterStateHash,
          ...(operation.beforeParentState === undefined
            ? {}
            : { beforeParentState: operation.beforeParentState }),
          ...(operation.afterParentState === undefined
            ? {}
            : { afterParentState: operation.afterParentState }),
        };
      case 'delete':
        return {
          ...common,
          action: 'delete',
          before: operation.before,
          beforeStateJson: operation.beforeStateJson,
          beforeStateHash: operation.beforeStateHash,
        };
    }
  }

  #responseFromEnvelope(value: unknown): StudioBridgeResponse {
    const content =
      typeof value === 'object' && value !== null && 'content' in value
        ? (value as { readonly content?: readonly unknown[] }).content
        : undefined;
    const first = content?.[0];
    const text =
      typeof first === 'object' && first !== null && 'text' in first
        ? (first as { readonly text?: unknown }).text
        : undefined;
    if (typeof text !== 'string' || !text.startsWith(STUDIO_BRIDGE_RESPONSE_PREFIX)) {
      throw new Error('Fake single bridge response is malformed.');
    }
    return JSON.parse(text.slice(STUDIO_BRIDGE_RESPONSE_PREFIX.length)) as StudioBridgeResponse;
  }

  #batchIdentityFailure(request: Readonly<StudioBatchRequest>): unknown {
    return this.#text(
      batchFrame({
        protocolVersion: '0.1.0',
        action: 'apply_chunk',
        ok: false,
        changeSetHash: request.changeSetHash,
        chunkId: request.chunkId,
        chunkIndex: request.chunkIndex,
        operationsAttempted: 0,
        operationsApplied: 0,
        completedOperationIds: [],
        localRestoreSucceeded: false,
        diagnostic: {
          code: 'studio.sandbox_identity_mismatch',
          message: 'The loaded sandbox does not carry the exact transaction lease.',
        },
      }),
    );
  }

  #executeBatch(request: Readonly<StudioBatchRequest>): unknown {
    this.beforeBatch?.(this, request);
    const parsed = this.#currentSandboxLease('bound_snapshot', 'studio.sandbox_identity_mismatch');
    if (!parsed.ok) return this.#batchIdentityFailure(request);
    const current = parsed.record;
    if (
      current === undefined ||
      current.schemaVersion !== '0.1.0' ||
      current.leaseId !== request.sandboxLeaseId ||
      current.projectId !== request.projectId ||
      current.changeSetHash !== request.changeSetHash
    ) {
      return this.#batchIdentityFailure(request);
    }
    const completedOperationIds: string[] = [];
    for (let index = 0; index < request.operations.length; index += 1) {
      const operation = request.operations[index]!;
      const single = this.#responseFromEnvelope(
        this.#execute(this.#singleRequestFromBatch(request, operation)),
      );
      if (!single.ok) {
        return this.#text(
          batchFrame({
            protocolVersion: '0.1.0',
            action: 'apply_chunk',
            ok: false,
            changeSetHash: request.changeSetHash,
            chunkId: request.chunkId,
            chunkIndex: request.chunkIndex,
            operationsAttempted: index + 1,
            operationsApplied: index,
            completedOperationIds,
            failedOperationId: operation.operationId,
            localRestoreSucceeded: true,
            diagnostic: single.diagnostic,
          }),
        );
      }
      completedOperationIds.push(operation.operationId);
    }
    return this.#text(
      batchFrame({
        protocolVersion: '0.1.0',
        action: 'apply_chunk',
        ok: true,
        changeSetHash: request.changeSetHash,
        chunkId: request.chunkId,
        chunkIndex: request.chunkIndex,
        operationsAttempted: request.operations.length,
        operationsApplied: request.operations.length,
        completedOperationIds,
      }),
    );
  }

  #execute(request: StudioBridgeRequest | StudioBatchRequest | StudioSandboxLeaseRequest): unknown {
    if (
      request.action === 'read_lease' ||
      request.action === 'claim_lease' ||
      request.action === 'bound_snapshot'
    ) {
      return this.#executeSandboxLease(request);
    }
    if (request.action === 'apply_chunk') {
      const response = this.#executeBatch(request);
      this.afterBatch?.(this, request);
      return response;
    }
    if (request.action !== 'probe') {
      if (!this.#publicationInjected && request.action === this.publishBeforeAction) {
        this.#publicationInjected = true;
        this.placeId = 42;
        this.gameId = 42;
      }
      if (this.placeId !== 0 || this.gameId !== 0) {
        return this.#bridgeFailure(
          request,
          'studio.published_place_forbidden',
          'Managed project access requires an unsaved sandbox.',
        );
      }
      if (this.running) {
        return this.#bridgeFailure(
          request,
          'studio.edit_mode_required',
          'Managed project access requires stopped Edit mode.',
        );
      }
      if (
        !this.#ownershipConflictInjected &&
        request.action === this.ownershipConflictBeforeAction?.action
      ) {
        this.#ownershipConflictInjected = true;
        return this.#bridgeFailure(
          request,
          this.ownershipConflictBeforeAction.code,
          'A concurrent managed ownership conflict was detected.',
        );
      }
    }
    switch (request.action) {
      case 'probe':
        return this.#text(
          frame({
            protocolVersion: '0.1.0',
            action: 'probe',
            ok: true,
            probe: {
              placeName: 'Unsaved Sandbox',
              placeId: this.placeId,
              gameId: this.gameId,
              isRunning: this.running,
              isEditAvailable: !this.running,
            },
          }),
        );
      case 'snapshot':
        return this.#text(
          frame({
            protocolVersion: '0.1.0',
            action: 'snapshot',
            ok: true,
            compactSnapshot: this.#compactSnapshot(request.projectId),
          }),
        );
      case 'create':
        this.#maybeDriftParent('create');
        if (this.nodes.has(request.node.id)) {
          return this.#bridgeFailure(request, 'studio.create_failed', 'Node already exists.');
        }
        if (!this.#parentStateMatches(request.node.parentId, request.parentState)) {
          return this.#bridgeFailure(
            request,
            'studio.engine_state_drift',
            'Create parent differs from its transaction-observed state.',
          );
        }
        this.nodes.set(request.node.id, structuredClone(request.node));
        this.#maybeFault('create');
        return this.#text(
          frame({ protocolVersion: '0.1.0', action: 'create', ok: true, nodeId: request.node.id }),
        );
      case 'update': {
        this.#maybeDriftParent('update');
        const current = this.nodes.get(request.before.id);
        if (
          current === undefined ||
          canonicalNodeMetadata(current).hash !== request.beforeStateHash
        ) {
          return this.#bridgeFailure(request, 'studio.update_failed', 'Before state differs.');
        }
        if (!this.#parentStateMatches(request.before.parentId, request.beforeParentState)) {
          return this.#bridgeFailure(
            request,
            'studio.engine_state_drift',
            'Update source parent differs from its transaction-observed state.',
          );
        }
        if (!this.#parentStateMatches(request.after.parentId, request.afterParentState)) {
          return this.#bridgeFailure(
            request,
            'studio.engine_state_drift',
            'Update parent differs from its transaction-observed state.',
          );
        }
        this.nodes.set(request.after.id, structuredClone(request.after));
        this.#maybeFault('update');
        return this.#text(
          frame({
            protocolVersion: '0.1.0',
            action: 'update',
            ok: true,
            nodeId: request.before.id,
          }),
        );
      }
      case 'delete': {
        const current = this.nodes.get(request.before.id);
        if (
          current === undefined ||
          canonicalNodeMetadata(current).hash !== request.beforeStateHash
        ) {
          return this.#bridgeFailure(request, 'studio.delete_failed', 'Before state differs.');
        }
        this.nodes.delete(request.before.id);
        this.#maybeFault('delete');
        return this.#text(
          frame({
            protocolVersion: '0.1.0',
            action: 'delete',
            ok: true,
            nodeId: request.before.id,
          }),
        );
      }
    }
  }

  public async invoke(
    tool: AllowedStudioMcpToolName,
    argumentsValue: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    if (this.closed) throw new Error('Fake Studio protocol is closed.');
    this.calls.push({ tool, argumentsValue });
    switch (tool) {
      case 'list_roblox_studios':
        return this.#text(
          JSON.stringify({
            studios: [{ id: 'studio-test', name: 'Unsaved Sandbox', active: this.#active }],
          }),
        );
      case 'set_active_studio':
        this.#active = argumentsValue['studio_id'] === 'studio-test';
        return this.#text(JSON.stringify({ selected: this.#active }));
      case 'get_studio_state':
        if (!this.#active) throw new Error('Unexpected inactive fake Studio state read.');
        return this.#text(
          JSON.stringify({
            play_state: this.running ? 'Running' : 'NotRunning',
            available_datamodel_types: this.running ? ['Client', 'Server'] : ['Edit'],
          }),
        );
      case 'execute_luau': {
        if (!this.#active) throw new Error('Unexpected inactive fake Studio execution.');
        const source = argumentsValue['code'];
        if (typeof source !== 'string' || argumentsValue['datamodel_type'] !== 'Edit') {
          throw new Error('Unexpected execute_luau arguments.');
        }
        return this.#execute(extractPayload(source));
      }
      case 'screen_capture': {
        if (!this.#active) throw new Error('Unexpected inactive fake Studio capture.');
        return {
          content: [
            {
              type: 'image',
              mimeType: 'image/jpeg',
              data: VALID_JPEG_BYTES.toString('base64'),
            },
          ],
          isError: false,
        };
      }
      case 'search_game_tree':
      case 'inspect_instance':
        return this.#text('{}');
    }
    throw new Error(`Unexpected fake Studio tool: ${tool}.`);
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}

export async function createFakeStudioAdapter(
  options: Readonly<FakeStudioOptions> = {},
): Promise<{ readonly adapter: StudioMcpRobloxAdapter; readonly protocol: FakeStudioProtocol }> {
  const protocol = new FakeStudioProtocol(options);
  const client = await connectStudioMcpForTesting(() => protocol);
  const sharedState: FakeStudioSharedState = {
    nodes: protocol.nodes,
    workspace: protocol.workspace,
    calls: protocol.calls,
  };
  const reconnectState: FakeStudioSharedState =
    options.reconnectDataModel === undefined
      ? sharedState
      : {
          nodes: new Map(
            (options.reconnectDataModel.initialNodes ?? []).map((node) => [
              node.id,
              structuredClone(node),
            ]),
          ),
          workspace: {
            sandboxLeaseAttribute: options.reconnectDataModel.sandboxLeaseAttribute,
          },
          calls: protocol.calls,
        };
  let reconnectHookUsed = false;
  const reconnectClient = async () => {
    if (!reconnectHookUsed) {
      reconnectHookUsed = true;
      options.beforeReconnect?.(protocol);
    }
    const replacement = new FakeStudioProtocol(
      {
        placeId: protocol.placeId,
        gameId: protocol.gameId,
        running: protocol.running,
        unmanagedRoots: protocol.unmanagedRoots,
        ...(options.beforeBatch === undefined ? {} : { beforeBatch: options.beforeBatch }),
        ...(options.afterBatch === undefined ? {} : { afterBatch: options.afterBatch }),
      },
      reconnectState,
    );
    return connectStudioMcpForTesting(() => replacement);
  };
  return {
    adapter: createStudioMcpAdapterForTesting(
      client,
      {
        studioId: 'studio-test',
        displayName: 'Unsaved Sandbox',
        active: true,
      },
      options.mutationAuthorized ?? true,
      reconnectClient,
      options.leaseIdFactory,
    ),
    protocol,
  };
}
