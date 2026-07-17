import {
  type ApplyResult,
  type RobloxAdapterScope,
  type RobloxChangeOperation,
  type RobloxManagedNode,
  type RobloxOperationBatchContext,
  type RobloxOperationBatchOutcome,
  type RobloxOperationBatchPlanInput,
  type RobloxOperationBatchPlanner,
  type RobloxSnapshot,
} from '@worldwright/roblox-compiler';

import {
  createStudioReconnectState,
  type StudioExactSessionLease,
  type StudioReconnectState,
} from '../connection/session-lease.js';
import { studioDiagnostic } from '../diagnostics.js';
import { executeFixedStudioBatchProgram } from '../mcp/client.js';
import { buildStudioTransportReport } from '../transport-report.js';
import type {
  StudioTransportCounters,
  StudioTransportFinalOutcome,
  StudioTransportReport,
} from '../report-types.js';
import { chunkStudioBatchOperations } from './chunk.js';
import { buildStudioBatchBridgeProgram } from './program.js';
import { buildStudioBatchOperations } from './request.js';
import { parseStudioBatchResponse } from './response.js';
import type { StudioBatchRequest } from './types.js';
import type { StudioSandboxLeaseRecord } from '../sandbox-lease/types.js';

interface PreparedStudioBatch {
  readonly request: Readonly<StudioBatchRequest>;
  readonly operationIds: readonly string[];
}

function operationNodeId(operation: Readonly<RobloxChangeOperation>): string {
  return operation.type === 'create' ? operation.node.id : operation.before.id;
}

function cacheKey(
  context: Readonly<RobloxOperationBatchContext>,
  operations: readonly Readonly<RobloxChangeOperation>[],
): string {
  return `${context.phase}:${String(context.batchIndex)}:${String(context.operationOffset)}:${context.changeSetHash}:${operations.map((operation) => operation.id).join(',')}`;
}

function failureOutcome(
  attempted: number,
  applied: number,
  operation: Readonly<RobloxChangeOperation> | undefined,
  code: string,
): RobloxOperationBatchOutcome {
  return {
    success: false,
    stateCertain: true,
    operationsAttempted: attempted,
    operationsApplied: applied,
    diagnostics: [
      {
        code: 'transaction.apply_failed',
        severity: 'error',
        path: '',
        message: `${code}: The fixed Studio batch operation failed.`,
        ...(operation === undefined ? {} : { relatedId: operationNodeId(operation) }),
      },
    ],
  };
}

function finalOutcome(
  result: Readonly<ApplyResult>,
  counters: Readonly<StudioTransportCounters>,
): StudioTransportFinalOutcome {
  if (result.success) return result.status === 'noop' ? 'noop' : 'applied';
  if (result.rollback.attempted && result.rollback.succeeded) return 'failed-restored';
  if (
    result.rollback.attempted &&
    !result.rollback.succeeded &&
    counters.compensationChunksAttempted === 0 &&
    result.rollback.diagnostics.some(
      (entry) => entry.code === 'transaction.rollback_unsafe_observed_state',
    )
  ) {
    return 'failed-unsafe';
  }
  return 'failed-unrestored';
}

export class StudioBatchTransactionTransport {
  readonly #projectId: string;
  readonly #changeSetHash: string;
  readonly #lease: StudioExactSessionLease;
  readonly #prepared = new Map<string, PreparedStudioBatch>();
  readonly #expectedNodes = new Map<string, RobloxManagedNode>();
  readonly #reconnectState: StudioReconnectState = createStudioReconnectState();
  readonly #counters: StudioTransportCounters;
  #sandboxLeaseId: string | undefined;
  #discardNextForwardAcknowledgment: boolean;
  #discardNextCompensationAcknowledgment: boolean;
  #acknowledgmentDiscarded = false;
  #compensationAcknowledgmentDiscarded = false;
  #observedRecoveryPrefixRecorded = false;

  public constructor(
    input: Readonly<{
      projectId: string;
      changeSetHash: string;
      operationsPlanned: number;
      lease: StudioExactSessionLease;
      discardNextForwardAcknowledgment?: boolean;
      discardNextCompensationAcknowledgment?: boolean;
    }>,
  ) {
    this.#projectId = input.projectId;
    this.#changeSetHash = input.changeSetHash;
    this.#lease = input.lease;
    this.#discardNextForwardAcknowledgment = input.discardNextForwardAcknowledgment === true;
    this.#discardNextCompensationAcknowledgment =
      input.discardNextCompensationAcknowledgment === true;
    this.#counters = {
      changeSetHash: input.changeSetHash,
      operationsPlanned: input.operationsPlanned,
      operationsAttempted: 0,
      operationsAppliedBeforeFailure: 0,
      chunksPlanned: 0,
      chunksAttempted: 0,
      chunksCompleted: 0,
      sandboxLeaseClaimCalls: 0,
      mutationExecuteCalls: 0,
      uncertainTransportEvents: 0,
      reconnectAttempts: 0,
      reconnectsSucceeded: 0,
      compensationOperationsAttempted: 0,
      compensationOperationsApplied: 0,
      compensationChunksAttempted: 0,
      compensationChunksCompleted: 0,
    };
  }

  public get reconnectState(): StudioReconnectState {
    return this.#reconnectState;
  }

  public get expectedNodes(): Map<string, RobloxManagedNode> {
    return this.#expectedNodes;
  }

  public recordSandboxLeaseClaimCall(): void {
    if (this.#counters.sandboxLeaseClaimCalls !== 0) {
      throw new Error('Studio sandbox lease claim call was already recorded.');
    }
    this.#counters.sandboxLeaseClaimCalls = 1;
  }

  public bindSandboxLease(record: Readonly<StudioSandboxLeaseRecord>): void {
    if (
      this.#sandboxLeaseId !== undefined ||
      record.projectId !== this.#projectId ||
      record.changeSetHash !== this.#changeSetHash
    ) {
      throw new Error('Studio sandbox lease cannot be bound to this transaction.');
    }
    this.#sandboxLeaseId = record.leaseId;
  }

  public replaceObservedSnapshot(snapshot: Readonly<RobloxSnapshot>): void {
    this.#expectedNodes.clear();
    for (const node of snapshot.nodes) this.#expectedNodes.set(node.id, structuredClone(node));
    this.#prepared.clear();
  }

  #recordExpectedOperation(operation: Readonly<RobloxChangeOperation>): void {
    switch (operation.type) {
      case 'create':
        this.#expectedNodes.set(operation.node.id, structuredClone(operation.node));
        return;
      case 'update':
        this.#expectedNodes.set(operation.after.id, structuredClone(operation.after));
        return;
      case 'delete':
        this.#expectedNodes.delete(operation.before.id);
    }
  }

  public readonly planBatches: RobloxOperationBatchPlanner = (
    input: Readonly<RobloxOperationBatchPlanInput>,
  ) => {
    if (input.changeSetHash !== this.#changeSetHash) {
      throw new Error('Studio batch planner change-set identity mismatch.');
    }
    if (this.#sandboxLeaseId === undefined) {
      throw new Error('Studio batch planner requires the claimed sandbox lease.');
    }
    const preparedOperations = buildStudioBatchOperations(input.operations, [
      ...this.#expectedNodes.values(),
    ]);
    const chunks = chunkStudioBatchOperations({
      projectId: this.#projectId,
      changeSetHash: input.changeSetHash,
      sandboxLeaseId: this.#sandboxLeaseId,
      operations: preparedOperations,
    });
    if (input.phase === 'forward') {
      this.#counters.chunksPlanned = chunks.length;
    } else if (!this.#observedRecoveryPrefixRecorded) {
      // Compiler Change Sets target each node at most once, so the fresh
      // observation-derived inverse contains exactly one operation per applied
      // forward-prefix operation. Record that authoritative observed count
      // instead of guessing from an unacknowledged response.
      this.#counters.operationsAppliedBeforeFailure = input.operations.length;
      this.#observedRecoveryPrefixRecorded = true;
    }

    const batches: Array<readonly Readonly<RobloxChangeOperation>[]> = [];
    let operationOffset = 0;
    for (let batchIndex = 0; batchIndex < chunks.length; batchIndex += 1) {
      const chunk = chunks[batchIndex]!;
      const operations = input.operations.slice(
        operationOffset,
        operationOffset + chunk.request.operations.length,
      );
      const context: RobloxOperationBatchContext = {
        changeSetHash: input.changeSetHash,
        phase: input.phase,
        batchIndex,
        operationOffset,
      };
      this.#prepared.set(cacheKey(context, operations), {
        request: chunk.request,
        operationIds: operations.map((operation) => operation.id),
      });
      batches.push(operations);
      operationOffset += operations.length;
    }
    return batches;
  };

  public async applyOperationBatch(
    scope: Readonly<RobloxAdapterScope>,
    operations: readonly Readonly<RobloxChangeOperation>[],
    context: Readonly<RobloxOperationBatchContext>,
  ): Promise<RobloxOperationBatchOutcome> {
    if (
      scope.projectId !== this.#projectId ||
      scope.target.service !== 'Workspace' ||
      context.changeSetHash !== this.#changeSetHash
    ) {
      return failureOutcome(0, 0, operations[0], 'studio.project_mismatch');
    }
    const prepared = this.#prepared.get(cacheKey(context, operations));
    if (
      prepared === undefined ||
      prepared.operationIds.length !== operations.length ||
      !prepared.operationIds.every((id, index) => id === operations[index]?.id)
    ) {
      return failureOutcome(0, 0, operations[0], 'studio.response_invalid');
    }

    let program;
    try {
      program = buildStudioBatchBridgeProgram(prepared.request);
      await this.#lease.reassertExactSession();
    } catch {
      return failureOutcome(0, 0, operations[0], 'studio.response_invalid');
    }

    if (context.phase === 'forward') this.#counters.chunksAttempted += 1;
    else this.#counters.compensationChunksAttempted += 1;
    this.#counters.mutationExecuteCalls += 1;

    let text: string;
    try {
      text = await executeFixedStudioBatchProgram(this.#lease.currentClient(), program);
    } catch {
      if (context.phase === 'forward') this.#counters.operationsAttempted += operations.length;
      else this.#counters.compensationOperationsAttempted += operations.length;
      await this.#lease.markUncertainMutation(this.#reconnectState);
      throw new Error('Uncertain Studio batch transport outcome.');
    }

    if (
      context.phase === 'forward' &&
      this.#discardNextForwardAcknowledgment &&
      !this.#acknowledgmentDiscarded
    ) {
      this.#acknowledgmentDiscarded = true;
      this.#discardNextForwardAcknowledgment = false;
      this.#counters.operationsAttempted += operations.length;
      await this.#lease.markUncertainMutation(this.#reconnectState);
      throw new Error('Testing-only lost Studio batch acknowledgment.');
    }
    if (
      context.phase === 'compensation' &&
      this.#discardNextCompensationAcknowledgment &&
      !this.#compensationAcknowledgmentDiscarded
    ) {
      this.#compensationAcknowledgmentDiscarded = true;
      this.#discardNextCompensationAcknowledgment = false;
      this.#counters.compensationOperationsAttempted += operations.length;
      await this.#lease.markUncertainMutation(this.#reconnectState);
      throw new Error('Testing-only lost Studio compensation batch acknowledgment.');
    }

    let response;
    try {
      response = parseStudioBatchResponse(text, prepared.request);
    } catch {
      if (context.phase === 'forward') this.#counters.operationsAttempted += operations.length;
      else this.#counters.compensationOperationsAttempted += operations.length;
      await this.#lease.markUncertainMutation(this.#reconnectState);
      throw new Error('Uncertain malformed Studio batch response.');
    }

    if (context.phase === 'forward') {
      this.#counters.operationsAttempted += response.operationsAttempted;
      this.#counters.operationsAppliedBeforeFailure += response.operationsApplied;
    } else {
      this.#counters.compensationOperationsAttempted += response.operationsAttempted;
      this.#counters.compensationOperationsApplied += response.operationsApplied;
    }
    for (let index = 0; index < response.operationsApplied; index += 1) {
      this.#recordExpectedOperation(operations[index]!);
    }

    if (
      !response.ok &&
      !response.localRestoreSucceeded &&
      response.diagnostic.code === 'studio.sandbox_identity_mismatch' &&
      response.operationsAttempted === 0 &&
      response.operationsApplied === 0
    ) {
      if (context.phase === 'compensation') {
        this.#counters.compensationChunksAttempted -= 1;
      }
      return failureOutcome(0, 0, operations[0], response.diagnostic.code);
    }
    if (!response.ok && !response.localRestoreSucceeded) {
      await this.#lease.markUncertainMutation(this.#reconnectState);
      throw new Error('Studio batch local restoration was not proven.');
    }
    if (response.ok) {
      if (context.phase === 'forward') this.#counters.chunksCompleted += 1;
      else this.#counters.compensationChunksCompleted += 1;
      return {
        success: true,
        operationsAttempted: response.operationsAttempted,
        operationsApplied: response.operationsApplied,
      };
    }
    const failedIndex = Math.min(response.operationsApplied, operations.length - 1);
    return failureOutcome(
      response.operationsAttempted,
      response.operationsApplied,
      operations[failedIndex],
      response.diagnostic.code,
    );
  }

  public buildReport(result: Readonly<ApplyResult>): StudioTransportReport {
    this.#counters.uncertainTransportEvents = this.#reconnectState.uncertainTransportEvents;
    this.#counters.reconnectAttempts = this.#reconnectState.reconnectAttempts;
    this.#counters.reconnectsSucceeded = this.#reconnectState.reconnectsSucceeded;
    return buildStudioTransportReport(this.#counters, finalOutcome(result, this.#counters));
  }

  public static diagnosticForMissingContext() {
    return studioDiagnostic(
      'studio.usage_invalid',
      '/adapter',
      'Studio batch mutation is available only inside the verified transaction executor.',
    );
  }
}
