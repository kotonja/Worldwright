import type { RobloxChangeSetProgressResult } from '@worldwright/roblox-compiler';
import { Ajv2020 } from 'ajv/dist/2020.js';

import { STUDIO_PROGRESS_REPORT_VERSION } from './constants.js';
import { studioDiagnostic } from './diagnostics.js';
import {
  canonicalizeJsonValue,
  hashCanonicalJson,
  inspectJsonCompatibility,
  stringifyCanonicalJson,
  type JsonValue,
} from './json.js';
import { StudioProgressReportSchema } from './report-contract-schema.js';
import type { StudioProgressReport } from './report-types.js';
import type { StudioContractValidationResult } from './types.js';

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictNumbers: true,
  validateFormats: false,
});
const checkProgressReport = ajv.compile<StudioProgressReport>(StudioProgressReportSchema);

export function normalizeStudioProgressReport(
  report: Readonly<StudioProgressReport>,
): StudioProgressReport {
  return canonicalizeJsonValue(report as unknown as JsonValue) as StudioProgressReport;
}

export function stringifyStudioProgressReport(report: Readonly<StudioProgressReport>): string {
  return stringifyCanonicalJson(normalizeStudioProgressReport(report) as JsonValue);
}

export function hashStudioProgressReport(report: Readonly<StudioProgressReport>): string {
  return hashCanonicalJson(normalizeStudioProgressReport(report) as JsonValue);
}

export function validateStudioProgressReport(
  input: unknown,
): StudioContractValidationResult<StudioProgressReport> {
  try {
    const issue = inspectJsonCompatibility(input);
    if (issue !== undefined || !checkProgressReport(input)) {
      return {
        valid: false,
        diagnostics: [
          studioDiagnostic(
            'studio.response_invalid',
            issue?.path ?? '',
            'Studio Progress Report does not satisfy its strict contract.',
          ),
        ],
      };
    }
    const report = normalizeStudioProgressReport(input);
    if (report.classification !== 'unsafe' && report.appliedPrefixLength > report.operationsTotal) {
      return {
        valid: false,
        diagnostics: [
          studioDiagnostic(
            'studio.response_invalid',
            '/appliedPrefixLength',
            'Progress prefix length exceeds the complete operation count.',
          ),
        ],
      };
    }
    if (report.classification !== 'unsafe') {
      const hasNextOperation = 'nextOperationId' in report;
      const classificationValid =
        (report.classification === 'base' &&
          report.appliedPrefixLength === 0 &&
          report.observedSnapshotHash === report.baseSnapshotHash &&
          hasNextOperation === report.operationsTotal > 0) ||
        (report.classification === 'prefix' &&
          report.appliedPrefixLength > 0 &&
          report.appliedPrefixLength < report.operationsTotal &&
          hasNextOperation) ||
        (report.classification === 'complete' &&
          report.appliedPrefixLength === report.operationsTotal &&
          !hasNextOperation);
      if (!classificationValid) {
        return {
          valid: false,
          diagnostics: [
            studioDiagnostic(
              'studio.response_invalid',
              '/classification',
              'Progress classification, prefix length, total count, and next operation are inconsistent.',
            ),
          ],
        };
      }
    }
    return { valid: true, value: report, diagnostics: [] };
  } catch {
    return {
      valid: false,
      diagnostics: [
        studioDiagnostic(
          'studio.response_invalid',
          '',
          'Studio Progress Report could not be safely inspected.',
        ),
      ],
    };
  }
}

export function buildStudioProgressReport(
  result: Readonly<RobloxChangeSetProgressResult>,
): StudioProgressReport {
  let report: StudioProgressReport;
  if (result.success) {
    const common = {
      schemaVersion: STUDIO_PROGRESS_REPORT_VERSION,
      projectId: result.projectId,
      target: { service: 'Workspace' as const },
      baseSnapshotHash: result.baseSnapshotHash,
      observedSnapshotHash: result.observedSnapshotHash,
      changeSetHash: result.changeSetHash,
      operationsTotal: result.operationsTotal,
      appliedPrefixLength: result.appliedPrefixLength,
    };
    switch (result.classification) {
      case 'base':
        report = {
          ...common,
          classification: 'base',
          ...(result.nextOperationId === undefined
            ? {}
            : { nextOperationId: result.nextOperationId }),
        };
        break;
      case 'prefix':
        if (result.nextOperationId === undefined) {
          throw new Error('Studio Progress Report prefix invariant failed.');
        }
        report = { ...common, classification: 'prefix', nextOperationId: result.nextOperationId };
        break;
      case 'complete':
        report = { ...common, classification: 'complete' };
        break;
    }
  } else {
    report = {
      schemaVersion: STUDIO_PROGRESS_REPORT_VERSION,
      classification: 'unsafe',
      ...(result.projectId === undefined ? {} : { projectId: result.projectId }),
      ...(result.target === undefined ? {} : { target: { service: 'Workspace' as const } }),
      ...(result.baseSnapshotHash === undefined
        ? {}
        : { baseSnapshotHash: result.baseSnapshotHash }),
      ...(result.observedSnapshotHash === undefined
        ? {}
        : { observedSnapshotHash: result.observedSnapshotHash }),
      ...(result.changeSetHash === undefined ? {} : { changeSetHash: result.changeSetHash }),
      ...(result.operationsTotal === undefined ? {} : { operationsTotal: result.operationsTotal }),
      diagnostics: result.diagnostics.slice(0, 32).map((entry) => ({
        code: entry.code,
        severity: 'error' as const,
        path: entry.path,
        message: entry.message,
        ...(entry.relatedId === undefined ? {} : { relatedId: entry.relatedId }),
      })),
    };
  }
  const validation = validateStudioProgressReport(report);
  if (!validation.valid) throw new Error('Studio Progress Report invariant failed.');
  return validation.value;
}
