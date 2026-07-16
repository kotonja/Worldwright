import { Buffer } from 'node:buffer';

import { planRobloxChangeSet } from '@worldwright/roblox-compiler';
import { describe, expect, it } from 'vitest';

import { chunkStudioBatchOperations } from '../src/batch/chunk.js';
import { stringifyStudioBatchRequest } from '../src/batch/normalize.js';
import { buildStudioBatchBridgeProgram } from '../src/batch/program.js';
import { buildStudioBatchOperations } from '../src/batch/request.js';
import { measureFixedStudioBatchOuterPayloadBytes } from '../src/bridge/program.js';
import { STUDIO_MCP_MAX_PAYLOAD_BYTES } from '../src/constants.js';
import { emptySnapshot, loadCourtyardManifest } from './helpers.js';

function fixtureRequest() {
  const manifest = loadCourtyardManifest();
  const plan = planRobloxChangeSet(emptySnapshot(manifest), manifest);
  if (!plan.success) throw new Error('Fixture planning failed.');
  return chunkStudioBatchOperations({
    projectId: manifest.source.projectId,
    changeSetHash: 'a'.repeat(64),
    operations: buildStudioBatchOperations(plan.changeSet.operations, []),
  })[0]!.request;
}

describe('fixed Studio batch program', () => {
  it('uses one inert payload literal and retains the audited closed security surface', () => {
    const program = buildStudioBatchBridgeProgram(fixtureRequest());
    expect(program.source).not.toContain('__WORLDWRIGHT_VALIDATED_PAYLOAD__');
    expect(program.source).toContain('local MAX_BATCH_OPERATIONS = 32');
    expect(program.source).toContain('local function batchPayloadValid');
    expect(program.source).toContain('local function isSafeStoredNodeShape');
    expect(program.source).toContain('local function verifyInstance');
    expect(program.source).toContain('local function hasProtectedDescendant');
    expect(program.source).toContain(
      'local batchRoot, batchIndex, batchIndexError = buildProjectIndex(batchPayload.projectId)',
    );
    expect(program.source).toContain('return createAction(batchState)');
    expect(program.source).toContain('return updateAction(batchState)');
    expect(program.source).toContain('return deleteAction(batchState)');
    expect(program.source).toContain('node = operation.node');
    expect(program.source).toContain('beforeStateJson = operation.beforeStateJson');
    expect(program.source).toContain('afterParentState = operation.afterParentState');
    expect(program.source).not.toContain('for key, value in pairs(operation)');
    expect(program.source).toContain(
      'local finalRoot, finalIndex, finalIndexError = buildProjectIndex(batchPayload.projectId)',
    );
    expect(program.source).toContain('table.insert(completedOperationIds, operation.operationId)');
    expect(program.source).toContain('operationsApplied = #batchPayload.operations');
    expect(program.source).toContain(
      'code = "studio.engine_state_drift", message = "Studio batch final state verification failed."',
    );
    expect(Buffer.byteLength(program.source, 'utf8')).toBeLessThanOrEqual(
      STUDIO_MCP_MAX_PAYLOAD_BYTES,
    );
    expect(
      measureFixedStudioBatchOuterPayloadBytes(stringifyStudioBatchRequest(fixtureRequest())),
    ).toBeLessThanOrEqual(STUDIO_MCP_MAX_PAYLOAD_BYTES);
    for (const forbidden of [
      'loadstring',
      'ChangeHistoryService',
      'InsertService',
      'MarketplaceService',
      'DataStoreService',
      'HttpService:GetAsync',
      'require(',
    ]) {
      expect(program.source).not.toContain(forbidden);
    }
  });

  it('keeps delimiter collisions inert inside a deterministic long-bracket literal', () => {
    const request = fixtureRequest();
    const first = request.operations[0]!;
    if (first.type !== 'create') throw new Error('Expected create fixture.');
    const hostileName = ']] [=[ inert payload marker';
    const operations = buildStudioBatchOperations(
      [
        {
          type: 'create',
          id: first.operationId,
          node: { ...first.node, name: hostileName },
        },
      ],
      [],
    );
    const hostile = chunkStudioBatchOperations({
      projectId: first.node.attributes.WorldwrightProjectId,
      changeSetHash: 'b'.repeat(64),
      operations,
    })[0]!.request;
    const firstProgram = buildStudioBatchBridgeProgram(hostile);
    const secondProgram = buildStudioBatchBridgeProgram(structuredClone(hostile));
    expect(firstProgram.source).toBe(secondProgram.source);
    expect(firstProgram.source).toContain(hostileName);
    expect(firstProgram.source).toMatch(/local payloadJson = \[=+\[/u);
  });
});
