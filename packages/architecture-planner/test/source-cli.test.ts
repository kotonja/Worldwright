import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const repositoryDirectory = fileURLToPath(new URL('../../..', import.meta.url));
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
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
const tsxCliPath = createRequire(import.meta.url).resolve('tsx/cli');

interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runSourceCli(args: readonly string[]): CliResult {
  const result = spawnSync(process.execPath, [tsxCliPath, cliPath, ...args], {
    cwd: repositoryDirectory,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) throw new Error(`Source CLI terminated from ${result.signal}.`);
  if (result.status === null) throw new Error('Source CLI did not report an exit status.');
  const output = `${result.stdout}\n${result.stderr}`;
  expect(output).not.toMatch(/(?:^|\r?\n)\s+at\s/u);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function parseObject(result: Readonly<CliResult>): Record<string, unknown> {
  expect(result.stderr).toBe('');
  const value: unknown = JSON.parse(result.stdout);
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  expect(typeof value).toBe('object');
  return value as Record<string, unknown>;
}

function expectCanonicalJson(text: string): void {
  expect(text.endsWith('\n')).toBe(true);
  expect(text.endsWith('\n\n')).toBe(false);
  expect(text).not.toContain('\r');
  expect(() => JSON.parse(text) as unknown).not.toThrow();
}

function expectDiagnostic(output: Readonly<Record<string, unknown>>, code: string): void {
  expect(output['success']).toBe(false);
  expect(output['diagnostics']).toEqual(
    expect.arrayContaining([expect.objectContaining({ code })]),
  );
}

let temporaryDirectory = '';

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'worldwright-architecture-source-cli-'));
});

afterAll(async () => {
  await rm(temporaryDirectory, { force: true, recursive: true });
});

describe('source TypeScript architecture-planner CLI', () => {
  it('plans canonically to stdout, JSON, and an output file from a repository-relative path', async () => {
    const expectedPlan = await readFile(planFixturePath, 'utf8');
    const relativeSource = relative(repositoryDirectory, sourceFixturePath);

    const human = runSourceCli(['plan', relativeSource]);
    expect(human.status).toBe(0);
    expect(human.stdout).toBe(expectedPlan);

    const outputPath = join(temporaryDirectory, 'planned.architecture-plan.json');
    const toFile = runSourceCli(['plan', relativeSource, '--output', outputPath, '--json']);
    expect(toFile.status).toBe(0);
    expectCanonicalJson(toFile.stdout);
    const output = parseObject(toFile);
    expect(output).toMatchObject({ success: true });
    expect(output['architecturePlan']).toEqual(JSON.parse(expectedPlan));
    expect(toFile.stdout.toLowerCase()).not.toContain(repositoryDirectory.toLowerCase());
    expect(await readFile(outputPath, 'utf8')).toBe(expectedPlan);
  }, 60_000);

  it('emits canonically to stdout, JSON, and an output file', async () => {
    const expectedWorldSpec = await readFile(worldSpecFixturePath, 'utf8');

    const human = runSourceCli(['emit', sourceFixturePath, '--plan', planFixturePath]);
    expect(human.status).toBe(0);
    expect(human.stdout).toBe(expectedWorldSpec);

    const outputPath = join(temporaryDirectory, 'emitted.worldspec.json');
    const toFile = runSourceCli([
      'emit',
      sourceFixturePath,
      '--plan',
      planFixturePath,
      '--output',
      outputPath,
      '--json',
    ]);
    expect(toFile.status).toBe(0);
    expectCanonicalJson(toFile.stdout);
    expect(parseObject(toFile)).toMatchObject({
      architecturePlanHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      manifest: expect.any(Object),
      success: true,
      worldSpec: JSON.parse(expectedWorldSpec) as unknown,
    });
    expect(await readFile(outputPath, 'utf8')).toBe(expectedWorldSpec);
  }, 60_000);

  it('builds deterministically and writes both canonical artifacts', async () => {
    const [expectedPlan, expectedWorldSpec] = await Promise.all([
      readFile(planFixturePath, 'utf8'),
      readFile(worldSpecFixturePath, 'utf8'),
    ]);
    const first = runSourceCli(['build', sourceFixturePath]);
    expect(first.status).toBe(0);
    expectCanonicalJson(first.stdout);
    expect(JSON.parse(first.stdout)).toMatchObject({
      architecturePlan: JSON.parse(expectedPlan) as unknown,
      worldSpec: JSON.parse(expectedWorldSpec) as unknown,
    });

    const planOutput = join(temporaryDirectory, 'built.architecture-plan.json');
    const worldSpecOutput = join(temporaryDirectory, 'built.worldspec.json');
    const toFiles = runSourceCli([
      'build',
      sourceFixturePath,
      '--plan-output',
      planOutput,
      '--worldspec-output',
      worldSpecOutput,
      '--json',
    ]);
    expect(toFiles.status).toBe(0);
    const buildOutput = parseObject(toFiles);
    expect(buildOutput).toMatchObject({
      architecturePlan: JSON.parse(expectedPlan) as unknown,
      success: true,
      worldSpec: JSON.parse(expectedWorldSpec) as unknown,
    });
    expect(buildOutput['diagnostics']).toEqual([
      expect.objectContaining({ code: 'architecture.preference_unsatisfied' }),
    ]);
    expect(await readFile(planOutput, 'utf8')).toBe(expectedPlan);
    expect(await readFile(worldSpecOutput, 'utf8')).toBe(expectedWorldSpec);
  }, 60_000);

  it('uses exit 1 and stable diagnostics for invalid, infeasible, and malformed sources', async () => {
    const invalidProfile = runSourceCli(['plan', invalidProfilePath, '--json']);
    expect(invalidProfile.status).toBe(1);
    expectDiagnostic(parseObject(invalidProfile), 'architecture.directive_missing');

    const source = JSON.parse(await readFile(sourceFixturePath, 'utf8')) as {
      entities: Array<{ id: string; attributes: Record<string, Record<string, unknown>> }>;
    };
    const ballroom = source.entities.find((entity) => entity.id === 'ballroom');
    if (ballroom === undefined) throw new Error('Mansion source omits the ballroom.');
    const directive = ballroom.attributes['worldwright.architecture'];
    if (directive === undefined) throw new Error('Ballroom omits its architecture directive.');
    directive['minimumArea'] = 100_000;
    directive['preferredArea'] = 100_000;
    directive['maximumArea'] = 100_000;
    const infeasiblePath = join(temporaryDirectory, 'infeasible.worldspec.json');
    await writeFile(infeasiblePath, `${JSON.stringify(source, null, 2)}\n`, 'utf8');
    const infeasible = runSourceCli(['plan', infeasiblePath, '--json']);
    expect(infeasible.status).toBe(1);
    const infeasibleOutput = parseObject(infeasible);
    const diagnostics = infeasibleOutput['diagnostics'];
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/^architecture\.(?:capacity_exceeded|infeasible)$/u),
        }),
      ]),
    );

    const malformedPath = join(temporaryDirectory, 'malformed.json');
    await writeFile(malformedPath, '{', 'utf8');
    const malformed = runSourceCli(['plan', malformedPath, '--json']);
    expect(malformed.status).toBe(1);
    expectDiagnostic(parseObject(malformed), 'json.invalid');
  }, 60_000);

  it('uses exit 1 for invalid and stale plans', async () => {
    const invalidPlanPath = join(temporaryDirectory, 'invalid-plan.json');
    await writeFile(invalidPlanPath, '{}\n', 'utf8');
    const invalid = runSourceCli(['emit', sourceFixturePath, '--plan', invalidPlanPath, '--json']);
    expect(invalid.status).toBe(1);
    expectDiagnostic(parseObject(invalid), 'architecture.plan_invalid');

    const source = JSON.parse(await readFile(sourceFixturePath, 'utf8')) as {
      project: { seed: number };
    };
    source.project.seed += 1;
    const staleSourcePath = join(temporaryDirectory, 'stale.worldspec.json');
    await writeFile(staleSourcePath, `${JSON.stringify(source, null, 2)}\n`, 'utf8');
    const stale = runSourceCli(['emit', staleSourcePath, '--plan', planFixturePath, '--json']);
    expect(stale.status).toBe(1);
    expectDiagnostic(parseObject(stale), 'architecture.plan_stale');
  }, 60_000);

  it('uses exit 2 for usage and I/O failures without overwriting inputs', async () => {
    const usage = runSourceCli([]);
    expect(usage).toMatchObject({ status: 2, stdout: '' });
    expect(usage.stderr).toContain('Usage:');

    const missingPath = relative(repositoryDirectory, join(temporaryDirectory, 'missing.json'));
    const missing = runSourceCli(['plan', missingPath, '--json']);
    expect(missing.status).toBe(2);
    expect(parseObject(missing)).toMatchObject({
      error: { code: 'cli.io', message: expect.stringContaining(missingPath) },
      success: false,
    });

    const sourceBefore = await readFile(sourceFixturePath, 'utf8');
    const collision = runSourceCli([
      'plan',
      sourceFixturePath,
      '--output',
      sourceFixturePath,
      '--json',
    ]);
    expect(collision.status).toBe(2);
    expect(parseObject(collision)).toMatchObject({
      error: { code: 'cli.usage' },
      success: false,
    });
    expect(await readFile(sourceFixturePath, 'utf8')).toBe(sourceBefore);
  }, 60_000);

  it('executes the intended package-local source entrypoint through tsx', () => {
    expect(packageDirectory).toBe(fileURLToPath(new URL('..', import.meta.url)));
    const help = runSourceCli(['--help']);
    expect(help).toMatchObject({ status: 0, stderr: '' });
    expect(help.stdout).toContain('architecture-planner plan');
  }, 60_000);
});
