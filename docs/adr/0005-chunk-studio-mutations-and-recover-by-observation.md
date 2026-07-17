# ADR 0005: Chunk Studio mutations and recover uncertain transport by observation

- **Status:** Accepted
- **Date:** 2026-07-16

## Context

Milestone 3 proved that Worldwright can select one exact Roblox Studio session, reject published or
running places, reconstruct managed state, preserve unmanaged ownership boundaries, apply fixed
allowlisted mutations, verify the complete result, and compensate an admissible failure. Its live
Cliffwatch acceptance created 400 managed nodes successfully and remains accepted.

That acceptance also exposed a transport limitation. Adapter `0.1.0` sent one privileged
`execute_luau` request for each node mutation. Two separate bounded attempts encountered
intermittent Studio MCP timeouts during the resulting 400-call phase. Partial managed state remained
observable, and Worldwright correctly refused to claim rollback through an uncertain connection. A
separately authorized managed-only recovery was required before the successful run.

The failure was therefore neither hidden nor evidence that the Milestone 3 safety model was wrong.
It showed that one call per node creates too many transport failure opportunities and too much
latency for the repeated build, observe, critique, and repair loop Worldwright eventually needs.
Before adding playtesting or The Critic, the mutation lane needs fewer calls and observation-based
recovery after an acknowledgment becomes uncertain.

Director review identified one additional identity boundary. Roblox Studio's connected-instance ID
selects the Studio target, but it is not documented as durable identity for the particular unsaved
DataModel loaded inside that process. The same Studio can replace one unsaved place with another
that also reports zero PlaceId/GameId, stopped Edit mode, and the same display name. Exact-ID
reselection plus the generic sandbox gate therefore cannot by itself prove that recovery observed
the DataModel that received the uncertain mutation.

## Decision

Worldwright adds a separately versioned fixed batch protocol. It partitions the already authorized,
canonically ordered operations of one Roblox Change Set into deterministic chunks and sends each
chunk through one fixed Studio bridge program. A chunk contains at most 32 operations and must fit
the 3 MiB canonical batch-payload limit and the existing 4 MiB outer payload bound. The overall
transaction remains limited to 512 operations.

The complete normalized Change Set and its SHA-256 remain the review and authorization unit. Chunk
IDs, chunk hashes, and individual operation acknowledgments are transport evidence; none grants new
mutation authority. Chunking never reorders, omits, invents, or widens an operation.

The compiler owns generic transaction semantics. Its shared transaction engine performs input
validation, a fresh base read, stale rejection, pure simulation, ordered execution, final snapshot
verification, admissibility checking, compensation planning, and exact restoration verification for
both sequential and batch adapters. The Studio package owns only its fixed batch encoding, MCP
connection lifecycle, exact-session lease, Studio-specific transport, and sanitized transport
reporting.

### Bind each nonempty transaction to one unsaved DataModel

Every nonempty authorized Studio transaction claims one private adapter-owned sandbox lease stored
as strict canonical JSON in the fixed `Workspace` attribute `WorldwrightStudioSandboxLeaseJson`. The
record binds a cryptographically random transaction lease ID to the project ID and complete
normalized Change Set hash. It is not a WorldSpec entity, managed node, Manifest, Scene Snapshot,
Change Set, receipt, report identity, or creator-facing object.

Claim occurs only after Change Set validation, the fresh exact-base check, and complete pure
simulation, and only after the engine has ruled out a no-op. The fixed claim program reads the prior
state, compares it byte-for-byte with the expected valid canonical record or explicit absence,
writes the new canonical record once, and reads it back for exact verification. A competing
claimant, malformed prior record, published or running place, or changed prior value fails closed. A
successful record remains on Workspace after the transaction; the next nonempty transaction rotates
it through the same compare-and-set. There is no uncertain cleanup or clear action. A verified no-op
performs zero lease claims and zero mutation calls.

The compiler's optional preparation hook establishes this adapter-owned boundary after preflight,
then requires a second complete lease-bound snapshot with the exact original base hash before the
first batch. Every forward batch, final verification, failure observation, compensation batch,
reconnect observation, and post-compensation verification uses the same lease. The complete Change
Set hash remains the mutation authorization unit; the lease is only private transport evidence.

The lease is not authentication, a digital signature, permanent Roblox object identity, a
replacement for exact Studio selection or snapshot hashes, or creator approval. Its identifier and
JSON are excluded from receipts, Progress Reports, Transport Reports, CLI output, fixtures, PR text,
and shareable live summaries.

### Batch acknowledgments are not final proof

A schema-valid success response proves only what the fixed program reports about that tool call. It
does not prove the complete transaction result. Worldwright advances its expected in-transaction
state only through the exact acknowledged operation prefix and still reads a fresh complete Studio
snapshot after all chunks. Success requires that snapshot to equal the Change Set's exact
`resultSnapshotHash`; the desired-manifest relationship remains established by compiler preflight.

### Uncertain clients are poisoned

A timeout, rejected or closed call, missing acknowledgment, malformed or mismatched response, or a
failure whose operation-local restoration is not proven leaves the mutation outcome uncertain. The
client that carried that privileged call is poisoned and closed. No later tool, including a
snapshot, is sent through it, and the uncertain chunk is never retried blindly.

The next recovery observation may establish a new local-stdio MCP connection. It must rediscover
compatible tools, find and select the exact original Studio ID, verify that ID became active, and
re-probe `PlaceId == 0`, `GameId == 0`, and stopped Edit mode. It must then verify the exact
original sandbox lease and obtain the complete selected-project snapshot together in one fixed
`bound_snapshot` operation. Display name, focus, active status, list order, or there being one
remaining session cannot substitute for the exact ID; the exact ID and generic sandbox facts cannot
substitute for the lease-bound DataModel observation. Reconnection is bounded to two attempts per
transaction.

### Fresh observation is authoritative

After a certain or uncertain failure, a fresh complete lease-bound snapshot is compared with the
original base and the complete canonical Change Set. A missing, malformed, or different lease,
project, or Change Set blocks snapshot classification and all compensation, producing an unrestored
failure rather than evidence from a replacement DataModel. The pure classifier accepts only a state
exactly equal to:

- the base snapshot at prefix length zero;
- one exact ordered operation prefix; or
- the complete desired result at the full prefix length.

It rejects arbitrary subsets, skipped or reordered operations, third states, unrelated managed
additions, edits or deletions, changed unmanaged-root boundaries, scope mismatch, and invalid
hierarchy. Exact-prefix classification is necessary because an attempted-call count alone does not
establish which effects reached Studio, while looser before-or-after envelopes can admit states that
were not produced by canonical execution.

### Recovery is conservative in version 0.1

Version `0.1.0` never automatically resumes a forward transaction after an uncertain response. If
the observation is the base state, the original transaction fails without compensation. If it is an
exact nonzero prefix, the compiler plans compensation from that observed state to the original base.
If it is the complete desired result after acknowledgment loss, Worldwright still reports the
original transaction as failed and compensates the full prefix to the base. The creator may rerun
the complete reviewed Change Set explicitly after restoration.

This policy avoids silently continuing work whose transport acknowledgment was lost. Resume
semantics would require a separately reviewed contract that explains renewed authorization,
remaining-operation preconditions, and evidence.

Compensation is allowed only within the conservative attempted-operation envelope. Any unrelated
managed or unmanaged change makes causality unsafe, so Worldwright performs zero compensating
mutations and reports failure. Compensation is successful only after a complete fresh snapshot hash
equals the exact original base hash.

### ChangeHistoryService remains deferred

The MCP bridge is not a plugin and does not call `ChangeHistoryService`. Studio undo history is not
transaction isolation and cannot replace stale checks, complete observations, prefix classification,
or exact verification. A future Forge plugin may add creator-facing history around an already safe
transaction boundary.

## Alternatives considered

### Keep one MCP call per node

Rejected as the default live path. It is simple and remains supported through the sequential
compiler adapter, but the two bounded 400-call timeout attempts show that it is insufficient for
normal iterative world building.

### Authorize each chunk separately

Rejected. Chunk boundaries are a transport detail and can change with safe bounds or encoding.
Review must remain attached to the complete desired transition, not to an implementation-specific
partition.

### Trust a successful batch response as transaction completion

Rejected. The response covers one call and can be incomplete, malformed, lost, or inconsistent with
actual engine state. Independent complete snapshot verification remains mandatory.

### Retry a timed-out chunk

Rejected. The first call may have applied none, some, or all of its operations. Repeating it without
observation can violate create and before-state preconditions and obscure causality.

### Continue using a poisoned client for observation

Rejected. A transport that lost a privileged mutation acknowledgment cannot provide an independent
recovery observation. A new process and exact-session revalidation are required.

### Reconnect to the only visible or similarly named Studio

Rejected. Window names and list position are not mutation authority. Only the exact original Studio
ID preserves selection intent, and even that ID plus a renewed sandbox probe is insufficient
DataModel identity. Recovery additionally requires the original transaction lease and snapshot in
one fixed bound operation.

### Treat the Studio ID as durable unsaved-place identity

Rejected. The Studio ID identifies a connected Studio instance, not a guaranteed permanent identity
for whichever unsaved DataModel it currently contains. A same-ID replacement place must fail before
classification or compensation when its private lease is absent or different.

### Automatically resume from an exact prefix

Deferred. Exact-prefix classification supplies the technical foundation, but version `0.1.0` chooses
deterministic restoration and explicit rerun over implicit continuation.

### Accept complete desired state after response loss as success

Rejected for version `0.1.0`. The original transport outcome remains uncertain, so conservative
recovery treats the full result as an admissible completed prefix and restores the base.

### Compensate any state that looks close to the base or result

Rejected. Similarity is not causal proof. Unrelated changes must block Worldwright from overwriting
creator or competing-client work.

### Use one unbounded Luau transaction

Rejected. An unbounded payload and execution window would make failure localization, response
evidence, and resource control worse. Deterministic bounded chunks preserve explicit limits.

### Use ChangeHistoryService for rollback

Deferred. It requires a plugin-security context and cannot establish the compiler's canonical
snapshot or transaction invariants.

## Consequences

### Positive

- Hundreds of ordered node operations require a small bounded number of mutation tool calls.
- The complete Change Set remains the stable authorization and audit boundary.
- Sequential and batch adapters share validation, simulation, verification, and compensation
  semantics.
- Recovery decisions are based on a fresh complete observation from a newly trusted connection.
- Every nonempty transaction is bound to one unsaved DataModel across initial revalidation, forward
  mutation, final verification, reconnect, and compensation.
- Lease mismatch blocks recovery before a replacement place can be mistaken for a restored base.
- Exact-prefix classification distinguishes admissible transaction effects from unrelated edits.
- Lost acknowledgments cannot silently become retries or successful forward completion.
- Strict deterministic transport reports record calls, chunks, uncertainty, reconnects, and
  compensation without exposing Studio identity or raw MCP data.

### Costs and constraints

- The fixed batch program and strict request/response contracts add an independently versioned
  security boundary.
- Batch payload construction must carry complete before/after and parent state, increasing request
  size.
- A response loss after a fully successful forward transition intentionally causes compensation and
  requires an explicit rerun.
- Recovery requires the exact Studio session to remain connected, unsaved, and stopped.
- Concurrent creator or tool edits can make compensation inadmissible and leave manual recovery for
  the creator.
- Reconnection is bounded and may fail instead of searching for a substitute session.
- The canonical lease persists after completion and must be rotated by compare-and-set for the next
  nonempty transaction; this is deliberate private transport metadata on the unsaved Workspace.
- Live acceptance must report actual mutation-call counts; chunk planning alone is not proof.

## Versioning implications

The package version advances to `0.2.0`, while persisted
`WorldwrightStudioAdapterVersion == "0.1.0"` keeps its Milestone 3 meaning. Existing managed nodes
remain readable and need no metadata rewrite.

The published Studio bridge request/response and Studio Apply Receipt contracts remain `0.1.0` and
unchanged. Chunking adds separate strict contracts:

- `urn:worldwright:studio-batch-request:0.1.0`
- `urn:worldwright:studio-batch-response:0.1.0`
- `urn:worldwright:studio-sandbox-lease-record:0.1.0`
- `urn:worldwright:studio-sandbox-lease-request:0.1.0`
- `urn:worldwright:studio-sandbox-lease-response:0.1.0`
- `urn:worldwright:studio-progress-report:0.1.0`
- `urn:worldwright:studio-transport-report:0.1.0`

WorldSpec, Roblox directive, Manifest, Scene Snapshot, Change Set, architecture directives, and
Architecture Plan `0.1.0` contracts remain unchanged. Any future automatic-resume behavior requires
an explicit new recovery contract and may not reinterpret batch protocol `0.1.0`.
