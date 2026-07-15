import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';

import { type Diagnostic, type DiagnosticCode, type ValidationResult } from './diagnostics.js';
import { WorldSpecSchema } from './schema.js';
import type { WorldEntity, WorldSpec } from './types.js';

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictNumbers: true,
  validateFormats: false,
});

const validateSchema = ajv.compile<WorldSpec>(WorldSpecSchema);

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function escapePointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function appendPointer(path: string, segment: string): string {
  return `${path}/${escapePointerSegment(segment)}`;
}

function displayPath(path: string): string {
  return path;
}

function diagnostic(
  code: DiagnosticCode,
  path: string,
  message: string,
  relatedId?: string,
): Diagnostic {
  return {
    code,
    severity: 'error',
    path: displayPath(path),
    message,
    ...(relatedId === undefined ? {} : { relatedId }),
  };
}

function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const byPath = compareCodePoints(left.path, right.path);
    if (byPath !== 0) return byPath;
    const byCode = compareCodePoints(left.code, right.code);
    if (byCode !== 0) return byCode;
    const byMessage = compareCodePoints(left.message, right.message);
    if (byMessage !== 0) return byMessage;
    return compareCodePoints(left.relatedId ?? '', right.relatedId ?? '');
  });
}

function invalidJsonValue(path: string, reason: string): Diagnostic {
  return diagnostic('schema.invalid', path, `Value is not JSON-compatible: ${reason}.`);
}

function inspectJsonValue(
  value: unknown,
  path: string,
  activeObjects: WeakSet<object>,
): Diagnostic | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return undefined;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? undefined : invalidJsonValue(path, 'numbers must be finite');
  }
  if (typeof value === 'undefined') return invalidJsonValue(path, 'undefined is not permitted');
  if (typeof value === 'bigint') return invalidJsonValue(path, 'BigInt is not permitted');
  if (typeof value === 'symbol') return invalidJsonValue(path, 'symbols are not permitted');
  if (typeof value === 'function') return invalidJsonValue(path, 'functions are not permitted');

  if (activeObjects.has(value))
    return invalidJsonValue(path, 'cyclic references are not permitted');
  activeObjects.add(value);

  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return invalidJsonValue(path, 'array subclasses are not plain JSON arrays');
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        return invalidJsonValue(path, 'symbol-keyed properties are not permitted');
      }
      for (const name of Object.getOwnPropertyNames(value)) {
        if (name === 'length') continue;
        const index = Number(name);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          String(index) !== name ||
          index >= value.length
        ) {
          return invalidJsonValue(
            appendPointer(path, name),
            'custom array properties are not permitted',
          );
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        const childPath = appendPointer(path, String(index));
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined)
          return invalidJsonValue(childPath, 'sparse array holes are not permitted');
        if (!('value' in descriptor)) {
          return invalidJsonValue(childPath, 'accessor properties are not permitted');
        }
        const childDiagnostic = inspectJsonValue(descriptor.value, childPath, activeObjects);
        if (childDiagnostic !== undefined) return childDiagnostic;
      }
      return undefined;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidJsonValue(path, 'class instances and built-in objects are not permitted');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return invalidJsonValue(path, 'symbol-keyed properties are not permitted');
    }

    for (const key of Object.getOwnPropertyNames(value).sort(compareCodePoints)) {
      const childPath = appendPointer(path, key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable) {
        return invalidJsonValue(childPath, 'non-enumerable properties are not permitted');
      }
      if (!('value' in descriptor)) {
        return invalidJsonValue(childPath, 'accessor properties are not permitted');
      }
      const childDiagnostic = inspectJsonValue(descriptor.value, childPath, activeObjects);
      if (childDiagnostic !== undefined) return childDiagnostic;
    }
    return undefined;
  } finally {
    activeObjects.delete(value);
  }
}

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
  return displayPath(
    property === undefined ? error.instancePath : appendPointer(error.instancePath, property),
  );
}

function schemaErrorMessage(error: ErrorObject): string {
  switch (error.keyword) {
    case 'additionalProperties':
      return 'Property is not allowed by this schema.';
    case 'required':
      return 'Required property is missing.';
    case 'type': {
      const expected = errorParameter(error, 'type');
      return expected === undefined
        ? 'Value has the wrong type.'
        : `Expected a value of type ${expected}.`;
    }
    case 'const':
      return 'Value does not match the required constant.';
    case 'enum':
      return 'Value is not one of the allowed choices.';
    case 'pattern':
      return 'String does not match the required identifier format.';
    case 'uniqueItems':
      return 'Array items must be unique.';
    case 'minimum':
    case 'exclusiveMinimum':
    case 'maximum':
    case 'exclusiveMaximum':
      return 'Number is outside the allowed range.';
    case 'minItems':
      return 'Array contains fewer items than required.';
    case 'minLength':
    case 'maxLength':
      return 'String length is outside the allowed range.';
    case 'anyOf':
      return 'Value does not match any allowed JSON type.';
    default:
      return `Value does not satisfy the schema rule "${error.keyword}".`;
  }
}

function schemaDiagnostics(errors: readonly ErrorObject[] | null | undefined): Diagnostic[] {
  return sortDiagnostics(
    (errors ?? []).map((error) =>
      diagnostic('schema.invalid', schemaErrorPath(error), schemaErrorMessage(error)),
    ),
  );
}

interface IdentifierLocation {
  readonly id: string;
  readonly path: string;
}

function identifierLocations(worldSpec: WorldSpec): IdentifierLocation[] {
  return [
    { id: worldSpec.project.id, path: '/project/id' },
    ...worldSpec.references.map((reference, index) => ({
      id: reference.id,
      path: `/references/${index}/id`,
    })),
    ...worldSpec.entities.map((entity, index) => ({
      id: entity.id,
      path: `/entities/${index}/id`,
    })),
    ...worldSpec.relationships.map((relationship, index) => ({
      id: relationship.id,
      path: `/relationships/${index}/id`,
    })),
    ...worldSpec.constraints.map((constraint, index) => ({
      id: constraint.id,
      path: `/constraints/${index}/id`,
    })),
    ...worldSpec.locks.map((lock, index) => ({ id: lock.id, path: `/locks/${index}/id` })),
  ];
}

function validateUniqueIdentifiers(worldSpec: WorldSpec, diagnostics: Diagnostic[]): void {
  const firstPathById = new Map<string, string>();
  for (const location of identifierLocations(worldSpec)) {
    const firstPath = firstPathById.get(location.id);
    if (firstPath === undefined) {
      firstPathById.set(location.id, location.path);
    } else {
      diagnostics.push(
        diagnostic(
          'id.duplicate',
          location.path,
          `Identifier "${location.id}" duplicates the identifier at ${firstPath}.`,
          location.id,
        ),
      );
    }
  }
}

function firstEntityMaps(worldSpec: WorldSpec): {
  readonly entitiesById: Map<string, WorldEntity>;
  readonly indexById: Map<string, number>;
} {
  const entitiesById = new Map<string, WorldEntity>();
  const indexById = new Map<string, number>();
  worldSpec.entities.forEach((entity, index) => {
    if (!entitiesById.has(entity.id)) {
      entitiesById.set(entity.id, entity);
      indexById.set(entity.id, index);
    }
  });
  return { entitiesById, indexById };
}

function validateRootAndParents(
  worldSpec: WorldSpec,
  entitiesById: ReadonlyMap<string, WorldEntity>,
  diagnostics: Diagnostic[],
): void {
  const root = entitiesById.get(worldSpec.rootEntityId);
  if (root === undefined) {
    diagnostics.push(
      diagnostic(
        'entity.root_missing',
        '/rootEntityId',
        `Root entity "${worldSpec.rootEntityId}" does not exist.`,
        worldSpec.rootEntityId,
      ),
    );
  } else {
    if (root.kind !== 'world') {
      diagnostics.push(
        diagnostic(
          'entity.root_wrong_kind',
          `/entities/${worldSpec.entities.indexOf(root)}/kind`,
          'The root entity must have kind "world".',
          root.id,
        ),
      );
    }
    if (root.parentId !== undefined) {
      diagnostics.push(
        diagnostic(
          'entity.root_has_parent',
          `/entities/${worldSpec.entities.indexOf(root)}/parentId`,
          'The root entity must not have a parent.',
          root.id,
        ),
      );
    }
  }

  worldSpec.entities.forEach((entity, index) => {
    if (entity.id === worldSpec.rootEntityId) return;
    if (entity.parentId === undefined) {
      diagnostics.push(
        diagnostic(
          'entity.parent_missing',
          `/entities/${index}/parentId`,
          'Every non-root entity must declare a parentId.',
          entity.id,
        ),
      );
      return;
    }
    if (entity.parentId === entity.id) {
      diagnostics.push(
        diagnostic(
          'entity.parent_self',
          `/entities/${index}/parentId`,
          'An entity cannot parent itself.',
          entity.id,
        ),
      );
    }
    if (!entitiesById.has(entity.parentId)) {
      diagnostics.push(
        diagnostic(
          'entity.parent_missing',
          `/entities/${index}/parentId`,
          `Parent entity "${entity.parentId}" does not exist.`,
          entity.parentId,
        ),
      );
    }
  });
}

function validateParentCycles(
  entitiesById: ReadonlyMap<string, WorldEntity>,
  indexById: ReadonlyMap<string, number>,
  diagnostics: Diagnostic[],
): void {
  const processed = new Set<string>();
  const entityIds = [...entitiesById.keys()].sort(compareCodePoints);

  for (const startId of entityIds) {
    if (processed.has(startId)) continue;
    const chain: string[] = [];
    const chainPositions = new Map<string, number>();
    let currentId: string | undefined = startId;

    while (currentId !== undefined && entitiesById.has(currentId) && !processed.has(currentId)) {
      const cycleStart = chainPositions.get(currentId);
      if (cycleStart !== undefined) {
        const cycleIds = chain.slice(cycleStart);
        const anchorId = [...cycleIds].sort(compareCodePoints)[0];
        if (anchorId !== undefined) {
          const anchorIndex = indexById.get(anchorId);
          diagnostics.push(
            diagnostic(
              'entity.parent_cycle',
              anchorIndex === undefined ? '/entities' : `/entities/${anchorIndex}/parentId`,
              `Entity parent cycle detected: ${[...cycleIds, currentId].join(' -> ')}.`,
              anchorId,
            ),
          );
        }
        break;
      }

      chainPositions.set(currentId, chain.length);
      chain.push(currentId);
      currentId = entitiesById.get(currentId)?.parentId;
    }

    for (const id of chain) processed.add(id);
  }
}

function reachesRoot(
  entityId: string,
  rootEntityId: string,
  entitiesById: ReadonlyMap<string, WorldEntity>,
): boolean {
  const visited = new Set<string>();
  let currentId = entityId;
  while (currentId !== rootEntityId) {
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    const entity = entitiesById.get(currentId);
    if (entity?.parentId === undefined) return false;
    currentId = entity.parentId;
  }
  return entitiesById.has(rootEntityId);
}

function validateReachability(
  worldSpec: WorldSpec,
  entitiesById: ReadonlyMap<string, WorldEntity>,
  diagnostics: Diagnostic[],
): void {
  worldSpec.entities.forEach((entity, index) => {
    if (
      entity.id !== worldSpec.rootEntityId &&
      !reachesRoot(entity.id, worldSpec.rootEntityId, entitiesById)
    ) {
      diagnostics.push(
        diagnostic(
          'entity.unreachable',
          `/entities/${index}`,
          `Entity "${entity.id}" is not reachable from the root through its parent chain.`,
          entity.id,
        ),
      );
    }
  });
}

function validateReferencesAndEndpoints(
  worldSpec: WorldSpec,
  entitiesById: ReadonlyMap<string, WorldEntity>,
  diagnostics: Diagnostic[],
): void {
  const referenceIds = new Set(worldSpec.references.map((reference) => reference.id));
  worldSpec.entities.forEach((entity, entityIndex) => {
    entity.provenance.referenceIds.forEach((referenceId, referenceIndex) => {
      if (!referenceIds.has(referenceId)) {
        diagnostics.push(
          diagnostic(
            'reference.missing',
            `/entities/${entityIndex}/provenance/referenceIds/${referenceIndex}`,
            `Provenance reference "${referenceId}" does not exist.`,
            referenceId,
          ),
        );
      }
    });
  });

  worldSpec.relationships.forEach((relationship, index) => {
    for (const [field, entityId] of [
      ['sourceId', relationship.sourceId],
      ['targetId', relationship.targetId],
    ] as const) {
      if (!entitiesById.has(entityId)) {
        diagnostics.push(
          diagnostic(
            'relationship.endpoint_missing',
            `/relationships/${index}/${field}`,
            `Relationship endpoint "${entityId}" does not exist.`,
            entityId,
          ),
        );
      }
    }
    if (relationship.sourceId === relationship.targetId) {
      diagnostics.push(
        diagnostic(
          'relationship.self',
          `/relationships/${index}/targetId`,
          'A relationship cannot connect an entity to itself.',
          relationship.sourceId,
        ),
      );
    }
  });

  worldSpec.constraints.forEach((constraint, constraintIndex) => {
    for (const [field, ids] of [
      ['subjectIds', constraint.subjectIds],
      ['targetIds', constraint.targetIds],
    ] as const) {
      ids.forEach((entityId, entityIndex) => {
        if (!entitiesById.has(entityId)) {
          diagnostics.push(
            diagnostic(
              'constraint.entity_missing',
              `/constraints/${constraintIndex}/${field}/${entityIndex}`,
              `Constraint entity "${entityId}" does not exist.`,
              entityId,
            ),
          );
        }
      });
    }
  });

  worldSpec.locks.forEach((lock, lockIndex) => {
    if (!entitiesById.has(lock.entityId)) {
      diagnostics.push(
        diagnostic(
          'lock.entity_missing',
          `/locks/${lockIndex}/entityId`,
          `Locked entity "${lock.entityId}" does not exist.`,
          lock.entityId,
        ),
      );
    }
    if (lock.fieldPaths.length === 0) {
      diagnostics.push(
        diagnostic(
          'lock.path_empty',
          `/locks/${lockIndex}/fieldPaths`,
          'A lock must contain at least one non-empty field path.',
          lock.id,
        ),
      );
    } else {
      lock.fieldPaths.forEach((fieldPath, fieldPathIndex) => {
        if (fieldPath.trim() === '') {
          diagnostics.push(
            diagnostic(
              'lock.path_empty',
              `/locks/${lockIndex}/fieldPaths/${fieldPathIndex}`,
              'Lock field paths must not be empty.',
              lock.id,
            ),
          );
        }
      });
    }
  });
}

function semanticDiagnostics(worldSpec: WorldSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  validateUniqueIdentifiers(worldSpec, diagnostics);
  const { entitiesById, indexById } = firstEntityMaps(worldSpec);
  validateRootAndParents(worldSpec, entitiesById, diagnostics);
  validateParentCycles(entitiesById, indexById, diagnostics);
  validateReachability(worldSpec, entitiesById, diagnostics);
  validateReferencesAndEndpoints(worldSpec, entitiesById, diagnostics);
  return sortDiagnostics(diagnostics);
}

/** Validates JSON compatibility, the runtime schema, and then semantic invariants. */
export function validateWorldSpec(input: unknown): ValidationResult {
  try {
    const jsonDiagnostic = inspectJsonValue(input, '', new WeakSet<object>());
    if (jsonDiagnostic !== undefined) {
      return { valid: false, diagnostics: [jsonDiagnostic] };
    }
    if (!validateSchema(input)) {
      return { valid: false, diagnostics: schemaDiagnostics(validateSchema.errors) };
    }

    const diagnostics = semanticDiagnostics(input);
    return diagnostics.length === 0
      ? { valid: true, value: input, diagnostics }
      : { valid: false, diagnostics };
  } catch {
    return {
      valid: false,
      diagnostics: [
        diagnostic(
          'schema.invalid',
          '',
          'Input could not be safely inspected as JSON-compatible data.',
        ),
      ],
    };
  }
}

/** Parses JSON source text and validates it without throwing for invalid input. */
export function parseWorldSpec(source: unknown): ValidationResult {
  if (typeof source !== 'string') {
    return {
      valid: false,
      diagnostics: [diagnostic('json.invalid', '', 'Expected WorldSpec JSON source text.')],
    };
  }

  try {
    return validateWorldSpec(JSON.parse(source) as unknown);
  } catch {
    return {
      valid: false,
      diagnostics: [diagnostic('json.invalid', '', 'The input is not valid JSON text.')],
    };
  }
}
