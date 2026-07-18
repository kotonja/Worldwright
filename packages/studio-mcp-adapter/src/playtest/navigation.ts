import type {
  StudioPlaytestAgent,
  StudioPlaytestPlayerStateSuccess,
  StudioPlaytestVector,
} from './types.js';

export type StudioPlaytestArrivalStatus = 'reached' | 'moving' | 'dead' | 'fell' | 'wrong_floor';

export interface StudioPlaytestArrivalAssessment {
  readonly status: StudioPlaytestArrivalStatus;
  readonly horizontalError: number;
  readonly verticalError: number;
  readonly independentlyReached: boolean;
}

/** Pure independent arrival, floor, death, and fall assessment. */
export function assessStudioPlaytestArrival(
  state: Readonly<StudioPlaytestPlayerStateSuccess>,
  target: Readonly<StudioPlaytestVector>,
  expectedLevel: number,
  expectedFinishedFloorElevation: number,
  agent: Readonly<StudioPlaytestAgent>,
): StudioPlaytestArrivalAssessment {
  const horizontalError = Math.hypot(state.position.x - target.x, state.position.z - target.z);
  const verticalError = Math.abs(state.position.y - target.y);
  let status: StudioPlaytestArrivalStatus = 'moving';
  if (!state.alive || state.health <= 0) status = 'dead';
  else if (state.position.y < expectedFinishedFloorElevation - agent.maximumFallBelowFloor) {
    status = 'fell';
  } else if (
    horizontalError <= agent.arrivalHorizontalTolerance &&
    verticalError <= agent.arrivalVerticalTolerance
  ) {
    status = state.currentLevel === expectedLevel ? 'reached' : 'wrong_floor';
  }
  return Object.freeze({
    status,
    horizontalError,
    verticalError,
    independentlyReached: status === 'reached',
  });
}
