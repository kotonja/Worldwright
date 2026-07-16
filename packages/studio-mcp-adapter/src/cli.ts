#!/usr/bin/env node

import { open, readFile, realpath, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  hashRobloxChangeSet,
  normalizeRobloxChangeSet,
  normalizeRobloxManifest,
  planRobloxChangeSet,
  stringifyRobloxChangeSet,
  stringifyRobloxSnapshot,
  validateRobloxChangeSet,
  validateRobloxManifest,
  type RobloxChangeSet,
  type RobloxManifest,
} from '@worldwright/roblox-compiler';

import {
  connectReadOnlyStudioMcpAdapter,
  connectSelectedStudioMcpAdapter,
  type StudioMcpRobloxAdapter,
} from './adapter.js';
import { createViewportEvidence } from './capture.js';
import {
  StudioAdapterError,
  studioDiagnostic,
  type StudioDiagnostic,
  type StudioDiagnosticCode,
} from './diagnostics.js';
import { hashStudioApplyReceipt } from './hashing.js';
import { stringifyCanonicalJson, type JsonValue } from './json.js';
import { connectStudioMcp } from './mcp/client.js';
import { assertSandboxStudioProbe, listStudioSessions } from './mcp/session.js';
import { stringifyStudioApplyReceipt } from './normalize.js';
import { buildStudioApplyReceipt } from './receipt.js';

const USAGE = `Usage:
  studio-mcp probe [--studio-id <id>] [--json]
  studio-mcp snapshot [--studio-id <id>] --project-id <project-id> [--output <path>] [--json]
  studio-mcp plan-live [--studio-id <id>] --manifest <path> [--output <path>] [--json]
  studio-mcp apply --studio-id <id> --change-set <path> --confirm <full-sha256> [--receipt-output <path>] [--json]
  studio-mcp verify --studio-id <id> --manifest <path> [--json]
  studio-mcp capture --studio-id <id> --output <path> [--json]
`;

const LIVE_EVIDENCE_DIRECTORY = fileURLToPath(
  new URL('../../../.worldwright/live-milestone-3/', import.meta.url),
);

interface CliIo {
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

export interface StudioMcpCliDependencies {
  readonly connectClient: typeof connectStudioMcp;
  readonly connectSelectedAdapter: typeof connectSelectedStudioMcpAdapter;
  readonly connectReadOnlyAdapter: typeof connectReadOnlyStudioMcpAdapter;
  readonly finalizeReceipt?: (handle: FileHandle, value: string) => Promise<void>;
  readonly evidenceDirectory?: string;
}

const defaultDependencies: StudioMcpCliDependencies = {
  connectClient: connectStudioMcp,
  connectSelectedAdapter: connectSelectedStudioMcpAdapter,
  connectReadOnlyAdapter: connectReadOnlyStudioMcpAdapter,
};

interface ParsedOptions {
  readonly values: ReadonlyMap<string, string>;
  readonly json: boolean;
}

class CliError extends Error {
  public readonly exitCode: 1 | 2;
  public readonly diagnostics: readonly StudioDiagnostic[];

  public constructor(exitCode: 1 | 2, diagnostic: StudioDiagnostic) {
    super(diagnostic.message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.diagnostics = [diagnostic];
  }
}

const defaultIo: CliIo = {
  writeStdout: (value) => process.stdout.write(value),
  writeStderr: (value) => process.stderr.write(value),
};

function usageError(message: string): never {
  throw new CliError(2, studioDiagnostic('studio.usage_invalid', '', message));
}

function parseOptions(args: readonly string[], allowedValues: ReadonlySet<string>): ParsedOptions {
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--json') {
      if (json) usageError('The --json flag may be supplied only once.');
      json = true;
      continue;
    }
    if (!argument.startsWith('--')) usageError('An unexpected positional argument was provided.');
    const name = argument.slice(2);
    if (!allowedValues.has(name)) usageError('An unsupported option was provided.');
    if (values.has(name)) usageError('An option may be supplied only once.');
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) usageError('An option requires a value.');
    values.set(name, value);
    index += 1;
  }
  return { values, json };
}

function required(options: ParsedOptions, name: string): string {
  const value = options.values.get(name);
  if (value === undefined || value.length === 0) usageError(`Missing required option --${name}.`);
  return value;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new CliError(
      2,
      studioDiagnostic('studio.io_failed', '', 'The selected JSON input could not be read.'),
    );
  }
}

function assertOutputDistinct(outputPath: string, inputPaths: readonly string[]): void {
  const output = resolve(outputPath);
  if (inputPaths.some((input) => resolve(input) === output)) {
    throw new CliError(
      2,
      studioDiagnostic('studio.io_failed', '', 'An output path must not overwrite an input file.'),
    );
  }
}

async function writeText(
  path: string,
  value: string,
  inputPaths: readonly string[],
): Promise<void> {
  assertOutputDistinct(path, inputPaths);
  try {
    await writeFile(path, value, { encoding: 'utf8', flag: 'wx' });
  } catch {
    throw new CliError(
      2,
      studioDiagnostic('studio.io_failed', '', 'The explicit output file could not be written.'),
    );
  }
}

async function reserveTextOutput(path: string, inputPaths: readonly string[]): Promise<FileHandle> {
  assertOutputDistinct(path, inputPaths);
  try {
    return await open(path, 'wx');
  } catch {
    throw new CliError(
      2,
      studioDiagnostic('studio.io_failed', '', 'The explicit output file could not be reserved.'),
    );
  }
}

async function writeReservedText(handle: FileHandle, value: string): Promise<void> {
  await handle.writeFile(value, { encoding: 'utf8' });
  await handle.sync();
  await handle.close();
}

async function writeReservedBytes(handle: FileHandle, value: Uint8Array): Promise<void> {
  await handle.writeFile(value);
  await handle.sync();
  await handle.close();
}

function isWithinPath(root: string, candidate: string, allowEqual: boolean): boolean {
  const relation = relative(root, candidate);
  return (
    (allowEqual || relation.length > 0) &&
    relation !== '..' &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

async function assertLiveEvidenceOutputPath(
  path: string,
  evidenceDirectory: string,
): Promise<void> {
  const output = resolve(path);
  const root = resolve(evidenceDirectory);
  let safe = isWithinPath(root, output, false);
  if (safe) {
    try {
      const [realRoot, realParent] = await Promise.all([realpath(root), realpath(dirname(output))]);
      safe = isWithinPath(realRoot, realParent, true);
    } catch {
      safe = false;
    }
  }
  if (!safe) {
    throw new CliError(
      2,
      studioDiagnostic(
        'studio.io_failed',
        '',
        'Viewport evidence must be written under .worldwright/live-milestone-3/.',
      ),
    );
  }
}

function writeJson(io: CliIo, value: JsonValue): void {
  io.writeStdout(stringifyCanonicalJson(value));
}

function compilerFailure(
  diagnostics: readonly {
    readonly code: string;
    readonly path: string;
    readonly message: string;
    readonly relatedId?: string;
  }[],
): CliError {
  const first = diagnostics[0];
  return new CliError(
    1,
    studioDiagnostic(
      'studio.transaction_failed',
      first?.path ?? '',
      first === undefined ? 'The domain contract is invalid.' : `${first.code}: ${first.message}`,
      first?.relatedId === undefined ? {} : { relatedId: first.relatedId },
    ),
  );
}

async function loadManifest(path: string): Promise<RobloxManifest> {
  const validation = validateRobloxManifest(await readJson(path));
  if (!validation.valid) throw compilerFailure(validation.diagnostics);
  return normalizeRobloxManifest(validation.value);
}

async function loadChangeSet(path: string): Promise<RobloxChangeSet> {
  const validation = validateRobloxChangeSet(await readJson(path));
  if (!validation.valid) throw compilerFailure(validation.diagnostics);
  return normalizeRobloxChangeSet(validation.value);
}

async function closeAdapter(adapter: StudioMcpRobloxAdapter | undefined): Promise<void> {
  if (adapter === undefined) return;
  await adapter.close().catch(() => undefined);
}

async function runProbe(
  args: readonly string[],
  io: CliIo,
  dependencies: StudioMcpCliDependencies,
): Promise<number> {
  const options = parseOptions(args, new Set(['studio-id']));
  const studioId = options.values.get('studio-id');
  if (studioId === undefined) {
    const client = await dependencies.connectClient();
    try {
      const sessions = await listStudioSessions(client);
      if (options.json) {
        writeJson(io, { success: true, sessions } as unknown as JsonValue);
      } else if (sessions.length === 0) {
        io.writeStdout('No Roblox Studio sessions are connected.\n');
      } else {
        for (const session of sessions) {
          io.writeStdout(
            `${session.studioId}\t${session.displayName}\t${session.active ? 'active' : 'inactive'}\n`,
          );
        }
      }
      return 0;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  let adapter: StudioMcpRobloxAdapter | undefined;
  try {
    adapter = await dependencies.connectSelectedAdapter(studioId);
    const probe = await adapter.probeSelectedStudio();
    if (options.json) writeJson(io, { success: true, probe } as unknown as JsonValue);
    else {
      io.writeStdout(
        `Studio: ${probe.studioId}\nPlace: ${probe.placeName}\nPlaceId: ${probe.placeId}\nGameId: ${probe.gameId}\nMode: ${probe.dataModelMode}\nPlaytesting: ${probe.playtesting}\nEdit available: ${probe.editExecutionAvailable}\n`,
      );
    }
    return 0;
  } finally {
    await closeAdapter(adapter);
  }
}

async function runSnapshot(
  args: readonly string[],
  io: CliIo,
  dependencies: StudioMcpCliDependencies,
): Promise<number> {
  const options = parseOptions(args, new Set(['studio-id', 'project-id', 'output']));
  const projectId = required(options, 'project-id');
  let adapter: StudioMcpRobloxAdapter | undefined;
  try {
    adapter = await dependencies.connectReadOnlyAdapter(options.values.get('studio-id'));
    const snapshot = await adapter.readSnapshot({ projectId, target: { service: 'Workspace' } });
    const output = options.values.get('output');
    if (output !== undefined) await writeText(output, stringifyRobloxSnapshot(snapshot), []);
    if (options.json) {
      writeJson(io, {
        success: true,
        snapshot,
        ...(output === undefined ? {} : { written: true }),
      } as unknown as JsonValue);
    } else if (output === undefined) io.writeStdout(stringifyRobloxSnapshot(snapshot));
    else io.writeStdout(`Snapshot written with ${snapshot.nodes.length} managed nodes.\n`);
    return 0;
  } finally {
    await closeAdapter(adapter);
  }
}

async function runPlanLive(
  args: readonly string[],
  io: CliIo,
  dependencies: StudioMcpCliDependencies,
): Promise<number> {
  const options = parseOptions(args, new Set(['studio-id', 'manifest', 'output']));
  const manifestPath = required(options, 'manifest');
  const manifest = await loadManifest(manifestPath);
  let adapter: StudioMcpRobloxAdapter | undefined;
  try {
    adapter = await dependencies.connectReadOnlyAdapter(options.values.get('studio-id'));
    const snapshot = await adapter.readSnapshot({
      projectId: manifest.source.projectId,
      target: manifest.target,
    });
    const plan = planRobloxChangeSet(snapshot, manifest);
    if (!plan.success) throw compilerFailure(plan.diagnostics);
    const output = options.values.get('output');
    if (output !== undefined) {
      await writeText(output, stringifyRobloxChangeSet(plan.changeSet), [manifestPath]);
    }
    const changeSetHash = hashRobloxChangeSet(plan.changeSet);
    if (options.json) {
      writeJson(io, {
        success: true,
        changeSetHash,
        summary: plan.changeSet.summary,
        changeSet: plan.changeSet,
        ...(output === undefined ? {} : { written: true }),
      } as unknown as JsonValue);
    } else {
      io.writeStdout(
        `Creates: ${plan.changeSet.summary.creates}\nUpdates: ${plan.changeSet.summary.updates}\nDeletes: ${plan.changeSet.summary.deletes}\nTotal: ${plan.changeSet.summary.total}\nChange-set hash: ${changeSetHash}\n`,
      );
    }
    return 0;
  } finally {
    await closeAdapter(adapter);
  }
}

function writeApplyPreview(
  io: CliIo,
  studioId: string,
  placeName: string,
  changeSet: Readonly<RobloxChangeSet>,
  changeSetHash: string,
): void {
  io.writeStdout(
    `Studio ID: ${studioId}\nUnsaved place: ${placeName}\nProject: ${changeSet.preconditions.projectId}\nCreates: ${changeSet.summary.creates}\nUpdates: ${changeSet.summary.updates}\nDeletes: ${changeSet.summary.deletes}\nTotal operations: ${changeSet.summary.total}\nBase snapshot hash: ${changeSet.preconditions.baseSnapshotHash}\nDesired manifest hash: ${changeSet.preconditions.desiredManifestHash}\nExpected result hash: ${changeSet.preconditions.resultSnapshotHash}\nRequired confirmation hash: ${changeSetHash}\n`,
  );
}

async function runApply(
  args: readonly string[],
  io: CliIo,
  dependencies: StudioMcpCliDependencies,
): Promise<number> {
  const options = parseOptions(
    args,
    new Set(['studio-id', 'change-set', 'confirm', 'receipt-output']),
  );
  const studioId = required(options, 'studio-id');
  const changeSetPath = required(options, 'change-set');
  const confirmation = required(options, 'confirm');
  const changeSet = await loadChangeSet(changeSetPath);
  const changeSetHash = hashRobloxChangeSet(changeSet);
  if (!/^[0-9a-f]{64}$/u.test(confirmation) || confirmation !== changeSetHash) {
    usageError(
      'The --confirm value must equal the complete lowercase normalized change-set SHA-256.',
    );
  }

  const receiptOutput = options.values.get('receipt-output');
  if (receiptOutput !== undefined) {
    await assertLiveEvidenceOutputPath(
      receiptOutput,
      dependencies.evidenceDirectory ?? LIVE_EVIDENCE_DIRECTORY,
    );
  }
  const reservedReceipt =
    receiptOutput === undefined
      ? undefined
      : await reserveTextOutput(receiptOutput, [changeSetPath]);
  let adapter: StudioMcpRobloxAdapter | undefined;
  let receiptFinalized = false;
  try {
    adapter = await dependencies.connectSelectedAdapter(studioId);
    const probe = assertSandboxStudioProbe(await adapter.probeSelectedStudio());
    if (!options.json) writeApplyPreview(io, studioId, probe.placeName, changeSet, changeSetHash);
    const result = await adapter.applyChangeSet(changeSet);
    const receipt = buildStudioApplyReceipt(
      {
        studio: {
          studioId,
          placeName: probe.placeName,
          placeId: 0,
          gameId: 0,
        },
        projectId: changeSet.preconditions.projectId,
        target: changeSet.preconditions.target,
        changeSetHash,
        baseSnapshotHash: changeSet.preconditions.baseSnapshotHash,
        desiredManifestHash: changeSet.preconditions.desiredManifestHash,
        expectedResultSnapshotHash: changeSet.preconditions.resultSnapshotHash,
        operationsPlanned: changeSet.operations.length,
      },
      result,
    );
    let receiptWriteDiagnostic: StudioDiagnostic | undefined;
    if (reservedReceipt !== undefined) {
      try {
        await (dependencies.finalizeReceipt ?? writeReservedText)(
          reservedReceipt,
          stringifyStudioApplyReceipt(receipt),
        );
        receiptFinalized = true;
      } catch (error) {
        receiptWriteDiagnostic =
          error instanceof CliError
            ? error.diagnostics[0]
            : studioDiagnostic(
                'studio.io_failed',
                '',
                'The transaction completed, but its receipt could not be written.',
              );
      }
    }
    const receiptHash = hashStudioApplyReceipt(receipt);
    if (options.json) {
      writeJson(io, {
        success: result.success && receiptWriteDiagnostic === undefined,
        transactionSucceeded: result.success,
        result,
        receipt,
        receiptHash,
        ...(receiptOutput === undefined
          ? {}
          : { receiptWritten: receiptWriteDiagnostic === undefined }),
        ...(receiptWriteDiagnostic === undefined ? {} : { diagnostics: [receiptWriteDiagnostic] }),
      } as unknown as JsonValue);
    } else {
      io.writeStdout(
        `Transaction status: ${receipt.status}\nOperations attempted: ${receipt.operationsAttempted}\nReceipt hash: ${receiptHash}\n`,
      );
      if (receiptWriteDiagnostic !== undefined) {
        io.writeStderr(`${receiptWriteDiagnostic.code}: ${receiptWriteDiagnostic.message}\n`);
      }
    }
    if (receiptWriteDiagnostic !== undefined) return 2;
    return result.success ? 0 : 1;
  } finally {
    await closeAdapter(adapter);
    if (reservedReceipt !== undefined && !receiptFinalized) {
      await reservedReceipt.close().catch(() => undefined);
      if (receiptOutput !== undefined) {
        await unlink(receiptOutput).catch(() => undefined);
      }
    }
  }
}

async function runVerify(
  args: readonly string[],
  io: CliIo,
  dependencies: StudioMcpCliDependencies,
): Promise<number> {
  const options = parseOptions(args, new Set(['studio-id', 'manifest']));
  const studioId = required(options, 'studio-id');
  const manifest = await loadManifest(required(options, 'manifest'));
  let adapter: StudioMcpRobloxAdapter | undefined;
  try {
    adapter = await dependencies.connectSelectedAdapter(studioId);
    const snapshot = await adapter.readSnapshot({
      projectId: manifest.source.projectId,
      target: manifest.target,
    });
    const plan = planRobloxChangeSet(snapshot, manifest);
    if (!plan.success) throw compilerFailure(plan.diagnostics);
    const matches = plan.changeSet.operations.length === 0;
    if (options.json) {
      writeJson(io, {
        success: matches,
        matches,
        operationCount: plan.changeSet.operations.length,
        snapshotHash: plan.changeSet.preconditions.baseSnapshotHash,
        desiredManifestHash: plan.changeSet.preconditions.desiredManifestHash,
      } as unknown as JsonValue);
    } else {
      io.writeStdout(
        matches
          ? `Live snapshot exactly matches the desired manifest.\nSnapshot hash: ${plan.changeSet.preconditions.baseSnapshotHash}\n`
          : `Live snapshot requires ${plan.changeSet.operations.length} operations.\n`,
      );
    }
    return matches ? 0 : 1;
  } finally {
    await closeAdapter(adapter);
  }
}

async function runCapture(
  args: readonly string[],
  io: CliIo,
  dependencies: StudioMcpCliDependencies,
): Promise<number> {
  const options = parseOptions(args, new Set(['studio-id', 'output']));
  const studioId = required(options, 'studio-id');
  const output = required(options, 'output');
  await assertLiveEvidenceOutputPath(
    output,
    dependencies.evidenceDirectory ?? LIVE_EVIDENCE_DIRECTORY,
  );
  const reservedOutput = await reserveTextOutput(output, []);
  let adapter: StudioMcpRobloxAdapter | undefined;
  let captureFinalized = false;
  try {
    adapter = await dependencies.connectSelectedAdapter(studioId);
    const capture = await adapter.captureViewport({ captureId: 'worldwright-viewport' });
    const evidence = createViewportEvidence(capture.mediaType, capture.bytes);
    await writeReservedBytes(reservedOutput, capture.bytes);
    captureFinalized = true;
    if (options.json) writeJson(io, { success: true, evidence } as unknown as JsonValue);
    else io.writeStdout(`Viewport evidence: ${evidence.sha256} (${evidence.byteLength} bytes)\n`);
    return 0;
  } finally {
    await closeAdapter(adapter);
    if (!captureFinalized) {
      await reservedOutput.close().catch(() => undefined);
      await unlink(output).catch(() => undefined);
    }
  }
}

function errorEnvelope(diagnostics: readonly StudioDiagnostic[]): JsonValue {
  return { success: false, diagnostics } as unknown as JsonValue;
}

const EXIT_TWO_DIAGNOSTIC_CODES = new Set<StudioDiagnosticCode>([
  'studio.mcp_start_failed',
  'studio.mcp_handshake_failed',
  'studio.tool_missing',
  'studio.tool_schema_unsupported',
  'studio.tool_call_failed',
  'studio.tool_timeout',
  'studio.response_invalid',
  'studio.response_too_large',
  'studio.session_not_found',
  'studio.session_ambiguous',
  'studio.edit_mode_required',
  'studio.published_place_forbidden',
  'studio.capture_unavailable',
  'studio.capture_invalid',
  'studio.io_failed',
  'studio.usage_invalid',
]);

function studioErrorExitCode(diagnostics: readonly StudioDiagnostic[]): 1 | 2 {
  return diagnostics.every((diagnostic) => EXIT_TWO_DIAGNOSTIC_CODES.has(diagnostic.code)) ? 2 : 1;
}

export async function runStudioMcpCli(
  args: readonly string[],
  io: CliIo = defaultIo,
  dependencies: StudioMcpCliDependencies = defaultDependencies,
): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined || command === '--help' || command === '-h') {
    if (command === undefined) io.writeStderr(USAGE);
    else io.writeStdout(USAGE);
    return command === undefined ? 2 : 0;
  }
  const jsonRequested = rest.includes('--json');
  try {
    switch (command) {
      case 'probe':
        return await runProbe(rest, io, dependencies);
      case 'snapshot':
        return await runSnapshot(rest, io, dependencies);
      case 'plan-live':
        return await runPlanLive(rest, io, dependencies);
      case 'apply':
        return await runApply(rest, io, dependencies);
      case 'verify':
        return await runVerify(rest, io, dependencies);
      case 'capture':
        return await runCapture(rest, io, dependencies);
      default:
        usageError('The command is unknown.');
    }
  } catch (error) {
    const diagnostics =
      error instanceof StudioAdapterError
        ? error.diagnostics
        : error instanceof CliError
          ? error.diagnostics
          : [studioDiagnostic('studio.io_failed', '', 'The Studio MCP command failed.')];
    const exitCode =
      error instanceof CliError
        ? error.exitCode
        : error instanceof StudioAdapterError
          ? studioErrorExitCode(error.diagnostics)
          : 2;
    if (jsonRequested) writeJson(io, errorEnvelope(diagnostics));
    else {
      for (const diagnostic of diagnostics)
        io.writeStderr(`${diagnostic.code}: ${diagnostic.message}\n`);
    }
    return exitCode;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  process.exitCode = await runStudioMcpCli(process.argv.slice(2));
}
