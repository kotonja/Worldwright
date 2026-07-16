import type { RobloxChangeSet } from '@worldwright/roblox-compiler';
import { describe, expect, it } from 'vitest';

import {
  assertLiveSmokeSequenceAuthorization,
  classifyLiveSmokeInitialState,
  formatLiveSmokeAuthorizationReview,
  formatLiveSmokePreMutationReview,
  hashLiveSmokeAuthorizationEnvelope,
  isLiveSmokeReviewRequest,
  parseLiveSmokeArguments,
  type LiveSmokeAuthorizationEnvelope,
} from '../scripts/live-smoke-helpers.js';

const reviewedHash = 'a'.repeat(64);

function envelope(): LiveSmokeAuthorizationEnvelope {
  return {
    schemaVersion: '0.1.0',
    sequence: 'worldwright-milestone-3-live-smoke-v1',
    projectId: 'project-live-review',
    createChangeSetHash: '1'.repeat(64),
    canonicalSnapshotHash: '2'.repeat(64),
    canonicalNoopChangeSetHash: '3'.repeat(64),
    updateNodeId: 'wall-one',
    updateChangeSetHash: '4'.repeat(64),
    modifiedSnapshotHash: '5'.repeat(64),
    repairChangeSetHash: '6'.repeat(64),
    faultChangeSetHash: '4'.repeat(64),
    captureMediaType: 'image/png',
    steps: [
      'initial-reconciliation',
      'canonical-noop',
      'one-node-display-name-update',
      'exact-inverse-repair',
      'post-update-fault',
      'verified-compensation',
      'png-viewport-capture',
      'final-canonical-noop',
    ],
  };
}

function changeSet(): RobloxChangeSet {
  return {
    schemaVersion: '0.1.0',
    compilerVersion: '0.1.0',
    preconditions: {
      projectId: 'project-live-review',
      target: { service: 'Workspace' },
      baseSnapshotHash: 'b'.repeat(64),
      desiredManifestHash: 'c'.repeat(64),
      resultSnapshotHash: 'd'.repeat(64),
    },
    operations: [],
    summary: { creates: 12, updates: 0, deletes: 0, total: 12 },
  };
}

describe('live smoke authority and review helpers', () => {
  it('requires an exact Studio ID and complete reviewed change-set confirmation', () => {
    expect(isLiveSmokeReviewRequest(['--review'])).toBe(true);
    expect(isLiveSmokeReviewRequest(['--', '--review'])).toBe(true);
    expect(isLiveSmokeReviewRequest(['--review', '--studio-id', 'studio-exact'])).toBe(false);
    expect(
      parseLiveSmokeArguments(['--confirm', reviewedHash, '--studio-id', 'studio-exact']),
    ).toEqual({ studioId: 'studio-exact', confirmation: reviewedHash });
    expect(
      parseLiveSmokeArguments(['--', '--studio-id', 'studio-exact', '--confirm', reviewedHash]),
    ).toEqual({ studioId: 'studio-exact', confirmation: reviewedHash });
    expect(() => parseLiveSmokeArguments(['--studio-id', 'studio-exact'])).toThrow(/Usage:/u);
    expect(() =>
      parseLiveSmokeArguments([
        '--studio-id',
        'studio-exact',
        '--confirm',
        reviewedHash,
        '--yes',
        'true',
      ]),
    ).toThrow(/Usage:/u);
  });

  it('renders the offline authorization envelope without connecting or mutating', () => {
    const authorizationEnvelope = envelope();
    const authorizationEnvelopeHash = hashLiveSmokeAuthorizationEnvelope(authorizationEnvelope);
    expect(
      JSON.parse(
        formatLiveSmokeAuthorizationReview(authorizationEnvelope, authorizationEnvelopeHash),
      ),
    ).toEqual({
      authorizationEnvelope,
      connectionAttempted: false,
      mutationAttempted: false,
      requiredLiveSequenceConfirmationHash: authorizationEnvelopeHash,
      review: 'Worldwright Milestone 3 offline live-sequence authorization',
    });
  });

  it('rejects prefixes, symbolic approval, uppercase hashes, and a different full hash', () => {
    expect(() => assertLiveSmokeSequenceAuthorization(reviewedHash, reviewedHash)).not.toThrow();
    for (const invalid of [
      reviewedHash.slice(0, 16),
      'yes',
      reviewedHash.toUpperCase(),
      'b'.repeat(64),
    ]) {
      expect(() => assertLiveSmokeSequenceAuthorization(invalid, reviewedHash)).toThrow(
        /complete lowercase reviewed live-sequence/u,
      );
    }
  });

  it('accepts only empty or exact canonical interrupted state', () => {
    expect(classifyLiveSmokeInitialState(0, 'e'.repeat(64), 'f'.repeat(64))).toBe('empty');
    expect(classifyLiveSmokeInitialState(400, 'f'.repeat(64), 'f'.repeat(64))).toBe(
      'canonical-cliffwatch',
    );
    expect(() => classifyLiveSmokeInitialState(400, 'e'.repeat(64), 'f'.repeat(64))).toThrow(
      /unexpected managed project/u,
    );
  });

  it('renders complete counts and hashes while escaping untrusted display text', () => {
    const authorizationEnvelope = envelope();
    const authorizationEnvelopeHash = hashLiveSmokeAuthorizationEnvelope(authorizationEnvelope);
    const output = formatLiveSmokePreMutationReview({
      studioId: 'studio\nnot-a-second-line',
      placeName: 'Sandbox\nInjected label',
      initialState: 'empty',
      changeSet: changeSet(),
      plannedChangeSetHash: reviewedHash,
      authorizationEnvelope,
      authorizationEnvelopeHash,
    });
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      studioId: 'studio\nnot-a-second-line',
      unsavedPlaceName: 'Sandbox\nInjected label',
      initialState: 'empty',
      projectId: 'project-live-review',
      operations: { creates: 12, updates: 0, deletes: 0, total: 12 },
      baseSnapshotHash: 'b'.repeat(64),
      desiredManifestHash: 'c'.repeat(64),
      expectedResultSnapshotHash: 'd'.repeat(64),
      plannedChangeSetHash: reviewedHash,
      authorizationEnvelope,
      requiredLiveSequenceConfirmationHash: authorizationEnvelopeHash,
    });
    expect(output).not.toContain('studio\nnot-a-second-line');
    expect(output).not.toContain('Sandbox\nInjected label');
  });
});
