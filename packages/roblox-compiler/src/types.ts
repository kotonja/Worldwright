import type { Static } from '@sinclair/typebox';

import type {
  RobloxChangeOperationSchema,
  RobloxChangeSetPreconditionsSchema,
  RobloxChangeSetSchema,
  RobloxChangeSetSummarySchema,
  RobloxContainerNodeSchema,
  RobloxContainerPropertiesSchema,
  RobloxCornerWedgePartNodeSchema,
  RobloxCornerWedgePartPropertiesSchema,
  RobloxCreateOperationSchema,
  RobloxDeleteOperationSchema,
  RobloxEntityKindSchema,
  RobloxFolderNodeSchema,
  RobloxManagedAttributesSchema,
  RobloxManagedNodeSchema,
  RobloxManifestMeasurementsSchema,
  RobloxManifestSchema,
  RobloxManifestSourceSchema,
  RobloxModelNodeSchema,
  RobloxPartNodeSchema,
  RobloxPartPropertiesSchema,
  RobloxPositiveVector3Schema,
  RobloxPrimitiveNodeSchema,
  RobloxSnapshotSchema,
  RobloxTargetSchema,
  RobloxUnmanagedRootSchema,
  RobloxUpdateOperationSchema,
  RobloxVector3Schema,
  RobloxWedgePartNodeSchema,
  RobloxWedgePartPropertiesSchema,
} from './contract-schema.js';
import type {
  RobloxContainerDirective,
  RobloxCornerWedgeDirective,
  RobloxDirective,
  RobloxPartDirective,
  RobloxWedgeDirective,
} from './directive-schema.js';
import type { RobloxDiagnostic } from './diagnostics.js';

export type {
  RobloxContainerDirective,
  RobloxCornerWedgeDirective,
  RobloxDirective,
  RobloxPartDirective,
  RobloxWedgeDirective,
};

export type RobloxTarget = Static<typeof RobloxTargetSchema>;
export type RobloxEntityKind = Static<typeof RobloxEntityKindSchema>;
export type RobloxVector3 = Static<typeof RobloxVector3Schema>;
export type RobloxPositiveVector3 = Static<typeof RobloxPositiveVector3Schema>;
export type RobloxManagedAttributes = Static<typeof RobloxManagedAttributesSchema>;
export type RobloxContainerProperties = Static<typeof RobloxContainerPropertiesSchema>;
export type RobloxPartProperties = Static<typeof RobloxPartPropertiesSchema>;
export type RobloxWedgePartProperties = Static<typeof RobloxWedgePartPropertiesSchema>;
export type RobloxCornerWedgePartProperties = Static<typeof RobloxCornerWedgePartPropertiesSchema>;
export type RobloxFolderNode = Static<typeof RobloxFolderNodeSchema>;
export type RobloxModelNode = Static<typeof RobloxModelNodeSchema>;
export type RobloxPartNode = Static<typeof RobloxPartNodeSchema>;
export type RobloxWedgePartNode = Static<typeof RobloxWedgePartNodeSchema>;
export type RobloxCornerWedgePartNode = Static<typeof RobloxCornerWedgePartNodeSchema>;
export type RobloxContainerNode = Static<typeof RobloxContainerNodeSchema>;
export type RobloxPrimitiveNode = Static<typeof RobloxPrimitiveNodeSchema>;
export type RobloxManagedNode = Static<typeof RobloxManagedNodeSchema>;
export type RobloxManifestSource = Static<typeof RobloxManifestSourceSchema>;
export type RobloxManifestMeasurements = Static<typeof RobloxManifestMeasurementsSchema>;
export type RobloxManifest = Static<typeof RobloxManifestSchema>;
export type RobloxUnmanagedRoot = Static<typeof RobloxUnmanagedRootSchema>;
export type RobloxSnapshot = Static<typeof RobloxSnapshotSchema>;
export type RobloxSceneSnapshot = RobloxSnapshot;
export type RobloxCreateOperation = Static<typeof RobloxCreateOperationSchema>;
export type RobloxUpdateOperation = Static<typeof RobloxUpdateOperationSchema>;
export type RobloxDeleteOperation = Static<typeof RobloxDeleteOperationSchema>;
export type RobloxChangeOperation = Static<typeof RobloxChangeOperationSchema>;
export type RobloxChangeSetPreconditions = Static<typeof RobloxChangeSetPreconditionsSchema>;
export type RobloxChangeSetSummary = Static<typeof RobloxChangeSetSummarySchema>;
export type RobloxChangeSet = Static<typeof RobloxChangeSetSchema>;

export interface RobloxContractValidationSuccess<T> {
  readonly valid: true;
  readonly value: T;
  readonly diagnostics: readonly RobloxDiagnostic[];
}

export interface RobloxContractValidationFailure {
  readonly valid: false;
  readonly diagnostics: readonly RobloxDiagnostic[];
}

export type RobloxContractValidationResult<T> =
  | RobloxContractValidationSuccess<T>
  | RobloxContractValidationFailure;

export interface CompileSuccess {
  readonly success: true;
  readonly manifest: RobloxManifest;
  readonly diagnostics: readonly RobloxDiagnostic[];
}

export interface CompileFailure {
  readonly success: false;
  readonly diagnostics: readonly RobloxDiagnostic[];
}

export type CompileResult = CompileSuccess | CompileFailure;

export interface PlanSuccess {
  readonly success: true;
  readonly changeSet: RobloxChangeSet;
  readonly expectedSnapshot: RobloxSnapshot;
  readonly diagnostics: readonly RobloxDiagnostic[];
}

export interface PlanFailure {
  readonly success: false;
  readonly diagnostics: readonly RobloxDiagnostic[];
}

export type PlanResult = PlanSuccess | PlanFailure;

export interface SimulationSuccess {
  readonly success: true;
  readonly snapshot: RobloxSnapshot;
  readonly diagnostics: readonly RobloxDiagnostic[];
}

export interface SimulationFailure {
  readonly success: false;
  readonly diagnostics: readonly RobloxDiagnostic[];
}

export type SimulationResult = SimulationSuccess | SimulationFailure;

export interface RobloxAdapterScope {
  readonly projectId: string;
  readonly target: Readonly<RobloxTarget>;
}

/**
 * A bounded future-implementation boundary for one project and target.
 * Implementations must faithfully apply only the fixed node class/property allowlist.
 */
export interface RobloxAdapter {
  readSnapshot(scope: Readonly<RobloxAdapterScope>): Promise<unknown>;
  createNode(scope: Readonly<RobloxAdapterScope>, node: Readonly<RobloxManagedNode>): Promise<void>;
  updateNode(
    scope: Readonly<RobloxAdapterScope>,
    before: Readonly<RobloxManagedNode>,
    after: Readonly<RobloxManagedNode>,
  ): Promise<void>;
  deleteNode(
    scope: Readonly<RobloxAdapterScope>,
    before: Readonly<RobloxManagedNode>,
  ): Promise<void>;
}

export type ApplyFailureStage =
  | 'change-set-validation'
  | 'snapshot-read'
  | 'snapshot-validation'
  | 'stale-check'
  | 'preflight'
  | 'apply'
  | 'verification';

export interface RollbackNotAttempted {
  readonly attempted: false;
  readonly succeeded: false;
}

export interface RollbackSucceeded {
  readonly attempted: true;
  readonly succeeded: true;
  readonly restoredSnapshotHash: string;
}

export interface RollbackFailed {
  readonly attempted: true;
  readonly succeeded: false;
  readonly diagnostics: readonly RobloxDiagnostic[];
  readonly observedSnapshotHash?: string;
}

export type RollbackResult = RollbackNotAttempted | RollbackSucceeded | RollbackFailed;

export interface ApplySuccess {
  readonly success: true;
  readonly status: 'applied' | 'noop';
  readonly snapshot: RobloxSnapshot;
  readonly diagnostics: readonly RobloxDiagnostic[];
  readonly operationsAttempted: number;
  readonly initialSnapshotHash: string;
  readonly finalSnapshotHash: string;
}

export interface ApplyFailure {
  readonly success: false;
  readonly stage: ApplyFailureStage;
  readonly diagnostics: readonly RobloxDiagnostic[];
  readonly operationsAttempted: number;
  readonly rollback: RollbackResult;
  readonly initialSnapshotHash?: string;
  readonly observedFinalSnapshotHash?: string;
}

export type ApplyResult = ApplySuccess | ApplyFailure;
