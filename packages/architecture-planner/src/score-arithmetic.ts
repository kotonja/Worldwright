export const ARCHITECTURE_MAX_SCORE_COMPONENT = Number.MAX_SAFE_INTEGER;

/** Converts a finite planner penalty into the closed non-negative score range. */
export function toArchitectureScoreComponent(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(ARCHITECTURE_MAX_SCORE_COMPONENT, Math.round(value));
}

/** Adds normalized score components without unsafe intermediate arithmetic. */
export function sumArchitectureScoreComponents(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (value >= ARCHITECTURE_MAX_SCORE_COMPONENT - total) {
      return ARCHITECTURE_MAX_SCORE_COMPONENT;
    }
    total += value;
  }
  return total;
}

/** Adds one raw penalty to an already normalized score component. */
export function addArchitectureScoreComponent(total: number, value: number): number {
  return sumArchitectureScoreComponents([total, toArchitectureScoreComponent(value)]);
}
