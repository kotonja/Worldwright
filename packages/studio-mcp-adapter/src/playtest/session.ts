import {
  STUDIO_MCP_PLAYTEST_POLL_INTERVAL_MS,
  STUDIO_MCP_PLAYTEST_STATE_TRANSITION_TIMEOUT_MS,
} from '../constants.js';
import { StudioAdapterError, studioDiagnostic } from '../diagnostics.js';
import { parseStudioStateText, type StudioStateSummary } from '../mcp/session.js';

export type StudioPlaytestSessionPhase =
  | 'stopped_edit'
  | 'running_server'
  | 'transitioning'
  | 'unsafe';

const STOPPED_STATES = new Set(['edit', 'notrunning', 'stopped']);
const RUNNING_STATES = new Set(['play', 'playing', 'playserver', 'playtest', 'running']);
const TRANSITION_STATES = new Set(['starting', 'stopping']);

function normalizedState(value: string): string {
  return value.replaceAll(/[_\s-]/gu, '').toLowerCase();
}

/** Strictly classify only the Studio states used by the bounded playtest state machine. */
export function classifyStudioPlaytestSessionState(
  state: Readonly<StudioStateSummary>,
): StudioPlaytestSessionPhase {
  const normalized = normalizedState(state.playState);
  if (STOPPED_STATES.has(normalized)) {
    return state.editAvailable && !state.playtesting ? 'stopped_edit' : 'unsafe';
  }
  if (TRANSITION_STATES.has(normalized)) return 'transitioning';
  if (RUNNING_STATES.has(normalized)) {
    return state.playtesting && state.availableDataModelTypes.includes('Server')
      ? 'running_server'
      : 'transitioning';
  }
  return 'unsafe';
}

export function readStudioPlaytestSessionState(text: string): Readonly<{
  state: StudioStateSummary;
  phase: StudioPlaytestSessionPhase;
}> {
  const state = parseStudioStateText(text);
  return Object.freeze({ state, phase: classifyStudioPlaytestSessionState(state) });
}

export interface StudioPlaytestStateWaitOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** Poll one already-selected exact session until a requested stable phase is observed. */
export async function waitForStudioPlaytestSessionPhase(
  readStateText: () => Promise<string>,
  expected: 'stopped_edit' | 'running_server',
  options: Readonly<StudioPlaytestStateWaitOptions> = {},
): Promise<StudioStateSummary> {
  const timeoutMs = options.timeoutMs ?? STUDIO_MCP_PLAYTEST_STATE_TRANSITION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? STUDIO_MCP_PLAYTEST_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.wait ?? waitFor;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 1
  ) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.playtest_state_invalid',
        '/stateWait',
        'Studio playtest state waits require positive bounded integer durations.',
      ),
    ]);
  }
  const deadline = now() + timeoutMs;
  for (;;) {
    const observation = readStudioPlaytestSessionState(await readStateText());
    if (observation.phase === expected) return observation.state;
    if (observation.phase === 'unsafe') {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.playtest_state_invalid',
          '/state',
          'Studio entered a state outside the bounded playtest lifecycle.',
        ),
      ]);
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.playtest_state_invalid',
          '/state',
          `Studio did not reach ${expected === 'stopped_edit' ? 'stopped Edit' : 'running Server'} within the bounded wait.`,
        ),
      ]);
    }
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}
