import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import {
  STUDIO_MCP_PLAYTEST_MAX_CONSOLE_ENTRIES,
  STUDIO_MCP_PLAYTEST_MAX_CONSOLE_MESSAGE_BYTES,
  STUDIO_MCP_PLAYTEST_MAX_CONSOLE_TOTAL_BYTES,
} from '../constants.js';
import { compareCodePoints } from '../diagnostics.js';
import { inspectJsonCompatibility } from '../json.js';

export type StudioConsoleSeverity = 'error' | 'warning' | 'info';
export type StudioConsoleDataModelSource = 'Edit' | 'Server';
export type StudioConsoleClassificationCode =
  | 'console-error'
  | 'console-warning'
  | 'console-information'
  | 'console-output';

interface PrivateStudioConsoleEntry {
  readonly severity: StudioConsoleSeverity;
  readonly source: StudioConsoleDataModelSource;
  readonly messageSha256: string;
  readonly classificationCode: StudioConsoleClassificationCode;
}

/** @internal Hash-only normalized observation; raw messages are discarded during parsing. */
export interface StudioConsoleObservation {
  readonly valid: boolean;
  readonly complete: boolean;
  readonly exactEmptyText: boolean;
  readonly evidenceSha256: string;
  readonly entries: readonly PrivateStudioConsoleEntry[];
}

export interface SanitizedStudioConsoleEntry {
  readonly evidenceId: string;
  readonly severity: StudioConsoleSeverity;
  readonly dataModelSource: StudioConsoleDataModelSource;
  readonly messageSha256: string;
  readonly classificationCode: StudioConsoleClassificationCode;
  readonly isNew: boolean;
}

export interface SanitizedStudioConsoleEvidence {
  readonly baselineEvidenceSha256: string;
  readonly finalEvidenceSha256: string;
  readonly evidenceComplete: boolean;
  readonly newErrorCount: number;
  readonly newWarningCount: number;
  readonly entries: readonly SanitizedStudioConsoleEntry[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function oneAlias(value: Readonly<Record<string, unknown>>, aliases: readonly string[]): unknown {
  const present = aliases.filter((alias) => Object.hasOwn(value, alias));
  return present.length === 1 ? value[present[0]!] : undefined;
}

function severity(value: unknown):
  | Readonly<{
      severity: StudioConsoleSeverity;
      classification: StudioConsoleClassificationCode;
    }>
  | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replaceAll(/[_\s-]/gu, '').toLowerCase();
  if (new Set(['error', 'messageerror']).has(normalized)) {
    return { severity: 'error', classification: 'console-error' };
  }
  if (new Set(['warning', 'warn', 'messagewarning']).has(normalized)) {
    return { severity: 'warning', classification: 'console-warning' };
  }
  if (new Set(['info', 'information', 'messageinfo']).has(normalized)) {
    return { severity: 'info', classification: 'console-information' };
  }
  if (new Set(['output', 'print', 'messageoutput']).has(normalized)) {
    return { severity: 'info', classification: 'console-output' };
  }
  return undefined;
}

function dataModelSource(
  value: unknown,
  fallback: StudioConsoleDataModelSource,
): StudioConsoleDataModelSource | undefined {
  if (value === undefined) return fallback;
  if (value === 'Edit' || value === 'Server') return value;
  return undefined;
}

function readEntry(
  input: unknown,
  fallbackSource: StudioConsoleDataModelSource,
): PrivateStudioConsoleEntry | undefined {
  const value = record(input);
  if (value === undefined) return undefined;
  const allowed = new Set([
    'message',
    'text',
    'severity',
    'type',
    'messageType',
    'message_type',
    'source',
    'dataModelType',
    'datamodel_type',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  const message = oneAlias(value, ['message', 'text']);
  const kind = severity(oneAlias(value, ['severity', 'type', 'messageType', 'message_type']));
  const source = dataModelSource(
    oneAlias(value, ['source', 'dataModelType', 'datamodel_type']),
    fallbackSource,
  );
  if (
    typeof message !== 'string' ||
    message.length === 0 ||
    Buffer.byteLength(message, 'utf8') > STUDIO_MCP_PLAYTEST_MAX_CONSOLE_MESSAGE_BYTES ||
    kind === undefined ||
    source === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    severity: kind.severity,
    source,
    messageSha256: sha256(message),
    classificationCode: kind.classification,
  });
}

function invalidObservation(text: string): StudioConsoleObservation {
  return Object.freeze({
    valid: false,
    complete: false,
    exactEmptyText: false,
    evidenceSha256: sha256(text),
    entries: Object.freeze([]),
  });
}

/** Parse only bounded structured console data; raw messages never leave this module. */
export function observeStudioConsoleText(
  text: string,
  fallbackSource: StudioConsoleDataModelSource,
): StudioConsoleObservation {
  if (Buffer.byteLength(text, 'utf8') > STUDIO_MCP_PLAYTEST_MAX_CONSOLE_TOTAL_BYTES) {
    return invalidObservation(text);
  }
  // The current built-in Studio MCP returns exact empty text when the selected
  // DataModel has no console entries. Keep this compatibility case exact: any
  // nonempty unstructured text continues to fail closed below.
  if (text === '') {
    return Object.freeze({
      valid: true,
      complete: true,
      exactEmptyText: true,
      evidenceSha256: sha256(text),
      entries: Object.freeze([]),
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return invalidObservation(text);
  }
  if (inspectJsonCompatibility(parsed) !== undefined) return invalidObservation(text);
  let entriesValue: unknown;
  let complete = true;
  if (Array.isArray(parsed)) {
    entriesValue = parsed;
  } else {
    const envelope = record(parsed);
    if (envelope === undefined) return invalidObservation(text);
    const allowed = new Set(['entries', 'logs', 'truncated', 'complete']);
    if (Object.keys(envelope).some((key) => !allowed.has(key))) return invalidObservation(text);
    entriesValue = oneAlias(envelope, ['entries', 'logs']);
    if (Object.hasOwn(envelope, 'truncated')) {
      if (typeof envelope.truncated !== 'boolean') return invalidObservation(text);
      complete = complete && !envelope.truncated;
    }
    if (Object.hasOwn(envelope, 'complete')) {
      if (typeof envelope.complete !== 'boolean') return invalidObservation(text);
      complete = complete && envelope.complete;
    }
  }
  if (
    !Array.isArray(entriesValue) ||
    entriesValue.length > STUDIO_MCP_PLAYTEST_MAX_CONSOLE_ENTRIES
  ) {
    return invalidObservation(text);
  }
  const entries = entriesValue.map((entry) => readEntry(entry, fallbackSource));
  if (entries.some((entry) => entry === undefined)) return invalidObservation(text);
  return Object.freeze({
    valid: true,
    complete,
    exactEmptyText: false,
    evidenceSha256: sha256(text),
    entries: Object.freeze(entries as PrivateStudioConsoleEntry[]),
  });
}

function fingerprint(entry: PrivateStudioConsoleEntry): string {
  return `${entry.severity}\u0000${entry.source}\u0000${entry.classificationCode}\u0000${entry.messageSha256}`;
}

/**
 * Deterministically compare two bounded observations. Without stable entry IDs,
 * only an exact retained baseline prefix is sufficient evidence of new output.
 */
export function sanitizeStudioConsoleEvidence(
  baselineText: string,
  finalText: string,
  baselineSource: StudioConsoleDataModelSource = 'Edit',
  finalSource: StudioConsoleDataModelSource = 'Server',
  maximumSummaryEntries = 64,
): SanitizedStudioConsoleEvidence {
  return sanitizeStudioConsoleObservations(
    observeStudioConsoleText(baselineText, baselineSource),
    observeStudioConsoleText(finalText, finalSource),
    maximumSummaryEntries,
  );
}

/** @internal Compare two already hash-normalized observations without retaining raw text. */
export function sanitizeStudioConsoleObservations(
  baseline: Readonly<StudioConsoleObservation>,
  final: Readonly<StudioConsoleObservation>,
  maximumSummaryEntries = 64,
): SanitizedStudioConsoleEvidence {
  const prefixMatches =
    baseline.entries.length <= final.entries.length &&
    baseline.entries.every(
      (entry, index) => fingerprint(entry) === fingerprint(final.entries[index]!),
    );
  // An exact empty final Server result proves that the running DataModel
  // retained no console entries, even when the separate Edit baseline used a
  // nonempty legacy text presentation. No other unstructured result receives
  // this exception.
  const evidenceComplete =
    (final.valid && final.complete && final.exactEmptyText) ||
    (baseline.valid && final.valid && baseline.complete && final.complete && prefixMatches);
  const newEntries = evidenceComplete ? final.entries.slice(baseline.entries.length) : [];
  const sortedSummary = newEntries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (left, right) =>
        compareCodePoints(left.entry.messageSha256, right.entry.messageSha256) ||
        left.index - right.index,
    )
    .slice(0, Math.max(0, Math.min(64, maximumSummaryEntries)))
    .map(({ entry, index }) =>
      Object.freeze({
        evidenceId: `console-${String(index).padStart(3, '0')}`,
        severity: entry.severity,
        dataModelSource: entry.source,
        messageSha256: entry.messageSha256,
        classificationCode: entry.classificationCode,
        isNew: true,
      }),
    );
  return Object.freeze({
    baselineEvidenceSha256: baseline.evidenceSha256,
    finalEvidenceSha256: final.evidenceSha256,
    evidenceComplete,
    newErrorCount: newEntries.filter((entry) => entry.severity === 'error').length,
    newWarningCount: newEntries.filter((entry) => entry.severity === 'warning').length,
    entries: Object.freeze(sortedSummary),
  });
}
