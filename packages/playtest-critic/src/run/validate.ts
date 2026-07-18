import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';

import {
  playtestDiagnostic,
  sortPlaytestDiagnostics,
  type PlaytestDiagnostic,
  type PlaytestValidationResult,
} from '../diagnostic.js';
import { compareCodePoints, inspectJsonCompatibility } from '../json.js';
import { hashPlaytestPlan } from '../plan/hashing.js';
import type { PlaytestCheckpoint, PlaytestPlan } from '../plan/contract-schema.js';
import { validatePlaytestPlan } from '../plan/validate.js';
import { PlaytestRunReportSchema, type PlaytestRunReport } from './contract-schema.js';
import { normalizePlaytestRunReport } from './normalize.js';

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictNumbers: true,
  validateFormats: false,
});
const checkReport = ajv.compile(PlaytestRunReportSchema);

function schemaDiagnostics(
  errors: readonly ErrorObject[] | null | undefined,
): PlaytestDiagnostic[] {
  return (errors ?? []).map((error) =>
    playtestDiagnostic(
      'playtest.run_report_invalid',
      error.instancePath,
      `Playtest Run Report schema rejected ${error.keyword}.`,
    ),
  );
}

function duplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameVector(
  left: Readonly<{ x: number; y: number; z: number }>,
  right: Readonly<{ x: number; y: number; z: number }>,
): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function horizontalError(
  observed: Readonly<{ x: number; y: number; z: number }>,
  target: Readonly<{ x: number; y: number; z: number }>,
): number {
  return Math.hypot(observed.x - target.x, observed.z - target.z);
}

function expectedSegmentFailureCodes(
  result: Readonly<PlaytestRunReport['segmentResults'][number]>,
): readonly string[] {
  const codes: string[] = [];
  if (result.path.status === 'failed') codes.push('path-failed');
  if (
    result.path.status === 'success' &&
    result.navigation.requestedOnce &&
    result.arrival.status !== 'reached'
  )
    codes.push('navigation-failed');
  if (result.arrival.status === 'missed') codes.push('arrival-missed');
  if (result.character.observed && (!result.character.alive || result.character.health <= 0))
    codes.push('character-dead');
  if (result.character.observed && result.character.fallDetected) codes.push('character-fell');
  if (
    result.character.observedLevel !== undefined &&
    result.character.observedLevel !== result.character.expectedLevel
  )
    codes.push('wrong-floor');
  if (result.clearance.observed && !result.clearance.supported) codes.push('support-missing');
  if (result.clearance.observed && !result.clearance.headClear) codes.push('head-blocked');
  if (result.clearance.observed && !result.clearance.bodyClear) codes.push('body-blocked');
  return codes.sort(compareCodePoints);
}

function standaloneDiagnostics(report: Readonly<PlaytestRunReport>): PlaytestDiagnostic[] {
  const diagnostics: PlaytestDiagnostic[] = [];
  const expectedDataModels = [
    'Edit',
    ...(report.start.observedPlayRunning ? ['Server'] : []),
    ...(report.segmentResults.some((result) => result.navigation.requestedOnce) ? ['Client'] : []),
  ].sort(compareCodePoints);
  const actualDataModels = [...report.environment.playDataModelsUsed].sort(compareCodePoints);
  if (!sameStrings(actualDataModels, expectedDataModels)) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/environment/playDataModelsUsed',
        'Data-model evidence must contain Edit, Server exactly when Play was observed, and Client exactly when navigation was requested.',
      ),
    );
  }
  if (duplicate(report.segmentResults.map((result) => result.segmentId))) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/segmentResults',
        'Segment results must have unique segment IDs.',
      ),
    );
  }
  if (duplicate(report.consoleEvidence.entries.map((entry) => entry.evidenceId))) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/consoleEvidence/entries',
        'Console evidence IDs must be unique.',
      ),
    );
  }
  if (duplicate(report.viewportEvidence.map((entry) => entry.evidenceId))) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/viewportEvidence',
        'Viewport evidence IDs must be unique.',
      ),
    );
  }
  if (duplicate(report.viewportEvidence.map((entry) => entry.checkpointId))) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/viewportEvidence',
        'Viewport evidence may contain at most one record per checkpoint.',
      ),
    );
  }
  report.segmentResults.forEach((result, index) => {
    const path = `/segmentResults/${index}`;
    if (
      result.path.status === 'success' &&
      (result.path.waypointCount < 1 || result.path.waypointDigestSha256 === undefined)
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `${path}/path`,
          'A successful path requires retained waypoints and their deterministic digest.',
        ),
      );
    }
    if (!sameStrings(result.failureCodes, expectedSegmentFailureCodes(result))) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `${path}/failureCodes`,
          'Segment failure codes must be the exact deterministic codes derived from evidence.',
        ),
      );
    }
    if (
      result.path.status === 'not_attempted' &&
      (result.path.waypointCount !== 0 ||
        result.path.totalPathDistance !== 0 ||
        result.path.jumpWaypointCount !== 0 ||
        result.path.waypointDigestSha256 !== undefined)
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `${path}/path`,
          'An unattempted path cannot retain path evidence.',
        ),
      );
    }
    if (
      result.path.status === 'failed' &&
      !(
        (result.path.waypointCount === 0 &&
          result.path.totalPathDistance === 0 &&
          result.path.jumpWaypointCount === 0 &&
          result.path.waypointDigestSha256 === undefined) ||
        (result.path.waypointCount >= 1 &&
          result.path.jumpWaypointCount >= 1 &&
          result.path.jumpWaypointCount <= result.path.waypointCount &&
          result.path.waypointDigestSha256 !== undefined)
      )
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `${path}/path`,
          'A failed path may retain evidence only for a bounded jump-required result.',
        ),
      );
    }
    if (result.path.status === 'success' && !result.navigation.requestedOnce) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `${path}/navigation/requestedOnce`,
          'A successful path segment must issue exactly one navigation request.',
        ),
      );
    }
    if (
      !result.navigation.requestedOnce &&
      (result.navigation.acknowledgmentCertain ||
        result.navigation.independentlyReached ||
        result.navigation.finalPosition !== undefined ||
        result.navigation.horizontalError !== undefined ||
        result.navigation.verticalError !== undefined ||
        result.navigation.finalVelocityMagnitude !== undefined)
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `${path}/navigation`,
          'Unrequested navigation cannot carry acknowledgment or arrival evidence.',
        ),
      );
    }
    if (
      result.arrival.status !== 'not_observed' &&
      (result.arrival.observedPosition === undefined ||
        result.arrival.horizontalError === undefined ||
        result.arrival.verticalError === undefined ||
        result.navigation.finalPosition === undefined ||
        result.navigation.horizontalError === undefined ||
        result.navigation.verticalError === undefined ||
        result.navigation.finalVelocityMagnitude === undefined)
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `${path}/arrival`,
          'Reached or missed arrival requires complete independent position, error, and velocity evidence.',
        ),
      );
    }
    if (
      result.arrival.status === 'not_observed' &&
      (result.arrival.observedPosition !== undefined ||
        result.arrival.horizontalError !== undefined ||
        result.arrival.verticalError !== undefined ||
        result.navigation.finalPosition !== undefined ||
        result.navigation.horizontalError !== undefined ||
        result.navigation.verticalError !== undefined ||
        result.navigation.finalVelocityMagnitude !== undefined)
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `${path}/arrival`,
          'An unobserved arrival cannot retain position, error, or velocity evidence.',
        ),
      );
    }
    if (
      result.arrival.status !== 'not_observed' &&
      (!result.navigation.requestedOnce ||
        result.navigation.independentlyReached !== (result.arrival.status === 'reached'))
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `${path}/arrival/status`,
          'Observed arrival status must match one requested navigation and independent reach truth.',
        ),
      );
    }
    if (
      result.arrival.status !== 'not_observed' &&
      result.arrival.observedPosition !== undefined &&
      result.arrival.horizontalError !== undefined &&
      result.arrival.verticalError !== undefined &&
      result.navigation.finalPosition !== undefined &&
      result.navigation.horizontalError !== undefined &&
      result.navigation.verticalError !== undefined
    ) {
      const expectedHorizontalError = horizontalError(
        result.arrival.observedPosition,
        result.arrival.targetPosition,
      );
      const expectedVerticalError = Math.abs(
        result.arrival.observedPosition.y - result.arrival.targetPosition.y,
      );
      if (
        !sameVector(result.navigation.finalPosition, result.arrival.observedPosition) ||
        result.arrival.horizontalError !== expectedHorizontalError ||
        result.arrival.verticalError !== expectedVerticalError ||
        result.navigation.horizontalError !== expectedHorizontalError ||
        result.navigation.verticalError !== expectedVerticalError
      ) {
        diagnostics.push(
          playtestDiagnostic(
            'playtest.run_report_invalid',
            `${path}/arrival`,
            'Observed arrival position and errors must be exact and internally consistent.',
          ),
        );
      }
    }
    const derivedAlive =
      result.character.observed &&
      result.character.health > 0 &&
      result.character.humanoidState !== 'dead';
    if (
      result.character.health > result.character.maximumHealth ||
      result.character.alive !== derivedAlive ||
      (result.character.humanoidState === 'dead' && result.character.health !== 0) ||
      (result.character.fallDetected && !result.character.observed)
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `${path}/character`,
          'Character health, life, state, and observation evidence are contradictory.',
        ),
      );
    }
    if (
      !result.character.observed &&
      (result.character.alive ||
        result.character.health !== 0 ||
        result.character.maximumHealth !== 0 ||
        result.character.humanoidState !== 'unknown' ||
        result.character.fallDetected ||
        result.character.observedLevel !== undefined)
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `${path}/character`,
          'Unobserved character evidence must use the exact zero and unknown sentinel state.',
        ),
      );
    }
    if (
      !result.clearance.observed &&
      (result.clearance.supported ||
        result.clearance.headClear ||
        result.clearance.bodyClear ||
        result.clearance.supportEntityId !== undefined ||
        result.clearance.managedBlockerIds.length !== 0 ||
        result.clearance.unmanagedBlockerCount !== 0)
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `${path}/clearance`,
          'Unobserved clearance must use the exact empty sentinel state.',
        ),
      );
    }
    if (result.arrival.status === 'reached' && !result.clearance.observed) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `${path}/clearance/observed`,
          'An independently reached segment requires one complete clearance observation.',
        ),
      );
    }
    if (result.arrival.status !== 'reached' && result.clearance.observed) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `${path}/clearance/observed`,
          'Clearance evidence may be observed only after independent segment arrival.',
        ),
      );
    }
    if (
      result.clearance.observed &&
      result.clearance.supportEntityId !== undefined &&
      !result.clearance.supported
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `${path}/clearance/supportEntityId`,
          'A retained managed support entity requires observed support truth.',
        ),
      );
    }
  });
  const newErrors = report.consoleEvidence.entries.filter(
    (entry) => entry.isNew && entry.severity === 'error',
  ).length;
  const newWarnings = report.consoleEvidence.entries.filter(
    (entry) => entry.isNew && entry.severity === 'warning',
  ).length;
  if (
    report.consoleEvidence.entries.some(
      (entry) =>
        !entry.isNew ||
        (entry.severity === 'error' && entry.classificationCode !== 'console-error') ||
        (entry.severity === 'warning' && entry.classificationCode !== 'console-warning') ||
        (entry.severity === 'info' &&
          entry.classificationCode !== 'console-information' &&
          entry.classificationCode !== 'console-output'),
    )
  ) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/consoleEvidence/entries',
        'Retained console entries must be new and use the fixed severity classification.',
      ),
    );
  }
  const expectedStartFailureCode =
    !report.start.requested || !report.start.acknowledgmentCertain
      ? 'start-uncertain'
      : !report.start.observedPlayRunning
        ? 'play-not-observed'
        : !report.start.identityProbePassed
          ? 'identity-unproved'
          : !report.start.characterReady
            ? 'character-missing'
            : 'none';
  if (report.start.failureCode !== expectedStartFailureCode) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/start/failureCode',
        'Start failure code is not the exact deterministic lifecycle result.',
      ),
    );
  }
  if (
    newErrors > report.consoleEvidence.newErrorCount ||
    newWarnings > report.consoleEvidence.newWarningCount
  ) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/consoleEvidence',
        'Sanitized console entries cannot exceed the complete new-entry counts.',
      ),
    );
  }
  const attempted = report.segmentResults.filter(
    (result) => result.path.status !== 'not_attempted',
  ).length;
  const reached = report.segmentResults.filter(
    (result) => result.arrival.status === 'reached',
  ).length;
  const pathFailures = report.segmentResults.filter(
    (result) => result.path.status === 'failed',
  ).length;
  const arrivalFailures = report.segmentResults.filter(
    (result) => result.arrival.status === 'missed',
  ).length;
  const clearanceFailures = report.segmentResults.filter(
    (result) =>
      result.clearance.observed &&
      (!result.clearance.supported || !result.clearance.headClear || !result.clearance.bodyClear),
  ).length;
  if (
    report.summary.segmentsPlanned !== report.segmentResults.length ||
    report.summary.segmentsAttempted !== attempted ||
    report.summary.segmentsReached !== reached ||
    report.summary.pathFailures !== pathFailures ||
    report.summary.arrivalFailures !== arrivalFailures ||
    report.summary.clearanceFailures !== clearanceFailures ||
    report.summary.consoleErrors !== report.consoleEvidence.newErrorCount ||
    report.summary.consoleWarnings !== report.consoleEvidence.newWarningCount ||
    report.summary.editIntegrityPassed !==
      (report.editIntegrity.exactMatch &&
        report.editIntegrity.finalManifestNoopOperationCount === 0)
  ) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/summary',
        'Run summary does not match its normalized evidence.',
      ),
    );
  }
  if (report.start.identityProbePassed && !report.start.observedPlayRunning) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/start',
        'Play identity cannot pass before running play is observed.',
      ),
    );
  }
  if (
    !report.start.requested &&
    (report.start.acknowledgmentCertain ||
      report.start.observedPlayRunning ||
      report.start.identityProbePassed ||
      report.start.characterReady)
  ) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/start',
        'Successful Play evidence requires an explicit start request.',
      ),
    );
  }
  if (
    report.setup.succeeded &&
    (!report.setup.attempted ||
      report.setup.verifiedPosition === undefined ||
      !sameVector(report.setup.requestedPosition, report.setup.verifiedPosition))
  ) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/setup',
        'Successful setup requires an attempt and verified position.',
      ),
    );
  }
  if (report.setup.failureCode !== (report.setup.succeeded ? 'none' : 'setup-failed')) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/setup/failureCode',
        'Setup failure code is not the exact deterministic setup result.',
      ),
    );
  }
  if (
    report.setup.attempted &&
    (!report.start.observedPlayRunning ||
      !report.start.identityProbePassed ||
      !report.start.characterReady)
  ) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/setup/attempted',
        'Setup may be attempted only after the owned Play identity and ready character are proved.',
      ),
    );
  }
  if (report.stop.requested && !report.start.identityProbePassed) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/stop/requested',
        'Stop may be requested only for a proved owned Play run.',
      ),
    );
  }
  if (report.stop.observedEditRestored && !report.stop.requested) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/stop',
        'Edit restoration cannot be attributed without a stop request.',
      ),
    );
  }
  const expectedStopFailureCode = !report.stop.requested
    ? 'none'
    : !report.stop.acknowledgmentCertain
      ? 'stop-uncertain'
      : !report.stop.observedEditRestored
        ? 'edit-not-restored'
        : 'none';
  if (report.stop.failureCode !== expectedStopFailureCode) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/stop/failureCode',
        'Stop failure code is not the exact deterministic lifecycle result.',
      ),
    );
  }
  if (
    report.stop.identityVerifiedBeforeSecondStop &&
    (!report.stop.requested || report.stop.acknowledgmentCertain)
  ) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/stop/identityVerifiedBeforeSecondStop',
        'Second-Stop identity evidence is permitted only after an uncertain first Stop request.',
      ),
    );
  }
  const hashesExactlyMatch =
    report.editIntegrity.postPlayEditSnapshotSha256 !== undefined &&
    report.editIntegrity.prePlayEditSnapshotSha256 ===
      report.editIntegrity.postPlayEditSnapshotSha256;
  if (report.editIntegrity.exactMatch !== hashesExactlyMatch) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/editIntegrity',
        'Exact Edit integrity must equal the deterministic pre/post snapshot-hash comparison.',
      ),
    );
  }
  return diagnostics;
}

function checkpointSourceIds(
  checkpoints: readonly PlaytestCheckpoint[],
  reached: ReadonlySet<string>,
  type: 'room' | 'floor',
): readonly string[] {
  const values = checkpoints.filter((checkpoint) => reached.has(checkpoint.id));
  return [
    ...new Set(
      type === 'room'
        ? values.flatMap((checkpoint) =>
            checkpoint.type === 'room_center' ? [checkpoint.roomId] : [],
          )
        : values.map((checkpoint) => checkpoint.sourceFloorId),
    ),
  ].sort(compareCodePoints);
}

function planBoundDiagnostics(
  plan: Readonly<PlaytestPlan>,
  report: Readonly<PlaytestRunReport>,
): PlaytestDiagnostic[] {
  const diagnostics: PlaytestDiagnostic[] = [];
  if (
    report.source.playtestPlanSha256 !== hashPlaytestPlan(plan) ||
    report.source.architecturePlanSha256 !== plan.source.architecturePlanSha256 ||
    report.source.robloxManifestSha256 !== plan.source.robloxManifestSha256 ||
    report.source.projectId !== plan.source.projectId ||
    report.source.manifestRootNodeId !== plan.source.manifestRootNodeId ||
    report.source.manifestSourceWorldSpecSha256 !== plan.source.manifestSourceWorldSpecSha256
  ) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_source_mismatch',
        '/source',
        'Run Report source does not match the exact Playtest Plan.',
      ),
    );
  }
  if (
    report.environment.managedNodeCount !== plan.source.expectedManagedInstanceCount ||
    report.environment.editBaseSnapshotSha256 !== report.editIntegrity.prePlayEditSnapshotSha256
  ) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_source_mismatch',
        '/environment',
        'Run environment does not match the Plan source or Edit base.',
      ),
    );
  }
  if (!sameVector(report.setup.requestedPosition, plan.setup.worldPosition)) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/setup/requestedPosition',
        'Run setup must request the exact Playtest Plan setup position.',
      ),
    );
  }
  if (report.segmentResults.length !== plan.segments.length) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/segmentResults',
        'Run Report must include one result for every planned segment.',
      ),
    );
  }
  let traversalHalted =
    !report.start.observedPlayRunning ||
    !report.start.identityProbePassed ||
    !report.start.characterReady ||
    !report.setup.succeeded;
  plan.segments.forEach((segment, index) => {
    const result = report.segmentResults[index];
    if (
      result === undefined ||
      result.sequence !== segment.sequence ||
      result.segmentId !== segment.id ||
      result.fromCheckpointId !== segment.fromCheckpointId ||
      result.toCheckpointId !== segment.toCheckpointId ||
      result.traversal !== segment.traversal
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `/segmentResults/${index}`,
          'Segment result does not match the exact planned segment.',
        ),
      );
      return;
    }
    const source = plan.checkpoints.find(
      (checkpoint) => checkpoint.id === segment.fromCheckpointId,
    );
    const target = plan.checkpoints.find((checkpoint) => checkpoint.id === segment.toCheckpointId);
    const expectedObservationLevel = result.navigation.requestedOnce
      ? target?.level
      : source?.level;
    if (
      expectedObservationLevel === undefined ||
      result.character.expectedLevel !== expectedObservationLevel
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `/segmentResults/${index}/character/expectedLevel`,
          'Character evidence must use the source level before navigation and the target level after navigation.',
        ),
      );
    }
    if (traversalHalted && result.path.status !== 'not_attempted') {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `/segmentResults/${index}/path/status`,
          'Traversal results after a terminal segment failure must remain unattempted.',
        ),
      );
    }
    if (result.path.status !== 'success' && result.navigation.requestedOnce) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `/segmentResults/${index}/navigation/requestedOnce`,
          'Navigation may be requested only after a successful path probe.',
        ),
      );
    }
    if (
      result.path.status === 'success' &&
      !plan.agent.canJump &&
      result.path.jumpWaypointCount > 0
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `/segmentResults/${index}/path/jumpWaypointCount`,
          'A no-jump agent cannot report a jumping path as successful.',
        ),
      );
    }
    if (
      result.arrival.status === 'reached' &&
      (!result.navigation.requestedOnce || !result.navigation.independentlyReached)
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `/segmentResults/${index}/arrival`,
          'A reached target requires one navigation request and independent arrival evidence.',
        ),
      );
    }
    if (
      result.arrival.status === 'reached' &&
      target !== undefined &&
      result.character.observedLevel === undefined
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `/segmentResults/${index}/character/observedLevel`,
          'Reached segment evidence must include an observed floor classification.',
        ),
      );
    }
    if (
      result.arrival.status === 'reached' &&
      target !== undefined &&
      result.character.observedLevel !== undefined &&
      result.character.observedLevel !== target.level &&
      !result.failureCodes.includes('wrong-floor')
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `/segmentResults/${index}/failureCodes`,
          'A wrong-floor observation must carry its fixed failure code.',
        ),
      );
    }
    if (target !== undefined && !sameVector(result.arrival.targetPosition, target.worldPosition)) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `/segmentResults/${index}/arrival/targetPosition`,
          'Arrival target must equal the exact planned checkpoint position.',
        ),
      );
    }
    if (
      result.arrival.status !== 'not_observed' &&
      result.arrival.observedPosition !== undefined &&
      result.arrival.horizontalError !== undefined &&
      result.arrival.verticalError !== undefined &&
      result.navigation.finalPosition !== undefined &&
      result.navigation.horizontalError !== undefined &&
      result.navigation.verticalError !== undefined
    ) {
      const expectedHorizontalError = result.arrival.horizontalError;
      const expectedVerticalError = result.arrival.verticalError;
      const withinTolerance =
        expectedHorizontalError <= plan.agent.arrivalHorizontalTolerance &&
        expectedVerticalError <= plan.agent.arrivalVerticalTolerance;
      const terminalEvidenceExplainsMiss =
        result.character.observed &&
        (!result.character.alive ||
          result.character.health <= 0 ||
          result.character.fallDetected ||
          (result.character.observedLevel !== undefined &&
            result.character.observedLevel !== result.character.expectedLevel));
      if (
        (result.arrival.status === 'reached' && !withinTolerance) ||
        (result.arrival.status === 'missed' && withinTolerance && !terminalEvidenceExplainsMiss)
      ) {
        diagnostics.push(
          playtestDiagnostic(
            'playtest.run_report_invalid',
            `/segmentResults/${index}/arrival`,
            'Arrival status must match the exact horizontal and vertical tolerances.',
          ),
        );
      }
    }
    if (
      result.path.status !== 'success' ||
      result.arrival.status !== 'reached' ||
      !result.navigation.independentlyReached ||
      result.failureCodes.length > 0 ||
      (result.character.observed &&
        (!result.character.alive || result.character.health <= 0 || result.character.fallDetected))
    )
      traversalHalted = true;
  });
  const reached = new Set<string>();
  if (report.setup.succeeded) reached.add(plan.setup.checkpointId);
  for (const result of report.segmentResults)
    if (result.arrival.status === 'reached' && result.navigation.independentlyReached)
      reached.add(result.toCheckpointId);
  const authorizedCaptures = new Set(plan.captureCheckpoints);
  const viewportById = new Map(
    report.viewportEvidence.map((evidence) => [evidence.evidenceId, evidence] as const),
  );
  for (const [index, result] of report.segmentResults.entries()) {
    if (result.viewportEvidenceId === undefined) continue;
    const evidence = viewportById.get(result.viewportEvidenceId);
    if (
      evidence === undefined ||
      evidence.checkpointId !== result.toCheckpointId ||
      result.arrival.status !== 'reached' ||
      !result.navigation.independentlyReached ||
      !authorizedCaptures.has(evidence.checkpointId) ||
      !reached.has(evidence.checkpointId)
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `/segmentResults/${index}/viewportEvidenceId`,
          'Segment viewport evidence must resolve to its exact independently reached authorized capture checkpoint.',
        ),
      );
    }
  }
  for (const [index, evidence] of report.viewportEvidence.entries()) {
    const referencedBySegment = report.segmentResults.some(
      (result) =>
        result.viewportEvidenceId === evidence.evidenceId &&
        result.toCheckpointId === evidence.checkpointId,
    );
    const setupCapture = evidence.checkpointId === plan.setup.checkpointId;
    if (
      !authorizedCaptures.has(evidence.checkpointId) ||
      !reached.has(evidence.checkpointId) ||
      (!setupCapture && !referencedBySegment)
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.run_report_invalid',
          `/viewportEvidence/${index}`,
          'Viewport evidence must be authorized, independently reached, and referenced by its target segment unless it is the setup capture.',
        ),
      );
    }
  }
  const requiredCheckpointIds = plan.requiredCoverage.checkpoints.ids;
  const missedCheckpointIds = requiredCheckpointIds
    .filter((id) => !reached.has(id))
    .sort(compareCodePoints);
  const reachedRooms = checkpointSourceIds(plan.checkpoints, reached, 'room');
  const reachedFloors = checkpointSourceIds(plan.checkpoints, reached, 'floor');
  const missedRoomIds = plan.requiredCoverage.rooms.ids.filter((id) => !reachedRooms.includes(id));
  const missedFloorIds = plan.requiredCoverage.floors.ids.filter(
    (id) => !reachedFloors.includes(id),
  );
  const checkpointById = new Map(
    plan.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint] as const),
  );
  const traversedStairs = new Set<string>();
  for (const result of report.segmentResults) {
    if (
      result.arrival.status !== 'reached' ||
      !result.navigation.independentlyReached ||
      result.traversal !== 'stair'
    )
      continue;
    const from = checkpointById.get(result.fromCheckpointId);
    const to = checkpointById.get(result.toCheckpointId);
    if (
      from === undefined ||
      to === undefined ||
      from.level === to.level ||
      result.character.observedLevel !== to.level
    )
      continue;
    const stairRunId =
      to.type === 'stair_landing' || to.type === 'stair_hall'
        ? to.stairRunId
        : from.type === 'stair_landing' || from.type === 'stair_hall'
          ? from.stairRunId
          : undefined;
    if (stairRunId !== undefined) traversedStairs.add(stairRunId);
  }
  const missedStairs = plan.requiredCoverage.stairRuns.ids.filter((id) => !traversedStairs.has(id));
  const expectedCoverage = {
    requiredCheckpointCount: requiredCheckpointIds.length,
    reachedCheckpointCount: requiredCheckpointIds.length - missedCheckpointIds.length,
    missedCheckpointIds,
    requiredRoomCount: plan.requiredCoverage.rooms.count,
    reachedRoomCount: reachedRooms.length,
    missedRoomIds,
    requiredFloorCount: plan.requiredCoverage.floors.count,
    reachedFloorCount: reachedFloors.length,
    missedFloorIds,
    requiredStairRunCount: plan.requiredCoverage.stairRuns.count,
    traversedStairRunCount: traversedStairs.size,
    missedStairRunIds: missedStairs,
  };
  if (
    report.coverage.requiredCheckpointCount !== expectedCoverage.requiredCheckpointCount ||
    report.coverage.reachedCheckpointCount !== expectedCoverage.reachedCheckpointCount ||
    !sameStrings(report.coverage.missedCheckpointIds, expectedCoverage.missedCheckpointIds) ||
    report.coverage.requiredRoomCount !== expectedCoverage.requiredRoomCount ||
    report.coverage.reachedRoomCount !== expectedCoverage.reachedRoomCount ||
    !sameStrings(report.coverage.missedRoomIds, expectedCoverage.missedRoomIds) ||
    report.coverage.requiredFloorCount !== expectedCoverage.requiredFloorCount ||
    report.coverage.reachedFloorCount !== expectedCoverage.reachedFloorCount ||
    !sameStrings(report.coverage.missedFloorIds, expectedCoverage.missedFloorIds) ||
    report.coverage.requiredStairRunCount !== expectedCoverage.requiredStairRunCount ||
    report.coverage.traversedStairRunCount !== expectedCoverage.traversedStairRunCount ||
    !sameStrings(report.coverage.missedStairRunIds, expectedCoverage.missedStairRunIds)
  ) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/coverage',
        'Coverage is not derivable from independently reached checkpoints.',
      ),
    );
  }
  const allCoverage =
    missedCheckpointIds.length === 0 &&
    missedRoomIds.length === 0 &&
    missedFloorIds.length === 0 &&
    missedStairs.length === 0;
  if (report.summary.allRequiredCoverageReached !== allCoverage) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/summary/allRequiredCoverageReached',
        'Coverage summary is inconsistent.',
      ),
    );
  }
  const observedCharacterResults = report.segmentResults.filter(
    (result) => result.character.observed,
  );
  const characterSurvived =
    report.start.characterReady &&
    observedCharacterResults.length > 0 &&
    observedCharacterResults.every(
      (result) =>
        result.character.alive && result.character.health > 0 && !result.character.fallDetected,
    );
  if (report.summary.characterSurvived !== characterSurvived) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/summary/characterSurvived',
        'Character survival summary is not derivable from character evidence.',
      ),
    );
  }
  const attempted = report.segmentResults.filter(
    (result) => result.path.status !== 'not_attempted',
  ).length;
  const expectedStatus =
    !report.start.requested ||
    !report.start.observedPlayRunning ||
    !report.start.identityProbePassed ||
    !report.start.characterReady
      ? 'failed_to_start'
      : !report.stop.observedEditRestored
        ? 'failed_to_stop'
        : !report.setup.succeeded || attempted < plan.segments.length
          ? 'aborted'
          : 'completed';
  if (report.summary.status !== expectedStatus) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.run_report_invalid',
        '/summary/status',
        'Run status is not derivable from start, traversal, and stop evidence.',
      ),
    );
  }
  return diagnostics;
}

export function validatePlaytestRunReport(
  input: unknown,
): PlaytestValidationResult<PlaytestRunReport> {
  const compatibility = inspectJsonCompatibility(input);
  if (compatibility !== undefined) {
    return {
      valid: false,
      diagnostics: [playtestDiagnostic('json.invalid', compatibility.path, compatibility.reason)],
    };
  }
  if (!checkReport(input))
    return {
      valid: false,
      diagnostics: sortPlaytestDiagnostics(schemaDiagnostics(checkReport.errors)),
    };
  const report = input as PlaytestRunReport;
  const diagnostics = sortPlaytestDiagnostics(standaloneDiagnostics(report));
  return diagnostics.length === 0
    ? { valid: true, value: normalizePlaytestRunReport(report), diagnostics: [] }
    : { valid: false, diagnostics };
}

export function validatePlaytestRunReportAgainstPlan(
  planInput: unknown,
  reportInput: unknown,
): PlaytestValidationResult<PlaytestRunReport> {
  const planResult = validatePlaytestPlan(planInput);
  if (!planResult.valid) return planResult;
  const reportResult = validatePlaytestRunReport(reportInput);
  if (!reportResult.valid) return reportResult;
  const diagnostics = sortPlaytestDiagnostics(
    planBoundDiagnostics(planResult.value, reportResult.value),
  );
  return diagnostics.length === 0
    ? { valid: true, value: reportResult.value, diagnostics: [] }
    : { valid: false, diagnostics };
}
