import { createHash } from 'node:crypto';

import { stringifyWorldSpec, type WorldSpec } from '@worldwright/worldspec';

import type { ArchitecturePlan } from './plan-schema.js';
import { stringifyArchitecturePlan } from './normalize.js';

/** Returns lowercase hexadecimal SHA-256 for a UTF-8 string. */
export function sha256Hex(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

/** Hashes the canonical normalized WorldSpec source representation. */
export function hashSourceWorldSpec(source: Readonly<WorldSpec>): string {
  return sha256Hex(stringifyWorldSpec(source));
}

export const hashWorldSpecSource = hashSourceWorldSpec;

/** Hashes the canonical normalized Architecture Plan representation. */
export function hashArchitecturePlan(plan: Readonly<ArchitecturePlan>): string {
  return sha256Hex(stringifyArchitecturePlan(plan));
}
