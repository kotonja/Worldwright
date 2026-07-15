import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const compiledCliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const validFixturePath = fileURLToPath(
  new URL('../fixtures/valid/reference-mansion.worldspec.json', import.meta.url),
);
const invalidFixturePath = fileURLToPath(
  new URL('../fixtures/invalid/duplicate-id.worldspec.json', import.meta.url),
);

interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasDiagnosticCode(value: unknown, expectedCode: string): boolean {
  if (!isRecord(value) || !Array.isArray(value['diagnostics'])) {
    return false;
  }

  return value['diagnostics'].some(
    (diagnostic: unknown) => isRecord(diagnostic) && diagnostic['code'] === expectedCode,
  );
}

function runCompiledCli(args: readonly string[]): CliResult {
  const result = spawnSync(process.execPath, [compiledCliPath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.error !== undefined) {
    throw new Error(`Unable to launch the compiled CLI: ${result.error.message}`);
  }

  assert(result.signal === null, `Compiled CLI terminated from signal ${result.signal}`);
  assert(result.status !== null, 'Compiled CLI did not report an exit status');

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function assertNoStackTrace(output: string, context: string): void {
  assert(!/(?:^|\r?\n)\s+at\s/u.test(output), `${context} unexpectedly exposed a stack trace`);
}

async function checkCompiledCli(): Promise<void> {
  const compiledCliStats = await stat(compiledCliPath).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Compiled CLI is missing; run pnpm build first: ${message}`);
  });
  assert(compiledCliStats.isFile(), `Compiled CLI is not a file: ${compiledCliPath}`);

  const valid = runCompiledCli(['validate', validFixturePath]);
  assert(valid.status === 0, `Valid fixture exited ${valid.status}, expected 0`);
  assert(
    valid.stdout === `Valid WorldSpec: ${validFixturePath}\n`,
    'Valid fixture produced unexpected standard output',
  );
  assert(valid.stderr === '', 'Valid fixture produced unexpected standard error');

  const invalid = runCompiledCli(['validate', invalidFixturePath, '--json']);
  assert(invalid.status === 1, `Invalid fixture exited ${invalid.status}, expected 1`);
  assert(invalid.stderr === '', 'Invalid JSON-mode validation wrote to standard error');
  assertNoStackTrace(invalid.stdout, 'Invalid JSON-mode validation');
  let invalidOutput: unknown;
  try {
    invalidOutput = JSON.parse(invalid.stdout) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON-mode output was not parseable: ${message}`);
  }
  assert(
    isRecord(invalidOutput) && invalidOutput['valid'] === false,
    'Invalid JSON-mode output did not report valid: false',
  );
  assert(
    hasDiagnosticCode(invalidOutput, 'id.duplicate'),
    'Invalid JSON-mode output omitted the id.duplicate diagnostic',
  );

  const usage = runCompiledCli([]);
  assert(usage.status === 2, `Invalid usage exited ${usage.status}, expected 2`);
  assert(usage.stdout === '', 'Invalid usage produced unexpected standard output');
  assert(usage.stderr.includes('Usage:'), 'Invalid usage omitted the usage summary');
  assertNoStackTrace(usage.stderr, 'Invalid usage');
}

try {
  await checkCompiledCli();
  process.stdout.write('Compiled WorldSpec CLI smoke check passed.\n');
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Compiled WorldSpec CLI smoke check failed: ${message}\n`);
  process.exitCode = 1;
}
