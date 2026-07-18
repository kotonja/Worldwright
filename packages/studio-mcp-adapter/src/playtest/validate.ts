import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';

import {
  compareCodePoints,
  sortStudioDiagnostics,
  studioDiagnostic,
  type StudioDiagnostic,
} from '../diagnostics.js';
import { inspectJsonCompatibility } from '../json.js';
import {
  StudioPlaytestProbeRequestSchema,
  StudioPlaytestProbeResponseSchema,
} from './contract-schema.js';
import {
  normalizeStudioPlaytestProbeRequest,
  normalizeStudioPlaytestProbeResponse,
} from './normalize.js';
import type {
  StudioPlaytestContractValidationResult,
  StudioPlaytestProbeRequest,
  StudioPlaytestProbeResponse,
} from './types.js';

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictNumbers: true,
  validateFormats: false,
});
const checkRequest = ajv.compile<StudioPlaytestProbeRequest>(StudioPlaytestProbeRequestSchema);
const checkResponse = ajv.compile<StudioPlaytestProbeResponse>(StudioPlaytestProbeResponseSchema);

function errorPath(error: ErrorObject): string {
  const property =
    error.keyword === 'required'
      ? (error.params as Readonly<{ missingProperty?: unknown }>).missingProperty
      : error.keyword === 'additionalProperties'
        ? (error.params as Readonly<{ additionalProperty?: unknown }>).additionalProperty
        : undefined;
  return typeof property === 'string'
    ? `${error.instancePath}/${property.replaceAll('~', '~0').replaceAll('/', '~1')}`
    : error.instancePath;
}

function firstError(errors: readonly ErrorObject[] | null | undefined): ErrorObject | undefined {
  return [...(errors ?? [])].sort((left, right) => {
    const leftPriority =
      left.keyword === 'additionalProperties' ? 0 : left.keyword === 'required' ? 1 : 2;
    const rightPriority =
      right.keyword === 'additionalProperties' ? 0 : right.keyword === 'required' ? 1 : 2;
    return (
      leftPriority - rightPriority ||
      compareCodePoints(errorPath(left), errorPath(right)) ||
      compareCodePoints(left.keyword, right.keyword)
    );
  })[0];
}

function schemaFailure<T>(
  input: unknown,
  check: ((value: unknown) => value is T) & { errors?: readonly ErrorObject[] | null },
  subject: string,
): StudioPlaytestContractValidationResult<T> | undefined {
  const compatibility = inspectJsonCompatibility(input);
  if (compatibility !== undefined) {
    return {
      valid: false,
      diagnostics: [
        studioDiagnostic(
          'studio.playtest_probe_invalid',
          compatibility.path,
          `${subject} is not JSON-compatible: ${compatibility.reason}.`,
        ),
      ],
    };
  }
  if (check(input)) return undefined;
  const error = firstError(check.errors);
  return {
    valid: false,
    diagnostics: [
      studioDiagnostic(
        'studio.playtest_probe_invalid',
        error === undefined ? '' : errorPath(error),
        `${subject} does not satisfy its strict contract.`,
      ),
    ],
  };
}

function duplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function sameVector(
  left: Readonly<{ readonly x: number; readonly y: number; readonly z: number }>,
  right: Readonly<{ readonly x: number; readonly y: number; readonly z: number }>,
): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function pathDistance(
  start: Readonly<{ readonly x: number; readonly y: number; readonly z: number }>,
  waypoints: readonly Readonly<{ readonly x: number; readonly y: number; readonly z: number }>[],
): number {
  let previous = start;
  let total = 0;
  for (const waypoint of waypoints) {
    total += Math.hypot(waypoint.x - previous.x, waypoint.y - previous.y, waypoint.z - previous.z);
    previous = waypoint;
  }
  return total;
}

function requestDiagnostics(
  request: Readonly<StudioPlaytestProbeRequest>,
): readonly StudioDiagnostic[] {
  const diagnostics: StudioDiagnostic[] = [];
  if (request.identity.sandboxLease.projectId !== request.identity.projectId) {
    diagnostics.push(
      studioDiagnostic(
        'studio.playtest_probe_invalid',
        '/identity/sandboxLease/projectId',
        'Playtest probe lease project must match the expected managed project.',
      ),
    );
  }
  if (request.action === 'player_state') {
    const floorIds = request.floors.map((floor) => floor.floorId);
    const levels = request.floors.map((floor) => String(floor.level));
    if (duplicates(floorIds) || duplicates(levels)) {
      diagnostics.push(
        studioDiagnostic(
          'studio.playtest_probe_invalid',
          '/floors',
          'Playtest floor classifications must have unique floor IDs and levels.',
        ),
      );
    }
  }
  if (request.action === 'path_probe' && request.fromCheckpointId === request.targetCheckpointId) {
    diagnostics.push(
      studioDiagnostic(
        'studio.playtest_probe_invalid',
        '/targetCheckpointId',
        'A playtest path probe must connect two different checkpoints.',
      ),
    );
  }
  return sortStudioDiagnostics(diagnostics);
}

function responseDiagnostics(
  response: Readonly<StudioPlaytestProbeResponse>,
  request?: Readonly<StudioPlaytestProbeRequest>,
): readonly StudioDiagnostic[] {
  const diagnostics: StudioDiagnostic[] = [];
  if (request !== undefined && response.action !== request.action) {
    diagnostics.push(
      studioDiagnostic(
        'studio.response_invalid',
        '/action',
        'Studio playtest probe response action does not match its request.',
      ),
    );
  }
  if (!response.ok) {
    const privateValues =
      request === undefined
        ? []
        : [
            request.identity.sandboxLease.leaseId,
            request.identity.playtestPlanSha256,
            request.identity.sandboxLease.changeSetHash,
          ];
    if (privateValues.some((value) => response.diagnostic.message.includes(value))) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/diagnostic/message',
          'Studio playtest diagnostics must not expose private identity material.',
        ),
      );
    }
    return sortStudioDiagnostics(diagnostics);
  }
  if (response.action === 'identity_probe' && request !== undefined) {
    if (
      !response.projectIdentityMatched ||
      !response.rootIdentityMatched ||
      response.managedNodeCount !== request.identity.expectedManagedNodeCount ||
      response.dataModelType !== 'Server' ||
      !response.playRunning
    ) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/managedNodeCount',
          'Studio playtest identity response does not match the expected run identity.',
        ),
      );
    }
  }
  if (response.action === 'character_setup' && request?.action === 'character_setup') {
    if (
      !sameVector(response.position, request.setupPosition) ||
      response.linearVelocityMagnitude !== 0 ||
      response.angularVelocityMagnitude !== 0
    ) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/position',
          'Character setup must verify the exact requested position and zero velocity.',
        ),
      );
    }
  }
  if (response.action === 'path_probe') {
    if (response.waypointCount !== response.waypoints.length) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/waypointCount',
          'Studio path waypoint count does not match its bounded waypoint list.',
        ),
      );
    }
    if (
      request?.action === 'path_probe' &&
      (response.fromCheckpointId !== request.fromCheckpointId ||
        response.targetCheckpointId !== request.targetCheckpointId)
    ) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/targetCheckpointId',
          'Studio path response checkpoint identity does not match its request.',
        ),
      );
    }
    if (request?.action === 'path_probe') {
      const recomputedDistance = pathDistance(request.fromWorldPosition, response.waypoints);
      const tolerance = Math.max(1, recomputedDistance) * 1e-6;
      if (Math.abs(response.totalPathDistance - recomputedDistance) > tolerance) {
        diagnostics.push(
          studioDiagnostic(
            'studio.response_invalid',
            '/totalPathDistance',
            'Studio path distance does not match the exact source and retained waypoints.',
          ),
        );
      }
    }
    if (
      response.status === 'success' &&
      (response.waypointCount === 0 || response.requiresJump || response.jumpWaypointCount !== 0)
    ) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/status',
          'A successful fixed-agent path must contain waypoints and require no jump.',
        ),
      );
    }
    const jumpEvidenceValid =
      response.status === 'jump_required' &&
      response.requiresJump &&
      response.jumpWaypointCount > 0 &&
      response.jumpWaypointCount <= response.waypointCount &&
      response.waypointCount > 0;
    const emptyFailureEvidence =
      response.status !== 'success' &&
      response.status !== 'jump_required' &&
      response.waypointCount === 0 &&
      response.waypoints.length === 0 &&
      response.totalPathDistance === 0 &&
      !response.requiresJump &&
      response.jumpWaypointCount === 0;
    if (response.status !== 'success' && !jumpEvidenceValid && !emptyFailureEvidence) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/status',
          'A non-success path must carry either exact jump-required evidence or no path evidence.',
        ),
      );
    }
  }
  if (response.action === 'player_state') {
    if ((response.supportDistance !== undefined) !== response.supported) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/supportDistance',
          'Player support distance must be present exactly when support was observed.',
        ),
      );
    }
    if ((response.currentLevel !== undefined) !== (response.currentFloorId !== undefined)) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/currentFloorId',
          'Player floor ID must be present exactly when a level was classified.',
        ),
      );
    }
    if (
      response.health > response.maximumHealth ||
      response.alive !==
        (response.health > 0 && response.hasHumanoidRootPart && response.humanoidState !== 'Dead')
    ) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/alive',
          'Player health, root, Humanoid state, and alive classification are inconsistent.',
        ),
      );
    }
    if (response.managedSupportEntityId !== undefined && !response.supported) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/managedSupportEntityId',
          'Player managed support identity may be present only with observed support.',
        ),
      );
    }
    if (
      request?.action === 'player_state' &&
      response.currentFloorId !== undefined &&
      !request.floors.some(
        (floor) =>
          floor.floorId === response.currentFloorId && floor.level === response.currentLevel,
      )
    ) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/currentFloorId',
          'Player floor classification must equal one exact requested floor pair.',
        ),
      );
    }
  }
  if (response.action === 'clearance_probe') {
    if ((response.supportDistance !== undefined) !== response.supported) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/supportDistance',
          'Clearance support distance must be present exactly when support was observed.',
        ),
      );
    }
    if (request?.action === 'clearance_probe' && response.checkpointId !== request.checkpointId) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/checkpointId',
          'Clearance response checkpoint identity does not match its request.',
        ),
      );
    }
    if (response.managedSupportEntityId !== undefined && !response.supported) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/managedSupportEntityId',
          'Clearance managed support identity may be present only with observed support.',
        ),
      );
    }
    if (
      response.bodyClear !==
      (response.managedBlockerIds.length === 0 && response.unmanagedBlockerCount === 0)
    ) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/bodyClear',
          'Body clearance must agree with the complete bounded blocker evidence.',
        ),
      );
    }
    if (
      duplicates(response.managedBlockerIds) ||
      [...response.managedBlockerIds]
        .sort(compareCodePoints)
        .some((value, index) => value !== response.managedBlockerIds[index])
    ) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/managedBlockerIds',
          'Managed blocker IDs must be unique and sorted by code point.',
        ),
      );
    }
  }
  return sortStudioDiagnostics(diagnostics);
}

export function validateStudioPlaytestProbeRequest(
  input: unknown,
): StudioPlaytestContractValidationResult<StudioPlaytestProbeRequest> {
  try {
    const failure = schemaFailure(input, checkRequest, 'Studio playtest probe request');
    if (failure !== undefined) return failure;
    const request = input as StudioPlaytestProbeRequest;
    const diagnostics = requestDiagnostics(request);
    return diagnostics.length > 0
      ? { valid: false, diagnostics }
      : { valid: true, value: normalizeStudioPlaytestProbeRequest(request), diagnostics: [] };
  } catch {
    return {
      valid: false,
      diagnostics: [
        studioDiagnostic(
          'studio.playtest_probe_invalid',
          '',
          'Studio playtest probe request could not be safely inspected.',
        ),
      ],
    };
  }
}

export function validateStudioPlaytestProbeResponse(
  input: unknown,
): StudioPlaytestContractValidationResult<StudioPlaytestProbeResponse> {
  try {
    const failure = schemaFailure(input, checkResponse, 'Studio playtest probe response');
    if (failure !== undefined) return failure;
    const response = input as StudioPlaytestProbeResponse;
    const diagnostics = responseDiagnostics(response);
    return diagnostics.length > 0
      ? { valid: false, diagnostics }
      : { valid: true, value: normalizeStudioPlaytestProbeResponse(response), diagnostics: [] };
  } catch {
    return {
      valid: false,
      diagnostics: [
        studioDiagnostic(
          'studio.response_invalid',
          '',
          'Studio playtest probe response could not be safely inspected.',
        ),
      ],
    };
  }
}

export function validateStudioPlaytestProbeResponseForRequest(
  input: unknown,
  requestInput: unknown,
): StudioPlaytestContractValidationResult<StudioPlaytestProbeResponse> {
  const requestValidation = validateStudioPlaytestProbeRequest(requestInput);
  if (!requestValidation.valid) return requestValidation;
  const responseValidation = validateStudioPlaytestProbeResponse(input);
  if (!responseValidation.valid) return responseValidation;
  const diagnostics = responseDiagnostics(responseValidation.value, requestValidation.value);
  return diagnostics.length > 0 ? { valid: false, diagnostics } : responseValidation;
}
