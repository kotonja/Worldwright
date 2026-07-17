import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  hashRobloxChangeSet,
  planRobloxChangeSet,
  type RobloxSnapshot,
} from '@worldwright/roblox-compiler';
import { afterEach, describe, expect, it } from 'vitest';

import { runStudioMcpCli, type StudioMcpCliDependencies } from '../src/cli.js';
import { StudioAdapterError, studioDiagnostic } from '../src/diagnostics.js';
import { connectStudioMcpForTesting } from '../src/testing.js';
import {
  createFakeStudioAdapter,
  emptySnapshot,
  type FakeStudioProtocol,
  loadCourtyardManifest,
} from './helpers.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function ioCapture(): {
  readonly io: { writeStdout(value: string): void; writeStderr(value: string): void };
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
    },
    stdout,
    stderr,
  };
}

async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'worldwright-studio-cli-'));
  temporaryDirectories.push(path);
  return path;
}

async function dependencies(
  options: Parameters<typeof createFakeStudioAdapter>[0] = {},
  evidenceDirectory?: string,
): Promise<{
  readonly dependencies: StudioMcpCliDependencies;
  readonly protocol: FakeStudioProtocol;
}> {
  const { adapter, protocol } = await createFakeStudioAdapter(options);
  return {
    protocol,
    dependencies: {
      connectClient: async () => connectStudioMcpForTesting(() => protocol),
      connectSelectedAdapter: async () => adapter,
      connectReadOnlyAdapter: async () => adapter,
      ...(evidenceDirectory === undefined ? {} : { evidenceDirectory }),
    },
  };
}

function progressDependencies(
  observedSnapshot: Readonly<RobloxSnapshot>,
  acceptedLeaseId: string,
): {
  readonly dependencies: StudioMcpCliDependencies;
  readonly calls: Array<{
    readonly scope: unknown;
    readonly changeSetHash: string;
    readonly leaseId: string;
  }>;
  readonly state: {
    selectedStudioIds: string[];
    readOnlyConnections: number;
    closeCalls: number;
  };
} {
  const calls: Array<{
    readonly scope: unknown;
    readonly changeSetHash: string;
    readonly leaseId: string;
  }> = [];
  const state = { selectedStudioIds: [] as string[], readOnlyConnections: 0, closeCalls: 0 };
  const adapter = {
    async readLeaseBoundSnapshot(
      scope: unknown,
      changeSetHash: string,
      leaseId: string,
    ): Promise<RobloxSnapshot> {
      calls.push({ scope: structuredClone(scope), changeSetHash, leaseId });
      if (leaseId !== acceptedLeaseId) {
        throw new StudioAdapterError([
          studioDiagnostic(
            'studio.sandbox_identity_mismatch',
            '/sandboxLease',
            'The current Studio sandbox does not match the requested transaction lease.',
          ),
        ]);
      }
      return structuredClone(observedSnapshot);
    },
    async close(): Promise<void> {
      state.closeCalls += 1;
    },
  } as unknown as Awaited<ReturnType<StudioMcpCliDependencies['connectReadOnlyAdapter']>>;
  return {
    calls,
    state,
    dependencies: {
      connectClient: async () => {
        throw new Error('Unexpected client connection.');
      },
      connectSelectedAdapter: async () => {
        throw new Error('Unexpected mutation-authorized adapter connection.');
      },
      connectReadOnlyAdapter: async (studioId) => {
        if (studioId === undefined) throw new Error('Expected an exact Studio ID.');
        state.selectedStudioIds.push(studioId);
        state.readOnlyConnections += 1;
        return adapter;
      },
    },
  };
}

describe('Studio MCP CLI', () => {
  it('documents usage and rejects unknown or missing arguments without a stack trace', async () => {
    const help = ioCapture();
    expect(await runStudioMcpCli(['--help'], help.io)).toBe(0);
    expect(help.stdout.join('')).toContain('studio-mcp apply');
    expect(help.stdout.join('')).toContain('studio-mcp progress');
    expect(help.stdout.join('')).toContain('--sandbox-lease-id <64-lowercase-hex>');

    const invalid = ioCapture();
    expect(await runStudioMcpCli(['apply', '--studio-id', 'studio-test'], invalid.io)).toBe(2);
    expect(invalid.stderr.join('')).toContain('studio.usage_invalid');
    expect(invalid.stderr.join('')).not.toMatch(/\n\s+at\s/u);

    for (const unsafe of ['unknown\u001b[31m', 'unknown\u202evalue']) {
      const output = ioCapture();
      expect(await runStudioMcpCli([unsafe], output.io)).toBe(2);
      expect(output.stderr.join('')).not.toContain(unsafe);
      expect(
        [...output.stderr.join('')].some(
          (character) => character === '\u001b' || character === '\u202e',
        ),
      ).toBe(false);
    }
  });

  it('classifies read-only live progress without attempting mutation', async () => {
    const directory = await tempDirectory();
    const manifest = loadCourtyardManifest();
    const base = emptySnapshot(manifest);
    const plan = planRobloxChangeSet(base, manifest);
    if (!plan.success) throw new Error('Fixture planning failed.');
    const basePath = join(directory, 'base.snapshot.json');
    const changeSetPath = join(directory, 'change-set.json');
    await writeFile(basePath, `${JSON.stringify(base, null, 2)}\n`, 'utf8');
    await writeFile(changeSetPath, `${JSON.stringify(plan.changeSet, null, 2)}\n`, 'utf8');
    const sandboxLeaseId = 'a'.repeat(64);
    const progress = progressDependencies(base, sandboxLeaseId);
    const output = ioCapture();
    const exitCode = await runStudioMcpCli(
      [
        'progress',
        '--studio-id',
        'studio-test',
        '--base-snapshot',
        basePath,
        '--change-set',
        changeSetPath,
        '--sandbox-lease-id',
        sandboxLeaseId,
        '--json',
      ],
      output.io,
      progress.dependencies,
    );
    if (exitCode !== 0) {
      throw new Error(`Progress CLI failed: ${output.stderr.join('')}${output.stdout.join('')}`);
    }
    expect(JSON.parse(output.stdout.join(''))).toMatchObject({
      success: true,
      progress: { classification: 'base', appliedPrefixLength: 0 },
    });
    expect(output.stdout.join('')).not.toContain(sandboxLeaseId);
    expect(output.stderr.join('')).not.toContain(sandboxLeaseId);
    expect(progress.calls).toEqual([
      {
        scope: {
          projectId: plan.changeSet.preconditions.projectId,
          target: plan.changeSet.preconditions.target,
        },
        changeSetHash: hashRobloxChangeSet(plan.changeSet),
        leaseId: sandboxLeaseId,
      },
    ]);
    expect(progress.state).toEqual({
      selectedStudioIds: ['studio-test'],
      readOnlyConnections: 1,
      closeCalls: 1,
    });
  });

  it.each([
    { label: 'prefix', nodeCount: 1, classification: 'prefix', exitCode: 0 },
    { label: 'complete', nodeCount: 'all', classification: 'complete', exitCode: 0 },
    { label: 'unsafe', nodeCount: 'unsafe', classification: 'unsafe', exitCode: 1 },
  ] as const)(
    'reports $label read-only progress with the documented domain exit code',
    async ({ nodeCount, classification, exitCode }) => {
      const directory = await tempDirectory();
      const manifest = loadCourtyardManifest();
      const base = emptySnapshot(manifest);
      const plan = planRobloxChangeSet(base, manifest);
      if (!plan.success) throw new Error('Fixture planning failed.');
      const first = plan.changeSet.operations[0];
      if (first?.type !== 'create') throw new Error('Expected a create operation.');
      const initialNodes =
        nodeCount === 'all'
          ? manifest.nodes
          : nodeCount === 'unsafe'
            ? [{ ...first.node, name: 'Unauthorized third state' }]
            : [first.node];
      const basePath = join(directory, 'base.snapshot.json');
      const changeSetPath = join(directory, 'change-set.json');
      await writeFile(basePath, `${JSON.stringify(base, null, 2)}\n`, 'utf8');
      await writeFile(changeSetPath, `${JSON.stringify(plan.changeSet, null, 2)}\n`, 'utf8');
      const observed: RobloxSnapshot = {
        ...base,
        rootNodeId: first.node.id,
        nodes: structuredClone(initialNodes),
      };
      const sandboxLeaseId = 'a'.repeat(64);
      const progress = progressDependencies(observed, sandboxLeaseId);
      const output = ioCapture();
      expect(
        await runStudioMcpCli(
          [
            'progress',
            '--studio-id',
            'studio-test',
            '--base-snapshot',
            basePath,
            '--change-set',
            changeSetPath,
            '--sandbox-lease-id',
            sandboxLeaseId,
            '--json',
          ],
          output.io,
          progress.dependencies,
        ),
      ).toBe(exitCode);
      expect(JSON.parse(output.stdout.join(''))).toMatchObject({
        success: exitCode === 0,
        progress: { classification },
      });
      expect(output.stdout.join('')).not.toContain(sandboxLeaseId);
      expect(output.stderr.join('')).not.toContain(sandboxLeaseId);
      expect(progress.calls).toHaveLength(1);
      expect(progress.state.readOnlyConnections).toBe(1);
    },
  );

  it('rejects missing or malformed progress lease IDs before connecting', async () => {
    const directory = await tempDirectory();
    const manifest = loadCourtyardManifest();
    const base = emptySnapshot(manifest);
    const plan = planRobloxChangeSet(base, manifest);
    if (!plan.success) throw new Error('Fixture planning failed.');
    const basePath = join(directory, 'base.snapshot.json');
    const changeSetPath = join(directory, 'change-set.json');
    await writeFile(basePath, `${JSON.stringify(base, null, 2)}\n`, 'utf8');
    await writeFile(changeSetPath, `${JSON.stringify(plan.changeSet, null, 2)}\n`, 'utf8');
    const acceptedLeaseId = 'a'.repeat(64);
    const progress = progressDependencies(base, acceptedLeaseId);
    const baseArgs = [
      'progress',
      '--studio-id',
      'studio-test',
      '--base-snapshot',
      basePath,
      '--change-set',
      changeSetPath,
    ] as const;

    for (const candidate of [undefined, '', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(63)}g`]) {
      const output = ioCapture();
      const args = [
        ...baseArgs,
        ...(candidate === undefined ? [] : ['--sandbox-lease-id', candidate]),
        '--json',
      ];
      expect(await runStudioMcpCli(args, output.io, progress.dependencies)).toBe(2);
      expect(JSON.parse(output.stdout.join(''))).toMatchObject({
        success: false,
        diagnostics: [expect.objectContaining({ code: 'studio.usage_invalid' })],
      });
      expect(output.stdout.join('')).not.toContain(acceptedLeaseId);
      if (candidate !== undefined && candidate.length > 0) {
        expect(output.stdout.join('')).not.toContain(candidate);
        expect(output.stderr.join('')).not.toContain(candidate);
      }
    }
    expect(progress.calls).toHaveLength(0);
    expect(progress.state).toEqual({
      selectedStudioIds: [],
      readOnlyConnections: 0,
      closeCalls: 0,
    });
  });

  it('returns unsafe domain status for a mismatched progress lease without exposing either ID', async () => {
    const directory = await tempDirectory();
    const manifest = loadCourtyardManifest();
    const base = emptySnapshot(manifest);
    const plan = planRobloxChangeSet(base, manifest);
    if (!plan.success) throw new Error('Fixture planning failed.');
    const basePath = join(directory, 'base.snapshot.json');
    const changeSetPath = join(directory, 'change-set.json');
    await writeFile(basePath, `${JSON.stringify(base, null, 2)}\n`, 'utf8');
    await writeFile(changeSetPath, `${JSON.stringify(plan.changeSet, null, 2)}\n`, 'utf8');
    const acceptedLeaseId = 'a'.repeat(64);
    const suppliedLeaseId = 'b'.repeat(64);
    const progress = progressDependencies(base, acceptedLeaseId);
    const output = ioCapture();

    expect(
      await runStudioMcpCli(
        [
          'progress',
          '--studio-id',
          'studio-test',
          '--base-snapshot',
          basePath,
          '--change-set',
          changeSetPath,
          '--sandbox-lease-id',
          suppliedLeaseId,
          '--json',
        ],
        output.io,
        progress.dependencies,
      ),
    ).toBe(1);
    expect(JSON.parse(output.stdout.join(''))).toMatchObject({
      success: false,
      diagnostics: [expect.objectContaining({ code: 'studio.sandbox_identity_mismatch' })],
    });
    expect(`${output.stdout.join('')}${output.stderr.join('')}`).not.toContain(acceptedLeaseId);
    expect(`${output.stdout.join('')}${output.stderr.join('')}`).not.toContain(suppliedLeaseId);
    expect(progress.calls).toHaveLength(1);
    expect(progress.state).toEqual({
      selectedStudioIds: ['studio-test'],
      readOnlyConnections: 1,
      closeCalls: 1,
    });
  });

  it('lists sanitized sessions and emits canonical JSON', async () => {
    const fake = await dependencies();
    const output = ioCapture();
    expect(await runStudioMcpCli(['probe', '--json'], output.io, fake.dependencies)).toBe(0);
    const parsed = JSON.parse(output.stdout.join('')) as {
      success: boolean;
      sessions: readonly { studioId: string }[];
    };
    expect(parsed).toEqual({
      sessions: [{ active: true, displayName: 'Unsaved Sandbox', studioId: 'studio-test' }],
      success: true,
    });
    expect(output.stderr).toEqual([]);
  });

  it('snapshots, plans, applies with exact confirmation, and verifies independently', async () => {
    const directory = await tempDirectory();
    const evidenceDirectory = join(directory, '.worldwright', 'live-milestone-3');
    await mkdir(evidenceDirectory, { recursive: true });
    const manifest = loadCourtyardManifest();
    const manifestPath = join(directory, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const snapshotFake = await dependencies();
    const snapshotOutput = join(directory, 'snapshot.json');
    const snapshotIo = ioCapture();
    expect(
      await runStudioMcpCli(
        [
          'snapshot',
          '--studio-id',
          'studio-test',
          '--project-id',
          manifest.source.projectId,
          '--output',
          snapshotOutput,
          '--json',
        ],
        snapshotIo.io,
        snapshotFake.dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(await readFile(snapshotOutput, 'utf8'))).toMatchObject({ nodes: [] });

    const planFake = await dependencies();
    const changeSetPath = join(directory, 'change-set.json');
    const planIo = ioCapture();
    expect(
      await runStudioMcpCli(
        [
          'plan-live',
          '--studio-id',
          'studio-test',
          '--manifest',
          manifestPath,
          '--output',
          changeSetPath,
          '--json',
        ],
        planIo.io,
        planFake.dependencies,
      ),
    ).toBe(0);
    const changeSet = JSON.parse(await readFile(changeSetPath, 'utf8'));
    const changeSetHash = hashRobloxChangeSet(changeSet);

    const privateLeaseId = '0123456789abcdef'.repeat(4);
    const applyFake = await dependencies(
      { leaseIdFactory: () => privateLeaseId },
      evidenceDirectory,
    );
    const receiptPath = join(evidenceDirectory, 'receipt.json');
    const applyIo = ioCapture();
    expect(
      await runStudioMcpCli(
        [
          'apply',
          '--studio-id',
          'studio-test',
          '--change-set',
          changeSetPath,
          '--confirm',
          changeSetHash,
          '--receipt-output',
          receiptPath,
          '--json',
        ],
        applyIo.io,
        applyFake.dependencies,
      ),
    ).toBe(0);
    const receiptText = await readFile(receiptPath, 'utf8');
    expect(JSON.parse(receiptText)).toMatchObject({ status: 'applied' });
    expect(JSON.parse(applyIo.stdout.join(''))).toMatchObject({
      success: true,
      transactionSucceeded: true,
      transportReport: {
        mode: 'chunked',
        finalOutcome: 'applied',
        operationsPlanned: manifest.nodes.length,
        chunksAttempted: 1,
        mutationExecuteCalls: 1,
      },
      transportReportHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(`${applyIo.stdout.join('')}${applyIo.stderr.join('')}${receiptText}`).not.toContain(
      privateLeaseId,
    );

    const unwritableReceipt = join(evidenceDirectory, 'existing-receipt.json');
    await writeFile(unwritableReceipt, 'preserve me', 'utf8');
    const receiptFailureFake = await dependencies({}, evidenceDirectory);
    const receiptFailureIo = ioCapture();
    expect(
      await runStudioMcpCli(
        [
          'apply',
          '--studio-id',
          'studio-test',
          '--change-set',
          changeSetPath,
          '--confirm',
          changeSetHash,
          '--receipt-output',
          unwritableReceipt,
          '--json',
        ],
        receiptFailureIo.io,
        receiptFailureFake.dependencies,
      ),
    ).toBe(2);
    expect(await readFile(unwritableReceipt, 'utf8')).toBe('preserve me');
    expect(receiptFailureFake.protocol.nodes.size).toBe(0);
    expect(receiptFailureFake.protocol.calls).toHaveLength(0);
    expect(JSON.parse(receiptFailureIo.stdout.join(''))).toMatchObject({
      success: false,
      diagnostics: [expect.objectContaining({ code: 'studio.io_failed' })],
    });

    const staleFake = await dependencies({ initialNodes: manifest.nodes });
    const staleIo = ioCapture();
    expect(
      await runStudioMcpCli(
        [
          'apply',
          '--studio-id',
          'studio-test',
          '--change-set',
          changeSetPath,
          '--confirm',
          changeSetHash,
          '--json',
        ],
        staleIo.io,
        staleFake.dependencies,
      ),
    ).toBe(1);
    expect(JSON.parse(staleIo.stdout.join(''))).toMatchObject({
      success: false,
      transactionSucceeded: false,
      result: { success: false, stage: 'stale-check' },
      receipt: {
        status: 'failed',
        observedFailureSnapshotHash: expect.any(String),
      },
    });
    expect(staleFake.protocol.nodes.size).toBe(manifest.nodes.length);

    const verifyFake = await dependencies({ initialNodes: manifest.nodes });
    const verifyIo = ioCapture();
    expect(
      await runStudioMcpCli(
        ['verify', '--studio-id', 'studio-test', '--manifest', manifestPath, '--json'],
        verifyIo.io,
        verifyFake.dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(verifyIo.stdout.join(''))).toMatchObject({ success: true, matches: true });
  }, 10_000);

  it('reports restored batch failure and fails closed when exact-session re-probe fails', async () => {
    const directory = await tempDirectory();
    const manifest = loadCourtyardManifest();
    const plan = planRobloxChangeSet(emptySnapshot(manifest), manifest);
    if (!plan.success) throw new Error('Fixture planning failed.');
    const changeSetPath = join(directory, 'change-set.json');
    await writeFile(changeSetPath, `${JSON.stringify(plan.changeSet, null, 2)}\n`, 'utf8');
    const confirmation = hashRobloxChangeSet(plan.changeSet);
    const args = [
      'apply',
      '--studio-id',
      'studio-test',
      '--change-set',
      changeSetPath,
      '--confirm',
      confirmation,
      '--json',
    ] as const;

    const restored = await dependencies({ throwAfter: 'create' });
    const restoredOutput = ioCapture();
    expect(await runStudioMcpCli(args, restoredOutput.io, restored.dependencies)).toBe(1);
    expect(JSON.parse(restoredOutput.stdout.join(''))).toMatchObject({
      success: false,
      transactionSucceeded: false,
      result: {
        success: false,
        stage: 'apply',
        rollback: { attempted: true, succeeded: true },
      },
      transportReport: {
        finalOutcome: 'failed-restored',
        uncertainTransportEvents: 1,
        reconnectAttempts: 1,
        reconnectsSucceeded: 1,
      },
    });
    expect(restored.protocol.nodes.size).toBe(0);

    const reconnectFailure = await dependencies({
      throwAfter: 'create',
      beforeReconnect: (protocol) => {
        protocol.placeId = 42;
        protocol.gameId = 42;
      },
    });
    const reconnectOutput = ioCapture();
    expect(await runStudioMcpCli(args, reconnectOutput.io, reconnectFailure.dependencies)).toBe(1);
    expect(JSON.parse(reconnectOutput.stdout.join(''))).toMatchObject({
      success: false,
      transactionSucceeded: false,
      result: {
        success: false,
        stage: 'apply',
        rollback: {
          attempted: true,
          succeeded: false,
          diagnostics: [expect.objectContaining({ code: 'transaction.rollback_failed' })],
        },
      },
      transportReport: {
        finalOutcome: 'failed-unrestored',
        uncertainTransportEvents: 1,
        reconnectAttempts: 1,
        reconnectsSucceeded: 0,
      },
    });
    expect(reconnectFailure.protocol.nodes.size).toBe(1);
  });

  it('removes an incomplete reserved receipt after a post-mutation write failure', async () => {
    const directory = await tempDirectory();
    const evidenceDirectory = join(directory, '.worldwright', 'live-milestone-3');
    await mkdir(evidenceDirectory, { recursive: true });
    const manifest = loadCourtyardManifest();
    const plan = planRobloxChangeSet(emptySnapshot(manifest), manifest);
    if (!plan.success) throw new Error('Expected a valid test change set.');
    const changeSetPath = join(directory, 'change-set.json');
    await writeFile(changeSetPath, `${JSON.stringify(plan.changeSet, null, 2)}\n`, 'utf8');
    const changeSetHash = hashRobloxChangeSet(plan.changeSet);
    const failedReceiptPath = join(evidenceDirectory, 'failed-receipt.json');
    const fake = await dependencies({}, evidenceDirectory);
    const output = ioCapture();
    expect(
      await runStudioMcpCli(
        [
          'apply',
          '--studio-id',
          'studio-test',
          '--change-set',
          changeSetPath,
          '--confirm',
          changeSetHash,
          '--receipt-output',
          failedReceiptPath,
          '--json',
        ],
        output.io,
        {
          ...fake.dependencies,
          finalizeReceipt: async (handle) => {
            await handle.writeFile('{"partial":', { encoding: 'utf8' });
            throw new Error('injected write failure');
          },
        },
      ),
    ).toBe(2);
    await expect(readFile(failedReceiptPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fake.protocol.nodes.size).toBe(manifest.nodes.length);
    expect(JSON.parse(output.stdout.join(''))).toMatchObject({
      success: false,
      transactionSucceeded: true,
      receiptWritten: false,
      diagnostics: [expect.objectContaining({ code: 'studio.io_failed' })],
    });
  });

  it('rejects incomplete confirmation before connection or mutation', async () => {
    const directory = await tempDirectory();
    const evidenceDirectory = join(directory, '.worldwright', 'live-milestone-3');
    await mkdir(evidenceDirectory, { recursive: true });
    const manifest = loadCourtyardManifest();
    const plan = planRobloxChangeSet(emptySnapshot(manifest), manifest);
    if (!plan.success) throw new Error('Fixture planning failed.');
    const path = join(directory, 'change-set.json');
    await writeFile(path, `${JSON.stringify(plan.changeSet, null, 2)}\n`, 'utf8');
    const fake = await dependencies({}, evidenceDirectory);
    const output = ioCapture();
    expect(
      await runStudioMcpCli(
        [
          'apply',
          '--studio-id',
          'studio-test',
          '--change-set',
          path,
          '--confirm',
          hashRobloxChangeSet(plan.changeSet).slice(0, 16),
          '--json',
        ],
        output.io,
        fake.dependencies,
      ),
    ).toBe(2);
    expect(fake.protocol.calls).toHaveLength(0);
    expect(JSON.parse(output.stdout.join(''))).toMatchObject({
      success: false,
      diagnostics: [expect.objectContaining({ code: 'studio.usage_invalid' })],
    });

    const outsideOutput = ioCapture();
    expect(
      await runStudioMcpCli(
        [
          'apply',
          '--studio-id',
          'studio-test',
          '--change-set',
          path,
          '--confirm',
          hashRobloxChangeSet(plan.changeSet),
          '--receipt-output',
          join(directory, 'outside-receipt.json'),
          '--json',
        ],
        outsideOutput.io,
        fake.dependencies,
      ),
    ).toBe(2);
    expect(fake.protocol.calls).toHaveLength(0);
    expect(JSON.parse(outsideOutput.stdout.join(''))).toMatchObject({
      success: false,
      diagnostics: [expect.objectContaining({ code: 'studio.io_failed' })],
    });

    const junctionTarget = join(directory, 'junction-target');
    await mkdir(junctionTarget);
    const junctionPath = join(evidenceDirectory, 'junction-escape');
    await symlink(junctionTarget, junctionPath, process.platform === 'win32' ? 'junction' : 'dir');
    const junctionOutput = ioCapture();
    expect(
      await runStudioMcpCli(
        [
          'apply',
          '--studio-id',
          'studio-test',
          '--change-set',
          path,
          '--confirm',
          hashRobloxChangeSet(plan.changeSet),
          '--receipt-output',
          join(junctionPath, 'escaped-receipt.json'),
          '--json',
        ],
        junctionOutput.io,
        fake.dependencies,
      ),
    ).toBe(2);
    expect(fake.protocol.calls).toHaveLength(0);
    expect(JSON.parse(junctionOutput.stdout.join(''))).toMatchObject({
      success: false,
      diagnostics: [expect.objectContaining({ code: 'studio.io_failed' })],
    });
  });

  it('captures one bounded image and rejects published places', async () => {
    const directory = await tempDirectory();
    const captureDirectory = join(directory, '.worldwright', 'live-milestone-3');
    await mkdir(captureDirectory, { recursive: true });
    const capturePath = join(captureDirectory, 'viewport.jpg');
    const fake = await dependencies({}, captureDirectory);
    const output = ioCapture();
    expect(
      await runStudioMcpCli(
        ['capture', '--studio-id', 'studio-test', '--output', capturePath, '--json'],
        output.io,
        fake.dependencies,
      ),
    ).toBe(0);
    expect((await readFile(capturePath)).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    const outsideFake = await dependencies();
    const outsideIo = ioCapture();
    expect(
      await runStudioMcpCli(
        [
          'capture',
          '--studio-id',
          'studio-test',
          '--output',
          join(directory, 'outside.jpg'),
          '--json',
        ],
        outsideIo.io,
        outsideFake.dependencies,
      ),
    ).toBe(2);
    expect(outsideFake.protocol.calls).toHaveLength(0);

    const published = await dependencies({ placeId: 100 });
    const publishedIo = ioCapture();
    expect(
      await runStudioMcpCli(
        [
          'snapshot',
          '--studio-id',
          'studio-test',
          '--project-id',
          loadCourtyardManifest().source.projectId,
          '--json',
        ],
        publishedIo.io,
        published.dependencies,
      ),
    ).toBe(2);
    expect(JSON.parse(publishedIo.stdout.join(''))).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'studio.published_place_forbidden' })],
    });
  });
});
