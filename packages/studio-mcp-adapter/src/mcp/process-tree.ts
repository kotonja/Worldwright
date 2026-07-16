import { execFile } from 'node:child_process';
import process from 'node:process';
import { win32 } from 'node:path';

import { isUnsafePresentationCharacter } from '../privacy.js';

const WINDOWS_TREE_KILL_TIMEOUT_MS = 2_000;
const WINDOWS_TREE_EXIT_POLL_MS = 25;
const WINDOWS_TREE_EXIT_POLL_ATTEMPTS = 20;

export interface ProcessTreeTerminationDependencies {
  readonly platform: NodeJS.Platform;
  readonly systemRoot: string | undefined;
  readonly runTaskkill: (
    executable: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<void>;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly wait: (milliseconds: number) => Promise<void>;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function runTaskkill(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      { timeout: timeoutMs, windowsHide: true },
      (error: Error | null) => {
        if (error === null) resolve();
        else reject(error);
      },
    );
  });
}

const defaultDependencies: ProcessTreeTerminationDependencies = {
  platform: process.platform,
  systemRoot: process.env['SystemRoot'] ?? process.env['WINDIR'],
  runTaskkill,
  isProcessAlive,
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function resolveTaskkill(systemRoot: string | undefined): string {
  if (
    systemRoot === undefined ||
    !/^[a-zA-Z]:[\\/]/u.test(systemRoot) ||
    [...systemRoot].some((character) => isUnsafePresentationCharacter(character))
  ) {
    throw new Error('The Windows process-tree terminator could not be resolved safely.');
  }
  return win32.join(systemRoot, 'System32', 'taskkill.exe');
}

/** Terminates the SDK-owned Windows shell and its complete child tree before SDK close can orphan it. */
export async function terminateOwnedWindowsProcessTree(
  pid: number | null,
  dependencies: Readonly<ProcessTreeTerminationDependencies> = defaultDependencies,
): Promise<void> {
  if (dependencies.platform !== 'win32' || pid === null) return;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('The owned Studio MCP process ID is invalid.');
  }
  if (!dependencies.isProcessAlive(pid)) return;
  const executable = resolveTaskkill(dependencies.systemRoot);
  try {
    await dependencies.runTaskkill(
      executable,
      ['/PID', String(pid), '/T', '/F'],
      WINDOWS_TREE_KILL_TIMEOUT_MS,
    );
  } catch (error) {
    if (dependencies.isProcessAlive(pid)) throw error;
    return;
  }
  for (let attempt = 0; attempt < WINDOWS_TREE_EXIT_POLL_ATTEMPTS; attempt += 1) {
    if (!dependencies.isProcessAlive(pid)) return;
    await dependencies.wait(WINDOWS_TREE_EXIT_POLL_MS);
  }
  throw new Error('The owned Studio MCP process tree did not terminate within its bound.');
}
