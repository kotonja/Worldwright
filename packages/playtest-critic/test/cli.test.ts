import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runPlaytestCriticCli } from '../src/cli.js';

const architecturePlanPath = fileURLToPath(
  new URL(
    '../../architecture-planner/fixtures/plans/cliffwatch-mansion.architecture-plan.json',
    import.meta.url,
  ),
);
const manifestPath = fileURLToPath(
  new URL(
    '../../architecture-planner/fixtures/manifest/cliffwatch-mansion-blockout.manifest.json',
    import.meta.url,
  ),
);
const playtestPlanPath = fileURLToPath(
  new URL('../fixtures/plans/cliffwatch.playtest-plan.json', import.meta.url),
);
const passRunPath = fileURLToPath(
  new URL('../fixtures/run-reports/cliffwatch-pass.playtest-run.json', import.meta.url),
);
const failedRunPath = fileURLToPath(
  new URL('../fixtures/run-reports/blocked-door.playtest-run.json', import.meta.url),
);

function capture(): {
  readonly io: {
    readonly stdout: (value: string) => void;
    readonly stderr: (value: string) => void;
  };
  readonly out: () => string;
  readonly err: () => string;
} {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
    },
    out: () => stdout,
    err: () => stderr,
  };
}

describe('Playtest Critic CLI', () => {
  it('plans and evaluates with documented exit codes', async () => {
    const planned = capture();
    expect(
      await runPlaytestCriticCli(
        ['plan', architecturePlanPath, '--manifest', manifestPath, '--json'],
        planned.io,
      ),
    ).toBe(0);
    expect(JSON.parse(planned.out())).toMatchObject({ success: true });
    expect(planned.err()).toBe('');
    const pass = capture();
    expect(
      await runPlaytestCriticCli(
        ['evaluate', playtestPlanPath, '--run', passRunPath, '--json'],
        pass.io,
      ),
    ).toBe(0);
    expect(JSON.parse(pass.out())).toMatchObject({
      success: true,
      criticReport: { status: 'pass' },
    });
    const fail = capture();
    expect(
      await runPlaytestCriticCli(
        ['evaluate', playtestPlanPath, '--run', failedRunPath, '--json'],
        fail.io,
      ),
    ).toBe(1);
    expect(JSON.parse(fail.out())).toMatchObject({
      success: true,
      criticReport: { status: 'fail' },
    });
  });

  it('uses exit 2 for usage and I/O without stack traces', async () => {
    const usage = capture();
    expect(await runPlaytestCriticCli([], usage.io)).toBe(2);
    expect(usage.err()).toContain('Usage:');
    const missing = capture();
    expect(
      await runPlaytestCriticCli(
        ['plan', 'missing.json', '--manifest', manifestPath, '--json'],
        missing.io,
      ),
    ).toBe(2);
    expect(JSON.parse(missing.out())).toMatchObject({ success: false, error: { code: 'cli.io' } });
    expect(`${missing.out()}${missing.err()}`).not.toMatch(/\n\s+at\s/u);
  });
});
