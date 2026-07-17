import { readFileSync } from 'node:fs';

import {
  hashRobloxChangeSet,
  hashRobloxSnapshot,
  planRobloxChangeSet,
  type RobloxChangeSet,
  type RobloxManagedNode,
  type RobloxManifest,
  type RobloxSnapshot,
} from '@worldwright/roblox-compiler';
import { describe, expect, it } from 'vitest';

import {
  createStudioMcpAdapterForTesting,
  type StudioChangeSetApplyEvidence,
} from '../src/adapter.js';
import { STUDIO_SANDBOX_LEASE_RESPONSE_PREFIX } from '../src/constants.js';
import type { AllowedStudioMcpToolName } from '../src/mcp/capabilities.js';
import { executeFixedStudioBridgeProgram, type StudioMcpClient } from '../src/mcp/client.js';
import {
  parseSandboxLeaseAttribute,
  createSandboxLeaseRecord,
} from '../src/sandbox-lease/record.js';
import { stringifySandboxLeaseRecord } from '../src/sandbox-lease/normalize.js';
import { buildSandboxLeaseProgram } from '../src/sandbox-lease/program.js';
import {
  buildClaimSandboxLeaseRequest,
  buildReadSandboxLeaseRequest,
} from '../src/sandbox-lease/request.js';
import { parseStudioSandboxLeaseResponse } from '../src/sandbox-lease/response.js';
import type {
  StudioSandboxLeaseRecord,
  StudioSandboxLeaseRequest,
  StudioSandboxLeaseResponse,
} from '../src/sandbox-lease/types.js';
import {
  applyStudioChangeSetWithLostForwardAndCompensationAcknowledgments,
  applyStudioChangeSetWithLostBatchAcknowledgment,
  connectStudioMcpForTesting,
} from '../src/testing.js';
import { createFakeStudioAdapter, FakeStudioProtocol, loadCourtyardManifest } from './helpers.js';

const selectedSession = Object.freeze({
  studioId: 'studio-test',
  displayName: 'Unsaved Sandbox',
  active: true,
});

function loadCliffwatchChangeSet(): RobloxChangeSet {
  return JSON.parse(
    readFileSync(
      new URL(
        '../../architecture-planner/fixtures/change-sets/create-cliffwatch-blockout.change-set.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as RobloxChangeSet;
}

function snapshotFromManifest(manifest: Readonly<RobloxManifest>): RobloxSnapshot {
  return {
    schemaVersion: '0.1.0',
    projectId: manifest.source.projectId,
    target: { service: 'Workspace' },
    rootNodeId: manifest.rootNodeId,
    nodes: structuredClone(manifest.nodes),
    unmanagedRoots: [],
  };
}

function renamedManifest(manifest: Readonly<RobloxManifest>, name: string): RobloxManifest {
  return {
    ...structuredClone(manifest),
    nodes: manifest.nodes.map((node) =>
      node.id === 'east-wall' ? { ...structuredClone(node), name } : structuredClone(node),
    ),
  };
}

function requirePlan(
  base: Readonly<RobloxManifest>,
  desired: Readonly<RobloxManifest>,
): RobloxChangeSet {
  const plan = planRobloxChangeSet(snapshotFromManifest(base), desired);
  if (!plan.success) throw new Error('Sandbox lease transaction fixture planning failed.');
  return plan.changeSet;
}

function twoUpdatePlans(): Readonly<{
  original: RobloxManifest;
  firstDesired: RobloxManifest;
  secondDesired: RobloxManifest;
  firstChangeSet: RobloxChangeSet;
  secondChangeSet: RobloxChangeSet;
}> {
  const original = loadCourtyardManifest();
  const firstDesired = renamedManifest(original, 'East Wall Lease One');
  const secondDesired = renamedManifest(firstDesired, 'East Wall Lease Two');
  return {
    original,
    firstDesired,
    secondDesired,
    firstChangeSet: requirePlan(original, firstDesired),
    secondChangeSet: requirePlan(firstDesired, secondDesired),
  };
}

function fixedAction(argumentsValue: Readonly<Record<string, unknown>>): string | undefined {
  const source = argumentsValue['code'];
  if (typeof source !== 'string') return undefined;
  const marker = 'local payloadJson = ';
  const start = source.indexOf(marker);
  if (start < 0) return undefined;
  const match = /^\[(=*)\[([\s\S]*?)\]\1\]/u.exec(source.slice(start + marker.length));
  if (match === null) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(match[2]!) as unknown;
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null || !('action' in payload)) {
    return undefined;
  }
  const action = (payload as { readonly action?: unknown }).action;
  return typeof action === 'string' ? action : undefined;
}

function actionCount(protocol: Readonly<FakeStudioProtocol>, action: string): number {
  return protocol.calls.filter(
    (call) => call.tool === 'execute_luau' && fixedAction(call.argumentsValue) === action,
  ).length;
}

function expectLeaseIdsPrivate(value: unknown, leaseIds: readonly string[]): void {
  const serialized = JSON.stringify(value);
  for (const leaseId of leaseIds) expect(serialized).not.toContain(leaseId);
}

function leaseRecord(
  projectId: string,
  changeSetHash: string,
  leaseId: string,
): StudioSandboxLeaseRecord {
  return createSandboxLeaseRecord(projectId, changeSetHash, () => leaseId);
}

async function executeLeaseRequest(
  client: StudioMcpClient,
  request: Readonly<StudioSandboxLeaseRequest>,
): Promise<StudioSandboxLeaseResponse> {
  const text = await executeFixedStudioBridgeProgram(client, buildSandboxLeaseProgram(request));
  return parseStudioSandboxLeaseResponse(text, request);
}

async function capturedRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the Studio operation to reject.');
}

class DriftAfterClaimProtocol extends FakeStudioProtocol {
  #driftInjected = false;

  public override async invoke(
    tool: AllowedStudioMcpToolName,
    argumentsValue: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const result = await super.invoke(tool, argumentsValue);
    if (
      !this.#driftInjected &&
      tool === 'execute_luau' &&
      fixedAction(argumentsValue) === 'claim_lease'
    ) {
      const current = this.nodes.get('east-wall');
      if (current !== undefined) {
        this.#driftInjected = true;
        this.nodes.set(current.id, { ...current, name: 'Concurrent Creator Edit' });
      }
    }
    return result;
  }
}

class RotateAfterClaimProtocol extends FakeStudioProtocol {
  #rotated = false;

  public constructor(
    initialNodes: readonly RobloxManagedNode[],
    private readonly rotatedAttribute: string,
  ) {
    super({ initialNodes });
  }

  public override async invoke(
    tool: AllowedStudioMcpToolName,
    argumentsValue: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const result = await super.invoke(tool, argumentsValue);
    if (
      !this.#rotated &&
      tool === 'execute_luau' &&
      fixedAction(argumentsValue) === 'claim_lease'
    ) {
      this.#rotated = true;
      this.sandboxLeaseAttribute = this.rotatedAttribute;
    }
    return result;
  }
}

class MaliciousLeaseDiagnosticProtocol extends FakeStudioProtocol {
  public constructor(private readonly attackerLeaseId: string) {
    super();
  }

  public override async invoke(
    tool: AllowedStudioMcpToolName,
    argumentsValue: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    if (tool === 'execute_luau' && fixedAction(argumentsValue) === 'bound_snapshot') {
      return {
        content: [
          {
            type: 'text',
            text: `${STUDIO_SANDBOX_LEASE_RESPONSE_PREFIX}${JSON.stringify({
              protocolVersion: '0.1.0',
              action: 'bound_snapshot',
              ok: false,
              diagnostic: {
                code: 'studio.sandbox_identity_mismatch',
                message: `Current private lease: ${this.attackerLeaseId}`,
              },
            })}\n`,
          },
        ],
        isError: false,
      };
    }
    return super.invoke(tool, argumentsValue);
  }
}

function expectIdentityMismatch(evidence: Readonly<StudioChangeSetApplyEvidence>): void {
  expect(evidence.result).toMatchObject({
    success: false,
    stage: 'apply',
    operationsAttempted: 1,
    rollback: { attempted: true, succeeded: false },
  });
  if (evidence.result.success) throw new Error('Expected a failed Studio transaction.');
  expect(
    evidence.result.diagnostics.some((entry) =>
      entry.message.includes('studio.sandbox_identity_mismatch'),
    ),
  ).toBe(true);
  expect(evidence.transportReport).toMatchObject({
    sandboxLeaseClaimCalls: 1,
    mutationExecuteCalls: 1,
    uncertainTransportEvents: 1,
    reconnectAttempts: 1,
    reconnectsSucceeded: 0,
    compensationOperationsAttempted: 0,
    compensationOperationsApplied: 0,
    compensationChunksAttempted: 0,
    compensationChunksCompleted: 0,
    finalOutcome: 'failed-unrestored',
  });
}

describe('Studio transaction-scoped sandbox lease integration', () => {
  it('does not read, generate, or claim a lease for a canonical no-op', async () => {
    const manifest = loadCourtyardManifest();
    const noOp = requirePlan(manifest, manifest);
    const privateLeaseId = '1'.repeat(64);
    let generated = 0;
    const fake = await createFakeStudioAdapter({
      initialNodes: manifest.nodes,
      leaseIdFactory: () => {
        generated += 1;
        return privateLeaseId;
      },
    });
    try {
      const applied = await fake.adapter.applyChangeSetDetailed(noOp);
      expect(applied.result).toMatchObject({ success: true, status: 'noop' });
      expect(applied.transportReport).toMatchObject({
        operationsPlanned: 0,
        sandboxLeaseClaimCalls: 0,
        mutationExecuteCalls: 0,
        finalOutcome: 'noop',
      });
      expect(generated).toBe(0);
      expect(actionCount(fake.protocol, 'read_lease')).toBe(0);
      expect(actionCount(fake.protocol, 'claim_lease')).toBe(0);
      expect(fake.protocol.sandboxLeaseAttribute).toBeUndefined();
      expectLeaseIdsPrivate(applied, [privateLeaseId]);
    } finally {
      await fake.adapter.close();
    }
  });

  it('claims exactly once for a nonempty transaction and keeps the lease private', async () => {
    const { original, firstChangeSet } = twoUpdatePlans();
    const privateLeaseId = '2'.repeat(64);
    const fake = await createFakeStudioAdapter({
      initialNodes: original.nodes,
      leaseIdFactory: () => privateLeaseId,
    });
    try {
      const applied = await fake.adapter.applyChangeSetDetailed(firstChangeSet);
      expect(applied.result).toMatchObject({
        success: true,
        status: 'applied',
        operationsAttempted: 1,
      });
      expect(applied.transportReport).toMatchObject({
        operationsPlanned: 1,
        sandboxLeaseClaimCalls: 1,
        mutationExecuteCalls: 1,
        finalOutcome: 'applied',
      });
      expect(actionCount(fake.protocol, 'read_lease')).toBe(1);
      expect(actionCount(fake.protocol, 'claim_lease')).toBe(1);
      expect(actionCount(fake.protocol, 'apply_chunk')).toBe(1);
      expect(parseSandboxLeaseAttribute(fake.protocol.sandboxLeaseAttribute)).toMatchObject({
        leaseId: privateLeaseId,
        changeSetHash: hashRobloxChangeSet(firstChangeSet),
      });
      expectLeaseIdsPrivate([applied.result, applied.transportReport], [privateLeaseId]);
    } finally {
      await fake.adapter.close();
    }
  });

  it('rotates a valid old lease on every next nonempty transaction', async () => {
    const { original, firstChangeSet, secondChangeSet } = twoUpdatePlans();
    const oldLeaseId = '3'.repeat(64);
    const firstLeaseId = '4'.repeat(64);
    const secondLeaseId = '5'.repeat(64);
    const oldLease = leaseRecord(original.source.projectId, '6'.repeat(64), oldLeaseId);
    const generatedLeaseIds = [firstLeaseId, secondLeaseId] as const;
    let generationIndex = 0;
    const fake = await createFakeStudioAdapter({
      initialNodes: original.nodes,
      initialSandboxLeaseAttribute: stringifySandboxLeaseRecord(oldLease),
      leaseIdFactory: () => {
        const leaseId = generatedLeaseIds[generationIndex];
        generationIndex += 1;
        if (leaseId === undefined) throw new Error('Unexpected extra sandbox lease generation.');
        return leaseId;
      },
    });
    try {
      const first = await fake.adapter.applyChangeSetDetailed(firstChangeSet);
      expect(first.result).toMatchObject({ success: true, status: 'applied' });
      expect(parseSandboxLeaseAttribute(fake.protocol.sandboxLeaseAttribute)).toMatchObject({
        leaseId: firstLeaseId,
        changeSetHash: hashRobloxChangeSet(firstChangeSet),
      });

      const second = await fake.adapter.applyChangeSetDetailed(secondChangeSet);
      expect(second.result).toMatchObject({ success: true, status: 'applied' });
      expect(parseSandboxLeaseAttribute(fake.protocol.sandboxLeaseAttribute)).toMatchObject({
        leaseId: secondLeaseId,
        changeSetHash: hashRobloxChangeSet(secondChangeSet),
      });
      expect(generationIndex).toBe(2);
      expect(actionCount(fake.protocol, 'claim_lease')).toBe(2);
      expect(first.transportReport.sandboxLeaseClaimCalls).toBe(1);
      expect(second.transportReport.sandboxLeaseClaimCalls).toBe(1);
      expectLeaseIdsPrivate(
        [first.result, first.transportReport, second.result, second.transportReport],
        [oldLeaseId, firstLeaseId, secondLeaseId],
      );
    } finally {
      await fake.adapter.close();
    }
  });

  it('fails closed on a malformed existing lease without overwrite, claim, or node mutation', async () => {
    const { original, firstChangeSet } = twoUpdatePlans();
    const malformedAttribute = '{"schemaVersion":"0.1.0"}';
    const generatedLeaseId = '7'.repeat(64);
    let generated = 0;
    const fake = await createFakeStudioAdapter({
      initialNodes: original.nodes,
      initialSandboxLeaseAttribute: malformedAttribute,
      leaseIdFactory: () => {
        generated += 1;
        return generatedLeaseId;
      },
    });
    try {
      const applied = await fake.adapter.applyChangeSetDetailed(firstChangeSet);
      expect(applied.result).toMatchObject({
        success: false,
        stage: 'apply',
        operationsAttempted: 0,
        rollback: { attempted: false },
      });
      if (applied.result.success) throw new Error('Expected malformed lease rejection.');
      expect(
        applied.result.diagnostics.some((entry) =>
          entry.message.includes('studio.sandbox_lease_invalid'),
        ),
      ).toBe(true);
      expect(applied.transportReport).toMatchObject({
        sandboxLeaseClaimCalls: 0,
        mutationExecuteCalls: 0,
        finalOutcome: 'failed-unrestored',
      });
      expect(generated).toBe(0);
      expect(actionCount(fake.protocol, 'read_lease')).toBe(1);
      expect(actionCount(fake.protocol, 'claim_lease')).toBe(0);
      expect(actionCount(fake.protocol, 'apply_chunk')).toBe(0);
      expect(fake.protocol.sandboxLeaseAttribute).toBe(malformedAttribute);
      expect([...fake.protocol.nodes.values()]).toEqual(original.nodes);
      expectLeaseIdsPrivate([applied.result, applied.transportReport], [generatedLeaseId]);
    } finally {
      await fake.adapter.close();
    }
  });

  it('performs an exact public lease-bound read and rejects every identity mismatch', async () => {
    const { original, firstChangeSet } = twoUpdatePlans();
    const projectId = original.source.projectId;
    const changeSetHash = hashRobloxChangeSet(firstChangeSet);
    const privateLeaseId = '8'.repeat(64);
    const differentLeaseId = '9'.repeat(64);
    const exactLease = leaseRecord(projectId, changeSetHash, privateLeaseId);
    const exact = await createFakeStudioAdapter({
      initialNodes: original.nodes,
      initialSandboxLeaseAttribute: stringifySandboxLeaseRecord(exactLease),
    });
    try {
      const snapshot = await exact.adapter.readLeaseBoundSnapshot(
        { projectId, target: { service: 'Workspace' } },
        changeSetHash,
        privateLeaseId,
      );
      expect(hashRobloxSnapshot(snapshot)).toBe(firstChangeSet.preconditions.baseSnapshotHash);
      expect(actionCount(exact.protocol, 'bound_snapshot')).toBe(1);
      expect(actionCount(exact.protocol, 'claim_lease')).toBe(0);
      expectLeaseIdsPrivate(snapshot, [privateLeaseId]);
    } finally {
      await exact.adapter.close();
    }

    const differentLease = leaseRecord(projectId, changeSetHash, differentLeaseId);
    const cases: readonly Readonly<{
      label: string;
      attribute?: unknown;
      privateIds: readonly string[];
      requestedProjectId?: string;
      requestedChangeSetHash?: string;
    }>[] = [
      { label: 'absent', privateIds: [privateLeaseId] },
      {
        label: 'different',
        attribute: stringifySandboxLeaseRecord(differentLease),
        privateIds: [privateLeaseId, differentLeaseId],
      },
      { label: 'malformed', attribute: '{', privateIds: [privateLeaseId] },
      {
        label: 'wrong project',
        attribute: stringifySandboxLeaseRecord(exactLease),
        privateIds: [privateLeaseId],
        requestedProjectId: 'project-other',
      },
      {
        label: 'wrong Change Set',
        attribute: stringifySandboxLeaseRecord(exactLease),
        privateIds: [privateLeaseId],
        requestedChangeSetHash: '0'.repeat(64),
      },
    ];
    for (const testCase of cases) {
      const fake = await createFakeStudioAdapter({
        initialNodes: original.nodes,
        ...(testCase.attribute === undefined
          ? {}
          : { initialSandboxLeaseAttribute: testCase.attribute }),
      });
      try {
        const error = await capturedRejection(
          fake.adapter.readLeaseBoundSnapshot(
            {
              projectId: testCase.requestedProjectId ?? projectId,
              target: { service: 'Workspace' },
            },
            testCase.requestedChangeSetHash ?? changeSetHash,
            privateLeaseId,
          ),
        );
        expect(error, testCase.label).toMatchObject({
          diagnostics: [expect.objectContaining({ code: 'studio.sandbox_identity_mismatch' })],
        });
        expect(actionCount(fake.protocol, 'bound_snapshot'), testCase.label).toBe(1);
        expect(actionCount(fake.protocol, 'claim_lease'), testCase.label).toBe(0);
        expectLeaseIdsPrivate(error, testCase.privateIds);
      } finally {
        await fake.adapter.close();
      }
    }
  });

  it('replaces untrusted lease failure text with a fixed host-owned diagnostic', async () => {
    const requestedLeaseId = 'a'.repeat(64);
    const attackerLeaseId = 'f'.repeat(64);
    const protocol = new MaliciousLeaseDiagnosticProtocol(attackerLeaseId);
    const client = await connectStudioMcpForTesting(() => protocol);
    const adapter = createStudioMcpAdapterForTesting(client, selectedSession, false);
    try {
      const error = await capturedRejection(
        adapter.readLeaseBoundSnapshot(
          { projectId: 'project-private-diagnostic', target: { service: 'Workspace' } },
          'e'.repeat(64),
          requestedLeaseId,
        ),
      );
      expect(error).toMatchObject({
        diagnostics: [
          expect.objectContaining({
            code: 'studio.sandbox_identity_mismatch',
            message:
              'The fixed Studio sandbox lease bound_snapshot action failed (studio.sandbox_identity_mismatch).',
          }),
        ],
      });
      expectLeaseIdsPrivate(error, [requestedLeaseId, attackerLeaseId]);
    } finally {
      await adapter.close();
    }
  });

  it('stops before batch mutation when the exact base changes after claim and before bound reread', async () => {
    const { original, firstChangeSet } = twoUpdatePlans();
    const privateLeaseId = 'a'.repeat(64);
    const protocol = new DriftAfterClaimProtocol({ initialNodes: original.nodes });
    const client = await connectStudioMcpForTesting(() => protocol);
    const adapter = createStudioMcpAdapterForTesting(
      client,
      selectedSession,
      true,
      undefined,
      () => privateLeaseId,
    );
    try {
      const applied = await adapter.applyChangeSetDetailed(firstChangeSet);
      expect(applied.result).toMatchObject({
        success: false,
        stage: 'stale-check',
        operationsAttempted: 0,
        rollback: { attempted: false },
      });
      expect(applied.transportReport).toMatchObject({
        sandboxLeaseClaimCalls: 1,
        mutationExecuteCalls: 0,
        compensationOperationsAttempted: 0,
        compensationChunksAttempted: 0,
        finalOutcome: 'failed-unrestored',
      });
      expect(actionCount(protocol, 'claim_lease')).toBe(1);
      expect(actionCount(protocol, 'bound_snapshot')).toBe(1);
      expect(actionCount(protocol, 'apply_chunk')).toBe(0);
      expect(protocol.nodes.get('east-wall')?.name).toBe('Concurrent Creator Edit');
      expectLeaseIdsPrivate([applied.result, applied.transportReport], [privateLeaseId]);
    } finally {
      await adapter.close();
    }
  });

  it('preserves the identity cause without misreporting rollback before the first mutation', async () => {
    const { original, firstChangeSet } = twoUpdatePlans();
    const projectId = original.source.projectId;
    const changeSetHash = hashRobloxChangeSet(firstChangeSet);
    const claimedLeaseId = '0'.repeat(64);
    const rotatedLeaseId = '1'.repeat(64);
    const protocol = new RotateAfterClaimProtocol(
      original.nodes,
      stringifySandboxLeaseRecord(leaseRecord(projectId, changeSetHash, rotatedLeaseId)),
    );
    const client = await connectStudioMcpForTesting(() => protocol);
    const adapter = createStudioMcpAdapterForTesting(
      client,
      selectedSession,
      true,
      undefined,
      () => claimedLeaseId,
    );
    try {
      const applied = await adapter.applyChangeSetDetailed(firstChangeSet);
      expect(applied.result).toMatchObject({
        success: false,
        stage: 'snapshot-read',
        operationsAttempted: 0,
        rollback: { attempted: false },
      });
      if (applied.result.success) throw new Error('Expected pre-mutation identity rejection.');
      expect(applied.result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'transaction.apply_failed',
            message: expect.stringContaining('studio.sandbox_identity_mismatch'),
          }),
        ]),
      );
      expect(
        applied.result.diagnostics.some((entry) => entry.code === 'transaction.rollback_failed'),
      ).toBe(false);
      expect(applied.transportReport).toMatchObject({
        sandboxLeaseClaimCalls: 1,
        mutationExecuteCalls: 0,
        compensationOperationsAttempted: 0,
        compensationChunksAttempted: 0,
        finalOutcome: 'failed-unrestored',
      });
      expect(actionCount(protocol, 'apply_chunk')).toBe(0);
      expect([...protocol.nodes.values()]).toEqual(original.nodes);
      expectLeaseIdsPrivate(
        [applied.result, applied.transportReport],
        [claimedLeaseId, rotatedLeaseId],
      );
    } finally {
      await adapter.close();
    }
  });

  for (const replacementKind of ['missing', 'malformed'] as const) {
    it(`rejects a ${replacementKind} lease in the first batch with zero node operations`, async () => {
      const { original, firstChangeSet } = twoUpdatePlans();
      const privateLeaseId = '2'.repeat(64);
      let batchCalls = 0;
      const fake = await createFakeStudioAdapter({
        initialNodes: original.nodes,
        leaseIdFactory: () => privateLeaseId,
        beforeBatch: (protocol) => {
          batchCalls += 1;
          if (batchCalls === 1) {
            protocol.sandboxLeaseAttribute = replacementKind === 'missing' ? undefined : '{';
          }
        },
      });
      try {
        const applied = await fake.adapter.applyChangeSetDetailed(firstChangeSet);
        expect(applied.result).toMatchObject({
          success: false,
          operationsAttempted: 0,
          rollback: { attempted: true, succeeded: false },
        });
        expect(applied.transportReport).toMatchObject({
          operationsAttempted: 0,
          operationsAppliedBeforeFailure: 0,
          chunksAttempted: 1,
          sandboxLeaseClaimCalls: 1,
          mutationExecuteCalls: 1,
          compensationOperationsAttempted: 0,
          compensationChunksAttempted: 0,
          finalOutcome: 'failed-unrestored',
        });
        expect(batchCalls).toBe(1);
        expect(fake.protocol.nodes.get('east-wall')?.name).toBe('East Brick Wall');
        expectLeaseIdsPrivate([applied.result, applied.transportReport], [privateLeaseId]);
      } finally {
        await fake.adapter.close();
      }
    });
  }

  it('rejects a lease rotated before a later chunk and leaves the exact acknowledged prefix', async () => {
    const changeSet = loadCliffwatchChangeSet();
    const privateLeaseId = '3'.repeat(64);
    const rotatedLeaseId = '4'.repeat(64);
    const rotatedLease = leaseRecord(
      changeSet.preconditions.projectId,
      hashRobloxChangeSet(changeSet),
      rotatedLeaseId,
    );
    let batchCalls = 0;
    const fake = await createFakeStudioAdapter({
      leaseIdFactory: () => privateLeaseId,
      beforeBatch: (protocol) => {
        batchCalls += 1;
        if (batchCalls === 2) {
          protocol.sandboxLeaseAttribute = stringifySandboxLeaseRecord(rotatedLease);
        }
      },
    });
    try {
      const applied = await fake.adapter.applyChangeSetDetailed(changeSet);
      expect(applied.result).toMatchObject({
        success: false,
        operationsAttempted: 32,
        rollback: { attempted: true, succeeded: false },
      });
      expect(applied.transportReport).toMatchObject({
        operationsAttempted: 32,
        operationsAppliedBeforeFailure: 32,
        chunksAttempted: 2,
        chunksCompleted: 1,
        sandboxLeaseClaimCalls: 1,
        mutationExecuteCalls: 2,
        compensationOperationsAttempted: 0,
        compensationChunksAttempted: 0,
        finalOutcome: 'failed-unrestored',
      });
      expect(batchCalls).toBe(2);
      expect(fake.protocol.nodes.size).toBe(32);
      expectLeaseIdsPrivate(
        [applied.result, applied.transportReport],
        [privateLeaseId, rotatedLeaseId],
      );
    } finally {
      await fake.adapter.close();
    }
  });

  it('reuses one exact lease through reconnect observation and successful compensation', async () => {
    const { original, firstChangeSet } = twoUpdatePlans();
    const privateLeaseId = '5'.repeat(64);
    const fake = await createFakeStudioAdapter({
      initialNodes: original.nodes,
      leaseIdFactory: () => privateLeaseId,
    });
    try {
      const applied = await applyStudioChangeSetWithLostBatchAcknowledgment(
        fake.adapter,
        firstChangeSet,
      );
      expect(applied.result).toMatchObject({
        success: false,
        rollback: {
          attempted: true,
          succeeded: true,
          restoredSnapshotHash: firstChangeSet.preconditions.baseSnapshotHash,
        },
      });
      expect(applied.transportReport).toMatchObject({
        sandboxLeaseClaimCalls: 1,
        mutationExecuteCalls: 2,
        reconnectAttempts: 1,
        reconnectsSucceeded: 1,
        compensationOperationsAttempted: 1,
        compensationOperationsApplied: 1,
        compensationChunksAttempted: 1,
        compensationChunksCompleted: 1,
        finalOutcome: 'failed-restored',
      });
      expect(actionCount(fake.protocol, 'claim_lease')).toBe(1);
      expect(actionCount(fake.protocol, 'bound_snapshot')).toBeGreaterThanOrEqual(3);
      expect(parseSandboxLeaseAttribute(fake.protocol.sandboxLeaseAttribute)).toMatchObject({
        leaseId: privateLeaseId,
        changeSetHash: hashRobloxChangeSet(firstChangeSet),
      });
      expect(fake.protocol.nodes.get('east-wall')?.name).toBe('East Brick Wall');
      expectLeaseIdsPrivate([applied.result, applied.transportReport], [privateLeaseId]);
    } finally {
      await fake.adapter.close();
    }
  });

  it('rejects a changed lease before compensation without incrementing compensation counts', async () => {
    const { original, firstChangeSet } = twoUpdatePlans();
    const privateLeaseId = '6'.repeat(64);
    const rotatedLeaseId = '7'.repeat(64);
    const rotatedLease = leaseRecord(
      original.source.projectId,
      hashRobloxChangeSet(firstChangeSet),
      rotatedLeaseId,
    );
    let batchCalls = 0;
    const fake = await createFakeStudioAdapter({
      initialNodes: original.nodes,
      leaseIdFactory: () => privateLeaseId,
      beforeBatch: (protocol) => {
        batchCalls += 1;
        if (batchCalls === 2) {
          protocol.sandboxLeaseAttribute = stringifySandboxLeaseRecord(rotatedLease);
        }
      },
    });
    try {
      const applied = await applyStudioChangeSetWithLostBatchAcknowledgment(
        fake.adapter,
        firstChangeSet,
      );
      expect(applied.result).toMatchObject({
        success: false,
        rollback: { attempted: true, succeeded: false },
      });
      if (applied.result.success) throw new Error('Expected compensation identity rejection.');
      expect(
        applied.result.diagnostics.some((entry) =>
          entry.message.includes('studio.sandbox_identity_mismatch'),
        ),
      ).toBe(true);
      expect(applied.transportReport).toMatchObject({
        operationsAttempted: 1,
        operationsAppliedBeforeFailure: 1,
        chunksAttempted: 1,
        sandboxLeaseClaimCalls: 1,
        mutationExecuteCalls: 2,
        reconnectAttempts: 1,
        reconnectsSucceeded: 1,
        compensationOperationsAttempted: 0,
        compensationOperationsApplied: 0,
        compensationChunksAttempted: 0,
        compensationChunksCompleted: 0,
        finalOutcome: 'failed-unrestored',
      });
      expect(batchCalls).toBe(2);
      expect(fake.protocol.nodes.get('east-wall')?.name).toBe('East Wall Lease One');
      expectLeaseIdsPrivate(
        [applied.result, applied.transportReport],
        [privateLeaseId, rotatedLeaseId],
      );
    } finally {
      await fake.adapter.close();
    }
  });

  it('rechecks the original lease before the second reconnect observation', async () => {
    const { original, firstChangeSet } = twoUpdatePlans();
    const privateLeaseId = '8'.repeat(64);
    const rotatedLeaseId = '9'.repeat(64);
    const rotatedLease = leaseRecord(
      original.source.projectId,
      hashRobloxChangeSet(firstChangeSet),
      rotatedLeaseId,
    );
    let batchCalls = 0;
    const fake = await createFakeStudioAdapter({
      initialNodes: original.nodes,
      leaseIdFactory: () => privateLeaseId,
      afterBatch: (protocol) => {
        batchCalls += 1;
        if (batchCalls === 2) {
          protocol.sandboxLeaseAttribute = stringifySandboxLeaseRecord(rotatedLease);
        }
      },
    });
    try {
      const applied = await applyStudioChangeSetWithLostForwardAndCompensationAcknowledgments(
        fake.adapter,
        firstChangeSet,
      );
      expect(applied.result).toMatchObject({
        success: false,
        rollback: { attempted: true, succeeded: false },
      });
      expect(applied.transportReport).toMatchObject({
        sandboxLeaseClaimCalls: 1,
        mutationExecuteCalls: 2,
        uncertainTransportEvents: 2,
        reconnectAttempts: 2,
        reconnectsSucceeded: 1,
        compensationOperationsAttempted: 1,
        compensationOperationsApplied: 0,
        compensationChunksAttempted: 1,
        compensationChunksCompleted: 0,
        finalOutcome: 'failed-unrestored',
      });
      expect(actionCount(fake.protocol, 'claim_lease')).toBe(1);
      expect(actionCount(fake.protocol, 'bound_snapshot')).toBeGreaterThanOrEqual(3);
      expect(fake.protocol.nodes.get('east-wall')?.name).toBe('East Brick Wall');
      expectLeaseIdsPrivate(
        [applied.result, applied.transportReport],
        [privateLeaseId, rotatedLeaseId],
      );
    } finally {
      await fake.adapter.close();
    }
  });

  for (const replacementKind of ['absent', 'different'] as const) {
    it(`fails unrestored after lost acknowledgment when the same Studio reconnects to a distinct DataModel with a ${replacementKind} lease`, async () => {
      const { original, firstDesired, firstChangeSet } = twoUpdatePlans();
      const projectId = original.source.projectId;
      const changeSetHash = hashRobloxChangeSet(firstChangeSet);
      const privateLeaseId = 'b'.repeat(64);
      const differentLeaseId = 'c'.repeat(64);
      const replacementAttribute =
        replacementKind === 'different'
          ? stringifySandboxLeaseRecord(leaseRecord(projectId, changeSetHash, differentLeaseId))
          : undefined;
      const fake = await createFakeStudioAdapter({
        initialNodes: original.nodes,
        leaseIdFactory: () => privateLeaseId,
        reconnectDataModel: {
          initialNodes: firstDesired.nodes,
          ...(replacementAttribute === undefined
            ? {}
            : { sandboxLeaseAttribute: replacementAttribute }),
        },
      });
      try {
        const applied = await applyStudioChangeSetWithLostBatchAcknowledgment(
          fake.adapter,
          firstChangeSet,
        );
        expectIdentityMismatch(applied);
        expect(actionCount(fake.protocol, 'claim_lease')).toBe(1);
        expect(actionCount(fake.protocol, 'apply_chunk')).toBe(1);
        expect(fake.protocol.nodes.get('east-wall')?.name).toBe('East Wall Lease One');
        expect(fake.protocol.nodes.get('east-wall')?.name).not.toBe('East Brick Wall');
        expectLeaseIdsPrivate(
          [applied.result, applied.transportReport],
          replacementKind === 'different' ? [privateLeaseId, differentLeaseId] : [privateLeaseId],
        );
      } finally {
        await fake.adapter.close();
      }
    });
  }
});

describe('fixed Studio sandbox lease protocol behavior', () => {
  it('claims an absent lease and then rotates an exact old lease', async () => {
    const manifest = loadCourtyardManifest();
    const projectId = manifest.source.projectId;
    const firstLeaseId = 'd'.repeat(64);
    const secondLeaseId = 'e'.repeat(64);
    const firstLease = leaseRecord(projectId, '1'.repeat(64), firstLeaseId);
    const secondLease = leaseRecord(projectId, '2'.repeat(64), secondLeaseId);
    const protocol = new FakeStudioProtocol();
    const client = await connectStudioMcpForTesting(() => protocol);
    try {
      const firstRequest = buildClaimSandboxLeaseRequest(undefined, firstLease);
      const firstResponse = await executeLeaseRequest(client, firstRequest);
      expect(firstResponse).toMatchObject({ ok: true, action: 'claim_lease' });
      expect(parseSandboxLeaseAttribute(protocol.sandboxLeaseAttribute)).toEqual(firstLease);

      const secondRequest = buildClaimSandboxLeaseRequest(firstLease, secondLease);
      const secondResponse = await executeLeaseRequest(client, secondRequest);
      expect(secondResponse).toMatchObject({ ok: true, action: 'claim_lease' });
      expect(parseSandboxLeaseAttribute(protocol.sandboxLeaseAttribute)).toEqual(secondLease);
      expect(actionCount(protocol, 'claim_lease')).toBe(2);
      expectLeaseIdsPrivate([firstResponse, secondResponse], [firstLeaseId, secondLeaseId]);
    } finally {
      await client.close();
    }
  });

  it('lets exactly one of two stale compare-and-set claimants succeed', async () => {
    const manifest = loadCourtyardManifest();
    const projectId = manifest.source.projectId;
    const oldLeaseId = '0'.repeat(64);
    const firstLeaseId = '1'.repeat(64);
    const secondLeaseId = '2'.repeat(64);
    const oldLease = leaseRecord(projectId, '3'.repeat(64), oldLeaseId);
    const firstLease = leaseRecord(projectId, '4'.repeat(64), firstLeaseId);
    const secondLease = leaseRecord(projectId, '5'.repeat(64), secondLeaseId);
    const protocol = new FakeStudioProtocol({
      initialSandboxLeaseAttribute: stringifySandboxLeaseRecord(oldLease),
    });
    const firstClient = await connectStudioMcpForTesting(() => protocol);
    const secondClient = await connectStudioMcpForTesting(() => protocol);
    try {
      const readRequest = buildReadSandboxLeaseRequest();
      const [firstRead, secondRead] = await Promise.all([
        executeLeaseRequest(firstClient, readRequest),
        executeLeaseRequest(secondClient, readRequest),
      ]);
      if (
        !firstRead.ok ||
        firstRead.action !== 'read_lease' ||
        !secondRead.ok ||
        secondRead.action !== 'read_lease'
      ) {
        throw new Error('Both claimants must read the same valid old lease.');
      }
      expect(firstRead.lease).toEqual(oldLease);
      expect(secondRead.lease).toEqual(oldLease);

      const responses = await Promise.all([
        executeLeaseRequest(
          firstClient,
          buildClaimSandboxLeaseRequest(firstRead.lease, firstLease),
        ),
        executeLeaseRequest(
          secondClient,
          buildClaimSandboxLeaseRequest(secondRead.lease, secondLease),
        ),
      ]);
      expect(responses.filter((response) => response.ok)).toHaveLength(1);
      expect(responses.filter((response) => !response.ok)).toHaveLength(1);
      expect(responses.find((response) => !response.ok)).toMatchObject({
        diagnostic: { code: 'studio.sandbox_lease_conflict' },
      });
      expect(parseSandboxLeaseAttribute(protocol.sandboxLeaseAttribute)).toEqual(firstLease);
      expect(actionCount(protocol, 'read_lease')).toBe(2);
      expect(actionCount(protocol, 'claim_lease')).toBe(2);
      expectLeaseIdsPrivate(responses, [firstLeaseId, secondLeaseId]);
    } finally {
      await Promise.all([firstClient.close(), secondClient.close()]);
    }
  });

  it('rejects direct claims in published and running Studio sessions without writing the attribute', async () => {
    const manifest = loadCourtyardManifest();
    const privateLeaseId = 'f'.repeat(64);
    const record = leaseRecord(manifest.source.projectId, 'a'.repeat(64), privateLeaseId);
    const cases = [
      {
        label: 'published',
        options: { placeId: 42 },
        code: 'studio.published_place_forbidden',
      },
      {
        label: 'running',
        options: { running: true },
        code: 'studio.edit_mode_required',
      },
    ] as const;
    for (const testCase of cases) {
      const protocol = new FakeStudioProtocol(testCase.options);
      const client = await connectStudioMcpForTesting(() => protocol);
      try {
        const response = await executeLeaseRequest(
          client,
          buildClaimSandboxLeaseRequest(undefined, record),
        );
        expect(response, testCase.label).toMatchObject({
          ok: false,
          action: 'claim_lease',
          diagnostic: { code: testCase.code },
        });
        expect(protocol.sandboxLeaseAttribute, testCase.label).toBeUndefined();
        expect(actionCount(protocol, 'claim_lease'), testCase.label).toBe(1);
        expectLeaseIdsPrivate(response, [privateLeaseId]);
      } finally {
        await client.close();
      }
    }
  });
});
