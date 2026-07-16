import { describe, expect, it } from 'vitest';

import { buildStudioBridgeProgram } from '../src/bridge/program.js';
import { encodeLuauLongBracketLiteral } from '../src/bridge/literal.js';
import { canonicalNodeMetadata } from '../src/engine-state.js';

function decodeEmbeddedPayload(source: string): unknown {
  const marker = 'local payloadJson = ';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('Fixed bridge payload assignment is missing.');
  const literal = source.slice(start + marker.length);
  const match = /^\[(=*)\[([\s\S]*?)\]\1\]/u.exec(literal);
  if (match === null) throw new Error('Fixed bridge payload literal is malformed.');
  return JSON.parse(match[2]!) as unknown;
}

describe('fixed Luau payload encoding', () => {
  it('chooses the shortest safe long-bracket delimiter', () => {
    expect(encodeLuauLongBracketLiteral('plain')).toBe('[[plain]]');
    expect(encodeLuauLongBracketLiteral('contains ]] delimiter')).toBe(
      '[=[contains ]] delimiter]=]',
    );
    expect(encodeLuauLongBracketLiteral('both ]] and ]=] delimiters')).toBe(
      '[==[both ]] and ]=] delimiters]==]',
    );
    expect(encodeLuauLongBracketLiteral('all ]] ]=] ]==]')).toBe('[===[all ]] ]=] ]==]]===]');
  });

  it('keeps adversarial names inert inside validated JSON', () => {
    const projectId = 'project-safe';
    const program = buildStudioBridgeProgram({
      protocolVersion: '0.1.0',
      action: 'snapshot',
      projectId,
    });
    expect(program.source).toContain(`"projectId": "${projectId}"`);
    expect(program.source).not.toContain('__WORLDWRIGHT_VALIDATED_PAYLOAD__');
  });

  it.each(['$&', '$`', "$'", '$$'])(
    'preserves the JavaScript replacement token %s as exact inert JSON',
    (replacementToken) => {
      const node = {
        id: 'world-root',
        entityKind: 'world' as const,
        name: `World ${replacementToken} Name`,
        attributes: {
          WorldwrightManaged: true as const,
          WorldwrightProjectId: 'project-safe',
          WorldwrightEntityId: 'world-root',
          WorldwrightEntityKind: 'world' as const,
          WorldwrightCompilerVersion: '0.1.0' as const,
          WorldwrightSourceHash: 'a'.repeat(64),
        },
        className: 'Folder' as const,
        properties: {},
      };
      const metadata = canonicalNodeMetadata(node);
      const request = {
        protocolVersion: '0.1.0' as const,
        action: 'create' as const,
        projectId: 'project-safe',
        node,
        stateJson: metadata.json,
        stateHash: metadata.hash,
      };

      expect(decodeEmbeddedPayload(buildStudioBridgeProgram(request).source)).toEqual(request);
    },
  );

  it('contains no dynamic execution, network, script, asset, or undo primitive', () => {
    const source = buildStudioBridgeProgram({
      protocolVersion: '0.1.0',
      action: 'probe',
    }).source;
    for (const forbidden of [
      'loadstring',
      'GetAsync',
      'PostAsync',
      'RequestAsync',
      'DataStoreService',
      'MarketplaceService',
      'InsertService',
      'ChangeHistoryService',
      'Instance.new("Script")',
      'Instance.new("LocalScript")',
      'Instance.new("ModuleScript")',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('keeps create parent-last, update metadata-last, and descendant checks iterative', () => {
    const source = buildStudioBridgeProgram({
      protocolVersion: '0.1.0',
      action: 'probe',
    }).source;
    const createStart = source.indexOf('local function setCreatedNodeState');
    const updateStart = source.indexOf('local function setUpdatedNodeState');
    const indexStart = source.indexOf('local function buildProjectIndex');
    const createBody = source.slice(createStart, updateStart);
    const updateBody = source.slice(updateStart, indexStart);

    expect(createBody.indexOf('setAdapterMetadata')).toBeLessThan(
      createBody.indexOf('instance.Parent = parent'),
    );
    expect(updateBody.indexOf('instance.Parent = parent')).toBeLessThan(
      updateBody.indexOf('setAdapterMetadata'),
    );
    expect(source).not.toContain('hasProtectedDescendant(child');
  });

  it('preflights stored metadata and engine state before constructing a snapshot response', () => {
    const source = buildStudioBridgeProgram({
      protocolVersion: '0.1.0',
      action: 'probe',
    }).source;
    const snapshotStart = source.indexOf('local function snapshotAction');
    const probeStart = source.indexOf('local function probeAction');
    const snapshotBody = source.slice(snapshotStart, probeStart);
    const storedNodeStart = source.indexOf('local function readStoredNode');
    const storedNodeEnd = source.indexOf('local function verifyStoredManagedInstance');
    const storedNodeBody = source.slice(storedNodeStart, storedNodeEnd);

    expect(source).toContain('local function readStoredNode(instance, projectId)');
    expect(source).toContain('or not hasOnlyKeys(node, NODE_KEYS)');
    expect(source).toContain('or not isEntityKind(node.entityKind)');
    expect(source).toContain('local MAX_INSTANCE_NAME_CODE_POINTS = 100');
    expect(source).toContain('local function isValidInstanceName(value)');
    expect(source).toContain('for _, codePoint in utf8.codes(value) do');
    expect(source).toContain('or not isValidInstanceName(node.name)');
    expect(source).toContain('or properties.anchored ~= true');
    expect(source).toContain('or properties.transparency > 1');
    expect(source).toContain('if #stateJson > MAX_NODE_STATE_BYTES then');
    expect(source).toContain('return nil, nil, nil, "studio.adapter_metadata_too_large"');
    expect(source).toContain('local function sha256Hex(message)');
    expect(source).toContain('local function sha256SelfTest()');
    expect(source).toContain('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(source).toContain('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(source).toContain('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    expect(source).toContain(
      'local hashed, computedStateHash = pcall(function() return sha256Hex(stateJson) end)',
    );
    expect(source).toContain('if not hashed or computedStateHash ~= stateHash then');
    expect(storedNodeBody.indexOf('computedStateHash ~= stateHash')).toBeLessThan(
      storedNodeBody.indexOf(
        'local decoded, node = pcall(function() return HttpService:JSONDecode(stateJson) end)',
      ),
    );
    expect(source).toContain(
      'local decoded, node = pcall(function() return HttpService:JSONDecode(stateJson) end)',
    );
    expect(source).toContain('attributeName ~= "WorldwrightStudioStateHash"');
    expect(source).toContain('local verified, valid, propertyName = pcall(function()');
    expect(source).toContain('return false, "studio.engine_state_drift", propertyName, nil');
    expect(snapshotBody.indexOf('verifyStoredManagedInstance')).toBeLessThan(
      snapshotBody.indexOf('local idTokens = array()'),
    );
    expect(snapshotBody).toContain(
      'local valid, validationCode, propertyName, node, stateHash = verifyStoredManagedInstance(',
    );
    expect(snapshotBody.indexOf('pcall(sha256SelfTest)')).toBeLessThan(
      snapshotBody.indexOf('Workspace:GetChildren()'),
    );
    expect(snapshotBody).toContain('selectedNodes[instance] = node');
    expect(snapshotBody.indexOf('table.sort(selectedInstances')).toBeLessThan(
      snapshotBody.indexOf('local encodedStateHashes'),
    );
    expect(snapshotBody.indexOf('local encodedStateHashes')).toBeLessThan(
      snapshotBody.indexOf('local compactNodes = array()'),
    );
    expect(snapshotBody).toContain('local frontCodedNames = frontCodeSortedNames(names)');
    expect(snapshotBody).toContain('local encodedStateHash = z85EncodeSha256(');
    expect(snapshotBody).toContain('stateHashesZ85 = stateHashesZ85');
    expect(snapshotBody).toContain('compactSnapshot = {');
    const primitiveTupleStart = snapshotBody.indexOf(
      'if node.className ~= "Folder" and node.className ~= "Model" then',
      snapshotBody.indexOf('local compactNodes = array()'),
    );
    const primitiveTupleEnd = snapshotBody.indexOf(
      'table.insert(compactNodes, tuple)',
      primitiveTupleStart,
    );
    expect(
      snapshotBody.slice(primitiveTupleStart, primitiveTupleEnd).match(/table\.insert\(tuple,/gu),
    ).toHaveLength(16);
    expect(snapshotBody).toContain('cumulativeMetadataBytes > MAX_RESULT_BYTES');
    expect(source).toContain('local MAX_STUDIO_OUTPUT_BYTES = 96 * 1024');
    expect(source).toContain(
      'if responseBytes > MAX_STUDIO_OUTPUT_BYTES or responseBytes > MAX_RESULT_BYTES then',
    );
  });

  it('checks every mutating payload name before its action can mutate Studio', () => {
    const source = buildStudioBridgeProgram({
      protocolVersion: '0.1.0',
      action: 'probe',
    }).source;
    const createBody = source.slice(
      source.indexOf('local function createAction(batchState)'),
      source.indexOf('local function updateAction(batchState)'),
    );
    const updateBody = source.slice(
      source.indexOf('local function updateAction(batchState)'),
      source.indexOf('local function deleteAction(batchState)'),
    );
    const deleteBody = source.slice(
      source.indexOf('local function deleteAction(batchState)'),
      source.lastIndexOf('if payload.protocolVersion'),
    );
    expect(createBody.indexOf('isValidInstanceName(node.name)')).toBeLessThan(
      createBody.indexOf('buildProjectIndex(payload.projectId)'),
    );
    expect(updateBody.indexOf('isValidInstanceName(before.name)')).toBeLessThan(
      updateBody.indexOf('buildProjectIndex(payload.projectId)'),
    );
    expect(updateBody.indexOf('isValidInstanceName(after.name)')).toBeLessThan(
      updateBody.indexOf('buildProjectIndex(payload.projectId)'),
    );
    expect(deleteBody.indexOf('isValidInstanceName(before.name)')).toBeLessThan(
      deleteBody.indexOf('buildProjectIndex(payload.projectId)'),
    );
  });

  it('indexes only selected-project descendants and keeps snapshot traversal separate', () => {
    const source = buildStudioBridgeProgram({
      protocolVersion: '0.1.0',
      action: 'probe',
    }).source;
    const indexStart = source.indexOf('local function buildProjectIndex');
    const resolveStart = source.indexOf('local function resolveParent');
    const indexBody = source.slice(indexStart, resolveStart);
    const snapshotStart = source.indexOf('local function snapshotAction');
    const probeStart = source.indexOf('local function probeAction');
    const snapshotBody = source.slice(snapshotStart, probeStart);

    expect(source).not.toContain('GetDescendants()');
    expect(source).toContain('local MAX_WORKSPACE_SCAN_INSTANCES = 65536');
    expect(source).toContain('local workspaceChildren = Workspace:GetChildren()');
    expect(source).toContain('scannedCount += #children');
    expect(source).toContain('if scannedCount > MAX_WORKSPACE_SCAN_INSTANCES then');
    expect(indexBody.match(/Workspace:GetChildren\(\)/gu)).toHaveLength(1);
    expect(indexBody).toContain('for _, child in ipairs(children) do');
    expect(indexBody).toContain('if isSelectedManaged(child, projectId) then');
    expect(indexBody).toContain('local pending = {root}');
    expect(indexBody).not.toContain('table.insert(pending, child)\n    end');
    expect(indexBody).toContain('if index[entityId] ~= nil then');
    expect(indexBody).not.toContain('root:GetDescendants');
    expect(snapshotBody).not.toContain('buildProjectIndex(');
    expect(snapshotBody.match(/Workspace:GetChildren\(\)/gu)).toHaveLength(1);
    expect(snapshotBody).toContain('selectedChildren[instance] = children');
  });

  it('supports exact root updates and verifies every resolved managed parent', () => {
    const source = buildStudioBridgeProgram({
      protocolVersion: '0.1.0',
      action: 'probe',
    }).source;

    expect(source).toContain('if root ~= nil and root ~= existingRoot then');
    expect(source).toContain('resolveParent(after, root, index, instance)');
    expect(source).toContain('expectedParent.attributes.WorldwrightProjectId ~= projectId');
    expect(source).toContain('index[expectedParent.id] ~= parent');
    expect(source).toContain('return verifyInstance(');
    const updateStart = source.indexOf('local function updateAction');
    const deleteStart = source.indexOf('local function deleteAction');
    const updateBody = source.slice(updateStart, deleteStart);
    expect(updateBody).toContain('payload.beforeParentState');
    expect(updateBody).toContain('payload.afterParentState');
    expect(updateBody.indexOf('payload.beforeParentState')).toBeLessThan(
      updateBody.indexOf('setUpdatedNodeState(instance, after'),
    );
  });

  it('verifies failed-create cleanup and reports uncertain cleanup distinctly', () => {
    const source = buildStudioBridgeProgram({
      protocolVersion: '0.1.0',
      action: 'probe',
    }).source;
    const cleanupStart = source.indexOf('local function cleanupFailedCreate');
    const compactHelpersStart = source.indexOf('local function normalizedNumber');
    const cleanupBody = source.slice(cleanupStart, compactHelpersStart);

    expect(cleanupBody).toContain('if #instance:GetChildren() ~= 0 then return false end');
    expect(cleanupBody).toContain('local destroyed = pcall(function() instance:Destroy() end)');
    expect(cleanupBody).toContain(
      'if finalError ~= nil or finalIndex[node.id] ~= nil then return false end',
    );
    expect(source).toContain('local cleanupObserved, cleanupComplete = pcall(function()');
    expect(source).toContain('"studio.create_cleanup_failed"');
  });

  it('assigns unmanaged ordinals within equal class-and-name groups only', () => {
    const source = buildStudioBridgeProgram({
      protocolVersion: '0.1.0',
      action: 'probe',
    }).source;
    const pathStart = source.indexOf('local structuralPath = parentId');
    const pathEnd = source.indexOf('if #structuralPath > 2048', pathStart);
    const pathBody = source.slice(pathStart, pathEnd);
    const lengthCheck = source.indexOf('#parentId + #child.className + #child.name + 16 > 2048');
    const duplicateKey = source.indexOf('local duplicateKey = child.className');

    expect(source).toContain('local duplicateKey = child.className .. "\\0" .. child.name');
    expect(source).toContain('local duplicateOrdinal = (duplicateCounts[duplicateKey] or 0) + 1');
    expect(pathBody.indexOf('child.className')).toBeLessThan(pathBody.indexOf('child.name'));
    expect(pathBody.indexOf('child.name')).toBeLessThan(
      pathBody.indexOf('tostring(duplicateOrdinal)'),
    );
    expect(source).toContain('ordinal = duplicateOrdinal');
    expect(lengthCheck).toBeLessThan(duplicateKey);
    expect(source).toContain('local compactUnmanagedRoots = array()');
    expect(source).toContain('nodeIndexById[unmanaged.parentId]');
    expect(source).toContain('unmanagedClassIndex[unmanaged.className]');
    expect(source).toContain('nameIndex[unmanaged.name]');
    expect(source).toContain('unmanaged.ordinal');
  });

  it('gates every managed-state action inside the fixed program immediately before dispatch', () => {
    const source = buildStudioBridgeProgram({
      protocolVersion: '0.1.0',
      action: 'probe',
    }).source;
    expect(source).toContain('if game.PlaceId ~= 0 or game.GameId ~= 0 then');
    expect(source).toContain('if RunService:IsRunning() then');
    const probeDispatch = source.lastIndexOf('if payload.action == "probe"');
    const gateCall = source.lastIndexOf('local gateFailure = sandboxGate()');
    const snapshotDispatch = source.lastIndexOf('if payload.action == "snapshot"');
    expect(probeDispatch).toBeLessThan(gateCall);
    expect(gateCall).toBeLessThan(snapshotDispatch);
  });
});
