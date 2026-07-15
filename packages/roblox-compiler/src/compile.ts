import {
  WORLD_SPEC_VERSION,
  normalizeWorldSpec,
  stringifyWorldSpec,
  validateWorldSpec,
  type WorldEntity,
  type WorldSpec,
} from '@worldwright/worldspec';

import { ROBLOX_COMPILER_VERSION, ROBLOX_MANIFEST_VERSION } from './contract-schema.js';
import { diagnostic, hasErrorDiagnostics, sortDiagnostics } from './diagnostics.js';
import type { RobloxDiagnostic } from './diagnostics.js';
import { ROBLOX_DIRECTIVE_KEY, type RobloxDirective } from './directive-schema.js';
import { validateRobloxDirective } from './directive.js';
import { normalizeRobloxManifest, sha256Hex } from './normalize.js';
import type { CompileResult, RobloxManagedNode, RobloxManifest } from './types.js';

interface CompilableEntity {
  readonly entity: WorldEntity;
  readonly entityIndex: number;
  readonly directive: RobloxDirective;
}

function directivePath(index: number): string {
  return `/entities/${index}/attributes/${ROBLOX_DIRECTIVE_KEY}`;
}

function collectDirectives(
  worldSpec: Readonly<WorldSpec>,
  inputIndexById: ReadonlyMap<string, number>,
  diagnostics: RobloxDiagnostic[],
): CompilableEntity[] {
  const childCountById = new Map<string, number>();
  for (const entity of worldSpec.entities) {
    if (entity.parentId !== undefined) {
      childCountById.set(entity.parentId, (childCountById.get(entity.parentId) ?? 0) + 1);
    }
  }

  const compilable: CompilableEntity[] = [];
  worldSpec.entities.forEach((entity, normalizedIndex) => {
    const entityIndex = inputIndexById.get(entity.id) ?? normalizedIndex;
    if (!Object.hasOwn(entity.attributes, ROBLOX_DIRECTIVE_KEY)) {
      diagnostics.push(
        diagnostic(
          'compiler.directive_missing',
          directivePath(entityIndex),
          'Every compiled WorldSpec entity must declare a worldwright.roblox directive.',
          entity.id,
        ),
      );
      return;
    }

    const result = validateRobloxDirective(
      entity.attributes[ROBLOX_DIRECTIVE_KEY],
      directivePath(entityIndex),
    );
    if (!result.valid) {
      for (const entry of result.diagnostics) {
        diagnostics.push({ ...entry, relatedId: entity.id });
      }
      return;
    }

    if (entity.id === worldSpec.rootEntityId && result.value.mode !== 'container') {
      diagnostics.push(
        diagnostic(
          'compiler.root_not_container',
          `${directivePath(entityIndex)}/mode`,
          'The root WorldSpec entity must compile to a Folder or Model container.',
          entity.id,
        ),
      );
    }

    if (result.value.mode === 'primitive') {
      if ((childCountById.get(entity.id) ?? 0) > 0) {
        diagnostics.push(
          diagnostic(
            'compiler.primitive_has_children',
            `/entities/${entityIndex}`,
            'Primitive entities must be leaves in the WorldSpec hierarchy.',
            entity.id,
          ),
        );
      }
      if (entity.transform === undefined) {
        diagnostics.push(
          diagnostic(
            'compiler.transform_missing',
            `/entities/${entityIndex}/transform`,
            'Primitive entities require an explicit world-space transform.',
            entity.id,
          ),
        );
      }
      if (entity.bounds === undefined) {
        diagnostics.push(
          diagnostic(
            'compiler.bounds_missing',
            `/entities/${entityIndex}/bounds`,
            'Primitive entities require explicit bounds.',
            entity.id,
          ),
        );
      }
      if (entity.transform !== undefined && entity.bounds !== undefined) {
        const size = {
          x: entity.bounds.size.x * entity.transform.scale.x,
          y: entity.bounds.size.y * entity.transform.scale.y,
          z: entity.bounds.size.z * entity.transform.scale.z,
        };
        if (
          !Number.isFinite(size.x) ||
          !Number.isFinite(size.y) ||
          !Number.isFinite(size.z) ||
          size.x <= 0 ||
          size.y <= 0 ||
          size.z <= 0
        ) {
          diagnostics.push(
            diagnostic(
              'compiler.size_invalid',
              `/entities/${entityIndex}/bounds/size`,
              'Component-wise bounds and scale multiplication must produce a finite positive size.',
              entity.id,
            ),
          );
        }
      }
    }

    compilable.push({ entity, entityIndex, directive: result.value });
  });
  return compilable;
}

function managedAttributes(
  worldSpec: Readonly<WorldSpec>,
  entity: Readonly<WorldEntity>,
  sourceHash: string,
): RobloxManagedNode['attributes'] {
  return {
    WorldwrightManaged: true,
    WorldwrightProjectId: worldSpec.project.id,
    WorldwrightEntityId: entity.id,
    WorldwrightEntityKind: entity.kind,
    WorldwrightCompilerVersion: ROBLOX_COMPILER_VERSION,
    ...(entity.id === worldSpec.rootEntityId ? { WorldwrightSourceHash: sourceHash } : {}),
  };
}

function compileEntity(
  worldSpec: Readonly<WorldSpec>,
  input: Readonly<CompilableEntity>,
  sourceHash: string,
): RobloxManagedNode {
  const { entity, directive } = input;
  const common = {
    id: entity.id,
    entityKind: entity.kind,
    name: entity.name,
    ...(entity.parentId === undefined ? {} : { parentId: entity.parentId }),
    attributes: managedAttributes(worldSpec, entity, sourceHash),
  } as const;

  if (directive.mode === 'container') {
    return {
      ...common,
      className: directive.className,
      properties: {},
    };
  }

  // collectDirectives reports these omissions before this function can be reached.
  const transform = entity.transform;
  const bounds = entity.bounds;
  if (transform === undefined || bounds === undefined) {
    throw new TypeError('Validated primitive compilation state is incomplete.');
  }
  const properties = {
    position: { ...transform.position },
    rotationEulerDegreesXYZ: { ...transform.rotationEulerDegrees },
    size: {
      x: bounds.size.x * transform.scale.x,
      y: bounds.size.y * transform.scale.y,
      z: bounds.size.z * transform.scale.z,
    },
    anchored: true as const,
    material: directive.material,
    color: { ...directive.color },
    transparency: directive.transparency,
    canCollide: directive.canCollide,
    canQuery: directive.canQuery,
    canTouch: directive.canTouch,
    castShadow: directive.castShadow,
  };

  switch (directive.className) {
    case 'Part':
      return {
        ...common,
        className: 'Part',
        properties: { ...properties, shape: directive.shape },
      };
    case 'WedgePart':
      return { ...common, className: 'WedgePart', properties };
    case 'CornerWedgePart':
      return { ...common, className: 'CornerWedgePart', properties };
  }
}

function budgetDiagnostics(worldSpec: Readonly<WorldSpec>, instances: number): RobloxDiagnostic[] {
  const diagnostics: RobloxDiagnostic[] = [];
  const limits = worldSpec.budgets.limits;
  if (limits?.instances !== undefined && instances > limits.instances) {
    diagnostics.push(
      diagnostic(
        'compiler.instance_budget_exceeded',
        '/budgets/limits/instances',
        `Compiled instance count ${instances} exceeds the configured limit ${limits.instances}.`,
      ),
    );
  }
  if (limits?.triangles !== undefined) {
    diagnostics.push(
      diagnostic(
        'compiler.budget_not_evaluated',
        '/budgets/limits/triangles',
        'Triangle limits are not evaluated by the primitive compiler because rendered engine geometry is not measured.',
        undefined,
        'warning',
      ),
    );
  }
  if (limits?.textureMemoryMegabytes !== undefined) {
    diagnostics.push(
      diagnostic(
        'compiler.budget_not_evaluated',
        '/budgets/limits/textureMemoryMegabytes',
        'Texture-memory limits are not evaluated by the primitive compiler because engine texture usage is not measured.',
        undefined,
        'warning',
      ),
    );
  }
  return diagnostics;
}

/** Compiles a validated WorldSpec into a pure desired-state Roblox manifest. */
export function compileWorldSpecToRobloxManifest(input: unknown): CompileResult {
  const validation = validateWorldSpec(input);
  if (!validation.valid) {
    return {
      success: false,
      diagnostics: sortDiagnostics(
        validation.diagnostics.map((entry) =>
          diagnostic(
            'compiler.worldspec_invalid',
            entry.path,
            `WorldSpec ${entry.code}: ${entry.message}`,
            entry.relatedId,
          ),
        ),
      ),
    };
  }

  const inputIndexById = new Map(
    validation.value.entities.map((entity, index) => [entity.id, index] as const),
  );
  const worldSpec = normalizeWorldSpec(validation.value);
  const diagnostics: RobloxDiagnostic[] = [];
  const compilable = collectDirectives(worldSpec, inputIndexById, diagnostics);
  const sourceHash = sha256Hex(stringifyWorldSpec(worldSpec));
  const budgetEntries = budgetDiagnostics(worldSpec, worldSpec.entities.length);
  diagnostics.push(...budgetEntries);

  if (hasErrorDiagnostics(diagnostics)) {
    return { success: false, diagnostics: sortDiagnostics(diagnostics) };
  }

  const nodes = compilable.map((entry) => compileEntity(worldSpec, entry, sourceHash));
  const containers = nodes.filter(
    (node) => node.className === 'Folder' || node.className === 'Model',
  ).length;
  const manifest: RobloxManifest = {
    schemaVersion: ROBLOX_MANIFEST_VERSION,
    compilerVersion: ROBLOX_COMPILER_VERSION,
    source: {
      worldSpecSchemaVersion: WORLD_SPEC_VERSION,
      projectId: worldSpec.project.id,
      worldSpecHash: sourceHash,
    },
    target: { service: 'Workspace' },
    rootNodeId: worldSpec.rootEntityId,
    nodes,
    measurements: {
      instances: nodes.length,
      containers,
      primitives: nodes.length - containers,
    },
  };

  return {
    success: true,
    manifest: normalizeRobloxManifest(manifest),
    diagnostics: sortDiagnostics(diagnostics),
  };
}
