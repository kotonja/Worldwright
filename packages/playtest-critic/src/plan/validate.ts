import { createHash } from 'node:crypto';

import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';

import {
  playtestDiagnostic,
  sortPlaytestDiagnostics,
  type PlaytestDiagnostic,
  type PlaytestValidationResult,
} from '../diagnostic.js';
import { compareCodePoints, inspectJsonCompatibility } from '../json.js';
import {
  PlaytestPlanSchema,
  type PlaytestCheckpoint,
  type PlaytestPlan,
  type PlaytestRequiredCoverage,
} from './contract-schema.js';
import { normalizePlaytestPlan } from './normalize.js';

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictNumbers: true,
  validateFormats: false,
});
const checkPlan = ajv.compile(PlaytestPlanSchema);

function schemaDiagnostics(
  errors: readonly ErrorObject[] | null | undefined,
): PlaytestDiagnostic[] {
  return (errors ?? []).map((error) =>
    playtestDiagnostic(
      'playtest.plan_invalid',
      error.instancePath,
      `Playtest Plan schema rejected ${error.keyword}.`,
    ),
  );
}

function duplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareCodePoints);
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

function expectedSegmentId(
  sequence: number,
  fromCheckpointId: string,
  toCheckpointId: string,
  sourceCirculationEdgeId: string,
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([String(sequence), fromCheckpointId, toCheckpointId, sourceCirculationEdgeId]),
      'utf8',
    )
    .digest('hex');
  return `pt-segment-${digest.slice(0, 20)}`;
}

function checkDimension(
  path: string,
  actual: Readonly<{ ids: readonly string[]; count: number }>,
  expectedIds: readonly string[],
  diagnostics: PlaytestDiagnostic[],
): void {
  const expected = sortedUnique(expectedIds);
  if (
    duplicates(actual.ids) ||
    actual.count !== actual.ids.length ||
    !sameStrings([...actual.ids].sort(compareCodePoints), expected)
  ) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.plan_invalid',
        path,
        'Required coverage IDs and count do not match derived plan coverage.',
      ),
    );
  }
}

function checkpointOpeningIds(checkpoints: readonly PlaytestCheckpoint[]): readonly string[] {
  return checkpoints.flatMap((checkpoint) =>
    'openingId' in checkpoint ? [checkpoint.openingId] : [],
  );
}

function semanticDiagnostics(plan: Readonly<PlaytestPlan>): PlaytestDiagnostic[] {
  const diagnostics: PlaytestDiagnostic[] = [];
  const checkpoints = new Map(
    plan.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint] as const),
  );
  if (checkpoints.size !== plan.checkpoints.length) {
    diagnostics.push(
      playtestDiagnostic('playtest.plan_invalid', '/checkpoints', 'Checkpoint IDs must be unique.'),
    );
  }
  if (new Set(plan.segments.map((segment) => segment.id)).size !== plan.segments.length) {
    diagnostics.push(
      playtestDiagnostic('playtest.plan_invalid', '/segments', 'Segment IDs must be unique.'),
    );
  }
  const routeCheckpoints = new Set<string>();
  plan.segments.forEach((segment, index) => {
    const from = checkpoints.get(segment.fromCheckpointId);
    const to = checkpoints.get(segment.toCheckpointId);
    if (segment.sequence !== index) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.plan_invalid',
          `/segments/${index}/sequence`,
          'Segment sequences must be contiguous from zero.',
        ),
      );
    }
    if (
      segment.id !==
      expectedSegmentId(
        segment.sequence,
        segment.fromCheckpointId,
        segment.toCheckpointId,
        segment.sourceCirculationEdgeId,
      )
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.plan_invalid',
          `/segments/${index}/id`,
          'Segment ID does not match its deterministic route tuple.',
        ),
      );
    }
    if (from === undefined || to === undefined) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.plan_invalid',
          `/segments/${index}`,
          'Segment checkpoint reference does not resolve.',
        ),
      );
    } else {
      if (segment.expectedFromLevel !== from.level || segment.expectedToLevel !== to.level) {
        diagnostics.push(
          playtestDiagnostic(
            'playtest.plan_invalid',
            `/segments/${index}`,
            'Segment expected levels differ from their checkpoints.',
          ),
        );
      }
      if (from.level !== to.level && segment.traversal !== 'stair') {
        diagnostics.push(
          playtestDiagnostic(
            'playtest.plan_invalid',
            `/segments/${index}/traversal`,
            'Only an explicit stair traversal may change floor level.',
          ),
        );
      }
      if (from.level !== to.level) {
        const validCrossing =
          from.type === 'stair_landing' &&
          to.type === 'stair_landing' &&
          from.stairRunId === to.stairRunId &&
          from.landing !== to.landing;
        if (!validCrossing) {
          diagnostics.push(
            playtestDiagnostic(
              'playtest.plan_invalid',
              `/segments/${index}`,
              'A cross-level stair segment must connect the exact landing pair for one stair run.',
            ),
          );
        }
      }
    }
    if (index > 0 && plan.segments[index - 1]?.toCheckpointId !== segment.fromCheckpointId) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.plan_invalid',
          `/segments/${index}`,
          'Route segments must form one continuous sequence.',
        ),
      );
    }
    routeCheckpoints.add(segment.fromCheckpointId);
    routeCheckpoints.add(segment.toCheckpointId);
  });
  for (const checkpoint of plan.checkpoints) {
    if (checkpoint.required && !routeCheckpoints.has(checkpoint.id)) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.plan_invalid',
          '/checkpoints',
          'Every required checkpoint must occur in the route.',
          checkpoint.id,
        ),
      );
    }
  }
  if (
    plan.segments[0]?.fromCheckpointId !== plan.setup.checkpointId ||
    checkpoints.get(plan.setup.checkpointId)?.type !== 'exterior_entrance'
  ) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.plan_invalid',
        '/setup/checkpointId',
        'Setup must resolve to the route-start exterior checkpoint.',
      ),
    );
  } else {
    const setupCheckpoint = checkpoints.get(plan.setup.checkpointId);
    if (
      setupCheckpoint === undefined ||
      setupCheckpoint.type !== 'exterior_entrance' ||
      !sameVector(plan.setup.worldPosition, setupCheckpoint.worldPosition) ||
      plan.setup.expectedLevel !== setupCheckpoint.level ||
      plan.setup.sourceFloorId !== setupCheckpoint.sourceFloorId ||
      plan.setup.expectedFinishedFloorElevation !==
        setupCheckpoint.expectedFinishedFloorElevation ||
      plan.setup.exteriorEntranceOpeningId !== setupCheckpoint.openingId ||
      plan.setup.entranceRoomId !== setupCheckpoint.roomId
    ) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.plan_invalid',
          '/setup',
          'Setup does not exactly match its exterior entrance checkpoint.',
        ),
      );
    }
  }
  if (
    duplicates(plan.captureCheckpoints) ||
    plan.captureCheckpoints.some((id) => !checkpoints.has(id))
  ) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.plan_invalid',
        '/captureCheckpoints',
        'Capture checkpoint references must be unique and resolvable.',
      ),
    );
  }
  const rooms = plan.checkpoints.flatMap((checkpoint) =>
    checkpoint.type === 'room_center' ? [checkpoint.roomId] : [],
  );
  const floors = plan.checkpoints.map((checkpoint) => checkpoint.sourceFloorId);
  const corridors = plan.checkpoints.flatMap((checkpoint) =>
    checkpoint.type === 'corridor' ? [checkpoint.corridorId] : [],
  );
  const stairRuns = plan.checkpoints.flatMap((checkpoint) =>
    checkpoint.type === 'stair_hall' || checkpoint.type === 'stair_landing'
      ? [checkpoint.stairRunId]
      : [],
  );
  for (const stairRunId of sortedUnique(stairRuns)) {
    const crossed = plan.segments.some((segment) => {
      const from = checkpoints.get(segment.fromCheckpointId);
      const to = checkpoints.get(segment.toCheckpointId);
      return (
        segment.traversal === 'stair' &&
        from?.type === 'stair_landing' &&
        to?.type === 'stair_landing' &&
        from.stairRunId === stairRunId &&
        to.stairRunId === stairRunId &&
        from.level !== to.level
      );
    });
    if (!crossed) {
      diagnostics.push(
        playtestDiagnostic(
          'playtest.plan_invalid',
          '/segments',
          'Every required stair run must be crossed between its lower and upper landings.',
          stairRunId,
        ),
      );
    }
  }
  const coverage: Readonly<PlaytestRequiredCoverage> = plan.requiredCoverage;
  checkDimension('/requiredCoverage/rooms', coverage.rooms, rooms, diagnostics);
  checkDimension('/requiredCoverage/floors', coverage.floors, floors, diagnostics);
  checkDimension('/requiredCoverage/corridors', coverage.corridors, corridors, diagnostics);
  checkDimension('/requiredCoverage/stairRuns', coverage.stairRuns, stairRuns, diagnostics);
  checkDimension(
    '/requiredCoverage/openings',
    coverage.openings,
    checkpointOpeningIds(plan.checkpoints),
    diagnostics,
  );
  checkDimension(
    '/requiredCoverage/checkpoints',
    coverage.checkpoints,
    plan.checkpoints.filter((checkpoint) => checkpoint.required).map((checkpoint) => checkpoint.id),
    diagnostics,
  );
  checkDimension(
    '/requiredCoverage/segments',
    coverage.segments,
    plan.segments.map((segment) => segment.id),
    diagnostics,
  );
  return diagnostics;
}

export function validatePlaytestPlan(input: unknown): PlaytestValidationResult<PlaytestPlan> {
  const compatibility = inspectJsonCompatibility(input);
  if (compatibility !== undefined) {
    return {
      valid: false,
      diagnostics: [playtestDiagnostic('json.invalid', compatibility.path, compatibility.reason)],
    };
  }
  if (!checkPlan(input)) {
    return {
      valid: false,
      diagnostics: sortPlaytestDiagnostics(schemaDiagnostics(checkPlan.errors)),
    };
  }
  const value = input as PlaytestPlan;
  const diagnostics = sortPlaytestDiagnostics(semanticDiagnostics(value));
  return diagnostics.length === 0
    ? { valid: true, value: normalizePlaytestPlan(value), diagnostics: [] }
    : { valid: false, diagnostics };
}
