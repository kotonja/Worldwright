import { playtestDiagnostic, type PlaytestValidationResult } from '../diagnostic.js';
import type { PlaytestPlan } from './contract-schema.js';
import { hashPlaytestPlan } from './hashing.js';
import { buildPlaytestPlan } from './planner.js';
import { bindPlaytestSource } from './source.js';
import { validatePlaytestPlan } from './validate.js';

/**
 * Validates a reviewed Playtest Plan against the exact trusted Architecture Plan and Roblox
 * Manifest. In addition to all three closed schemas and source hashes, this rebuilds the complete
 * deterministic checkpoint/route plan so coordinate, circulation, setup, and coverage drift fail
 * before a live controller may start Play.
 */
export function validatePlaytestPlanAgainstSources(
  playtestPlanInput: unknown,
  architecturePlanInput: unknown,
  robloxManifestInput: unknown,
): PlaytestValidationResult<PlaytestPlan> {
  const planResult = validatePlaytestPlan(playtestPlanInput);
  if (!planResult.valid) return planResult;
  const binding = bindPlaytestSource(architecturePlanInput, robloxManifestInput);
  if (!binding.valid) return binding;
  const expected = buildPlaytestPlan(binding.value.architecturePlan, binding.value.manifest);
  if (!expected.valid) return expected;
  if (hashPlaytestPlan(planResult.value) !== hashPlaytestPlan(expected.value)) {
    return {
      valid: false,
      diagnostics: [
        playtestDiagnostic(
          'playtest.source_hash_mismatch',
          '',
          'Playtest Plan is not the exact deterministic plan for its trusted Architecture Plan and Roblox Manifest.',
        ),
      ],
    };
  }
  return { valid: true, value: planResult.value, diagnostics: [] };
}
