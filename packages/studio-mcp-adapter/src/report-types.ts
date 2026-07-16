import type { Static } from '@sinclair/typebox';

import type {
  StudioProgressDiagnosticSchema,
  StudioProgressReportSchema,
  StudioTransportFinalOutcomeSchema,
  StudioTransportReportSchema,
} from './report-contract-schema.js';

export type StudioProgressDiagnostic = Static<typeof StudioProgressDiagnosticSchema>;
export type StudioProgressReport = Static<typeof StudioProgressReportSchema>;
export type StudioTransportFinalOutcome = Static<typeof StudioTransportFinalOutcomeSchema>;
export type StudioTransportReport = Static<typeof StudioTransportReportSchema>;

export interface StudioTransportCounters {
  changeSetHash: string;
  operationsPlanned: number;
  operationsAttempted: number;
  operationsAppliedBeforeFailure: number;
  chunksPlanned: number;
  chunksAttempted: number;
  chunksCompleted: number;
  mutationExecuteCalls: number;
  uncertainTransportEvents: number;
  reconnectAttempts: number;
  reconnectsSucceeded: number;
  compensationOperationsAttempted: number;
  compensationOperationsApplied: number;
  compensationChunksAttempted: number;
  compensationChunksCompleted: number;
}
