import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const tsxCli = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url));
const liveScript = fileURLToPath(new URL('../scripts/live-playtest-smoke.ts', import.meta.url));

function run(args: readonly string[]): Promise<
  Readonly<{
    status: number | null;
    stdout: string;
    stderr: string;
  }>
> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, liveScript, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

describe('Milestone 5 live playtest CLI review boundary', () => {
  it('prints deterministic identity-free reviewed sequence and all three required hashes', async () => {
    const result = await run(['--', '--review']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      sequence: { action: 'worldwright-live-playtest-smoke' },
    });
    for (const key of ['sequenceSha256', 'playtestPlanSha256', 'sandboxChangeSetSha256']) {
      expect(parsed[key]).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(result.stdout).not.toContain('studioId');
    expect(result.stdout).not.toContain('sandboxLeaseId');
  }, 120_000);

  it('rejects incomplete usage with exit 2 and never echoes private arguments', async () => {
    const privateStudio = 'private-studio-id';
    const result = await run(['--studio-id', privateStudio]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage:');
    expect(result.stderr).not.toContain(privateStudio);
  }, 120_000);

  it('rejects wrong complete confirmations before connection with sanitized output', async () => {
    const privateStudio = 'private-studio-id';
    const privateLease = 'a'.repeat(64);
    const result = await run([
      '--studio-id',
      privateStudio,
      '--sandbox-lease-id',
      privateLease,
      '--confirm',
      'b'.repeat(64),
      '--confirm-plan',
      'c'.repeat(64),
      '--confirm-change-set',
      'd'.repeat(64),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      'The confirmed bounded live playtest did not complete successfully.\n',
    );
    expect(result.stderr).not.toContain(privateStudio);
    expect(result.stderr).not.toContain(privateLease);
  }, 120_000);
});
