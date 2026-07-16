import type { Static } from '@sinclair/typebox';

import type {
  StudioAppliedReceiptSchema,
  StudioApplyReceiptSchema,
  StudioBridgeCreateRequestSchema,
  StudioBridgeDeleteRequestSchema,
  StudioBridgeDiagnosticSchema,
  StudioBridgeFailureSchema,
  StudioBridgeManagedNodeSchema,
  StudioBridgeMutationSuccessSchema,
  StudioBridgeParentStateSchema,
  StudioBridgeProbeRequestSchema,
  StudioBridgeProbeSuccessSchema,
  StudioBridgeRequestSchema,
  StudioBridgeResponseSchema,
  StudioBridgeSnapshotRequestSchema,
  StudioBridgeSnapshotSuccessSchema,
  StudioBridgeUpdateRequestSchema,
  StudioCompactContainerNodeSchema,
  StudioCompactManagedNodeSchema,
  StudioCompactNameSchema,
  StudioCompactPartNodeSchema,
  StudioCompactSnapshotSchema,
  StudioCompactUnmanagedRootSchema,
  StudioCompactWedgeNodeSchema,
  StudioFailedReceiptSchema,
  StudioNoopReceiptSchema,
  StudioProbeSchema,
  StudioRawManagedNodeSchema,
  StudioRawSnapshotSchema,
  StudioRawUnmanagedRootSchema,
  StudioReceiptDiagnosticSchema,
  StudioReceiptStudioSchema,
  StudioRollbackResultSchema,
  StudioTargetSchema,
  StudioViewportEvidenceSchema,
} from './contract-schema.js';
import type { StudioDiagnostic } from './diagnostics.js';

export type StudioTarget = Static<typeof StudioTargetSchema>;
export type StudioBridgeManagedNode = Static<typeof StudioBridgeManagedNodeSchema>;
export type StudioBridgeParentState = Static<typeof StudioBridgeParentStateSchema>;
export type StudioBridgeProbeRequest = Static<typeof StudioBridgeProbeRequestSchema>;
export type StudioBridgeSnapshotRequest = Static<typeof StudioBridgeSnapshotRequestSchema>;
export type StudioBridgeCreateRequest = Static<typeof StudioBridgeCreateRequestSchema>;
export type StudioBridgeUpdateRequest = Static<typeof StudioBridgeUpdateRequestSchema>;
export type StudioBridgeDeleteRequest = Static<typeof StudioBridgeDeleteRequestSchema>;
export type StudioBridgeRequest = Static<typeof StudioBridgeRequestSchema>;

export type StudioRawManagedNode = Static<typeof StudioRawManagedNodeSchema>;
export type StudioRawNode = StudioRawManagedNode;
export type StudioRawUnmanagedRoot = Static<typeof StudioRawUnmanagedRootSchema>;
export type StudioRawSnapshot = Static<typeof StudioRawSnapshotSchema>;
export type StudioCompactContainerNode = Static<typeof StudioCompactContainerNodeSchema>;
export type StudioCompactPartNode = Static<typeof StudioCompactPartNodeSchema>;
export type StudioCompactWedgeNode = Static<typeof StudioCompactWedgeNodeSchema>;
export type StudioCompactManagedNode = Static<typeof StudioCompactManagedNodeSchema>;
export type StudioCompactName = Static<typeof StudioCompactNameSchema>;
export type StudioCompactUnmanagedRoot = Static<typeof StudioCompactUnmanagedRootSchema>;
export type StudioCompactSnapshot = Static<typeof StudioCompactSnapshotSchema>;
export type StudioProbe = Static<typeof StudioProbeSchema>;
export type StudioRawProbe = StudioProbe;
export type StudioBridgeDiagnostic = Static<typeof StudioBridgeDiagnosticSchema>;
export type StudioBridgeProbeSuccess = Static<typeof StudioBridgeProbeSuccessSchema>;
export type StudioBridgeSnapshotSuccess = Static<typeof StudioBridgeSnapshotSuccessSchema>;
export type StudioBridgeMutationSuccess = Static<typeof StudioBridgeMutationSuccessSchema>;
export type StudioBridgeFailure = Static<typeof StudioBridgeFailureSchema>;
export type StudioBridgeResponse = Static<typeof StudioBridgeResponseSchema>;

export type StudioReceiptDiagnostic = Static<typeof StudioReceiptDiagnosticSchema>;
export type StudioViewportEvidence = Static<typeof StudioViewportEvidenceSchema>;
export type StudioReceiptStudio = Static<typeof StudioReceiptStudioSchema>;
export type StudioRollbackResult = Static<typeof StudioRollbackResultSchema>;
export type StudioAppliedReceipt = Static<typeof StudioAppliedReceiptSchema>;
export type StudioNoopReceipt = Static<typeof StudioNoopReceiptSchema>;
export type StudioFailedReceipt = Static<typeof StudioFailedReceiptSchema>;
export type StudioApplyReceipt = Static<typeof StudioApplyReceiptSchema>;

export interface StudioReceiptContext {
  readonly studio: Readonly<StudioReceiptStudio>;
  readonly projectId: string;
  readonly target: Readonly<StudioTarget>;
  readonly changeSetHash: string;
  readonly baseSnapshotHash: string;
  readonly desiredManifestHash: string;
  readonly expectedResultSnapshotHash: string;
  readonly operationsPlanned: number;
  readonly viewportEvidence?: Readonly<StudioViewportEvidence>;
}

export interface StudioContractValidationSuccess<T> {
  readonly valid: true;
  readonly value: T;
  readonly diagnostics: readonly StudioDiagnostic[];
}

export interface StudioContractValidationFailure {
  readonly valid: false;
  readonly diagnostics: readonly StudioDiagnostic[];
}

export type StudioContractValidationResult<T> =
  | StudioContractValidationSuccess<T>
  | StudioContractValidationFailure;

export interface ViewportCaptureWriteInput {
  readonly outputPath: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}
