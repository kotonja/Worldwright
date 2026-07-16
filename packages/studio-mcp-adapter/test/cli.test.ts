import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashRobloxChangeSet, planRobloxChangeSet } from '@worldwright/roblox-compiler';
import { afterEach, describe, expect, it } from 'vitest';

import { runStudioMcpCli, type StudioMcpCliDependencies } from '../src/cli.js';
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

describe('Studio MCP CLI', () => {
  it('documents usage and rejects unknown or missing arguments without a stack trace', async () => {
    const help = ioCapture();
    expect(await runStudioMcpCli(['--help'], help.io)).toBe(0);
    expect(help.stdout.join('')).toContain('studio-mcp apply');

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

    const applyFake = await dependencies({}, evidenceDirectory);
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
    expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toMatchObject({ status: 'applied' });

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
    const capturePath = join(captureDirectory, 'viewport.png');
    const fake = await dependencies({}, captureDirectory);
    const output = ioCapture();
    expect(
      await runStudioMcpCli(
        ['capture', '--studio-id', 'studio-test', '--output', capturePath, '--json'],
        output.io,
        fake.dependencies,
      ),
    ).toBe(0);
    expect((await readFile(capturePath)).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    const outsideFake = await dependencies();
    const outsideIo = ioCapture();
    expect(
      await runStudioMcpCli(
        [
          'capture',
          '--studio-id',
          'studio-test',
          '--output',
          join(directory, 'outside.png'),
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
