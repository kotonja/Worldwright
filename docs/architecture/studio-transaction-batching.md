# Studio transaction batching and reconnectable recovery

## Implemented boundary

Milestone 4 adds a bounded mutation transport beneath the existing verified Roblox transaction
protocol. It reduces the number of Studio MCP mutation calls without changing the complete Roblox
Change Set that a creator reviews and confirms.

The feature remains limited to one exact unsaved local Roblox Studio session in stopped Edit mode.
It does not add Play-mode automation, character navigation, console inspection, visual evaluation,
The Critic, Forge, a plugin, arbitrary Luau, assets, network transports, or published-place
mutation.

```text
validated complete Change Set
  -> compiler preflight and exact base check
  -> canonical compare-and-set Workspace sandbox lease claim
  -> fresh lease-bound exact-base snapshot
  -> deterministic Studio chunk planner
  -> lease-bound fixed apply_chunk program, one execute_luau call per chunk
  -> fresh complete lease-bound snapshot
  -> exact result hash or observation-gated compensation
```

The complete normalized Change Set SHA-256 remains mutation authorization. Chunks are deterministic
transport units, not independently authorizable plans. The exact Studio ID selects the Studio
target, but does not prove that the same unsaved DataModel remains loaded inside it. One private
transaction sandbox lease supplies that additional transport identity for nonempty transactions.

## Ownership of responsibilities

`@worldwright/roblox-compiler` owns behavior that is independent of Studio:

- `progress.ts` validates and classifies a complete observation against an exact Change Set prefix;
- `transaction-engine.ts` owns validation, stale checks, simulation, optional pre-mutation
  preparation and exact-base reread, ordered application, final verification, failure observation,
  admissibility, compensation, and restoration verification;
- `batch-adapter.ts` defines the optional generic multi-operation adapter and batch-planner
  boundary; and
- `transaction.ts` presents compatible sequential and intentional batched entry points backed by the
  same engine.

`@worldwright/studio-mcp-adapter` owns the Studio-specific layer:

- `src/batch/` owns strict batch contracts, normalization, hashing, deterministic chunking, fixed
  program construction, response parsing, and transport counters;
- `src/connection/` owns the exact-session lease and bounded reconnect path;
- the separate sandbox-lease protocol owns canonical Workspace lease records, compare-and-set claim,
  and same-call lease-bound snapshots;
- `src/adapter.ts` maps the generic compiler batch interface to one transaction-local Studio
  transport; and
- `progress-report.ts` and `transport-report.ts` own strict sanitized report values.

The Studio package does not copy the compiler's stale check, simulator, exact-prefix classifier,
compensation planner, or final hash verification.

## Deterministic chunk planner

The planner receives the canonical Change Set operations in their existing create, update, then
delete order. It never reorders or splits one operation. It deep-copies prepared operations and
builds the largest next chunk that satisfies both:

- at most `STUDIO_MCP_MAX_BATCH_OPERATIONS == 32`; and
- at most `STUDIO_MCP_MAX_BATCH_PAYLOAD_BYTES == 3 * 1024 * 1024` canonical UTF-8 bytes.

The existing 4 MiB outer payload bound also applies. One operation that cannot fit a valid chunk
fails before Studio is called. Zero operations produce zero chunks, and the existing 512-operation
transaction limit remains unchanged.

Each chunk ID is the lowercase SHA-256 of a canonical JSON value containing the project ID, complete
Change Set hash, zero-based chunk index, ordered operation IDs, and complete prepared operations.
Repeated planning over equivalent normalized input therefore produces byte-identical requests and
IDs. There are no timestamps, UUIDs, random values, locale-dependent ordering, or object-identity
inputs. The private sandbox lease ID is deliberately excluded, so chunk IDs and shareable hashes do
not reveal or depend on lease material.

The compiler verifies that planner-produced nonempty batches flatten to the exact authorized
operation sequence before applying any batch. The Cliffwatch 400-create fixture is an explicit
call-count test and must plan no more than 16 chunks; with the 32-operation ceiling its canonical
plan is 13 chunks.

## Batch request

The separate batch protocol uses `protocolVersion: "0.1.0"` and `action: "apply_chunk"`. Its strict
request binds:

- project ID;
- complete Change Set hash;
- exact private sandbox lease ID;
- canonical chunk ID and zero-based chunk index; and
- one to 32 strict create, update, or delete operations.

A create carries the complete desired node, its canonical node JSON and hash, and the exact managed
parent state when it has a managed parent. An update carries complete before and after nodes, both
canonical JSON values and hashes, plus exact before- and after-parent states where applicable. A
delete carries its complete before node and canonical JSON/hash.

Prepared batch values cannot carry arbitrary classes, properties, attributes, complete manifests or
Change Sets, credentials, URLs, or Luau. Every operation is also validated through the existing
single-action bridge contract so the class, property, metadata, and parent allowlists do not
diverge. A chunk may target one managed ID only once and must retain canonical create/update/delete
phase order.

## Expected parent-state progression

Parent checks are tied to the expected state established by the transaction, not merely to an ID or
to whatever metadata currently exists in Studio.

Before planning a chunk, the adapter starts from the last independently observed node map. Preparing
operations walks the exact canonical order and updates a private expected map after each prepared
create, update, or delete. A child created later in the same chunk can therefore carry the complete
state of the parent created earlier. The same rule applies across chunk boundaries and to parent
updates or reparenting.

During transport, the authoritative expected map advances only through the exact prefix acknowledged
by a valid response. Any fresh snapshot read replaces it completely. This prevents an unacknowledged
operation or stale parent view from being used as the precondition for a later mutation.

## Fixed batch bridge

`buildStudioBatchBridgeProgram` produces one audited fixed Luau program. The only dynamic insertion
is one schema-validated batch request encoded as an inert deterministic long-bracket JSON literal.
The source is not exported, and callers cannot provide Luau or arbitrary MCP calls.

The program rechecks `PlaceId == 0`, `GameId == 0`, and stopped Edit mode, validates the closed
batch shape defensively, enforces the 32-operation limit, and verifies that the canonical Workspace
sandbox lease exactly matches the request's lease ID, project ID, and Change Set hash before it
processes operations in exact order. A missing, malformed, stale, or mismatched lease performs zero
operations and cannot claim operation-local restoration. It reuses the existing audited create,
update, delete, engine-state, ownership, metadata, parent, and operation-local cleanup/restoration
helpers. Before the operation loop, it builds the exact selected-project managed index once and
passes that chunk-local root and index to the shared action helpers. Each acknowledged create,
update, or delete updates the in-memory root and index, so successful earlier operations are visible
to later operations without crossing unmanaged or foreign-project boundaries.

Before and after each node mutation, the shared helpers verify complete identity, class, name,
direct parent, public ownership attributes, adapter-owned canonical metadata, and all allowlisted
engine properties. Delete and reparent remain blocked by protected descendants. The program stops at
the first failure and attempts only the existing operation-local cleanup or restoration for that
failing operation. It never performs transaction-level rollback.

After every operation has succeeded locally, the program rebuilds the selected-project index once as
an authoritative end-of-chunk observation. It requires the rebuilt root and complete entity-to-
Instance mapping to equal the in-memory index, then verifies every requested create and update in
its complete after state and every requested delete as absent. A mismatch returns failure with local
restoration unproven; only this complete end-of-chunk verification permits a success response.

The batch bridge contains no dynamic property loop, arbitrary `Instance.new`, `loadstring`, numeric
`require`, asset insertion, network call, data-store access, script creation, or
`ChangeHistoryService` call.

## Batch response and framing

Batch output uses its own exact `WORLDWRIGHT_STUDIO_BATCH_V1\n` prefix, one strict JSON object, and
one final newline. The complete framed response remains within the 96 KiB compact bridge-output
bound. The host rejects missing or repeated framing, trailing output, malformed JSON, duplicate
object keys, unknown fields, unsupported versions, oversized values, and any mismatch with the
request.

Both response variants bind the Change Set hash, chunk ID, chunk index, attempted count, applied
count, and completed operation IDs. Completed IDs must equal the exact applied prefix and
`operationsApplied <= operationsAttempted <= requested operations`.

A success response must attempt and apply the complete chunk. A failure may name only the operation
immediately after the completed prefix and records whether its operation-local restoration was
proved. A schema-valid response is transport evidence, never final transaction proof.

## Shared compiler transaction engine

The original `applyRobloxChangeSet` still adapts each operation to a one-operation batch, preserving
the sequential `RobloxAdapter` surface and public `ApplyResult` semantics. The intentional
`applyRobloxChangeSetBatched` entry point accepts a `RobloxOperationBatchAdapter` and exact batch
planner. Both delegate to one shared transaction state machine.

For either strategy the engine:

1. validates and normalizes the Change Set;
2. reads and validates one fresh complete base snapshot;
3. compares the exact base hash before mutation;
4. purely simulates the complete transition;
5. returns a no-op before any mutation when there are zero operations;
6. calls optional adapter-owned pre-mutation preparation for a nonempty transition;
7. reads a fresh prepared complete snapshot and requires the exact original base hash;
8. applies exact ordered batches;
9. reads an independent complete final snapshot; and
10. reports success only when its hash equals `resultSnapshotHash`.

For Studio, preparation reads and compare-and-set claims one canonical sandbox lease. It stores the
claimed record only in the private transaction context. The post-preparation reread is lease-bound;
a changed base, malformed observation, or failed claim attempts zero node operations and no
rollback. Adapters without preparation retain their existing behavior. The no-op path invokes no
preparation, planning, batch, or lease claim.

Public `operationsAttempted` counts node operations, not MCP calls or chunks. A successful batch
response cannot substitute for the final snapshot.

## Certain and uncertain failures

A strict failure response with a valid exact prefix and proven operation-local restoration is a
certain batch failure. Its reported attempted and applied counts bound the compiler's subsequent
observation.

The outcome is uncertain when no trustworthy exact response exists, including a timeout, rejected
call, closed process, deliberately discarded acknowledgment, malformed or mismatched response, or
unproven local restoration. In that case the transaction conservatively counts every node operation
submitted in the unresolved chunk as attempted. It does not retry the chunk.

The host cross-checks `localRestoreSucceeded` against the response shape and diagnostic. A
post-chunk verification failure or a cleanup, restore, delete, or response-integrity failure cannot
claim proven local restoration; contradictory evidence is itself uncertain.

Both failure classes lead to a fresh snapshot. Only uncertain Studio transport additionally poisons
the old MCP client and requires a new observation connection.

## Client poisoning, exact Studio selection, and DataModel lease

One `StudioExactSessionLease` owns the private exact Studio ID and the current local-stdio client.
After an uncertain mutation it marks the connection as needing recovery, records one uncertainty
event, poisons the client, and closes its owned process tree. No later tool call may use that
client. Process-tree termination is part of the trust boundary: if bounded close fails or times out,
termination is unproven and the lease refuses to start or trust a replacement, so no automatic
recovery observation or compensation follows.

The next required snapshot may create a replacement client. Before it becomes trusted, the lease:

1. starts a new default local-stdio MCP process;
2. rediscovers and validates required capabilities;
3. lists connected sessions;
4. finds and selects the exact original Studio ID;
5. confirms the selection;
6. probes Studio again; and
7. requires unsaved IDs and stopped Edit mode.

It never substitutes a same-named session or the only remaining session. If the exact ID is absent,
tools are incompatible, Studio is published or running, or the bound is exhausted, recovery stops
without compensation. At most two reconnect attempts are available to a transaction: one after an
uncertain forward call and one after an uncertain compensating call.

Every rejected candidate is closed before another attempt. If that bounded close cannot prove the
candidate process tree terminated, the lease remembers the unproven lane and permanently refuses
further replacement or recovery.

That connection/session object is separate from the transaction-scoped Workspace sandbox lease.
Exact Studio reselection proves which Studio target receives a call; it does not prove which unsaved
DataModel is currently loaded there. For every nonempty transaction, the adapter claims a strict
canonical `WorldwrightStudioSandboxLeaseJson` record containing a cryptographically random lease ID,
project ID, and complete Change Set hash. Claim compares the exact previously read canonical record
or explicit absence, writes once, and verifies exact readback. The record remains after completion
and the next nonempty transaction rotates it; there is no clear, force, adopt, or cleanup action.

After reconnect steps 1 through 7, recovery verifies the original transaction lease and reads the
complete compact project snapshot together in one fixed `bound_snapshot` call. It never checks the
lease in one Studio call and snapshots in another. If the same Studio ID now exposes another unsaved
DataModel with an absent, malformed, or different lease, project, or Change Set, recovery stops
failed-unrestored with zero compensation mutations. It never classifies that replacement state as
the original base.

## Exact-prefix classification

`classifyRobloxChangeSetProgress(base, observed, changeSet)` is pure, accepts `unknown`, does not
mutate inputs, and returns `base`, `prefix`, `complete`, or `unsafe` with deterministic diagnostics.
It validates and normalizes all three values, proves scope and base-hash agreement, requires exact
unmanaged-root equality, and runs one complete preflight simulation.

The classifier builds base, observed, operation, and expected-node maps. It computes one initial
mismatch count, then applies each operation to the expected map in order and updates that count only
for the operation's target ID. A zero mismatch identifies the exact prefix. It does not serialize or
resimulate a complete snapshot for every prefix and uses iterative contract hierarchy validation
rather than hierarchy-depth recursion. After bounded normalization and sorting, classification uses
linear map construction plus constant-time mismatch work per operation.

`unsafe` covers malformed input, stale base, project or target mismatch, changed unmanaged roots,
invalid operation preconditions, arbitrary subsets, skipped or reordered effects, third-state
targets, and unrelated managed additions, edits, or deletions.

## Conservative compensation

Version `0.1.0` does not resume a forward transition after uncertainty:

| Fresh classification | Recovery behavior                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `base`               | Report the original transaction failed; apply no compensation.                                                             |
| `prefix`             | Require the prefix not to exceed the attempted envelope, plan back to base, and verify the exact base hash.                |
| `complete`           | Treat the full result as an admissible prefix, report forward failure, compensate to base, and verify the exact base hash. |
| `unsafe`             | Apply zero compensation mutations and report unsafe failure.                                                               |

The compiler first cross-checks compensation against its pure safe snapshot-transition plan, then
executes the exact inverse of the observed forward prefix in reverse order. Every acknowledged or
partially applied compensation operation therefore produces a shorter exact forward prefix rather
than an arbitrary subset. Compensation uses the same shared transaction machinery and deterministic
Studio chunk transport. An uncertain compensation may consume the second bounded reconnect,
re-observe, and replan only when the observed state remains causally admissible and is a strictly
shorter forward prefix. Zero observed progress would produce the same uncertain chunk, so it fails
unrestored instead of retransmitting. Restoration is never inferred from operation responses; it
requires a complete snapshot equal to the original base hash.

## Progress and transport reports

The read-only `progress` CLI reads a fresh snapshot and emits the strict Studio Progress Report
`0.1.0`. Authoritative recovery classification requires the exact Studio ID, private
`--sandbox-lease-id`, reviewed base snapshot file, and Change Set file. It verifies the lease and
reads the snapshot together through `bound_snapshot`; the lease is never printed or placed in the
Progress Report. The Change Set contains only the base hash, so the base document is needed for
exact-prefix classification. Base, prefix, and complete return exit code 0, unsafe domain state
returns 1, and usage, I/O, MCP, Studio, or tool failure returns 2.

The separate Studio Transport Report `0.1.0` records deterministic forward and compensation counts:
planned, attempted, and applied operations; planned, attempted, and completed chunks; mutation
execute calls; sandbox lease claim calls; uncertainty events; reconnect attempts and successes; and
final outcome. No-op evidence records zero sandbox lease claims. Lease-bound activity records one
claim for the complete transaction, including reconnect and compensation; it never rotates or
reclaims the lease. Mutation execute calls count forward and compensation batches and exclude the
claim call. Normally that count equals attempted forward plus compensation chunks. A
`failed-unrestored` compensation-time lease rejection may add exactly one execute call without an
attempted compensation chunk: the fixed call occurred, but its lease guard blocked all node
operations before compensation began. The report exposes no lease ID, lease record, Workspace lease
attribute contents, timestamp, Studio ID, place name, path, raw MCP message, Luau, image,
environment value, username, or credential. The closed Studio Apply Receipt `0.1.0` remains
unchanged.

Report bounds include the two permitted recovery observations. After an uncertain compensation,
definitely acknowledged inverse operations shrink the causal envelope and only the unresolved batch
of at most 32 operations may remain. The strict contract therefore permits at most 544 compensation
operation attempts, reported applications, or chunk attempts and 1,056 total mutation calls. These
are evidence-counter bounds, not permission to exceed the 512-operation Change Set or to retry an
uncertain chunk. `applied` and `noop` reports forbid recovery evidence, `failed-unsafe` forbids
compensation calls, and reconnect attempts cannot exceed recorded uncertainty events. Applied
evidence also proves a feasible nonempty chunk count between `ceil(operationsPlanned / 32)` and
`operationsPlanned`.

## Limits

| Resource                       |            Limit |
| ------------------------------ | ---------------: |
| Complete Change Set            |   512 operations |
| One batch                      |    32 operations |
| Canonical batch request        |            3 MiB |
| Outer bridge payload           |            4 MiB |
| Framed compact bridge response |           96 KiB |
| Batch tool call                |       45 seconds |
| Reconnects per transaction     |                2 |
| Managed project                |      2,048 nodes |
| Workspace structural scan      | 65,536 Instances |
| One canonical node state       |          256 KiB |

All preexisting Studio process, result, viewport, name, and shutdown limits continue to apply.

## Live evidence

Ordinary tests use fake MCP clients and require no Studio installation. Separate live acceptance
must use one fresh unsaved stopped sandbox and the exact Studio ID, and must report actual
node-operation, chunk, mutation-call, sandbox-lease-claim, and reconnect counts. The Cliffwatch
create transition is successful only after the expected and observed complete snapshot hashes match;
planned chunks alone do not prove call reduction.

The live sequence also proves no-op, one harmless update and inverse repair, and a testing-only lost
acknowledgment that forces a new connection, exact-prefix observation, conservative compensation,
and exact base restoration. The reconnect observation must verify the original lease and return the
snapshot in one fixed call. Viewport capture is evidence only, not a visual-quality claim.

All files remain ignored and untracked under `.worldwright/live-milestone-4/`. Shareable summaries
exclude Studio ID, place name, paths, raw messages, Luau, stderr, image bytes, machine data, lease
identifiers, lease JSON, and prior Workspace attribute contents. They may state only that claim,
reconnect reverification, or safe mismatch blocking succeeded.

## Future boundaries

An automatic-resume protocol may later use exact-prefix classification, but it requires separate
review and versioning. Milestone 4 always restores after uncertain forward progress.

The sandbox lease is not authentication, a digital signature, creator authorization, permanent
Roblox identity, or a replacement for exact Studio selection or complete snapshot hashes. No
published-place path exists.

Playtest observation may later enter a running data model under a different authorization and
evidence contract. Character traversal, console inspection, gameplay assertions, collision and
visual critique, and The Critic are not implemented by batching or by the viewport evidence path.

See [ADR 0005](../adr/0005-chunk-studio-mutations-and-recover-by-observation.md), the
[Studio MCP Adapter 0.2 reference](../studio-mcp-adapter/0.2.0.md), and the
[recovery runbook](../studio-mcp-adapter/recovery.md).
