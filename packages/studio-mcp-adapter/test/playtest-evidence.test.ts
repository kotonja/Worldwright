import { describe, expect, it } from 'vitest';

import { sanitizeStudioConsoleEvidence } from '../src/playtest/console.js';
import { assessStudioPlaytestArrival } from '../src/playtest/navigation.js';
import {
  classifyStudioPlaytestSessionState,
  readStudioPlaytestSessionState,
} from '../src/playtest/session.js';
import type {
  StudioPlaytestAgent,
  StudioPlaytestPlayerStateSuccess,
} from '../src/playtest/types.js';

const AGENT: StudioPlaytestAgent = {
  radius: 2,
  height: 5,
  canJump: false,
  canClimb: false,
  waypointSpacing: 4,
  arrivalHorizontalTolerance: 4,
  arrivalVerticalTolerance: 5,
  maximumHorizontalSpeed: 32,
  maximumFallBelowFloor: 12,
  rootHeightAboveFinishedFloor: 3,
};

function state(
  overrides: Partial<StudioPlaytestPlayerStateSuccess> = {},
): StudioPlaytestPlayerStateSuccess {
  return {
    protocolVersion: '0.1.0',
    action: 'player_state',
    ok: true,
    position: { x: 10, y: 3, z: 20 },
    linearVelocityMagnitude: 0,
    health: 100,
    maximumHealth: 100,
    humanoidState: 'Running',
    floorMaterial: 'Concrete',
    hasHumanoidRootPart: true,
    alive: true,
    supported: true,
    supportDistance: 3,
    managedSupportEntityId: 'floor-part',
    currentLevel: 0,
    currentFloorId: 'floor-zero',
    ...overrides,
  };
}

describe('Studio playtest evidence helpers', () => {
  it('classifies only stopped Edit, running Server, transition, and unsafe states', () => {
    expect(
      classifyStudioPlaytestSessionState({
        playState: 'NotRunning',
        availableDataModelTypes: ['Edit'],
        editAvailable: true,
        playtesting: false,
      }),
    ).toBe('stopped_edit');
    expect(
      readStudioPlaytestSessionState(
        JSON.stringify({
          play_state: 'Running',
          available_datamodel_types: ['Client', 'Server'],
        }),
      ).phase,
    ).toBe('running_server');
    expect(
      classifyStudioPlaytestSessionState({
        playState: 'Paused',
        availableDataModelTypes: ['Server'],
        editAvailable: false,
        playtesting: true,
      }),
    ).toBe('unsafe');
  });

  it('requires independent position, floor, life, and fall evidence', () => {
    const target = { x: 10, y: 3, z: 20 };
    expect(assessStudioPlaytestArrival(state(), target, 0, 0, AGENT).status).toBe('reached');
    expect(
      assessStudioPlaytestArrival(state({ currentLevel: 1 }), target, 0, 0, AGENT).status,
    ).toBe('wrong_floor');
    expect(assessStudioPlaytestArrival(state({ alive: false }), target, 0, 0, AGENT).status).toBe(
      'dead',
    );
    expect(
      assessStudioPlaytestArrival(
        state({ position: { x: 10, y: -13, z: 20 } }),
        target,
        0,
        0,
        AGENT,
      ).status,
    ).toBe('fell');
  });

  it('hashes and classifies only a safe retained console prefix', () => {
    const baseline = JSON.stringify({
      entries: [{ message: 'ready', type: 'MessageOutput', source: 'Edit' }],
      complete: true,
    });
    const final = JSON.stringify({
      entries: [
        { message: 'ready', type: 'MessageOutput', source: 'Edit' },
        { message: 'warning detail', type: 'MessageWarning', source: 'Server' },
        { message: 'error detail', type: 'MessageError', source: 'Server' },
      ],
      complete: true,
    });
    const evidence = sanitizeStudioConsoleEvidence(baseline, final);
    expect(evidence).toMatchObject({
      evidenceComplete: true,
      newErrorCount: 1,
      newWarningCount: 1,
    });
    expect(evidence.entries).toHaveLength(2);
    expect(JSON.stringify(evidence)).not.toContain('warning detail');
    expect(JSON.stringify(evidence)).not.toContain('error detail');
    expect(evidence.entries.every((entry) => /^[0-9a-f]{64}$/u.test(entry.messageSha256))).toBe(
      true,
    );
  });

  it('does not conflate identical source-less Edit and Server messages', () => {
    const baseline = JSON.stringify({
      entries: [{ message: 'retained output', type: 'MessageOutput' }],
      complete: true,
    });
    const final = JSON.stringify({
      entries: [
        { message: 'retained output', type: 'MessageOutput' },
        { message: 'new output', type: 'MessageOutput' },
      ],
      complete: true,
    });
    const evidence = sanitizeStudioConsoleEvidence(baseline, final);
    expect(evidence).toMatchObject({ evidenceComplete: false, newErrorCount: 0 });
    expect(evidence.entries).toHaveLength(0);
  });

  it('accepts only exact empty runtime text as complete zero-entry evidence', () => {
    expect(sanitizeStudioConsoleEvidence('legacy Edit text', '')).toMatchObject({
      evidenceComplete: true,
      newErrorCount: 0,
      newWarningCount: 0,
      entries: [],
    });
    expect(sanitizeStudioConsoleEvidence('legacy Edit text', ' ')).toMatchObject({
      evidenceComplete: false,
      newErrorCount: 0,
      newWarningCount: 0,
      entries: [],
    });
    expect(sanitizeStudioConsoleEvidence('', 'nonempty runtime text')).toMatchObject({
      evidenceComplete: false,
      newErrorCount: 0,
      newWarningCount: 0,
      entries: [],
    });
  });

  it('marks malformed, truncated, reordered, and oversized console evidence incomplete', () => {
    const entry = { message: 'one', severity: 'info', source: 'Edit' };
    expect(sanitizeStudioConsoleEvidence('plain output', 'plain output').evidenceComplete).toBe(
      false,
    );
    expect(
      sanitizeStudioConsoleEvidence(
        JSON.stringify({ entries: [entry], truncated: true }),
        JSON.stringify({ entries: [entry] }),
      ).evidenceComplete,
    ).toBe(false);
    expect(
      sanitizeStudioConsoleEvidence(
        JSON.stringify([entry, { ...entry, message: 'two' }]),
        JSON.stringify([{ ...entry, message: 'two' }, entry]),
      ).evidenceComplete,
    ).toBe(false);
    expect(
      sanitizeStudioConsoleEvidence(
        JSON.stringify([]),
        JSON.stringify([
          { message: 'x'.repeat(16 * 1024 + 1), severity: 'info', source: 'Server' },
        ]),
      ).evidenceComplete,
    ).toBe(false);
  });
});
