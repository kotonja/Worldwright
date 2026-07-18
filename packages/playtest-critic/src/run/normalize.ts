import { compareCodePoints } from '../json.js';
import type { PlaytestRunReport } from './contract-schema.js';

function clone<T>(value: Readonly<T>): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function normalizePlaytestRunReport(input: Readonly<PlaytestRunReport>): PlaytestRunReport {
  const value = clone(input);
  return {
    ...value,
    source: { ...value.source },
    environment: {
      ...value.environment,
      playDataModelsUsed: [...value.environment.playDataModelsUsed].sort(compareCodePoints),
    },
    start: { ...value.start },
    setup: {
      ...value.setup,
      requestedPosition: { ...value.setup.requestedPosition },
      ...(value.setup.verifiedPosition === undefined
        ? {}
        : { verifiedPosition: { ...value.setup.verifiedPosition } }),
    },
    segmentResults: value.segmentResults
      .map((result) => ({
        ...result,
        path: { ...result.path },
        navigation: {
          ...result.navigation,
          ...(result.navigation.finalPosition === undefined
            ? {}
            : { finalPosition: { ...result.navigation.finalPosition } }),
        },
        arrival: {
          ...result.arrival,
          targetPosition: { ...result.arrival.targetPosition },
          ...(result.arrival.observedPosition === undefined
            ? {}
            : { observedPosition: { ...result.arrival.observedPosition } }),
        },
        character: { ...result.character },
        clearance: {
          ...result.clearance,
          managedBlockerIds: [...result.clearance.managedBlockerIds].sort(compareCodePoints),
        },
        failureCodes: [...result.failureCodes].sort(compareCodePoints),
      }))
      .sort(
        (left, right) =>
          left.sequence - right.sequence || compareCodePoints(left.segmentId, right.segmentId),
      ),
    consoleEvidence: {
      ...value.consoleEvidence,
      entries: value.consoleEvidence.entries
        .map((entry) => ({ ...entry }))
        .sort((left, right) => compareCodePoints(left.evidenceId, right.evidenceId)),
    },
    viewportEvidence: value.viewportEvidence
      .map((evidence) => ({ ...evidence }))
      .sort((left, right) => compareCodePoints(left.evidenceId, right.evidenceId)),
    coverage: {
      ...value.coverage,
      missedCheckpointIds: [...value.coverage.missedCheckpointIds].sort(compareCodePoints),
      missedRoomIds: [...value.coverage.missedRoomIds].sort(compareCodePoints),
      missedFloorIds: [...value.coverage.missedFloorIds].sort(compareCodePoints),
      missedStairRunIds: [...value.coverage.missedStairRunIds].sort(compareCodePoints),
    },
    stop: { ...value.stop },
    editIntegrity: { ...value.editIntegrity },
    summary: { ...value.summary },
  };
}
