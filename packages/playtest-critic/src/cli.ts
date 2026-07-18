#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { evaluatePlaytestRun } from './critic/evaluate.js';
import { stringifyCriticReport } from './critic/hashing.js';
import type { PlaytestDiagnostic } from './diagnostic.js';
import { stringifyCanonicalJson, type JsonValue } from './json.js';
import { stringifyPlaytestPlan } from './plan/hashing.js';
import { buildPlaytestPlan } from './plan/planner.js';

interface CliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

const defaultIo: CliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

interface ParsedCommand {
  readonly kind: 'plan' | 'evaluate';
  readonly primaryPath: string;
  readonly secondaryPath: string;
  readonly outputPath?: string;
  readonly json: boolean;
}

const usage = `Usage:\n  playtest-critic plan <architecture-plan.json> --manifest <manifest.json> [--output <plan.json>] [--json]\n  playtest-critic evaluate --plan <playtest-plan.json> --run-report <run-report.json> [--output <critic.json>] [--json]\n`;

function parseCommand(args: readonly string[]): ParsedCommand | undefined {
  const kind = args[0];
  if (kind !== 'plan' && kind !== 'evaluate') return undefined;
  let primaryPath: string | undefined;
  let secondaryPath: string | undefined;
  let outputPath: string | undefined;
  let json = false;
  let index = 1;
  if (args[index] !== undefined && !args[index]!.startsWith('--')) primaryPath = args[index++];
  for (; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--json') {
      json = true;
      continue;
    }
    if (value === '--output') {
      outputPath = args[++index];
      if (outputPath === undefined) return undefined;
      continue;
    }
    if (value === '--plan') {
      if (primaryPath !== undefined) return undefined;
      primaryPath = args[++index];
      if (primaryPath === undefined) return undefined;
      continue;
    }
    if (
      value === (kind === 'plan' ? '--manifest' : '--run') ||
      (kind === 'evaluate' && value === '--run-report')
    ) {
      if (secondaryPath !== undefined) return undefined;
      secondaryPath = args[++index];
      if (secondaryPath === undefined) return undefined;
      continue;
    }
    return undefined;
  }
  if (primaryPath === undefined || secondaryPath === undefined) return undefined;
  if (
    outputPath !== undefined &&
    (resolve(outputPath) === resolve(primaryPath) || resolve(outputPath) === resolve(secondaryPath))
  )
    return undefined;
  return {
    kind,
    primaryPath,
    secondaryPath,
    ...(outputPath === undefined ? {} : { outputPath }),
    json,
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function domainFailure(
  diagnostics: readonly PlaytestDiagnostic[],
  json: boolean,
  io: CliIo,
): number {
  if (json)
    io.stdout(stringifyCanonicalJson({ diagnostics, success: false } as unknown as JsonValue));
  else
    for (const diagnostic of diagnostics)
      io.stderr(`${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}\n`);
  return 1;
}

function ioFailure(message: string, json: boolean, io: CliIo): number {
  if (json)
    io.stdout(
      stringifyCanonicalJson({ error: { code: 'cli.io', message }, success: false } as JsonValue),
    );
  else io.stderr(`playtest-critic: ${message}\n`);
  return 2;
}

export async function runPlaytestCriticCli(
  args: readonly string[],
  io: CliIo = defaultIo,
): Promise<number> {
  const command = parseCommand(args);
  if (command === undefined) {
    const json = args.includes('--json');
    if (json)
      io.stdout(
        stringifyCanonicalJson({
          error: { code: 'cli.usage', message: usage.trim() },
          success: false,
        } as JsonValue),
      );
    else io.stderr(usage);
    return 2;
  }
  let primary: unknown;
  let secondary: unknown;
  try {
    [primary, secondary] = await Promise.all([
      readJson(command.primaryPath),
      readJson(command.secondaryPath),
    ]);
  } catch {
    return ioFailure('Unable to read and parse the requested input files.', command.json, io);
  }
  if (command.kind === 'plan') {
    const result = buildPlaytestPlan(primary, secondary);
    if (!result.valid) return domainFailure(result.diagnostics, command.json, io);
    const serialized = stringifyPlaytestPlan(result.value);
    if (command.outputPath !== undefined) {
      try {
        await writeFile(command.outputPath, serialized, { encoding: 'utf8', flag: 'wx' });
      } catch {
        return ioFailure('Unable to write the requested output file.', command.json, io);
      }
    }
    if (command.json)
      io.stdout(
        stringifyCanonicalJson({
          playtestPlan: result.value,
          success: true,
        } as unknown as JsonValue),
      );
    else if (command.outputPath === undefined) io.stdout(serialized);
    return 0;
  }
  const result = evaluatePlaytestRun(primary, secondary);
  if (!result.valid) return domainFailure(result.diagnostics, command.json, io);
  const serialized = stringifyCriticReport(result.value);
  if (command.outputPath !== undefined) {
    try {
      await writeFile(command.outputPath, serialized, { encoding: 'utf8', flag: 'wx' });
    } catch {
      return ioFailure('Unable to write the requested output file.', command.json, io);
    }
  }
  if (command.json)
    io.stdout(
      stringifyCanonicalJson({ criticReport: result.value, success: true } as unknown as JsonValue),
    );
  else if (command.outputPath === undefined) io.stdout(serialized);
  return result.value.status === 'fail' ? 1 : 0;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  void runPlaytestCriticCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
