#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { stringifyWorldSpec } from '@worldwright/worldspec';

import {
  architectureDiagnostic,
  formatArchitectureDiagnostics,
  sortArchitectureDiagnostics,
  type ArchitectureDiagnostic,
} from './diagnostics.js';
import { emitArchitectureWorldSpec } from './emit-worldspec.js';
import { stringifyCanonicalJson, type JsonValue } from './json.js';
import { stringifyArchitecturePlan } from './normalize.js';
import { planArchitectureWorldSpec } from './planner.js';

const USAGE = `Usage:
  architecture-planner plan <source-worldspec> [--output <plan-file>] [--json]
  architecture-planner emit <source-worldspec> --plan <plan-file> [--output <derived-worldspec-file>] [--json]
  architecture-planner build <source-worldspec> [--plan-output <plan-file>] [--worldspec-output <derived-worldspec-file>] [--json]
`;

interface PlanCommand {
  readonly kind: 'plan';
  readonly sourcePath: string;
  readonly outputPath?: string;
  readonly json: boolean;
}

interface EmitCommand {
  readonly kind: 'emit';
  readonly sourcePath: string;
  readonly planPath: string;
  readonly outputPath?: string;
  readonly json: boolean;
}

interface BuildCommand {
  readonly kind: 'build';
  readonly sourcePath: string;
  readonly planOutputPath?: string;
  readonly worldSpecOutputPath?: string;
  readonly json: boolean;
}

interface HelpCommand {
  readonly kind: 'help';
}

type CliCommand = PlanCommand | EmitCommand | BuildCommand | HelpCommand;

type ParseResult =
  | { readonly success: true; readonly command: CliCommand }
  | { readonly success: false; readonly message: string };

type JsonFileResult =
  | { readonly success: true; readonly value: unknown }
  | { readonly success: false; readonly kind: 'io' | 'json'; readonly message: string };

export interface ArchitecturePlannerCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const processIo: ArchitecturePlannerCliIo = {
  stdout: (text: string): void => {
    process.stdout.write(text);
  },
  stderr: (text: string): void => {
    process.stderr.write(text);
  },
};

function samePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function sortAndDeduplicateDiagnostics(
  diagnostics: readonly ArchitectureDiagnostic[],
): ArchitectureDiagnostic[] {
  const sorted = sortArchitectureDiagnostics(diagnostics);
  return sorted.filter((entry, index) => {
    const previous = sorted[index - 1];
    return (
      previous === undefined ||
      entry.path !== previous.path ||
      entry.code !== previous.code ||
      entry.severity !== previous.severity ||
      entry.message !== previous.message ||
      entry.relatedId !== previous.relatedId
    );
  });
}

function parseOptions(
  commandName: 'plan' | 'emit' | 'build',
  args: readonly string[],
): ParseResult {
  let sourcePath: string | undefined;
  let outputPath: string | undefined;
  let planPath: string | undefined;
  let planOutputPath: string | undefined;
  let worldSpecOutputPath: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--json') {
      if (json) return { success: false, message: 'The --json flag may be supplied only once.' };
      json = true;
      continue;
    }

    const supportedOption =
      (commandName === 'plan' && argument === '--output') ||
      (commandName === 'emit' && (argument === '--plan' || argument === '--output')) ||
      (commandName === 'build' &&
        (argument === '--plan-output' || argument === '--worldspec-output'));
    if (supportedOption) {
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
      } else if (argument === '--plan') {
        if (planPath !== undefined) {
          return { success: false, message: 'The --plan option may be supplied only once.' };
        }
        planPath = value;
      } else if (argument === '--plan-output') {
        if (planOutputPath !== undefined) {
          return {
            success: false,
            message: 'The --plan-output option may be supplied only once.',
          };
        }
        planOutputPath = value;
      } else {
        if (worldSpecOutputPath !== undefined) {
          return {
            success: false,
            message: 'The --worldspec-output option may be supplied only once.',
          };
        }
        worldSpecOutputPath = value;
      }
      continue;
    }

    if (argument.startsWith('-')) {
      return { success: false, message: `Unknown option: ${argument}` };
    }
    if (sourcePath !== undefined) {
      return { success: false, message: 'Exactly one source WorldSpec file is required.' };
    }
    sourcePath = argument;
  }

  if (sourcePath === undefined) {
    return { success: false, message: 'A source WorldSpec file is required.' };
  }
  if (commandName === 'emit' && planPath === undefined) {
    return { success: false, message: 'The emit command requires --plan <plan-file>.' };
  }

  for (const candidate of [outputPath, planOutputPath, worldSpecOutputPath]) {
    if (candidate !== undefined && samePath(sourcePath, candidate)) {
      return { success: false, message: 'An output file must differ from the source file.' };
    }
  }
  if (planPath !== undefined && outputPath !== undefined && samePath(planPath, outputPath)) {
    return { success: false, message: 'The output file must differ from the plan input file.' };
  }
  if (
    planOutputPath !== undefined &&
    worldSpecOutputPath !== undefined &&
    samePath(planOutputPath, worldSpecOutputPath)
  ) {
    return { success: false, message: 'The plan and WorldSpec output files must differ.' };
  }

  switch (commandName) {
    case 'plan':
      return {
        success: true,
        command: {
          kind: 'plan',
          sourcePath,
          ...(outputPath === undefined ? {} : { outputPath }),
          json,
        },
      };
    case 'emit':
      return {
        success: true,
        command: {
          kind: 'emit',
          sourcePath,
          planPath: planPath!,
          ...(outputPath === undefined ? {} : { outputPath }),
          json,
        },
      };
    case 'build':
      return {
        success: true,
        command: {
          kind: 'build',
          sourcePath,
          ...(planOutputPath === undefined ? {} : { planOutputPath }),
          ...(worldSpecOutputPath === undefined ? {} : { worldSpecOutputPath }),
          json,
        },
      };
  }
}

function parseCommand(args: readonly string[]): ParseResult {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    return { success: true, command: { kind: 'help' } };
  }
  const commandName = args[0];
  if (commandName !== 'plan' && commandName !== 'emit' && commandName !== 'build') {
    return { success: false, message: 'Expected the plan, emit, or build command.' };
  }
  return parseOptions(commandName, args.slice(1));
}

async function readJsonFile(path: string, label: string): Promise<JsonFileResult> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch {
    return { success: false, kind: 'io', message: `Unable to read the ${label}: ${path}` };
  }
  try {
    return { success: true, value: JSON.parse(source) as unknown };
  } catch {
    return { success: false, kind: 'json', message: `The ${label} is not valid JSON.` };
  }
}

function canonicalJson(value: unknown): string {
  return stringifyCanonicalJson(value as JsonValue);
}

function reportUsageFailure(message: string, json: boolean, io: ArchitecturePlannerCliIo): number {
  if (json) io.stdout(canonicalJson({ error: { code: 'cli.usage', message }, success: false }));
  else io.stderr(`${message}\n${USAGE}`);
  return 2;
}

function reportIoFailure(message: string, json: boolean, io: ArchitecturePlannerCliIo): number {
  if (json) io.stdout(canonicalJson({ error: { code: 'cli.io', message }, success: false }));
  else io.stderr(`${message}\n`);
  return 2;
}

function reportInvalidJson(message: string, json: boolean, io: ArchitecturePlannerCliIo): number {
  return reportDomainFailure([architectureDiagnostic('json.invalid', '', message)], json, io);
}

function reportDomainFailure(
  diagnostics: readonly ArchitectureDiagnostic[],
  json: boolean,
  io: ArchitecturePlannerCliIo,
): number {
  if (json) io.stdout(canonicalJson({ diagnostics, success: false }));
  else io.stderr(`${formatArchitectureDiagnostics(diagnostics)}\n`);
  return 1;
}

function reportHumanWarnings(
  diagnostics: readonly ArchitectureDiagnostic[],
  io: ArchitecturePlannerCliIo,
): void {
  if (diagnostics.length > 0) io.stderr(`${formatArchitectureDiagnostics(diagnostics)}\n`);
}

async function writeArtifact(
  path: string,
  content: string,
  json: boolean,
  io: ArchitecturePlannerCliIo,
): Promise<number | undefined> {
  try {
    await writeFile(path, content, 'utf8');
    return undefined;
  } catch {
    return reportIoFailure(`Unable to write the output file: ${path}`, json, io);
  }
}

async function readSource(
  sourcePath: string,
  json: boolean,
  io: ArchitecturePlannerCliIo,
): Promise<
  | { readonly success: true; readonly value: unknown }
  | { readonly success: false; readonly exitCode: number }
> {
  const input = await readJsonFile(sourcePath, 'source WorldSpec file');
  if (input.success) return input;
  const exitCode =
    input.kind === 'io'
      ? reportIoFailure(input.message, json, io)
      : reportInvalidJson(input.message, json, io);
  return { success: false, exitCode };
}

async function runPlan(
  command: Readonly<PlanCommand>,
  io: ArchitecturePlannerCliIo,
): Promise<number> {
  const source = await readSource(command.sourcePath, command.json, io);
  if (!source.success) return source.exitCode;
  const result = planArchitectureWorldSpec(source.value);
  if (!result.success) return reportDomainFailure(result.diagnostics, command.json, io);

  const content = stringifyArchitecturePlan(result.plan);
  if (command.outputPath !== undefined) {
    const exitCode = await writeArtifact(command.outputPath, content, command.json, io);
    if (exitCode !== undefined) return exitCode;
  }
  if (command.json) {
    io.stdout(
      canonicalJson({
        architecturePlan: result.plan,
        diagnostics: result.diagnostics,
        success: true,
      }),
    );
  } else {
    reportHumanWarnings(result.diagnostics, io);
    io.stdout(
      command.outputPath === undefined
        ? content
        : `Wrote Architecture Plan: ${command.outputPath}\n`,
    );
  }
  return 0;
}

async function runEmit(
  command: Readonly<EmitCommand>,
  io: ArchitecturePlannerCliIo,
): Promise<number> {
  const source = await readSource(command.sourcePath, command.json, io);
  if (!source.success) return source.exitCode;
  const planInput = await readJsonFile(command.planPath, 'Architecture Plan file');
  if (!planInput.success) {
    return planInput.kind === 'io'
      ? reportIoFailure(planInput.message, command.json, io)
      : reportInvalidJson(planInput.message, command.json, io);
  }

  const result = emitArchitectureWorldSpec(source.value, planInput.value);
  if (!result.success) return reportDomainFailure(result.diagnostics, command.json, io);
  const content = stringifyWorldSpec(result.worldSpec);
  if (command.outputPath !== undefined) {
    const exitCode = await writeArtifact(command.outputPath, content, command.json, io);
    if (exitCode !== undefined) return exitCode;
  }
  if (command.json) {
    io.stdout(
      canonicalJson({
        architecturePlanHash: result.architecturePlanHash,
        diagnostics: result.diagnostics,
        manifest: result.manifest,
        success: true,
        worldSpec: result.worldSpec,
      }),
    );
  } else {
    reportHumanWarnings(result.diagnostics, io);
    io.stdout(
      command.outputPath === undefined
        ? content
        : `Wrote derived WorldSpec: ${command.outputPath}\n`,
    );
  }
  return 0;
}

async function runBuild(
  command: Readonly<BuildCommand>,
  io: ArchitecturePlannerCliIo,
): Promise<number> {
  const source = await readSource(command.sourcePath, command.json, io);
  if (!source.success) return source.exitCode;
  const planning = planArchitectureWorldSpec(source.value);
  if (!planning.success) return reportDomainFailure(planning.diagnostics, command.json, io);
  const emission = emitArchitectureWorldSpec(source.value, planning.plan);
  if (!emission.success) return reportDomainFailure(emission.diagnostics, command.json, io);
  const diagnostics = sortAndDeduplicateDiagnostics([
    ...planning.diagnostics,
    ...emission.diagnostics,
  ]);

  if (command.planOutputPath !== undefined) {
    const exitCode = await writeArtifact(
      command.planOutputPath,
      stringifyArchitecturePlan(planning.plan),
      command.json,
      io,
    );
    if (exitCode !== undefined) return exitCode;
  }
  if (command.worldSpecOutputPath !== undefined) {
    const exitCode = await writeArtifact(
      command.worldSpecOutputPath,
      stringifyWorldSpec(emission.worldSpec),
      command.json,
      io,
    );
    if (exitCode !== undefined) return exitCode;
  }

  if (command.json) {
    io.stdout(
      canonicalJson({
        architecturePlan: planning.plan,
        architecturePlanHash: emission.architecturePlanHash,
        diagnostics,
        manifest: emission.manifest,
        success: true,
        worldSpec: emission.worldSpec,
      }),
    );
  } else {
    reportHumanWarnings(diagnostics, io);
    if (command.planOutputPath === undefined && command.worldSpecOutputPath === undefined) {
      io.stdout(canonicalJson({ architecturePlan: planning.plan, worldSpec: emission.worldSpec }));
    } else {
      if (command.planOutputPath !== undefined) {
        io.stdout(`Wrote Architecture Plan: ${command.planOutputPath}\n`);
      }
      if (command.worldSpecOutputPath !== undefined) {
        io.stdout(`Wrote derived WorldSpec: ${command.worldSpecOutputPath}\n`);
      }
    }
  }
  return 0;
}

export async function runArchitecturePlannerCli(
  args: readonly string[],
  io: ArchitecturePlannerCliIo = processIo,
): Promise<number> {
  const parsed = parseCommand(args);
  if (!parsed.success) return reportUsageFailure(parsed.message, args.includes('--json'), io);
  switch (parsed.command.kind) {
    case 'help':
      io.stdout(USAGE);
      return 0;
    case 'plan':
      return runPlan(parsed.command, io);
    case 'emit':
      return runEmit(parsed.command, io);
    case 'build':
      return runBuild(parsed.command, io);
  }
}

const entryPath = process.argv[1];
const isMain =
  entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href;

if (isMain) {
  void runArchitecturePlannerCli(process.argv.slice(2)).then(
    (exitCode: number) => {
      process.exitCode = exitCode;
    },
    () => {
      process.stderr.write('Architecture planner CLI failed unexpectedly.\n');
      process.exitCode = 2;
    },
  );
}
