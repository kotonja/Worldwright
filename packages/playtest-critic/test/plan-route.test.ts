import { describe, expect, it } from 'vitest';

import { hashPlaytestPlan, stringifyPlaytestPlan } from '../src/plan/hashing.js';
import { buildPlaytestPlan } from '../src/plan/planner.js';
import { validatePlaytestPlan } from '../src/plan/validate.js';
import type { PlaytestPlan } from '../src/plan/contract-schema.js';
import { clone, readArchitectureInputs } from './helpers.js';

describe('deterministic checkpoint and route planning', () => {
  it('generates byte-identical plans with complete Cliffwatch coverage', async () => {
    const inputs = await readArchitectureInputs();
    const first = buildPlaytestPlan(inputs.architecturePlan, inputs.manifest);
    const second = buildPlaytestPlan(inputs.architecturePlan, inputs.manifest);
    expect(first.valid).toBe(true);
    expect(second.valid).toBe(true);
    if (!first.valid || !second.valid) return;
    expect(stringifyPlaytestPlan(first.value)).toBe(stringifyPlaytestPlan(second.value));
    expect(hashPlaytestPlan(first.value)).toBe(hashPlaytestPlan(second.value));
    expect(first.value.requiredCoverage.rooms.count).toBe(13);
    expect(first.value.requiredCoverage.floors.count).toBe(2);
    expect(first.value.requiredCoverage.corridors.count).toBe(2);
    expect(first.value.requiredCoverage.stairRuns.count).toBe(1);
    expect(first.value.requiredCoverage.openings.count).toBe(20);
    expect(first.value.checkpoints.length).toBeLessThanOrEqual(128);
    expect(first.value.segments.length).toBeLessThanOrEqual(256);
    expect(first.value.captureCheckpoints.length).toBeLessThanOrEqual(8);
    expect(validatePlaytestPlan(first.value).valid).toBe(true);
  });

  it('uses explicit circulation edges and one navigation attempt for every contiguous segment', async () => {
    const inputs = await readArchitectureInputs();
    const result = buildPlaytestPlan(inputs.architecturePlan, inputs.manifest);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    const circulationIds = new Set(inputs.architecturePlan.circulationEdges.map((edge) => edge.id));
    result.value.segments.forEach((segment, index) => {
      expect(segment.sequence).toBe(index);
      expect(segment.maximumNavigationAttempts).toBe(1);
      expect(circulationIds.has(segment.sourceCirculationEdgeId)).toBe(true);
      if (index > 0)
        expect(result.value.segments[index - 1]?.toCheckpointId).toBe(segment.fromCheckpointId);
    });
    const visited = new Set(
      result.value.segments.flatMap((segment) => [
        segment.fromCheckpointId,
        segment.toCheckpointId,
      ]),
    );
    expect(result.value.requiredCoverage.checkpoints.ids.every((id) => visited.has(id))).toBe(true);
  });

  it('rejects sequence gaps, fabricated coverage, and unresolved captures', async () => {
    const inputs = await readArchitectureInputs();
    const result = buildPlaytestPlan(inputs.architecturePlan, inputs.manifest);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    const sequenceGap = clone(result.value);
    sequenceGap.segments[0]!.sequence = 2;
    expect(validatePlaytestPlan(sequenceGap).valid).toBe(false);
    const coverage = clone(result.value);
    coverage.requiredCoverage.rooms.count += 1;
    expect(validatePlaytestPlan(coverage).valid).toBe(false);
    const capture = clone(result.value);
    capture.captureCheckpoints.push('missing-checkpoint');
    expect(validatePlaytestPlan(capture).valid).toBe(false);
    const duplicateCheckpoint = clone(result.value);
    duplicateCheckpoint.checkpoints[1]!.id = duplicateCheckpoint.checkpoints[0]!.id;
    expect(validatePlaytestPlan(duplicateCheckpoint).valid).toBe(false);
  });

  it('is stable under source-array reordering and rejects disconnected explicit circulation', async () => {
    const inputs = await readArchitectureInputs();
    const canonical = buildPlaytestPlan(inputs.architecturePlan, inputs.manifest);
    expect(canonical.valid).toBe(true);
    if (!canonical.valid) return;
    const reordered = clone(inputs.architecturePlan);
    reordered.floors.reverse();
    reordered.spaces.reverse();
    reordered.walls.reverse();
    reordered.openings.reverse();
    reordered.stairRuns.reverse();
    reordered.circulationEdges.reverse();
    const reorderedResult = buildPlaytestPlan(reordered, inputs.manifest);
    expect(reorderedResult.valid).toBe(true);
    if (reorderedResult.valid)
      expect(stringifyPlaytestPlan(reorderedResult.value)).toBe(
        stringifyPlaytestPlan(canonical.value),
      );

    const disconnected = clone(inputs.architecturePlan);
    const isolatedSpace = disconnected.spaces.find((space) => space.type === 'room');
    expect(isolatedSpace).toBeDefined();
    if (isolatedSpace === undefined) return;
    const retainedEdges = disconnected.circulationEdges.filter(
      (edge) => edge.fromNodeId !== isolatedSpace.id && edge.toNodeId !== isolatedSpace.id,
    );
    disconnected.circulationEdges.splice(0, disconnected.circulationEdges.length, ...retainedEdges);
    expect(buildPlaytestPlan(disconnected, inputs.manifest).valid).toBe(false);
  });

  it('rejects unsafe JSON properties and proxy traps without executing accessors', async () => {
    const inputs = await readArchitectureInputs();
    const built = buildPlaytestPlan(inputs.architecturePlan, inputs.manifest);
    expect(built.valid).toBe(true);
    if (!built.valid) return;
    const symbolPlan = clone(built.value) as PlaytestPlan & { [key: symbol]: unknown };
    symbolPlan[Symbol('forged')] = true;
    expect(validatePlaytestPlan(symbolPlan).valid).toBe(false);
    const customArrayPlan = clone(built.value);
    (
      customArrayPlan.checkpoints as typeof customArrayPlan.checkpoints & { forged?: boolean }
    ).forged = true;
    expect(validatePlaytestPlan(customArrayPlan).valid).toBe(false);

    const accessorPlan = clone(built.value);
    let accessorCalls = 0;
    Object.defineProperty(accessorPlan.checkpoints, '0', {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorCalls += 1;
        return built.value.checkpoints[0];
      },
    });
    expect(validatePlaytestPlan(accessorPlan)).toMatchObject({
      valid: false,
      diagnostics: [{ code: 'json.invalid', path: '/checkpoints/0' }],
    });
    expect(accessorCalls).toBe(0);

    const trapped = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('untrusted proxy trap');
        },
      },
    );
    expect(validatePlaytestPlan(trapped)).toEqual({
      valid: false,
      diagnostics: [
        {
          code: 'json.invalid',
          message: 'the value could not be safely inspected',
          path: '',
        },
      ],
    });
  });
});
