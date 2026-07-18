import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
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
const passCriticPath = fileURLToPath(
  new URL('../fixtures/critic-reports/cliffwatch-pass.critic.json', import.meta.url),
);

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function run(args: readonly string[]): {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  assert(result.status !== null, 'Compiled CLI did not return an exit status.');
  assert(result.signal === null, `Compiled CLI terminated from ${result.signal}.`);
  assert(
    !/(?:^|\n)\s+at\s/u.test(`${result.stdout}\n${result.stderr}`),
    'Compiled CLI exposed a stack trace.',
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

try {
  assert((await stat(cliPath)).isFile(), 'Compiled CLI is missing; run pnpm build first.');
  const planned = run(['plan', architecturePlanPath, '--manifest', manifestPath]);
  assert(planned.status === 0, `Compiled plan exited ${planned.status}.`);
  assert(
    planned.stdout === (await readFile(playtestPlanPath, 'utf8')),
    'Compiled plan differs from its fixture.',
  );
  const pass = run(['evaluate', playtestPlanPath, '--run', passRunPath]);
  assert(pass.status === 0, `Compiled passing evaluation exited ${pass.status}.`);
  assert(
    pass.stdout === (await readFile(passCriticPath, 'utf8')),
    'Compiled evaluation differs from its fixture.',
  );
  const fail = run(['evaluate', playtestPlanPath, '--run', failedRunPath, '--json']);
  assert(fail.status === 1, `Compiled failing evaluation exited ${fail.status}.`);
  const failedOutput = JSON.parse(fail.stdout) as Record<string, unknown>;
  assert(
    failedOutput['success'] === true,
    'A valid failing Critic run must still report CLI success.',
  );
  const usage = run([]);
  assert(usage.status === 2 && usage.stderr.includes('Usage:'), 'Compiled usage contract failed.');
  const missing = run(['plan', 'missing.json', '--manifest', manifestPath, '--json']);
  assert(missing.status === 2, 'Compiled missing-file contract failed.');
  process.stdout.write('Compiled Playtest Critic CLI smoke check passed.\n');
} catch (error: unknown) {
  process.stderr.write(
    `Compiled Playtest Critic CLI smoke check failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
