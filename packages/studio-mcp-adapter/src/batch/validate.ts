import { Buffer } from 'node:buffer';

import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import { STUDIO_BRIDGE_PROTOCOL_VERSION } from '../constants.js';
import {
  STUDIO_BATCH_RESPONSE_PREFIX,
  STUDIO_MCP_MAX_BATCH_PAYLOAD_BYTES,
  STUDIO_MCP_MAX_BRIDGE_TEXT_BYTES,
  STUDIO_MCP_MAX_PAYLOAD_BYTES,
  STUDIO_MCP_MAX_RESULT_BYTES,
} from '../constants.js';
import {
  compareCodePoints,
  sortStudioDiagnostics,
  studioDiagnostic,
  type StudioDiagnostic,
  type StudioDiagnosticCode,
} from '../diagnostics.js';
import {
  inspectJsonCompatibility,
  jsonValuesEqual,
  stringifyCanonicalJson,
  type JsonValue,
} from '../json.js';
import { validateStudioBridgeRequest } from '../validate.js';
import type { StudioBridgeRequest } from '../types.js';
import { StudioBatchRequestSchema, StudioBatchResponseSchema } from './contract-schema.js';
import { hashStudioBatchChunkIdentity } from './hashing.js';
import { normalizeStudioBatchRequest, normalizeStudioBatchResponse } from './normalize.js';
import type {
  StudioBatchContractValidationResult,
  StudioBatchOperation,
  StudioBatchRequest,
  StudioBatchResponse,
} from './types.js';

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictNumbers: true,
  validateFormats: false,
});

const checkBatchRequest = ajv.compile<StudioBatchRequest>(StudioBatchRequestSchema);
const checkBatchResponse = ajv.compile<StudioBatchResponse>(StudioBatchResponseSchema);
const UNPROVEN_LOCAL_RESTORE_CODES = new Set<StudioDiagnosticCode>([
  'studio.create_cleanup_failed',
  'studio.update_restore_failed',
  'studio.delete_failed',
  'studio.response_invalid',
  'studio.sandbox_identity_mismatch',
]);

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
): StudioBatchContractValidationResult<T> | undefined {
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

function operationNodeId(operation: Readonly<StudioBatchOperation>): string {
  return operation.type === 'create' ? operation.node.id : operation.before.id;
}

function asSingleBridgeRequest(
  projectId: string,
  operation: Readonly<StudioBatchOperation>,
): StudioBridgeRequest {
  switch (operation.type) {
    case 'create':
      return {
        protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
        action: 'create',
        projectId,
        node: operation.node,
        stateJson: operation.stateJson,
        stateHash: operation.stateHash,
        ...(operation.parentState === undefined ? {} : { parentState: operation.parentState }),
      };
    case 'update':
      return {
        protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
        action: 'update',
        projectId,
        before: operation.before,
        after: operation.after,
        beforeStateJson: operation.beforeStateJson,
        beforeStateHash: operation.beforeStateHash,
        afterStateJson: operation.afterStateJson,
        afterStateHash: operation.afterStateHash,
        ...(operation.beforeParentState === undefined
          ? {}
          : { beforeParentState: operation.beforeParentState }),
        ...(operation.afterParentState === undefined
          ? {}
          : { afterParentState: operation.afterParentState }),
      };
    case 'delete':
      return {
        protocolVersion: STUDIO_BRIDGE_PROTOCOL_VERSION,
        action: 'delete',
        projectId,
        before: operation.before,
        beforeStateJson: operation.beforeStateJson,
        beforeStateHash: operation.beforeStateHash,
      };
  }
}

function prefixDiagnostic(
  diagnostic: Readonly<StudioDiagnostic>,
  prefix: string,
): StudioDiagnostic {
  return studioDiagnostic(diagnostic.code, `${prefix}${diagnostic.path}`, diagnostic.message, {
    severity: diagnostic.severity,
    ...(diagnostic.relatedId === undefined ? {} : { relatedId: diagnostic.relatedId }),
    ...(diagnostic.toolName === undefined ? {} : { toolName: diagnostic.toolName }),
  });
}

function batchRequestSemanticDiagnostics(
  request: Readonly<StudioBatchRequest>,
): StudioDiagnostic[] {
  const diagnostics: StudioDiagnostic[] = [];
  const canonicalBytes = Buffer.byteLength(
    stringifyCanonicalJson(request as unknown as JsonValue),
    'utf8',
  );
  if (
    canonicalBytes > STUDIO_MCP_MAX_BATCH_PAYLOAD_BYTES ||
    canonicalBytes > STUDIO_MCP_MAX_PAYLOAD_BYTES
  ) {
    return [
      studioDiagnostic(
        'studio.payload_too_large',
        '',
        'Studio batch request exceeds the bounded canonical payload size.',
      ),
    ];
  }
  const expectedChunkId = hashStudioBatchChunkIdentity(request);
  if (request.chunkId !== expectedChunkId) {
    diagnostics.push(
      studioDiagnostic(
        'studio.property_invalid',
        '/chunkId',
        'Studio batch chunk identity does not match its canonical contents.',
      ),
    );
  }

  const operationIds = new Set<string>();
  const targetIds = new Set<string>();
  const phase = { create: 0, update: 1, delete: 2 } as const;
  let priorPhase = -1;
  request.operations.forEach((operation, index) => {
    const path = `/operations/${String(index)}`;
    const nodeId = operationNodeId(operation);
    if (operation.operationId !== `${operation.type}:${nodeId}`) {
      diagnostics.push(
        studioDiagnostic(
          'studio.identity_invalid',
          `${path}/operationId`,
          'Batch operation ID must exactly match its operation type and managed node ID.',
          { relatedId: nodeId },
        ),
      );
    }
    if (operationIds.has(operation.operationId)) {
      diagnostics.push(
        studioDiagnostic(
          'studio.identity_invalid',
          `${path}/operationId`,
          'Batch operation IDs must be unique.',
          { relatedId: operation.operationId },
        ),
      );
    }
    operationIds.add(operation.operationId);
    if (targetIds.has(nodeId)) {
      diagnostics.push(
        studioDiagnostic(
          'studio.identity_invalid',
          path,
          'A Studio batch may target each managed node at most once.',
          { relatedId: nodeId },
        ),
      );
    }
    targetIds.add(nodeId);
    const currentPhase = phase[operation.type];
    if (currentPhase < priorPhase) {
      diagnostics.push(
        studioDiagnostic(
          'studio.property_invalid',
          path,
          'Studio batch operations must preserve create, update, then delete phase order.',
          { relatedId: nodeId },
        ),
      );
    }
    priorPhase = Math.max(priorPhase, currentPhase);

    if (operation.type === 'update') {
      if (operation.before.className !== operation.after.className) {
        diagnostics.push(
          studioDiagnostic(
            'studio.class_unsupported',
            `${path}/after/className`,
            'A Studio batch update must preserve the managed Roblox class.',
            { relatedId: nodeId },
          ),
        );
      }
      if (jsonValuesEqual(operation.before, operation.after)) {
        diagnostics.push(
          studioDiagnostic(
            'studio.property_invalid',
            path,
            'A Studio batch update must contain distinct before and after states.',
            { relatedId: nodeId },
          ),
        );
      }
    }

    const singleValidation = validateStudioBridgeRequest(
      asSingleBridgeRequest(request.projectId, operation),
    );
    if (!singleValidation.valid) {
      diagnostics.push(
        ...singleValidation.diagnostics.map((diagnostic) => prefixDiagnostic(diagnostic, path)),
      );
    }
  });
  return sortStudioDiagnostics(diagnostics);
}

function batchResponseSemanticDiagnostics(
  response: Readonly<StudioBatchResponse>,
): StudioDiagnostic[] {
  const diagnostics: StudioDiagnostic[] = [];
  const canonicalBytes = Buffer.byteLength(
    stringifyCanonicalJson(response as unknown as JsonValue),
    'utf8',
  );
  const framedBytes = Buffer.byteLength(STUDIO_BATCH_RESPONSE_PREFIX, 'utf8') + canonicalBytes;
  if (
    canonicalBytes > STUDIO_MCP_MAX_RESULT_BYTES ||
    framedBytes > STUDIO_MCP_MAX_BRIDGE_TEXT_BYTES
  ) {
    diagnostics.push(
      studioDiagnostic(
        'studio.response_too_large',
        '',
        'Studio batch response exceeds the bounded result size.',
      ),
    );
  }
  if (response.operationsApplied > response.operationsAttempted) {
    diagnostics.push(
      studioDiagnostic(
        'studio.response_invalid',
        '/operationsApplied',
        'Applied batch operations cannot exceed attempted operations.',
      ),
    );
  }
  if (response.completedOperationIds.length !== response.operationsApplied) {
    diagnostics.push(
      studioDiagnostic(
        'studio.response_invalid',
        '/completedOperationIds',
        'Completed operation IDs must have exactly one entry per applied operation.',
      ),
    );
  }
  if (new Set(response.completedOperationIds).size !== response.completedOperationIds.length) {
    diagnostics.push(
      studioDiagnostic(
        'studio.response_invalid',
        '/completedOperationIds',
        'Completed operation IDs must be unique.',
      ),
    );
  }
  if (response.ok) {
    if (response.operationsAttempted !== response.operationsApplied) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/operationsAttempted',
          'A successful batch response must apply every attempted operation.',
        ),
      );
    }
  } else {
    const failedOperationPresent = response.failedOperationId !== undefined;
    if (
      (failedOperationPresent && response.operationsAttempted !== response.operationsApplied + 1) ||
      (!failedOperationPresent && response.operationsAttempted !== response.operationsApplied)
    ) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/failedOperationId',
          'A failed operation must be the one attempted immediately after the completed prefix.',
        ),
      );
    }
    if (
      response.localRestoreSucceeded &&
      (UNPROVEN_LOCAL_RESTORE_CODES.has(response.diagnostic.code) ||
        (!failedOperationPresent && response.operationsAttempted > 0))
    ) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/localRestoreSucceeded',
          'Studio batch failure cannot claim local restoration for an uncertain failure shape.',
        ),
      );
    }
  }
  return sortStudioDiagnostics(diagnostics);
}

function responseForRequestDiagnostics(
  response: Readonly<StudioBatchResponse>,
  request: Readonly<StudioBatchRequest>,
): StudioDiagnostic[] {
  const diagnostics: StudioDiagnostic[] = [];
  if (response.changeSetHash !== request.changeSetHash) {
    diagnostics.push(
      studioDiagnostic(
        'studio.response_invalid',
        '/changeSetHash',
        'Studio batch response change-set hash does not match its request.',
      ),
    );
  }
  if (response.chunkId !== request.chunkId) {
    diagnostics.push(
      studioDiagnostic(
        'studio.response_invalid',
        '/chunkId',
        'Studio batch response chunk ID does not match its request.',
      ),
    );
  }
  if (response.chunkIndex !== request.chunkIndex) {
    diagnostics.push(
      studioDiagnostic(
        'studio.response_invalid',
        '/chunkIndex',
        'Studio batch response chunk index does not match its request.',
      ),
    );
  }
  if (response.operationsAttempted > request.operations.length) {
    diagnostics.push(
      studioDiagnostic(
        'studio.response_invalid',
        '/operationsAttempted',
        'Studio batch response exceeds the requested operation count.',
      ),
    );
  }
  const exactCompletedPrefix = request.operations
    .slice(0, response.operationsApplied)
    .map((operation) => operation.operationId);
  if (!jsonValuesEqual(response.completedOperationIds, exactCompletedPrefix)) {
    diagnostics.push(
      studioDiagnostic(
        'studio.response_invalid',
        '/completedOperationIds',
        'Completed operation IDs do not equal the exact requested prefix.',
      ),
    );
  }
  if (response.ok) {
    if (
      response.operationsAttempted !== request.operations.length ||
      response.operationsApplied !== request.operations.length
    ) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/operationsAttempted',
          'A successful batch response must attempt and apply the complete requested chunk.',
        ),
      );
    }
  } else {
    if (
      response.failedOperationId !== undefined &&
      response.failedOperationId !== request.operations[response.operationsApplied]?.operationId
    ) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/failedOperationId',
          'Failed operation ID does not equal the next requested operation after the completed prefix.',
        ),
      );
    }
    if (
      response.failedOperationId === undefined &&
      response.operationsAttempted !== 0 &&
      response.operationsAttempted !== request.operations.length
    ) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          '/operationsAttempted',
          'A failure without an operation ID must occur before the chunk or during final verification.',
        ),
      );
    }
  }
  return sortStudioDiagnostics(diagnostics);
}

export function validateStudioBatchRequest(
  input: unknown,
): StudioBatchContractValidationResult<StudioBatchRequest> {
  try {
    const failure = schemaFailure(
      input,
      checkBatchRequest,
      'studio.property_invalid',
      'Studio batch request',
    );
    if (failure !== undefined) return failure;
    const request = input as StudioBatchRequest;
    const diagnostics = batchRequestSemanticDiagnostics(request);
    return diagnostics.length > 0
      ? { valid: false, diagnostics }
      : { valid: true, value: normalizeStudioBatchRequest(request), diagnostics: [] };
  } catch {
    return {
      valid: false,
      diagnostics: [
        studioDiagnostic(
          'studio.property_invalid',
          '',
          'Studio batch request could not be safely inspected.',
        ),
      ],
    };
  }
}

export function validateStudioBatchResponse(
  input: unknown,
): StudioBatchContractValidationResult<StudioBatchResponse> {
  try {
    const failure = schemaFailure(
      input,
      checkBatchResponse,
      'studio.response_invalid',
      'Studio batch response',
    );
    if (failure !== undefined) return failure;
    const response = input as StudioBatchResponse;
    const diagnostics = batchResponseSemanticDiagnostics(response);
    return diagnostics.length > 0
      ? { valid: false, diagnostics }
      : { valid: true, value: normalizeStudioBatchResponse(response), diagnostics: [] };
  } catch {
    return {
      valid: false,
      diagnostics: [
        studioDiagnostic(
          'studio.response_invalid',
          '',
          'Studio batch response could not be safely inspected.',
        ),
      ],
    };
  }
}

export function validateStudioBatchResponseForRequest(
  input: unknown,
  requestInput: unknown,
): StudioBatchContractValidationResult<StudioBatchResponse> {
  const requestValidation = validateStudioBatchRequest(requestInput);
  if (!requestValidation.valid) return requestValidation;
  const responseValidation = validateStudioBatchResponse(input);
  if (!responseValidation.valid) return responseValidation;
  const diagnostics = responseForRequestDiagnostics(
    responseValidation.value,
    requestValidation.value,
  );
  return diagnostics.length > 0
    ? { valid: false, diagnostics }
    : { valid: true, value: responseValidation.value, diagnostics: [] };
}
