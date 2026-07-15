import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import {
  ROBLOX_COMPILER_VERSION,
  RobloxCornerWedgePartNodeSchema,
  RobloxCreateOperationSchema,
  RobloxChangeSetSchema,
  RobloxDeleteOperationSchema,
  RobloxFolderNodeSchema,
  RobloxManifestSchema,
  RobloxModelNodeSchema,
  RobloxPartNodeSchema,
  RobloxSnapshotSchema,
  RobloxUpdateOperationSchema,
  RobloxWedgePartNodeSchema,
} from './contract-schema.js';
import { diagnostic, sortDiagnostics, type RobloxDiagnostic } from './diagnostics.js';
import {
  appendPointer,
  compareCodePoints,
  inspectJsonCompatibility,
  jsonValuesEqual,
} from './json.js';
import {
  normalizeRobloxChangeSet,
  normalizeRobloxManagedNode,
  normalizeRobloxManifest,
  normalizeRobloxSnapshot,
} from './normalize.js';
import type {
  RobloxChangeOperation,
  RobloxChangeSet,
  RobloxContractValidationResult,
  RobloxManagedNode,
  RobloxManifest,
  RobloxSceneSnapshot,
} from './types.js';

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictNumbers: true,
  validateFormats: false,
});

const checkManifestSchema = ajv.compile<RobloxManifest>(RobloxManifestSchema);
const checkSnapshotSchema = ajv.compile<RobloxSceneSnapshot>(RobloxSnapshotSchema);
const checkChangeSetSchema = ajv.compile<RobloxChangeSet>(RobloxChangeSetSchema);
const checkFolderNodeSchema = ajv.compile(RobloxFolderNodeSchema);
const checkModelNodeSchema = ajv.compile(RobloxModelNodeSchema);
const checkPartNodeSchema = ajv.compile(RobloxPartNodeSchema);
const checkWedgePartNodeSchema = ajv.compile(RobloxWedgePartNodeSchema);
const checkCornerWedgePartNodeSchema = ajv.compile(RobloxCornerWedgePartNodeSchema);
const checkCreateOperationSchema = ajv.compile(RobloxCreateOperationSchema);
const checkUpdateOperationSchema = ajv.compile(RobloxUpdateOperationSchema);
const checkDeleteOperationSchema = ajv.compile(RobloxDeleteOperationSchema);

function errorParameter(error: ErrorObject, key: string): string | undefined {
  const value = (error.params as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
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

function schemaErrorMessage(error: ErrorObject): string {
  switch (error.keyword) {
    case 'additionalProperties':
      return 'Property is not allowed by this Roblox compiler contract.';
    case 'required':
      return 'Required Roblox compiler contract property is missing.';
    case 'type':
      return 'Roblox compiler contract value has the wrong type.';
    case 'const':
    case 'enum':
      return 'Roblox compiler contract value is not an allowed choice.';
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'exclusiveMaximum':
      return 'Roblox compiler contract number is outside the allowed range.';
    case 'minLength':
    case 'maxLength':
    case 'pattern':
      return 'Roblox compiler contract string is outside the allowed format.';
    case 'minItems':
    case 'maxItems':
    case 'uniqueItems':
      return 'Roblox compiler contract array does not satisfy its bounds.';
    default:
      return 'Value does not satisfy the Roblox compiler contract.';
  }
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
    case 'exclusiveMaximum':
    case 'minLength':
    case 'maxLength':
    case 'pattern':
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
    const byPriority = schemaErrorPriority(left) - schemaErrorPriority(right);
    if (byPriority !== 0) return byPriority;
    const byPath = compareCodePoints(schemaErrorPath(left), schemaErrorPath(right));
    if (byPath !== 0) return byPath;
    return compareCodePoints(left.keyword, right.keyword);
  })[0];
}

function objectRecord(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function schemaDiagnosticForValidator(
  input: unknown,
  basePath: string,
  validator: ValidateFunction,
): RobloxDiagnostic | undefined {
  if (validator(input)) return undefined;
  const error = mostUsefulSchemaError(validator.errors);
  return diagnostic(
    'contract.schema_invalid',
    `${basePath}${error === undefined ? '' : schemaErrorPath(error)}`,
    error === undefined
      ? 'Value does not satisfy the Roblox compiler contract.'
      : schemaErrorMessage(error),
  );
}

function managedNodeSchemaDiagnostic(
  input: unknown,
  basePath: string,
): RobloxDiagnostic | undefined {
  const record = objectRecord(input);
  if (record === undefined) {
    return diagnostic(
      'contract.schema_invalid',
      basePath,
      'Roblox compiler contract value has the wrong type.',
    );
  }

  let validator: ValidateFunction;
  switch (record.className) {
    case 'Folder':
      validator = checkFolderNodeSchema;
      break;
    case 'Model':
      validator = checkModelNodeSchema;
      break;
    case 'Part':
      validator = checkPartNodeSchema;
      break;
    case 'WedgePart':
      validator = checkWedgePartNodeSchema;
      break;
    case 'CornerWedgePart':
      validator = checkCornerWedgePartNodeSchema;
      break;
    default:
      return diagnostic(
        'contract.schema_invalid',
        `${basePath}/className`,
        record.className === undefined
          ? 'Required Roblox compiler contract property is missing.'
          : 'Roblox compiler contract value is not an allowed choice.',
      );
  }
  return schemaDiagnosticForValidator(input, basePath, validator);
}

function managedNodesSchemaDiagnostic(input: unknown): RobloxDiagnostic | undefined {
  const nodes = objectRecord(input)?.nodes;
  if (!Array.isArray(nodes)) return undefined;
  const diagnostics = nodes
    .map((node, index) => managedNodeSchemaDiagnostic(node, `/nodes/${index}`))
    .filter((entry): entry is RobloxDiagnostic => entry !== undefined);
  return sortDiagnostics(diagnostics)[0];
}

function operationSchemaDiagnostics(input: unknown, basePath: string): RobloxDiagnostic[] {
  const record = objectRecord(input);
  if (record === undefined) {
    return [
      diagnostic(
        'contract.schema_invalid',
        basePath,
        'Roblox compiler contract value has the wrong type.',
      ),
    ];
  }

  let validator: ValidateFunction;
  const diagnostics: RobloxDiagnostic[] = [];
  switch (record.type) {
    case 'create': {
      const nodeDiagnostic = managedNodeSchemaDiagnostic(record.node, `${basePath}/node`);
      if (nodeDiagnostic !== undefined) diagnostics.push(nodeDiagnostic);
      validator = checkCreateOperationSchema;
      break;
    }
    case 'update': {
      const beforeDiagnostic = managedNodeSchemaDiagnostic(record.before, `${basePath}/before`);
      const afterDiagnostic = managedNodeSchemaDiagnostic(record.after, `${basePath}/after`);
      if (beforeDiagnostic !== undefined) diagnostics.push(beforeDiagnostic);
      if (afterDiagnostic !== undefined) diagnostics.push(afterDiagnostic);
      validator = checkUpdateOperationSchema;
      break;
    }
    case 'delete': {
      const beforeDiagnostic = managedNodeSchemaDiagnostic(record.before, `${basePath}/before`);
      if (beforeDiagnostic !== undefined) diagnostics.push(beforeDiagnostic);
      validator = checkDeleteOperationSchema;
      break;
    }
    default:
      return [
        diagnostic(
          'contract.schema_invalid',
          `${basePath}/type`,
          record.type === undefined
            ? 'Required Roblox compiler contract property is missing.'
            : 'Roblox compiler contract value is not an allowed choice.',
        ),
      ];
  }

  if (diagnostics.length > 0) return diagnostics;
  const operationDiagnostic = schemaDiagnosticForValidator(input, basePath, validator);
  if (operationDiagnostic !== undefined) diagnostics.push(operationDiagnostic);
  return diagnostics;
}

function changeSetOperationSchemaDiagnostic(input: unknown): RobloxDiagnostic | undefined {
  const operations = objectRecord(input)?.operations;
  if (!Array.isArray(operations)) return undefined;
  const diagnostics = operations.flatMap((operation, index) =>
    operationSchemaDiagnostics(operation, `/operations/${index}`),
  );
  return sortDiagnostics(diagnostics)[0];
}

function schemaValidation<T>(
  input: unknown,
  validateSchema: ValidateFunction<T>,
  discriminatedDiagnostic?: (value: unknown) => RobloxDiagnostic | undefined,
): RobloxContractValidationResult<T> | undefined {
  const issue = inspectJsonCompatibility(input);
  if (issue !== undefined) {
    return {
      valid: false,
      diagnostics: [
        diagnostic(
          'contract.schema_invalid',
          issue.path,
          `Value is not JSON-compatible: ${issue.reason}.`,
        ),
      ],
    };
  }
  const targetedDiagnostic = discriminatedDiagnostic?.(input);
  if (targetedDiagnostic !== undefined) {
    return { valid: false, diagnostics: [targetedDiagnostic] };
  }
  if (validateSchema(input)) return undefined;

  const error = mostUsefulSchemaError(validateSchema.errors);
  return {
    valid: false,
    diagnostics: [
      diagnostic(
        'contract.schema_invalid',
        error === undefined ? '' : schemaErrorPath(error),
        error === undefined
          ? 'Value does not satisfy the Roblox compiler contract.'
          : schemaErrorMessage(error),
      ),
    ],
  };
}

function nodeMetadataDiagnostics(
  node: Readonly<RobloxManagedNode>,
  projectId: string,
  path: string,
): RobloxDiagnostic[] {
  const diagnostics: RobloxDiagnostic[] = [];
  if (node.attributes.WorldwrightProjectId !== projectId) {
    diagnostics.push(
      diagnostic(
        'contract.metadata_invalid',
        `${path}/attributes/WorldwrightProjectId`,
        'Managed project metadata must match the containing contract project.',
        node.id,
      ),
    );
  }
  if (node.attributes.WorldwrightEntityId !== node.id) {
    diagnostics.push(
      diagnostic(
        'contract.metadata_invalid',
        `${path}/attributes/WorldwrightEntityId`,
        'Managed entity ID metadata must match the node ID.',
        node.id,
      ),
    );
  }
  if (node.attributes.WorldwrightEntityKind !== node.entityKind) {
    diagnostics.push(
      diagnostic(
        'contract.metadata_invalid',
        `${path}/attributes/WorldwrightEntityKind`,
        'Managed entity-kind metadata must match the node entity kind.',
        node.id,
      ),
    );
  }
  if (node.attributes.WorldwrightCompilerVersion !== ROBLOX_COMPILER_VERSION) {
    diagnostics.push(
      diagnostic(
        'contract.metadata_invalid',
        `${path}/attributes/WorldwrightCompilerVersion`,
        'Managed compiler metadata must match the contract compiler version.',
        node.id,
      ),
    );
  }
  return diagnostics;
}

interface ManagedGraphValidationOptions {
  readonly nodes: readonly RobloxManagedNode[];
  readonly rootNodeId: string | undefined;
  readonly projectId: string;
  readonly sourceHash: string | undefined;
  readonly nodesPath: string;
  readonly rootPath: string;
}

function managedGraphDiagnostics(
  options: Readonly<ManagedGraphValidationOptions>,
): RobloxDiagnostic[] {
  const diagnostics: RobloxDiagnostic[] = [];
  const nodesById = new Map<string, RobloxManagedNode>();
  const indexById = new Map<string, number>();

  options.nodes.forEach((node, index) => {
    const path = `${options.nodesPath}/${index}`;
    diagnostics.push(...nodeMetadataDiagnostics(node, options.projectId, path));
    if (nodesById.has(node.id)) {
      diagnostics.push(
        diagnostic(
          'contract.id_duplicate',
          `${path}/id`,
          'Managed node IDs must be unique.',
          node.id,
        ),
      );
    } else {
      nodesById.set(node.id, node);
      indexById.set(node.id, index);
    }
  });

  if (options.nodes.length === 0) {
    if (options.rootNodeId !== undefined) {
      diagnostics.push(
        diagnostic(
          'contract.root_invalid',
          options.rootPath,
          'An empty managed scene must not declare a root node.',
          options.rootNodeId,
        ),
      );
    }
    return diagnostics;
  }

  if (options.rootNodeId === undefined) {
    diagnostics.push(
      diagnostic(
        'contract.root_invalid',
        options.rootPath,
        'A non-empty managed scene must declare its root node.',
      ),
    );
    return diagnostics;
  }

  const root = nodesById.get(options.rootNodeId);
  if (root === undefined) {
    diagnostics.push(
      diagnostic(
        'contract.root_invalid',
        options.rootPath,
        'The declared managed root node does not exist.',
        options.rootNodeId,
      ),
    );
  } else {
    const rootIndex = indexById.get(root.id)!;
    if (root.parentId !== undefined) {
      diagnostics.push(
        diagnostic(
          'contract.root_invalid',
          `${options.nodesPath}/${rootIndex}/parentId`,
          'The managed root node must not declare a parent.',
          root.id,
        ),
      );
    }
    if (root.className !== 'Folder' && root.className !== 'Model') {
      diagnostics.push(
        diagnostic(
          'contract.root_invalid',
          `${options.nodesPath}/${rootIndex}/className`,
          'The managed root node must be a Folder or Model.',
          root.id,
        ),
      );
    }
    if (root.entityKind !== 'world') {
      diagnostics.push(
        diagnostic(
          'contract.root_invalid',
          `${options.nodesPath}/${rootIndex}/entityKind`,
          'The managed root node must retain WorldSpec entity kind "world".',
          root.id,
        ),
      );
    }
    if (root.attributes.WorldwrightSourceHash === undefined) {
      diagnostics.push(
        diagnostic(
          'contract.metadata_invalid',
          `${options.nodesPath}/${rootIndex}/attributes/WorldwrightSourceHash`,
          'The managed root node must carry source-hash metadata.',
          root.id,
        ),
      );
    } else if (
      options.sourceHash !== undefined &&
      root.attributes.WorldwrightSourceHash !== options.sourceHash
    ) {
      diagnostics.push(
        diagnostic(
          'contract.metadata_invalid',
          `${options.nodesPath}/${rootIndex}/attributes/WorldwrightSourceHash`,
          'Root source-hash metadata must match the manifest source hash.',
          root.id,
        ),
      );
    }
  }

  for (const node of nodesById.values()) {
    const index = indexById.get(node.id)!;
    if (node.id !== options.rootNodeId && node.attributes.WorldwrightSourceHash !== undefined) {
      diagnostics.push(
        diagnostic(
          'contract.metadata_invalid',
          `${options.nodesPath}/${index}/attributes/WorldwrightSourceHash`,
          'Source-hash metadata is allowed only on the managed root node.',
          node.id,
        ),
      );
    }
    if (node.parentId !== undefined && !nodesById.has(node.parentId)) {
      diagnostics.push(
        diagnostic(
          'contract.parent_missing',
          `${options.nodesPath}/${index}/parentId`,
          'Managed parent ID must resolve to a managed node.',
          node.parentId,
        ),
      );
    }
    if (node.parentId !== undefined) {
      const parent = nodesById.get(node.parentId);
      if (parent !== undefined && parent.className !== 'Folder' && parent.className !== 'Model') {
        diagnostics.push(
          diagnostic(
            'contract.metadata_invalid',
            `${options.nodesPath}/${index}/parentId`,
            'Managed primitive nodes cannot contain managed children.',
            node.parentId,
          ),
        );
      }
    }
  }

  const reachesRoot = new Map<string, boolean>();
  for (const startId of [...nodesById.keys()].sort(compareCodePoints)) {
    if (reachesRoot.has(startId)) continue;
    const path: string[] = [];
    const localIndex = new Map<string, number>();
    let currentId: string | undefined = startId;
    let resolved = false;
    let cycleStart: number | undefined;

    while (currentId !== undefined) {
      const known = reachesRoot.get(currentId);
      if (known !== undefined) {
        resolved = known;
        break;
      }
      if (currentId === options.rootNodeId) {
        resolved = root !== undefined;
        break;
      }
      const priorIndex = localIndex.get(currentId);
      if (priorIndex !== undefined) {
        cycleStart = priorIndex;
        break;
      }
      localIndex.set(currentId, path.length);
      path.push(currentId);
      const current = nodesById.get(currentId);
      currentId = current?.parentId;
      if (
        current !== undefined &&
        current.parentId !== undefined &&
        !nodesById.has(current.parentId)
      ) {
        currentId = undefined;
      }
    }

    if (cycleStart !== undefined) {
      const cycleIds = path.slice(cycleStart).sort(compareCodePoints);
      const reportedId = cycleIds[0]!;
      const reportedIndex = indexById.get(reportedId)!;
      diagnostics.push(
        diagnostic(
          'contract.parent_cycle',
          `${options.nodesPath}/${reportedIndex}/parentId`,
          'Managed parent references must be acyclic.',
          reportedId,
        ),
      );
    }
    for (const id of path) reachesRoot.set(id, resolved);
  }

  for (const [id, doesReachRoot] of reachesRoot) {
    if (doesReachRoot) continue;
    const index = indexById.get(id)!;
    diagnostics.push(
      diagnostic(
        'contract.unreachable',
        `${options.nodesPath}/${index}`,
        'Every managed node must reach the declared managed root.',
        id,
      ),
    );
  }

  return diagnostics;
}

function manifestSemanticDiagnostics(manifest: Readonly<RobloxManifest>): RobloxDiagnostic[] {
  const diagnostics = managedGraphDiagnostics({
    nodes: manifest.nodes,
    rootNodeId: manifest.rootNodeId,
    projectId: manifest.source.projectId,
    sourceHash: manifest.source.worldSpecHash,
    nodesPath: '/nodes',
    rootPath: '/rootNodeId',
  });
  const containers = manifest.nodes.filter(
    (node) => node.className === 'Folder' || node.className === 'Model',
  ).length;
  const primitives = manifest.nodes.length - containers;
  if (
    manifest.measurements.instances !== manifest.nodes.length ||
    manifest.measurements.containers !== containers ||
    manifest.measurements.primitives !== primitives ||
    manifest.measurements.containers + manifest.measurements.primitives !==
      manifest.measurements.instances
  ) {
    diagnostics.push(
      diagnostic(
        'contract.measurements_invalid',
        '/measurements',
        'Manifest measurements must exactly match the managed node classes and count.',
      ),
    );
  }
  return sortDiagnostics(diagnostics);
}

function snapshotSemanticDiagnostics(snapshot: Readonly<RobloxSceneSnapshot>): RobloxDiagnostic[] {
  const diagnostics = managedGraphDiagnostics({
    nodes: snapshot.nodes,
    rootNodeId: snapshot.rootNodeId,
    projectId: snapshot.projectId,
    sourceHash: undefined,
    nodesPath: '/nodes',
    rootPath: '/rootNodeId',
  });
  const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
  const snapshotIds = new Set<string>();
  snapshot.unmanagedRoots.forEach((root, index) => {
    if (snapshotIds.has(root.snapshotId)) {
      diagnostics.push(
        diagnostic(
          'contract.id_duplicate',
          `/unmanagedRoots/${index}/snapshotId`,
          'Unmanaged-root snapshot IDs must be unique.',
          root.snapshotId,
        ),
      );
    }
    snapshotIds.add(root.snapshotId);
    if (!nodeIds.has(root.parentNodeId)) {
      diagnostics.push(
        diagnostic(
          'contract.parent_missing',
          `/unmanagedRoots/${index}/parentNodeId`,
          'An unmanaged root must reference an existing managed parent.',
          root.parentNodeId,
        ),
      );
    }
  });
  return sortDiagnostics(diagnostics);
}

function operationNode(operation: Readonly<RobloxChangeOperation>): RobloxManagedNode {
  return operation.type === 'create' ? operation.node : operation.before;
}

function changeSetSemanticDiagnostics(changeSet: Readonly<RobloxChangeSet>): RobloxDiagnostic[] {
  const diagnostics: RobloxDiagnostic[] = [];
  const operationIds = new Set<string>();
  const targetIds = new Set<string>();
  const phase = { create: 0, update: 1, delete: 2 } as const;
  let priorPhase = -1;
  let creates = 0;
  let updates = 0;
  let deletes = 0;

  changeSet.operations.forEach((operation, index) => {
    const path = `/operations/${index}`;
    const node = operationNode(operation);
    const expectedOperationId = `${operation.type}:${node.id}`;
    if (operation.id !== expectedOperationId) {
      diagnostics.push(
        diagnostic(
          'contract.operation_invalid',
          `${path}/id`,
          'Operation ID must exactly equal its type and managed node ID.',
          node.id,
        ),
      );
    }
    if (operationIds.has(operation.id)) {
      diagnostics.push(
        diagnostic(
          'contract.id_duplicate',
          `${path}/id`,
          'Change-set operation IDs must be unique.',
          operation.id,
        ),
      );
    }
    operationIds.add(operation.id);
    if (targetIds.has(node.id)) {
      diagnostics.push(
        diagnostic(
          'contract.operation_invalid',
          path,
          'A change set may target each managed node at most once.',
          node.id,
        ),
      );
    }
    targetIds.add(node.id);

    const currentPhase = phase[operation.type];
    if (currentPhase < priorPhase) {
      diagnostics.push(
        diagnostic(
          'contract.operation_invalid',
          path,
          'Operations must use create, update, then delete execution phases.',
          node.id,
        ),
      );
    }
    priorPhase = Math.max(priorPhase, currentPhase);

    diagnostics.push(
      ...nodeMetadataDiagnostics(
        node,
        changeSet.preconditions.projectId,
        `${path}/${operation.type === 'create' ? 'node' : 'before'}`,
      ),
    );

    switch (operation.type) {
      case 'create':
        creates += 1;
        break;
      case 'update':
        updates += 1;
        diagnostics.push(
          ...nodeMetadataDiagnostics(
            operation.after,
            changeSet.preconditions.projectId,
            `${path}/after`,
          ),
        );
        if (operation.before.id !== operation.after.id) {
          diagnostics.push(
            diagnostic(
              'contract.operation_invalid',
              `${path}/after/id`,
              'An update must preserve managed node identity.',
              operation.before.id,
            ),
          );
        }
        if (operation.before.className !== operation.after.className) {
          diagnostics.push(
            diagnostic(
              'contract.operation_invalid',
              `${path}/after/className`,
              'An update must not change the managed Roblox class.',
              operation.before.id,
            ),
          );
        }
        if (
          jsonValuesEqual(
            normalizeRobloxManagedNode(operation.before),
            normalizeRobloxManagedNode(operation.after),
          )
        ) {
          diagnostics.push(
            diagnostic(
              'contract.operation_invalid',
              path,
              'An update must contain different before and after nodes.',
              operation.before.id,
            ),
          );
        }
        break;
      case 'delete':
        deletes += 1;
        break;
    }
  });

  if (
    changeSet.summary.creates !== creates ||
    changeSet.summary.updates !== updates ||
    changeSet.summary.deletes !== deletes ||
    changeSet.summary.total !== changeSet.operations.length ||
    changeSet.summary.creates + changeSet.summary.updates + changeSet.summary.deletes !==
      changeSet.summary.total
  ) {
    diagnostics.push(
      diagnostic(
        'contract.measurements_invalid',
        '/summary',
        'Change-set summary counts must exactly match its operations.',
      ),
    );
  }
  return sortDiagnostics(diagnostics);
}

/** Validates a manifest schema and all cross-field and hierarchy invariants. */
export function validateRobloxManifest(
  input: unknown,
): RobloxContractValidationResult<RobloxManifest> {
  try {
    const schemaResult = schemaValidation(input, checkManifestSchema, managedNodesSchemaDiagnostic);
    if (schemaResult !== undefined) return schemaResult;
    const manifest = input as RobloxManifest;
    const diagnostics = manifestSemanticDiagnostics(manifest);
    return diagnostics.length === 0
      ? { valid: true, value: normalizeRobloxManifest(manifest), diagnostics }
      : { valid: false, diagnostics };
  } catch {
    return {
      valid: false,
      diagnostics: [
        diagnostic('contract.schema_invalid', '', 'Manifest input could not be safely inspected.'),
      ],
    };
  }
}

/** Validates a scene snapshot schema and all managed-ownership invariants. */
export function validateRobloxSnapshot(
  input: unknown,
): RobloxContractValidationResult<RobloxSceneSnapshot> {
  try {
    const schemaResult = schemaValidation(input, checkSnapshotSchema, managedNodesSchemaDiagnostic);
    if (schemaResult !== undefined) return schemaResult;
    const snapshot = input as RobloxSceneSnapshot;
    const diagnostics = snapshotSemanticDiagnostics(snapshot);
    return diagnostics.length === 0
      ? { valid: true, value: normalizeRobloxSnapshot(snapshot), diagnostics }
      : { valid: false, diagnostics };
  } catch {
    return {
      valid: false,
      diagnostics: [
        diagnostic('contract.schema_invalid', '', 'Snapshot input could not be safely inspected.'),
      ],
    };
  }
}

/** Validates a change-set schema and deterministic operation invariants. */
export function validateRobloxChangeSet(
  input: unknown,
): RobloxContractValidationResult<RobloxChangeSet> {
  try {
    const schemaResult = schemaValidation(
      input,
      checkChangeSetSchema,
      changeSetOperationSchemaDiagnostic,
    );
    if (schemaResult !== undefined) return schemaResult;
    const changeSet = input as RobloxChangeSet;
    const diagnostics = changeSetSemanticDiagnostics(changeSet);
    return diagnostics.length === 0
      ? { valid: true, value: normalizeRobloxChangeSet(changeSet), diagnostics }
      : { valid: false, diagnostics };
  } catch {
    return {
      valid: false,
      diagnostics: [
        diagnostic(
          'contract.schema_invalid',
          '',
          'Change-set input could not be safely inspected.',
        ),
      ],
    };
  }
}
