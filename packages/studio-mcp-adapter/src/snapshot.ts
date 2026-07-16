import {
  normalizeRobloxSnapshot,
  validateRobloxSnapshot,
  type RobloxManagedNode,
  type RobloxSnapshot,
} from '@worldwright/roblox-compiler';

import { STUDIO_MCP_MAX_MANAGED_NODES } from './constants.js';
import { StudioAdapterError, studioDiagnostic } from './diagnostics.js';
import { verifyStudioRawNode } from './engine-state.js';
import type { StudioRawSnapshot } from './types.js';
import { deriveUnmanagedRoot } from './unmanaged.js';

export function snapshotFromStudioRaw(
  raw: Readonly<StudioRawSnapshot>,
  expectedProjectId: string,
): RobloxSnapshot {
  if (raw.projectId !== expectedProjectId) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.project_mismatch',
        '/projectId',
        'Studio snapshot project does not match the requested project.',
        { relatedId: expectedProjectId },
      ),
    ]);
  }
  if (raw.nodes.length > STUDIO_MCP_MAX_MANAGED_NODES) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.node_limit_exceeded',
        '/nodes',
        `Studio snapshot exceeds ${STUDIO_MCP_MAX_MANAGED_NODES} managed nodes.`,
      ),
    ]);
  }

  const nodes: RobloxManagedNode[] = raw.nodes.map((node) => verifyStudioRawNode(node));
  const rootCandidates = nodes.filter((node) => node.parentId === undefined);
  if (nodes.length > 0 && rootCandidates.length !== 1) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.root_invalid',
        '/nodes',
        'A non-empty managed project must contain exactly one Workspace root.',
      ),
    ]);
  }
  const root = rootCandidates[0];
  if (
    root !== undefined &&
    (root.className !== 'Folder' || root.entityKind !== 'world') &&
    (root.className !== 'Model' || root.entityKind !== 'world')
  ) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.root_invalid',
        `/nodes/${root.id}`,
        'The managed root must be a world Folder or Model directly under Workspace.',
        { relatedId: root.id },
      ),
    ]);
  }

  const candidate: unknown = {
    schemaVersion: '0.1.0',
    projectId: expectedProjectId,
    target: { service: 'Workspace' },
    ...(root === undefined ? {} : { rootNodeId: root.id }),
    nodes,
    unmanagedRoots: raw.unmanagedRoots.map((entry) => deriveUnmanagedRoot(entry)),
  };
  const validation = validateRobloxSnapshot(candidate);
  if (!validation.valid) {
    throw new StudioAdapterError(
      validation.diagnostics.map((entry) =>
        studioDiagnostic(
          entry.code.includes('unmanaged')
            ? 'studio.unmanaged_content_protected'
            : 'studio.snapshot_invalid',
          entry.path,
          `${entry.code}: ${entry.message}`,
          entry.relatedId === undefined ? {} : { relatedId: entry.relatedId },
        ),
      ),
    );
  }
  return structuredClone(normalizeRobloxSnapshot(validation.value));
}
