import { describe, expect, it } from 'vitest';

import { PLAYTEST_AGENT_PROFILE, PLAYTEST_LIMITS } from '../src/constants.js';
import { CriticReportSchema } from '../src/critic/contract-schema.js';
import { CRITIC_RULES } from '../src/critic/rules.js';
import { PlaytestPlanSchema } from '../src/plan/contract-schema.js';
import { PlaytestRunReportSchema } from '../src/run/contract-schema.js';

import { checkPlaytestCriticFixtures } from '../scripts/check-fixtures.js';
import { checkPlaytestCriticSchemas } from '../scripts/check-schemas.js';
import { validateCriticReport } from '../src/critic/validate.js';
import { validatePlaytestPlan } from '../src/plan/validate.js';
import { validatePlaytestRunReport } from '../src/run/validate.js';
import { readCriticFixture, readPlanFixture, readRunFixture } from './helpers.js';

function recursivelyFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value !== 'object' || value === null || seen.has(value)) return true;
  seen.add(value);
  return (
    Object.isFrozen(value) &&
    Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor === undefined ||
        !('value' in descriptor) ||
        recursivelyFrozen(descriptor.value, seen)
      );
    })
  );
}

describe('generated contracts and fixtures', () => {
  it('deep-freezes the exported fixed profiles, limits, and rule registry', () => {
    expect(Object.isFrozen(PLAYTEST_AGENT_PROFILE)).toBe(true);
    expect(Object.isFrozen(PLAYTEST_LIMITS)).toBe(true);
    expect(Object.isFrozen(CRITIC_RULES)).toBe(true);
    expect(Object.values(CRITIC_RULES).every((rule) => Object.isFrozen(rule))).toBe(true);
    expect(recursivelyFrozen(PlaytestPlanSchema)).toBe(true);
    expect(recursivelyFrozen(PlaytestRunReportSchema)).toBe(true);
    expect(recursivelyFrozen(CriticReportSchema)).toBe(true);
  });
  it('keeps generated JSON Schemas current', async () => {
    expect(await checkPlaytestCriticSchemas()).toBe(true);
  });

  it('keeps all deterministic scenario fixtures current', async () => {
    expect(await checkPlaytestCriticFixtures()).toBe(true);
  });

  it('validates all three committed contract kinds', async () => {
    const [plan, run, critic] = await Promise.all([
      readPlanFixture(),
      readRunFixture(),
      readCriticFixture(),
    ]);
    expect(validatePlaytestPlan(plan).valid).toBe(true);
    expect(validatePlaytestRunReport(run).valid).toBe(true);
    expect(validateCriticReport(critic).valid).toBe(true);
  });
});
