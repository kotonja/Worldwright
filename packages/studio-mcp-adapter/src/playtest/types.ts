import type { Static } from '@sinclair/typebox';

import type { StudioDiagnostic } from '../diagnostics.js';
import type { StudioViewportEvidence } from '../types.js';
import type {
  StudioPlaytestAgentSchema,
  StudioPlaytestCharacterSetupRequestSchema,
  StudioPlaytestCharacterSetupSuccessSchema,
  StudioPlaytestClearanceProbeRequestSchema,
  StudioPlaytestClearanceProbeSuccessSchema,
  StudioPlaytestFloorSchema,
  StudioPlaytestIdentityProbeRequestSchema,
  StudioPlaytestIdentityProbeSuccessSchema,
  StudioPlaytestIdentitySchema,
  StudioPlaytestPathProbeRequestSchema,
  StudioPlaytestPathProbeSuccessSchema,
  StudioPlaytestPlayerStateRequestSchema,
  StudioPlaytestPlayerStateSuccessSchema,
  StudioPlaytestProbeFailureSchema,
  StudioPlaytestProbeRequestSchema,
  StudioPlaytestProbeResponseSchema,
  StudioPlaytestVectorSchema,
} from './contract-schema.js';

export type StudioPlaytestVector = Static<typeof StudioPlaytestVectorSchema>;
export type StudioPlaytestAgent = Static<typeof StudioPlaytestAgentSchema>;
export type StudioPlaytestFloor = Static<typeof StudioPlaytestFloorSchema>;
export type StudioPlaytestIdentity = Static<typeof StudioPlaytestIdentitySchema>;
export type StudioPlaytestIdentityProbeRequest = Static<
  typeof StudioPlaytestIdentityProbeRequestSchema
>;
export type StudioPlaytestCharacterSetupRequest = Static<
  typeof StudioPlaytestCharacterSetupRequestSchema
>;
export type StudioPlaytestPlayerStateRequest = Static<
  typeof StudioPlaytestPlayerStateRequestSchema
>;
export type StudioPlaytestPathProbeRequest = Static<typeof StudioPlaytestPathProbeRequestSchema>;
export type StudioPlaytestClearanceProbeRequest = Static<
  typeof StudioPlaytestClearanceProbeRequestSchema
>;
export type StudioPlaytestProbeRequest = Static<typeof StudioPlaytestProbeRequestSchema>;
export type StudioPlaytestIdentityProbeSuccess = Static<
  typeof StudioPlaytestIdentityProbeSuccessSchema
>;
export type StudioPlaytestCharacterSetupSuccess = Static<
  typeof StudioPlaytestCharacterSetupSuccessSchema
>;
export type StudioPlaytestPlayerStateSuccess = Static<
  typeof StudioPlaytestPlayerStateSuccessSchema
>;
export type StudioPlaytestPathProbeSuccess = Static<typeof StudioPlaytestPathProbeSuccessSchema>;
export type StudioPlaytestClearanceProbeSuccess = Static<
  typeof StudioPlaytestClearanceProbeSuccessSchema
>;
export type StudioPlaytestProbeFailure = Static<typeof StudioPlaytestProbeFailureSchema>;
export type StudioPlaytestProbeResponse = Static<typeof StudioPlaytestProbeResponseSchema>;
export type StudioPlaytestProbeAction = StudioPlaytestProbeRequest['action'];

export interface StudioPlaytestContractValidationSuccess<T> {
  readonly valid: true;
  readonly value: T;
  readonly diagnostics: readonly [];
}

export interface StudioPlaytestContractValidationFailure {
  readonly valid: false;
  readonly diagnostics: readonly StudioDiagnostic[];
}

export type StudioPlaytestContractValidationResult<T> =
  | StudioPlaytestContractValidationSuccess<T>
  | StudioPlaytestContractValidationFailure;

export interface StudioPlaytestCaptureEvidence extends StudioViewportEvidence {
  readonly evidenceId: string;
  readonly checkpointId: string;
}
