import { beforeAll, describe, expect, it } from 'vitest';

import type { PlaytestPlan } from '../src/plan/contract-schema.js';
import type { PlaytestRunReport, PlaytestSegmentResult } from '../src/run/contract-schema.js';
import {
  validatePlaytestRunReport,
  validatePlaytestRunReportAgainstPlan,
} from '../src/run/validate.js';
import { clone, readPlanFixture, readRunFixture } from './helpers.js';

let plan: PlaytestPlan;
let clean: PlaytestRunReport;

function makeUnattempted(result: PlaytestSegmentResult): void {
  const source = plan.checkpoints.find((checkpoint) => checkpoint.id === result.fromCheckpointId);
  if (source === undefined) throw new Error('Expected source checkpoint.');
  result.path = {
    status: 'not_attempted',
    waypointCount: 0,
    totalPathDistance: 0,
    jumpWaypointCount: 0,
  };
  result.navigation = {
    requestedOnce: false,
    acknowledgmentCertain: false,
    independentlyReached: false,
  };
  result.arrival.status = 'not_observed';
  delete result.arrival.observedPosition;
  delete result.arrival.horizontalError;
  delete result.arrival.verticalError;
  result.character.observed = false;
  result.character.alive = false;
  result.character.health = 0;
  result.character.maximumHealth = 0;
  result.character.humanoidState = 'unknown';
  result.character.fallDetected = false;
  result.character.expectedLevel = source.level;
  delete result.character.observedLevel;
  result.clearance = {
    observed: false,
    supported: false,
    headClear: false,
    bodyClear: false,
    managedBlockerIds: [],
    unmanagedBlockerCount: 0,
  };
  delete result.viewportEvidenceId;
  result.failureCodes = [];
}

function failedStartRun(): PlaytestRunReport {
  const run = clone(clean);
  run.environment.playDataModelsUsed = ['Edit'];
  run.start = {
    requested: true,
    acknowledgmentCertain: false,
    observedPlayRunning: false,
    identityProbePassed: false,
    characterReady: false,
    failureCode: 'start-uncertain',
  };
  run.setup.attempted = false;
  run.setup.succeeded = false;
  run.setup.failureCode = 'setup-failed';
  delete run.setup.verifiedPosition;
  run.segmentResults.forEach(makeUnattempted);
  run.viewportEvidence = [];
  run.coverage = {
    requiredCheckpointCount: plan.requiredCoverage.checkpoints.count,
    reachedCheckpointCount: 0,
    missedCheckpointIds: [...plan.requiredCoverage.checkpoints.ids],
    requiredRoomCount: plan.requiredCoverage.rooms.count,
    reachedRoomCount: 0,
    missedRoomIds: [...plan.requiredCoverage.rooms.ids],
    requiredFloorCount: plan.requiredCoverage.floors.count,
    reachedFloorCount: 0,
    missedFloorIds: [...plan.requiredCoverage.floors.ids],
    requiredStairRunCount: plan.requiredCoverage.stairRuns.count,
    traversedStairRunCount: 0,
    missedStairRunIds: [...plan.requiredCoverage.stairRuns.ids],
  };
  run.stop = {
    requested: false,
    acknowledgmentCertain: false,
    observedEditRestored: false,
    identityVerifiedBeforeSecondStop: false,
    failureCode: 'none',
  };
  run.summary = {
    status: 'failed_to_start',
    segmentsPlanned: plan.segments.length,
    segmentsAttempted: 0,
    segmentsReached: 0,
    allRequiredCoverageReached: false,
    characterSurvived: false,
    pathFailures: 0,
    arrivalFailures: 0,
    clearanceFailures: 0,
    consoleErrors: 0,
    consoleWarnings: 0,
    editIntegrityPassed: true,
  };
  return run;
}

function invalid(mutator: (run: PlaytestRunReport) => void): void {
  const run = clone(clean);
  mutator(run);
  expect(validatePlaytestRunReportAgainstPlan(plan, run).valid).toBe(false);
}

beforeAll(async () => {
  [plan, clean] = await Promise.all([readPlanFixture(), readRunFixture()]);
});

describe('Run evidence causality matrix', () => {
  it('represents a genuine still-Edit failed start with no unsafe traversal or Stop', () => {
    expect(validatePlaytestRunReportAgainstPlan(plan, failedStartRun()).valid).toBe(true);
  });

  it('rejects setup, traversal, or Stop after identity was not proved', () => {
    const setup = failedStartRun();
    setup.setup.attempted = true;
    expect(validatePlaytestRunReportAgainstPlan(plan, setup).valid).toBe(false);
    const traversal = failedStartRun();
    traversal.segmentResults[0] = clone(clean.segmentResults[0]!);
    expect(validatePlaytestRunReportAgainstPlan(plan, traversal).valid).toBe(false);
    const stop = failedStartRun();
    stop.stop.requested = true;
    expect(validatePlaytestRunReportAgainstPlan(plan, stop).valid).toBe(false);
  });

  it('requires exact Edit, Server, and navigation-derived Client evidence', () => {
    invalid((run) => {
      run.environment.playDataModelsUsed = ['Edit', 'Server'];
    });
    invalid((run) => {
      run.environment.playDataModelsUsed = ['Client', 'Edit'];
    });
  });

  it('rejects success-mapped jumping paths but accepts the closed failed jump evidence shape', () => {
    invalid((run) => {
      run.segmentResults[0]!.path.jumpWaypointCount = 1;
    });
    invalid((run) => {
      const result = run.segmentResults.at(-1)!;
      result.path.status = 'failed';
      result.path.jumpWaypointCount = 1;
      result.navigation.requestedOnce = false;
      result.navigation.acknowledgmentCertain = false;
      result.navigation.independentlyReached = false;
      result.failureCodes = ['path-failed'];
      // Retained final navigation evidence is intentionally forged and must be rejected.
    });
  });

  it('binds every capture to one authorized independently reached checkpoint and segment', () => {
    invalid((run) => {
      run.viewportEvidence[0]!.checkpointId = 'forged-checkpoint';
    });
    invalid((run) => {
      run.viewportEvidence[1]!.checkpointId = run.viewportEvidence[0]!.checkpointId;
    });
    invalid((run) => {
      const evidence = run.viewportEvidence.find(
        (candidate) => candidate.checkpointId !== plan.setup.checkpointId,
      );
      if (evidence === undefined) throw new Error('Expected segment capture.');
      for (const result of run.segmentResults)
        if (result.viewportEvidenceId === evidence.evidenceId) delete result.viewportEvidenceId;
    });
    invalid((run) => {
      const result = run.segmentResults.find(
        (candidate) => candidate.viewportEvidenceId !== undefined,
      );
      if (result === undefined) throw new Error('Expected captured segment.');
      result.viewportEvidenceId = 'forged-evidence';
    });
    const failedCapture = clone(clean);
    const capturedResultIndex = failedCapture.segmentResults.findIndex(
      (candidate) => candidate.viewportEvidenceId !== undefined,
    );
    const capturedResult = failedCapture.segmentResults[capturedResultIndex];
    if (capturedResult === undefined) throw new Error('Expected captured segment.');
    const horizontalError = plan.agent.arrivalHorizontalTolerance + 1;
    capturedResult.arrival.status = 'missed';
    capturedResult.arrival.observedPosition = {
      ...capturedResult.arrival.targetPosition,
      x: capturedResult.arrival.targetPosition.x + horizontalError,
    };
    capturedResult.arrival.horizontalError = horizontalError;
    capturedResult.arrival.verticalError = 0;
    capturedResult.navigation.independentlyReached = false;
    capturedResult.navigation.finalPosition = { ...capturedResult.arrival.observedPosition };
    capturedResult.navigation.horizontalError = horizontalError;
    capturedResult.navigation.verticalError = 0;
    capturedResult.clearance = {
      observed: false,
      supported: false,
      headClear: false,
      bodyClear: false,
      managedBlockerIds: [],
      unmanagedBlockerCount: 0,
    };
    capturedResult.failureCodes = ['arrival-missed', 'navigation-failed'];
    failedCapture.summary.segmentsReached -= 1;
    failedCapture.summary.arrivalFailures += 1;
    const validation = validatePlaytestRunReportAgainstPlan(plan, failedCapture);
    expect(validation.valid).toBe(false);
    if (!validation.valid)
      expect(
        validation.diagnostics.some(
          (diagnostic) =>
            diagnostic.path === `/segmentResults/${capturedResultIndex}/viewportEvidenceId`,
        ),
      ).toBe(true);
  });

  it('requires retained console entries to be new, classified consistently, and count-bounded', () => {
    invalid((run) => {
      run.consoleEvidence.entries.push({
        evidenceId: 'evidence-old-console',
        severity: 'warning',
        dataModelSource: 'Server',
        messageSha256: 'a'.repeat(64),
        classificationCode: 'console-warning',
        isNew: false,
      });
    });
    invalid((run) => {
      run.consoleEvidence.entries.push({
        evidenceId: 'evidence-misclassified-console',
        severity: 'error',
        dataModelSource: 'Server',
        messageSha256: 'b'.repeat(64),
        classificationCode: 'console-warning',
        isNew: true,
      });
      run.consoleEvidence.newErrorCount = 1;
      run.summary.consoleErrors = 1;
    });
    invalid((run) => {
      run.consoleEvidence.entries.push({
        evidenceId: 'evidence-overcount-console',
        severity: 'warning',
        dataModelSource: 'Server',
        messageSha256: 'c'.repeat(64),
        classificationCode: 'console-warning',
        isNew: true,
      });
    });
  });

  it('requires actual observation and no fall for characterSurvived', () => {
    invalid((run) => {
      run.segmentResults[0]!.character.observed = false;
    });
    invalid((run) => {
      run.segmentResults.at(-1)!.character.fallDetected = true;
    });
  });

  it('rejects contradictory character, arrival, and clearance sentinel evidence', () => {
    invalid((run) => {
      run.segmentResults[0]!.character.health = 101;
    });
    invalid((run) => {
      run.segmentResults[0]!.character.alive = false;
    });
    invalid((run) => {
      const character = run.segmentResults[0]!.character;
      character.observed = false;
      character.alive = false;
      character.health = 1;
      character.maximumHealth = 1;
      character.humanoidState = 'unknown';
      delete character.observedLevel;
    });
    invalid((run) => {
      run.segmentResults.at(-1)!.arrival.status = 'missed';
    });
    invalid((run) => {
      const clearance = run.segmentResults[0]!.clearance;
      clearance.observed = false;
    });
  });

  it('requires a complete clearance observation for every independently reached segment', () => {
    invalid((run) => {
      const clearance = run.segmentResults[0]!.clearance;
      clearance.observed = false;
      clearance.supported = false;
      clearance.headClear = false;
      clearance.bodyClear = false;
      delete clearance.supportEntityId;
      clearance.managedBlockerIds = [];
      clearance.unmanagedBlockerCount = 0;
    });
  });

  it('accepts complete missed-arrival evidence and requires exact cross-consistency', () => {
    const missed = clone(clean);
    const result = missed.segmentResults.at(-1)!;
    const horizontalError = plan.agent.arrivalHorizontalTolerance + 1;
    const observedPosition = {
      ...result.arrival.targetPosition,
      x: result.arrival.targetPosition.x + horizontalError,
    };
    result.arrival.status = 'missed';
    result.arrival.observedPosition = observedPosition;
    result.arrival.horizontalError = horizontalError;
    result.arrival.verticalError = 0;
    result.navigation.independentlyReached = false;
    result.navigation.finalPosition = { ...observedPosition };
    result.navigation.horizontalError = horizontalError;
    result.navigation.verticalError = 0;
    result.navigation.finalVelocityMagnitude = 0;
    result.clearance = {
      observed: false,
      supported: false,
      headClear: false,
      bodyClear: false,
      managedBlockerIds: [],
      unmanagedBlockerCount: 0,
    };
    result.failureCodes = ['arrival-missed', 'navigation-failed'];
    missed.summary.segmentsReached -= 1;
    missed.summary.arrivalFailures += 1;
    expect(validatePlaytestRunReport(missed).valid).toBe(true);

    const incomplete = clone(missed);
    delete incomplete.segmentResults.at(-1)!.navigation.finalVelocityMagnitude;
    expect(validatePlaytestRunReport(incomplete).valid).toBe(false);

    const inconsistent = clone(missed);
    inconsistent.segmentResults.at(-1)!.navigation.horizontalError = horizontalError + 1;
    expect(validatePlaytestRunReport(inconsistent).valid).toBe(false);

    const falseMiss = clone(missed);
    const falseResult = falseMiss.segmentResults.at(-1)!;
    falseResult.arrival.observedPosition = {
      ...falseResult.arrival.targetPosition,
      x: falseResult.arrival.targetPosition.x + 1,
    };
    falseResult.arrival.horizontalError = 1;
    falseResult.navigation.finalPosition = { ...falseResult.arrival.observedPosition };
    falseResult.navigation.horizontalError = 1;
    const falseValidation = validatePlaytestRunReportAgainstPlan(plan, falseMiss);
    expect(falseValidation.valid).toBe(false);
    if (!falseValidation.valid)
      expect(
        falseValidation.diagnostics.some(
          (diagnostic) =>
            diagnostic.path.endsWith('/arrival') && diagnostic.message.includes('tolerances'),
        ),
      ).toBe(true);
  });

  it('rejects destination clearance evidence unless independent arrival was reached', () => {
    const run = clone(clean);
    const result = run.segmentResults.at(-1)!;
    result.arrival.status = 'missed';
    result.navigation.independentlyReached = false;
    result.failureCodes = ['arrival-missed', 'navigation-failed'];
    run.summary.segmentsReached -= 1;
    run.summary.arrivalFailures += 1;
    expect(validatePlaytestRunReport(run).valid).toBe(false);
  });

  it('allows a floor-range fall observation after Humanoid state has changed', () => {
    const run = clone(clean);
    const result = run.segmentResults.at(-1)!;
    result.character.fallDetected = true;
    result.character.humanoidState = 'running';
    result.failureCodes = ['character-fell'];
    run.summary.characterSurvived = false;
    expect(validatePlaytestRunReportAgainstPlan(plan, run).valid).toBe(true);
  });

  it('derives Edit exactMatch in both directions from the pre/post hashes', () => {
    invalid((run) => {
      run.editIntegrity.exactMatch = false;
      run.summary.editIntegrityPassed = false;
    });
    invalid((run) => {
      run.editIntegrity.postPlayEditSnapshotSha256 = 'f'.repeat(64);
    });
  });

  it('permits second-Stop identity evidence only after an uncertain first Stop', () => {
    invalid((run) => {
      run.stop.identityVerifiedBeforeSecondStop = true;
    });
  });

  it('accepts supported managed and unavailable-ID support while rejecting a false support ID', () => {
    expect(validatePlaytestRunReportAgainstPlan(plan, clean).valid).toBe(true);

    const unavailableId = clone(clean);
    delete unavailableId.segmentResults[0]!.clearance.supportEntityId;
    expect(validatePlaytestRunReportAgainstPlan(plan, unavailableId).valid).toBe(true);

    const falseSupportId = clone(clean);
    falseSupportId.segmentResults[0]!.clearance.supported = false;
    falseSupportId.segmentResults[0]!.failureCodes = ['support-missing'];
    falseSupportId.summary.clearanceFailures = 1;
    expect(validatePlaytestRunReport(falseSupportId).valid).toBe(false);
  });

  it('rejects stale, missing, extra, or none segment and lifecycle failure codes', () => {
    invalid((run) => {
      run.segmentResults[0]!.failureCodes = ['none'];
    });
    invalid((run) => {
      run.segmentResults[0]!.clearance.supported = false;
      delete run.segmentResults[0]!.clearance.supportEntityId;
    });
    invalid((run) => {
      run.start.failureCode = 'start-uncertain';
    });
    invalid((run) => {
      run.setup.failureCode = 'setup-failed';
    });
    invalid((run) => {
      run.stop.failureCode = 'stop-uncertain';
    });
  });

  it('requires an untouched suffix after any terminal segment result', () => {
    const run = clone(clean);
    const first = run.segmentResults[0]!;
    first.clearance.supported = false;
    delete first.clearance.supportEntityId;
    first.failureCodes = ['support-missing'];
    run.summary.clearanceFailures = 1;
    const validation = validatePlaytestRunReportAgainstPlan(plan, run);
    expect(validation.valid).toBe(false);
    if (validation.valid) return;
    expect(
      validation.diagnostics.some(
        (diagnostic) =>
          diagnostic.path === '/segmentResults/1/path/status' &&
          diagnostic.message.includes('terminal'),
      ),
    ).toBe(true);
  });
});
