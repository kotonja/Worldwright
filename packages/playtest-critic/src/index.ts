export {
  CRITIC_REPORT_SCHEMA_ID,
  CRITIC_REPORT_VERSION,
  PLAYTEST_AGENT_PROFILE,
  PLAYTEST_CRITIC_VERSION,
  PLAYTEST_LIMITS,
  PLAYTEST_PLAN_SCHEMA_ID,
  PLAYTEST_PLAN_VERSION,
  PLAYTEST_RUN_REPORT_SCHEMA_ID,
  PLAYTEST_RUN_REPORT_VERSION,
} from './constants.js';

export {
  playtestDiagnostic,
  sortPlaytestDiagnostics,
  type PlaytestDiagnostic,
  type PlaytestDiagnosticCode,
  type PlaytestValidationResult,
} from './diagnostic.js';

export {
  PlaytestAgentSchema,
  PlaytestCheckpointSchema,
  PlaytestLimitsSchema,
  PlaytestPlanSchema,
  PlaytestPlanSourceSchema,
  PlaytestRequiredCoverageSchema,
  PlaytestSegmentSchema,
  PlaytestSetupSchema,
  PlaytestVector3Schema,
  type PlaytestAgent,
  type PlaytestCheckpoint,
  type PlaytestPlan,
  type PlaytestPlanSource,
  type PlaytestRequiredCoverage,
  type PlaytestSegment,
  type PlaytestSetup,
  type PlaytestVector3,
} from './plan/contract-schema.js';
export { buildPlaytestPlan } from './plan/planner.js';
export { bindPlaytestSource, type BoundPlaytestSource } from './plan/source.js';
export { validatePlaytestPlanAgainstSources } from './plan/trusted.js';
export { validatePlaytestPlan } from './plan/validate.js';
export { normalizePlaytestPlan } from './plan/normalize.js';
export { hashPlaytestPlan, stringifyPlaytestPlan } from './plan/hashing.js';

export {
  PlaytestConsoleEvidenceSchema,
  PlaytestCoverageSchema,
  PlaytestRunReportSchema,
  PlaytestRunSourceSchema,
  PlaytestSegmentResultSchema,
  PlaytestViewportEvidenceSchema,
  type PlaytestConsoleEvidence,
  type PlaytestCoverage,
  type PlaytestRunReport,
  type PlaytestRunSource,
  type PlaytestSegmentResult,
  type PlaytestViewportEvidence,
} from './run/contract-schema.js';
export { validatePlaytestRunReport, validatePlaytestRunReportAgainstPlan } from './run/validate.js';
export { normalizePlaytestRunReport } from './run/normalize.js';
export { hashPlaytestRunReport, stringifyPlaytestRunReport } from './run/hashing.js';

export {
  CriticEvidenceCompletenessSchema,
  CriticFindingCodeSchema,
  CriticFindingSchema,
  CriticMetricsSchema,
  CriticReportSchema,
  CriticReportSourceSchema,
  CriticSuggestionCodeSchema,
  type CriticFinding,
  type CriticFindingCode,
  type CriticReport,
  type CriticSuggestionCode,
} from './critic/contract-schema.js';
export { CRITIC_RULES, type CriticRuleDescriptor } from './critic/rules.js';
export { evaluatePlaytestRun } from './critic/evaluate.js';
export { validateCriticReport, validateCriticReportAgainstInputs } from './critic/validate.js';
export { normalizeCriticReport } from './critic/normalize.js';
export { hashCriticReport, stringifyCriticReport } from './critic/hashing.js';
