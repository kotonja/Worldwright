import { describe, expect, it } from 'vitest';

import {
  assertBatchLiveShareableSummaryPrivacy,
  buildBatchLiveShareableSummary,
} from '../scripts/live-batch-summary.js';

describe('Milestone 4 shareable live summary', () => {
  it('contains only non-sensitive lease claims and rejects private identity fields', () => {
    const privateLeaseId = '0123456789abcdef'.repeat(4);
    const summary = buildBatchLiveShareableSummary({
      placeId: 0,
      gameId: 0,
      authorizationEnvelopeHash: '0'.repeat(64),
      createOperationCount: 400,
      createChunkCount: 13,
      createMutationExecuteCallCount: 13,
      createChangeSetHash: '1'.repeat(64),
      createChunkIds: ['2'.repeat(64)],
      expectedResultHash: '3'.repeat(64),
      observedResultHash: '3'.repeat(64),
      noOpChangeSetHash: '4'.repeat(64),
      noOpMutationExecuteCallCount: 0,
      noOpSandboxLeaseClaimCallCount: 0,
      updateResultHash: '5'.repeat(64),
      repairResultHash: '3'.repeat(64),
      controlledResponseLossObservedHash: '5'.repeat(64),
      observedProgressClassification: 'complete',
      observedAppliedPrefixLength: 1,
      reconnectCount: 1,
      compensationAttempted: true,
      compensationSucceeded: true,
      restoredHash: '3'.repeat(64),
      finalHash: '3'.repeat(64),
      finalNoOpOperations: 0,
      transportReportHashes: {
        create: '6'.repeat(64),
        noop: '7'.repeat(64),
        update: '8'.repeat(64),
        repair: '9'.repeat(64),
        lostResponse: 'a'.repeat(64),
      },
      receiptHashes: {
        applied: 'b'.repeat(64),
        noop: 'c'.repeat(64),
        lostResponseRollback: 'd'.repeat(64),
      },
      viewportEvidence: {
        mediaType: 'image/jpeg',
        sha256: 'e'.repeat(64),
        byteLength: 128,
      },
    });

    const serialized = JSON.stringify(summary);
    expect(summary).toMatchObject({
      sandboxLeaseClaimed: true,
      sandboxLeaseReverifiedAfterReconnect: true,
      noOpSandboxLeaseClaimCallCount: 0,
    });
    expect(summary).not.toHaveProperty('studioId');
    expect(summary).not.toHaveProperty('leaseId');
    expect(summary).not.toHaveProperty('sandboxLeaseId');
    expect(serialized).not.toContain(privateLeaseId);
    expect(serialized).not.toContain('WorldwrightStudioSandboxLeaseJson');

    expect(() =>
      assertBatchLiveShareableSummaryPrivacy({ ...summary, leaseId: privateLeaseId }),
    ).toThrow(/private identity field/u);
    expect(() =>
      assertBatchLiveShareableSummaryPrivacy({
        ...summary,
        nested: { attributeName: 'WorldwrightStudioSandboxLeaseJson' },
      }),
    ).toThrow(/private sandbox lease metadata/u);
  });
});
