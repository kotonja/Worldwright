import {
  hashArchitecturePlan,
  validateArchitecturePlan,
  type ArchitecturePlan,
} from '@worldwright/architecture-planner';
import {
  hashRobloxManifest,
  validateRobloxManifest,
  type RobloxManagedNode,
  type RobloxManifest,
} from '@worldwright/roblox-compiler';

import {
  playtestDiagnostic,
  sortPlaytestDiagnostics,
  type PlaytestValidationResult,
} from '../diagnostic.js';
import type { PlaytestPlanSource } from './contract-schema.js';
import { manifestCorrespondenceDiagnostics } from './manifest-correspondence.js';

export interface BoundPlaytestSource {
  readonly architecturePlan: ArchitecturePlan;
  readonly manifest: RobloxManifest;
  readonly source: PlaytestPlanSource;
}

function nodeMap(manifest: Readonly<RobloxManifest>): ReadonlyMap<string, RobloxManagedNode> {
  return new Map(manifest.nodes.map((node) => [node.id, node] as const));
}

function hasAncestor(
  id: string,
  ancestorId: string,
  nodes: ReadonlyMap<string, RobloxManagedNode>,
): boolean {
  let current = nodes.get(id);
  const seen = new Set<string>();
  while (current !== undefined && current.parentId !== undefined && !seen.has(current.id)) {
    if (current.parentId === ancestorId) return true;
    seen.add(current.id);
    current = nodes.get(current.parentId);
  }
  return false;
}

/**
 * Validates all identity and semantic correspondence available in the closed Plan and Manifest
 * contracts. The two contracts deliberately retain different source WorldSpec hashes (authored
 * source versus emitted source), so both hashes are preserved rather than falsely equated.
 */
export function bindPlaytestSource(
  architecturePlanInput: unknown,
  manifestInput: unknown,
): PlaytestValidationResult<BoundPlaytestSource> {
  const planResult = validateArchitecturePlan(architecturePlanInput);
  if (!planResult.valid) {
    return {
      valid: false,
      diagnostics: [
        playtestDiagnostic(
          'playtest.architecture_plan_invalid',
          '',
          'Architecture Plan validation failed.',
        ),
      ],
    };
  }
  const manifestResult = validateRobloxManifest(manifestInput);
  if (!manifestResult.valid) {
    return {
      valid: false,
      diagnostics: [
        playtestDiagnostic('playtest.manifest_invalid', '', 'Roblox Manifest validation failed.'),
      ],
    };
  }
  const architecturePlan = planResult.value;
  const manifest = manifestResult.value;
  const diagnostics = [];
  if (architecturePlan.source.projectId !== manifest.source.projectId) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.source_project_mismatch',
        '/source/projectId',
        'Architecture Plan and Roblox Manifest project IDs differ.',
      ),
    );
  }
  if (architecturePlan.source.worldSpecSchemaVersion !== manifest.source.worldSpecSchemaVersion) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.source_hash_mismatch',
        '/source',
        'Architecture Plan and Roblox Manifest WorldSpec schema versions differ.',
      ),
    );
  }
  const nodes = nodeMap(manifest);
  const root = nodes.get(manifest.rootNodeId);
  if (
    root === undefined ||
    root.parentId !== undefined ||
    root.attributes.WorldwrightProjectId !== manifest.source.projectId ||
    root.attributes.WorldwrightSourceHash !== manifest.source.worldSpecHash ||
    manifest.target.service !== 'Workspace'
  ) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.source_root_mismatch',
        '/rootNodeId',
        'Roblox Manifest root is missing or parented.',
        manifest.rootNodeId,
      ),
    );
  }
  const building = nodes.get(architecturePlan.source.buildingEntityId);
  if (
    building === undefined ||
    (building.id !== manifest.rootNodeId && !hasAncestor(building.id, manifest.rootNodeId, nodes))
  ) {
    diagnostics.push(
      playtestDiagnostic(
        'playtest.manifest_structure_mismatch',
        '/nodes',
        'The plan building does not resolve beneath the Manifest root as a structure.',
        architecturePlan.source.buildingEntityId,
      ),
    );
  }
  diagnostics.push(...manifestCorrespondenceDiagnostics(architecturePlan, manifest));
  const sorted = sortPlaytestDiagnostics(diagnostics);
  if (sorted.length > 0) return { valid: false, diagnostics: sorted };
  return {
    valid: true,
    value: {
      architecturePlan,
      manifest,
      source: {
        architecturePlanSchemaVersion: architecturePlan.schemaVersion,
        architecturePlannerVersion: architecturePlan.plannerVersion,
        architecturePlanSha256: hashArchitecturePlan(architecturePlan),
        sourceWorldSpecSha256: architecturePlan.source.worldSpecHash,
        projectId: architecturePlan.source.projectId,
        buildingEntityId: architecturePlan.source.buildingEntityId,
        robloxManifestSchemaVersion: manifest.schemaVersion,
        robloxCompilerVersion: manifest.compilerVersion,
        robloxManifestSha256: hashRobloxManifest(manifest),
        manifestSourceWorldSpecSha256: manifest.source.worldSpecHash,
        manifestRootNodeId: manifest.rootNodeId,
        expectedManagedInstanceCount: manifest.measurements.instances,
      },
    },
    diagnostics: [],
  };
}
