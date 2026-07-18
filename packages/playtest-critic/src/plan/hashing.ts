import { createHash } from 'node:crypto';

import { stringifyCanonicalJson, type JsonValue } from '../json.js';
import type { PlaytestPlan } from './contract-schema.js';
import { normalizePlaytestPlan } from './normalize.js';

export function stringifyPlaytestPlan(input: Readonly<PlaytestPlan>): string {
  return stringifyCanonicalJson(normalizePlaytestPlan(input) as unknown as JsonValue);
}

export function hashPlaytestPlan(input: Readonly<PlaytestPlan>): string {
  return createHash('sha256').update(stringifyPlaytestPlan(input), 'utf8').digest('hex');
}
