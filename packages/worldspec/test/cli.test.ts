import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { renderWorldSpecSchema } from '../scripts/generate-schema.js';
import { runCli } from '../src/cli.js';
import type { CliIo } from '../src/cli.js';
import { normalizeWorldSpec, stringifyWorldSpec } from '../src/index.js';
import { fixturePath, fixtureSource, loadValidFixture } from './helpers.js';

vi.setConfig({ testTimeout: 60_000 });

interface CapturedIo {
  readonly io: CliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

function captureIo(): CapturedIo {
  let stdout = '';
  let stderr = '';

  return {
    io: {
      stdout: (text: string): void => {
        stdout += text;
      },
      stderr: (text: string): void => {
        stderr += text;
      },
    },
    stdout: (): string => stdout,
    stderr: (): string => stderr,
  };
}

describe('worldspec CLI', () => {
  it('validates a document with concise human output', async () => {
    const capture = captureIo();
    const inputPath = fixturePath('valid/reference-mansion.worldspec.json');

    const exitCode = await runCli(['validate', inputPath], capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout()).toBe(`Valid WorldSpec: ${inputPath}\n`);
    expect(capture.stderr()).toBe('');
  });

  it('emits stable machine-readable validation output', async () => {
    const capture = captureIo();

    const exitCode = await runCli(
      ['validate', fixturePath('valid/reference-mansion.worldspec.json'), '--json'],
      capture.io,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(capture.stdout())).toEqual({ valid: true, diagnostics: [] });
    expect(capture.stdout().endsWith('\n')).toBe(true);
    expect(capture.stderr()).toBe('');
  });

  it('returns exit code 1 and diagnostics for an invalid document', async () => {
    const capture = captureIo();

    const exitCode = await runCli(
      ['validate', fixturePath('invalid/duplicate-id.worldspec.json'), '--json'],
      capture.io,
    );

    const output: unknown = JSON.parse(capture.stdout());
    expect(exitCode).toBe(1);
    expect(output).toEqual(
      expect.objectContaining({
        valid: false,
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'id.duplicate' })]),
      }),
    );
    expect(capture.stderr()).toBe('');
  });

  it('reports malformed JSON without a stack trace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'worldspec-cli-'));
    const inputPath = join(directory, 'malformed.json');
    await writeFile(inputPath, '{"schemaVersion":', 'utf8');
    const capture = captureIo();

    try {
      const exitCode = await runCli(['validate', inputPath, '--json'], capture.io);
      const output: unknown = JSON.parse(capture.stdout());

      expect(exitCode).toBe(1);
      expect(output).toEqual(
        expect.objectContaining({
          valid: false,
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'json.invalid' })]),
        }),
      );
      expect(capture.stderr()).not.toContain(' at ');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('normalizes to stdout without overwriting the input', async () => {
    const capture = captureIo();
    const inputPath = fixturePath('valid/reference-mansion.worldspec.json');
    const before = fixtureSource('valid/reference-mansion.worldspec.json');

    const exitCode = await runCli(['normalize', inputPath], capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout()).toBe(stringifyWorldSpec(normalizeWorldSpec(loadValidFixture())));
    expect(await readFile(inputPath, 'utf8')).toBe(before);
    expect(capture.stderr()).toBe('');
  });

  it('normalizes to an explicitly selected output file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'worldspec-cli-'));
    const outputPath = join(directory, 'normalized.worldspec.json');
    const capture = captureIo();

    try {
      const exitCode = await runCli(
        [
          'normalize',
          fixturePath('valid/reference-mansion.worldspec.json'),
          '--output',
          outputPath,
        ],
        capture.io,
      );

      expect(exitCode).toBe(0);
      expect(await readFile(outputPath, 'utf8')).toBe(
        stringifyWorldSpec(normalizeWorldSpec(loadValidFixture())),
      );
      expect(capture.stdout()).toBe(`Normalized WorldSpec written to ${outputPath}\n`);
      expect(capture.stderr()).toBe('');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('prints the generated schema', async () => {
    const capture = captureIo();

    const exitCode = await runCli(['schema'], capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout()).toBe(renderWorldSpecSchema());
    expect(capture.stderr()).toBe('');
  });

  const invalidUsageCases: readonly { readonly args: readonly string[] }[] = [
    { args: [] },
    { args: ['unknown'] },
    { args: ['validate'] },
    { args: ['schema', 'extra'] },
  ];

  it.each(invalidUsageCases)(
    'returns exit code 2 for invalid usage: $args',
    async ({ args }: { readonly args: readonly string[] }) => {
      const capture = captureIo();

      const exitCode = await runCli(args, capture.io);

      expect(exitCode).toBe(2);
      expect(capture.stdout()).toBe('');
      expect(capture.stderr()).toContain('Usage:');
      expect(capture.stderr()).not.toContain(' at ');
    },
  );

  it('returns exit code 2 for I/O failures', async () => {
    const capture = captureIo();

    const exitCode = await runCli(
      ['validate', join(tmpdir(), 'worldspec-file-that-does-not-exist.json')],
      capture.io,
    );

    expect(exitCode).toBe(2);
    expect(capture.stderr()).toContain('Unable to read');
    expect(capture.stderr()).not.toContain(' at ');
  });

  it('runs as a real tsx subprocess and propagates the documented exit code', () => {
    const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const packagePath = fileURLToPath(new URL('..', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        cliPath,
        'validate',
        fixturePath('invalid/dangling-parent.worldspec.json'),
        '--json',
      ],
      { cwd: packagePath, encoding: 'utf8' },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        valid: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'entity.parent_missing' }),
        ]),
      }),
    );
    expect(result.stderr).toBe('');
  });

  it('resolves documented repository-relative paths when launched from the root', () => {
    const repositoryPath = fileURLToPath(new URL('../../../', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'packages/worldspec/src/cli.ts',
        'validate',
        'packages/worldspec/fixtures/valid/reference-mansion.worldspec.json',
        '--json',
      ],
      { cwd: repositoryPath, encoding: 'utf8' },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ valid: true, diagnostics: [] });
    expect(result.stderr).toBe('');
  });

  it('keeps invalid JSON-mode output parseable through the documented pnpm command', () => {
    const repositoryPath = fileURLToPath(new URL('../../../', import.meta.url));
    const cliArguments = [
      'worldspec',
      'validate',
      'packages/worldspec/fixtures/invalid/duplicate-id.worldspec.json',
      '--json',
    ];
    const result =
      process.platform === 'win32'
        ? spawnSync(
            process.env.ComSpec ?? 'cmd.exe',
            ['/d', '/s', '/c', `pnpm ${cliArguments.join(' ')}`],
            { cwd: repositoryPath, encoding: 'utf8' },
          )
        : spawnSync('pnpm', cliArguments, { cwd: repositoryPath, encoding: 'utf8' });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        valid: false,
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'id.duplicate' })]),
      }),
    );
    expect(result.stderr).toBe('');
  });
});
