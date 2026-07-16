import { classifyRobloxChangeSetProgress, planRobloxChangeSet } from '@worldwright/roblox-compiler';
import { describe, expect, it } from 'vitest';

import {
  buildStudioProgressReport,
  hashStudioProgressReport,
  validateStudioProgressReport,
} from '../src/progress-report.js';
import { emptySnapshot, loadCourtyardManifest } from './helpers.js';

describe('Studio Progress Reports', () => {
  it('records deterministic base and unsafe classifications without Studio identity', () => {
    const manifest = loadCourtyardManifest();
    const base = emptySnapshot(manifest);
    const plan = planRobloxChangeSet(base, manifest);
    if (!plan.success) throw new Error('Fixture planning failed.');

    const baseReport = buildStudioProgressReport(
      classifyRobloxChangeSetProgress(base, base, plan.changeSet),
    );
    expect(baseReport).toMatchObject({
      classification: 'base',
      appliedPrefixLength: 0,
      operationsTotal: manifest.nodes.length,
    });
    expect(validateStudioProgressReport(baseReport).valid).toBe(true);
    expect(hashStudioProgressReport(structuredClone(baseReport))).toBe(
      hashStudioProgressReport(baseReport),
    );
    expect(JSON.stringify(baseReport)).not.toContain('studioId');

    const unsafeReport = buildStudioProgressReport(
      classifyRobloxChangeSetProgress(
        base,
        { ...base, unmanagedRoots: [{ parentEntityId: 'missing' }] },
        plan.changeSet,
      ),
    );
    expect(unsafeReport.classification).toBe('unsafe');
    expect(validateStudioProgressReport(unsafeReport).valid).toBe(true);
  });

  it('rejects unknown report fields', () => {
    expect(
      validateStudioProgressReport({
        schemaVersion: '0.1.0',
        classification: 'unsafe',
        diagnostics: [
          {
            code: 'progress.not_exact_prefix',
            severity: 'error',
            path: '',
            message: 'Unsafe.',
          },
        ],
        studioId: 'private',
      }).valid,
    ).toBe(false);
  });

  it('rejects contradictory classifications, prefix lengths, and next-operation evidence', () => {
    const manifest = loadCourtyardManifest();
    const base = emptySnapshot(manifest);
    const plan = planRobloxChangeSet(base, manifest);
    if (!plan.success) throw new Error('Fixture planning failed.');
    const report = buildStudioProgressReport(
      classifyRobloxChangeSetProgress(base, base, plan.changeSet),
    );
    if (report.classification !== 'base' || report.nextOperationId === undefined) {
      throw new Error('Expected a nonempty base progress report.');
    }
    const withoutNext = {
      schemaVersion: report.schemaVersion,
      classification: report.classification,
      projectId: report.projectId,
      target: report.target,
      baseSnapshotHash: report.baseSnapshotHash,
      observedSnapshotHash: report.observedSnapshotHash,
      changeSetHash: report.changeSetHash,
      operationsTotal: report.operationsTotal,
      appliedPrefixLength: report.appliedPrefixLength,
    };
    for (const contradictory of [
      { ...report, appliedPrefixLength: 1 },
      { ...report, observedSnapshotHash: 'f'.repeat(64) },
      withoutNext,
      { ...report, classification: 'prefix', appliedPrefixLength: 0 },
      {
        ...report,
        classification: 'prefix',
        appliedPrefixLength: report.operationsTotal,
      },
      {
        ...withoutNext,
        classification: 'complete',
        appliedPrefixLength: 0,
      },
    ]) {
      expect(validateStudioProgressReport(contradictory).valid).toBe(false);
    }
  });
});
