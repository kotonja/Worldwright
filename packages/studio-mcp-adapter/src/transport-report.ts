import { Ajv2020 } from 'ajv/dist/2020.js';

import { STUDIO_MCP_MAX_BATCH_OPERATIONS, STUDIO_TRANSPORT_REPORT_VERSION } from './constants.js';
import { sortStudioDiagnostics, studioDiagnostic } from './diagnostics.js';
import {
  canonicalizeJsonValue,
  hashCanonicalJson,
  inspectJsonCompatibility,
  stringifyCanonicalJson,
  type JsonValue,
} from './json.js';
import { StudioTransportReportSchema } from './report-contract-schema.js';
import type { StudioContractValidationResult } from './types.js';
import type {
  StudioTransportCounters,
  StudioTransportFinalOutcome,
  StudioTransportReport,
} from './report-types.js';

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictNumbers: true,
  validateFormats: false,
});
const checkTransportReport = ajv.compile<StudioTransportReport>(StudioTransportReportSchema);

export function normalizeStudioTransportReport(
  report: Readonly<StudioTransportReport>,
): StudioTransportReport {
  return canonicalizeJsonValue(report as unknown as JsonValue) as StudioTransportReport;
}

export function stringifyStudioTransportReport(report: Readonly<StudioTransportReport>): string {
  return stringifyCanonicalJson(normalizeStudioTransportReport(report) as JsonValue);
}

export function hashStudioTransportReport(report: Readonly<StudioTransportReport>): string {
  return hashCanonicalJson(normalizeStudioTransportReport(report) as JsonValue);
}

function semanticDiagnostics(report: Readonly<StudioTransportReport>) {
  const diagnostics = [];
  const hasCompensation =
    report.compensationOperationsAttempted !== 0 ||
    report.compensationOperationsApplied !== 0 ||
    report.compensationChunksAttempted !== 0 ||
    report.compensationChunksCompleted !== 0;
  const hasRecovery =
    report.uncertainTransportEvents !== 0 ||
    report.reconnectAttempts !== 0 ||
    report.reconnectsSucceeded !== 0 ||
    hasCompensation;
  const hasLeaseBoundActivity =
    report.operationsAttempted !== 0 ||
    report.operationsAppliedBeforeFailure !== 0 ||
    report.chunksAttempted !== 0 ||
    report.chunksCompleted !== 0 ||
    report.mutationExecuteCalls !== 0 ||
    hasRecovery;
  if (
    report.operationsAppliedBeforeFailure > report.operationsAttempted ||
    report.operationsAttempted > report.operationsPlanned ||
    (report.operationsAttempted > 0 && report.chunksAttempted === 0) ||
    (report.operationsAppliedBeforeFailure > 0 && report.chunksAttempted === 0)
  ) {
    diagnostics.push(
      studioDiagnostic(
        'studio.receipt_invalid',
        '/operationsAttempted',
        'Transport operation counts are inconsistent.',
      ),
    );
  }
  if (
    report.chunksCompleted > report.chunksAttempted ||
    report.chunksAttempted > report.chunksPlanned
  ) {
    diagnostics.push(
      studioDiagnostic(
        'studio.receipt_invalid',
        '/chunksAttempted',
        'Transport forward chunk counts are inconsistent.',
      ),
    );
  }
  if (
    report.compensationOperationsApplied > report.compensationOperationsAttempted ||
    report.compensationChunksCompleted > report.compensationChunksAttempted ||
    (report.compensationOperationsAttempted > 0 && report.compensationChunksAttempted === 0) ||
    (report.compensationOperationsApplied > 0 && report.compensationChunksAttempted === 0) ||
    (report.compensationChunksCompleted > 0 && report.compensationOperationsApplied === 0)
  ) {
    diagnostics.push(
      studioDiagnostic(
        'studio.receipt_invalid',
        '/compensationChunksAttempted',
        'Transport compensation counts are inconsistent.',
      ),
    );
  }
  // A compensation apply_chunk call can be rejected by the lease guard before
  // it becomes an attempted compensation chunk. The execute call remains
  // truthful evidence, while the compensation counters remain unchanged.
  if (
    report.reconnectsSucceeded > report.reconnectAttempts ||
    report.reconnectAttempts > report.uncertainTransportEvents ||
    report.mutationExecuteCalls < report.chunksAttempted + report.compensationChunksAttempted ||
    report.mutationExecuteCalls > report.chunksAttempted + report.compensationChunksAttempted + 1 ||
    (report.mutationExecuteCalls ===
      report.chunksAttempted + report.compensationChunksAttempted + 1 &&
      report.finalOutcome !== 'failed-unrestored')
  ) {
    diagnostics.push(
      studioDiagnostic(
        'studio.receipt_invalid',
        '/mutationExecuteCalls',
        'Transport call or reconnect counts are inconsistent.',
      ),
    );
  }
  if (
    (hasLeaseBoundActivity && report.sandboxLeaseClaimCalls !== 1) ||
    (report.operationsPlanned === 0 && report.sandboxLeaseClaimCalls !== 0)
  ) {
    diagnostics.push(
      studioDiagnostic(
        'studio.receipt_invalid',
        '/sandboxLeaseClaimCalls',
        'Transport activity requires exactly one sandbox lease claim call.',
      ),
    );
  }
  if (
    report.finalOutcome === 'noop' &&
    (report.operationsPlanned !== 0 ||
      report.operationsAttempted !== 0 ||
      report.operationsAppliedBeforeFailure !== 0 ||
      report.chunksPlanned !== 0 ||
      report.chunksAttempted !== 0 ||
      report.chunksCompleted !== 0 ||
      report.sandboxLeaseClaimCalls !== 0 ||
      report.mutationExecuteCalls !== 0 ||
      hasRecovery)
  ) {
    diagnostics.push(
      studioDiagnostic(
        'studio.receipt_invalid',
        '/finalOutcome',
        'A no-op transport report must contain no planned or attempted mutation.',
      ),
    );
  }
  if (
    report.finalOutcome === 'applied' &&
    (report.operationsPlanned === 0 ||
      report.operationsAttempted !== report.operationsPlanned ||
      report.operationsAppliedBeforeFailure !== report.operationsPlanned ||
      report.sandboxLeaseClaimCalls !== 1 ||
      report.chunksPlanned <
        Math.ceil(report.operationsPlanned / STUDIO_MCP_MAX_BATCH_OPERATIONS) ||
      report.chunksPlanned > report.operationsPlanned ||
      report.chunksAttempted !== report.chunksPlanned ||
      report.chunksCompleted !== report.chunksPlanned ||
      hasRecovery)
  ) {
    diagnostics.push(
      studioDiagnostic(
        'studio.receipt_invalid',
        '/finalOutcome',
        'An applied transport report must acknowledge every planned operation and chunk.',
      ),
    );
  }
  if (report.finalOutcome === 'failed-unsafe' && hasCompensation) {
    diagnostics.push(
      studioDiagnostic(
        'studio.receipt_invalid',
        '/finalOutcome',
        'A failed-unsafe report must stop before any compensating mutation call.',
      ),
    );
  }
  if (
    (report.finalOutcome === 'failed-restored' || report.finalOutcome === 'failed-unsafe') &&
    report.operationsPlanned === 0
  ) {
    diagnostics.push(
      studioDiagnostic(
        'studio.receipt_invalid',
        '/finalOutcome',
        'Restored and unsafe failures require a nonempty planned transaction.',
      ),
    );
  }
  return sortStudioDiagnostics(diagnostics);
}

export function validateStudioTransportReport(
  input: unknown,
): StudioContractValidationResult<StudioTransportReport> {
  try {
    const issue = inspectJsonCompatibility(input);
    if (issue !== undefined || !checkTransportReport(input)) {
      return {
        valid: false,
        diagnostics: [
          studioDiagnostic(
            'studio.receipt_invalid',
            issue?.path ?? '',
            'Studio Transport Report does not satisfy its strict contract.',
          ),
        ],
      };
    }
    const report = normalizeStudioTransportReport(input);
    const diagnostics = semanticDiagnostics(report);
    return diagnostics.length === 0
      ? { valid: true, value: report, diagnostics: [] }
      : { valid: false, diagnostics };
  } catch {
    return {
      valid: false,
      diagnostics: [
        studioDiagnostic(
          'studio.receipt_invalid',
          '',
          'Studio Transport Report could not be safely inspected.',
        ),
      ],
    };
  }
}

export function buildStudioTransportReport(
  counters: Readonly<StudioTransportCounters>,
  finalOutcome: StudioTransportFinalOutcome,
): StudioTransportReport {
  const report: StudioTransportReport = {
    schemaVersion: STUDIO_TRANSPORT_REPORT_VERSION,
    mode: 'chunked',
    ...counters,
    finalOutcome,
  };
  const validation = validateStudioTransportReport(report);
  if (!validation.valid) {
    throw new Error('Studio Transport Report invariant failed.');
  }
  return validation.value;
}
