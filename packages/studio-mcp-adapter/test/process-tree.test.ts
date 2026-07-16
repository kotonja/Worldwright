import { describe, expect, it, vi } from 'vitest';

import {
  terminateOwnedWindowsProcessTree,
  type ProcessTreeTerminationDependencies,
} from '../src/mcp/process-tree.js';

function dependencies(
  overrides: Partial<ProcessTreeTerminationDependencies> = {},
): ProcessTreeTerminationDependencies {
  return {
    platform: 'win32',
    systemRoot: 'C:\\Windows',
    runTaskkill: async () => undefined,
    isProcessAlive: () => false,
    wait: async () => undefined,
    ...overrides,
  };
}

describe('owned Studio MCP process-tree termination', () => {
  it('uses bounded taskkill tree semantics before accepting Windows termination', async () => {
    let alive = true;
    const runTaskkill = vi.fn(async () => {
      alive = false;
    });
    await terminateOwnedWindowsProcessTree(
      1234,
      dependencies({ runTaskkill, isProcessAlive: () => alive }),
    );
    expect(runTaskkill).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\taskkill.exe',
      ['/PID', '1234', '/T', '/F'],
      2_000,
    );
  });

  it('skips absent/non-Windows processes and rejects an unverified live process', async () => {
    const runTaskkill = vi.fn(async () => undefined);
    await terminateOwnedWindowsProcessTree(null, dependencies({ runTaskkill }));
    await terminateOwnedWindowsProcessTree(
      1234,
      dependencies({ platform: 'darwin', runTaskkill, isProcessAlive: () => true }),
    );
    await terminateOwnedWindowsProcessTree(
      1234,
      dependencies({ runTaskkill, isProcessAlive: () => false }),
    );
    expect(runTaskkill).not.toHaveBeenCalled();

    await expect(
      terminateOwnedWindowsProcessTree(
        1234,
        dependencies({ runTaskkill, isProcessAlive: () => true }),
      ),
    ).rejects.toThrow(/did not terminate/u);
  });

  it('rejects unsafe resolution and invalid owned process IDs', async () => {
    await expect(
      terminateOwnedWindowsProcessTree(
        1234,
        dependencies({ systemRoot: 'relative', isProcessAlive: () => true }),
      ),
    ).rejects.toThrow(/resolved safely/u);
    await expect(terminateOwnedWindowsProcessTree(0, dependencies())).rejects.toThrow(
      /process ID is invalid/u,
    );
  });
});
