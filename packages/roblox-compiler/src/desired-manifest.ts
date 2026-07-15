import {
  ROBLOX_COMPILER_VERSION,
  ROBLOX_MANIFEST_VERSION,
  ROBLOX_SUPPORTED_WORLD_SPEC_VERSION,
} from './contract-schema.js';
import { validateRobloxManifest, validateRobloxSnapshot } from './contract-validation.js';
import { diagnostic, type RobloxDiagnostic } from './diagnostics.js';
import { normalizeRobloxManifest, normalizeRobloxSnapshot } from './normalize.js';
import type { RobloxManifest } from './types.js';

export type DesiredManifestDerivationResult =
  | {
      readonly success: true;
      readonly manifest: RobloxManifest;
    }
  | {
      readonly success: false;
      readonly diagnostics: readonly RobloxDiagnostic[];
    };

/** Reconstructs desired manifest state from a complete, non-empty desired snapshot. */
export function deriveRobloxManifestFromDesiredSnapshot(
  snapshotInput: unknown,
): DesiredManifestDerivationResult {
  const snapshotValidation = validateRobloxSnapshot(snapshotInput);
  if (!snapshotValidation.valid) {
    return { success: false, diagnostics: snapshotValidation.diagnostics };
  }

  const snapshot = normalizeRobloxSnapshot(snapshotValidation.value);
  if (snapshot.nodes.length === 0 || snapshot.rootNodeId === undefined) {
    return {
      success: false,
      diagnostics: [
        diagnostic(
          'contract.root_invalid',
          '/rootNodeId',
          'A desired manifest must contain exactly one managed root.',
        ),
      ],
    };
  }

  const root = snapshot.nodes.find((node) => node.id === snapshot.rootNodeId);
  const worldSpecHash = root?.attributes.WorldwrightSourceHash;
  if (root === undefined || worldSpecHash === undefined) {
    return {
      success: false,
      diagnostics: [
        diagnostic(
          'contract.metadata_invalid',
          '/rootNodeId',
          'The desired managed root must carry source-hash metadata.',
          snapshot.rootNodeId,
        ),
      ],
    };
  }

  const containers = snapshot.nodes.filter(
    (node) => node.className === 'Folder' || node.className === 'Model',
  ).length;
  const manifest = normalizeRobloxManifest({
    schemaVersion: ROBLOX_MANIFEST_VERSION,
    compilerVersion: ROBLOX_COMPILER_VERSION,
    source: {
      worldSpecSchemaVersion: ROBLOX_SUPPORTED_WORLD_SPEC_VERSION,
      projectId: snapshot.projectId,
      worldSpecHash,
    },
    target: snapshot.target,
    rootNodeId: snapshot.rootNodeId,
    nodes: snapshot.nodes,
    measurements: {
      instances: snapshot.nodes.length,
      containers,
      primitives: snapshot.nodes.length - containers,
    },
  });
  const manifestValidation = validateRobloxManifest(manifest);
  return manifestValidation.valid
    ? { success: true, manifest: manifestValidation.value }
    : { success: false, diagnostics: manifestValidation.diagnostics };
}
