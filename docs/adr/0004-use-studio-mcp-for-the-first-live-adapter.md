# ADR 0004: Use Roblox Studio MCP for the first live adapter

- **Status:** Accepted
- **Date:** 2026-07-15

## Context

Milestones 0 through 2 established a canonical semantic contract, a deterministic architectural
planner, a declarative Roblox Manifest, observed Scene Snapshots, dry-run Change Sets, pure
simulation, and a transaction executor with verified compensation. Those boundaries deliberately
stopped before Roblox Studio. Worldwright now needs its first authorized side-effect boundary so an
already reviewed change set can be applied to an actual Roblox data model and verified from a fresh
observation.

A live adapter is privileged. It chooses a running Studio process, sends executable Luau through a
local tool, reads mutable engine state, and can destroy data if ownership or concurrency checks are
wrong. Merely connecting to Studio cannot weaken the existing compiler contracts. Desired state,
observed state, dry-run transitions, stale-state rejection, unmanaged-root protection, and verified
compensation remain authoritative.

Roblox Studio includes a local MCP server with stdio transport and tools for listing Studio
sessions, selecting one session, inspecting its state, executing Luau in Edit mode, and optionally
capturing the viewport. This creates a usable first integration boundary without adding a Studio
plugin. It also exposes a broad `execute_luau` capability that Worldwright must not pass through to
callers.

## Decision

Worldwright implements `@worldwright/studio-mcp-adapter` version `0.1.0` as its first live Roblox
adapter. The package starts Roblox Studio's built-in MCP server over local stdio, validates the
discovered tool schemas, selects one exact Studio session, applies strict sandbox gates, and
implements the existing compiler `RobloxAdapter` interface through five fixed bridge actions:
`probe`, `snapshot`, `create`, `update`, and `delete`.

The adapter accepts the existing Roblox Manifest, Scene Snapshot, and Change Set contracts. It does
not define an MCP-specific scene model or a parallel transaction protocol. The existing
`applyRobloxChangeSet` executor remains responsible for fresh-snapshot validation, stale rejection,
pure simulation, sequential application, result verification, rollback admissibility, compensation,
and verification of the restored snapshot.

Version `0.1.0` is restricted to an open, unsaved local place where both `game.PlaceId` and
`game.GameId` are zero and Studio is stopped in Edit mode. Mutating commands require the exact
Studio session ID and the complete lowercase SHA-256 hash of the normalized change set. There is no
bypass for a published place, a running data model, or confirmation.

## Why Studio MCP is used before a custom plugin

The built-in Studio MCP server provides a maintained local process boundary and the minimum
capabilities needed to prove the existing adapter protocol against real engine state. Using it first
lets Worldwright validate process lifecycle, tool negotiation, session selection, snapshot fidelity,
ownership protection, engine drift, and compensation without also building and distributing a
plugin, toolbar, widget, permissions UX, or plugin update channel.

This is a sequencing decision, not a claim that MCP replaces Forge. A future Forge plugin may offer
creator-native review, approval, and undo affordances after the underlying transaction boundary has
already proved safe.

## Why stdio only

The adapter starts the documented local Studio MCP executable directly and communicates over its
stdio streams. This keeps the capability on the creator's machine and gives the client explicit
ownership of startup, timeouts, shutdown, and child-process cleanup.

Version `0.1.0` does not support Streamable HTTP, SSE, TCP, remote URLs, registry-discovered
servers, or downloaded server commands. Those transports would add network identity, authentication,
deployment, and remote trust questions that this milestone neither needs nor authorizes.

## Why an exact Studio ID is required for mutation

Process activity, window focus, display names, and list order are not mutation authority. More than
one Studio session may be connected, and the wrong choice could modify an unrelated place. Every
mutating command therefore requires an exact discovered Studio ID, even when only one session is
currently visible. Read-only listing may show sanitized candidates; it never chooses a mutation
target based on an "active" flag.

The Studio ID is private local selection state. The live-smoke runner accepts it only to select and
reselect the intended session, and omits it from its pre-mutation review and shareable summary.
Probe output and strict `0.1.0` receipts may still contain the sanitized ID locally, so those raw
files remain ignored and private; the ID is never committed in fixtures or documentation or copied
into pull-request evidence.

## Why v0.1 is restricted to unsaved local sandboxes

The first live integration must prove correctness without risking cloud or production content.
Mutation and project snapshot extraction require `PlaceId == 0`, `GameId == 0`, and stopped Edit
mode. A read-only probe may describe a non-sandbox session, but snapshot, plan, apply, verify, and
capture workflows for managed project content fail closed outside the sandbox boundary.

There is no `--force`, published-place bypass, or allowlist of production places. Broader place
authorization requires a later contract, creator experience, and operational review.

## Why fixed Luau bridge programs are required

Studio MCP's `execute_luau` tool is broader than Worldwright's authority. The adapter therefore
constructs source only from one audited bridge implementation, a schema-validated JSON payload, and
a deterministic long-bracket literal encoder. Dynamic values remain inert JSON. Class creation,
property writes, and attributes use explicit allowlisted branches rather than identifiers read from
the payload.

The bridge contains no `loadstring`, asset require, network request, data-store access, service
escape hatch, dynamic property setter, or creation of `Script`, `LocalScript`, or `ModuleScript`.
`HttpService:JSONDecode` and `JSONEncode` are used only for local payload framing.

## Why raw `execute_luau` is not exposed

A public arbitrary-Luau API would bypass the compiler allowlists, ownership model, sandbox-specific
actions, stable diagnostics, and transaction executor. It would turn Worldwright into a general
remote code execution client for Studio. The package consequently exports neither an arbitrary
tool-call method nor bridge source constants, and its CLI accepts no Luau text or source file.

The internal MCP client is capability-specific. Its existence is not an authorization boundary for
other tools or clients, and creators should connect only trusted MCP clients to Studio.

## Why snapshot transport is compact and capped at 96 KiB

The built-in Studio MCP has been observed to impose an approximately 100,000-byte ceiling on tool
text. A verbose JSON snapshot can cross that ceiling well before the adapter's independent managed-
node and Workspace-scan limits, causing truncation outside the versioned bridge contract.

Snapshot success therefore uses deterministic sorted dictionaries and fixed numeric tuples for
managed nodes and unmanaged roots. Names use maximal Unicode-scalar-value front-coding; malformed
surrogate sequences are rejected. Repeated identifiers, enums, source hashes, and numbers are
referenced by zero-based indexes, while each node's stored-state SHA-256 is packed in node order as
40 canonical Z85 characters. Explicit `-1` sentinels encode only defined absence cases. The complete
prefixed response plus final newline is capped conservatively at 96 KiB (98,304 bytes). This cap is
stricter than the general host-side MCP-result validation bound.

Compactness is not trust. Before snapshot traversal, the fixed bridge runs three SHA-256 known
vectors and fails closed if its runtime implementation disagrees. Before encoding, Studio computes
SHA-256 over the exact raw state-JSON bytes and compares it with the stored state hash, then
validates the decoded metadata and verifies the actual Instance hierarchy, attributes, class, name,
and allowlisted engine properties. Only those verified canonical node properties enter the compact
response. The host rejects noncanonical dictionaries and ordering, malformed front-coding or Z85,
tuple shapes, sentinels, indexes, class codes, flags, identifiers, hierarchy, roots, or unmanaged
records. It reconstructs each canonical node and requires its Node-computed hash to equal that
node's decoded stored-state hash. Public compiler snapshot normalization and validation run last.
The compact form is private bridge transport and does not replace or alter the public Roblox Scene
Snapshot contract or its hash.

## Why adapter metadata stores canonical node state

Roblox Instances do not natively retain the complete declarative node against which a reviewed
`before` condition was calculated. Each managed instance therefore stores exactly three private
adapter attributes: the adapter version, canonical normalized node JSON, and the lowercase SHA-256
hash of that JSON. Public Worldwright ownership attributes remain unchanged.

This metadata is transport state, not a new compiler contract. It is excluded from Manifests and
Scene Snapshot node attributes. It never stores a WorldSpec, complete manifest, change set, prompt,
reference URL, credential, machine path, or reasoning trace.

## Why actual engine state is verified

Stored metadata alone could become stale after a creator, plugin, or other tool edits the Instance.
Every snapshot and targeted operation therefore compares the stored node with actual `ClassName`,
`Name`, direct parent, public managed attributes, and allowlisted container or primitive properties.
Primitive vectors, colors, and `CFrame` components use a documented small tolerance for engine
conversion; identity, hierarchy, strings, booleans, and enums remain exact.

A mismatch is `studio.engine_state_drift`. Missing or malformed metadata is
`studio.adapter_metadata_invalid`. Neither condition is silently adopted or overwritten.

## Why one MCP mutation call per change operation is accepted temporarily

One fixed `execute_luau` call for each create, update, or delete keeps the first bridge auditable
and aligns failure reporting with the existing ordered operation model. Update operations can
perform and verify their operation-local restoration within the same call before the outer
transaction decides whether full compensation is admissible.

This design has overhead, so `0.1.0` bounds a change set to 512 operations. A future batch protocol
may improve throughput, but it must preserve complete before checks, deterministic attempted-order
reporting, ownership rules, and exact final verification.

## Why unmanaged content remains protected

The adapter observes direct non-project children beneath managed nodes and maps each one to a
structural, session-local snapshot marker. It does not add attributes to, rename, clone, serialize,
reparent, inspect deeply, or destroy unmanaged content. A foreign Worldwright project nested beneath
the selected project is treated as protected content at its first foreign root.

Reparenting or deleting a managed lineage with a protected descendant fails. The live bridge repeats
leaf and ownership checks defensively even though the planner and simulator already enforce them.
Display names never establish managed identity.

## Why published places are forbidden

The first live adapter has no production-place approval model, deployment workflow, cloud backup
contract, or creator-facing recovery UX. Allowing published-place mutation would convert a local
technical proof into a production editing tool without those safeguards. Both nonzero PlaceId and
nonzero GameId fail with `studio.published_place_forbidden`; no override exists.

## Why ChangeHistoryService is deferred

ChangeHistoryService recording APIs require Plugin Security, while the Studio MCP bridge is not a
plugin. The adapter does not call ChangeHistoryService and does not claim Studio undo history as
transaction isolation.

Milestone 3 safety comes from exact snapshots, stale-state and before-state checks, ownership
protection, pure simulation, exact result verification, rollback admissibility, and verified
compensation. A future Forge plugin may wrap an already safe transaction in a history recording, but
that recording cannot replace snapshot verification.

## Why live playtesting and The Critic are separate milestones

Edit-mode mutation proves that declarative state can be materialized and recovered. It does not
prove that a character can traverse the result, interactions work, performance budgets hold in a
running client, or the world looks good. Milestone 3 does not start Play mode, run autonomous
gameplay, score screenshots, interpret references, invoke The Critic, or perform autonomous repair
beyond transaction compensation.

Those capabilities require separate observation and evaluation contracts so evidence is not confused
with a successful state transfer.

## Alternatives considered

### Build Forge as a plugin first

Deferred. A plugin is likely valuable for creator-native review and ChangeHistoryService support,
but it adds distribution, UI, permissions, and lifecycle concerns before the live transaction
mapping itself has been proved.

### Expose Studio MCP as a general tool proxy

Rejected. It would grant arbitrary Studio authority, make tool-schema changes part of the public
API, and bypass Worldwright contracts.

### Generate one large Luau transaction

Deferred. Batching could reduce transport overhead, but the first protocol is easier to audit and
fault-test when each existing change operation maps to one fixed bridge action.

### Trust adapter metadata without reading engine properties

Rejected. Metadata can survive while live properties drift, yielding a false snapshot and unsafe
before checks.

### Support published places with an opt-in flag

Rejected for `0.1.0`. A command-line switch is not a sufficient production authorization and
recovery model.

### Rely on Studio undo for rollback

Rejected. The bridge lacks Plugin Security, creator edits remain concurrent, and undo state is not
the compiler's canonical observed-state contract.

## Consequences

### Positive

- Worldwright gains a real engine boundary without changing WorldSpec or compiler wire contracts.
- Studio selection and place eligibility are explicit and fail closed.
- Fixed programs preserve the compiler's closed class, property, attribute, and operation sets.
- Live snapshots verify actual engine state instead of trusting stored declarations.
- Existing stale-state, simulation, result verification, and compensation behavior remains the
  single transaction authority.
- Unmanaged and foreign-project content remains outside Worldwright's mutation authority.
- Ordinary CI can exercise the complete protocol with a fake MCP client and no Studio installation.

### Costs and constraints

- Live mutation works only in unsaved local Edit-mode sandboxes.
- One MCP round trip per mutation limits throughput.
- Structural unmanaged-root markers are observation-local, not permanent Roblox object IDs.
- Creator edits during an asynchronous transaction can make compensation inadmissible.
- The package depends on the built-in Studio MCP tool surface and must reject incompatible schema
  changes rather than guess.
- Snapshot bridge output is limited to 96 KiB to stay below the built-in MCP's observed tool-text
  ceiling; a project can therefore hit `studio.response_too_large` before the managed-node bound.
- A viewport image is operational evidence only; it is neither committed nor interpreted.

## Versioning implications

The adapter, bridge protocol, and Studio Apply Receipt independently declare version `0.1.0`. The
bridge request, bridge response, and receipt use version-specific draft 2020-12 schema IDs.
Consumers reject unsupported versions and unknown fields.

Documentation or implementation corrections that preserve accepted shape and behavior may use a
patch release. Backward-compatible additions require a new minor contract version. Removing,
renaming, narrowing, or reinterpreting a bridge field, receipt field, action, attribute, selection
rule, engine comparison, ownership rule, payload framing rule, or hash input requires a deliberate
major version.

WorldSpec `0.1.0`, the four Roblox compiler `0.1.0` contracts, and Architecture Planner `0.1.0`
remain independently versioned and unchanged. A future batch bridge or plugin adapter must negotiate
its own version while continuing to consume the existing public compiler transaction boundary.
