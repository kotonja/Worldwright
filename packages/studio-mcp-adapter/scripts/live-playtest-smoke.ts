import { readFile } from 'node:fs/promises';

import { hashPlaytestPlan } from '@worldwright/playtest-critic';
import { hashRobloxChangeSet } from '@worldwright/roblox-compiler';

import { stringifyCanonicalJson, type JsonValue } from '../src/json.js';
import {
  hashReviewedLivePlaytestSequence,
  stringifySanitizedLivePlaytestPreStartReview,
  stringifySanitizedLivePlaytestSummary,
  stringifyReviewedLivePlaytestSequence,
} from './live-playtest-summary.js';
import { reviewLivePlaytestArtifacts, runReviewedLivePlaytest } from './live-playtest-runner.js';

interface CliArguments {
  readonly review: boolean;
  readonly studioId?: string;
  readonly sandboxLeaseId?: string;
  readonly confirmedSequenceSha256?: string;
  readonly confirmedPlaytestPlanSha256?: string;
  readonly confirmedChangeSetSha256?: string;
}

function usage(): never {
  throw new Error('usage');
}

function parseArguments(values: readonly string[]): CliArguments {
  const forwardedValues = values[0] === '--' ? values.slice(1) : values;
  let review = false;
  let studioId: string | undefined;
  let sandboxLeaseId: string | undefined;
  let confirmedSequenceSha256: string | undefined;
  let confirmedPlaytestPlanSha256: string | undefined;
  let confirmedChangeSetSha256: string | undefined;
  for (let index = 0; index < forwardedValues.length; index += 1) {
    const value = forwardedValues[index]!;
    if (value === '--review') {
      if (review) usage();
      review = true;
      continue;
    }
    const next = forwardedValues[index + 1];
    if (next === undefined || next.startsWith('--')) usage();
    index += 1;
    switch (value) {
      case '--studio-id':
        if (studioId !== undefined) usage();
        studioId = next;
        break;
      case '--sandbox-lease-id':
        if (sandboxLeaseId !== undefined) usage();
        sandboxLeaseId = next;
        break;
      case '--confirm':
        if (confirmedSequenceSha256 !== undefined) usage();
        confirmedSequenceSha256 = next;
        break;
      case '--confirm-plan':
        if (confirmedPlaytestPlanSha256 !== undefined) usage();
        confirmedPlaytestPlanSha256 = next;
        break;
      case '--confirm-change-set':
        if (confirmedChangeSetSha256 !== undefined) usage();
        confirmedChangeSetSha256 = next;
        break;
      default:
        usage();
    }
  }
  if (
    review &&
    [
      studioId,
      sandboxLeaseId,
      confirmedSequenceSha256,
      confirmedPlaytestPlanSha256,
      confirmedChangeSetSha256,
    ].some((value) => value !== undefined)
  ) {
    usage();
  }
  if (
    !review &&
    [
      studioId,
      sandboxLeaseId,
      confirmedSequenceSha256,
      confirmedPlaytestPlanSha256,
      confirmedChangeSetSha256,
    ].some((value) => value === undefined)
  ) {
    usage();
  }
  return {
    review,
    ...(studioId === undefined ? {} : { studioId }),
    ...(sandboxLeaseId === undefined ? {} : { sandboxLeaseId }),
    ...(confirmedSequenceSha256 === undefined ? {} : { confirmedSequenceSha256 }),
    ...(confirmedPlaytestPlanSha256 === undefined ? {} : { confirmedPlaytestPlanSha256 }),
    ...(confirmedChangeSetSha256 === undefined ? {} : { confirmedChangeSetSha256 }),
  };
}

async function readJson(relativeUrl: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(relativeUrl, import.meta.url), 'utf8')) as unknown;
}

async function artifacts() {
  return {
    architecturePlan: await readJson(
      '../../architecture-planner/fixtures/plans/cliffwatch-mansion.architecture-plan.json',
    ),
    playtestPlan: await readJson(
      '../../playtest-critic/fixtures/plans/cliffwatch.playtest-plan.json',
    ),
    manifest: await readJson(
      '../../architecture-planner/fixtures/manifest/cliffwatch-mansion-blockout.manifest.json',
    ),
    sandboxChangeSet: await readJson(
      '../../architecture-planner/fixtures/change-sets/create-cliffwatch-blockout.change-set.json',
    ),
  };
}

async function main(): Promise<void> {
  let args: CliArguments;
  try {
    args = parseArguments(process.argv.slice(2));
  } catch {
    process.stderr.write(
      'Usage: --review OR --studio-id <exact> --sandbox-lease-id <private> --confirm <sequence-sha256> --confirm-plan <plan-sha256> --confirm-change-set <change-set-sha256>\n',
    );
    process.exitCode = 2;
    return;
  }
  let input: Awaited<ReturnType<typeof artifacts>>;
  let reviewed: ReturnType<typeof reviewLivePlaytestArtifacts>;
  try {
    input = await artifacts();
    reviewed = reviewLivePlaytestArtifacts(input);
  } catch {
    process.stderr.write('The checked-in live playtest artifacts are unavailable or invalid.\n');
    process.exitCode = 2;
    return;
  }
  if (args.review) {
    process.stdout.write(
      stringifyCanonicalJson({
        sequence: JSON.parse(stringifyReviewedLivePlaytestSequence(reviewed.sequence)) as JsonValue,
        sequenceSha256: hashReviewedLivePlaytestSequence(reviewed.sequence),
        playtestPlanSha256: hashPlaytestPlan(reviewed.playtestPlan),
        sandboxChangeSetSha256: hashRobloxChangeSet(reviewed.sandboxChangeSet),
      }),
    );
    return;
  }
  try {
    const summary = await runReviewedLivePlaytest({
      ...input,
      studioId: args.studioId!,
      sandboxLeaseId: args.sandboxLeaseId!,
      confirmedSequenceSha256: args.confirmedSequenceSha256!,
      confirmedPlaytestPlanSha256: args.confirmedPlaytestPlanSha256!,
      confirmedChangeSetSha256: args.confirmedChangeSetSha256!,
      onPreStartReview: (review) => {
        process.stdout.write(stringifySanitizedLivePlaytestPreStartReview(review));
      },
    });
    process.stdout.write(stringifySanitizedLivePlaytestSummary(summary));
  } catch {
    process.stderr.write('The confirmed bounded live playtest did not complete successfully.\n');
    process.exitCode = 1;
  }
}

await main();
