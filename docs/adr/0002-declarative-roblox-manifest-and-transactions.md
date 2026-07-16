# ADR 0002: Use a declarative Roblox manifest and transactional reconciliation

- **Status:** Accepted
- **Date:** 2026-07-15

## Context

WorldSpec records semantic intent, hierarchy, provenance, constraints, locks, and budgets. It is not
a Roblox Instance dump and should not acquire engine-specific mutation commands. At the same time,
future Worldwright integrations need a safe way to turn a supported WorldSpec subset into editable
Roblox-native primitives.

Letting compilation mutate Studio directly would combine several responsibilities: validating
untrusted input, choosing an engine representation, observing mutable state, calculating changes,
performing side effects, and recovering from failure. Such a path would be difficult to review or
replay, could apply a stale decision, and could damage creator-owned descendants when only part of
an operation succeeds.

Milestone 1 therefore needs a deterministic boundary between semantic intent and any future live
Roblox side effect. That boundary must work without Studio so its contracts, safety checks, and
failure behavior can be tested completely in memory.

## Decision

Worldwright uses three strict, versioned Roblox state representations:

1. A **Roblox Manifest** describes the complete desired Worldwright-managed state compiled from one
   WorldSpec document.
2. A **Roblox Scene Snapshot** describes the observed managed state for the selected project and
   records direct unmanaged child roots that must be protected.
3. A **Roblox Change Set** describes the deterministic `create`, `update`, and `delete` operations
   needed to reconcile a particular snapshot to a particular manifest.

The data flow is:

```text
WorldSpec -> pure compilation -> Roblox Manifest
Roblox Manifest + Roblox Scene Snapshot -> pure planning -> Roblox Change Set
Roblox Change Set -> simulation -> adapter transaction -> verified state or verified rollback
```

All four Milestone 1 schemas, including the directive schema, are closed and versioned `0.1.0`
contracts. The manifest and change set contain only allowlisted classes, properties, and managed
attributes. They contain no arbitrary property maps, executable source, asset identifiers, or
content URLs.

### Manifest versus snapshot versus change set

The manifest is desired state and is independent of what is currently in a scene. The snapshot is
observed state and includes ownership evidence that does not come from WorldSpec. The change set is
a dry-run plan tied by hashes to its exact starting snapshot, desired manifest, and expected result.
Keeping these roles separate makes compilation cacheable, plans reviewable, and side effects
conditional on fresh observations. `desiredManifestHash` is an enforced provenance and integrity
link, not descriptive metadata.

### The compiler is pure

Compilation accepts `unknown`, validates WorldSpec and explicit entity directives, and returns a
canonical manifest or structured diagnostics. It does not mutate its input, read a scene, perform
I/O, or call an adapter. Given the same validated WorldSpec, it returns byte-identical output.

This separation prevents a compiler bug or partial engine operation from becoming an implicit
planning decision. It also allows compilation, planning, and simulation to be tested without a
Roblox process.

### Every entity maps to one node in v0.1

Each WorldSpec entity maps to exactly one manifest node with the same stable ID, and the manifest
parent graph mirrors WorldSpec `parentId`. This deliberately simple identity rule makes diffs,
ownership, diagnostics, and reconciliation understandable. One-to-many geometry expansion,
instancing, mesh generation, and asset insertion require later, explicitly versioned compilation
models.

### Directives are explicit

Each compiled entity must contain exactly one strict directive at
`attributes["worldwright.roblox"]`. A directive chooses either a `Folder` or `Model` container, or
an allowlisted `Part`, `WedgePart`, or `CornerWedgePart` primitive and its bounded visual and
collision properties.

The compiler does not infer a class from an entity kind or silently skip an entity. Explicit
directives make unsupported intent fail visibly and keep engine-specific choices out of the closed
WorldSpec entity shape. The WorldSpec `0.1.0` wire contract is unchanged.

### Transforms are world-space in v0.1

Primitive position and XYZ Euler rotation come directly from the entity transform. Final size is the
component-wise product of `bounds.size` and `transform.scale`. Parentage controls organization only;
container transforms do not compose into descendant transforms.

World-space semantics avoid an implicit transform hierarchy in the first compiler contract and make
the desired primitive state directly reviewable. A future local-space model would change meaning and
must be introduced deliberately rather than silently reinterpreting v0.1 data.

### Class changes fail instead of replacing instances

An existing node whose desired `className` differs is a planning conflict. The planner does not
translate that difference into a delete and create under the same ID. Replacement could destroy
descendants, sever creator edits, or obscure a migration that deserves explicit review. A future
class migration must use a new entity ID or a separately specified migration protocol.

### Unmanaged descendants block destructive changes

A snapshot records direct unmanaged child roots beneath managed nodes. Before deleting or
reparenting a managed node, the planner checks that node and all managed descendants for such a
record. If any exists, planning fails with a conflict instead of deleting, cloning, moving,
serializing, or quarantining creator-owned content.

Property-only updates remain eligible when they do not destroy or reparent unmanaged content. An
unmanaged root is protection evidence, not authorization to inspect or modify the full unmanaged
subtree.

### Change-set hashes bind the complete transition

Each change set names the hash of its complete base snapshot, desired manifest, and expected result
snapshot. The full snapshot hash includes unmanaged-root records. Immediately before mutation, the
transaction executor reads and hashes the adapter state; a `baseSnapshotHash` mismatch fails without
calling a mutation method. This optimistic concurrency boundary protects the state boundary before
mutation and prevents a reviewed plan from applying after managed state or protected user-owned
content has changed.

Simulation independently verifies the other two claims. After applying the operations to a value and
validating the result snapshot, it derives a manifest from the non-empty managed result: fixed
schema and compiler versions, project and target from the snapshot, source hash from the root's
`WorldwrightSourceHash`, the snapshot root and managed nodes, and measurements computed from node
classes. The derived manifest must validate, and its canonical hash must equal
`desiredManifestHash`. Unmanaged-root observations are deliberately excluded from desired state. An
empty result, missing or invalid root, or missing root source hash therefore cannot represent a
forward manifest. The independently computed complete snapshot hash must also equal
`resultSnapshotHash`; matching either hash does not substitute for matching the other.

Complete `before` node checks provide a second concurrency guard at each targeted update or delete.
They prevent an operation from proceeding when its target no longer equals the state reviewed in the
plan.

### No-op transactions stop at the preflight boundary

After a fresh snapshot passes validation, the base-hash check, and complete pure simulation, a
zero-operation change set returns `noop` success immediately with that preflight snapshot and hash.
It performs exactly one adapter read, no mutation, no post-apply read, and no rollback. Worldwright
never compensates for a transaction in which it attempted no mutation.

### Rollback is admissible, snapshot-based, and verified

An operation can fail before mutation, after a partial mutation, or by producing an incorrect
observable result. Reversing only the operations that reported success cannot cover all three cases.
On apply or verification failure, the executor therefore observes current state. Before planning or
applying compensation, a rollback admissibility guard compares that observation with the initial
snapshot and the prefix of forward operations whose adapter calls were attempted. Untargeted managed
nodes must be exactly unchanged; an attempted create may be absent or equal its created node; an
attempted update may equal its complete before or after node; and an attempted delete may equal its
before node or be absent. The complete `unmanagedRoots` collection must be exactly unchanged, and
any root-state difference must be explained by an attempted root operation.

Only an observation inside that forward-mutation envelope may be planned back to the exact initial
snapshot. An unrelated managed addition, deletion, or property change, changed unmanaged-root
record, or third state for a targeted node makes causality uncertain. In that case Worldwright makes
no compensating mutation and reports `transaction.rollback_unsafe_observed_state` rather than
overwriting the detected change.

Rollback is successful only if the complete restored snapshot hash equals the original initial
snapshot hash. Failure results report rollback attempt and verification status; they never infer
success from the absence of an exception.

Failure hashes have one meaning each: `observedFailureSnapshotHash` is the valid partial or
incorrect state observed before compensation; `restoredSnapshotHash` is the verified
post-compensation state and equals the initial hash; and `observedAfterRollbackSnapshotHash` is the
latest valid state seen after a failed compensation attempt. Transaction wrappers retain the
underlying diagnostic code in the message and preserve its path and related ID while still
sanitizing adapter errors and validation details.

### Concurrency model and limits

The protocol combines a complete base-snapshot boundary, targeted complete before-state checks, and
the rollback admissibility guard. It does not claim engine-level atomicity or transaction isolation.
A future live adapter should serialize Worldwright transactions within one project scope, and it
must treat creator edits during an asynchronous transaction as a concurrency hazard. When observed
causality is uncertain, Worldwright reports rollback failure rather than overwriting unrelated
state.

### Live Studio mutation is deferred

Milestone 1 defines an asynchronous, allowlisted adapter interface and supplies a deterministic
in-memory implementation for tests. It does not supply a Studio adapter, Forge plugin, Studio MCP
connection, ChangeHistoryService integration, or command that applies a change set to a live place.

A future live adapter must faithfully map the fixed contract to Roblox APIs, scope every operation
to the selected project and `Workspace`, expose current unmanaged-root observations, serialize
Worldwright transactions within that project scope, and preserve the transaction protocol. Creator
edits during an asynchronous transaction remain a concurrency hazard. ChangeHistoryService may
support creator undo in a future integration, but it does not provide or replace transaction
isolation. Live connectivity is a separate trust boundary and requires its own explicit milestone,
tests, and operational safeguards.

## Alternatives considered

### Emit imperative Roblox or Luau commands from the compiler

Rejected. Command streams hide desired state, are harder to diff and validate, encourage arbitrary
property access, and cannot be safely replanned against a fresh observation. Executable source is
outside the WorldSpec and Milestone 1 security boundary.

### Compile directly into a live Studio session

Rejected. This would entangle pure translation with connection state, mutable engine behavior, and
recovery. It would also make deterministic tests depend on an external application.

### Store desired and observed state in one contract

Rejected. Desired state has WorldSpec provenance, while observed state contains concurrency and
ownership evidence. Combining them would blur whether a value was requested or discovered and would
weaken stale-plan checks.

### Emit property-level patches

Rejected for v0.1. Complete before and after nodes make preconditions, review, simulation, and
compensating plans explicit. Fine-grained patches would add more operation variants without
improving the first primitive compiler's safety.

### Recreate nodes automatically when their class changes

Rejected. Silent replacement is destructive and can erase descendants. Class migration needs an
explicit future contract.

### Ignore unmanaged descendants or serialize them for rollback

Rejected. Ignoring them risks data loss; copying them would make Worldwright claim ownership over
user content and would require a much broader Roblox serialization contract.

### Trust an adapter-reported rollback result

Rejected. Observable state is the authority. Both forward application and rollback require a
validated post-operation snapshot and an exact hash match.

## Consequences

### Positive

- Compilation and reconciliation are deterministic, side-effect-free, and independently testable.
- Plans are reviewable before mutation and are protected from stale application.
- Stable semantic IDs survive display-name changes and provide clear managed ownership.
- Creator-owned descendants block destructive operations instead of being silently lost.
- Full-node operations and snapshots make failures and compensating transitions explainable.
- The same narrow adapter interface can support the in-memory test adapter now and separately
  authorized Studio transports later.

### Costs and constraints

- Live integrations must produce a complete, canonical snapshot before applying a plan.
- Snapshot-based rollback requires observing partial state and may itself fail; callers must handle
  that reported outcome.
- Concurrent creator or external managed-state edits can make rollback inadmissible; the safe result
  is a reported rollback failure without compensation.
- One entity per node and world-space transforms limit geometry expressiveness in v0.1.
- Class changes require explicit identity or migration decisions.
- The unmanaged-root marker protects destructive boundaries but does not serialize or understand
  user-owned subtrees.
- Engine-rendered triangle count and texture memory are not measurable offline and are reported as
  unevaluated budget warnings, not passed budgets.

## Versioning implications

The directive, manifest, snapshot, and change-set schemas each have an explicit `0.1.0` version and
version-specific schema ID. Consumers must reject unsupported versions rather than guess or coerce.

Documentation corrections and behavior fixes that preserve accepted shape and meaning may use a
patch release. Backward-compatible additions require a new minor contract version and generated
schema artifact. Removing, narrowing, renaming, or reinterpreting fields, spatial semantics,
ownership rules, operation semantics, or hash inputs requires a major version.

At the time of this decision, the four `0.1.0` compiler contracts were still unmerged. That allowed
the review correction to replace the ambiguous transaction result-hash wording before acceptance
while retaining the draft versions. It changed none of the four JSON wire schemas and required no
migration; subsequent changes follow the compatibility rules above.

WorldSpec remains independently versioned. Milestone 1 consumes WorldSpec `0.1.0` through its public
package API and stores compiler directives in the already-open entity attributes map; it does not
change the WorldSpec wire contract.
