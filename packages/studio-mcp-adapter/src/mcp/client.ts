import { Buffer } from 'node:buffer';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  STUDIO_MCP_CLOSE_TIMEOUT_MS,
  STUDIO_MCP_MAX_PAYLOAD_BYTES,
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

export interface StudioMcpProtocol {
  connect(signal: AbortSignal): Promise<void>;
  listTools(signal: AbortSignal): Promise<unknown>;
  invoke(
    tool: AllowedStudioMcpToolName,
    argumentsValue: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
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

const issuedFixedPrograms = new WeakSet<object>();
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

class SdkStudioMcpProtocol implements StudioMcpProtocol {
  readonly #client = new Client({ name: 'worldwright-studio-mcp-adapter', version: '0.1.0' });
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
  ): Promise<unknown> {
    return this.#client.callTool({ name: tool, arguments: { ...argumentsValue } }, undefined, {
      signal,
      timeout: STUDIO_MCP_TOOL_TIMEOUT_MS,
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

async function closeQuietly(protocol: StudioMcpProtocol): Promise<void> {
  try {
    await runBounded(STUDIO_MCP_CLOSE_TIMEOUT_MS, () => protocol.close());
  } catch {
    // Preserve the original stable connection or handshake diagnostic.
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
  public readonly capabilities: StudioMcpCapabilities;

  /** @internal The unexported construction token restricts this to safe package factories. */
  public constructor(
    token: symbol,
    protocol: StudioMcpProtocol,
    capabilities: StudioMcpCapabilities,
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
    });
  }

  async #invokeText(
    tool: AllowedStudioMcpToolName,
    argumentsValue: Readonly<Record<string, unknown>>,
    timeoutMs = STUDIO_MCP_TOOL_TIMEOUT_MS,
  ): Promise<string> {
    const result = await this.#invoke(tool, argumentsValue, timeoutMs);
    return readStudioMcpTextResult(result, tool).text;
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
      return await runBounded(
        Math.min(STUDIO_MCP_TOOL_TIMEOUT_MS, Math.max(1, timeoutMs)),
        (signal) => this.#protocol.invoke(tool, argumentsValue, signal),
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
    if (this.#closed) return;
    this.#closed = true;
    await closeQuietly(this.#protocol);
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
    if (this.#closed) return;
    this.#closed = true;
    try {
      await runBounded(STUDIO_MCP_CLOSE_TIMEOUT_MS, () => this.#protocol.close());
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
): Promise<StudioMcpClient> {
  let protocol: StudioMcpProtocol | undefined;
  try {
    const createdProtocol =
      protocolFactory?.() ?? new SdkStudioMcpProtocol(resolveDefaultStudioMcpCommand());
    protocol = createdProtocol;
    await runBounded(STUDIO_MCP_STARTUP_TIMEOUT_MS, (signal) => createdProtocol.connect(signal));
  } catch (error) {
    if (protocol !== undefined) await closeQuietly(protocol);
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
    return new StudioMcpClient(
      STUDIO_MCP_CLIENT_CONSTRUCTION_TOKEN,
      connectedProtocol,
      capabilities,
    );
  } catch (error) {
    await closeQuietly(connectedProtocol);
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

/** @internal Exported only from the package testing subpath. */
export function connectStudioMcpForTesting(
  protocolFactory: StudioMcpProtocolFactory,
): Promise<StudioMcpClient> {
  return connectStudioMcpWithFactory(protocolFactory);
}
