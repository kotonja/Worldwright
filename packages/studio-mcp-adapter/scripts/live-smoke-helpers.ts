import type { RobloxChangeSet } from '@worldwright/roblox-compiler';

import { StudioAdapterError, studioDiagnostic } from '../src/diagnostics.js';
import { hashCanonicalJson, stringifyCanonicalJson, type JsonValue } from '../src/json.js';

const LIVE_SMOKE_USAGE =
  'Usage:\n  pnpm studio:live-smoke -- --review\n  pnpm studio:live-smoke -- --studio-id <exact-id> --confirm <full-reviewed-live-sequence-sha256>';

function usageError(message: string): never {
  throw new StudioAdapterError([studioDiagnostic('studio.usage_invalid', '', message)]);
}

export interface LiveSmokeArguments {
  readonly studioId: string;
  readonly confirmation: string;
}

export type LiveSmokeInitialState = 'empty' | 'canonical-cliffwatch';

export interface LiveSmokeAuthorizationEnvelope {
  readonly schemaVersion: '0.1.0';
  readonly sequence: 'worldwright-milestone-3-live-smoke-v1';
  readonly projectId: string;
  readonly createChangeSetHash: string;
  readonly canonicalSnapshotHash: string;
  readonly canonicalNoopChangeSetHash: string;
  readonly updateNodeId: string;
  readonly updateChangeSetHash: string;
  readonly modifiedSnapshotHash: string;
  readonly repairChangeSetHash: string;
  readonly faultChangeSetHash: string;
  readonly captureMediaType: 'image/jpeg';
  readonly steps: readonly [
    'initial-reconciliation',
    'canonical-noop',
    'one-node-display-name-update',
    'exact-inverse-repair',
    'post-update-fault',
    'verified-compensation',
    'jpeg-viewport-capture',
    'final-canonical-noop',
  ];
}

export interface LiveSmokePreMutationReviewInput {
  readonly placeName: string;
  readonly initialState: LiveSmokeInitialState;
  readonly changeSet: Readonly<RobloxChangeSet>;
  readonly plannedChangeSetHash: string;
  readonly authorizationEnvelope: Readonly<LiveSmokeAuthorizationEnvelope>;
  readonly authorizationEnvelopeHash: string;
}

export function isLiveSmokeReviewRequest(args: readonly string[]): boolean {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  return normalizedArgs.length === 1 && normalizedArgs[0] === '--review';
}

/** Parses only the two explicit live-acceptance authority inputs. */
export function parseLiveSmokeArguments(args: readonly string[]): LiveSmokeArguments {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  if (normalizedArgs.length !== 4) return usageError(LIVE_SMOKE_USAGE);
  const values = new Map<string, string>();
  for (let index = 0; index < normalizedArgs.length; index += 2) {
    const name = normalizedArgs[index];
    const value = normalizedArgs[index + 1];
    if (
      (name !== '--studio-id' && name !== '--confirm') ||
      value === undefined ||
      value.length === 0 ||
      values.has(name)
    ) {
      return usageError(LIVE_SMOKE_USAGE);
    }
    values.set(name, value);
  }
  const studioId = values.get('--studio-id');
  const confirmation = values.get('--confirm');
  if (studioId === undefined || confirmation === undefined) return usageError(LIVE_SMOKE_USAGE);
  return { studioId, confirmation };
}

/** Requires the complete, lowercase hash of the reviewed checked-in create change set. */
export function assertLiveSmokeSequenceAuthorization(
  confirmation: string,
  reviewedSequenceHash: string,
): void {
  if (
    !/^[0-9a-f]{64}$/u.test(confirmation) ||
    !/^[0-9a-f]{64}$/u.test(reviewedSequenceHash) ||
    confirmation !== reviewedSequenceHash
  ) {
    return usageError(
      'The --confirm value must equal the complete lowercase reviewed live-sequence SHA-256.',
    );
  }
}

export function hashLiveSmokeAuthorizationEnvelope(
  envelope: Readonly<LiveSmokeAuthorizationEnvelope>,
): string {
  return hashCanonicalJson(envelope as unknown as JsonValue);
}

export function formatLiveSmokeAuthorizationReview(
  envelope: Readonly<LiveSmokeAuthorizationEnvelope>,
  envelopeHash: string,
): string {
  return stringifyCanonicalJson({
    review: 'Worldwright Milestone 3 offline live-sequence authorization',
    authorizationEnvelope: envelope,
    requiredLiveSequenceConfirmationHash: envelopeHash,
    connectionAttempted: false,
    mutationAttempted: false,
  } as unknown as JsonValue);
}

/** Accepts only a fresh empty project or the exact canonical result left by an interrupted run. */
export function classifyLiveSmokeInitialState(
  nodeCount: number,
  snapshotHash: string,
  canonicalResultHash: string,
): LiveSmokeInitialState {
  if (nodeCount === 0) return 'empty';
  if (snapshotHash === canonicalResultHash) return 'canonical-cliffwatch';
  throw new Error('Sandbox contains an unexpected managed project; no mutation was attempted.');
}

/** Formats a JSON-escaped, complete human review without machine paths or raw MCP data. */
export function formatLiveSmokePreMutationReview(
  input: Readonly<LiveSmokePreMutationReviewInput>,
): string {
  const review = {
    review: 'Worldwright Milestone 3 live pre-mutation review',
    unsavedPlaceName: input.placeName,
    initialState: input.initialState,
    projectId: input.changeSet.preconditions.projectId,
    operations: {
      creates: input.changeSet.summary.creates,
      updates: input.changeSet.summary.updates,
      deletes: input.changeSet.summary.deletes,
      total: input.changeSet.summary.total,
    },
    baseSnapshotHash: input.changeSet.preconditions.baseSnapshotHash,
    desiredManifestHash: input.changeSet.preconditions.desiredManifestHash,
    expectedResultSnapshotHash: input.changeSet.preconditions.resultSnapshotHash,
    plannedChangeSetHash: input.plannedChangeSetHash,
    authorizationEnvelope: input.authorizationEnvelope,
    requiredLiveSequenceConfirmationHash: input.authorizationEnvelopeHash,
    authorization: 'exact-full-reviewed-live-sequence-hash-matched',
  } as const;
  return stringifyCanonicalJson(review as unknown as JsonValue);
}
