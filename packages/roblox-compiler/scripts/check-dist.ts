import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const compiledCliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const validFixturePath = fileURLToPath(
  new URL('../fixtures/worldspec/primitive-courtyard.worldspec.json', import.meta.url),
);
const invalidFixturePath = fileURLToPath(
  new URL('../../worldspec/fixtures/valid/reference-mansion.worldspec.json', import.meta.url),
);
const manifestFixturePath = fileURLToPath(
  new URL('../fixtures/manifest/primitive-courtyard.manifest.json', import.meta.url),
);
const modifiedSnapshotFixturePath = fileURLToPath(
  new URL('../fixtures/snapshots/modified.snapshot.json', import.meta.url),
);

interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function assertNoStackTrace(output: string, context: string): void {
  assert(!/(?:^|\r?\n)\s+at\s/u.test(output), `${context} unexpectedly exposed a stack trace`);
}

function parseJsonOutput(result: Readonly<CliResult>, context: string): Record<string, unknown> {
  assert(result.stderr === '', `${context} unexpectedly wrote to standard error`);
  assertNoStackTrace(result.stdout, context);
  let output: unknown;
  try {
    output = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error(`${context} did not emit parseable JSON`);
  }
  assert(isRecord(output), `${context} did not emit a JSON object`);
  return output;
}

function diagnosticsContain(output: Readonly<Record<string, unknown>>, code: string): boolean {
  const diagnostics = output['diagnostics'];
  return (
    Array.isArray(diagnostics) &&
    diagnostics.some((entry: unknown) => isRecord(entry) && entry['code'] === code)
  );
}

function operationCount(output: Readonly<Record<string, unknown>>): number | undefined {
  const changeSet = output['changeSet'];
  if (!isRecord(changeSet)) return undefined;
  const operations = changeSet['operations'];
  return Array.isArray(operations) ? operations.length : undefined;
}

async function createDesiredSnapshot(path: string): Promise<void> {
  const source = await readFile(manifestFixturePath, 'utf8');
  const manifest = JSON.parse(source) as unknown;
  assert(isRecord(manifest), 'Committed manifest fixture is not a JSON object');
  const manifestSource = manifest['source'];
  assert(isRecord(manifestSource), 'Committed manifest fixture source is not a JSON object');
  const projectId = manifestSource['projectId'];
  const target = manifest['target'];
  const rootNodeId = manifest['rootNodeId'];
  const nodes = manifest['nodes'];
  assert(typeof projectId === 'string', 'Committed manifest fixture omits projectId');
  assert(isRecord(target), 'Committed manifest fixture omits target');
  assert(typeof rootNodeId === 'string', 'Committed manifest fixture omits rootNodeId');
  assert(Array.isArray(nodes), 'Committed manifest fixture omits nodes');
  await writeFile(
    path,
    `${JSON.stringify(
      {
        schemaVersion: '0.1.0',
        projectId,
        target,
        rootNodeId,
        nodes,
        unmanagedRoots: [],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

async function checkCompiledCli(): Promise<void> {
  const compiledCliStats = await stat(compiledCliPath).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Compiled CLI is missing; run pnpm build first: ${message}`);
  });
  assert(compiledCliStats.isFile(), `Compiled CLI is not a file: ${compiledCliPath}`);

  const valid = runCompiledCli(['compile', validFixturePath, '--json']);
  assert(valid.status === 0, `Valid compile exited ${valid.status}, expected 0`);
  const validOutput = parseJsonOutput(valid, 'Valid compiled CLI compile');
  assert(validOutput['success'] === true, 'Valid compiled CLI compile did not report success');
  assert(isRecord(validOutput['manifest']), 'Valid compiled CLI compile omitted its manifest');

  const outputDirectory = await mkdtemp(join(tmpdir(), 'worldwright-compiler-output-'));
  try {
    const outputManifestPath = join(outputDirectory, 'compiled.manifest.json');
    const outputCompile = runCompiledCli([
      'compile',
      validFixturePath,
      '--output',
      outputManifestPath,
      '--json',
    ]);
    assert(outputCompile.status === 0, `Output compile exited ${outputCompile.status}, expected 0`);
    const outputCompileJson = parseJsonOutput(outputCompile, 'Compiled CLI output-file compile');
    assert(
      outputCompileJson['success'] === true,
      'Compiled CLI output-file compile did not report success',
    );
    const [writtenManifest, committedManifest] = await Promise.all([
      readFile(outputManifestPath, 'utf8'),
      readFile(manifestFixturePath, 'utf8'),
    ]);
    assert(
      writtenManifest === committedManifest,
      'Compiled CLI output file differs from the committed canonical manifest',
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }

  const invalid = runCompiledCli(['compile', invalidFixturePath, '--json']);
  assert(invalid.status === 1, `Invalid compile exited ${invalid.status}, expected 1`);
  const invalidOutput = parseJsonOutput(invalid, 'Invalid compiled CLI compile');
  assert(invalidOutput['success'] === false, 'Invalid compiled CLI compile reported success');
  assert(
    diagnosticsContain(invalidOutput, 'compiler.directive_missing'),
    'Invalid compiled CLI compile omitted compiler.directive_missing',
  );

  const repair = runCompiledCli([
    'plan',
    manifestFixturePath,
    '--snapshot',
    modifiedSnapshotFixturePath,
    '--json',
  ]);
  assert(repair.status === 0, `Repair plan exited ${repair.status}, expected 0`);
  const repairOutput = parseJsonOutput(repair, 'Compiled CLI repair plan');
  assert(repairOutput['success'] === true, 'Compiled CLI repair plan did not report success');
  assert(
    (operationCount(repairOutput) ?? 0) >= 2,
    'Compiled CLI repair plan omitted expected update/delete operations',
  );

  const emptyCreation = runCompiledCli(['plan', manifestFixturePath, '--json']);
  assert(
    emptyCreation.status === 0,
    `Implicit empty-scene plan exited ${emptyCreation.status}, expected 0`,
  );
  const emptyCreationOutput = parseJsonOutput(
    emptyCreation,
    'Compiled CLI implicit empty-scene plan',
  );
  assert(
    emptyCreationOutput['success'] === true,
    'Compiled CLI implicit empty-scene plan did not report success',
  );
  assert(
    (operationCount(emptyCreationOutput) ?? 0) > 0,
    'Compiled CLI implicit empty-scene plan did not create managed nodes',
  );

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'worldwright-compiler-dist-'));
  try {
    const desiredSnapshotPath = join(temporaryDirectory, 'desired.snapshot.json');
    await createDesiredSnapshot(desiredSnapshotPath);
    const noOp = runCompiledCli([
      'plan',
      manifestFixturePath,
      '--snapshot',
      desiredSnapshotPath,
      '--json',
    ]);
    assert(noOp.status === 0, `No-op plan exited ${noOp.status}, expected 0`);
    const noOpOutput = parseJsonOutput(noOp, 'Compiled CLI no-op plan');
    assert(noOpOutput['success'] === true, 'Compiled CLI no-op plan did not report success');
    assert(operationCount(noOpOutput) === 0, 'Compiled CLI no-op plan contained operations');
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  const usage = runCompiledCli([]);
  assert(usage.status === 2, `Invalid usage exited ${usage.status}, expected 2`);
  assert(usage.stdout === '', 'Invalid usage produced unexpected standard output');
  assert(usage.stderr.includes('Usage:'), 'Invalid usage omitted the usage summary');
  assertNoStackTrace(usage.stderr, 'Invalid compiled CLI usage');
}

try {
  await checkCompiledCli();
  process.stdout.write('Compiled Roblox compiler CLI smoke check passed.\n');
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Compiled Roblox compiler CLI smoke check failed: ${message}\n`);
  process.exitCode = 1;
}
