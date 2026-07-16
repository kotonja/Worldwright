import { describe, expect, it } from 'vitest';

import {
  buildStudioTransportReport,
  hashStudioTransportReport,
  stringifyStudioTransportReport,
  validateStudioTransportReport,
} from '../src/transport-report.js';

const changeSetHash = 'a'.repeat(64);

describe('Studio Transport Reports', () => {
  it('normalizes and hashes deterministic applied evidence without private session data', () => {
    const report = buildStudioTransportReport(
      {
        changeSetHash,
        operationsPlanned: 400,
        operationsAttempted: 400,
        operationsAppliedBeforeFailure: 400,
        chunksPlanned: 13,
        chunksAttempted: 13,
        chunksCompleted: 13,
        mutationExecuteCalls: 13,
        uncertainTransportEvents: 0,
        reconnectAttempts: 0,
        reconnectsSucceeded: 0,
        compensationOperationsAttempted: 0,
        compensationOperationsApplied: 0,
        compensationChunksAttempted: 0,
        compensationChunksCompleted: 0,
      },
      'applied',
    );

    expect(validateStudioTransportReport(report)).toEqual({
      valid: true,
      value: report,
      diagnostics: [],
    });
    expect(hashStudioTransportReport(structuredClone(report))).toBe(
      hashStudioTransportReport(report),
    );
    const serialized = stringifyStudioTransportReport(report);
    expect(serialized).not.toContain('studioId');
    expect(serialized).not.toContain('placeName');
    expect(serialized).not.toContain('timestamp');
  });

  it('covers no-op, restored, unsafe, and unrestored outcomes with exact counters', () => {
    for (const [outcome, overrides] of [
      [
        'noop',
        {
          operationsPlanned: 0,
          operationsAttempted: 0,
          chunksPlanned: 0,
          chunksAttempted: 0,
        },
      ],
      [
        'failed-restored',
        { operationsPlanned: 1, operationsAttempted: 1, chunksPlanned: 1, chunksAttempted: 1 },
      ],
      [
        'failed-unsafe',
        { operationsPlanned: 1, operationsAttempted: 1, chunksPlanned: 1, chunksAttempted: 1 },
      ],
      [
        'failed-unrestored',
        { operationsPlanned: 1, operationsAttempted: 0, chunksPlanned: 1, chunksAttempted: 0 },
      ],
    ] as const) {
      const report = buildStudioTransportReport(
        {
          changeSetHash,
          operationsPlanned: overrides.operationsPlanned,
          operationsAttempted: overrides.operationsAttempted,
          operationsAppliedBeforeFailure: 0,
          chunksPlanned: overrides.chunksPlanned,
          chunksAttempted: overrides.chunksAttempted,
          chunksCompleted: 0,
          mutationExecuteCalls: overrides.chunksAttempted,
          uncertainTransportEvents: 0,
          reconnectAttempts: 0,
          reconnectsSucceeded: 0,
          compensationOperationsAttempted: 0,
          compensationOperationsApplied: 0,
          compensationChunksAttempted: 0,
          compensationChunksCompleted: 0,
        },
        outcome,
      );
      expect(report.finalOutcome).toBe(outcome);
    }
  });

  it('rejects unknown fields and contradictory counts', () => {
    const base = buildStudioTransportReport(
      {
        changeSetHash,
        operationsPlanned: 0,
        operationsAttempted: 0,
        operationsAppliedBeforeFailure: 0,
        chunksPlanned: 0,
        chunksAttempted: 0,
        chunksCompleted: 0,
        mutationExecuteCalls: 0,
        uncertainTransportEvents: 0,
        reconnectAttempts: 0,
        reconnectsSucceeded: 0,
        compensationOperationsAttempted: 0,
        compensationOperationsApplied: 0,
        compensationChunksAttempted: 0,
        compensationChunksCompleted: 0,
      },
      'noop',
    );
    expect(validateStudioTransportReport({ ...base, studioId: 'private' }).valid).toBe(false);
    expect(validateStudioTransportReport({ ...base, operationsAttempted: 1 }).valid).toBe(false);
  });

  it('records a final bounded uncertainty after both reconnect opportunities are consumed', () => {
    const report = buildStudioTransportReport(
      {
        changeSetHash,
        operationsPlanned: 1,
        operationsAttempted: 1,
        operationsAppliedBeforeFailure: 1,
        chunksPlanned: 1,
        chunksAttempted: 1,
        chunksCompleted: 0,
        mutationExecuteCalls: 3,
        uncertainTransportEvents: 3,
        reconnectAttempts: 2,
        reconnectsSucceeded: 2,
        compensationOperationsAttempted: 2,
        compensationOperationsApplied: 0,
        compensationChunksAttempted: 2,
        compensationChunksCompleted: 0,
      },
      'failed-unrestored',
    );
    expect(validateStudioTransportReport(report)).toMatchObject({ valid: true });
  });

  it('keeps response-completion counts separate from authoritative observed progress', () => {
    const report = buildStudioTransportReport(
      {
        changeSetHash,
        operationsPlanned: 64,
        operationsAttempted: 64,
        operationsAppliedBeforeFailure: 0,
        chunksPlanned: 2,
        chunksAttempted: 2,
        chunksCompleted: 1,
        mutationExecuteCalls: 2,
        uncertainTransportEvents: 1,
        reconnectAttempts: 1,
        reconnectsSucceeded: 1,
        compensationOperationsAttempted: 0,
        compensationOperationsApplied: 0,
        compensationChunksAttempted: 0,
        compensationChunksCompleted: 0,
      },
      'failed-restored',
    );
    expect(validateStudioTransportReport(report)).toMatchObject({ valid: true });
  });

  it('represents the formal maximum compensation retry counters', () => {
    const report = buildStudioTransportReport(
      {
        changeSetHash,
        operationsPlanned: 512,
        operationsAttempted: 512,
        operationsAppliedBeforeFailure: 512,
        chunksPlanned: 512,
        chunksAttempted: 512,
        chunksCompleted: 512,
        mutationExecuteCalls: 1_056,
        uncertainTransportEvents: 3,
        reconnectAttempts: 2,
        reconnectsSucceeded: 2,
        compensationOperationsAttempted: 544,
        compensationOperationsApplied: 544,
        compensationChunksAttempted: 544,
        compensationChunksCompleted: 512,
      },
      'failed-unrestored',
    );
    expect(validateStudioTransportReport(report)).toMatchObject({ valid: true });
  });

  it('rejects successful recovery activity and unsafe compensation contradictions', () => {
    const applied = buildStudioTransportReport(
      {
        changeSetHash,
        operationsPlanned: 1,
        operationsAttempted: 1,
        operationsAppliedBeforeFailure: 1,
        chunksPlanned: 1,
        chunksAttempted: 1,
        chunksCompleted: 1,
        mutationExecuteCalls: 1,
        uncertainTransportEvents: 0,
        reconnectAttempts: 0,
        reconnectsSucceeded: 0,
        compensationOperationsAttempted: 0,
        compensationOperationsApplied: 0,
        compensationChunksAttempted: 0,
        compensationChunksCompleted: 0,
      },
      'applied',
    );
    expect(validateStudioTransportReport({ ...applied, uncertainTransportEvents: 1 }).valid).toBe(
      false,
    );
    for (const impossibleChunks of [0, 12, 401]) {
      expect(
        validateStudioTransportReport({
          ...applied,
          operationsPlanned: 400,
          operationsAttempted: 400,
          operationsAppliedBeforeFailure: 400,
          chunksPlanned: impossibleChunks,
          chunksAttempted: impossibleChunks,
          chunksCompleted: impossibleChunks,
          mutationExecuteCalls: impossibleChunks,
        }).valid,
      ).toBe(false);
    }
    for (const contradiction of [
      { ...applied, operationsAttempted: 1, chunksAttempted: 0, mutationExecuteCalls: 0 },
      {
        ...applied,
        finalOutcome: 'failed-unrestored' as const,
        compensationOperationsAttempted: 1,
      },
      {
        ...applied,
        finalOutcome: 'failed-unrestored' as const,
        compensationChunksCompleted: 1,
        compensationChunksAttempted: 1,
        mutationExecuteCalls: 2,
      },
      {
        ...applied,
        finalOutcome: 'failed-restored' as const,
        operationsPlanned: 0,
        operationsAttempted: 0,
        operationsAppliedBeforeFailure: 0,
        chunksPlanned: 0,
        chunksAttempted: 0,
        chunksCompleted: 0,
        mutationExecuteCalls: 0,
      },
    ]) {
      expect(validateStudioTransportReport(contradiction).valid).toBe(false);
    }
    expect(
      validateStudioTransportReport({
        ...applied,
        finalOutcome: 'failed-unsafe',
        operationsAppliedBeforeFailure: 0,
        chunksAttempted: 0,
        chunksCompleted: 0,
        compensationOperationsAttempted: 1,
        compensationChunksAttempted: 1,
      }).valid,
    ).toBe(false);
  });
});
