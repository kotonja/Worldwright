import { createHash } from 'node:crypto';

import { stringifyCanonicalJson, type JsonValue } from '../json.js';
import type { CriticReport } from './contract-schema.js';
import { normalizeCriticReport } from './normalize.js';

export function stringifyCriticReport(input: Readonly<CriticReport>): string {
  return stringifyCanonicalJson(normalizeCriticReport(input) as unknown as JsonValue);
}

export function hashCriticReport(input: Readonly<CriticReport>): string {
  return createHash('sha256').update(stringifyCriticReport(input), 'utf8').digest('hex');
}
