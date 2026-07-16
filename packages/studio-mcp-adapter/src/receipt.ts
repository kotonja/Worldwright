import type { ApplyResult, RobloxDiagnostic, RollbackResult } from '@worldwright/roblox-compiler';

import { STUDIO_APPLY_RECEIPT_VERSION, STUDIO_MCP_ADAPTER_VERSION } from './constants.js';
import { StudioAdapterError, studioDiagnostic } from './diagnostics.js';
import {
  containsLocalAbsolutePath,
  isBoundedCompilerDiagnosticPointer,
  removeUnsafePresentationCharacters,
  replaceUnsafePresentationCharacters,
} from './privacy.js';
import type {
  StudioApplyReceipt,
  StudioReceiptContext,
  StudioReceiptDiagnostic,
  StudioRollbackResult,
} from './types.js';
import { validateStudioApplyReceipt } from './validate.js';

function sanitizedMessage(message: string): string {
  if (containsLocalAbsolutePath(removeUnsafePresentationCharacters(message))) {
    return '[local-path]';
  }
  return replaceUnsafePresentationCharacters(message).replace(/\s+/gu, ' ').trim().slice(0, 1024);
}

function receiptDiagnostic(diagnostic: Readonly<RobloxDiagnostic>): StudioReceiptDiagnostic {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    path: isBoundedCompilerDiagnosticPointer(diagnostic.path) ? diagnostic.path : '',
    message: sanitizedMessage(diagnostic.message) || 'Transaction diagnostic was sanitized.',
    ...(diagnostic.relatedId === undefined
      ? {}
      : { relatedId: sanitizedMessage(diagnostic.relatedId).slice(0, 128) || '[redacted]' }),
  };
}

function receiptRollback(rollback: Readonly<RollbackResult>): StudioRollbackResult {
  if (!rollback.attempted) return { attempted: false, succeeded: false };
  if (rollback.succeeded) {
    return {
      attempted: true,
      succeeded: true,
      restoredSnapshotHash: rollback.restoredSnapshotHash,
    };
  }
  return {
    attempted: true,
    succeeded: false,
    diagnostics: rollback.diagnostics.map((entry) => receiptDiagnostic(entry)),
    ...(rollback.observedAfterRollbackSnapshotHash === undefined
      ? {}
      : { observedAfterRollbackSnapshotHash: rollback.observedAfterRollbackSnapshotHash }),
  };
}

/** Builds and revalidates sanitized transaction evidence without timestamps or raw payloads. */
export function buildStudioApplyReceipt(
  context: Readonly<StudioReceiptContext>,
  result: Readonly<ApplyResult>,
): StudioApplyReceipt {
  if (
    context.studio.placeId !== 0 ||
    context.studio.gameId !== 0 ||
    context.target.service !== 'Workspace' ||
    Object.keys(context.target).some((key) => key !== 'service')
  ) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.receipt_invalid',
        '',
        'Receipt context must identify the exact unsaved Workspace sandbox boundary.',
      ),
    ]);
  }
  if (
    result.success &&
    (result.initialSnapshotHash !== context.baseSnapshotHash ||
      result.finalSnapshotHash !== context.expectedResultSnapshotHash)
  ) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.receipt_invalid',
        '',
        'Successful transaction hashes do not match the receipt context.',
      ),
    ]);
  }
  const observedFailureSnapshotHash = result.success
    ? undefined
    : (result.observedFailureSnapshotHash ??
      (result.initialSnapshotHash !== undefined &&
      result.initialSnapshotHash !== context.baseSnapshotHash
        ? result.initialSnapshotHash
        : undefined));
  const common = {
    schemaVersion: STUDIO_APPLY_RECEIPT_VERSION,
    adapterVersion: STUDIO_MCP_ADAPTER_VERSION,
    studio: {
      studioId: sanitizedMessage(context.studio.studioId).slice(0, 256) || '[redacted]',
      placeName:
        sanitizedMessage(context.studio.placeName).slice(0, 256) || 'Unnamed Studio sandbox',
      placeId: context.studio.placeId,
      gameId: context.studio.gameId,
    },
    projectId: context.projectId,
    target: { service: context.target.service },
    changeSetHash: context.changeSetHash,
    baseSnapshotHash: context.baseSnapshotHash,
    desiredManifestHash: context.desiredManifestHash,
    expectedResultSnapshotHash: context.expectedResultSnapshotHash,
    operationsPlanned: context.operationsPlanned,
    operationsAttempted: result.operationsAttempted,
    diagnostics: result.diagnostics.map((entry) => receiptDiagnostic(entry)),
    ...(context.viewportEvidence === undefined
      ? {}
      : {
          viewportEvidence: {
            mediaType: context.viewportEvidence.mediaType,
            sha256: context.viewportEvidence.sha256,
            byteLength: context.viewportEvidence.byteLength,
          },
        }),
  };
  const receipt: StudioApplyReceipt = result.success
    ? {
        ...common,
        status: result.status,
        finalSnapshotHash: result.finalSnapshotHash,
      }
    : {
        ...common,
        status: 'failed',
        transactionStage: result.stage,
        rollback: receiptRollback(result.rollback),
        ...(observedFailureSnapshotHash === undefined ? {} : { observedFailureSnapshotHash }),
        ...(result.rollback.attempted && result.rollback.succeeded
          ? { finalSnapshotHash: result.rollback.restoredSnapshotHash }
          : {}),
      };
  const validation = validateStudioApplyReceipt(receipt);
  if (!validation.valid) throw new StudioAdapterError(validation.diagnostics);
  return validation.value;
}
