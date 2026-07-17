import type { Static } from '@sinclair/typebox';

import type { StudioDiagnostic } from '../diagnostics.js';
import type {
  StudioSandboxLeaseBoundSnapshotRequestSchema,
  StudioSandboxLeaseBoundSnapshotSuccessSchema,
  StudioSandboxLeaseClaimRequestSchema,
  StudioSandboxLeaseClaimSuccessSchema,
  StudioSandboxLeaseFailureSchema,
  StudioSandboxLeaseReadRequestSchema,
  StudioSandboxLeaseReadSuccessSchema,
  StudioSandboxLeaseRecordSchema,
  StudioSandboxLeaseRequestSchema,
  StudioSandboxLeaseResponseSchema,
} from './contract-schema.js';

export type StudioSandboxLeaseRecord = Static<typeof StudioSandboxLeaseRecordSchema>;
export type StudioSandboxLeaseReadRequest = Static<typeof StudioSandboxLeaseReadRequestSchema>;
export type StudioSandboxLeaseClaimRequest = Static<typeof StudioSandboxLeaseClaimRequestSchema>;
export type StudioSandboxLeaseBoundSnapshotRequest = Static<
  typeof StudioSandboxLeaseBoundSnapshotRequestSchema
>;
export type StudioSandboxLeaseRequest = Static<typeof StudioSandboxLeaseRequestSchema>;
export type StudioSandboxLeaseReadSuccess = Static<typeof StudioSandboxLeaseReadSuccessSchema>;
export type StudioSandboxLeaseClaimSuccess = Static<typeof StudioSandboxLeaseClaimSuccessSchema>;
export type StudioSandboxLeaseBoundSnapshotSuccess = Static<
  typeof StudioSandboxLeaseBoundSnapshotSuccessSchema
>;
export type StudioSandboxLeaseFailure = Static<typeof StudioSandboxLeaseFailureSchema>;
export type StudioSandboxLeaseResponse = Static<typeof StudioSandboxLeaseResponseSchema>;
export type StudioSandboxLeaseAction = StudioSandboxLeaseRequest['action'];

export interface StudioSandboxLeaseContractValidationSuccess<T> {
  readonly valid: true;
  readonly value: T;
  readonly diagnostics: readonly StudioDiagnostic[];
}

export interface StudioSandboxLeaseContractValidationFailure {
  readonly valid: false;
  readonly diagnostics: readonly StudioDiagnostic[];
}

export type StudioSandboxLeaseContractValidationResult<T> =
  | StudioSandboxLeaseContractValidationSuccess<T>
  | StudioSandboxLeaseContractValidationFailure;

export type SandboxLeaseIdFactory = () => string;
