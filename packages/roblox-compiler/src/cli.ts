#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROBLOX_SNAPSHOT_VERSION } from './contract-schema.js';
import { validateRobloxManifest } from './contract-validation.js';
import { compileWorldSpecToRobloxManifest } from './compile.js';
import { diagnostic, formatRobloxDiagnostics } from './diagnostics.js';
import type { RobloxDiagnostic } from './diagnostics.js';
import { stringifyCanonicalJson, type JsonValue } from './json.js';
import {
  normalizeRobloxSnapshot,
  stringifyRobloxChangeSet,
  stringifyRobloxManifest,
} from './normalize.js';
import { planRobloxChangeSet } from './reconcile.js';

const USAGE = `Usage:
  roblox-compiler compile <worldspec-file> [--output <manifest-file>] [--json]
  roblox-compiler plan <manifest-file> [--snapshot <snapshot-file>] [--output <change-set-file>] [--json]
`;

interface CompileCommand {
  readonly kind: 'compile';
  readonly inputPath: string;
  readonly outputPath?: string;
  readonly json: boolean;
}

interface PlanCommand {
  readonly kind: 'plan';
  readonly inputPath: string;
  readonly snapshotPath?: string;
  readonly outputPath?: string;
  readonly json: boolean;
}

interface HelpCommand {
  readonly kind: 'help';
}

type CliCommand = CompileCommand | PlanCommand | HelpCommand;

type ParseResult =
  | { readonly success: true; readonly command: CliCommand }
  | { readonly success: false; readonly message: string };

type ReadJsonResult =
  | { readonly success: true; readonly value: unknown }
  | { readonly success: false; readonly kind: 'io' | 'json'; readonly message: string };

function samePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function parseCommand(args: readonly string[]): ParseResult {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    return { success: true, command: { kind: 'help' } };
  }
  const commandName = args[0];
  if (commandName !== 'compile' && commandName !== 'plan') {
    return { success: false, message: 'Expected the compile or plan command.' };
  }

  let inputPath: string | undefined;
  let outputPath: string | undefined;
  let snapshotPath: string | undefined;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--json') {
      if (json) return { success: false, message: 'The --json flag may be supplied only once.' };
      json = true;
      continue;
    }
    if (argument === '--output' || argument === '--snapshot') {
      if (argument === '--snapshot' && commandName !== 'plan') {
        return { success: false, message: 'The --snapshot option is available only for plan.' };
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { success: false, message: `${argument} requires a file path.` };
      }
      index += 1;
      if (argument === '--output') {
        if (outputPath !== undefined) {
          return { success: false, message: 'The --output option may be supplied only once.' };
        }
        outputPath = value;
      } else {
        if (snapshotPath !== undefined) {
          return { success: false, message: 'The --snapshot option may be supplied only once.' };
        }
        snapshotPath = value;
      }
      continue;
    }
    if (argument.startsWith('-')) {
      return { success: false, message: `Unknown option: ${argument}` };
    }
    if (inputPath !== undefined) {
      return { success: false, message: 'Exactly one input file is required.' };
    }
    inputPath = argument;
  }

  if (inputPath === undefined) {
    return { success: false, message: 'An input file is required.' };
  }
  if (outputPath !== undefined && samePath(inputPath, outputPath)) {
    return { success: false, message: 'The output file must differ from the input file.' };
  }
  if (
    outputPath !== undefined &&
    snapshotPath !== undefined &&
    samePath(snapshotPath, outputPath)
  ) {
    return { success: false, message: 'The output file must differ from the snapshot file.' };
  }

  return commandName === 'compile'
    ? {
        success: true,
        command: {
          kind: 'compile',
          inputPath,
          ...(outputPath === undefined ? {} : { outputPath }),
          json,
        },
      }
    : {
        success: true,
        command: {
          kind: 'plan',
          inputPath,
          ...(snapshotPath === undefined ? {} : { snapshotPath }),
          ...(outputPath === undefined ? {} : { outputPath }),
          json,
        },
      };
}

async function readJsonFile(path: string, label: string): Promise<ReadJsonResult> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch {
    return {
      success: false,
      kind: 'io',
      message: `Unable to read the ${label} file: ${path}`,
    };
  }

  try {
    return { success: true, value: JSON.parse(source) as unknown };
  } catch {
    return {
      success: false,
      kind: 'json',
      message: `The ${label} file is not valid JSON.`,
    };
  }
}

function writeCanonicalJson(value: unknown): void {
  process.stdout.write(stringifyCanonicalJson(value as JsonValue));
}

function reportUsageFailure(message: string, json: boolean): number {
  if (json) {
    writeCanonicalJson({
      error: { code: 'cli.usage', message },
      success: false,
    });
  } else {
    process.stderr.write(`${message}\n${USAGE}`);
  }
  return 2;
}

function reportIoFailure(message: string, json: boolean): number {
  if (json) {
    writeCanonicalJson({
      error: { code: 'cli.io', message },
      success: false,
    });
  } else {
    process.stderr.write(`${message}\n`);
  }
  return 2;
}

function reportInvalidJson(message: string, json: boolean): number {
  const diagnostics: readonly RobloxDiagnostic[] = [diagnostic('json.invalid', '', message)];
  if (json) {
    writeCanonicalJson({ diagnostics, success: false });
  } else {
    process.stderr.write(`${formatRobloxDiagnostics(diagnostics)}\n`);
  }
  return 1;
}

function reportDomainFailure(diagnostics: readonly RobloxDiagnostic[], json: boolean): number {
  if (json) {
    writeCanonicalJson({ diagnostics, success: false });
  } else {
    process.stderr.write(`${formatRobloxDiagnostics(diagnostics)}\n`);
  }
  return 1;
}

async function writeArtifact(
  path: string,
  content: string,
  json: boolean,
): Promise<number | undefined> {
  try {
    await writeFile(path, content, 'utf8');
    return undefined;
  } catch {
    return reportIoFailure(`Unable to write the output file: ${path}`, json);
  }
}

function reportHumanWarnings(diagnostics: readonly RobloxDiagnostic[]): void {
  if (diagnostics.length > 0) {
    process.stderr.write(`${formatRobloxDiagnostics(diagnostics)}\n`);
  }
}

async function runCompile(command: Readonly<CompileCommand>): Promise<number> {
  const input = await readJsonFile(command.inputPath, 'WorldSpec input');
  if (!input.success) {
    return input.kind === 'io'
      ? reportIoFailure(input.message, command.json)
      : reportInvalidJson(input.message, command.json);
  }

  const result = compileWorldSpecToRobloxManifest(input.value);
  if (!result.success) return reportDomainFailure(result.diagnostics, command.json);
  const content = stringifyRobloxManifest(result.manifest);
  if (command.outputPath !== undefined) {
    const exitCode = await writeArtifact(command.outputPath, content, command.json);
    if (exitCode !== undefined) return exitCode;
  }

  if (command.json) {
    writeCanonicalJson({
      diagnostics: result.diagnostics,
      manifest: result.manifest,
      success: true,
    });
  } else {
    reportHumanWarnings(result.diagnostics);
    process.stdout.write(
      command.outputPath === undefined ? content : `Wrote Roblox manifest: ${command.outputPath}\n`,
    );
  }
  return 0;
}

function invalidManifestDiagnostics(input: unknown): readonly RobloxDiagnostic[] | undefined {
  const validation = validateRobloxManifest(input);
  if (validation.valid) return undefined;
  return validation.diagnostics.map((entry) =>
    diagnostic(
      'plan.manifest_invalid',
      entry.path,
      `${entry.code}: ${entry.message}`,
      entry.relatedId,
    ),
  );
}

async function runPlan(command: Readonly<PlanCommand>): Promise<number> {
  const manifestInput = await readJsonFile(command.inputPath, 'manifest input');
  if (!manifestInput.success) {
    return manifestInput.kind === 'io'
      ? reportIoFailure(manifestInput.message, command.json)
      : reportInvalidJson(manifestInput.message, command.json);
  }

  let snapshotInput: unknown;
  if (command.snapshotPath === undefined) {
    const manifestValidation = validateRobloxManifest(manifestInput.value);
    if (!manifestValidation.valid) {
      return reportDomainFailure(
        invalidManifestDiagnostics(manifestInput.value) ?? manifestValidation.diagnostics,
        command.json,
      );
    }
    snapshotInput = normalizeRobloxSnapshot({
      schemaVersion: ROBLOX_SNAPSHOT_VERSION,
      projectId: manifestValidation.value.source.projectId,
      target: manifestValidation.value.target,
      nodes: [],
      unmanagedRoots: [],
    });
  } else {
    const snapshot = await readJsonFile(command.snapshotPath, 'snapshot input');
    if (!snapshot.success) {
      return snapshot.kind === 'io'
        ? reportIoFailure(snapshot.message, command.json)
        : reportInvalidJson(snapshot.message, command.json);
    }
    snapshotInput = snapshot.value;
  }

  const result = planRobloxChangeSet(snapshotInput, manifestInput.value);
  if (!result.success) return reportDomainFailure(result.diagnostics, command.json);
  const content = stringifyRobloxChangeSet(result.changeSet);
  if (command.outputPath !== undefined) {
    const exitCode = await writeArtifact(command.outputPath, content, command.json);
    if (exitCode !== undefined) return exitCode;
  }

  if (command.json) {
    writeCanonicalJson({
      changeSet: result.changeSet,
      diagnostics: result.diagnostics,
      success: true,
    });
  } else {
    process.stdout.write(
      command.outputPath === undefined
        ? content
        : `Wrote Roblox change set: ${command.outputPath}\n`,
    );
  }
  return 0;
}

export async function runRobloxCompilerCli(args: readonly string[]): Promise<number> {
  const parsed = parseCommand(args);
  if (!parsed.success) return reportUsageFailure(parsed.message, args.includes('--json'));
  switch (parsed.command.kind) {
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    case 'compile':
      return runCompile(parsed.command);
    case 'plan':
      return runPlan(parsed.command);
  }
}

const entryPath = process.argv[1];
const isMain =
  entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href;

if (isMain) {
  void runRobloxCompilerCli(process.argv.slice(2)).then(
    (exitCode: number) => {
      process.exitCode = exitCode;
    },
    () => {
      process.stderr.write('Roblox compiler CLI failed unexpectedly.\n');
      process.exitCode = 2;
    },
  );
}
