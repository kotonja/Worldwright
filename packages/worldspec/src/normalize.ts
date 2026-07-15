import type { JsonValue } from './schema.js';
import type {
  Bounds,
  Project,
  Provenance,
  Transform,
  WorldBudgets,
  WorldConstraint,
  WorldEntity,
  WorldLock,
  WorldReference,
  WorldRelationship,
  WorldSpec,
} from './types.js';

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort(compareCodePoints);
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function canonicalizeJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (isJsonArray(value)) return value.map(canonicalizeJsonValue);

  const normalized: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort(compareCodePoints)) {
    const child = value[key];
    if (child !== undefined) {
      Object.defineProperty(normalized, key, {
        configurable: true,
        enumerable: true,
        value: canonicalizeJsonValue(child),
        writable: true,
      });
    }
  }
  return normalized;
}

function canonicalizeJsonObject(
  value: Readonly<Record<string, JsonValue>>,
): Record<string, JsonValue> {
  return canonicalizeJsonValue(value) as Record<string, JsonValue>;
}

function normalizeProject(project: Readonly<Project>): Project {
  return {
    id: project.id,
    name: project.name,
    ...(project.description === undefined ? {} : { description: project.description }),
    seed: project.seed,
    units: project.units,
    upAxis: project.upAxis,
  };
}

function normalizeReference(reference: Readonly<WorldReference>): WorldReference {
  return {
    id: reference.id,
    kind: reference.kind,
    role: reference.role,
    ...(reference.uri === undefined ? {} : { uri: reference.uri }),
    influence: reference.influence,
    ...(reference.notes === undefined ? {} : { notes: reference.notes }),
  };
}

function normalizeProvenance(provenance: Readonly<Provenance>): Provenance {
  return {
    classification: provenance.classification,
    referenceIds: sortedStrings(provenance.referenceIds),
    confidence: provenance.confidence,
    ...(provenance.notes === undefined ? {} : { notes: provenance.notes }),
  };
}

function normalizeTransform(transform: Readonly<Transform>): Transform {
  return {
    position: { x: transform.position.x, y: transform.position.y, z: transform.position.z },
    rotationEulerDegrees: {
      x: transform.rotationEulerDegrees.x,
      y: transform.rotationEulerDegrees.y,
      z: transform.rotationEulerDegrees.z,
    },
    scale: { x: transform.scale.x, y: transform.scale.y, z: transform.scale.z },
  };
}

function normalizeBounds(bounds: Readonly<Bounds>): Bounds {
  return { size: { x: bounds.size.x, y: bounds.size.y, z: bounds.size.z } };
}

function normalizeEntity(entity: Readonly<WorldEntity>): WorldEntity {
  return {
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    ...(entity.parentId === undefined ? {} : { parentId: entity.parentId }),
    provenance: normalizeProvenance(entity.provenance),
    ...(entity.transform === undefined ? {} : { transform: normalizeTransform(entity.transform) }),
    ...(entity.bounds === undefined ? {} : { bounds: normalizeBounds(entity.bounds) }),
    tags: sortedStrings(entity.tags),
    attributes: canonicalizeJsonObject(entity.attributes),
  };
}

function normalizeRelationship(relationship: Readonly<WorldRelationship>): WorldRelationship {
  return {
    id: relationship.id,
    type: relationship.type,
    sourceId: relationship.sourceId,
    targetId: relationship.targetId,
    directed: relationship.directed,
    attributes: canonicalizeJsonObject(relationship.attributes),
  };
}

function normalizeConstraint(constraint: Readonly<WorldConstraint>): WorldConstraint {
  return {
    id: constraint.id,
    type: constraint.type,
    severity: constraint.severity,
    source: constraint.source,
    description: constraint.description,
    subjectIds: sortedStrings(constraint.subjectIds),
    targetIds: sortedStrings(constraint.targetIds),
    parameters: canonicalizeJsonObject(constraint.parameters),
  };
}

function normalizeLock(lock: Readonly<WorldLock>): WorldLock {
  return {
    id: lock.id,
    entityId: lock.entityId,
    fieldPaths: sortedStrings(lock.fieldPaths),
    owner: lock.owner,
    ...(lock.reason === undefined ? {} : { reason: lock.reason }),
  };
}

function normalizeBudgets(budgets: Readonly<WorldBudgets>): WorldBudgets {
  return {
    targetDevices: [...budgets.targetDevices].sort(compareCodePoints),
    qualityTier: budgets.qualityTier,
    streaming: budgets.streaming,
    ...(budgets.limits === undefined
      ? {}
      : {
          limits: {
            ...(budgets.limits.instances === undefined
              ? {}
              : { instances: budgets.limits.instances }),
            ...(budgets.limits.triangles === undefined
              ? {}
              : { triangles: budgets.limits.triangles }),
            ...(budgets.limits.textureMemoryMegabytes === undefined
              ? {}
              : { textureMemoryMegabytes: budgets.limits.textureMemoryMegabytes }),
          },
        }),
  };
}

/** Returns a deep, independent WorldSpec in its deterministic canonical order. */
export function normalizeWorldSpec(input: Readonly<WorldSpec>): WorldSpec {
  return {
    schemaVersion: input.schemaVersion,
    project: normalizeProject(input.project),
    intent: {
      summary: input.intent.summary,
      mustHave: [...input.intent.mustHave],
      mustNotHave: [...input.intent.mustNotHave],
      preferences: [...input.intent.preferences],
    },
    references: input.references.map(normalizeReference),
    style: {
      architecture: [...input.style.architecture],
      shapeLanguage: [...input.style.shapeLanguage],
      materialFamilies: [...input.style.materialFamilies],
      palette: [...input.style.palette],
      detailDensity: input.style.detailDensity,
      aging: input.style.aging,
      lighting: [...input.style.lighting],
      exclusions: [...input.style.exclusions],
    },
    rootEntityId: input.rootEntityId,
    entities: input.entities.map(normalizeEntity).sort((a, b) => compareCodePoints(a.id, b.id)),
    relationships: input.relationships
      .map(normalizeRelationship)
      .sort((a, b) => compareCodePoints(a.id, b.id)),
    constraints: input.constraints
      .map(normalizeConstraint)
      .sort((a, b) => compareCodePoints(a.id, b.id)),
    locks: input.locks.map(normalizeLock).sort((a, b) => compareCodePoints(a.id, b.id)),
    budgets: normalizeBudgets(input.budgets),
  };
}

/** Serializes normalized WorldSpec data with two spaces and exactly one trailing newline. */
export function stringifyWorldSpec(input: Readonly<WorldSpec>): string {
  const serialized = JSON.stringify(normalizeWorldSpec(input), null, 2);
  if (serialized === undefined) {
    throw new TypeError('A validated WorldSpec must be JSON serializable.');
  }
  return `${serialized}\n`;
}
