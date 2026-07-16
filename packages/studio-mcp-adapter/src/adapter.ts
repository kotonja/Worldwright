import { AsyncLocalStorage } from 'node:async_hooks';

import {
  applyRobloxChangeSet,
  validateRobloxChangeSet,
  type ApplyResult,
  type RobloxAdapter,
  type RobloxAdapterScope,
  type RobloxManagedNode,
  type RobloxSnapshot,
} from '@worldwright/roblox-compiler';

import { buildCreateProgram } from './bridge/create-program.js';
import { buildDeleteProgram } from './bridge/delete-program.js';
import { parseStudioBridgeResponse } from './bridge/response.js';
import { buildProbeProgram, buildSnapshotProgram } from './bridge/snapshot-program.js';
import { buildUpdateProgram } from './bridge/update-program.js';
import { STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS } from './constants.js';
import { StudioAdapterError, studioDiagnostic } from './diagnostics.js';
import {
  captureStudioViewport,
  connectStudioMcp,
  executeFixedStudioBridgeProgram,
  type FixedStudioBridgeProgram,
  type StudioMcpClient,
  type StudioViewportCaptureRequest,
} from './mcp/client.js';
import type { StudioMcpImageResult } from './mcp/result.js';
import {
  assertSandboxStudioProbe,
  listStudioSessions,
  parseStudioStateText,
  sanitizeStudioDisplayName,
  selectReadOnlyStudioSession,
  selectStudioSession,
  type StudioSandboxProbe,
  type StudioSessionSummary,
} from './mcp/session.js';
import { snapshotFromStudioRaw } from './snapshot.js';
import type { StudioBridgeResponse } from './types.js';

const ADAPTER_CONSTRUCTION_TOKEN = Symbol('worldwright.studioMcp.adapterConstruction');
export type StudioAdapterFaultOperation = 'create' | 'update' | 'delete';
const internalStudioTransactionAdapters = new WeakMap<StudioMcpRobloxAdapter, RobloxAdapter>();
const authorizedStudioTransactionRunners = new WeakMap<
  StudioMcpRobloxAdapter,
  (input: unknown, faultOperation?: StudioAdapterFaultOperation) => Promise<ApplyResult>
>();

interface StudioTransactionContext {
  readonly expectedNodes: Map<string, RobloxManagedNode>;
}

function createPostMutationFaultAdapter(
  delegate: RobloxAdapter,
  selectedOperation: StudioAdapterFaultOperation,
): RobloxAdapter {
  let thrown = false;
  const throwAfter = async (
    operation: StudioAdapterFaultOperation,
    mutation: () => Promise<void>,
  ): Promise<void> => {
    await mutation();
    if (!thrown && operation === selectedOperation) {
      thrown = true;
      throw new Error('Injected post-mutation test fault.');
    }
  };
  return Object.freeze({
    readSnapshot: (scope: Readonly<RobloxAdapterScope>): Promise<unknown> =>
      delegate.readSnapshot(scope),
    createNode: (
      scope: Readonly<RobloxAdapterScope>,
      node: Readonly<RobloxManagedNode>,
    ): Promise<void> => throwAfter('create', () => delegate.createNode(scope, node)),
    updateNode: (
      scope: Readonly<RobloxAdapterScope>,
      before: Readonly<RobloxManagedNode>,
      after: Readonly<RobloxManagedNode>,
    ): Promise<void> => throwAfter('update', () => delegate.updateNode(scope, before, after)),
    deleteNode: (
      scope: Readonly<RobloxAdapterScope>,
      before: Readonly<RobloxManagedNode>,
    ): Promise<void> => throwAfter('delete', () => delegate.deleteNode(scope, before)),
  });
}

function assertScope(scope: Readonly<RobloxAdapterScope>): void {
  if (scope.target.service !== 'Workspace') {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.project_mismatch',
        '/target',
        'Studio adapter target must be Workspace.',
      ),
    ]);
  }
}

function assertNodeProject(
  scope: Readonly<RobloxAdapterScope>,
  node: Readonly<RobloxManagedNode>,
): void {
  if (node.attributes.WorldwrightProjectId !== scope.projectId) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.project_mismatch',
        `/nodes/${node.id}/attributes/WorldwrightProjectId`,
        'Managed node project does not match the selected adapter scope.',
        { relatedId: node.id },
      ),
    ]);
  }
}

function successSnapshot(
  response: StudioBridgeResponse,
): StudioBridgeResponse & { readonly ok: true } {
  if (!response.ok)
    throw new StudioAdapterError([
      studioDiagnostic('studio.snapshot_invalid', '', response.diagnostic.message),
    ]);
  return response;
}

export class StudioMcpRobloxAdapter implements RobloxAdapter {
  readonly #client: StudioMcpClient;
  readonly #session: StudioSessionSummary;
  readonly #transactionContext = new AsyncLocalStorage<StudioTransactionContext>();
  readonly #mutationAuthorized: boolean;
  #transactionTail: Promise<void> = Promise.resolve();
  #closing = false;
  #closePromise: Promise<void> | undefined;

  /** @internal Construct through the package factories. */
  public constructor(
    token: symbol,
    client: StudioMcpClient,
    session: StudioSessionSummary,
    mutationAuthorized: boolean,
  ) {
    if (token !== ADAPTER_CONSTRUCTION_TOKEN) {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.usage_invalid',
          '/adapter',
          'Studio adapters must be created through a safe package factory.',
        ),
      ]);
    }
    this.#client = client;
    this.#session = session;
    this.#mutationAuthorized = mutationAuthorized;
    const transactionAdapter = Object.freeze({
      readSnapshot: (scope: Readonly<RobloxAdapterScope>): Promise<unknown> =>
        this.#readSnapshot(scope),
      createNode: (
        scope: Readonly<RobloxAdapterScope>,
        node: Readonly<RobloxManagedNode>,
      ): Promise<void> => this.#createNode(scope, node),
      updateNode: (
        scope: Readonly<RobloxAdapterScope>,
        before: Readonly<RobloxManagedNode>,
        after: Readonly<RobloxManagedNode>,
      ): Promise<void> => this.#updateNode(scope, before, after),
      deleteNode: (
        scope: Readonly<RobloxAdapterScope>,
        before: Readonly<RobloxManagedNode>,
      ): Promise<void> => this.#deleteNode(scope, before),
    });
    internalStudioTransactionAdapters.set(this, transactionAdapter);
    authorizedStudioTransactionRunners.set(this, (input, faultOperation) =>
      this.#runAuthorizedTransaction(input, faultOperation),
    );
  }

  public get studioId(): string {
    return this.#session.studioId;
  }

  public get displayName(): string {
    return this.#session.displayName;
  }

  async #serialized<T>(operation: () => Promise<T>, allowClosing = false): Promise<T> {
    if (this.#closing && !allowClosing) {
      throw new StudioAdapterError([
        studioDiagnostic('studio.usage_invalid', '/adapter', 'The Studio adapter is closing.'),
      ]);
    }
    const predecessor = this.#transactionTail;
    let release!: () => void;
    this.#transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #runFixed(
    action: 'probe' | 'snapshot' | 'create' | 'update' | 'delete',
    program: FixedStudioBridgeProgram,
    expectedNodeId?: string,
  ): Promise<StudioBridgeResponse> {
    await this.#reassertExactSession();
    const text = await executeFixedStudioBridgeProgram(this.#client, program);
    return parseStudioBridgeResponse(text, action, expectedNodeId);
  }

  async #reassertExactSession(): Promise<void> {
    await selectStudioSession(this.#client, this.#session.studioId);
  }

  async #probeSelectedStudioUnlocked(): Promise<StudioSandboxProbe> {
    await this.#reassertExactSession();
    const state = parseStudioStateText(await this.#client.getStudioStateText());
    if (!state.editAvailable || state.playtesting) {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.edit_mode_required',
          '/probe/dataModelMode',
          'Worldwright requires a stopped Studio session with Edit execution available.',
        ),
      ]);
    }
    const response = successSnapshot(await this.#runFixed('probe', buildProbeProgram()));
    if (response.action !== 'probe') {
      throw new StudioAdapterError([
        studioDiagnostic('studio.response_invalid', '/action', 'Studio probe response is invalid.'),
      ]);
    }
    return {
      studioId: this.#session.studioId,
      placeName: sanitizeStudioDisplayName(response.probe.placeName),
      placeId: response.probe.placeId,
      gameId: response.probe.gameId,
      dataModelMode: 'Edit',
      playtesting: state.playtesting || response.probe.isRunning,
      editExecutionAvailable: state.editAvailable && response.probe.isEditAvailable,
    };
  }

  public async probeSelectedStudio(): Promise<StudioSandboxProbe> {
    if (this.#transactionContext.getStore() !== undefined) {
      return this.#probeSelectedStudioUnlocked();
    }
    return this.#serialized(() => this.#probeSelectedStudioUnlocked());
  }

  async #assertSandbox(): Promise<StudioSandboxProbe> {
    return assertSandboxStudioProbe(await this.#probeSelectedStudioUnlocked());
  }

  async #runAdapterOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#transactionContext.getStore() !== undefined) return operation();
    return this.#serialized(async () => {
      await this.#assertSandbox();
      return operation();
    });
  }

  #assertTransactionMutationContext(): void {
    if (this.#transactionContext.getStore() === undefined) {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.usage_invalid',
          '/adapter',
          'Live node mutation is available only inside the verified transaction executor.',
        ),
      ]);
    }
  }

  #replaceExpectedNodes(snapshot: Readonly<RobloxSnapshot>): void {
    const context = this.#transactionContext.getStore();
    if (context === undefined) return;
    context.expectedNodes.clear();
    for (const node of snapshot.nodes) {
      context.expectedNodes.set(node.id, structuredClone(node));
    }
  }

  #expectedParent(node: Readonly<RobloxManagedNode>): RobloxManagedNode | undefined {
    if (node.parentId === undefined) return undefined;
    const parent = this.#transactionContext.getStore()?.expectedNodes.get(node.parentId);
    if (parent === undefined) {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.snapshot_invalid',
          `/nodes/${node.id}/parentId`,
          'The transaction-observed managed parent is unavailable.',
          { relatedId: node.parentId },
        ),
      ]);
    }
    return structuredClone(parent);
  }

  #recordExpectedNode(node: Readonly<RobloxManagedNode>): void {
    this.#transactionContext.getStore()?.expectedNodes.set(node.id, structuredClone(node));
  }

  #forgetExpectedNode(nodeId: string): void {
    this.#transactionContext.getStore()?.expectedNodes.delete(nodeId);
  }

  async #readSnapshot(scope: Readonly<RobloxAdapterScope>): Promise<RobloxSnapshot> {
    assertScope(scope);
    return this.#runAdapterOperation(async () => {
      const response = successSnapshot(
        await this.#runFixed('snapshot', buildSnapshotProgram(scope.projectId)),
      );
      if (response.action !== 'snapshot') {
        throw new StudioAdapterError([
          studioDiagnostic('studio.snapshot_invalid', '', 'Studio snapshot response is invalid.'),
        ]);
      }
      const snapshot = snapshotFromStudioRaw(response.snapshot, scope.projectId);
      this.#replaceExpectedNodes(snapshot);
      return snapshot;
    });
  }

  public async readSnapshot(scope: Readonly<RobloxAdapterScope>): Promise<RobloxSnapshot> {
    return this.#readSnapshot(scope);
  }

  async #createNode(
    scope: Readonly<RobloxAdapterScope>,
    node: Readonly<RobloxManagedNode>,
  ): Promise<void> {
    this.#assertTransactionMutationContext();
    assertScope(scope);
    assertNodeProject(scope, node);
    const parent = this.#expectedParent(node);
    await this.#runAdapterOperation(async () => {
      await this.#runFixed('create', buildCreateProgram(scope.projectId, node, parent), node.id);
      this.#recordExpectedNode(node);
    });
  }

  public async createNode(
    scope: Readonly<RobloxAdapterScope>,
    node: Readonly<RobloxManagedNode>,
  ): Promise<void> {
    return this.#createNode(scope, node);
  }

  async #updateNode(
    scope: Readonly<RobloxAdapterScope>,
    before: Readonly<RobloxManagedNode>,
    after: Readonly<RobloxManagedNode>,
  ): Promise<void> {
    this.#assertTransactionMutationContext();
    assertScope(scope);
    assertNodeProject(scope, before);
    assertNodeProject(scope, after);
    const beforeParent = this.#expectedParent(before);
    const afterParent = this.#expectedParent(after);
    await this.#runAdapterOperation(async () => {
      await this.#runFixed(
        'update',
        buildUpdateProgram(scope.projectId, before, after, beforeParent, afterParent),
        before.id,
      );
      this.#recordExpectedNode(after);
    });
  }

  public async updateNode(
    scope: Readonly<RobloxAdapterScope>,
    before: Readonly<RobloxManagedNode>,
    after: Readonly<RobloxManagedNode>,
  ): Promise<void> {
    return this.#updateNode(scope, before, after);
  }

  async #deleteNode(
    scope: Readonly<RobloxAdapterScope>,
    before: Readonly<RobloxManagedNode>,
  ): Promise<void> {
    this.#assertTransactionMutationContext();
    assertScope(scope);
    assertNodeProject(scope, before);
    await this.#runAdapterOperation(async () => {
      await this.#runFixed('delete', buildDeleteProgram(scope.projectId, before), before.id);
      this.#forgetExpectedNode(before.id);
    });
  }

  public async deleteNode(
    scope: Readonly<RobloxAdapterScope>,
    before: Readonly<RobloxManagedNode>,
  ): Promise<void> {
    return this.#deleteNode(scope, before);
  }

  /**
   * Serialize one complete live transaction and delegate all transaction semantics
   * to the existing compiler executor.
   */
  public async applyChangeSet(input: unknown): Promise<ApplyResult> {
    if (!this.#mutationAuthorized) {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.usage_invalid',
          '/adapter',
          'A read-only auto-selected Studio adapter cannot apply a change set.',
        ),
      ]);
    }
    return this.#runAuthorizedTransaction(input);
  }

  /** Testing reaches this only through a module-private WeakMap runner. */
  async #runAuthorizedTransaction(
    input: unknown,
    faultOperation?: StudioAdapterFaultOperation,
  ): Promise<ApplyResult> {
    if (!this.#mutationAuthorized) {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.usage_invalid',
          '/adapter',
          'A read-only auto-selected Studio adapter cannot apply a change set.',
        ),
      ]);
    }
    const internalAdapter = internalStudioTransactionAdapters.get(this);
    if (internalAdapter === undefined) {
      throw new StudioAdapterError([
        studioDiagnostic('studio.usage_invalid', '/adapter', 'The Studio adapter is invalid.'),
      ]);
    }
    const transactionAdapter =
      faultOperation === undefined
        ? internalAdapter
        : createPostMutationFaultAdapter(internalAdapter, faultOperation);
    const validation = validateRobloxChangeSet(input);
    if (!validation.valid) return applyRobloxChangeSet(transactionAdapter, input);
    if (validation.value.operations.length > STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS) {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.operation_limit_exceeded',
          '/operations',
          `Studio transactions are limited to ${STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS} operations.`,
        ),
      ]);
    }
    return this.#serialized(async () => {
      await this.#assertSandbox();
      return this.#transactionContext.run({ expectedNodes: new Map() }, () =>
        applyRobloxChangeSet(transactionAdapter, validation.value),
      );
    });
  }

  public async captureViewport(
    request: Readonly<StudioViewportCaptureRequest>,
  ): Promise<StudioMcpImageResult> {
    return this.#serialized(async () => {
      await this.#assertSandbox();
      await this.#reassertExactSession();
      return captureStudioViewport(this.#client, request);
    });
  }

  public close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = this.#serialized(() => this.#client.close(), true);
    return this.#closePromise;
  }
}

/** @internal Package-private test wrapper; not exported from the package root. */
export function runAuthorizedStudioTransactionForTesting(
  adapter: StudioMcpRobloxAdapter,
  input: unknown,
  faultOperation: StudioAdapterFaultOperation,
): Promise<ApplyResult> {
  const runner = authorizedStudioTransactionRunners.get(adapter);
  if (runner === undefined) {
    throw new StudioAdapterError([
      studioDiagnostic('studio.usage_invalid', '/adapter', 'The Studio adapter is invalid.'),
    ]);
  }
  return runner(input, faultOperation);
}

async function connectWithSession(
  select: (client: StudioMcpClient) => Promise<StudioSessionSummary>,
  mutationAuthorized: boolean,
): Promise<StudioMcpRobloxAdapter> {
  const client = await connectStudioMcp();
  try {
    const session = await select(client);
    return new StudioMcpRobloxAdapter(
      ADAPTER_CONSTRUCTION_TOKEN,
      client,
      session,
      mutationAuthorized,
    );
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

/** Mutation-safe connection: the caller must supply one exact connected Studio ID. */
export function connectSelectedStudioMcpAdapter(studioId: string): Promise<StudioMcpRobloxAdapter> {
  return connectWithSession((client) => selectStudioSession(client, studioId), true);
}

/** Read-only connection: omission is allowed only when exactly one Studio is connected. */
export function connectReadOnlyStudioMcpAdapter(
  studioId?: string,
): Promise<StudioMcpRobloxAdapter> {
  return connectWithSession((client) => selectReadOnlyStudioSession(client, studioId), false);
}

/** List sanitized connected sessions without exposing the raw MCP client or payload text. */
export async function listConnectedStudioSessions(): Promise<readonly StudioSessionSummary[]> {
  const client = await connectStudioMcp();
  try {
    return await listStudioSessions(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** @internal Offline tests inject a fake local protocol without widening the root API. */
export function createStudioMcpAdapterForTesting(
  client: StudioMcpClient,
  session: StudioSessionSummary,
  mutationAuthorized = true,
): StudioMcpRobloxAdapter {
  return new StudioMcpRobloxAdapter(
    ADAPTER_CONSTRUCTION_TOKEN,
    client,
    session,
    mutationAuthorized,
  );
}
