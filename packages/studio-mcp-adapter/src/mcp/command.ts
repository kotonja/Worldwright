import path from 'node:path';

import { StudioAdapterError, studioDiagnostic } from '../diagnostics.js';
import { isUnsafePresentationCharacter } from '../privacy.js';

export interface StudioMcpCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface StudioMcpCommandEnvironment {
  readonly platform?: NodeJS.Platform;
  readonly localAppData?: string;
}

const WINDOWS_CMD_UNSAFE_PATH_CHARACTERS = /["%&|<>^!()]/u;

function hasUnsafeWindowsCommandPathCharacters(value: string): boolean {
  return (
    WINDOWS_CMD_UNSAFE_PATH_CHARACTERS.test(value) ||
    [...value].some((character) => isUnsafePresentationCharacter(character))
  );
}

function commandResolutionError(message: string): StudioAdapterError {
  return new StudioAdapterError([studioDiagnostic('studio.mcp_start_failed', '/command', message)]);
}

function resolveWindowsCommand(localAppData: string | undefined): StudioMcpCommand {
  if (localAppData === undefined || localAppData.trim().length === 0) {
    throw commandResolutionError(
      'The local Roblox Studio MCP command could not be resolved on Windows.',
    );
  }
  if (!path.win32.isAbsolute(localAppData) || hasUnsafeWindowsCommandPathCharacters(localAppData)) {
    throw commandResolutionError(
      'The local Roblox Studio MCP command path is not safe to execute.',
    );
  }

  const mcpBatchFile = path.win32.join(localAppData, 'Roblox', 'mcp.bat');
  return Object.freeze({
    command: 'cmd.exe',
    // Passing `call` and the batch path as separate argv values lets Node quote
    // paths containing spaces without enabling shell interpolation.
    args: Object.freeze(['/d', '/s', '/c', 'call', mcpBatchFile]),
  });
}

/** Resolve the documented local Studio MCP executable without invoking a shell search. */
export function resolveDefaultStudioMcpCommand(
  environment: StudioMcpCommandEnvironment = {},
): StudioMcpCommand {
  const platform = environment.platform ?? process.platform;
  if (platform === 'win32') {
    return resolveWindowsCommand(environment.localAppData ?? process.env.LOCALAPPDATA);
  }
  if (platform === 'darwin') {
    return Object.freeze({
      command: '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP',
      args: Object.freeze([]),
    });
  }
  throw commandResolutionError('Roblox Studio MCP is supported only on Windows and macOS.');
}
