import { describe, expect, it } from 'vitest';

import { evaluatePlaytestRun } from '../src/critic/evaluate.js';
import { hashCriticReport, stringifyCriticReport } from '../src/critic/hashing.js';
import { validateCriticReport, validateCriticReportAgainstInputs } from '../src/critic/validate.js';
import {
  validatePlaytestRunReport,
  validatePlaytestRunReportAgainstPlan,
} from '../src/run/validate.js';
import { clone, readCriticFixture, readPlanFixture, readRunFixture } from './helpers.js';

describe('Run Report validation and pure Critic evaluation', () => {
  it('validates and deterministically evaluates the clean pass fixture', async () => {
    const [plan, run, committed] = await Promise.all([
      readPlanFixture(),
      readRunFixture(),
      readCriticFixture(),
    ]);
    expect(validatePlaytestRunReportAgainstPlan(plan, run).valid).toBe(true);
    const result = evaluatePlaytestRun(plan, run);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.value.status).toBe('pass');
    expect(result.value.findings).toEqual([]);
    expect(stringifyCriticReport(result.value)).toBe(stringifyCriticReport(committed));
    expect(hashCriticReport(result.value)).toBe(hashCriticReport(committed));
    expect(validateCriticReportAgainstInputs(plan, run, committed).valid).toBe(true);
  });

  it.each([
    ['blocked-door', 'critic.path_not_successful'],
    ['stair-failure', 'critic.stair_not_traversed'],
    ['console-error', 'critic.console_error_new'],
  ])('evaluates %s as fail with %s', async (name, code) => {
    const [plan, run] = await Promise.all([readPlanFixture(), readRunFixture(name)]);
    const result = evaluatePlaytestRun(plan, run);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.value.status).toBe('fail');
    expect(result.value.findings.some((finding) => finding.code === code)).toBe(true);
  });

  it('rejects fabricated run coverage and caller-altered fixed finding metadata', async () => {
    const [plan, run, critic, consoleCritic] = await Promise.all([
      readPlanFixture(),
      readRunFixture(),
      readCriticFixture(),
      readCriticFixture('console-error'),
    ]);
    const fabricated = clone(run);
    fabricated.coverage.reachedRoomCount -= 1;
    expect(validatePlaytestRunReportAgainstPlan(plan, fabricated).valid).toBe(false);
    const altered = clone(critic);
    altered.findings = [
      {
        id: 'critic-finding-altered',
        code: 'critic.console_warning_new',
        severity: 'error',
        category: 'console',
        message: 'Caller prose.',
        relatedSourceIds: [],
        relatedCheckpointIds: [],
        relatedSegmentIds: [],
        evidenceIds: [],
        suggestionCode: 'inspect-console-error',
      },
    ];
    altered.status = 'fail';
    expect(validateCriticReport(altered).valid).toBe(false);
    const forgedId = clone(consoleCritic);
    forgedId.findings[0]!.id = 'critic-finding-00000000000000000000';
    expect(validateCriticReport(forgedId).valid).toBe(false);
  });

  it('rejects adversarial non-JSON values at every public report boundary', async () => {
    const run = await readRunFixture();
    const date = clone(run) as unknown as Record<string, unknown>;
    date['extra'] = new Date();
    expect(validatePlaytestRunReport(date).valid).toBe(false);
    const cyclic = clone(run) as unknown as Record<string, unknown>;
    cyclic['cycle'] = cyclic;
    expect(validatePlaytestRunReport(cyclic).valid).toBe(false);
    const critic = await readCriticFixture();
    const functionValue = clone(critic) as unknown as Record<string, unknown>;
    functionValue['call'] = (): void => undefined;
    expect(validateCriticReport(functionValue).valid).toBe(false);
  });
});
