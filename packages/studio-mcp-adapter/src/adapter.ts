import { AsyncLocalStorage } from 'node:async_hooks';

import {
  applyRobloxChangeSet,
  applyRobloxChangeSetBatched,
  hashRobloxChangeSet,
  validateRobloxChangeSet,
  type ApplyResult,
  type RobloxAdapter,
  type RobloxAdapterScope,
  type RobloxChangeOperation,
  type RobloxManagedNode,
  type RobloxMutationPreparationInput,
  type RobloxMutationPreparationOutcome,
  type RobloxOperationBatchAdapter,
  type RobloxOperationBatchContext,
  type RobloxSnapshot,
} from '@worldwright/roblox-compiler';

import { StudioBatchTransactionTransport } from './batch/transport.js';
import { buildCreateProgram } from './bridge/create-program.js';
import { buildDeleteProgram } from './bridge/delete-program.js';
import { parseStudioBridgeResponse } from './bridge/response.js';
import { buildProbeProgram, buildSnapshotProgram } from './bridge/snapshot-program.js';
import { buildUpdateProgram } from './bridge/update-program.js';
import { STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS } from './constants.js';
import {
  StudioExactSessionLease,
  type StudioMcpClientFactory,
  type StudioReconnectState,
} from './connection/session-lease.js';
import {
  reconnectExactStudioSessionForObservation,
  reconnectExactStudioSessionWithVerifiedObservation,
} from './connection/reconnect.js';
import { StudioAdapterError, studioDiagnostic, type StudioDiagnostic } from './diagnostics.js';
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
import { snapshotFromStudioCompact } from './snapshot.js';
import {
  buildBoundSandboxSnapshotRequest,
  buildClaimSandboxLeaseRequest,
  buildReadSandboxLeaseRequest,
  createSandboxLeaseRecord,
  generateSandboxLeaseId,
  parseStudioSandboxLeaseResponse,
  type SandboxLeaseIdFactory,
  type StudioSandboxLeaseRecord,
  type StudioSandboxLeaseRequest,
  type StudioSandboxLeaseResponse,
} from './sandbox-lease/index.js';
import { buildSandboxLeaseProgram } from './sandbox-lease/program.js';
import type { StudioTransportReport } from './report-types.js';
import type { StudioBridgeResponse } from './types.js';

const ADAPTER_CONSTRUCTION_TOKEN = Symbol('worldwright.studioMcp.adapterConstruction');
export type StudioAdapterFaultOperation = 'create' | 'update' | 'delete';
const internalStudioTransactionAdapters = new WeakMap<StudioMcpRobloxAdapter, RobloxAdapter>();
const internalStudioBatchAdapters = new WeakMap<
  StudioMcpRobloxAdapter,
  RobloxOperationBatchAdapter
>();
const authorizedStudioTransactionRunners = new WeakMap<
  StudioMcpRobloxAdapter,
  (input: unknown, faultOperation?: StudioAdapterFaultOperation) => Promise<ApplyResult>
>();
const lostAcknowledgmentRunners = new WeakMap<
  StudioMcpRobloxAdapter,
  (input: unknown) => Promise<StudioChangeSetApplyEvidence>
>();
const doubleLostAcknowledgmentRunners = new WeakMap<
  StudioMcpRobloxAdapter,
  (input: unknown) => Promise<StudioChangeSetApplyEvidence>
>();

export interface StudioChangeSetApplyEvidence {
  readonly result: ApplyResult;
  readonly transportReport: StudioTransportReport;
}

interface StudioTransactionContext {
  readonly expectedNodes: Map<string, RobloxManagedNode>;
  readonly reconnectState: StudioReconnectState;
  readonly sandboxLease: { record?: StudioSandboxLeaseRecord };
  readonly batchTransport?: StudioBatchTransactionTransport;
  sandboxIdentityDiagnostic?: StudioDiagnostic;
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
  readonly #lease: StudioExactSessionLease;
  readonly #transactionContext = new AsyncLocalStorage<StudioTransactionContext>();
  readonly #mutationAuthorized: boolean;
  readonly #sandboxLeaseIdFactory: SandboxLeaseIdFactory;
  #transactionTail: Promise<void> = Promise.resolve();
  #closing = false;
  #closePromise: Promise<void> | undefined;

  /** @internal Construct through the package factories. */
  public constructor(
    token: symbol,
    client: StudioMcpClient,
    session: StudioSessionSummary,
    mutationAuthorized: boolean,
    connectClient: StudioMcpClientFactory = connectStudioMcp,
    sandboxLeaseIdFactory: SandboxLeaseIdFactory = generateSandboxLeaseId,
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
    this.#lease = new StudioExactSessionLease(client, session, connectClient);
    this.#mutationAuthorized = mutationAuthorized;
    this.#sandboxLeaseIdFactory = sandboxLeaseIdFactory;
    const transactionAdapter = Object.freeze({
      readSnapshot: (scope: Readonly<RobloxAdapterScope>): Promise<unknown> =>
        this.#readSnapshot(scope),
      prepareForMutation: (
        input: Readonly<RobloxMutationPreparationInput>,
      ): Promise<RobloxMutationPreparationOutcome> => this.#prepareForMutation(input),
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
    const batchAdapter: RobloxOperationBatchAdapter = Object.freeze({
      ...transactionAdapter,
      applyOperationBatch: (
        scope: Readonly<RobloxAdapterScope>,
        operations: readonly Readonly<RobloxChangeOperation>[],
        context: Readonly<RobloxOperationBatchContext>,
      ) => {
        const transport = this.#transactionContext.getStore()?.batchTransport;
        if (transport === undefined) {
          throw new StudioAdapterError([
            StudioBatchTransactionTransport.diagnosticForMissingContext(),
          ]);
        }
        return transport.applyOperationBatch(scope, operations, context);
      },
    });
    internalStudioBatchAdapters.set(this, batchAdapter);
    authorizedStudioTransactionRunners.set(this, (input, faultOperation) =>
      this.#runAuthorizedTransaction(input, faultOperation),
    );
    lostAcknowledgmentRunners.set(this, (input) => this.#runDetailedTransaction(input, true));
    doubleLostAcknowledgmentRunners.set(this, (input) =>
      this.#runDetailedTransaction(input, true, true),
    );
  }

  public get studioId(): string {
    return this.#lease.studioId;
  }

  public get displayName(): string {
    return this.#lease.displayName;
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
    return this.#runFixedOnClient(this.#lease.currentClient(), action, program, expectedNodeId);
  }

  async #runFixedOnClient(
    client: StudioMcpClient,
    action: 'probe' | 'snapshot' | 'create' | 'update' | 'delete',
    program: FixedStudioBridgeProgram,
    expectedNodeId?: string,
  ): Promise<StudioBridgeResponse> {
    await selectStudioSession(client, this.#lease.studioId);
    const text = await executeFixedStudioBridgeProgram(client, program);
    return parseStudioBridgeResponse(text, action, expectedNodeId);
  }

  async #runSandboxLeaseRequestOnClient(
    client: StudioMcpClient,
    request: Readonly<StudioSandboxLeaseRequest>,
  ): Promise<StudioSandboxLeaseResponse> {
    await selectStudioSession(client, this.#lease.studioId);
    const text = await executeFixedStudioBridgeProgram(client, buildSandboxLeaseProgram(request));
    return parseStudioSandboxLeaseResponse(text, request);
  }

  #requireSandboxLeaseSuccess(
    response: Readonly<StudioSandboxLeaseResponse>,
  ): asserts response is Extract<StudioSandboxLeaseResponse, { readonly ok: true }> {
    if (response.ok) return;
    throw new StudioAdapterError([
      studioDiagnostic(
        response.diagnostic.code,
        '/workspaceLease',
        `The fixed Studio sandbox lease ${response.action} action failed (${response.diagnostic.code}).`,
      ),
    ]);
  }

  async #readLeaseBoundSnapshotOnClient(
    client: StudioMcpClient,
    scope: Readonly<RobloxAdapterScope>,
    record: Readonly<StudioSandboxLeaseRecord>,
  ): Promise<RobloxSnapshot> {
    const request = buildBoundSandboxSnapshotRequest(record);
    const response = await this.#runSandboxLeaseRequestOnClient(client, request);
    this.#requireSandboxLeaseSuccess(response);
    if (response.action !== 'bound_snapshot') {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.response_invalid',
          '/action',
          'Studio lease-bound snapshot response is invalid.',
        ),
      ]);
    }
    return snapshotFromStudioCompact(response.compactSnapshot, scope.projectId);
  }

  async #reassertExactSession(): Promise<void> {
    await this.#lease.reassertExactSession();
  }

  async #probeClient(client: StudioMcpClient): Promise<StudioSandboxProbe> {
    await selectStudioSession(client, this.#lease.studioId);
    const state = parseStudioStateText(await client.getStudioStateText());
    if (!state.editAvailable || state.playtesting) {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.edit_mode_required',
          '/probe/dataModelMode',
          'Worldwright requires a stopped Studio session with Edit execution available.',
        ),
      ]);
    }
    const response = successSnapshot(
      await this.#runFixedOnClient(client, 'probe', buildProbeProgram()),
    );
    if (response.action !== 'probe') {
      throw new StudioAdapterError([
        studioDiagnostic('studio.response_invalid', '/action', 'Studio probe response is invalid.'),
      ]);
    }
    return {
      studioId: this.#lease.studioId,
      placeName: sanitizeStudioDisplayName(response.probe.placeName),
      placeId: response.probe.placeId,
      gameId: response.probe.gameId,
      dataModelMode: 'Edit',
      playtesting: state.playtesting || response.probe.isRunning,
      editExecutionAvailable: state.editAvailable && response.probe.isEditAvailable,
    };
  }

  async #probeSelectedStudioUnlocked(): Promise<StudioSandboxProbe> {
    return this.#probeClient(this.#lease.currentClient());
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

  #preparationFailure(error: unknown): RobloxMutationPreparationOutcome {
    const cause = error instanceof StudioAdapterError ? error.diagnostics[0] : undefined;
    return {
      success: false,
      diagnostics: [
        {
          code: 'transaction.apply_failed',
          severity: 'error',
          path: '/preparation',
          message:
            cause === undefined
              ? 'The Studio sandbox lease could not be prepared.'
              : `${cause.code}: ${cause.message}`,
        },
      ],
    };
  }

  async #prepareForMutation(
    input: Readonly<RobloxMutationPreparationInput>,
  ): Promise<RobloxMutationPreparationOutcome> {
    const context = this.#transactionContext.getStore();
    const transport = context?.batchTransport;
    if (
      context === undefined ||
      transport === undefined ||
      context.sandboxLease.record !== undefined
    ) {
      return this.#preparationFailure(
        new StudioAdapterError([
          studioDiagnostic(
            'studio.usage_invalid',
            '/preparation',
            'Studio sandbox lease preparation requires one active transaction.',
          ),
        ]),
      );
    }

    try {
      const readRequest = buildReadSandboxLeaseRequest();
      const readResponse = await this.#runSandboxLeaseRequestOnClient(
        this.#lease.currentClient(),
        readRequest,
      );
      this.#requireSandboxLeaseSuccess(readResponse);
      if (readResponse.action !== 'read_lease') {
        throw new StudioAdapterError([
          studioDiagnostic(
            'studio.response_invalid',
            '/action',
            'Studio sandbox lease read response is invalid.',
          ),
        ]);
      }

      const record = createSandboxLeaseRecord(
        input.scope.projectId,
        input.changeSetHash,
        this.#sandboxLeaseIdFactory,
      );
      const claimRequest = buildClaimSandboxLeaseRequest(readResponse.lease, record);
      const claimProgram = buildSandboxLeaseProgram(claimRequest);
      const client = this.#lease.currentClient();
      await selectStudioSession(client, this.#lease.studioId);
      transport.recordSandboxLeaseClaimCall();

      let claimResponse: StudioSandboxLeaseResponse;
      try {
        const text = await executeFixedStudioBridgeProgram(client, claimProgram);
        try {
          claimResponse = parseStudioSandboxLeaseResponse(text, claimRequest);
        } catch (error) {
          await this.#lease.markUncertainMutation(context.reconnectState);
          throw error;
        }
      } catch (error) {
        if (!context.reconnectState.needsReconnect) {
          await this.#lease.markUncertainMutation(context.reconnectState);
        }
        throw error;
      }
      this.#requireSandboxLeaseSuccess(claimResponse);
      if (claimResponse.action !== 'claim_lease') {
        throw new StudioAdapterError([
          studioDiagnostic(
            'studio.response_invalid',
            '/action',
            'Studio sandbox lease claim response is invalid.',
          ),
        ]);
      }

      context.sandboxLease.record = record;
      transport.bindSandboxLease(record);
      return { success: true };
    } catch (error) {
      return this.#preparationFailure(error);
    }
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
    context.batchTransport?.replaceObservedSnapshot(snapshot);
    if (context.batchTransport !== undefined) return;
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
      const context = this.#transactionContext.getStore();
      const sandboxLease = context?.sandboxLease.record;
      if (context !== undefined && sandboxLease !== undefined) {
        try {
          const observation = await reconnectExactStudioSessionWithVerifiedObservation(
            this.#lease,
            context.reconnectState,
            async (candidate) => {
              assertSandboxStudioProbe(await this.#probeClient(candidate));
              return this.#readLeaseBoundSnapshotOnClient(candidate, scope, sandboxLease);
            },
          );
          const snapshot =
            observation.verified ??
            (await this.#readLeaseBoundSnapshotOnClient(observation.client, scope, sandboxLease));
          this.#replaceExpectedNodes(snapshot);
          return snapshot;
        } catch (error) {
          if (error instanceof StudioAdapterError) {
            const identityDiagnostic = error.diagnostics.find(
              (entry) => entry.code === 'studio.sandbox_identity_mismatch',
            );
            if (identityDiagnostic !== undefined) {
              context.sandboxIdentityDiagnostic = identityDiagnostic;
            }
          }
          throw error;
        }
      }
      const client = await reconnectExactStudioSessionForObservation(
        this.#lease,
        context?.reconnectState,
        async (candidate) => {
          assertSandboxStudioProbe(await this.#probeClient(candidate));
        },
      );
      const response = successSnapshot(
        await this.#runFixedOnClient(client, 'snapshot', buildSnapshotProgram(scope.projectId)),
      );
      if (response.action !== 'snapshot') {
        throw new StudioAdapterError([
          studioDiagnostic('studio.snapshot_invalid', '', 'Studio snapshot response is invalid.'),
        ]);
      }
      const snapshot = snapshotFromStudioCompact(response.compactSnapshot, scope.projectId);
      this.#replaceExpectedNodes(snapshot);
      return snapshot;
    });
  }

  public async readSnapshot(scope: Readonly<RobloxAdapterScope>): Promise<RobloxSnapshot> {
    return this.#readSnapshot(scope);
  }

  /** Authoritative read-only recovery observation bound to one private transaction lease. */
  public async readLeaseBoundSnapshot(
    scope: Readonly<RobloxAdapterScope>,
    changeSetHash: string,
    sandboxLeaseId: string,
  ): Promise<RobloxSnapshot> {
    assertScope(scope);
    const record = createSandboxLeaseRecord(scope.projectId, changeSetHash, () => sandboxLeaseId);
    return this.#serialized(async () => {
      await this.#assertSandbox();
      return this.#readLeaseBoundSnapshotOnClient(this.#lease.currentClient(), scope, record);
    });
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
    const validation = validateRobloxChangeSet(input);
    if (!validation.valid) {
      const internalAdapter = internalStudioTransactionAdapters.get(this);
      if (internalAdapter === undefined) {
        throw new StudioAdapterError([
          studioDiagnostic('studio.usage_invalid', '/adapter', 'The Studio adapter is invalid.'),
        ]);
      }
      return applyRobloxChangeSet(internalAdapter, input);
    }
    return (await this.#runDetailedTransaction(validation.value)).result;
  }

  /** Applies through chunked transport and returns separate deterministic transport evidence. */
  public async applyChangeSetDetailed(input: unknown): Promise<StudioChangeSetApplyEvidence> {
    return this.#runDetailedTransaction(input);
  }

  async #runDetailedTransaction(
    input: unknown,
    discardNextForwardAcknowledgment = false,
    discardNextCompensationAcknowledgment = false,
  ): Promise<StudioChangeSetApplyEvidence> {
    if (!this.#mutationAuthorized) {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.usage_invalid',
          '/adapter',
          'A read-only auto-selected Studio adapter cannot apply a change set.',
        ),
      ]);
    }
    const validation = validateRobloxChangeSet(input);
    if (!validation.valid) {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.transaction_failed',
          '/changeSet',
          'Chunked Studio apply requires a valid complete Roblox Change Set.',
        ),
      ]);
    }
    if (validation.value.operations.length > STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS) {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.operation_limit_exceeded',
          '/operations',
          `Studio transactions are limited to ${STUDIO_MCP_MAX_CHANGE_SET_OPERATIONS} operations.`,
        ),
      ]);
    }
    const batchAdapter = internalStudioBatchAdapters.get(this);
    if (batchAdapter === undefined) {
      throw new StudioAdapterError([
        studioDiagnostic('studio.usage_invalid', '/adapter', 'The Studio adapter is invalid.'),
      ]);
    }
    const changeSetHash = hashRobloxChangeSet(validation.value);
    const transport = new StudioBatchTransactionTransport({
      projectId: validation.value.preconditions.projectId,
      changeSetHash,
      operationsPlanned: validation.value.operations.length,
      lease: this.#lease,
      discardNextForwardAcknowledgment,
      discardNextCompensationAcknowledgment,
    });
    return this.#serialized(async () => {
      await this.#assertSandbox();
      const transactionContext: StudioTransactionContext = {
        expectedNodes: transport.expectedNodes,
        reconnectState: transport.reconnectState,
        sandboxLease: {},
        batchTransport: transport,
      };
      const compilerResult = await this.#transactionContext.run(transactionContext, () =>
        applyRobloxChangeSetBatched(batchAdapter, validation.value, transport.planBatches),
      );
      const result: ApplyResult =
        compilerResult.success || transactionContext.sandboxIdentityDiagnostic === undefined
          ? compilerResult
          : (() => {
              const causeCode = compilerResult.rollback.attempted
                ? ('transaction.rollback_failed' as const)
                : ('transaction.apply_failed' as const);
              const cause = {
                code: causeCode,
                severity: 'error' as const,
                path: '/sandboxLease',
                message: `${transactionContext.sandboxIdentityDiagnostic.code}: ${transactionContext.sandboxIdentityDiagnostic.message}`,
              };
              return {
                ...compilerResult,
                diagnostics: [...compilerResult.diagnostics, cause],
                rollback:
                  compilerResult.rollback.attempted && !compilerResult.rollback.succeeded
                    ? {
                        ...compilerResult.rollback,
                        diagnostics: [...compilerResult.rollback.diagnostics, cause],
                      }
                    : compilerResult.rollback,
              };
            })();
      return { result, transportReport: transport.buildReport(result) };
    });
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
    return (
      await this.#runDetailedTransaction(
        input,
        // The testing-only legacy helper now injects a lost fixed-batch
        // acknowledgment so every Studio mutation remains lease-bound.
        faultOperation !== undefined,
      )
    ).result;
  }

  public async captureViewport(
    request: Readonly<StudioViewportCaptureRequest>,
  ): Promise<StudioMcpImageResult> {
    return this.#serialized(async () => {
      await this.#assertSandbox();
      await this.#reassertExactSession();
      return captureStudioViewport(this.#lease.currentClient(), request);
    });
  }

  public close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = this.#serialized(() => this.#lease.close(), true);
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

/** @internal Testing-only controlled loss after Studio completes one forward batch. */
export function runStudioBatchLostAcknowledgmentForTesting(
  adapter: StudioMcpRobloxAdapter,
  input: unknown,
): Promise<StudioChangeSetApplyEvidence> {
  const runner = lostAcknowledgmentRunners.get(adapter);
  if (runner === undefined) {
    throw new StudioAdapterError([
      studioDiagnostic('studio.usage_invalid', '/adapter', 'The Studio adapter is invalid.'),
    ]);
  }
  return runner(input);
}

/** @internal Testing-only controlled loss after forward and compensating batches complete. */
export function runStudioBatchDoubleLostAcknowledgmentForTesting(
  adapter: StudioMcpRobloxAdapter,
  input: unknown,
): Promise<StudioChangeSetApplyEvidence> {
  const runner = doubleLostAcknowledgmentRunners.get(adapter);
  if (runner === undefined) {
    throw new StudioAdapterError([
      studioDiagnostic('studio.usage_invalid', '/adapter', 'The Studio adapter is invalid.'),
    ]);
  }
  return runner(input);
}

async function connectWithSession(
  select: (client: StudioMcpClient) => Promise<StudioSessionSummary>,
  mutationAuthorized: boolean,
  sandboxLeaseIdFactory?: SandboxLeaseIdFactory,
): Promise<StudioMcpRobloxAdapter> {
  const client = await connectStudioMcp();
  try {
    const session = await select(client);
    return new StudioMcpRobloxAdapter(
      ADAPTER_CONSTRUCTION_TOKEN,
      client,
      session,
      mutationAuthorized,
      connectStudioMcp,
      sandboxLeaseIdFactory,
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

/**
 * @internal Live Milestone 5 acceptance only. This is deliberately absent from
 * the package root so ordinary callers cannot choose transaction lease IDs.
 */
export function connectSelectedStudioMcpAdapterWithSandboxLeaseForLivePlaytest(
  studioId: string,
  sandboxLeaseId: string,
): Promise<StudioMcpRobloxAdapter> {
  // Reuse the strict lease contract without retaining or presenting the value.
  createSandboxLeaseRecord('live-playtest-lease-validation', '0'.repeat(64), () => sandboxLeaseId);
  return connectWithSession(
    (client) => selectStudioSession(client, studioId),
    true,
    () => sandboxLeaseId,
  );
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
  connectClient?: StudioMcpClientFactory,
  sandboxLeaseIdFactory?: SandboxLeaseIdFactory,
): StudioMcpRobloxAdapter {
  return new StudioMcpRobloxAdapter(
    ADAPTER_CONSTRUCTION_TOKEN,
    client,
    session,
    mutationAuthorized,
    connectClient,
    sandboxLeaseIdFactory,
  );
}
