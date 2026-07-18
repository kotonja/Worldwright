import { createHash } from 'node:crypto';

import { stringifyCanonicalJson, type JsonValue } from '../json.js';
import type { PlaytestRunReport } from './contract-schema.js';
import { normalizePlaytestRunReport } from './normalize.js';

export function stringifyPlaytestRunReport(input: Readonly<PlaytestRunReport>): string {
  return stringifyCanonicalJson(normalizePlaytestRunReport(input) as unknown as JsonValue);
}

export function hashPlaytestRunReport(input: Readonly<PlaytestRunReport>): string {
  return createHash('sha256').update(stringifyPlaytestRunReport(input), 'utf8').digest('hex');
}
