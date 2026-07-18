export const PLAYTEST_PLAN_VERSION = '0.1.0' as const;
export const PLAYTEST_CRITIC_VERSION = '0.1.0' as const;
export const PLAYTEST_RUN_REPORT_VERSION = '0.1.0' as const;
export const CRITIC_REPORT_VERSION = '0.1.0' as const;

export const PLAYTEST_PLAN_SCHEMA_ID = 'urn:worldwright:playtest-plan:0.1.0' as const;
export const PLAYTEST_RUN_REPORT_SCHEMA_ID = 'urn:worldwright:playtest-run-report:0.1.0' as const;
export const CRITIC_REPORT_SCHEMA_ID = 'urn:worldwright:critic-report:0.1.0' as const;
// A valid report can produce at most fourteen findings per bounded segment, four
// bounded coverage findings per checkpoint, and twenty fixed/global findings.
// 14 * 256 + 4 * 128 + 20 = 4,116. Keep the published schema bound explicit and
// comfortably above that proof so evaluation never needs to truncate evidence.
export const CRITIC_MAX_FINDINGS = 4_116 as const;
export const JSON_SCHEMA_DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema' as const;

export const PLAYTEST_AGENT_PROFILE = Object.freeze({
  radius: 2,
  height: 5,
  canJump: false,
  canClimb: false,
  waypointSpacing: 4,
  arrivalHorizontalTolerance: 4,
  arrivalVerticalTolerance: 5,
  maximumHorizontalSpeed: 32,
  maximumFallBelowFloor: 12,
  rootHeightAboveFinishedFloor: 3,
} as const);

export const PLAYTEST_LIMITS = Object.freeze({
  maximumCheckpoints: 128,
  maximumRouteSegments: 256,
  maximumCaptures: 8,
  maximumPathWaypointsRetainedPerSegment: 128,
  maximumConsoleEvidenceEntries: 512,
  maximumSanitizedConsoleSummaryEntries: 64,
  maximumNavigationWaitMillisecondsPerSegment: 45_000,
  maximumTotalPlaytestWaitMilliseconds: 900_000,
  maximumCharacterLoadWaitMilliseconds: 60_000,
  maximumStartStopTransitionWaitMilliseconds: 60_000,
} as const);

export const PLAYTEST_CHECKPOINT_SAFE_OFFSET = 2.5 as const;
export const PLAYTEST_MAX_IDENTIFIER_LENGTH = 128 as const;
export const PLAYTEST_IDENTIFIER_PATTERN = '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$' as const;
export const SHA_256_PATTERN = '^[0-9a-f]{64}$' as const;
