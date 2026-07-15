#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  WorldSpecSchema,
  formatDiagnostics,
  normalizeWorldSpec,
  parseWorldSpec,
  stringifyWorldSpec,
} from './index.js';
import type { ValidationResult } from './index.js';

const USAGE = `Usage:
  worldspec validate <file> [--json]
  worldspec normalize <file> [--output <path>]
  worldspec schema`;

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const processIo: CliIo = {
  stdout: (text: string): void => {
    process.stdout.write(text);
  },
  stderr: (text: string): void => {
    process.stderr.write(text);
  },
};

class UsageError extends Error {}

function oneTrailingNewline(text: string): string {
  return `${text.replace(/\n+$/u, '')}\n`;
}

function validationJson(result: ValidationResult): string {
  return `${JSON.stringify(
    {
      valid: result.valid,
      diagnostics: result.diagnostics,
    },
    null,
    2,
  )}\n`;
}

function reportInvalid(
  filePath: string,
  result: ValidationResult,
  asJson: boolean,
  io: CliIo,
): void {
  if (asJson) {
    io.stdout(validationJson(result));
    return;
  }

  io.stderr(`Invalid WorldSpec: ${filePath}\n`);
  io.stderr(oneTrailingNewline(formatDiagnostics(result.diagnostics)));
}

async function readSource(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read "${filePath}": ${message}`);
  }
}

async function runValidate(args: readonly string[], io: CliIo): Promise<number> {
  const { positionals, values } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
    },
    strict: true,
  });

  const filePath = positionals[0];
  if (positionals.length !== 1 || filePath === undefined) {
    throw new UsageError('validate requires exactly one input file');
  }

  const asJson = values.json === true;
  const result = parseWorldSpec(await readSource(filePath));
  if (!result.valid) {
    reportInvalid(filePath, result, asJson, io);
    return 1;
  }

  if (asJson) {
    io.stdout(validationJson(result));
  } else {
    io.stdout(`Valid WorldSpec: ${filePath}\n`);
  }

  return 0;
}

async function runNormalize(args: readonly string[], io: CliIo): Promise<number> {
  const { positionals, values } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      output: { type: 'string' },
    },
    strict: true,
  });

  const filePath = positionals[0];
  if (positionals.length !== 1 || filePath === undefined) {
    throw new UsageError('normalize requires exactly one input file');
  }

  const result = parseWorldSpec(await readSource(filePath));
  if (!result.valid) {
    reportInvalid(filePath, result, false, io);
    return 1;
  }

  const output = stringifyWorldSpec(normalizeWorldSpec(result.value));
  const outputPath = typeof values.output === 'string' ? values.output : undefined;
  if (outputPath === undefined) {
    io.stdout(output);
    return 0;
  }

  try {
    await writeFile(outputPath, output, 'utf8');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to write "${outputPath}": ${message}`);
  }

  io.stdout(`Normalized WorldSpec written to ${outputPath}\n`);
  return 0;
}

function runSchema(args: readonly string[], io: CliIo): number {
  const { positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {},
    strict: true,
  });

  if (positionals.length !== 0) {
    throw new UsageError('schema does not accept positional arguments');
  }

  io.stdout(`${JSON.stringify(WorldSpecSchema, null, 2)}\n`);
  return 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  io: CliIo = processIo,
): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h') {
    io.stdout(`${USAGE}\n`);
    return 0;
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  try {
    switch (command) {
      case 'validate':
        return await runValidate(commandArgs, io);
      case 'normalize':
        return await runNormalize(commandArgs, io);
      case 'schema':
        return runSchema(commandArgs, io);
      case undefined:
        throw new UsageError('a command is required');
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error: unknown) {
    io.stderr(`Error: ${errorMessage(error)}\n`);
    if (error instanceof UsageError || error instanceof TypeError) {
      io.stderr(`\n${USAGE}\n`);
    }
    return 2;
  }
}

const entryPath = process.argv[1];
const isMain =
  entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href;

if (isMain) {
  process.exitCode = await runCli();
}
