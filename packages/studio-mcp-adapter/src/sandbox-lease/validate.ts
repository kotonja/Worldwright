import { Buffer } from 'node:buffer';

import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import { STUDIO_MCP_MAX_SANDBOX_LEASE_BYTES } from '../constants.js';
import {
  compareCodePoints,
  sortStudioDiagnostics,
  studioDiagnostic,
  type StudioDiagnostic,
  type StudioDiagnosticCode,
} from '../diagnostics.js';
import { inspectJsonCompatibility } from '../json.js';
import { compactSnapshotSemanticDiagnostics } from '../snapshot.js';
import {
  StudioSandboxLeaseRecordSchema,
  StudioSandboxLeaseRequestSchema,
  StudioSandboxLeaseResponseSchema,
} from './contract-schema.js';
import {
  normalizeSandboxLeaseRecord,
  normalizeStudioSandboxLeaseRequest,
  normalizeStudioSandboxLeaseResponse,
  stringifySandboxLeaseRecord,
} from './normalize.js';
import type {
  StudioSandboxLeaseContractValidationResult,
  StudioSandboxLeaseRecord,
  StudioSandboxLeaseRequest,
  StudioSandboxLeaseResponse,
} from './types.js';

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictNumbers: true,
  validateFormats: false,
});

const checkRecord = ajv.compile<StudioSandboxLeaseRecord>(StudioSandboxLeaseRecordSchema);
const checkRequest = ajv.compile<StudioSandboxLeaseRequest>(StudioSandboxLeaseRequestSchema);
const checkResponse = ajv.compile<StudioSandboxLeaseResponse>(StudioSandboxLeaseResponseSchema);

function errorParameter(error: ErrorObject, key: string): string | undefined {
  const value = (error.params as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function appendPointer(path: string, segment: string): string {
  return `${path}/${segment.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function schemaErrorPath(error: ErrorObject): string {
  const property =
    error.keyword === 'required'
      ? errorParameter(error, 'missingProperty')
      : error.keyword === 'additionalProperties'
        ? errorParameter(error, 'additionalProperty')
        : undefined;
  return property === undefined ? error.instancePath : appendPointer(error.instancePath, property);
}

function schemaErrorPriority(error: ErrorObject): number {
  if (error.keyword === 'additionalProperties') return 0;
  if (error.keyword === 'required') return 1;
  if (
    [
      'type',
      'minimum',
      'maximum',
      'maxLength',
      'minLength',
      'pattern',
      'maxItems',
      'minItems',
    ].includes(error.keyword)
  ) {
    return 2;
  }
  if (error.keyword === 'const' || error.keyword === 'enum') return 3;
  return 4;
}

function mostUsefulSchemaError(
  errors: readonly ErrorObject[] | null | undefined,
): ErrorObject | undefined {
  return [...(errors ?? [])].sort((left, right) => {
    const priority = schemaErrorPriority(left) - schemaErrorPriority(right);
    if (priority !== 0) return priority;
    return (
      compareCodePoints(schemaErrorPath(left), schemaErrorPath(right)) ||
      compareCodePoints(left.keyword, right.keyword)
    );
  })[0];
}

function schemaFailure<T>(
  input: unknown,
  validator: ValidateFunction<T>,
  code: StudioDiagnosticCode,
  subject: string,
): StudioSandboxLeaseContractValidationResult<T> | undefined {
  const issue = inspectJsonCompatibility(input);
  if (issue !== undefined) {
    return {
      valid: false,
      diagnostics: [
        studioDiagnostic(code, issue.path, `${subject} is not JSON-compatible: ${issue.reason}.`),
      ],
    };
  }
  if (validator(input)) return undefined;
  const error = mostUsefulSchemaError(validator.errors);
  return {
    valid: false,
    diagnostics: [
      studioDiagnostic(
        code,
        error === undefined ? '' : schemaErrorPath(error),
        `${subject} does not satisfy its strict contract.`,
      ),
    ],
  };
}

function recordSemanticDiagnostics(
  record: Readonly<StudioSandboxLeaseRecord>,
  path = '',
): StudioDiagnostic[] {
  if (
    Buffer.byteLength(stringifySandboxLeaseRecord(record), 'utf8') <=
    STUDIO_MCP_MAX_SANDBOX_LEASE_BYTES
  ) {
    return [];
  }
  return [
    studioDiagnostic(
      'studio.sandbox_lease_invalid',
      path,
      'Studio sandbox lease record exceeds the bounded canonical size.',
    ),
  ];
}

function requestSemanticDiagnostics(
  request: Readonly<StudioSandboxLeaseRequest>,
): StudioDiagnostic[] {
  const diagnostics: StudioDiagnostic[] = [];
  if (request.action === 'claim_lease') {
    const hasExpected = request.expectedLease !== undefined;
    if (request.expectedLeasePresent !== hasExpected) {
      diagnostics.push(
        studioDiagnostic(
          'studio.property_invalid',
          '/expectedLease',
          'Studio sandbox lease claim presence must exactly describe the expected prior lease.',
        ),
      );
    }
    if (
      request.expectedLease !== undefined &&
      request.expectedLease.leaseId === request.newLease.leaseId
    ) {
      diagnostics.push(
        studioDiagnostic(
          'studio.property_invalid',
          '/newLease/leaseId',
          'A nonempty Studio transaction must rotate the prior sandbox lease ID.',
        ),
      );
    }
  }
  return sortStudioDiagnostics(diagnostics);
}

function responseSemanticDiagnostics(
  response: Readonly<StudioSandboxLeaseResponse>,
): StudioDiagnostic[] {
  const diagnostics: StudioDiagnostic[] = [];
  if (response.ok && response.action === 'read_lease') {
    const hasLease = response.lease !== undefined;
    if (response.leasePresent !== hasLease) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/lease',
          'Studio sandbox lease read presence does not match its returned record.',
        ),
      );
    }
  }
  if (response.ok && response.action === 'bound_snapshot') {
    diagnostics.push(
      ...compactSnapshotSemanticDiagnostics(response.compactSnapshot, '/compactSnapshot'),
    );
  }
  return sortStudioDiagnostics(diagnostics);
}

export function validateSandboxLeaseRecord(
  input: unknown,
): StudioSandboxLeaseContractValidationResult<StudioSandboxLeaseRecord> {
  try {
    const failure = schemaFailure(
      input,
      checkRecord,
      'studio.sandbox_lease_invalid',
      'Studio sandbox lease record',
    );
    if (failure !== undefined) return failure;
    const record = input as StudioSandboxLeaseRecord;
    const diagnostics = recordSemanticDiagnostics(record);
    return diagnostics.length > 0
      ? { valid: false, diagnostics }
      : { valid: true, value: normalizeSandboxLeaseRecord(record), diagnostics: [] };
  } catch {
    return {
      valid: false,
      diagnostics: [
        studioDiagnostic(
          'studio.sandbox_lease_invalid',
          '',
          'Studio sandbox lease record could not be safely inspected.',
        ),
      ],
    };
  }
}

export function validateStudioSandboxLeaseRequest(
  input: unknown,
): StudioSandboxLeaseContractValidationResult<StudioSandboxLeaseRequest> {
  try {
    const failure = schemaFailure(
      input,
      checkRequest,
      'studio.property_invalid',
      'Studio sandbox lease request',
    );
    if (failure !== undefined) return failure;
    const request = input as StudioSandboxLeaseRequest;
    const diagnostics = requestSemanticDiagnostics(request);
    return diagnostics.length > 0
      ? { valid: false, diagnostics }
      : { valid: true, value: normalizeStudioSandboxLeaseRequest(request), diagnostics: [] };
  } catch {
    return {
      valid: false,
      diagnostics: [
        studioDiagnostic(
          'studio.property_invalid',
          '',
          'Studio sandbox lease request could not be safely inspected.',
        ),
      ],
    };
  }
}

export function validateStudioSandboxLeaseResponse(
  input: unknown,
): StudioSandboxLeaseContractValidationResult<StudioSandboxLeaseResponse> {
  try {
    const failure = schemaFailure(
      input,
      checkResponse,
      'studio.response_invalid',
      'Studio sandbox lease response',
    );
    if (failure !== undefined) return failure;
    const response = input as StudioSandboxLeaseResponse;
    const diagnostics = responseSemanticDiagnostics(response);
    return diagnostics.length > 0
      ? { valid: false, diagnostics }
      : { valid: true, value: normalizeStudioSandboxLeaseResponse(response), diagnostics: [] };
  } catch {
    return {
      valid: false,
      diagnostics: [
        studioDiagnostic(
          'studio.response_invalid',
          '',
          'Studio sandbox lease response could not be safely inspected.',
        ),
      ],
    };
  }
}

function privateLeaseIds(request: Readonly<StudioSandboxLeaseRequest>): readonly string[] {
  if (request.action === 'read_lease') return [];
  if (request.action === 'bound_snapshot') return [request.lease.leaseId];
  return [
    ...(request.expectedLease === undefined ? [] : [request.expectedLease.leaseId]),
    request.newLease.leaseId,
  ];
}

export function validateStudioSandboxLeaseResponseForRequest(
  input: unknown,
  requestInput: unknown,
): StudioSandboxLeaseContractValidationResult<StudioSandboxLeaseResponse> {
  const requestValidation = validateStudioSandboxLeaseRequest(requestInput);
  if (!requestValidation.valid) return requestValidation;
  const responseValidation = validateStudioSandboxLeaseResponse(input);
  if (!responseValidation.valid) return responseValidation;
  const request = requestValidation.value;
  const response = responseValidation.value;
  const diagnostics: StudioDiagnostic[] = [];
  if (response.action !== request.action) {
    diagnostics.push(
      studioDiagnostic(
        'studio.response_invalid',
        '/action',
        'Studio sandbox lease response action does not match its request.',
      ),
    );
  }
  if (
    response.ok &&
    response.action === 'bound_snapshot' &&
    request.action === 'bound_snapshot' &&
    response.compactSnapshot.projectId !== request.lease.projectId
  ) {
    diagnostics.push(
      studioDiagnostic(
        'studio.response_invalid',
        '/compactSnapshot/projectId',
        'Lease-bound snapshot project ID does not match its request.',
      ),
    );
  }
  if (
    !response.ok &&
    privateLeaseIds(request).some((leaseId) => response.diagnostic.message.includes(leaseId))
  ) {
    diagnostics.push(
      studioDiagnostic(
        'studio.response_invalid',
        '/diagnostic/message',
        'Studio sandbox lease diagnostics must not expose private lease identifiers.',
      ),
    );
  }
  return diagnostics.length > 0
    ? { valid: false, diagnostics: sortStudioDiagnostics(diagnostics) }
    : responseValidation;
}
