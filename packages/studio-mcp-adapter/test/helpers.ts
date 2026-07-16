import { readFileSync } from 'node:fs';

import type {
  RobloxManagedNode,
  RobloxManifest,
  RobloxSnapshot,
} from '@worldwright/roblox-compiler';

import { createStudioMcpAdapterForTesting, type StudioMcpRobloxAdapter } from '../src/adapter.js';
import { STUDIO_BRIDGE_RESPONSE_PREFIX } from '../src/constants.js';
import { compareCodePoints } from '../src/diagnostics.js';
import { canonicalNodeMetadata } from '../src/engine-state.js';
import { stringifyCanonicalJson, type JsonValue } from '../src/json.js';
import type { AllowedStudioMcpToolName } from '../src/mcp/capabilities.js';
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

function extractPayload(source: string): StudioBridgeRequest {
  const marker = 'local payloadJson = ';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('Fixed bridge payload marker is missing.');
  const literal = source.slice(start + marker.length);
  const match = /^\[(=*)\[([\s\S]*?)\]\1\]/u.exec(literal);
  if (match === null) throw new Error('Fixed bridge payload literal is malformed.');
  return JSON.parse(match[2]!) as StudioBridgeRequest;
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
  return `${STUDIO_BRIDGE_RESPONSE_PREFIX}${stringifyCanonicalJson(response as JsonValue)}`;
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
}

export class FakeStudioProtocol {
  readonly nodes = new Map<string, RobloxManagedNode>();
  readonly calls: Array<{
    readonly tool: AllowedStudioMcpToolName;
    readonly argumentsValue: Readonly<Record<string, unknown>>;
  }> = [];
  readonly unmanagedRoots: readonly StudioRawUnmanagedRoot[];
  placeId: number;
  gameId: number;
  readonly running: boolean;
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
  #faultThrown = false;
  #publicationInjected = false;
  #parentDriftInjected = false;
  #ownershipConflictInjected = false;
  #active = true;
  public closed = false;

  public constructor(options: Readonly<FakeStudioOptions> = {}) {
    for (const node of options.initialNodes ?? []) this.nodes.set(node.id, structuredClone(node));
    this.unmanagedRoots = structuredClone(options.unmanagedRoots ?? []);
    this.placeId = options.placeId ?? 0;
    this.gameId = options.gameId ?? 0;
    this.running = options.running ?? false;
    this.throwAfter = options.throwAfter;
    this.publishBeforeAction = options.publishBeforeAction;
    this.parentDriftBeforeAction = options.parentDriftBeforeAction;
    this.ownershipConflictBeforeAction = options.ownershipConflictBeforeAction;
  }

  public async connect(): Promise<void> {}

  public async listTools(): Promise<unknown> {
    return { tools: validToolList() };
  }

  public simulateExternalSessionSwitch(): void {
    this.#active = false;
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

  #execute(request: StudioBridgeRequest): unknown {
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
            compactSnapshot: compactSnapshotFixture(
              request.projectId,
              [...this.nodes.values()]
                .filter((node) => node.attributes.WorldwrightProjectId === request.projectId)
                .sort((left, right) => compareCodePoints(left.id, right.id)),
              this.unmanagedRoots,
            ),
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
  return {
    adapter: createStudioMcpAdapterForTesting(
      client,
      {
        studioId: 'studio-test',
        displayName: 'Unsaved Sandbox',
        active: true,
      },
      options.mutationAuthorized ?? true,
    ),
    protocol,
  };
}
