import { ROBLOX_SNAPSHOT_VERSION } from './contract-schema.js';
import { validateRobloxSnapshot } from './contract-validation.js';
import { jsonValuesEqual } from './json.js';
import { normalizeRobloxManagedNode, normalizeRobloxSnapshot } from './normalize.js';
import type {
  RobloxAdapter,
  RobloxAdapterScope,
  RobloxManagedNode,
  RobloxSnapshot,
  RobloxTarget,
  RobloxUnmanagedRoot,
} from './types.js';

export type InMemoryRobloxFaultAction = 'throw-before' | 'throw-after' | 'skip';

/** One-shot fault selected by the one-based global adapter mutation attempt. */
export interface InMemoryRobloxFault {
  readonly attempt: number;
  readonly action: InMemoryRobloxFaultAction;
  readonly message?: string;
}

export interface InMemoryRobloxAdapterOptions {
  readonly initialSnapshots?: readonly RobloxSnapshot[];
  readonly faults?: readonly InMemoryRobloxFault[];
}

export type InMemoryRobloxMutationType = 'create' | 'update' | 'delete';
export type InMemoryRobloxMutationOutcome =
  | 'applied'
  | 'skipped'
  | 'threw-before'
  | 'threw-after'
  | 'rejected';

export interface InMemoryRobloxMutationAttempt {
  readonly attempt: number;
  readonly type: InMemoryRobloxMutationType;
  readonly nodeId: string;
  readonly projectId: string;
  readonly target: RobloxTarget;
  readonly outcome: InMemoryRobloxMutationOutcome;
}

interface MutableMutationAttempt {
  attempt: number;
  type: InMemoryRobloxMutationType;
  nodeId: string;
  projectId: string;
  target: RobloxTarget;
  outcome: InMemoryRobloxMutationOutcome;
}

interface SceneState {
  readonly projectId: string;
  readonly target: RobloxTarget;
  rootNodeId: string | undefined;
  nodesById: Map<string, RobloxManagedNode>;
  readonly unmanagedRoots: RobloxUnmanagedRoot[];
}

function scopeKey(scope: Readonly<RobloxAdapterScope>): string {
  return `${scope.projectId}\u0000${scope.target.service}`;
}

function cloneUnmanagedRoots(roots: readonly RobloxUnmanagedRoot[]): RobloxUnmanagedRoot[] {
  return roots.map((root) => ({
    snapshotId: root.snapshotId,
    parentNodeId: root.parentNodeId,
    name: root.name,
  }));
}

function stateFromSnapshot(snapshot: Readonly<RobloxSnapshot>): SceneState {
  const normalized = normalizeRobloxSnapshot(snapshot);
  return {
    projectId: normalized.projectId,
    target: { service: 'Workspace' },
    rootNodeId: normalized.rootNodeId,
    nodesById: new Map(normalized.nodes.map((node) => [node.id, normalizeRobloxManagedNode(node)])),
    unmanagedRoots: cloneUnmanagedRoots(normalized.unmanagedRoots),
  };
}

function snapshotFromState(state: Readonly<SceneState>): RobloxSnapshot {
  return normalizeRobloxSnapshot({
    schemaVersion: ROBLOX_SNAPSHOT_VERSION,
    projectId: state.projectId,
    target: { service: 'Workspace' },
    ...(state.rootNodeId === undefined ? {} : { rootNodeId: state.rootNodeId }),
    nodes: [...state.nodesById.values()],
    unmanagedRoots: state.unmanagedRoots,
  });
}

function rootNodeIdFor(nodes: ReadonlyMap<string, RobloxManagedNode>): string | undefined {
  let rootNodeId: string | undefined;
  for (const node of nodes.values()) {
    if (node.parentId !== undefined) continue;
    if (rootNodeId !== undefined) return undefined;
    rootNodeId = node.id;
  }
  return rootNodeId;
}

function assertValidCandidate(
  state: Readonly<SceneState>,
  nodesById: Map<string, RobloxManagedNode>,
): SceneState {
  const rootNodeId = rootNodeIdFor(nodesById);
  const candidate: RobloxSnapshot = {
    schemaVersion: ROBLOX_SNAPSHOT_VERSION,
    projectId: state.projectId,
    target: { service: 'Workspace' },
    ...(rootNodeId === undefined ? {} : { rootNodeId }),
    nodes: [...nodesById.values()],
    unmanagedRoots: cloneUnmanagedRoots(state.unmanagedRoots),
  };
  const validation = validateRobloxSnapshot(candidate);
  if (!validation.valid) {
    throw new Error('The requested mutation would produce an invalid managed scene.');
  }
  return stateFromSnapshot(validation.value);
}

function protectedManagedNodeIds(state: Readonly<SceneState>): Set<string> {
  const protectedIds = new Set(state.unmanagedRoots.map((root) => root.parentNodeId));
  const queue = [...protectedIds];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const node = state.nodesById.get(queue[cursor]!);
    if (node?.parentId !== undefined && !protectedIds.has(node.parentId)) {
      protectedIds.add(node.parentId);
      queue.push(node.parentId);
    }
  }
  return protectedIds;
}

function assertScopeAndNodeIdentity(
  state: Readonly<SceneState>,
  scope: Readonly<RobloxAdapterScope>,
  node: Readonly<RobloxManagedNode>,
): void {
  if (
    state.projectId !== scope.projectId ||
    state.target.service !== scope.target.service ||
    node.attributes.WorldwrightProjectId !== scope.projectId ||
    node.attributes.WorldwrightEntityId !== node.id
  ) {
    throw new Error('The managed node does not belong to the selected adapter scope.');
  }
}

function faultError(fault: Readonly<InMemoryRobloxFault>): Error {
  return new Error(fault.message ?? 'Injected in-memory adapter fault.');
}

/** Convenience helper for a deterministic, one-shot mutation fault. */
export function inMemoryRobloxFault(
  attempt: number,
  action: InMemoryRobloxFaultAction,
  message?: string,
): InMemoryRobloxFault {
  return { attempt, action, ...(message === undefined ? {} : { message }) };
}

/**
 * A deterministic test adapter with independent project scopes and a fixed, typed
 * CRUD boundary. This is deliberately not a Roblox Studio adapter.
 */
export class InMemoryRobloxAdapter implements RobloxAdapter {
  readonly #states = new Map<string, SceneState>();
  readonly #faults = new Map<number, InMemoryRobloxFault>();
  readonly #mutationLog: MutableMutationAttempt[] = [];
  #mutationAttempts = 0;
  #snapshotReads = 0;

  public constructor(options: Readonly<InMemoryRobloxAdapterOptions> = {}) {
    for (const snapshot of options.initialSnapshots ?? []) {
      const validation = validateRobloxSnapshot(snapshot);
      if (!validation.valid) {
        throw new TypeError('An initial in-memory adapter snapshot is invalid.');
      }
      const state = stateFromSnapshot(validation.value);
      const key = scopeKey(state);
      if (this.#states.has(key)) {
        throw new TypeError('Initial snapshots must use unique project scopes.');
      }
      this.#states.set(key, state);
    }

    for (const fault of options.faults ?? []) {
      if (!Number.isSafeInteger(fault.attempt) || fault.attempt < 1) {
        throw new TypeError('Fault attempts must be positive safe integers.');
      }
      if (this.#faults.has(fault.attempt)) {
        throw new TypeError('Fault attempts must be unique.');
      }
      this.#faults.set(fault.attempt, { ...fault });
    }
  }

  /** Returns an independent record of every attempted adapter mutation. */
  public get mutationLog(): readonly InMemoryRobloxMutationAttempt[] {
    return this.#mutationLog.map((entry) => ({
      ...entry,
      target: { service: 'Workspace' },
    }));
  }

  public get mutationAttempts(): number {
    return this.#mutationAttempts;
  }

  public get snapshotReads(): number {
    return this.#snapshotReads;
  }

  /** Replaces one scope without recording a Worldwright mutation, for deterministic concurrency tests. */
  public replaceSnapshotForTesting(snapshot: Readonly<RobloxSnapshot>): void {
    const validation = validateRobloxSnapshot(snapshot);
    if (!validation.valid) {
      throw new TypeError('A replacement in-memory adapter snapshot is invalid.');
    }
    const state = stateFromSnapshot(validation.value);
    this.#states.set(scopeKey(state), state);
  }

  public async readSnapshot(scope: Readonly<RobloxAdapterScope>): Promise<unknown> {
    this.#snapshotReads += 1;
    const state = this.#states.get(scopeKey(scope));
    if (state !== undefined) return snapshotFromState(state);
    return normalizeRobloxSnapshot({
      schemaVersion: ROBLOX_SNAPSHOT_VERSION,
      projectId: scope.projectId,
      target: { service: 'Workspace' },
      nodes: [],
      unmanagedRoots: [],
    });
  }

  public async createNode(
    scope: Readonly<RobloxAdapterScope>,
    node: Readonly<RobloxManagedNode>,
  ): Promise<void> {
    await this.#mutate(scope, 'create', node.id, () => {
      const state = this.#stateForMutation(scope);
      assertScopeAndNodeIdentity(state, scope, node);
      if (state.nodesById.has(node.id)) {
        throw new Error('A managed node with this identity already exists.');
      }
      const nodesById = new Map(state.nodesById);
      nodesById.set(node.id, normalizeRobloxManagedNode(node));
      this.#states.set(scopeKey(scope), assertValidCandidate(state, nodesById));
    });
  }

  public async updateNode(
    scope: Readonly<RobloxAdapterScope>,
    before: Readonly<RobloxManagedNode>,
    after: Readonly<RobloxManagedNode>,
  ): Promise<void> {
    await this.#mutate(scope, 'update', before.id, () => {
      const state = this.#stateForMutation(scope);
      assertScopeAndNodeIdentity(state, scope, before);
      assertScopeAndNodeIdentity(state, scope, after);
      if (before.id !== after.id || before.className !== after.className) {
        throw new Error('A managed update must preserve identity and class.');
      }
      const current = state.nodesById.get(before.id);
      if (current === undefined || !jsonValuesEqual(current, normalizeRobloxManagedNode(before))) {
        throw new Error('The managed update before-state does not match.');
      }
      if (before.parentId !== after.parentId && protectedManagedNodeIds(state).has(before.id)) {
        throw new Error('Unmanaged content prevents reparenting this managed subtree.');
      }
      const nodesById = new Map(state.nodesById);
      nodesById.set(after.id, normalizeRobloxManagedNode(after));
      this.#states.set(scopeKey(scope), assertValidCandidate(state, nodesById));
    });
  }

  public async deleteNode(
    scope: Readonly<RobloxAdapterScope>,
    before: Readonly<RobloxManagedNode>,
  ): Promise<void> {
    await this.#mutate(scope, 'delete', before.id, () => {
      const state = this.#stateForMutation(scope);
      assertScopeAndNodeIdentity(state, scope, before);
      const current = state.nodesById.get(before.id);
      if (current === undefined || !jsonValuesEqual(current, normalizeRobloxManagedNode(before))) {
        throw new Error('The managed delete before-state does not match.');
      }
      for (const node of state.nodesById.values()) {
        if (node.parentId === before.id) {
          throw new Error('Managed children must be deleted before their parent.');
        }
      }
      if (protectedManagedNodeIds(state).has(before.id)) {
        throw new Error('Unmanaged content prevents deleting this managed subtree.');
      }
      const nodesById = new Map(state.nodesById);
      nodesById.delete(before.id);
      this.#states.set(scopeKey(scope), assertValidCandidate(state, nodesById));
    });
  }

  #stateForMutation(scope: Readonly<RobloxAdapterScope>): SceneState {
    const key = scopeKey(scope);
    const existing = this.#states.get(key);
    if (existing !== undefined) return existing;
    const empty = stateFromSnapshot({
      schemaVersion: ROBLOX_SNAPSHOT_VERSION,
      projectId: scope.projectId,
      target: { service: 'Workspace' },
      nodes: [],
      unmanagedRoots: [],
    });
    this.#states.set(key, empty);
    return empty;
  }

  async #mutate(
    scope: Readonly<RobloxAdapterScope>,
    type: InMemoryRobloxMutationType,
    nodeId: string,
    mutation: () => void,
  ): Promise<void> {
    this.#mutationAttempts += 1;
    const attempt = this.#mutationAttempts;
    const record: MutableMutationAttempt = {
      attempt,
      type,
      nodeId,
      projectId: scope.projectId,
      target: { service: 'Workspace' },
      outcome: 'rejected',
    };
    this.#mutationLog.push(record);
    const fault = this.#faults.get(attempt);
    if (fault !== undefined) this.#faults.delete(attempt);

    if (fault?.action === 'throw-before') {
      record.outcome = 'threw-before';
      throw faultError(fault);
    }
    if (fault?.action === 'skip') {
      record.outcome = 'skipped';
      return;
    }

    try {
      mutation();
    } catch {
      record.outcome = 'rejected';
      throw new Error('The in-memory adapter rejected an unsafe mutation.');
    }

    if (fault?.action === 'throw-after') {
      record.outcome = 'threw-after';
      throw faultError(fault);
    }
    record.outcome = 'applied';
  }
}

export function createInMemoryRobloxAdapter(
  options: Readonly<InMemoryRobloxAdapterOptions> = {},
): InMemoryRobloxAdapter {
  return new InMemoryRobloxAdapter(options);
}
