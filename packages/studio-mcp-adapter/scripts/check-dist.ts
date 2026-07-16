import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const cliUrl = new URL('../dist/cli.js', import.meta.url);
const testingUrl = new URL('../dist/testing.js', import.meta.url);
const cliPath = fileURLToPath(cliUrl);
const courtyardManifestPath = fileURLToPath(
  new URL(
    '../../roblox-compiler/fixtures/manifest/primitive-courtyard.manifest.json',
    import.meta.url,
  ),
);

interface BuiltCliIo {
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

interface BuiltCliModule {
  runStudioMcpCli(args: readonly string[], io: BuiltCliIo, dependencies: unknown): Promise<number>;
}

interface BuiltTestingModule {
  connectStudioMcpForTesting(protocolFactory: () => unknown): Promise<unknown>;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function run(args: readonly string[]): {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  assert(result.signal === null, `Compiled CLI terminated from signal ${result.signal}.`);
  assert(result.status !== null, 'Compiled CLI did not return an exit status.');
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function assertNoStack(value: string): void {
  assert(!/(?:^|\r?\n)\s+at\s/u.test(value), 'Compiled CLI exposed a stack trace.');
}

async function checkDist(): Promise<void> {
  assert((await stat(cliPath)).isFile(), 'Compiled Studio MCP CLI is missing.');

  const help = run(['--help']);
  assert(help.status === 0, `Compiled help exited ${help.status}.`);
  assert(help.stdout.includes('studio-mcp apply'), 'Compiled help omitted commands.');
  assert(help.stderr === '', 'Compiled help wrote to stderr.');

  const usage = run([]);
  assert(usage.status === 2, `Compiled empty usage exited ${usage.status}.`);
  assert(usage.stdout === '', 'Compiled empty usage wrote to stdout.');
  assert(usage.stderr.includes('Usage:'), 'Compiled empty usage omitted the usage summary.');

  const invalid = run(['apply', '--studio-id', 'never-connects']);
  assert(invalid.status === 2, `Compiled invalid apply exited ${invalid.status}.`);
  assert(
    invalid.stderr.includes('studio.usage_invalid'),
    'Compiled invalid apply omitted its stable diagnostic.',
  );
  assertNoStack(
    `${help.stdout}${help.stderr}${usage.stdout}${usage.stderr}${invalid.stdout}${invalid.stderr}`,
  );

  const builtCli = (await import(cliUrl.href)) as unknown as BuiltCliModule;
  const builtTesting = (await import(testingUrl.href)) as unknown as BuiltTestingModule;
  const fakeProtocol = {
    async connect(): Promise<void> {},
    async listTools(): Promise<unknown> {
      return {
        tools: [
          { name: 'list_roblox_studios', inputSchema: { type: 'object', properties: {} } },
          {
            name: 'set_active_studio',
            inputSchema: {
              type: 'object',
              properties: { studio_id: { type: 'string' } },
              required: ['studio_id'],
            },
          },
          { name: 'get_studio_state', inputSchema: { type: 'object', properties: {} } },
          {
            name: 'execute_luau',
            inputSchema: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                datamodel_type: { type: 'string', enum: ['Edit', 'Client', 'Server'] },
              },
              required: ['code', 'datamodel_type'],
            },
          },
        ],
      };
    },
    async invoke(tool: string): Promise<unknown> {
      assert(tool === 'list_roblox_studios', 'Built fake MCP received an unexpected tool call.');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              studios: [{ id: 'dist-studio', name: 'Dist Sandbox', active: true }],
            }),
          },
        ],
      };
    },
    async close(): Promise<void> {},
  };
  const builtProbeOutput = { stdout: '', stderr: '' };
  const builtProbeStatus = await builtCli.runStudioMcpCli(
    ['probe', '--json'],
    {
      writeStdout: (value) => (builtProbeOutput.stdout += value),
      writeStderr: (value) => (builtProbeOutput.stderr += value),
    },
    {
      connectClient: () => builtTesting.connectStudioMcpForTesting(() => fakeProtocol),
      connectSelectedAdapter: async () => {
        throw new Error('Unexpected selected adapter connection.');
      },
      connectReadOnlyAdapter: async () => {
        throw new Error('Unexpected read-only adapter connection.');
      },
    },
  );
  assert(builtProbeStatus === 0, `Built fake-MCP probe exited ${builtProbeStatus}.`);
  assert(builtProbeOutput.stderr === '', 'Built fake-MCP probe wrote to stderr.');
  assert(
    builtProbeOutput.stdout.includes('dist-studio'),
    'Built fake-MCP probe omitted its session.',
  );

  const emptyAdapter = {
    async readSnapshot(): Promise<unknown> {
      return {
        schemaVersion: '0.1.0',
        projectId: 'project-primitive-courtyard',
        target: { service: 'Workspace' },
        nodes: [],
        unmanagedRoots: [],
      };
    },
    async close(): Promise<void> {},
  };
  const builtVerifyOutput = { stdout: '', stderr: '' };
  const builtVerifyStatus = await builtCli.runStudioMcpCli(
    ['verify', '--studio-id', 'dist-studio', '--manifest', courtyardManifestPath, '--json'],
    {
      writeStdout: (value) => (builtVerifyOutput.stdout += value),
      writeStderr: (value) => (builtVerifyOutput.stderr += value),
    },
    {
      connectClient: async () => {
        throw new Error('Unexpected client connection.');
      },
      connectSelectedAdapter: async () => emptyAdapter,
      connectReadOnlyAdapter: async () => emptyAdapter,
    },
  );
  assert(builtVerifyStatus === 1, `Built valid domain mismatch exited ${builtVerifyStatus}.`);
  assert(builtVerifyOutput.stderr === '', 'Built domain mismatch wrote to stderr in JSON mode.');
  assert(builtVerifyOutput.stdout.includes('"matches": false'), 'Built verify omitted mismatch.');
  assertNoStack(
    `${builtProbeOutput.stdout}${builtProbeOutput.stderr}${builtVerifyOutput.stdout}${builtVerifyOutput.stderr}`,
  );
}

try {
  await checkDist();
  process.stdout.write('Compiled Studio MCP adapter CLI smoke check passed.\n');
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Compiled Studio MCP adapter CLI smoke check failed: ${message}\n`);
  process.exitCode = 1;
}
