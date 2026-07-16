import { describe, expect, it } from 'vitest';

import { StudioAdapterError } from '../src/diagnostics.js';
import { resolveDefaultStudioMcpCommand } from '../src/mcp/command.js';

describe('Studio MCP command resolution', () => {
  it('expands LOCALAPPDATA into the exact Windows command chain', () => {
    const command = resolveDefaultStudioMcpCommand({
      platform: 'win32',
      localAppData: 'C:\\Users\\Builder\\AppData\\Local',
    });

    expect(command).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'call', 'C:\\Users\\Builder\\AppData\\Local\\Roblox\\mcp.bat'],
    });
    expect(command.args.join(' ')).not.toContain('%LOCALAPPDATA%');
  });

  it('keeps a LOCALAPPDATA path containing spaces in one quoted child-process argument', () => {
    expect(
      resolveDefaultStudioMcpCommand({
        platform: 'win32',
        localAppData: 'C:\\Users\\Tom Smith\\AppData\\Local',
      }),
    ).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'call', 'C:\\Users\\Tom Smith\\AppData\\Local\\Roblox\\mcp.bat'],
    });
  });

  it('uses the documented macOS executable directly', () => {
    expect(resolveDefaultStudioMcpCommand({ platform: 'darwin' })).toEqual({
      command: '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP',
      args: [],
    });
  });

  it('rejects unsupported platforms and unsafe Windows paths', () => {
    for (const action of [
      () => resolveDefaultStudioMcpCommand({ platform: 'linux' }),
      () =>
        resolveDefaultStudioMcpCommand({
          platform: 'win32',
          localAppData: 'C:\\Local&unexpected',
        }),
      () => resolveDefaultStudioMcpCommand({ platform: 'win32', localAppData: '' }),
    ]) {
      expect(action).toThrow(StudioAdapterError);
      try {
        action();
      } catch (error) {
        expect(error).toMatchObject({
          diagnostics: [{ code: 'studio.mcp_start_failed' }],
        });
      }
    }
  });
});
