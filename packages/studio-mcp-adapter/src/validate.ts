import { Buffer } from 'node:buffer';

import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import {
  StudioApplyReceiptSchema,
  StudioBridgeManagedNodeSchema,
  StudioBridgeRequestSchema,
  StudioBridgeResponseSchema,
} from './contract-schema.js';
import {
  STUDIO_MCP_MAX_PAYLOAD_BYTES,
  STUDIO_MCP_MAX_RESULT_BYTES,
  STUDIO_MCP_MAX_NODE_STATE_BYTES,
} from './constants.js';
import {
  compareCodePoints,
  sortStudioDiagnostics,
  studioDiagnostic,
  type StudioDiagnostic,
  type StudioDiagnosticCode,
} from './diagnostics.js';
import { hashStudioManagedNodeState } from './hashing.js';
import {
  canonicalizeJsonValue,
  inspectJsonCompatibility,
  jsonValuesEqual,
  stringifyCanonicalJson,
  type JsonValue,
} from './json.js';
import {
  containsLocalAbsolutePath,
  isBoundedCompilerDiagnosticPointer,
  isUnsafePresentationCharacter,
} from './privacy.js';
import {
  normalizeStudioApplyReceipt,
  normalizeStudioBridgeRequest,
  normalizeStudioBridgeResponse,
  stringifyStudioManagedNodeState,
} from './normalize.js';
import type {
  StudioApplyReceipt,
  StudioBridgeManagedNode,
  StudioBridgeParentState,
  StudioBridgeRequest,
  StudioBridgeResponse,
  StudioContractValidationResult,
  StudioRawManagedNode,
} from './types.js';

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictNumbers: true,
  validateFormats: false,
});

const checkBridgeRequest = ajv.compile<StudioBridgeRequest>(StudioBridgeRequestSchema);
const checkBridgeResponse = ajv.compile<StudioBridgeResponse>(StudioBridgeResponseSchema);
const checkApplyReceipt = ajv.compile<StudioApplyReceipt>(StudioApplyReceiptSchema);
const checkManagedNode = ajv.compile<StudioBridgeManagedNode>(StudioBridgeManagedNodeSchema);

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
  switch (error.keyword) {
    case 'additionalProperties':
      return 0;
    case 'required':
      return 1;
    case 'type':
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'maxLength':
    case 'minLength':
    case 'pattern':
    case 'maxItems':
    case 'minItems':
      return 2;
    case 'const':
    case 'enum':
      return 3;
    default:
      return 4;
  }
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
): StudioContractValidationResult<T> | undefined {
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

function stateIntegrityDiagnostics(
  node: Readonly<StudioBridgeManagedNode>,
  stateJson: string,
  stateHash: string,
  path: string,
  code: StudioDiagnosticCode,
): StudioDiagnostic[] {
  const diagnostics: StudioDiagnostic[] = [];
  if (Buffer.byteLength(stateJson, 'utf8') > STUDIO_MCP_MAX_NODE_STATE_BYTES) {
    diagnostics.push(
      studioDiagnostic(
        'studio.adapter_metadata_too_large',
        path,
        'Node state metadata exceeds the byte limit.',
      ),
    );
    return diagnostics;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stateJson) as unknown;
  } catch {
    diagnostics.push(studioDiagnostic(code, path, 'Node state metadata is not valid JSON.'));
    return diagnostics;
  }
  const issue = inspectJsonCompatibility(parsed);
  if (issue !== undefined || !checkManagedNode(parsed)) {
    diagnostics.push(
      studioDiagnostic(code, path, 'Node state metadata is not a strict managed-node value.'),
    );
    return diagnostics;
  }
  if (stringifyStudioManagedNodeState(parsed) !== stateJson) {
    diagnostics.push(studioDiagnostic(code, path, 'Node state metadata is not canonical JSON.'));
  }
  if (hashStudioManagedNodeState(parsed) !== stateHash) {
    diagnostics.push(
      studioDiagnostic(
        code,
        path,
        'Node state metadata hash does not match its canonical contents.',
      ),
    );
  }
  if (
    !jsonValuesEqual(
      canonicalizeJsonValue(node as unknown as JsonValue),
      canonicalizeJsonValue(parsed as unknown as JsonValue),
    )
  ) {
    diagnostics.push(
      studioDiagnostic(
        code,
        path,
        'Node state metadata does not match the accompanying managed node.',
      ),
    );
  }
  return diagnostics;
}

function requestNodeDiagnostics(
  projectId: string,
  node: Readonly<StudioBridgeManagedNode>,
  path: string,
): StudioDiagnostic[] {
  const diagnostics: StudioDiagnostic[] = [];
  if (
    node.attributes.WorldwrightEntityId !== node.id ||
    node.attributes.WorldwrightEntityKind !== node.entityKind
  ) {
    diagnostics.push(
      studioDiagnostic(
        'studio.identity_invalid',
        path,
        'Managed node identity attributes do not match the node.',
      ),
    );
  }
  if (node.attributes.WorldwrightProjectId !== projectId) {
    diagnostics.push(
      studioDiagnostic(
        'studio.project_mismatch',
        path,
        'Managed node project identity does not match the bridge request.',
      ),
    );
  }
  return diagnostics;
}

function parentStateDiagnostics(
  projectId: string,
  parentId: string | undefined,
  parentState: Readonly<StudioBridgeParentState> | undefined,
  path: string,
): StudioDiagnostic[] {
  if (parentId === undefined) {
    return parentState === undefined
      ? []
      : [
          studioDiagnostic(
            'studio.hierarchy_invalid',
            path,
            'Workspace-root mutations must not include managed-parent state.',
          ),
        ];
  }
  if (parentState === undefined) {
    return [
      studioDiagnostic(
        'studio.hierarchy_invalid',
        path,
        'A managed parent requires its exact transaction-observed state.',
        { relatedId: parentId },
      ),
    ];
  }

  const diagnostics = requestNodeDiagnostics(projectId, parentState.node, `${path}/node`);
  if (parentState.node.id !== parentId) {
    diagnostics.push(
      studioDiagnostic(
        'studio.identity_invalid',
        `${path}/node/id`,
        'Parent state identity does not match the mutation parent ID.',
        { relatedId: parentId },
      ),
    );
  }
  if (parentState.node.className !== 'Folder' && parentState.node.className !== 'Model') {
    diagnostics.push(
      studioDiagnostic(
        'studio.hierarchy_invalid',
        `${path}/node/className`,
        'A managed parent must be a Folder or Model.',
        { relatedId: parentId },
      ),
    );
  }
  diagnostics.push(
    ...stateIntegrityDiagnostics(
      parentState.node,
      parentState.stateJson,
      parentState.stateHash,
      `${path}/stateJson`,
      'studio.adapter_metadata_invalid',
    ),
  );
  return diagnostics;
}

function bridgeRequestSemanticDiagnostics(
  request: Readonly<StudioBridgeRequest>,
): StudioDiagnostic[] {
  const diagnostics: StudioDiagnostic[] = [];
  const byteLength = Buffer.byteLength(
    stringifyCanonicalJson(request as unknown as JsonValue),
    'utf8',
  );
  if (byteLength > STUDIO_MCP_MAX_PAYLOAD_BYTES) {
    diagnostics.push(
      studioDiagnostic(
        'studio.payload_too_large',
        '',
        'Bridge request exceeds the payload byte limit.',
      ),
    );
    return diagnostics;
  }
  switch (request.action) {
    case 'probe':
    case 'snapshot':
      return diagnostics;
    case 'create':
      diagnostics.push(...requestNodeDiagnostics(request.projectId, request.node, '/node'));
      diagnostics.push(
        ...stateIntegrityDiagnostics(
          request.node,
          request.stateJson,
          request.stateHash,
          '/stateJson',
          'studio.adapter_metadata_invalid',
        ),
        ...parentStateDiagnostics(
          request.projectId,
          request.node.parentId,
          request.parentState,
          '/parentState',
        ),
      );
      return diagnostics;
    case 'update':
      diagnostics.push(...requestNodeDiagnostics(request.projectId, request.before, '/before'));
      diagnostics.push(...requestNodeDiagnostics(request.projectId, request.after, '/after'));
      if (request.before.id !== request.after.id) {
        diagnostics.push(
          studioDiagnostic(
            'studio.identity_invalid',
            '/after/id',
            'Update before and after nodes must have the same identity.',
          ),
        );
      }
      if (
        request.before.parentId === request.after.parentId &&
        !jsonValuesEqual(request.beforeParentState, request.afterParentState)
      ) {
        diagnostics.push(
          studioDiagnostic(
            'studio.adapter_metadata_invalid',
            '/afterParentState',
            'An unchanged managed parent must have one coherent expected state.',
            request.before.parentId === undefined ? {} : { relatedId: request.before.parentId },
          ),
        );
      }
      diagnostics.push(
        ...stateIntegrityDiagnostics(
          request.before,
          request.beforeStateJson,
          request.beforeStateHash,
          '/beforeStateJson',
          'studio.adapter_metadata_invalid',
        ),
        ...stateIntegrityDiagnostics(
          request.after,
          request.afterStateJson,
          request.afterStateHash,
          '/afterStateJson',
          'studio.adapter_metadata_invalid',
        ),
        ...parentStateDiagnostics(
          request.projectId,
          request.before.parentId,
          request.beforeParentState,
          '/beforeParentState',
        ),
        ...parentStateDiagnostics(
          request.projectId,
          request.after.parentId,
          request.afterParentState,
          '/afterParentState',
        ),
      );
      return diagnostics;
    case 'delete':
      diagnostics.push(...requestNodeDiagnostics(request.projectId, request.before, '/before'));
      diagnostics.push(
        ...stateIntegrityDiagnostics(
          request.before,
          request.beforeStateJson,
          request.beforeStateHash,
          '/beforeStateJson',
          'studio.adapter_metadata_invalid',
        ),
      );
      return diagnostics;
  }
}

function rawNodeState(node: Readonly<StudioRawManagedNode>): StudioBridgeManagedNode | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(node.stateJson) as unknown;
  } catch {
    return undefined;
  }
  return checkManagedNode(parsed) ? parsed : undefined;
}

function rawNodeDiagnostics(
  node: Readonly<StudioRawManagedNode>,
  projectId: string,
  path: string,
): StudioDiagnostic[] {
  const diagnostics: StudioDiagnostic[] = [];
  const state = rawNodeState(node);
  if (state === undefined) {
    return [
      studioDiagnostic(
        'studio.adapter_metadata_invalid',
        `${path}/stateJson`,
        'Stored node state is invalid.',
      ),
    ];
  }
  diagnostics.push(
    ...stateIntegrityDiagnostics(
      state,
      node.stateJson,
      node.stateHash,
      `${path}/stateJson`,
      'studio.adapter_metadata_invalid',
    ),
  );
  if (node.projectId !== projectId || state.attributes.WorldwrightProjectId !== projectId) {
    diagnostics.push(
      studioDiagnostic(
        'studio.project_mismatch',
        path,
        'Snapshot node belongs to a different project.',
      ),
    );
  }
  if (
    node.entityId !== state.id ||
    node.entityKind !== state.entityKind ||
    node.className !== state.className ||
    node.name !== state.name
  ) {
    diagnostics.push(
      studioDiagnostic(
        'studio.adapter_metadata_invalid',
        path,
        'Raw node identity differs from stored state.',
      ),
    );
  }
  if (node.parentKind === 'managed') {
    if (node.parentEntityId === undefined || state.parentId !== node.parentEntityId) {
      diagnostics.push(
        studioDiagnostic(
          'studio.hierarchy_invalid',
          path,
          'Managed parent metadata is inconsistent.',
        ),
      );
    }
  } else if (node.parentKind === 'Workspace') {
    if (node.parentEntityId !== undefined || state.parentId !== undefined) {
      diagnostics.push(
        studioDiagnostic(
          'studio.hierarchy_invalid',
          path,
          'Workspace root metadata is inconsistent.',
        ),
      );
    }
  }
  if (node.className === 'Part' && node.properties.shape === undefined) {
    diagnostics.push(
      studioDiagnostic(
        'studio.property_invalid',
        `${path}/properties/shape`,
        'Part shape is required.',
      ),
    );
  }
  if (
    (node.className === 'WedgePart' || node.className === 'CornerWedgePart') &&
    node.properties.shape !== undefined
  ) {
    diagnostics.push(
      studioDiagnostic(
        'studio.property_invalid',
        `${path}/properties/shape`,
        'Wedge classes do not carry a shape value.',
      ),
    );
  }
  return diagnostics;
}

function bridgeResponseSemanticDiagnostics(
  response: Readonly<StudioBridgeResponse>,
): StudioDiagnostic[] {
  const byteLength = Buffer.byteLength(
    stringifyCanonicalJson(response as unknown as JsonValue),
    'utf8',
  );
  if (byteLength > STUDIO_MCP_MAX_RESULT_BYTES) {
    return [
      studioDiagnostic(
        'studio.response_too_large',
        '',
        'Bridge response exceeds the result byte limit.',
      ),
    ];
  }
  if (!response.ok || response.action !== 'snapshot') return [];
  const diagnostics: StudioDiagnostic[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < response.snapshot.nodes.length; index += 1) {
    const node = response.snapshot.nodes[index]!;
    const path = `/snapshot/nodes/${String(index)}`;
    if (ids.has(node.entityId)) {
      diagnostics.push(
        studioDiagnostic(
          'studio.identity_invalid',
          `${path}/entityId`,
          'Snapshot entity IDs must be unique.',
        ),
      );
    }
    ids.add(node.entityId);
    diagnostics.push(...rawNodeDiagnostics(node, response.snapshot.projectId, path));
  }
  const unmanagedKeys = new Set<string>();
  for (let index = 0; index < response.snapshot.unmanagedRoots.length; index += 1) {
    const root = response.snapshot.unmanagedRoots[index]!;
    const path = `/snapshot/unmanagedRoots/${String(index)}`;
    if (!ids.has(root.parentEntityId)) {
      diagnostics.push(
        studioDiagnostic(
          'studio.hierarchy_invalid',
          `${path}/parentEntityId`,
          'Unmanaged root parent is not a managed snapshot node.',
        ),
      );
    }
    const key = `${root.parentEntityId}\u0000${root.structuralPath}\u0000${String(root.ordinal)}`;
    if (unmanagedKeys.has(key)) {
      diagnostics.push(
        studioDiagnostic(
          'studio.identity_invalid',
          path,
          'Unmanaged structural descriptors must be unique.',
        ),
      );
    }
    unmanagedKeys.add(key);
  }
  return diagnostics;
}

function containsLocalPath(value: string): boolean {
  return containsLocalAbsolutePath(value);
}

function containsTerminalControl(value: string): boolean {
  return [...value].some((character) => isUnsafePresentationCharacter(character));
}

function receiptDiagnosticPathDiagnostics(
  receiptDiagnostic: Readonly<StudioApplyReceipt['diagnostics'][number]>,
  path: string,
): StudioDiagnostic[] {
  const diagnostics: StudioDiagnostic[] = [];
  for (const [field, value] of [
    ['path', receiptDiagnostic.path],
    ['message', receiptDiagnostic.message],
    ['relatedId', receiptDiagnostic.relatedId],
  ] as const) {
    const unsafe =
      value !== undefined &&
      (field === 'path'
        ? !isBoundedCompilerDiagnosticPointer(value)
        : containsLocalPath(value) || containsTerminalControl(value));
    if (unsafe) {
      diagnostics.push(
        studioDiagnostic(
          'studio.receipt_invalid',
          `${path}/${field}`,
          'Receipt diagnostic contains a local path or terminal control character.',
        ),
      );
    }
  }
  return diagnostics;
}

function receiptSemanticDiagnostics(receipt: Readonly<StudioApplyReceipt>): StudioDiagnostic[] {
  const diagnostics: StudioDiagnostic[] = [];
  if (receipt.operationsAttempted > receipt.operationsPlanned) {
    diagnostics.push(
      studioDiagnostic(
        'studio.receipt_invalid',
        '/operationsAttempted',
        'Attempted operations exceed planned operations.',
      ),
    );
  }
  for (const [field, value] of [
    ['studioId', receipt.studio.studioId],
    ['placeName', receipt.studio.placeName],
  ] as const) {
    if (containsLocalPath(value) || containsTerminalControl(value)) {
      diagnostics.push(
        studioDiagnostic(
          'studio.receipt_invalid',
          `/studio/${field}`,
          'Receipt Studio metadata contains a local path or terminal control character.',
        ),
      );
    }
  }
  for (let index = 0; index < receipt.diagnostics.length; index += 1) {
    diagnostics.push(
      ...receiptDiagnosticPathDiagnostics(
        receipt.diagnostics[index]!,
        `/diagnostics/${String(index)}`,
      ),
    );
  }
  if (receipt.status === 'failed') {
    if (receipt.diagnostics.length === 0) {
      diagnostics.push(
        studioDiagnostic(
          'studio.receipt_invalid',
          '/diagnostics',
          'A failed receipt requires a diagnostic.',
        ),
      );
    }
    if (receipt.rollback.attempted && receipt.rollback.succeeded) {
      if (
        receipt.finalSnapshotHash === undefined ||
        receipt.finalSnapshotHash !== receipt.rollback.restoredSnapshotHash ||
        receipt.rollback.restoredSnapshotHash !== receipt.baseSnapshotHash
      ) {
        diagnostics.push(
          studioDiagnostic(
            'studio.receipt_invalid',
            '/finalSnapshotHash',
            'Verified rollback must report the exact base snapshot as its restored final hash.',
          ),
        );
      }
    }
    if (receipt.rollback.attempted && !receipt.rollback.succeeded) {
      for (let index = 0; index < receipt.rollback.diagnostics.length; index += 1) {
        diagnostics.push(
          ...receiptDiagnosticPathDiagnostics(
            receipt.rollback.diagnostics[index]!,
            `/rollback/diagnostics/${String(index)}`,
          ),
        );
      }
    }
  } else {
    if (receipt.finalSnapshotHash !== receipt.expectedResultSnapshotHash) {
      diagnostics.push(
        studioDiagnostic(
          'studio.receipt_invalid',
          '/finalSnapshotHash',
          'Successful receipt final hash must match the expected result hash.',
        ),
      );
    }
    if (receipt.diagnostics.some((entry) => entry.severity === 'error')) {
      diagnostics.push(
        studioDiagnostic(
          'studio.receipt_invalid',
          '/diagnostics',
          'Successful receipts may not contain error diagnostics.',
        ),
      );
    }
    if (receipt.status === 'applied') {
      if (
        receipt.operationsPlanned === 0 ||
        receipt.operationsAttempted !== receipt.operationsPlanned
      ) {
        diagnostics.push(
          studioDiagnostic(
            'studio.receipt_invalid',
            '/operationsAttempted',
            'Applied receipt must report every nonzero planned operation as attempted.',
          ),
        );
      }
    } else if (
      receipt.operationsPlanned !== 0 ||
      receipt.operationsAttempted !== 0 ||
      receipt.baseSnapshotHash !== receipt.expectedResultSnapshotHash ||
      receipt.finalSnapshotHash !== receipt.baseSnapshotHash
    ) {
      diagnostics.push(
        studioDiagnostic(
          'studio.receipt_invalid',
          '/operationsAttempted',
          'No-op receipt requires zero operations and identical base, expected, and final hashes.',
        ),
      );
    }
  }
  return diagnostics;
}

export function validateStudioBridgeRequest(
  input: unknown,
): StudioContractValidationResult<StudioBridgeRequest> {
  try {
    const failure = schemaFailure(
      input,
      checkBridgeRequest,
      'studio.property_invalid',
      'Studio bridge request',
    );
    if (failure !== undefined) return failure;
    const request = input as StudioBridgeRequest;
    const diagnostics = sortStudioDiagnostics(bridgeRequestSemanticDiagnostics(request));
    return diagnostics.length > 0
      ? { valid: false, diagnostics }
      : { valid: true, value: normalizeStudioBridgeRequest(request), diagnostics: [] };
  } catch {
    return {
      valid: false,
      diagnostics: [
        studioDiagnostic(
          'studio.property_invalid',
          '',
          'Studio bridge request could not be safely inspected.',
        ),
      ],
    };
  }
}

export function validateStudioBridgeResponse(
  input: unknown,
): StudioContractValidationResult<StudioBridgeResponse> {
  try {
    const failure = schemaFailure(
      input,
      checkBridgeResponse,
      'studio.response_invalid',
      'Studio bridge response',
    );
    if (failure !== undefined) return failure;
    const response = input as StudioBridgeResponse;
    const diagnostics = sortStudioDiagnostics(bridgeResponseSemanticDiagnostics(response));
    return diagnostics.length > 0
      ? { valid: false, diagnostics }
      : { valid: true, value: normalizeStudioBridgeResponse(response), diagnostics: [] };
  } catch {
    return {
      valid: false,
      diagnostics: [
        studioDiagnostic(
          'studio.response_invalid',
          '',
          'Studio bridge response could not be safely inspected.',
        ),
      ],
    };
  }
}

export function validateStudioApplyReceipt(
  input: unknown,
): StudioContractValidationResult<StudioApplyReceipt> {
  try {
    const failure = schemaFailure(
      input,
      checkApplyReceipt,
      'studio.receipt_invalid',
      'Studio Apply Receipt',
    );
    if (failure !== undefined) return failure;
    const receipt = input as StudioApplyReceipt;
    const diagnostics = sortStudioDiagnostics(receiptSemanticDiagnostics(receipt));
    return diagnostics.length > 0
      ? { valid: false, diagnostics }
      : { valid: true, value: normalizeStudioApplyReceipt(receipt), diagnostics: [] };
  } catch {
    return {
      valid: false,
      diagnostics: [
        studioDiagnostic(
          'studio.receipt_invalid',
          '',
          'Studio Apply Receipt could not be safely inspected.',
        ),
      ],
    };
  }
}
