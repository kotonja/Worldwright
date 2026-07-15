import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const compiledCliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const sourceFixturePath = fileURLToPath(
  new URL('../fixtures/input/cliffwatch-mansion-program.worldspec.json', import.meta.url),
);
const planFixturePath = fileURLToPath(
  new URL('../fixtures/plans/cliffwatch-mansion.architecture-plan.json', import.meta.url),
);
const worldSpecFixturePath = fileURLToPath(
  new URL('../fixtures/worldspec/cliffwatch-mansion-blockout.worldspec.json', import.meta.url),
);
const invalidProfilePath = fileURLToPath(
  new URL('../../worldspec/fixtures/valid/reference-mansion.worldspec.json', import.meta.url),
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
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
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

async function checkSuccessCommands(temporaryDirectory: string): Promise<void> {
  const committedPlan = await readFile(planFixturePath, 'utf8');
  const committedWorldSpec = await readFile(worldSpecFixturePath, 'utf8');

  const humanPlan = runCompiledCli(['plan', sourceFixturePath]);
  assert(humanPlan.status === 0, `Human plan exited ${humanPlan.status}, expected 0`);
  assert(humanPlan.stdout === committedPlan, 'Human plan stdout is not the canonical fixture plan');
  assertNoStackTrace(humanPlan.stderr, 'Human plan warnings');

  const repositoryRelativeSourcePath = relative(process.cwd(), sourceFixturePath);
  const planJson = runCompiledCli(['plan', repositoryRelativeSourcePath, '--json']);
  assert(planJson.status === 0, `JSON plan exited ${planJson.status}, expected 0`);
  const planOutput = parseJsonOutput(planJson, 'Compiled CLI JSON plan');
  assert(planOutput['success'] === true, 'JSON plan did not report success');
  assert(isRecord(planOutput['architecturePlan']), 'JSON plan omitted Architecture Plan');

  const writtenPlanPath = join(temporaryDirectory, 'written.architecture-plan.json');
  const planToFile = runCompiledCli([
    'plan',
    sourceFixturePath,
    '--output',
    writtenPlanPath,
    '--json',
  ]);
  assert(planToFile.status === 0, `Plan output command exited ${planToFile.status}, expected 0`);
  parseJsonOutput(planToFile, 'Compiled CLI plan output-file command');
  assert(
    (await readFile(writtenPlanPath, 'utf8')) === committedPlan,
    'Plan output file differs from the canonical fixture plan',
  );

  const humanEmit = runCompiledCli(['emit', sourceFixturePath, '--plan', planFixturePath]);
  assert(humanEmit.status === 0, `Human emit exited ${humanEmit.status}, expected 0`);
  assert(
    humanEmit.stdout === committedWorldSpec,
    'Human emit stdout is not the canonical derived WorldSpec',
  );
  assertNoStackTrace(humanEmit.stderr, 'Human emit warnings');

  const emitJson = runCompiledCli(['emit', sourceFixturePath, '--plan', planFixturePath, '--json']);
  assert(emitJson.status === 0, `JSON emit exited ${emitJson.status}, expected 0`);
  const emitOutput = parseJsonOutput(emitJson, 'Compiled CLI JSON emit');
  assert(emitOutput['success'] === true, 'JSON emit did not report success');
  assert(isRecord(emitOutput['worldSpec']), 'JSON emit omitted derived WorldSpec');
  assert(isRecord(emitOutput['manifest']), 'JSON emit omitted compiled Manifest');
  assert(
    typeof emitOutput['architecturePlanHash'] === 'string',
    'JSON emit omitted Architecture Plan hash',
  );

  const writtenWorldSpecPath = join(temporaryDirectory, 'written.worldspec.json');
  const emitToFile = runCompiledCli([
    'emit',
    sourceFixturePath,
    '--plan',
    planFixturePath,
    '--output',
    writtenWorldSpecPath,
    '--json',
  ]);
  assert(emitToFile.status === 0, `Emit output command exited ${emitToFile.status}, expected 0`);
  parseJsonOutput(emitToFile, 'Compiled CLI emit output-file command');
  assert(
    (await readFile(writtenWorldSpecPath, 'utf8')) === committedWorldSpec,
    'Emit output file differs from the canonical derived WorldSpec',
  );

  const humanBuild = runCompiledCli(['build', sourceFixturePath]);
  assert(humanBuild.status === 0, `Human build exited ${humanBuild.status}, expected 0`);
  assertNoStackTrace(humanBuild.stderr, 'Human build warnings');
  const humanBuildOutput = JSON.parse(humanBuild.stdout) as unknown;
  assert(isRecord(humanBuildOutput), 'Human build stdout is not a canonical object');
  assert(isRecord(humanBuildOutput['architecturePlan']), 'Human build omitted Architecture Plan');
  assert(isRecord(humanBuildOutput['worldSpec']), 'Human build omitted derived WorldSpec');

  const buildJson = runCompiledCli(['build', sourceFixturePath, '--json']);
  assert(buildJson.status === 0, `JSON build exited ${buildJson.status}, expected 0`);
  const buildOutput = parseJsonOutput(buildJson, 'Compiled CLI JSON build');
  assert(buildOutput['success'] === true, 'JSON build did not report success');
  assert(isRecord(buildOutput['architecturePlan']), 'JSON build omitted Architecture Plan');
  assert(isRecord(buildOutput['worldSpec']), 'JSON build omitted derived WorldSpec');
  assert(isRecord(buildOutput['manifest']), 'JSON build omitted compiled Manifest');

  const buildPlanPath = join(temporaryDirectory, 'build.architecture-plan.json');
  const buildWorldSpecPath = join(temporaryDirectory, 'build.worldspec.json');
  const buildToFiles = runCompiledCli([
    'build',
    sourceFixturePath,
    '--plan-output',
    buildPlanPath,
    '--worldspec-output',
    buildWorldSpecPath,
    '--json',
  ]);
  assert(
    buildToFiles.status === 0,
    `Build output command exited ${buildToFiles.status}, expected 0`,
  );
  parseJsonOutput(buildToFiles, 'Compiled CLI build output-file command');
  const [buildPlan, buildWorldSpec] = await Promise.all([
    readFile(buildPlanPath, 'utf8'),
    readFile(buildWorldSpecPath, 'utf8'),
  ]);
  assert(buildPlan === committedPlan, 'Build plan output differs from canonical fixture plan');
  assert(
    buildWorldSpec === committedWorldSpec,
    'Build WorldSpec output differs from canonical derived fixture',
  );
}

async function checkFailureCommands(temporaryDirectory: string): Promise<void> {
  const invalidSource = runCompiledCli(['plan', invalidProfilePath, '--json']);
  assert(invalidSource.status === 1, `Invalid profile exited ${invalidSource.status}, expected 1`);
  const invalidSourceOutput = parseJsonOutput(invalidSource, 'Compiled CLI invalid profile');
  assert(invalidSourceOutput['success'] === false, 'Invalid profile reported success');
  assert(
    diagnosticsContain(invalidSourceOutput, 'architecture.directive_missing'),
    'Invalid profile omitted architecture.directive_missing',
  );

  const infeasibleSourcePath = join(temporaryDirectory, 'infeasible.worldspec.json');
  const infeasibleInput = JSON.parse(await readFile(sourceFixturePath, 'utf8')) as unknown;
  assert(isRecord(infeasibleInput), 'Source fixture is not a JSON object');
  const infeasibleEntities = infeasibleInput['entities'];
  assert(Array.isArray(infeasibleEntities), 'Source fixture entities are not an array');
  const ballroom = infeasibleEntities.find(
    (entry: unknown) => isRecord(entry) && entry['id'] === 'ballroom',
  );
  assert(isRecord(ballroom), 'Source fixture omits the ballroom');
  const ballroomAttributes = ballroom['attributes'];
  assert(isRecord(ballroomAttributes), 'Ballroom attributes are not an object');
  const ballroomDirective = ballroomAttributes['worldwright.architecture'];
  assert(isRecord(ballroomDirective), 'Ballroom architecture directive is not an object');
  ballroomDirective['minimumArea'] = 100_000;
  ballroomDirective['preferredArea'] = 100_000;
  ballroomDirective['maximumArea'] = 100_000;
  await writeFile(infeasibleSourcePath, `${JSON.stringify(infeasibleInput, null, 2)}\n`, 'utf8');
  const infeasible = runCompiledCli(['plan', infeasibleSourcePath, '--json']);
  assert(infeasible.status === 1, `Infeasible source exited ${infeasible.status}, expected 1`);
  const infeasibleOutput = parseJsonOutput(infeasible, 'Compiled CLI infeasible source');
  assert(
    diagnosticsContain(infeasibleOutput, 'architecture.infeasible') ||
      diagnosticsContain(infeasibleOutput, 'architecture.capacity_exceeded'),
    'Infeasible source omitted an infeasibility diagnostic',
  );

  const malformedPath = join(temporaryDirectory, 'malformed.json');
  await writeFile(malformedPath, '{', 'utf8');
  const malformed = runCompiledCli(['plan', malformedPath, '--json']);
  assert(malformed.status === 1, `Malformed source exited ${malformed.status}, expected 1`);
  const malformedOutput = parseJsonOutput(malformed, 'Compiled CLI malformed source');
  assert(
    diagnosticsContain(malformedOutput, 'json.invalid'),
    'Malformed source omitted json.invalid',
  );

  const invalidPlanPath = join(temporaryDirectory, 'invalid-plan.json');
  await writeFile(invalidPlanPath, '{}\n', 'utf8');
  const invalidPlan = runCompiledCli([
    'emit',
    sourceFixturePath,
    '--plan',
    invalidPlanPath,
    '--json',
  ]);
  assert(invalidPlan.status === 1, `Invalid plan exited ${invalidPlan.status}, expected 1`);
  const invalidPlanOutput = parseJsonOutput(invalidPlan, 'Compiled CLI invalid plan');
  assert(
    diagnosticsContain(invalidPlanOutput, 'architecture.plan_invalid'),
    'Invalid plan omitted architecture.plan_invalid',
  );

  const staleSourcePath = join(temporaryDirectory, 'stale-source.worldspec.json');
  const sourceInput = JSON.parse(await readFile(sourceFixturePath, 'utf8')) as unknown;
  assert(isRecord(sourceInput), 'Source fixture is not a JSON object');
  const project = sourceInput['project'];
  assert(isRecord(project), 'Source fixture project is not a JSON object');
  const seed = project['seed'];
  assert(typeof seed === 'number', 'Source fixture project seed is not numeric');
  project['seed'] = seed + 1;
  await writeFile(staleSourcePath, `${JSON.stringify(sourceInput, null, 2)}\n`, 'utf8');
  const stalePlan = runCompiledCli(['emit', staleSourcePath, '--plan', planFixturePath, '--json']);
  assert(stalePlan.status === 1, `Stale plan exited ${stalePlan.status}, expected 1`);
  const staleOutput = parseJsonOutput(stalePlan, 'Compiled CLI stale plan');
  assert(
    diagnosticsContain(staleOutput, 'architecture.plan_stale'),
    'Stale plan omitted architecture.plan_stale',
  );

  const missing = runCompiledCli(['plan', join(temporaryDirectory, 'missing.json'), '--json']);
  assert(missing.status === 2, `Missing input exited ${missing.status}, expected 2`);
  const missingOutput = parseJsonOutput(missing, 'Compiled CLI missing input');
  const missingError = missingOutput['error'];
  assert(
    isRecord(missingError) && missingError['code'] === 'cli.io',
    'Missing input omitted cli.io',
  );

  const usage = runCompiledCli([]);
  assert(usage.status === 2, `Invalid usage exited ${usage.status}, expected 2`);
  assert(usage.stdout === '', 'Invalid usage produced unexpected standard output');
  assert(usage.stderr.includes('Usage:'), 'Invalid usage omitted usage summary');
  assertNoStackTrace(usage.stderr, 'Compiled CLI invalid usage');

  const collision = runCompiledCli([
    'plan',
    sourceFixturePath,
    '--output',
    sourceFixturePath,
    '--json',
  ]);
  assert(collision.status === 2, `Output collision exited ${collision.status}, expected 2`);
  const collisionOutput = parseJsonOutput(collision, 'Compiled CLI output collision');
  const collisionError = collisionOutput['error'];
  assert(
    isRecord(collisionError) && collisionError['code'] === 'cli.usage',
    'Output collision omitted cli.usage',
  );
}

async function checkCompiledCli(): Promise<void> {
  const compiledCliStats = await stat(compiledCliPath).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Compiled CLI is missing; run pnpm build first: ${message}`);
  });
  assert(compiledCliStats.isFile(), `Compiled CLI is not a file: ${compiledCliPath}`);

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'worldwright-architecture-dist-'));
  try {
    await checkSuccessCommands(temporaryDirectory);
    await checkFailureCommands(temporaryDirectory);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

try {
  await checkCompiledCli();
  process.stdout.write('Compiled architecture planner CLI smoke check passed.\n');
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Compiled architecture planner CLI smoke check failed: ${message}\n`);
  process.exitCode = 1;
}
