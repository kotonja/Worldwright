import { readFileSync } from 'node:fs';

import {
  hashPlaytestPlan,
  validatePlaytestPlan,
  type PlaytestPlan,
} from '@worldwright/playtest-critic';
import {
  hashRobloxChangeSet,
  validateRobloxChangeSet,
  validateRobloxManifest,
  type RobloxChangeSet,
  type RobloxManifest,
} from '@worldwright/roblox-compiler';
import { describe, expect, it, vi } from 'vitest';

import type { AllowedStudioMcpToolName } from '../src/mcp/capabilities.js';
import type { StudioMcpProtocol } from '../src/mcp/client.js';
import {
  STUDIO_BRIDGE_RESPONSE_PREFIX,
  STUDIO_PLAYTEST_PROBE_RESPONSE_PREFIX,
  STUDIO_SANDBOX_LEASE_RESPONSE_PREFIX,
} from '../src/constants.js';
import { compactSnapshotFixture } from '../scripts/compact-snapshot-fixture.js';
import type {
  StudioPlaytestIdentity,
  StudioPlaytestProbeRequest,
  StudioPlaytestVector,
} from '../src/playtest/types.js';
import {
  connectStudioPlaytestMcpForTesting,
  createStudioPlaytestControllerForTesting,
} from '../src/testing.js';
import { VALID_JPEG_BYTES } from './image-fixtures.js';

interface SharedPlaytestState {
  active: boolean;
  running: boolean;
  position: StudioPlaytestVector;
  startCalls: number;
  navigationCalls: number;
  stopCalls: number;
  captureCalls: number;
  trace: string[];
  loseStartAcknowledgment: boolean;
  loseNavigationAcknowledgment: boolean;
  loseStopAcknowledgment: boolean;
  failStartBeforeRunning: boolean;
  losePostStartStateObservation: boolean;
  startAcknowledgmentText: string | undefined;
  navigationAcknowledgmentText: string | undefined;
  stopAcknowledgmentText: string | undefined;
  studioStateFailuresRemaining: number;
  identityProbeFailuresRemaining: number;
  playerCount: number;
  characterReady: boolean;
  alive: boolean;
  health: number;
  maximumHealth: number;
  humanoidState: string;
  supported: boolean;
  pathStatus: 'success' | 'no_path' | 'jump_required';
  clearanceSupported: boolean;
  bodyClear: boolean;
  headClear: boolean;
  captureUnavailable: boolean;
  captureTimesOut: boolean;
  stopFailuresBeforeStopping: number;
  acknowledgeStopWithoutStopping: boolean;
  setupFailure: boolean;
  unmanagedRootPresent: boolean;
  forcedCurrentLevel: number | undefined;
  forcedCurrentFloorId: string | undefined;
  lastPathRequest:
    | Extract<StudioPlaytestProbeRequest, { readonly action: 'path_probe' }>
    | undefined;
  lastPlayerStateRequest:
    | Extract<StudioPlaytestProbeRequest, { readonly action: 'player_state' }>
    | undefined;
}

function tools(): readonly unknown[] {
  return [
    { name: 'list_roblox_studios', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'set_active_studio',
      inputSchema: {
        type: 'object',
        properties: { studio_id: { type: 'string' } },
        required: ['studio_id'],
      },
    },
    { name: 'get_studio_state', inputSchema: { type: 'object', properties: {}, required: [] } },
    {
      name: 'start_stop_play',
      inputSchema: {
        type: 'object',
        properties: { is_start: { type: 'boolean' } },
        required: ['is_start'],
      },
    },
    { name: 'get_console_output', inputSchema: { type: 'object', properties: {}, required: [] } },
    {
      name: 'character_navigation',
      inputSchema: {
        type: 'object',
        properties: {
          datamodel_type: { type: 'string', enum: ['Client'] },
          instance_path: { type: 'string' },
          speed_multiplier: { type: 'number' },
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
        },
        required: ['datamodel_type'],
      },
    },
    {
      name: 'screen_capture',
      inputSchema: {
        type: 'object',
        properties: {
          capture_id: { type: 'string' },
          camera_position: { type: 'array', items: { type: 'number' } },
          look_at_position: { type: 'array', items: { type: 'number' } },
        },
        required: ['capture_id'],
      },
    },
    {
      name: 'execute_luau',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          datamodel_type: { type: 'string', enum: ['Edit', 'Client', 'Server'] },
        },
        required: ['code', 'datamodel_type'],
      },
    },
  ];
}

function text(value: string): unknown {
  return { content: [{ type: 'text', text: value }], isError: false };
}

function payload(source: string): StudioPlaytestProbeRequest | { readonly action: string } {
  const marker = 'local payloadJson = ';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('missing fixed payload');
  const literal = source.slice(start + marker.length);
  const match = /^\[(=*)\[([\s\S]*?)\]\1\]/u.exec(literal);
  if (match === null) throw new Error('invalid fixed payload');
  return JSON.parse(match[2]!) as StudioPlaytestProbeRequest | { readonly action: string };
}

function playtestFrame(value: Readonly<Record<string, unknown>>): unknown {
  return text(`${STUDIO_PLAYTEST_PROBE_RESPONSE_PREFIX}${JSON.stringify(value)}\n`);
}

class FakePlaytestProtocol implements StudioMcpProtocol {
  public constructor(
    readonly shared: SharedPlaytestState,
    readonly manifest: RobloxManifest,
  ) {}

  public async connect(): Promise<void> {}

  public async listTools(): Promise<unknown> {
    return { tools: tools() };
  }

  public async invoke(
    tool: AllowedStudioMcpToolName,
    argumentsValue: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    this.shared.trace.push(tool);
    switch (tool) {
      case 'list_roblox_studios':
        return text(
          JSON.stringify({
            studios: [{ id: 'studio-test', name: 'Unsaved Sandbox', active: this.shared.active }],
          }),
        );
      case 'set_active_studio':
        this.shared.active = argumentsValue.studio_id === 'studio-test';
        return text(JSON.stringify({ selected: this.shared.active }));
      case 'get_studio_state':
        if (this.shared.studioStateFailuresRemaining > 0) {
          this.shared.studioStateFailuresRemaining -= 1;
          throw new Error('lost Studio state observation');
        }
        return text(
          JSON.stringify({
            play_state: this.shared.running ? 'Running' : 'NotRunning',
            available_datamodel_types: this.shared.running ? ['Client', 'Server'] : ['Edit'],
          }),
        );
      case 'start_stop_play': {
        const starting = argumentsValue.is_start === true;
        if (starting) {
          this.shared.startCalls += 1;
          if (this.shared.failStartBeforeRunning) {
            throw new Error('start failed before running');
          }
          this.shared.running = true;
          if (this.shared.losePostStartStateObservation) {
            this.shared.losePostStartStateObservation = false;
            this.shared.studioStateFailuresRemaining += 1;
          }
          if (this.shared.loseStartAcknowledgment) {
            this.shared.loseStartAcknowledgment = false;
            throw new Error('lost start acknowledgment');
          }
        } else {
          this.shared.stopCalls += 1;
          if (this.shared.stopFailuresBeforeStopping > 0) {
            this.shared.stopFailuresBeforeStopping -= 1;
            throw new Error('stop failed before stopping');
          }
          if (this.shared.acknowledgeStopWithoutStopping) {
            return text(
              this.shared.stopAcknowledgmentText ??
                JSON.stringify({
                  success: true,
                  output: [],
                  outputCount: 0,
                  message: 'Playtest stop signal sent.',
                }),
            );
          }
          this.shared.running = false;
          if (this.shared.loseStopAcknowledgment) {
            this.shared.loseStopAcknowledgment = false;
            throw new Error('lost stop acknowledgment');
          }
        }
        return text(
          starting
            ? (this.shared.startAcknowledgmentText ??
                JSON.stringify({ success: true, message: 'Playtest started in play mode' }))
            : (this.shared.stopAcknowledgmentText ??
                JSON.stringify({
                  success: true,
                  output: [],
                  outputCount: 0,
                  message: 'Playtest stop signal sent.',
                })),
        );
      }
      case 'get_console_output':
        return text(
          JSON.stringify({
            entries: this.shared.running
              ? [{ message: 'sensitive console text', type: 'MessageWarning', source: 'Server' }]
              : [],
            complete: true,
          }),
        );
      case 'character_navigation':
        this.shared.navigationCalls += 1;
        this.shared.position = {
          x: argumentsValue.x as number,
          y: argumentsValue.y as number,
          z: argumentsValue.z as number,
        };
        if (this.shared.loseNavigationAcknowledgment) {
          this.shared.loseNavigationAcknowledgment = false;
          throw new Error('lost navigation acknowledgment');
        }
        return text(
          this.shared.navigationAcknowledgmentText ??
            JSON.stringify({
              success: true,
              method: 'pathfinding',
              position: [this.shared.position.x, this.shared.position.y, this.shared.position.z],
            }),
        );
      case 'execute_luau': {
        const source = argumentsValue.code;
        if (typeof source !== 'string') throw new Error('missing fixed source');
        const decoded = payload(source);
        this.shared.trace.push(
          `execute:${String(argumentsValue.datamodel_type)}:${decoded.action}`,
        );
        if (argumentsValue.datamodel_type === 'Edit') {
          if (decoded.action === 'bound_snapshot') {
            return text(
              `${STUDIO_SANDBOX_LEASE_RESPONSE_PREFIX}${JSON.stringify({
                protocolVersion: '0.1.0',
                action: 'bound_snapshot',
                ok: true,
                compactSnapshot: compactSnapshotFixture(
                  this.manifest.source.projectId,
                  this.manifest.nodes,
                  this.shared.unmanagedRootPresent
                    ? [
                        {
                          parentEntityId: this.manifest.rootNodeId,
                          className: 'Folder',
                          name: 'Foreign Child',
                          structuralPath: `${this.manifest.rootNodeId}/Foreign Child`,
                          ordinal: 1,
                        },
                      ]
                    : [],
                ),
              })}\n`,
            );
          }
          return text(
            `${STUDIO_BRIDGE_RESPONSE_PREFIX}${JSON.stringify({
              protocolVersion: '0.1.0',
              action: 'probe',
              ok: true,
              probe: {
                placeId: 0,
                gameId: 0,
                placeName: 'Unsaved Sandbox',
                isRunning: false,
                isEditAvailable: true,
              },
            })}\n`,
          );
        }
        if (argumentsValue.datamodel_type !== 'Server' || !this.shared.running) {
          throw new Error('unexpected playtest execution lane');
        }
        const request = decoded as StudioPlaytestProbeRequest;
        if (request.action === 'identity_probe') {
          if (this.shared.identityProbeFailuresRemaining > 0) {
            this.shared.identityProbeFailuresRemaining -= 1;
            throw new Error('identity probe unavailable');
          }
          return playtestFrame({
            protocolVersion: '0.1.0',
            action: request.action,
            ok: true,
            projectIdentityMatched: true,
            rootIdentityMatched: true,
            managedNodeCount: this.manifest.nodes.length,
            playerCount: this.shared.playerCount,
            characterReady: this.shared.characterReady,
            dataModelType: 'Server',
            playRunning: true,
          });
        }
        if (request.action === 'character_setup') {
          if (this.shared.setupFailure) {
            return playtestFrame({
              protocolVersion: '0.1.0',
              action: request.action,
              ok: false,
              diagnostic: {
                code: 'studio.playtest_character_unavailable',
                message: 'The fixed setup failed.',
              },
            });
          }
          this.shared.position = { ...request.setupPosition };
          return playtestFrame({
            protocolVersion: '0.1.0',
            action: request.action,
            ok: true,
            position: this.shared.position,
            linearVelocityMagnitude: 0,
            angularVelocityMagnitude: 0,
          });
        }
        if (request.action === 'player_state') {
          this.shared.lastPlayerStateRequest = request;
          const floor = request.floors.reduce((best, candidate) =>
            Math.abs(this.shared.position.y - candidate.finishedFloorElevation) <
            Math.abs(this.shared.position.y - best.finishedFloorElevation)
              ? candidate
              : best,
          );
          return playtestFrame({
            protocolVersion: '0.1.0',
            action: request.action,
            ok: true,
            position: this.shared.position,
            linearVelocityMagnitude: 0,
            health: this.shared.health,
            maximumHealth: this.shared.maximumHealth,
            humanoidState: this.shared.humanoidState,
            floorMaterial: 'Concrete',
            hasHumanoidRootPart: true,
            alive: this.shared.alive,
            supported: this.shared.supported,
            ...(this.shared.supported
              ? {
                  supportDistance: request.agent.rootHeightAboveFinishedFloor,
                  managedSupportEntityId: 'floor-part',
                }
              : {}),
            currentLevel: this.shared.forcedCurrentLevel ?? floor.level,
            currentFloorId: this.shared.forcedCurrentFloorId ?? floor.floorId,
          });
        }
        if (request.action === 'path_probe') {
          this.shared.lastPathRequest = request;
          const jumpRequired = this.shared.pathStatus === 'jump_required';
          const hasPathEvidence = this.shared.pathStatus !== 'no_path';
          return playtestFrame({
            protocolVersion: '0.1.0',
            action: request.action,
            ok: true,
            status: this.shared.pathStatus,
            waypointCount: hasPathEvidence ? 1 : 0,
            waypoints: hasPathEvidence ? [request.targetWorldPosition] : [],
            totalPathDistance: hasPathEvidence
              ? Math.hypot(
                  request.targetWorldPosition.x - request.fromWorldPosition.x,
                  request.targetWorldPosition.y - request.fromWorldPosition.y,
                  request.targetWorldPosition.z - request.fromWorldPosition.z,
                )
              : 0,
            requiresJump: jumpRequired,
            jumpWaypointCount: jumpRequired ? 1 : 0,
            fromCheckpointId: request.fromCheckpointId,
            targetCheckpointId: request.targetCheckpointId,
          });
        }
        if (request.action === 'clearance_probe') {
          return playtestFrame({
            protocolVersion: '0.1.0',
            action: request.action,
            ok: true,
            checkpointId: request.checkpointId,
            supported: this.shared.clearanceSupported,
            ...(this.shared.clearanceSupported
              ? { supportDistance: 3, managedSupportEntityId: 'floor-part' }
              : {}),
            bodyClear: this.shared.bodyClear,
            headClear: this.shared.headClear,
            unmanagedBlockerCount: 0,
            managedBlockerIds: this.shared.bodyClear ? [] : ['wall-part'],
          });
        }
        throw new Error('unexpected fixed action');
      }
      case 'screen_capture':
        this.shared.captureCalls += 1;
        if (this.shared.captureTimesOut) return new Promise<never>(() => undefined);
        if (this.shared.captureUnavailable) throw new Error('capture unavailable');
        return {
          content: [
            {
              type: 'image',
              mimeType: 'image/jpeg',
              data: VALID_JPEG_BYTES.toString('base64'),
            },
          ],
          isError: false,
        };
      case 'search_game_tree':
      case 'inspect_instance':
        return text('{}');
    }
    throw new Error(`unexpected tool ${tool}`);
  }

  public async close(): Promise<void> {}
}

function fixture(): Readonly<{
  manifest: RobloxManifest;
  changeSet: RobloxChangeSet;
  playtestPlan: PlaytestPlan;
  expectedSnapshotHash: string;
  identity: StudioPlaytestIdentity;
}> {
  const rawManifest: unknown = JSON.parse(
    readFileSync(
      new URL(
        '../../architecture-planner/fixtures/manifest/cliffwatch-mansion-blockout.manifest.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const rawChangeSet: unknown = JSON.parse(
    readFileSync(
      new URL(
        '../../architecture-planner/fixtures/change-sets/create-cliffwatch-blockout.change-set.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const rawPlaytestPlan: unknown = JSON.parse(
    readFileSync(
      new URL(
        '../../playtest-critic/fixtures/plans/cliffwatch.playtest-plan.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const manifestValidation = validateRobloxManifest(rawManifest);
  const changeSetValidation = validateRobloxChangeSet(rawChangeSet);
  const planValidation = validatePlaytestPlan(rawPlaytestPlan);
  if (!manifestValidation.valid || !changeSetValidation.valid || !planValidation.valid) {
    throw new Error('Cliffwatch playtest fixture validation failed.');
  }
  const manifest = manifestValidation.value;
  const changeSet = changeSetValidation.value;
  const playtestPlan = planValidation.value;
  const leaseId = '5'.repeat(64);
  return {
    manifest,
    changeSet,
    playtestPlan,
    expectedSnapshotHash: changeSet.preconditions.resultSnapshotHash,
    identity: {
      projectId: manifest.source.projectId,
      rootNodeId: manifest.rootNodeId,
      manifestSourceWorldSpecSha256: manifest.source.worldSpecHash,
      expectedManagedNodeCount: manifest.nodes.length,
      sandboxLease: {
        schemaVersion: '0.1.0',
        leaseId,
        projectId: manifest.source.projectId,
        changeSetHash: hashRobloxChangeSet(changeSet),
      },
      playtestPlanSha256: hashPlaytestPlan(playtestPlan),
    },
  };
}

const FIXTURE = fixture();

async function controller(
  shared: SharedPlaytestState,
  postStopHashMismatch = false,
  maximumStartStopTransitionWaitMilliseconds?: number,
): Promise<ReturnType<typeof createStudioPlaytestControllerForTesting>> {
  const data = FIXTURE;
  const playtestPlan = structuredClone(data.playtestPlan);
  if (maximumStartStopTransitionWaitMilliseconds !== undefined) {
    (
      playtestPlan.limits as unknown as {
        maximumStartStopTransitionWaitMilliseconds: number;
      }
    ).maximumStartStopTransitionWaitMilliseconds = maximumStartStopTransitionWaitMilliseconds;
  }
  const identity = {
    ...data.identity,
    playtestPlanSha256: hashPlaytestPlan(playtestPlan),
  };
  const connectClient = () =>
    connectStudioPlaytestMcpForTesting(() => new FakePlaytestProtocol(shared, data.manifest));
  const client = await connectClient();
  return createStudioPlaytestControllerForTesting({
    client,
    session: { studioId: 'studio-test', displayName: 'Unsaved Sandbox', active: true },
    connectClient,
    sandboxChangeSet: data.changeSet,
    desiredManifest: data.manifest,
    sandboxLeaseId: data.identity.sandboxLease.leaseId,
    identity,
    playtestPlan,
    prePlaySnapshotHash: data.expectedSnapshotHash,
    verifyPostStop: async () => {
      if (postStopHashMismatch) throw new Error('post-Stop Edit hash mismatch');
      return {
        prePlayEditSnapshotSha256: data.expectedSnapshotHash,
        postPlayEditSnapshotSha256: data.expectedSnapshotHash,
        exactMatch: true,
        finalManifestNoopOperationCount: 0,
      };
    },
  });
}

function shared(overrides: Partial<SharedPlaytestState> = {}): SharedPlaytestState {
  return {
    active: false,
    running: false,
    position: { x: 0, y: 3, z: 0 },
    startCalls: 0,
    navigationCalls: 0,
    stopCalls: 0,
    captureCalls: 0,
    trace: [],
    loseStartAcknowledgment: false,
    loseNavigationAcknowledgment: false,
    loseStopAcknowledgment: false,
    failStartBeforeRunning: false,
    losePostStartStateObservation: false,
    startAcknowledgmentText: undefined,
    navigationAcknowledgmentText: undefined,
    stopAcknowledgmentText: undefined,
    studioStateFailuresRemaining: 0,
    identityProbeFailuresRemaining: 0,
    playerCount: 1,
    characterReady: true,
    alive: true,
    health: 100,
    maximumHealth: 100,
    humanoidState: 'Running',
    supported: true,
    pathStatus: 'success',
    clearanceSupported: true,
    bodyClear: true,
    headClear: true,
    captureUnavailable: false,
    captureTimesOut: false,
    stopFailuresBeforeStopping: 0,
    acknowledgeStopWithoutStopping: false,
    setupFailure: false,
    unmanagedRootPresent: false,
    forcedCurrentLevel: undefined,
    forcedCurrentFloorId: undefined,
    lastPathRequest: undefined,
    lastPlayerStateRequest: undefined,
    ...overrides,
  };
}

async function runOneSegment(
  testController: Awaited<ReturnType<typeof controller>>,
): Promise<void> {
  const segmentId = FIXTURE.playtestPlan.segments[0]!.id;
  await testController.setupCharacter();
  await testController.probeNextPath(segmentId);
  const navigation = await testController.navigateSegment(segmentId);
  expect(navigation.independentlyReached).toBe(true);
  await expect(testController.observeClearance(segmentId)).resolves.toMatchObject({
    supported: true,
    bodyClear: true,
    headClear: true,
  });
}

async function exhaustTraversalReconnects(
  testController: Awaited<ReturnType<typeof controller>>,
  state: SharedPlaytestState,
): Promise<void> {
  await testController.setupCharacter();
  for (const segment of FIXTURE.playtestPlan.segments.slice(0, 2)) {
    await testController.probeNextPath(segment.id);
    state.loseNavigationAcknowledgment = true;
    await expect(testController.navigateSegment(segment.id)).resolves.toMatchObject({
      acknowledgmentCertain: false,
      independentlyReached: true,
    });
    await testController.observeClearance(segment.id);
  }
}

describe('Studio playtest controller state machine', () => {
  it('runs one Start, one path/navigation sequence, sanitized console evidence, and verified Stop', async () => {
    const state = shared();
    const testController = await controller(state);
    try {
      await expect(testController.start()).resolves.toMatchObject({
        acknowledgmentCertain: true,
        identityProbePassed: true,
      });
      await expect(testController.waitForCharacter()).resolves.toMatchObject({ playerCount: 1 });
      await runOneSegment(testController);
      const consoleEvidence = await testController.collectConsoleEvidence();
      expect(consoleEvidence).toMatchObject({
        evidenceComplete: true,
        newWarningCount: 1,
        newErrorCount: 0,
      });
      expect(JSON.stringify(consoleEvidence)).not.toContain('sensitive console text');
      await expect(testController.stopAndVerify()).resolves.toMatchObject({
        stop: { acknowledgmentCertain: true, observedEditRestored: true },
        editIntegrity: { exactMatch: true, finalManifestNoopOperationCount: 0 },
      });
      expect(state).toMatchObject({ startCalls: 1, navigationCalls: 1, stopCalls: 1 });
    } finally {
      await testController.close();
    }
  });

  it('accepts the current exact Studio plain-text playtest acknowledgments', async () => {
    const state = shared({
      startAcknowledgmentText: 'Game Started',
      navigationAcknowledgmentText: 'Success',
      stopAcknowledgmentText: 'Game Stopped',
    });
    const testController = await controller(state);
    try {
      await expect(testController.start()).resolves.toMatchObject({ acknowledgmentCertain: true });
      await testController.waitForCharacter();
      await testController.setupCharacter();
      for (const segment of FIXTURE.playtestPlan.segments.slice(0, 2)) {
        await testController.probeNextPath(segment.id);
        await expect(testController.navigateSegment(segment.id)).resolves.toMatchObject({
          acknowledgmentCertain: true,
          independentlyReached: true,
        });
        await expect(testController.observeClearance(segment.id)).resolves.toMatchObject({
          supported: true,
          bodyClear: true,
          headClear: true,
        });
      }
      await expect(testController.stopAndVerify()).resolves.toMatchObject({
        stop: { acknowledgmentCertain: true, observedEditRestored: true },
        editIntegrity: { exactMatch: true, finalManifestNoopOperationCount: 0 },
      });
      expect(state).toMatchObject({ startCalls: 1, navigationCalls: 2, stopCalls: 1 });
    } finally {
      await testController.close();
    }
  });

  it('does not accept swapped current Studio Start and Stop acknowledgments as certain', async () => {
    const state = shared({
      startAcknowledgmentText: 'Game Stopped',
      stopAcknowledgmentText: 'Game Started',
    });
    const testController = await controller(state);
    try {
      await expect(testController.start()).resolves.toMatchObject({ acknowledgmentCertain: false });
      await expect(testController.stopAndVerify()).resolves.toMatchObject({
        stop: { acknowledgmentCertain: false, observedEditRestored: true },
      });
      expect(state).toMatchObject({ startCalls: 1, stopCalls: 1 });
    } finally {
      await testController.close();
    }
  });

  it('keeps near-match plain navigation acknowledgments uncertain', async () => {
    const state = shared({ navigationAcknowledgmentText: 'Success ' });
    const testController = await controller(state);
    try {
      await testController.start();
      await testController.setupCharacter();
      const segmentId = FIXTURE.playtestPlan.segments[0]!.id;
      await testController.probeNextPath(segmentId);
      await expect(testController.navigateSegment(segmentId)).resolves.toMatchObject({
        acknowledgmentCertain: false,
        independentlyReached: true,
      });
      expect(state.navigationCalls).toBe(1);
    } finally {
      await testController.close();
    }
  });

  it('does not retry a lost navigation acknowledgment and accepts only independent arrival', async () => {
    const state = shared({ loseNavigationAcknowledgment: true });
    const testController = await controller(state);
    try {
      await testController.start();
      const segmentId = FIXTURE.playtestPlan.segments[0]!.id;
      await testController.setupCharacter();
      await testController.probeNextPath(segmentId);
      const navigation = await testController.navigateSegment(segmentId);
      expect(navigation).toMatchObject({
        requestedOnce: true,
        acknowledgmentCertain: false,
        independentlyReached: true,
      });
      expect(state.navigationCalls).toBe(1);
    } finally {
      await testController.close();
    }
  });

  it('does not classify a failed pre-navigation identity proof as a navigation request', async () => {
    const state = shared();
    const testController = await controller(state);
    try {
      await testController.start();
      await testController.setupCharacter();
      const segmentId = FIXTURE.playtestPlan.segments[0]!.id;
      await testController.probeNextPath(segmentId);
      state.identityProbeFailuresRemaining = 1;
      await expect(testController.navigateSegment(segmentId)).rejects.toThrow(
        /local Studio operation failed/u,
      );
      expect(state.navigationCalls).toBe(0);
      await expect(testController.navigateSegment(segmentId)).rejects.toThrow(/at most once/u);
    } finally {
      await testController.close();
    }
  });

  it('resolves uncertain Start and Stop only from exact observed state without blind retries', async () => {
    const state = shared({ loseStartAcknowledgment: true, loseStopAcknowledgment: true });
    const testController = await controller(state);
    try {
      await expect(testController.start()).resolves.toMatchObject({ acknowledgmentCertain: false });
      expect(state.startCalls).toBe(1);
      await expect(testController.stopAndVerify()).resolves.toMatchObject({
        stop: {
          acknowledgmentCertain: false,
          observedEditRestored: true,
          identityVerifiedBeforeSecondStop: false,
        },
      });
      expect(state.stopCalls).toBe(1);
    } finally {
      await testController.close();
    }
  });

  it('reconnects only for observation after a certain Start acknowledgment loses its state lane', async () => {
    const state = shared({ losePostStartStateObservation: true });
    const testController = await controller(state);
    try {
      await expect(testController.start()).resolves.toMatchObject({
        acknowledgmentCertain: true,
        observedPlayRunning: true,
        identityProbePassed: true,
      });
      expect(state.startCalls).toBe(1);
      expect(state.running).toBe(true);
    } finally {
      await testController.close();
    }
  });

  it('reconnects a failed pre-Stop identity read before sending exactly one Stop', async () => {
    const state = shared();
    const testController = await controller(state);
    try {
      await testController.start();
      state.identityProbeFailuresRemaining = 1;
      await expect(testController.stopAndVerify()).resolves.toMatchObject({
        stop: {
          acknowledgmentCertain: true,
          observedEditRestored: true,
          identityVerifiedBeforeSecondStop: false,
        },
      });
      expect(state.stopCalls).toBe(1);
      expect(state.running).toBe(false);
    } finally {
      await testController.close();
    }
  });

  it('reserves complete bounded Stop recovery after traversal exhausts its reconnect allowance', async () => {
    const state = shared({ stopFailuresBeforeStopping: 1, loseStopAcknowledgment: true });
    const testController = await controller(state);
    try {
      await testController.start();
      await exhaustTraversalReconnects(testController, state);
      state.identityProbeFailuresRemaining = 1;
      await expect(testController.stopAndVerify()).resolves.toMatchObject({
        stop: {
          acknowledgmentCertain: false,
          observedEditRestored: true,
          identityVerifiedBeforeSecondStop: true,
        },
        editIntegrity: { exactMatch: true, finalManifestNoopOperationCount: 0 },
      });
      expect(state).toMatchObject({ navigationCalls: 2, stopCalls: 2, running: false });
    } finally {
      await testController.close();
    }
  });

  it('keeps the complete four-replacement cleanup envelope bounded across close re-entry', async () => {
    const state = shared({
      stopFailuresBeforeStopping: 1,
      loseStopAcknowledgment: true,
    });
    const testController = await controller(state);
    await testController.start();
    await exhaustTraversalReconnects(testController, state);
    state.identityProbeFailuresRemaining = 2;
    await expect(testController.stopAndVerify()).rejects.toThrow();
    expect(state.stopCalls).toBe(0);
    await testController.close();
    expect(state).toMatchObject({ navigationCalls: 2, stopCalls: 2, running: false });
  });

  it('reconnects only for observation after a certain Stop acknowledgment loses its state lane', async () => {
    const state = shared();
    const testController = await controller(state);
    try {
      await testController.start();
      await exhaustTraversalReconnects(testController, state);
      state.studioStateFailuresRemaining = 1;
      await expect(testController.stopAndVerify()).resolves.toMatchObject({
        stop: {
          acknowledgmentCertain: true,
          observedEditRestored: true,
          identityVerifiedBeforeSecondStop: false,
        },
      });
      expect(state.stopCalls).toBe(1);
      expect(state.running).toBe(false);
    } finally {
      await testController.close();
    }
  });

  it.each([
    ['legacy ok flag', JSON.stringify({ ok: true })],
    ['explicit failure', JSON.stringify({ success: false, error: 'rejected' })],
    ['unknown text', 'play started'],
  ])(
    'treats a %s Start result as uncertain rather than a certain acknowledgment',
    async (_name, result) => {
      const state = shared({ startAcknowledgmentText: result });
      const testController = await controller(state);
      try {
        await expect(testController.start()).resolves.toMatchObject({
          acknowledgmentCertain: false,
          observedPlayRunning: true,
        });
        expect(state.startCalls).toBe(1);
      } finally {
        await testController.close();
      }
    },
  );

  it('rejects an explicit navigation failure acknowledgment and relies on independent arrival', async () => {
    const state = shared({
      navigationAcknowledgmentText: JSON.stringify({ success: false, error: 'navigation_failed' }),
    });
    const testController = await controller(state);
    try {
      await testController.start();
      await testController.setupCharacter();
      const segmentId = FIXTURE.playtestPlan.segments[0]!.id;
      await testController.probeNextPath(segmentId);
      await expect(testController.navigateSegment(segmentId)).resolves.toMatchObject({
        requestedOnce: true,
        acknowledgmentCertain: false,
        independentlyReached: true,
      });
      expect(state.navigationCalls).toBe(1);
    } finally {
      await testController.close();
    }
  });

  it('makes the lease-bound snapshot the last Studio call before Start and re-proves identity before every unbound tool', async () => {
    const state = shared();
    const testController = await controller(state);
    try {
      await testController.start();
      await testController.setupCharacter();
      await testController.captureCheckpoint(FIXTURE.playtestPlan.setup.checkpointId);
      const segmentId = FIXTURE.playtestPlan.segments[0]!.id;
      await testController.probeNextPath(segmentId);
      await testController.navigateSegment(segmentId);
      await testController.observeClearance(segmentId);
      await testController.collectConsoleEvidence();
      await testController.stopAndVerify();
      const startIndex = state.trace.indexOf('start_stop_play');
      expect(state.trace[startIndex - 1]).toBe('execute:Edit:bound_snapshot');
      for (const tool of ['screen_capture', 'character_navigation']) {
        const index = state.trace.indexOf(tool);
        expect(state.trace[index - 1]).toBe('execute:Server:identity_probe');
      }
      const consoleIndices = state.trace
        .map((value, index) => (value === 'get_console_output' ? index : -1))
        .filter((index) => index >= 0);
      expect(state.trace[consoleIndices.at(-1)! - 1]).toBe('execute:Server:identity_probe');
      const stopIndex = state.trace.lastIndexOf('start_stop_play');
      expect(state.trace[stopIndex - 1]).toBe('execute:Server:identity_probe');
    } finally {
      await testController.close();
    }
  });

  it('never issues a second Start after an uncertain failure that remains stopped Edit', async () => {
    const state = shared({ failStartBeforeRunning: true });
    const testController = await controller(state);
    try {
      await expect(testController.start()).rejects.toThrow(/uncertain Start/u);
      await expect(testController.start()).rejects.toThrow(/at most once/u);
      expect(state.startCalls).toBe(1);
      expect(state.stopCalls).toBe(0);
    } finally {
      await testController.close();
    }
  });

  it('rejects multiple players immediately and times out a missing character without setup', async () => {
    const multipleState = shared({ playerCount: 2 });
    const multipleController = await controller(multipleState);
    try {
      await multipleController.start();
      await expect(multipleController.waitForCharacter()).rejects.toThrow(/Exactly one/u);
    } finally {
      await multipleController.close();
    }

    const missingState = shared({ playerCount: 0, characterReady: false });
    const missingController = await controller(missingState);
    try {
      await missingController.start();
      const originalNow = Date.now;
      let now = originalNow();
      try {
        Date.now = () => now;
        const wait = missingController.waitForCharacter();
        now += 60_001;
        await expect(wait).rejects.toThrow(/bounded wait/u);
      } finally {
        Date.now = originalNow;
      }
    } finally {
      await missingController.close();
    }
  });

  it('runs setup once at the exact Plan position and refuses traversal before setup or out of order', async () => {
    const state = shared();
    const testController = await controller(state);
    const first = FIXTURE.playtestPlan.segments[0]!;
    const second = FIXTURE.playtestPlan.segments[1]!;
    try {
      await testController.start();
      await expect(testController.probeNextPath(first.id)).rejects.toThrow(/setup checkpoint/u);
      await (testController.setupCharacter as unknown as (ignored: unknown) => Promise<unknown>)({
        x: 999,
        y: 999,
        z: 999,
      });
      expect(state.position).toEqual(FIXTURE.playtestPlan.setup.worldPosition);
      await expect(testController.setupCharacter()).rejects.toThrow(/at most once/u);
      await expect(testController.probeNextPath(second.id)).rejects.toThrow(
        /exact confirmed Plan order/u,
      );
      const preflight = await testController.probeNextPath(first.id);
      expect(preflight.preflightPassed).toBe(true);
      expect(state.lastPathRequest).toMatchObject({
        fromWorldPosition: FIXTURE.playtestPlan.setup.worldPosition,
        agent: FIXTURE.playtestPlan.agent,
      });
      expect(state.lastPlayerStateRequest?.floors).toHaveLength(2);
    } finally {
      await testController.close();
    }
  });

  it.each([
    {
      name: 'dead',
      update: { alive: false, health: 0, humanoidState: 'Dead' },
      status: 'dead',
    },
    {
      name: 'fallen',
      update: { position: { x: 295.25, y: 40, z: -259.75 } },
      status: 'fell',
    },
    {
      name: 'wrong floor',
      update: { forcedCurrentLevel: 1, forcedCurrentFloorId: 'floor-upper' },
      status: 'wrong_floor',
    },
    {
      name: 'unsupported',
      update: { supported: false },
      status: 'unsupported',
    },
  ])('hard-stops $name character preflight before path/navigation', async ({ update, status }) => {
    const state = shared();
    const testController = await controller(state);
    try {
      await testController.start();
      await testController.setupCharacter();
      Object.assign(state, update);
      const segmentId = FIXTURE.playtestPlan.segments[0]!.id;
      const preflight = await testController.probeNextPath(segmentId);
      expect(preflight).toMatchObject({ preflightPassed: false, status });
      expect(state.trace.filter((entry) => entry === 'execute:Server:path_probe')).toHaveLength(0);
      expect(state.navigationCalls).toBe(0);
      await expect(testController.probeNextPath(segmentId)).rejects.toThrow(/Traversal stopped/u);
    } finally {
      await testController.close();
    }
  });

  it.each(['no_path', 'jump_required'] as const)(
    'records one %s path preflight and never navigates or retries',
    async (pathStatus) => {
      const state = shared({ pathStatus });
      const testController = await controller(state);
      try {
        await testController.start();
        await testController.setupCharacter();
        const segmentId = FIXTURE.playtestPlan.segments[0]!.id;
        const preflight = await testController.probeNextPath(segmentId);
        expect(preflight).toMatchObject({ preflightPassed: true, path: { status: pathStatus } });
        if (preflight.preflightPassed && pathStatus === 'jump_required') {
          expect(preflight.path.jumpWaypointCount).toBe(1);
        }
        await expect(testController.navigateSegment(segmentId)).rejects.toThrow(
          /Traversal stopped/u,
        );
        expect(state.navigationCalls).toBe(0);
      } finally {
        await testController.close();
      }
    },
  );

  it('hard-stops after observed support/body/head clearance failure', async () => {
    const state = shared({ bodyClear: false, headClear: false });
    const testController = await controller(state);
    try {
      await testController.start();
      await testController.setupCharacter();
      const first = FIXTURE.playtestPlan.segments[0]!.id;
      await testController.probeNextPath(first);
      await testController.navigateSegment(first);
      await expect(testController.observeClearance(first)).resolves.toMatchObject({
        bodyClear: false,
        headClear: false,
      });
      await expect(
        testController.probeNextPath(FIXTURE.playtestPlan.segments[1]!.id),
      ).rejects.toThrow(/Traversal stopped/u);
    } finally {
      await testController.close();
    }
  });

  it('captures only reached authorized checkpoints once and classifies capture failure as unavailable', async () => {
    const state = shared();
    const testController = await controller(state);
    try {
      await testController.start();
      await expect(
        testController.captureCheckpoint(FIXTURE.playtestPlan.captureCheckpoints[1]!),
      ).rejects.toThrow(/not been reached/u);
      await testController.setupCharacter();
      await expect(
        testController.captureCheckpoint(FIXTURE.playtestPlan.setup.checkpointId),
      ).resolves.toMatchObject({ mediaType: 'image/jpeg' });
      await expect(
        testController.captureCheckpoint(FIXTURE.playtestPlan.setup.checkpointId),
      ).rejects.toThrow(/at most once/u);
      expect(state.captureCalls).toBe(1);
    } finally {
      await testController.close();
    }

    const unavailableState = shared({ captureUnavailable: true });
    const unavailableController = await controller(unavailableState);
    try {
      await unavailableController.start();
      await unavailableController.setupCharacter();
      await expect(
        unavailableController.captureCheckpoint(FIXTURE.playtestPlan.setup.checkpointId),
      ).rejects.toThrow(/viewport capture attempt was unavailable/u);
      expect(unavailableState.captureCalls).toBe(1);
    } finally {
      await unavailableController.close();
    }
  });

  it('rejects protected unmanaged roots before the sole Start request', async () => {
    const state = shared({ unmanagedRootPresent: true });
    const testController = await controller(state);
    try {
      await expect(testController.start()).rejects.toThrow(/zero protected unmanaged roots/u);
      expect(state.startCalls).toBe(0);
    } finally {
      await testController.close();
    }
  });

  it('reconnects after an optional viewport timeout before returning capture-unavailable', async () => {
    const state = shared({ captureTimesOut: true });
    const testController = await controller(state);
    try {
      await testController.start();
      await testController.setupCharacter();
      vi.useFakeTimers();
      const capture = expect(
        testController.captureCheckpoint(FIXTURE.playtestPlan.setup.checkpointId),
      ).rejects.toThrow(/viewport capture attempt was unavailable/u);
      await vi.advanceTimersByTimeAsync(30_001);
      await capture;
      expect(state.captureCalls).toBe(1);
      await expect(testController.waitForCharacter()).resolves.toMatchObject({ playerCount: 1 });
    } finally {
      vi.useRealTimers();
      await testController.close();
    }
  });

  it('does not re-enter an exhausted two-attempt Stop sequence during close', async () => {
    const state = shared({ stopFailuresBeforeStopping: 2 });
    const testController = await controller(state);
    await testController.start();
    await exhaustTraversalReconnects(testController, state);
    state.identityProbeFailuresRemaining = 1;
    await expect(testController.stopAndVerify()).rejects.toThrow(/uncertain observed-state Stop/u);
    expect(state.stopCalls).toBe(2);
    await testController.close();
    expect(state.stopCalls).toBe(2);
  });

  it('never issues a second Stop after a certain acknowledgment that does not restore Edit', async () => {
    const state = shared({ acknowledgeStopWithoutStopping: true });
    const testController = await controller(state, false, 1);
    await testController.start();
    await expect(testController.stopAndVerify()).rejects.toThrow(/stopped Edit/u);
    expect(state.stopCalls).toBe(1);
    await testController.close();
    expect(state.stopCalls).toBe(1);
  });

  it('does not retry setup or Stop after setup and post-Edit integrity failures', async () => {
    const setupState = shared({ setupFailure: true });
    const setupController = await controller(setupState);
    try {
      await setupController.start();
      await expect(setupController.setupCharacter()).rejects.toThrow(/character_unavailable/u);
      await expect(setupController.setupCharacter()).rejects.toThrow(/at most once/u);
      expect(
        setupState.trace.filter((entry) => entry === 'execute:Server:character_setup'),
      ).toHaveLength(1);
    } finally {
      await setupController.close();
    }

    const integrityState = shared();
    const integrityController = await controller(integrityState, true);
    await integrityController.start();
    await expect(integrityController.stopAndVerify()).rejects.toThrow(/hash mismatch/u);
    await integrityController.close();
    expect(integrityState.stopCalls).toBe(1);
  });
});
