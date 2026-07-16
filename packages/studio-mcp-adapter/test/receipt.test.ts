import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { ApplyResult } from '@worldwright/roblox-compiler';

import { hashStudioApplyReceipt } from '../src/hashing.js';
import { stringifyStudioApplyReceipt } from '../src/normalize.js';
import { buildStudioApplyReceipt } from '../src/receipt.js';
import type { StudioReceiptContext } from '../src/types.js';
import { validateStudioApplyReceipt } from '../src/validate.js';
import { renderStudioReceiptFixtures } from '../scripts/generate-fixtures.js';

const hashes = {
  change: 'a'.repeat(64),
  base: 'b'.repeat(64),
  desired: 'c'.repeat(64),
  expected: 'd'.repeat(64),
  failure: 'e'.repeat(64),
} as const;

function context(): StudioReceiptContext {
  return {
    studio: { studioId: 'fixture-studio', placeName: 'Fixture Sandbox', placeId: 0, gameId: 0 },
    projectId: 'fixture-project',
    target: { service: 'Workspace' },
    changeSetHash: hashes.change,
    baseSnapshotHash: hashes.base,
    desiredManifestHash: hashes.desired,
    expectedResultSnapshotHash: hashes.expected,
    operationsPlanned: 2,
  };
}

function success(status: 'applied' | 'noop'): ApplyResult {
  return {
    success: true,
    status,
    snapshot: {
      schemaVersion: '0.1.0',
      projectId: 'fixture-project',
      target: { service: 'Workspace' },
      nodes: [],
      unmanagedRoots: [],
    },
    diagnostics: [],
    operationsAttempted: status === 'noop' ? 0 : 2,
    initialSnapshotHash: hashes.base,
    finalSnapshotHash: status === 'noop' ? hashes.base : hashes.expected,
  };
}

describe('Studio Apply Receipts', () => {
  it('builds strict deterministic applied and no-op receipts without mutating inputs', () => {
    const receiptContext = context();
    const result = success('applied');
    const before = JSON.stringify({ receiptContext, result });
    const first = buildStudioApplyReceipt(receiptContext, result);
    const second = buildStudioApplyReceipt(receiptContext, result);
    expect(JSON.stringify({ receiptContext, result })).toBe(before);
    expect(validateStudioApplyReceipt(first).valid).toBe(true);
    expect(stringifyStudioApplyReceipt(second)).toBe(stringifyStudioApplyReceipt(first));
    expect(hashStudioApplyReceipt(second)).toBe(hashStudioApplyReceipt(first));
    expect(first).not.toHaveProperty('timestamp');
    expect(first).not.toHaveProperty('studioId');

    const noop = buildStudioApplyReceipt(
      {
        ...receiptContext,
        operationsPlanned: 0,
        expectedResultSnapshotHash: hashes.base,
      },
      success('noop'),
    );
    expect(noop.status).toBe('noop');
    expect(noop.operationsAttempted).toBe(0);
    expect(validateStudioApplyReceipt(noop).valid).toBe(true);
  });

  it('rejects receipt contexts outside the exact unsaved Workspace sandbox', () => {
    for (const invalidContext of [
      { ...context(), studio: { ...context().studio, placeId: 42 } },
      { ...context(), studio: { ...context().studio, gameId: 42 } },
      { ...context(), target: { service: 'ReplicatedStorage' } },
      { ...context(), target: { service: 'Workspace', extra: true } },
    ]) {
      expect(() =>
        buildStudioApplyReceipt(invalidContext as StudioReceiptContext, success('applied')),
      ).toThrowError(
        expect.objectContaining({
          diagnostics: [expect.objectContaining({ code: 'studio.receipt_invalid' })],
        }),
      );
    }
  });

  it('accepts only exact JPEG viewport evidence in the receipt contract', () => {
    const receipt = buildStudioApplyReceipt(
      {
        ...context(),
        viewportEvidence: {
          mediaType: 'image/jpeg',
          sha256: hashes.failure,
          byteLength: 191_339,
        },
      },
      success('applied'),
    );
    expect(validateStudioApplyReceipt(receipt).valid).toBe(true);
    expect(
      validateStudioApplyReceipt({
        ...receipt,
        viewportEvidence: { ...receipt.viewportEvidence, mediaType: 'image/png' },
      }).valid,
    ).toBe(false);
  });

  it('rejects contradictory outcomes and retains bounded rollback diagnostics beyond operations', () => {
    const applied = buildStudioApplyReceipt(context(), success('applied'));
    expect(validateStudioApplyReceipt({ ...applied, operationsAttempted: 1 }).valid).toBe(false);

    const noop = buildStudioApplyReceipt(
      { ...context(), operationsPlanned: 0, expectedResultSnapshotHash: hashes.base },
      success('noop'),
    );
    expect(validateStudioApplyReceipt({ ...noop, operationsPlanned: 1 }).valid).toBe(false);

    const failure: ApplyResult = {
      success: false,
      stage: 'apply',
      diagnostics: [
        {
          code: 'transaction.apply_failed',
          severity: 'error',
          path: '',
          message: 'Forward operation failed.',
        },
      ],
      operationsAttempted: 1,
      rollback: {
        attempted: true,
        succeeded: false,
        diagnostics: Array.from({ length: 513 }, (_, index) => ({
          code: 'transaction.rollback_unsafe_observed_state',
          severity: 'error' as const,
          path: `/nodes/${String(index)}`,
          message: 'Observed state is outside the rollback envelope.',
        })),
      },
      initialSnapshotHash: hashes.base,
      observedFailureSnapshotHash: hashes.failure,
    };
    const failedReceipt = buildStudioApplyReceipt(context(), failure);
    expect(failedReceipt.status).toBe('failed');
    if (
      failedReceipt.status !== 'failed' ||
      !failedReceipt.rollback.attempted ||
      failedReceipt.rollback.succeeded
    ) {
      throw new Error('Expected failed receipt with unsuccessful rollback.');
    }
    expect(failedReceipt.rollback.diagnostics).toHaveLength(513);
    expect(validateStudioApplyReceipt(failedReceipt).valid).toBe(true);

    const compensated = buildStudioApplyReceipt(context(), {
      ...failure,
      rollback: { attempted: true, succeeded: true, restoredSnapshotHash: hashes.base },
    });
    expect(
      validateStudioApplyReceipt({ ...compensated, finalSnapshotHash: hashes.expected }).valid,
    ).toBe(false);
  });

  it('records verified compensation and sanitizes local paths from diagnostics', () => {
    const failure: ApplyResult = {
      success: false,
      stage: 'verification',
      diagnostics: [
        {
          code: 'transaction.verification_failed',
          severity: 'error',
          path: 'C:\\Users\\private\\source.ts',
          message: 'Failure at C:\\Users\\Tom Smith\\private\\raw.log secret-tail',
        },
        {
          code: 'transaction.verification_failed',
          severity: 'warning',
          path: 'C:\\Users\\private\\source.ts',
          message: 'Failure at C:\\Users\\Tom Smith\\private\\raw.log secret-tail',
        },
      ],
      operationsAttempted: 1,
      rollback: { attempted: true, succeeded: true, restoredSnapshotHash: hashes.base },
      initialSnapshotHash: hashes.base,
      observedFailureSnapshotHash: hashes.failure,
    };
    const receipt = buildStudioApplyReceipt(context(), failure);
    expect(receipt).toMatchObject({
      status: 'failed',
      transactionStage: 'verification',
      rollback: { attempted: true, succeeded: true, restoredSnapshotHash: hashes.base },
      finalSnapshotHash: hashes.base,
    });
    expect(JSON.stringify(receipt)).not.toContain('Users');
    expect(JSON.stringify(receipt)).not.toContain('Smith');
    expect(JSON.stringify(receipt)).not.toContain('secret-tail');
    expect(JSON.stringify(receipt)).not.toContain('\u009b');
    expect(validateStudioApplyReceipt(receipt).valid).toBe(true);
    const reversed = buildStudioApplyReceipt(context(), {
      ...failure,
      diagnostics: [...failure.diagnostics].reverse(),
    });
    expect(stringifyStudioApplyReceipt(reversed)).toBe(stringifyStudioApplyReceipt(receipt));
    expect(
      validateStudioApplyReceipt({
        ...receipt,
        diagnostics: [
          {
            code: 'transaction.verification_failed',
            severity: 'error',
            path: '/tmp/private.log',
            message: 'Failure',
          },
        ],
      }).valid,
    ).toBe(false);
  });

  it('redacts generic absolute paths and Unicode format controls from receipt text', () => {
    const receipt = buildStudioApplyReceipt(
      {
        ...context(),
        studio: {
          studioId: 'fixture-studio',
          placeName: 'Sandbox\u202e Name at \\Users\\tommy\\secret.rbxl',
          placeId: 0,
          gameId: 0,
        },
      },
      {
        success: false,
        stage: 'apply',
        diagnostics: [
          {
            code: 'transaction.apply_failed',
            severity: 'error',
            path: 'C:\\workspace\\company\\private.log',
            message:
              'Failure at C\u200b:\\Users\\private\\raw.log\u202e hidden sandbox=/Developer/tommy/private.rbxl',
          },
        ],
        operationsAttempted: 1,
        rollback: { attempted: false, succeeded: false },
        initialSnapshotHash: hashes.base,
      },
    );
    const serialized = stringifyStudioApplyReceipt(receipt);
    expect(serialized).not.toContain('workspace');
    expect(serialized).not.toContain('company');
    expect(serialized).not.toContain('hidden');
    expect(serialized).not.toContain('Developer');
    expect(serialized).not.toContain('secret.rbxl');
    expect(serialized).not.toContain('\u202e');
    expect(receipt.diagnostics[0]?.path).toBe('');
    expect(validateStudioApplyReceipt(receipt).valid).toBe(true);
  });

  it('rejects terminal controls inside diagnostic JSON Pointers', () => {
    for (const unsafePath of [
      '/operations/\u001b[31m',
      '/operations/\u202e0',
      '/nodes/C:~1Users~1tommy~1secret.rbxl',
    ]) {
      const receipt = buildStudioApplyReceipt(context(), {
        success: false,
        stage: 'apply',
        diagnostics: [
          {
            code: 'transaction.apply_failed',
            severity: 'error',
            path: unsafePath,
            message: 'Failure',
          },
        ],
        operationsAttempted: 0,
        rollback: { attempted: false, succeeded: false },
        initialSnapshotHash: hashes.base,
      });
      expect(receipt.diagnostics[0]?.path).toBe('');
      expect(validateStudioApplyReceipt(receipt).valid).toBe(true);
      expect(
        validateStudioApplyReceipt({
          ...receipt,
          diagnostics: [{ ...receipt.diagnostics[0]!, path: unsafePath }],
        }).valid,
      ).toBe(false);
    }
  });

  it('preserves bounded compiler JSON Pointer locations', () => {
    const receipt = buildStudioApplyReceipt(context(), {
      success: false,
      stage: 'apply',
      diagnostics: [
        {
          code: 'transaction.apply_failed',
          severity: 'error',
          path: '/operations/0',
          message: 'Forward operation failed.',
        },
      ],
      operationsAttempted: 1,
      rollback: { attempted: false, succeeded: false },
      initialSnapshotHash: hashes.base,
    });
    expect(receipt.diagnostics[0]?.path).toBe('/operations/0');
    expect(validateStudioApplyReceipt(receipt).valid).toBe(true);
  });

  it('records the observed current hash for a stale transaction', () => {
    const stale: ApplyResult = {
      success: false,
      stage: 'stale-check',
      diagnostics: [
        {
          code: 'transaction.stale_snapshot',
          severity: 'error',
          path: '/preconditions/baseSnapshotHash',
          message: 'The complete current snapshot does not match the change-set base hash.',
        },
      ],
      operationsAttempted: 0,
      rollback: { attempted: false, succeeded: false },
      initialSnapshotHash: hashes.failure,
    };
    const receipt = buildStudioApplyReceipt(context(), stale);
    expect(receipt).toMatchObject({
      status: 'failed',
      transactionStage: 'stale-check',
      baseSnapshotHash: hashes.base,
      observedFailureSnapshotHash: hashes.failure,
      operationsAttempted: 0,
    });
    expect(validateStudioApplyReceipt(receipt).valid).toBe(true);
  });

  it('rejects unknown receipt fields and validates every generated fixture byte-for-byte', async () => {
    const receipt = buildStudioApplyReceipt(context(), success('applied'));
    expect(
      validateStudioApplyReceipt({ ...receipt, timestamp: '2026-07-15T00:00:00Z' }).valid,
    ).toBe(false);
    for (const artifact of renderStudioReceiptFixtures()) {
      const content = await readFile(artifact.path, 'utf8');
      const parsed = JSON.parse(content) as unknown;
      const validation = validateStudioApplyReceipt(parsed);
      expect(validation.valid, artifact.label).toBe(true);
      if (validation.valid) {
        expect(validation.value.studio.studioId).toBe('[redacted]');
        expect(stringifyStudioApplyReceipt(validation.value)).toBe(content);
      }
    }
  });
});
