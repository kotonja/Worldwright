import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { ArchitecturePlan } from '@worldwright/architecture-planner';
import type { RobloxManifest } from '@worldwright/roblox-compiler';

import type { CriticReport } from '../src/critic/contract-schema.js';
import type { PlaytestPlan } from '../src/plan/contract-schema.js';
import type { PlaytestRunReport } from '../src/run/contract-schema.js';

export async function readJson<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(fileURLToPath(url), 'utf8')) as T;
}

export async function readArchitectureInputs(): Promise<{
  readonly architecturePlan: ArchitecturePlan;
  readonly manifest: RobloxManifest;
}> {
  const [architecturePlan, manifest] = await Promise.all([
    readJson<ArchitecturePlan>(
      new URL(
        '../../architecture-planner/fixtures/plans/cliffwatch-mansion.architecture-plan.json',
        import.meta.url,
      ),
    ),
    readJson<RobloxManifest>(
      new URL(
        '../../architecture-planner/fixtures/manifest/cliffwatch-mansion-blockout.manifest.json',
        import.meta.url,
      ),
    ),
  ]);
  return { architecturePlan, manifest };
}

export async function readPlanFixture(): Promise<PlaytestPlan> {
  return readJson(new URL('../fixtures/plans/cliffwatch.playtest-plan.json', import.meta.url));
}

export async function readRunFixture(name = 'cliffwatch-pass'): Promise<PlaytestRunReport> {
  return readJson(new URL(`../fixtures/run-reports/${name}.playtest-run.json`, import.meta.url));
}

export async function readCriticFixture(name = 'cliffwatch-pass'): Promise<CriticReport> {
  return readJson(new URL(`../fixtures/critic-reports/${name}.critic.json`, import.meta.url));
}

export function clone<T>(value: Readonly<T>): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
