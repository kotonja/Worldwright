import type { Static } from '@sinclair/typebox';

import type { StudioDiagnostic } from '../diagnostics.js';
import type {
  StudioBatchCreateOperationSchema,
  StudioBatchDeleteOperationSchema,
  StudioBatchFailureResponseSchema,
  StudioBatchOperationSchema,
  StudioBatchRequestSchema,
  StudioBatchResponseSchema,
  StudioBatchSuccessResponseSchema,
  StudioBatchUpdateOperationSchema,
} from './contract-schema.js';

export type StudioBatchCreateOperation = Static<typeof StudioBatchCreateOperationSchema>;
export type StudioBatchUpdateOperation = Static<typeof StudioBatchUpdateOperationSchema>;
export type StudioBatchDeleteOperation = Static<typeof StudioBatchDeleteOperationSchema>;
export type StudioBatchOperation = Static<typeof StudioBatchOperationSchema>;
export type StudioBatchRequest = Static<typeof StudioBatchRequestSchema>;
export type StudioBatchSuccessResponse = Static<typeof StudioBatchSuccessResponseSchema>;
export type StudioBatchFailureResponse = Static<typeof StudioBatchFailureResponseSchema>;
export type StudioBatchResponse = Static<typeof StudioBatchResponseSchema>;

export interface StudioBatchContractValidationSuccess<T> {
  readonly valid: true;
  readonly value: T;
  readonly diagnostics: readonly StudioDiagnostic[];
}

export interface StudioBatchContractValidationFailure {
  readonly valid: false;
  readonly diagnostics: readonly StudioDiagnostic[];
}

export type StudioBatchContractValidationResult<T> =
  | StudioBatchContractValidationSuccess<T>
  | StudioBatchContractValidationFailure;

export interface StudioBatchChunkLimits {
  readonly maxOperations: number;
  readonly maxPayloadBytes: number;
}

export interface StudioOperationChunk {
  readonly chunkId: string;
  readonly chunkIndex: number;
  readonly operationIds: readonly string[];
  readonly canonicalRequestBytes: number;
  readonly request: Readonly<StudioBatchRequest>;
}
