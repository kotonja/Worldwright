import { Buffer } from 'node:buffer';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  STUDIO_MCP_BATCH_TOOL_TIMEOUT_MS,
  STUDIO_MCP_CLOSE_TIMEOUT_MS,
  STUDIO_MCP_MAX_PAYLOAD_BYTES,
  STUDIO_MCP_PACKAGE_VERSION,
  STUDIO_MCP_PLAYTEST_MAX_CONSOLE_ENTRIES,
  STUDIO_MCP_PLAYTEST_MAX_CONSOLE_MESSAGE_BYTES,
  STUDIO_MCP_STARTUP_TIMEOUT_MS,
  STUDIO_MCP_TOOL_TIMEOUT_MS,
} from '../constants.js';
import { StudioAdapterError, sanitizedErrorMessage, studioDiagnostic } from '../diagnostics.js';
import { containsLocalAbsolutePath, isUnsafePresentationCharacter } from '../privacy.js';
import {
  discoverStudioMcpCapabilities,
  type AllowedStudioMcpToolName,
  type StudioMcpCapabilities,
} from './capabilities.js';
import { resolveDefaultStudioMcpCommand, type StudioMcpCommand } from './command.js';
import {
  readStudioMcpImageResult,
  readStudioMcpTextResult,
  type StudioMcpImageResult,
} from './result.js';
import { readStudioMcpToolListEnvelope } from './tool-schema.js';
import { terminateOwnedWindowsProcessTree } from './process-tree.js';
import {
  discoverStudioPlaytestMcpCapabilities,
  type StudioPlaytestMcpCapabilities,
} from '../playtest/capabilities.js';
import type { StudioPlaytestVector } from '../playtest/types.js';

export interface StudioMcpProtocol {
  connect(signal: AbortSignal): Promise<void>;
  listTools(signal: AbortSignal): Promise<unknown>;
  invoke(
    tool: AllowedStudioMcpToolName,
    argumentsValue: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown>;
  close(): Promise<void>;
}

export type StudioMcpProtocolFactory = () => StudioMcpProtocol;

export interface StudioViewportCaptureRequest {
  readonly captureId: string;
}

export interface FixedStudioBridgeProgram {
  readonly source: string;
}

export interface FixedStudioPlaytestProgram {
  readonly source: string;
}

const issuedFixedPrograms = new WeakSet<object>();
const issuedFixedPlaytestPrograms = new WeakSet<object>();
const STUDIO_MCP_CLIENT_CONSTRUCTION_TOKEN = Symbol('worldwright.studioMcp.clientConstruction');

interface StudioMcpClientPrivateOperations {
  readonly invoke: (
    tool: AllowedStudioMcpToolName,
    argumentsValue: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ) => Promise<unknown>;
  readonly invokeText: (
    tool: AllowedStudioMcpToolName,
    argumentsValue: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ) => Promise<string>;
  readonly capabilities: StudioMcpCapabilities;
  readonly playtestCapabilities?: StudioPlaytestMcpCapabilities;
  readonly poison: () => Promise<void>;
}

const studioMcpClientPrivateOperations = new WeakMap<
  StudioMcpClient,
  StudioMcpClientPrivateOperations
>();

/** @internal Called only by the fixed bridge program builders; never export from the package root. */
export function issueFixedStudioBridgeProgram(source: string): FixedStudioBridgeProgram {
  if (source.length === 0 || Buffer.byteLength(source, 'utf8') > STUDIO_MCP_MAX_PAYLOAD_BYTES * 2) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.payload_too_large',
        '/program',
        'The fixed Studio bridge program is empty or exceeds the bounded program size.',
      ),
    ]);
  }
  const program = Object.freeze({ source });
  issuedFixedPrograms.add(program);
  return program;
}

/** @internal Batch programs include their inert request and must fit the existing outer bound. */
export function issueFixedStudioBatchProgram(source: string): FixedStudioBridgeProgram {
  if (source.length === 0 || Buffer.byteLength(source, 'utf8') > STUDIO_MCP_MAX_PAYLOAD_BYTES) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.payload_too_large',
        '/program',
        'The fixed Studio batch program is empty or exceeds the outer payload bound.',
      ),
    ]);
  }
  const program = Object.freeze({ source });
  issuedFixedPrograms.add(program);
  return program;
}

/** @internal Called only by the fixed Server playtest program builder. */
export function issueFixedStudioPlaytestProgram(source: string): FixedStudioPlaytestProgram {
  if (source.length === 0 || Buffer.byteLength(source, 'utf8') > STUDIO_MCP_MAX_PAYLOAD_BYTES * 2) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.payload_too_large',
        '/program',
        'The fixed Studio playtest program is empty or exceeds the bounded program size.',
      ),
    ]);
  }
  const program = Object.freeze({ source });
  issuedFixedPlaytestPrograms.add(program);
  return program;
}

class SdkStudioMcpProtocol implements StudioMcpProtocol {
  readonly #client = new Client({
    name: 'worldwright-studio-mcp-adapter',
    version: STUDIO_MCP_PACKAGE_VERSION,
  });
  readonly #transport: StdioClientTransport;

  public constructor(command: StudioMcpCommand) {
    this.#transport = new StdioClientTransport({
      command: command.command,
      args: [...command.args],
      stderr: 'ignore',
    });
  }

  public async connect(signal: AbortSignal): Promise<void> {
    await this.#client.connect(this.#transport, {
      signal,
      timeout: STUDIO_MCP_STARTUP_TIMEOUT_MS,
    });
  }

  public async listTools(signal: AbortSignal): Promise<unknown> {
    return this.#client.listTools(undefined, {
      signal,
      timeout: STUDIO_MCP_TOOL_TIMEOUT_MS,
    });
  }

  public async invoke(
    tool: AllowedStudioMcpToolName,
    argumentsValue: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    timeoutMs = STUDIO_MCP_TOOL_TIMEOUT_MS,
  ): Promise<unknown> {
    return this.#client.callTool({ name: tool, arguments: { ...argumentsValue } }, undefined, {
      signal,
      timeout: timeoutMs,
    });
  }

  public async close(): Promise<void> {
    let terminationError: unknown;
    try {
      await terminateOwnedWindowsProcessTree(this.#transport.pid);
    } catch (error) {
      terminationError = error;
    }
    try {
      await this.#client.close();
    } catch (error) {
      if (terminationError === undefined) throw error;
    }
    if (terminationError !== undefined) throw terminationError;
  }
}

class BoundedOperationTimeoutError extends Error {
  public constructor() {
    super('Bounded operation timed out.');
    this.name = 'BoundedOperationTimeoutError';
  }
}

/** @internal Signals that a locally started MCP process may still be alive. */
export class StudioMcpTerminationUnprovenError extends StudioAdapterError {
  public constructor(path = '/client') {
    super([
      studioDiagnostic(
        'studio.mcp_start_failed',
        path,
        'The failed Studio MCP process tree could not be proven terminated.',
      ),
    ]);
    this.name = 'StudioMcpTerminationUnprovenError';
  }
}

async function runBounded<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  let timeoutBoundaryFired = false;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timeoutBoundaryFired = true;
      controller.abort();
      reject(new BoundedOperationTimeoutError());
    }, timeoutMs);
    timeout.unref();
  });
  try {
    return await Promise.race([operation(controller.signal), timeoutPromise]);
  } catch (error) {
    if (timeoutBoundaryFired) throw new BoundedOperationTimeoutError();
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function closeFailedProtocol(protocol: StudioMcpProtocol): Promise<void> {
  try {
    await runBounded(STUDIO_MCP_CLOSE_TIMEOUT_MS, () => protocol.close());
  } catch {
    throw new StudioMcpTerminationUnprovenError();
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => isUnsafePresentationCharacter(character));
}

function validateStudioId(studioId: string): void {
  if (
    studioId.length === 0 ||
    studioId.length > 256 ||
    hasControlCharacters(studioId) ||
    containsLocalAbsolutePath(studioId) ||
    studioId.includes('/') ||
    studioId.includes('\\')
  ) {
    throw new StudioAdapterError([
      studioDiagnostic('studio.session_not_found', '/studioId', 'The Studio ID is invalid.'),
    ]);
  }
}

export class StudioMcpClient {
  readonly #protocol: StudioMcpProtocol;
  #closed = false;
  #poisoned = false;
  #terminationProven = false;
  public readonly capabilities: StudioMcpCapabilities;

  /** @internal The unexported construction token restricts this to safe package factories. */
  public constructor(
    token: symbol,
    protocol: StudioMcpProtocol,
    capabilities: StudioMcpCapabilities,
    playtestCapabilities?: StudioPlaytestMcpCapabilities,
  ) {
    if (token !== STUDIO_MCP_CLIENT_CONSTRUCTION_TOKEN) {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.usage_invalid',
          '/client',
          'Studio MCP clients must be created through a safe package factory.',
        ),
      ]);
    }
    this.#protocol = protocol;
    this.capabilities = capabilities;
    studioMcpClientPrivateOperations.set(this, {
      invoke: (tool, argumentsValue, timeoutMs) => this.#invoke(tool, argumentsValue, timeoutMs),
      invokeText: (tool, argumentsValue, timeoutMs) =>
        this.#invokeText(tool, argumentsValue, timeoutMs),
      capabilities,
      ...(playtestCapabilities === undefined ? {} : { playtestCapabilities }),
      poison: () => this.#poison(),
    });
  }

  /** @internal Used only by the exact-session lease and offline tests. */
  public get poisoned(): boolean {
    return this.#poisoned;
  }

  /** @internal Used only by the exact-session lease and offline tests. */
  public get closed(): boolean {
    return this.#closed;
  }

  /** @internal Recovery may replace a poisoned lane only after owned-process termination is proven. */
  public get terminationProven(): boolean {
    return this.#terminationProven;
  }

  async #invokeText(
    tool: AllowedStudioMcpToolName,
    argumentsValue: Readonly<Record<string, unknown>>,
    timeoutMs = STUDIO_MCP_TOOL_TIMEOUT_MS,
  ): Promise<string> {
    const result = await this.#invoke(tool, argumentsValue, timeoutMs);
    try {
      return readStudioMcpTextResult(result, tool).text;
    } catch (error) {
      if (tool === 'execute_luau') await this.#poison();
      throw error;
    }
  }

  async #invoke(
    tool: AllowedStudioMcpToolName,
    argumentsValue: Readonly<Record<string, unknown>>,
    timeoutMs = STUDIO_MCP_TOOL_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.#closed) {
      throw new StudioAdapterError([
        studioDiagnostic('studio.tool_call_failed', '/client', 'The Studio MCP client is closed.', {
          toolName: tool,
        }),
      ]);
    }
    try {
      const boundedTimeoutMs = Math.min(STUDIO_MCP_BATCH_TOOL_TIMEOUT_MS, Math.max(1, timeoutMs));
      return await runBounded(boundedTimeoutMs, (signal) =>
        this.#protocol.invoke(tool, argumentsValue, signal, boundedTimeoutMs),
      );
    } catch (error) {
      const timedOut = error instanceof BoundedOperationTimeoutError;
      if (timedOut || tool === 'execute_luau') {
        // Advisory cancellation cannot prove that Studio stopped a privileged
        // request. Poison and close this transport so transaction verification
        // and compensation cannot report success through the same uncertain lane.
        await this.#poison();
      }
      if (error instanceof StudioAdapterError) throw error;
      throw new StudioAdapterError([
        studioDiagnostic(
          timedOut ? 'studio.tool_timeout' : 'studio.tool_call_failed',
          `/tools/${tool}`,
          timedOut
            ? `Studio tool ${tool} exceeded the bounded call duration.`
            : `${sanitizedErrorMessage(error)} (${tool})`,
          { toolName: tool },
        ),
      ]);
    }
  }

  async #poison(): Promise<void> {
    if (this.#poisoned) {
      if (this.#terminationProven) return;
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.tool_call_failed',
          '/client',
          'The poisoned Studio MCP process tree could not be proven terminated.',
        ),
      ]);
    }
    this.#poisoned = true;
    this.#closed = true;
    try {
      await runBounded(STUDIO_MCP_CLOSE_TIMEOUT_MS, () => this.#protocol.close());
      this.#terminationProven = true;
    } catch {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.tool_call_failed',
          '/client',
          'The poisoned Studio MCP process tree could not be proven terminated.',
        ),
      ]);
    }
  }

  public async listStudioSessionsText(timeoutMs = STUDIO_MCP_TOOL_TIMEOUT_MS): Promise<string> {
    return this.#invokeText('list_roblox_studios', {}, timeoutMs);
  }

  public async selectStudioSessionById(studioId: string): Promise<void> {
    validateStudioId(studioId);
    await this.#invokeText('set_active_studio', { studio_id: studioId });
  }

  public async getStudioStateText(): Promise<string> {
    return this.#invokeText('get_studio_state', {});
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      if (this.#poisoned && !this.#terminationProven) {
        throw new StudioAdapterError([
          studioDiagnostic(
            'studio.tool_call_failed',
            '/client',
            'The poisoned Studio MCP process tree could not be proven terminated.',
          ),
        ]);
      }
      return;
    }
    this.#closed = true;
    try {
      await runBounded(STUDIO_MCP_CLOSE_TIMEOUT_MS, () => this.#protocol.close());
      this.#terminationProven = true;
    } catch (error) {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.mcp_start_failed',
          '/client',
          `The Studio MCP client could not be closed cleanly. ${sanitizedErrorMessage(error)}`,
        ),
      ]);
    }
  }
}

/** @internal Package-private fixed-program executor; not exported from the package root. */
export async function executeFixedStudioBridgeProgram(
  client: StudioMcpClient,
  program: FixedStudioBridgeProgram,
): Promise<string> {
  if (!issuedFixedPrograms.has(program)) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.usage_invalid',
        '/program',
        'Only a fixed Worldwright Studio bridge program may be executed.',
      ),
    ]);
  }
  const operations = studioMcpClientPrivateOperations.get(client);
  if (operations === undefined) {
    throw new StudioAdapterError([
      studioDiagnostic('studio.usage_invalid', '/client', 'The Studio MCP client is invalid.'),
    ]);
  }
  const sourceField = operations.capabilities.executeLuauSourceField;
  return operations.invokeText('execute_luau', {
    [sourceField]: program.source,
    datamodel_type: 'Edit',
  });
}

/** @internal Executes only an issued fixed program with the bounded batch timeout. */
export async function executeFixedStudioBatchProgram(
  client: StudioMcpClient,
  program: FixedStudioBridgeProgram,
): Promise<string> {
  if (!issuedFixedPrograms.has(program)) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.usage_invalid',
        '/program',
        'Only a fixed Worldwright Studio bridge program may be executed.',
      ),
    ]);
  }
  const operations = studioMcpClientPrivateOperations.get(client);
  if (operations === undefined) {
    throw new StudioAdapterError([
      studioDiagnostic('studio.usage_invalid', '/client', 'The Studio MCP client is invalid.'),
    ]);
  }
  const sourceField = operations.capabilities.executeLuauSourceField;
  const argumentsValue = {
    [sourceField]: program.source,
    datamodel_type: 'Edit',
  };
  if (Buffer.byteLength(JSON.stringify(argumentsValue), 'utf8') > STUDIO_MCP_MAX_PAYLOAD_BYTES) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.payload_too_large',
        '/program',
        'The fixed Studio batch program exceeds the outer MCP payload bound.',
      ),
    ]);
  }
  return operations.invokeText('execute_luau', argumentsValue, STUDIO_MCP_BATCH_TOOL_TIMEOUT_MS);
}

function requirePlaytestOperations(client: StudioMcpClient): StudioMcpClientPrivateOperations & {
  readonly playtestCapabilities: StudioPlaytestMcpCapabilities;
} {
  const operations = studioMcpClientPrivateOperations.get(client);
  if (operations?.playtestCapabilities === undefined) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.playtest_capability_unavailable',
        '/client',
        'The Studio MCP client did not complete the playtest capability handshake.',
      ),
    ]);
  }
  return operations as StudioMcpClientPrivateOperations & {
    readonly playtestCapabilities: StudioPlaytestMcpCapabilities;
  };
}

/** @internal Executes only a branded fixed playtest program against the Server data model. */
export async function executeFixedStudioPlaytestProgram(
  client: StudioMcpClient,
  program: FixedStudioPlaytestProgram,
): Promise<string> {
  if (!issuedFixedPlaytestPrograms.has(program)) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.usage_invalid',
        '/program',
        'Only a fixed Worldwright Studio playtest program may be executed.',
      ),
    ]);
  }
  const operations = requirePlaytestOperations(client);
  return operations.invokeText('execute_luau', {
    [operations.playtestCapabilities.executeLuauSourceField]: program.source,
    datamodel_type: 'Server',
  });
}

type StudioPlaytestMutationTool = 'start_stop_play' | 'character_navigation';

function isExactJsonRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return false;
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== keys.length || names.some((name) => !keys.includes(name))) return false;
  return names.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor;
  });
}

function isBoundedConsoleOutput(value: unknown): value is readonly unknown[] {
  return (
    Array.isArray(value) &&
    value.length <= STUDIO_MCP_PLAYTEST_MAX_CONSOLE_ENTRIES &&
    value.every(
      (entry) =>
        isExactJsonRecord(entry, ['message', 'messageType', 'timestamp']) &&
        typeof entry.message === 'string' &&
        Buffer.byteLength(entry.message, 'utf8') <= STUDIO_MCP_PLAYTEST_MAX_CONSOLE_MESSAGE_BYTES &&
        typeof entry.messageType === 'string' &&
        entry.messageType.length > 0 &&
        entry.messageType.length <= 128 &&
        typeof entry.timestamp === 'number' &&
        Number.isFinite(entry.timestamp) &&
        entry.timestamp >= 0,
    )
  );
}

function isExactStartStopAcknowledgment(value: unknown): boolean {
  if (isExactJsonRecord(value, ['success', 'message'])) {
    return (
      value.success === true &&
      (value.message === 'Playtest started in play mode' ||
        value.message === 'Playtest stop signal sent.' ||
        value.message === 'Playtest stopped via StudioTestService.')
    );
  }
  return (
    isExactJsonRecord(value, ['success', 'output', 'outputCount', 'message']) &&
    value.success === true &&
    (value.message === 'Playtest stop signal sent.' ||
      value.message === 'Playtest stopped via StudioTestService.') &&
    isBoundedConsoleOutput(value.output) &&
    typeof value.outputCount === 'number' &&
    Number.isSafeInteger(value.outputCount) &&
    value.outputCount === value.output.length
  );
}

function isExactNavigationAcknowledgment(value: unknown): boolean {
  if (isExactJsonRecord(value, ['success', 'message'])) {
    return value.success === true && value.message === 'Navigation command sent';
  }
  return (
    isExactJsonRecord(value, ['success', 'method', 'position']) &&
    value.success === true &&
    (value.method === 'direct' || value.method === 'pathfinding') &&
    Array.isArray(value.position) &&
    value.position.length === 3 &&
    value.position.every(
      (coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate),
    )
  );
}

function assertExactPlaytestMutationAcknowledgment(
  tool: StudioPlaytestMutationTool,
  text: string,
): void {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    value = undefined;
  }
  const valid =
    tool === 'start_stop_play'
      ? isExactStartStopAcknowledgment(value)
      : isExactNavigationAcknowledgment(value);
  if (!valid) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.response_invalid',
        `/tools/${tool}/content`,
        `Studio tool ${tool} returned an ambiguous mutation acknowledgment.`,
        { toolName: tool },
      ),
    ]);
  }
}

async function invokeUncertainPlaytestAction(
  client: StudioMcpClient,
  tool: StudioPlaytestMutationTool,
  argumentsValue: Readonly<Record<string, unknown>>,
  timeoutMs: number,
): Promise<void> {
  const operations = requirePlaytestOperations(client);
  try {
    const result = await operations.invoke(tool, argumentsValue, timeoutMs);
    const acknowledgment = readStudioMcpTextResult(result, tool);
    assertExactPlaytestMutationAcknowledgment(tool, acknowledgment.text);
  } catch (error) {
    if (!client.poisoned) await operations.poison();
    throw error;
  }
}

/** @internal One non-idempotent Start or Stop acknowledgment; observed state remains authoritative. */
export function invokeStudioPlaytestStartStop(
  client: StudioMcpClient,
  isStart: boolean,
  timeoutMs: number,
): Promise<void> {
  return invokeUncertainPlaytestAction(client, 'start_stop_play', { is_start: isStart }, timeoutMs);
}

/** @internal One non-idempotent Client navigation request to an exact world position. */
export function invokeStudioCharacterNavigation(
  client: StudioMcpClient,
  position: Readonly<StudioPlaytestVector>,
  timeoutMs: number,
): Promise<void> {
  if (![position.x, position.y, position.z].every(Number.isFinite)) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.playtest_probe_invalid',
        '/navigation/position',
        'Studio character navigation requires one finite world position.',
      ),
    ]);
  }
  const operations = requirePlaytestOperations(client);
  return invokeUncertainPlaytestAction(
    client,
    'character_navigation',
    {
      datamodel_type: 'Client',
      x: position.x,
      y: position.y,
      z: position.z,
      speed_multiplier: operations.playtestCapabilities.navigationSpeedMultiplier,
    },
    timeoutMs,
  );
}

/** @internal Raw console text stays inside the bounded sanitizer and ignored live evidence path. */
export async function readStudioConsoleText(client: StudioMcpClient): Promise<string> {
  const operations = requirePlaytestOperations(client);
  return operations.invokeText('get_console_output', {});
}

/** @internal Poison a privileged lane after an untrusted or lost mutation response. */
export function poisonStudioMcpClient(client: StudioMcpClient): Promise<void> {
  const operations = studioMcpClientPrivateOperations.get(client);
  if (operations === undefined) {
    throw new StudioAdapterError([
      studioDiagnostic('studio.usage_invalid', '/client', 'The Studio MCP client is invalid.'),
    ]);
  }
  return operations.poison();
}

/** @internal Package-private capture path; not exported from the package root. */
export async function captureStudioViewport(
  client: StudioMcpClient,
  request: StudioViewportCaptureRequest,
): Promise<StudioMcpImageResult> {
  const operations = studioMcpClientPrivateOperations.get(client);
  if (operations === undefined) {
    throw new StudioAdapterError([
      studioDiagnostic('studio.usage_invalid', '/client', 'The Studio MCP client is invalid.'),
    ]);
  }
  if (!operations.capabilities.optional.screenCapture) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.capture_unavailable',
        '/tools/screen_capture',
        'The connected Studio MCP server does not provide screen_capture.',
        { toolName: 'screen_capture' },
      ),
    ]);
  }
  const requestPrototype =
    typeof request === 'object' && request !== null ? Object.getPrototypeOf(request) : undefined;
  const requestDescriptor =
    typeof request === 'object' && request !== null
      ? Object.getOwnPropertyDescriptor(request, 'captureId')
      : undefined;
  if (
    (requestPrototype !== Object.prototype && requestPrototype !== null) ||
    Object.getOwnPropertySymbols(request).length !== 0 ||
    Object.getOwnPropertyNames(request).some((name) => name !== 'captureId') ||
    requestDescriptor === undefined ||
    !requestDescriptor.enumerable ||
    !('value' in requestDescriptor) ||
    typeof requestDescriptor.value !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(requestDescriptor.value)
  ) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.capture_invalid',
        '/captureId',
        'The capture ID must use only letters, digits, underscores, and hyphens.',
      ),
    ]);
  }
  const argumentsValue: Record<string, unknown> = { capture_id: requestDescriptor.value };
  return readStudioMcpImageResult(
    await operations.invoke('screen_capture', argumentsValue),
    'screen_capture',
  );
}

async function connectStudioMcpWithFactory(
  protocolFactory?: StudioMcpProtocolFactory,
  requirePlaytest = false,
): Promise<StudioMcpClient> {
  let protocol: StudioMcpProtocol | undefined;
  try {
    const createdProtocol =
      protocolFactory?.() ?? new SdkStudioMcpProtocol(resolveDefaultStudioMcpCommand());
    protocol = createdProtocol;
    await runBounded(STUDIO_MCP_STARTUP_TIMEOUT_MS, (signal) => createdProtocol.connect(signal));
  } catch (error) {
    if (protocol !== undefined) await closeFailedProtocol(protocol);
    if (error instanceof StudioAdapterError) throw error;
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.mcp_start_failed',
        '/client',
        error instanceof BoundedOperationTimeoutError
          ? 'The local Studio MCP process did not start within the bounded duration.'
          : sanitizedErrorMessage(error),
      ),
    ]);
  }

  const connectedProtocol = protocol;

  try {
    const toolListResult = await runBounded(STUDIO_MCP_TOOL_TIMEOUT_MS, (signal) =>
      connectedProtocol.listTools(signal),
    );
    const advertisedTools = readStudioMcpToolListEnvelope(toolListResult);
    if (advertisedTools === undefined) {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.mcp_handshake_failed',
          '/tools',
          'Studio returned an invalid tools/list response.',
        ),
      ]);
    }
    const capabilities = discoverStudioMcpCapabilities(advertisedTools);
    const playtestCapabilities = requirePlaytest
      ? discoverStudioPlaytestMcpCapabilities(advertisedTools)
      : undefined;
    return new StudioMcpClient(
      STUDIO_MCP_CLIENT_CONSTRUCTION_TOKEN,
      connectedProtocol,
      capabilities,
      playtestCapabilities,
    );
  } catch (error) {
    await closeFailedProtocol(connectedProtocol);
    if (error instanceof StudioAdapterError) throw error;
    throw new StudioAdapterError([
      studioDiagnostic(
        error instanceof BoundedOperationTimeoutError
          ? 'studio.tool_timeout'
          : 'studio.mcp_handshake_failed',
        '/tools',
        error instanceof BoundedOperationTimeoutError
          ? 'Studio tool discovery exceeded the bounded call duration.'
          : sanitizedErrorMessage(error),
        { toolName: 'tools/list' },
      ),
    ]);
  }
}

/** Connect to the documented local stdio server and complete the required capability handshake. */
export function connectStudioMcp(): Promise<StudioMcpClient> {
  return connectStudioMcpWithFactory();
}

/** @internal Connect and require the additional privileged playtest tool surface. */
export function connectStudioPlaytestMcp(): Promise<StudioMcpClient> {
  return connectStudioMcpWithFactory(undefined, true);
}

/** @internal Exported only from the package testing subpath. */
export function connectStudioMcpForTesting(
  protocolFactory: StudioMcpProtocolFactory,
): Promise<StudioMcpClient> {
  return connectStudioMcpWithFactory(protocolFactory);
}

/** @internal Exported only from the testing subpath. */
export function connectStudioPlaytestMcpForTesting(
  protocolFactory: StudioMcpProtocolFactory,
): Promise<StudioMcpClient> {
  return connectStudioMcpWithFactory(protocolFactory, true);
}
