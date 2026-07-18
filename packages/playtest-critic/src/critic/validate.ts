import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';

import {
  playtestDiagnostic,
  sortPlaytestDiagnostics,
  type PlaytestDiagnostic,
  type PlaytestValidationResult,
} from '../diagnostic.js';
import { inspectJsonCompatibility } from '../json.js';
import { stringifyCriticReport } from './hashing.js';
import { CriticReportSchema, type CriticReport } from './contract-schema.js';
import { evaluatePlaytestRun } from './evaluate.js';
import { deriveCriticFindingId } from './finding-id.js';
import { normalizeCriticReport } from './normalize.js';
import { CRITIC_RULES } from './rules.js';

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictNumbers: true,
  validateFormats: false,
});
const checkReport = ajv.compile(CriticReportSchema);

function schemaDiagnostics(
  errors: readonly ErrorObject[] | null | undefined,
): PlaytestDiagnostic[] {
  return (errors ?? []).map((error) =>
    playtestDiagnostic(
      'playtest.critic_report_invalid',
      error.instancePath,
      `Critic Report schema rejected ${error.keyword}.`,
    ),
  );
}

function semanticDiagnostics(report: Readonly<CriticReport>): PlaytestDiagnostic[] {
  const diagnostics: PlaytestDiagnostic[] = [];
  if (new Set(report.findings.map((finding) => finding.id)).size !== report.findings.length) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.critic_report_invalid',
        '/findings',
        'Finding IDs must be unique.',
      ),
    );
  }
  for (const [index, finding] of report.findings.entries()) {
    const rule = CRITIC_RULES[finding.code];
    if (
      finding.severity !== rule.severity ||
      finding.category !== rule.category ||
      finding.message !== rule.message ||
      finding.suggestionCode !== rule.suggestionCode
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.critic_report_invalid',
          `/findings/${index}`,
          'Finding metadata does not match its fixed Critic rule.',
        ),
      );
    }
    if (finding.id !== deriveCriticFindingId(finding)) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.critic_report_invalid',
          `/findings/${index}/id`,
          'Finding ID does not match its deterministic finding identity.',
        ),
      );
    }
  }
  const errors = report.findings.filter((finding) => finding.severity === 'error').length;
  const warnings = report.findings.length - errors;
  const expectedStatus = errors > 0 ? 'fail' : warnings > 0 ? 'pass_with_warnings' : 'pass';
  if (report.status !== expectedStatus) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.critic_report_invalid',
        '/status',
        'Critic status does not match finding severities.',
      ),
    );
  }
  if (stringifyCriticReport(report) !== stringifyCriticReport(normalizeCriticReport(report))) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.critic_report_invalid',
        '',
        'Critic Report normalization is unstable.',
      ),
    );
  }
  return diagnostics;
}

export function validateCriticReport(input: unknown): PlaytestValidationResult<CriticReport> {
  const compatibility = inspectJsonCompatibility(input);
  if (compatibility !== undefined) {
    return {
      valid: false,
      diagnostics: [playtestDiagnostic('json.invalid', compatibility.path, compatibility.reason)],
    };
  }
  if (!checkReport(input))
    return {
      valid: false,
      diagnostics: sortPlaytestDiagnostics(schemaDiagnostics(checkReport.errors)),
    };
  const report = input as CriticReport;
  const diagnostics = sortPlaytestDiagnostics(semanticDiagnostics(report));
  return diagnostics.length === 0
    ? { valid: true, value: normalizeCriticReport(report), diagnostics: [] }
    : { valid: false, diagnostics };
}

export function validateCriticReportAgainstInputs(
  planInput: unknown,
  runInput: unknown,
  reportInput: unknown,
): PlaytestValidationResult<CriticReport> {
  const reportResult = validateCriticReport(reportInput);
  if (!reportResult.valid) return reportResult;
  const evaluated = evaluatePlaytestRun(planInput, runInput);
  if (!evaluated.valid) return evaluated;
  if (stringifyCriticReport(reportResult.value) !== stringifyCriticReport(evaluated.value)) {
    return {
      valid: false,
      diagnostics: [
        playtestDiagnostic(
          'playtest.evaluation_source_mismatch',
          '',
          'Critic Report does not equal pure deterministic reevaluation of its inputs.',
        ),
      ],
    };
  }
  return reportResult;
}
