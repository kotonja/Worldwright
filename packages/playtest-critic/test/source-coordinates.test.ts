import { describe, expect, it } from 'vitest';

import { bindPlaytestSource } from '../src/plan/source.js';
import { buildPlaytestPlan } from '../src/plan/planner.js';
import { validatePlaytestPlanAgainstSources } from '../src/plan/trusted.js';
import {
  localToWorld,
  openingSidePoint,
  rectangleCenterHasAgentClearance,
  safeStairHallPoint,
  stairHallApproachContainsPoint,
} from '../src/plan/coordinates.js';
import { clone, readArchitectureInputs } from './helpers.js';

describe('Playtest source binding and coordinates', () => {
  it('binds the exact Cliffwatch Plan and Manifest without mutating either input', async () => {
    const { architecturePlan, manifest } = await readArchitectureInputs();
    const planBefore = JSON.stringify(architecturePlan);
    const manifestBefore = JSON.stringify(manifest);
    const result = bindPlaytestSource(architecturePlan, manifest);
    expect(result.valid).toBe(true);
    expect(JSON.stringify(architecturePlan)).toBe(planBefore);
    expect(JSON.stringify(manifest)).toBe(manifestBefore);
    if (!result.valid) return;
    expect(result.value.source.architecturePlanSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.value.source.robloxManifestSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.value.source.expectedManagedInstanceCount).toBe(400);
    expect(result.value.source.sourceWorldSpecSha256).not.toBe(
      result.value.source.manifestSourceWorldSpecSha256,
    );
  });

  it('rejects a Manifest from another project and a missing semantic room', async () => {
    const { architecturePlan, manifest } = await readArchitectureInputs();
    const wrongProject = clone(manifest);
    wrongProject.source.projectId = 'project-unrelated';
    expect(bindPlaytestSource(architecturePlan, wrongProject).valid).toBe(false);
    const missingRoom = clone(manifest);
    const roomNode = missingRoom.nodes.find((node) => node.id === 'foyer-grand');
    if (roomNode === undefined) throw new Error('Expected fixture room is missing.');
    roomNode.entityKind = 'route';
    roomNode.attributes.WorldwrightEntityKind = 'route';
    const result = bindPlaytestSource(architecturePlan, missingRoom);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.code === 'playtest.semantic_node_missing'),
    ).toBe(true);
  });

  it('uses exact quarter-turn coordinates and a supported exterior aperture setup', async () => {
    const { architecturePlan, manifest } = await readArchitectureInputs();
    const result = buildPlaytestPlan(architecturePlan, manifest);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    const foyer = result.value.checkpoints.find(
      (checkpoint) => checkpoint.type === 'room_center' && checkpoint.roomId === 'foyer-grand',
    );
    expect(foyer?.localPosition).toEqual({ x: -59.5, y: 3, z: -24.5 });
    expect(foyer?.worldPosition).toEqual({ x: 344.5, y: 67, z: -239.5 });
    const setup = result.value.checkpoints.find(
      (checkpoint) => checkpoint.id === result.value.setup.checkpointId,
    );
    expect(setup?.type).toBe('exterior_entrance');
    expect(setup?.localPosition.x).toBeGreaterThanOrEqual(-80);
    expect(setup?.localPosition.x).toBeLessThan(-78);
  });

  it.each(['id', 'name', 'property'] as const)(
    'rejects a substituted generated primitive %s',
    async (field) => {
      const { architecturePlan, manifest } = await readArchitectureInputs();
      const changed = clone(manifest);
      const node = changed.nodes.find(
        (candidate) => candidate.className === 'Part' && candidate.id.startsWith('archgen-'),
      );
      if (node === undefined || node.className !== 'Part')
        throw new Error('Expected generated fixture Part.');
      if (field === 'id') {
        node.id = 'archgen-substituted-generated-part';
        node.attributes.WorldwrightEntityId = node.id;
      } else if (field === 'name') node.name = 'Substituted Generated Part';
      else node.properties.position.x += 1;
      expect(bindPlaytestSource(architecturePlan, changed).valid).toBe(false);
    },
  );

  it('rejects source-bound Playtest coordinate and route drift without mutating trusted inputs', async () => {
    const { architecturePlan, manifest } = await readArchitectureInputs();
    const built = buildPlaytestPlan(architecturePlan, manifest);
    expect(built.valid).toBe(true);
    if (!built.valid) return;
    const trustedBefore = JSON.stringify({ architecturePlan, manifest });
    const coordinateDrift = clone(built.value);
    coordinateDrift.checkpoints[0]!.worldPosition.x += 1;
    expect(
      validatePlaytestPlanAgainstSources(coordinateDrift, architecturePlan, manifest).valid,
    ).toBe(false);
    const routeDrift = clone(built.value);
    routeDrift.segments[0]!.traversal =
      routeDrift.segments[0]!.traversal === 'door' ? 'open' : 'door';
    expect(validatePlaytestPlanAgainstSources(routeDrift, architecturePlan, manifest).valid).toBe(
      false,
    );
    expect(validatePlaytestPlanAgainstSources(built.value, architecturePlan, manifest).valid).toBe(
      true,
    );
    expect(JSON.stringify({ architecturePlan, manifest })).toBe(trustedBefore);
  });

  it('covers all quarter-turn yaws and rejects a door-side point outside its source space', async () => {
    const { architecturePlan } = await readArchitectureInputs();
    const local = { x: 2, y: 3, z: 5 };
    const expected = [
      { x: 322, y: 67, z: -175 },
      { x: 315, y: 67, z: -178 },
      { x: 318, y: 67, z: -185 },
      { x: 325, y: 67, z: -182 },
    ];
    for (const [index, yawDegrees] of [0, 90, 180, 270].entries()) {
      const changed = clone(architecturePlan);
      changed.building.yawDegrees = yawDegrees as 0 | 90 | 180 | 270;
      expect(localToWorld(changed, local)).toEqual(expected[index]);
    }
    const opening = architecturePlan.openings[0];
    const wall = architecturePlan.walls.find((candidate) => candidate.id === opening?.wallId);
    const room = architecturePlan.spaces.find((space) => space.type === 'room');
    if (opening === undefined || wall === undefined || room === undefined)
      throw new Error('Coordinate fixture source is incomplete.');
    expect(
      openingSidePoint(opening, wall, {
        ...room,
        rectangle: { x: 1_000, z: 1_000, width: 10, depth: 10 },
      }),
    ).toBeUndefined();
  });

  it('rejects invalid sources, wrong roots, missing openings, stair geometry, and source-hash drift', async () => {
    const { architecturePlan, manifest } = await readArchitectureInputs();
    expect(bindPlaytestSource({}, manifest).valid).toBe(false);
    expect(bindPlaytestSource(architecturePlan, {}).valid).toBe(false);
    for (const mutate of [
      (value: typeof manifest): void => {
        value.rootNodeId = 'foyer-grand';
      },
      (value: typeof manifest): void => {
        const opening = value.nodes.find((node) => node.entityKind === 'interaction');
        if (opening !== undefined) opening.parentId = value.rootNodeId;
      },
      (value: typeof manifest): void => {
        const step = value.nodes.find(
          (node) => node.className === 'Part' && node.name.startsWith('Stair Step'),
        );
        if (step !== undefined && step.className === 'Part') step.properties.size.y += 1;
      },
      (value: typeof manifest): void => {
        const root = value.nodes.find((node) => node.id === value.rootNodeId);
        if (root !== undefined) root.attributes.WorldwrightSourceHash = 'f'.repeat(64);
      },
    ]) {
      const changed = clone(manifest);
      mutate(changed);
      expect(bindPlaytestSource(architecturePlan, changed).valid).toBe(false);
    }
  });

  it('selects both safe stair-hall approach sides for both axes and all run directions', async () => {
    const { architecturePlan } = await readArchitectureInputs();
    const hallSource = architecturePlan.spaces.find((space) => space.type === 'stair_hall');
    const runSource = architecturePlan.stairRuns[0];
    if (hallSource === undefined || runSource === undefined)
      throw new Error('Stair coordinate fixture is incomplete.');
    for (const direction of ['negative_x', 'positive_x', 'negative_z', 'positive_z'] as const) {
      const xHall = { ...hallSource, rectangle: { x: 0, z: 0, width: 20, depth: 20 } };
      const xRun = {
        ...runSource,
        direction,
        core: { x: 0, z: 5, width: 20, depth: 10 },
      };
      expect(safeStairHallPoint(xHall, xRun, 'x', { x: 10, z: 2 })).toEqual({ x: 10, z: 2.5 });
      expect(safeStairHallPoint(xHall, xRun, 'x', { x: 10, z: 18 })).toEqual({ x: 10, z: 17.5 });
      expect(stairHallApproachContainsPoint(xHall, xRun, 'x', { x: 10, z: 10 })).toBe(false);
      const zHall = { ...hallSource, rectangle: { x: 0, z: 0, width: 20, depth: 20 } };
      const zRun = {
        ...runSource,
        direction,
        core: { x: 5, z: 0, width: 10, depth: 20 },
      };
      expect(safeStairHallPoint(zHall, zRun, 'z', { x: 2, z: 10 })).toEqual({ x: 2.5, z: 10 });
      expect(safeStairHallPoint(zHall, zRun, 'z', { x: 18, z: 10 })).toEqual({ x: 17.5, z: 10 });
      expect(stairHallApproachContainsPoint(zHall, zRun, 'z', { x: 10, z: 10 })).toBe(false);
    }
  });

  it('requires every deterministic stair-landing center to contain the fixed agent envelope', async () => {
    const { architecturePlan } = await readArchitectureInputs();
    const run = architecturePlan.stairRuns[0];
    if (run === undefined) throw new Error('Stair coordinate fixture is incomplete.');
    expect(rectangleCenterHasAgentClearance(run.landing.lower)).toBe(true);
    expect(rectangleCenterHasAgentClearance(run.landing.upper)).toBe(true);
    expect(rectangleCenterHasAgentClearance({ ...run.landing.lower, width: 2 })).toBe(false);
    expect(rectangleCenterHasAgentClearance({ ...run.landing.lower, depth: 2 })).toBe(false);
  });
});
