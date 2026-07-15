import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { compileWorldSpecToRobloxManifest } from '../src/compile.js';
import {
  stringifyRobloxChangeSet,
  stringifyRobloxManifest,
  stringifyRobloxSnapshot,
} from '../src/normalize.js';
import { planRobloxChangeSet } from '../src/reconcile.js';
import type { CompileSuccess, PlanSuccess, RobloxManifest, RobloxSnapshot } from '../src/types.js';
import {
  emptySnapshotForManifest,
  loadPrimitiveWorldSpec,
  primitiveFixturePath,
  snapshotFromManifest,
} from './helpers.js';

const CLI_PATH = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const PACKAGE_PATH = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY_PATH = fileURLToPath(new URL('../../../', import.meta.url));

vi.setConfig({ testTimeout: 60_000 });

function runSourceCli(
  args: readonly string[],
  cwd: string = PACKAGE_PATH,
): SpawnSyncReturns<string> {
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
  });
  expect(result.error).toBeUndefined();
  return result;
}

function expectNoStackTrace(result: Readonly<SpawnSyncReturns<string>>): void {
  expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/\n\s+at\s/u);
  expect(`${result.stdout}\n${result.stderr}`).not.toContain('node:internal');
}

function requireCompiledFixture(): CompileSuccess {
  const result = compileWorldSpecToRobloxManifest(loadPrimitiveWorldSpec());
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(`Fixture compilation failed: ${JSON.stringify(result)}`);
  return result;
}

function requirePlan(
  snapshot: Readonly<RobloxSnapshot>,
  manifest: Readonly<RobloxManifest>,
): PlanSuccess {
  const result = planRobloxChangeSet(snapshot, manifest);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(`Fixture planning failed: ${JSON.stringify(result)}`);
  return result;
}

describe('Roblox compiler source CLI', () => {
  it('compiles valid WorldSpec to canonical human output and a stable JSON envelope', () => {
    const expected = requireCompiledFixture();

    const human = runSourceCli(['compile', primitiveFixturePath()]);
    const machine = runSourceCli(['compile', primitiveFixturePath(), '--json']);

    expect(human.status).toBe(0);
    expect(human.stdout).toBe(stringifyRobloxManifest(expected.manifest));
    expect(human.stderr.match(/compiler\.budget_not_evaluated/gu)).toHaveLength(2);
    expectNoStackTrace(human);

    expect(machine.status).toBe(0);
    expect(JSON.parse(machine.stdout)).toEqual({
      diagnostics: expected.diagnostics,
      manifest: expected.manifest,
      success: true,
    });
    expect(machine.stdout.endsWith('\n')).toBe(true);
    expect(machine.stderr).toBe('');
  });

  it('writes a compiled manifest only to an explicit output path and preserves its input', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'worldwright-compile-cli-'));
    const outputPath = join(directory, 'compiled.roblox-manifest.json');
    const inputPath = primitiveFixturePath();
    const inputBefore = await readFile(inputPath, 'utf8');
    const expected = requireCompiledFixture();

    try {
      const result = runSourceCli(['compile', inputPath, '--output', outputPath]);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`Wrote Roblox manifest: ${outputPath}\n`);
      expect(result.stderr.match(/compiler\.budget_not_evaluated/gu)).toHaveLength(2);
      expect(await readFile(outputPath, 'utf8')).toBe(stringifyRobloxManifest(expected.manifest));
      expect(await readFile(inputPath, 'utf8')).toBe(inputBefore);
      expectNoStackTrace(result);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns exit 1 with parseable diagnostics for malformed and invalid WorldSpec input', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'worldwright-invalid-compile-cli-'));
    const malformedPath = join(directory, 'malformed.json');
    const invalidPath = join(directory, 'invalid.worldspec.json');
    const invalid = loadPrimitiveWorldSpec();
    const entity = invalid.entities[1];
    if (entity === undefined) throw new Error('Fixture entity is missing.');
    delete (entity.attributes as Record<string, unknown>)['worldwright.roblox'];
    await writeFile(malformedPath, '{"schemaVersion":', 'utf8');
    await writeFile(invalidPath, JSON.stringify(invalid), 'utf8');

    try {
      const malformed = runSourceCli(['compile', malformedPath, '--json']);
      const domainInvalid = runSourceCli(['compile', invalidPath, '--json']);

      expect(malformed.status).toBe(1);
      expect(JSON.parse(malformed.stdout)).toEqual({
        diagnostics: [expect.objectContaining({ code: 'json.invalid' })],
        success: false,
      });
      expect(malformed.stderr).toBe('');
      expectNoStackTrace(malformed);

      expect(domainInvalid.status).toBe(1);
      expect(JSON.parse(domainInvalid.stdout)).toEqual(
        expect.objectContaining({
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: 'compiler.directive_missing' }),
          ]),
          success: false,
        }),
      );
      expect(domainInvalid.stderr).toBe('');
      expectNoStackTrace(domainInvalid);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('plans the same all-create transition for implicit and explicit empty snapshots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'worldwright-empty-plan-cli-'));
    const compiled = requireCompiledFixture();
    const manifestPath = join(directory, 'manifest.json');
    const snapshotPath = join(directory, 'empty.snapshot.json');
    const empty = emptySnapshotForManifest(compiled.manifest);
    const expected = requirePlan(empty, compiled.manifest);
    await writeFile(manifestPath, stringifyRobloxManifest(compiled.manifest), 'utf8');
    await writeFile(snapshotPath, stringifyRobloxSnapshot(empty), 'utf8');

    try {
      const implicit = runSourceCli(['plan', manifestPath]);
      const explicit = runSourceCli(['plan', manifestPath, '--snapshot', snapshotPath, '--json']);

      expect(implicit.status).toBe(0);
      expect(implicit.stdout).toBe(stringifyRobloxChangeSet(expected.changeSet));
      expect(implicit.stderr).toBe('');
      expect(expected.changeSet.summary).toEqual({
        creates: compiled.manifest.nodes.length,
        updates: 0,
        deletes: 0,
        total: compiled.manifest.nodes.length,
      });

      expect(explicit.status).toBe(0);
      expect(JSON.parse(explicit.stdout)).toEqual({
        changeSet: expected.changeSet,
        diagnostics: [],
        success: true,
      });
      expect(explicit.stderr).toBe('');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('plans a modified snapshot to an output file and reports an exact snapshot as a no-op', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'worldwright-update-plan-cli-'));
    const compiled = requireCompiledFixture();
    const manifestPath = join(directory, 'manifest.json');
    const modifiedPath = join(directory, 'modified.snapshot.json');
    const exactPath = join(directory, 'exact.snapshot.json');
    const outputPath = join(directory, 'update.change-set.json');
    const modified = snapshotFromManifest(compiled.manifest);
    const changedNode = modified.nodes.find((node) => node.id === 'plaza-floor');
    if (changedNode === undefined) throw new Error('Missing fixture node: plaza-floor');
    changedNode.name = 'Observed legacy floor name';
    const exact = snapshotFromManifest(compiled.manifest);
    const updatePlan = requirePlan(modified, compiled.manifest);
    await writeFile(manifestPath, stringifyRobloxManifest(compiled.manifest), 'utf8');
    await writeFile(modifiedPath, stringifyRobloxSnapshot(modified), 'utf8');
    await writeFile(exactPath, stringifyRobloxSnapshot(exact), 'utf8');

    try {
      const update = runSourceCli([
        'plan',
        manifestPath,
        '--snapshot',
        modifiedPath,
        '--output',
        outputPath,
      ]);
      const noop = runSourceCli(['plan', manifestPath, '--snapshot', exactPath, '--json']);

      expect(update.status).toBe(0);
      expect(update.stdout).toBe(`Wrote Roblox change set: ${outputPath}\n`);
      expect(update.stderr).toBe('');
      expect(updatePlan.changeSet.summary).toEqual({
        creates: 0,
        updates: 1,
        deletes: 0,
        total: 1,
      });
      expect(await readFile(outputPath, 'utf8')).toBe(
        stringifyRobloxChangeSet(updatePlan.changeSet),
      );

      expect(noop.status).toBe(0);
      expect(JSON.parse(noop.stdout)).toEqual(
        expect.objectContaining({
          success: true,
          diagnostics: [],
          changeSet: expect.objectContaining({
            operations: [],
            summary: { creates: 0, updates: 0, deletes: 0, total: 0 },
          }),
        }),
      );
      expect(noop.stderr).toBe('');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns exit 1 for invalid manifest and malformed snapshot plan data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'worldwright-invalid-plan-cli-'));
    const manifestPath = join(directory, 'manifest.json');
    const invalidManifestPath = join(directory, 'invalid-manifest.json');
    const malformedSnapshotPath = join(directory, 'malformed-snapshot.json');
    const compiled = requireCompiledFixture();
    await writeFile(manifestPath, stringifyRobloxManifest(compiled.manifest), 'utf8');
    await writeFile(invalidManifestPath, '{}\n', 'utf8');
    await writeFile(malformedSnapshotPath, '{"schemaVersion":', 'utf8');

    try {
      const invalidManifest = runSourceCli(['plan', invalidManifestPath, '--json']);
      const malformedSnapshot = runSourceCli([
        'plan',
        manifestPath,
        '--snapshot',
        malformedSnapshotPath,
        '--json',
      ]);

      expect(invalidManifest.status).toBe(1);
      expect(JSON.parse(invalidManifest.stdout)).toEqual(
        expect.objectContaining({
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: 'plan.manifest_invalid' }),
          ]),
          success: false,
        }),
      );
      expect(invalidManifest.stderr).toBe('');
      expectNoStackTrace(invalidManifest);

      expect(malformedSnapshot.status).toBe(1);
      expect(JSON.parse(malformedSnapshot.stdout)).toEqual({
        diagnostics: [expect.objectContaining({ code: 'json.invalid' })],
        success: false,
      });
      expect(malformedSnapshot.stderr).toBe('');
      expectNoStackTrace(malformedSnapshot);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns exit 2 for usage and read/write I/O errors without exposing stacks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'worldwright-cli-errors-'));
    const missingInput = join(directory, 'missing.worldspec.json');
    const unwritableOutput = join(directory, 'missing-parent', 'manifest.json');

    try {
      const usage = runSourceCli([]);
      const readFailure = runSourceCli(['compile', missingInput, '--json']);
      const writeFailure = runSourceCli([
        'compile',
        primitiveFixturePath(),
        '--output',
        unwritableOutput,
        '--json',
      ]);

      expect(usage.status).toBe(2);
      expect(usage.stdout).toBe('');
      expect(usage.stderr).toContain('Usage:');
      expectNoStackTrace(usage);

      expect(readFailure.status).toBe(2);
      expect(JSON.parse(readFailure.stdout)).toEqual({
        error: expect.objectContaining({ code: 'cli.io' }),
        success: false,
      });
      expect(readFailure.stderr).toBe('');
      expectNoStackTrace(readFailure);

      expect(writeFailure.status).toBe(2);
      expect(JSON.parse(writeFailure.stdout)).toEqual({
        error: expect.objectContaining({ code: 'cli.io' }),
        success: false,
      });
      expect(writeFailure.stderr).toBe('');
      expectNoStackTrace(writeFailure);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('treats unsafe output aliases and unknown options as usage errors', () => {
    const inputPath = primitiveFixturePath();

    const aliasedOutput = runSourceCli(['compile', inputPath, '--output', inputPath, '--json']);
    const unknownOption = runSourceCli(['compile', inputPath, '--wat', '--json']);

    expect(aliasedOutput.status).toBe(2);
    expect(JSON.parse(aliasedOutput.stdout)).toEqual({
      error: expect.objectContaining({ code: 'cli.usage' }),
      success: false,
    });
    expect(aliasedOutput.stderr).toBe('');
    expectNoStackTrace(aliasedOutput);

    expect(unknownOption.status).toBe(2);
    expect(JSON.parse(unknownOption.stdout)).toEqual({
      error: expect.objectContaining({ code: 'cli.usage' }),
      success: false,
    });
    expect(unknownOption.stderr).toBe('');
    expectNoStackTrace(unknownOption);
  });

  it('resolves documented repository-relative paths when launched from the repository root', () => {
    const result = runSourceCli(
      [
        'compile',
        'packages/roblox-compiler/fixtures/worldspec/primitive-courtyard.worldspec.json',
        '--json',
      ],
      REPOSITORY_PATH,
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({ success: true, manifest: expect.any(Object) }),
    );
    expect(result.stderr).toBe('');
    expectNoStackTrace(result);
  });
});
