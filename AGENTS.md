# Worldwright repository guide

## Mission and vocabulary

Worldwright is an AI World Architect intended to turn human intent and references into coherent,
editable, testable, and performance-aware Roblox worlds. It is a world compiler, not a
text-to-random-parts or text-to-mesh toy.

- **Atlas** is the future reasoning and orchestration layer.
- **WorldSpec** is the versioned, JSON-serializable semantic world contract. Its v0.1 foundation was
  implemented in Milestone 0.
- **Architecture Directive** is the strict planner input stored in the open
  `worldwright.architecture` WorldSpec entity or relationship attribute.
- **Architecture Plan** is the separate, versioned, reviewable spatial contract produced by the
  Milestone 2 offline planner. It is derived from, and integrity-bound to, a canonical WorldSpec.
- **Roblox Manifest** is the complete desired Worldwright-managed Roblox state compiled from a
  WorldSpec document.
- **Roblox Scene Snapshot** is observed managed state for one project and includes markers for
  direct unmanaged child roots.
- **Roblox Change Set** is a deterministic dry-run transition from one exact snapshot to one exact
  desired manifest.
- **The Roblox compiler** is the Milestone 1 offline compiler, reconciler, simulator, transaction
  protocol, and in-memory test adapter. It is not a live Studio integration.
- **The Studio MCP Adapter** is the Milestone 3 local-stdio, unsaved-sandbox, Edit-mode bridge from
  the existing `RobloxAdapter` interface to one exact Roblox Studio session. It is not a general
  Luau or Studio automation API. Milestone 4 adds deterministic chunked mutation and exact-session
  reconnectable observation beneath that same boundary.
- **Studio Batch Protocol** is the separate fixed `apply_chunk` request and response contract. A
  chunk is a transport unit; the complete Roblox Change Set remains the authorization unit.
- **Studio Sandbox Lease** is one private adapter-owned, transaction-scoped canonical JSON attribute
  on Workspace that binds nonempty mutation and recovery calls to the same unsaved DataModel. It is
  transport evidence, not creator authorization, authentication, a signature, permanent Roblox
  identity, a snapshot field, or a managed node.
- **Studio Progress Report** classifies one fresh complete snapshot as the exact base, an exact
  canonical operation prefix, the complete result, or unsafe.
- **Studio Transport Report** is the strict identity-free record of chunk, call, uncertainty,
  reconnect, and compensation counts. It does not replace the Studio Apply Receipt.
- **Studio Apply Receipt** is the strict, sanitized record of an observed Studio transaction
  outcome. It is not mutation authorization, a digital signature, or visual-quality proof.
- **Forge** is the future Roblox Studio creator interface.
- **The Critic** is the future evaluation and localized-repair system.

Do not describe future systems as implemented.

## Sources of truth

- `packages/worldspec/src/schema.ts` is the source for the runtime TypeBox schema and derived static
  types.
- `packages/worldspec/schema/worldspec-0.1.0.schema.json` is generated. Never hand-edit it; use
  `pnpm schema:generate`, then verify with `pnpm schema:check`.
- `packages/roblox-compiler/src/directive-schema.ts` is the source for the Roblox directive schema,
  allowlisted classes, shapes, and materials.
- `packages/roblox-compiler/src/contract-schema.ts` is the source for the Roblox Manifest, Scene
  Snapshot, and Change Set schemas and their schema-derived static types.
- `packages/roblox-compiler/schema/*.schema.json` files are generated. Never hand-edit them; use the
  root schema generation and drift-check commands.
- `packages/roblox-compiler/src/compile.ts`, `reconcile.ts`, `simulate.ts`, `progress.ts`,
  `batch-adapter.ts`, `transaction-engine.ts`, and `transaction.ts` define compiler, planning,
  simulation, exact-prefix classification, sequential/batch adapter boundaries, and shared
  transaction behavior. Safety invariants belong in those package boundaries rather than only in a
  caller or adapter.
- `packages/roblox-compiler/fixtures/worldspec/primitive-courtyard.worldspec.json` is the authored
  fixture input. The corresponding manifest, snapshot, and change-set artifacts are generated;
  update them with `pnpm fixture:generate` and verify them with `pnpm fixture:check`.
- `packages/architecture-planner/src/entity-directive-schema.ts` and
  `relationship-directive-schema.ts` are the sources for strict planner input directives.
- `packages/architecture-planner/src/plan-schema.ts` is the source for the Architecture Plan schema
  and schema-derived static types. The corresponding `packages/architecture-planner/schema/*.json`
  files are generated and must never be hand-edited.
- `packages/architecture-planner/src/source-profile.ts`, `solver.ts`, `walls.ts`, `openings.ts`,
  `stairs.ts`, `circulation.ts`, and `evaluation.ts` define the supported profile, bounded solve,
  geometry, navigation, and semantic invariants. Do not enforce those rules only in a CLI caller.
- `packages/architecture-planner/fixtures/input/cliffwatch-mansion-program.worldspec.json` is the
  authored Milestone 2 input. Its Architecture Plan, derived WorldSpec, manifest, empty snapshot,
  and change set are generated artifacts; update and check them with the root fixture commands.
- Semantic invariants and stable diagnostic behavior belong in the validation layer, not in callers
  or prose-only rules.
- `docs/worldspec/0.1.0.md` documents the published WorldSpec v0.1 contract. Update it with every
  WorldSpec contract or behavior change.
- `docs/roblox-compiler/0.1.0.md` documents the published compiler contracts and behavior. Update it
  with every compiler contract or behavior change.
- `docs/architecture-planner/0.1.0.md` documents the published planner contracts and behavior.
  Update it with every architecture directive, plan, solver, geometry, or emission change.
- `packages/studio-mcp-adapter/src/contract-schema.ts` is the source for the Studio Apply Receipt
  and fixed Studio bridge schemas and their schema-derived static types;
  `src/bridge/protocol-schema.ts` exposes the bridge-specific boundary. Corresponding
  `packages/studio-mcp-adapter/schema/*.schema.json` files are generated and must never be
  hand-edited.
- `packages/studio-mcp-adapter/src/batch/contract-schema.ts` is the source for the strict Studio
  Batch Request and Response schemas. `src/batch/chunk.ts`, `request.ts`, `response.ts`,
  `program.ts`, and `transport.ts` define deterministic partitioning, expected parent-state
  progression, strict framing, fixed program construction, and Studio-specific batch reporting.
- `packages/studio-mcp-adapter/src/sandbox-lease/contract-schema.ts` is the source for the separate
  strict Workspace sandbox-lease record, request, and response schemas. The other files in
  `src/sandbox-lease/` own canonical record validation, compare-and-set claim programs, exact lease
  verification, and same-call bound snapshot construction.
- `packages/studio-mcp-adapter/src/report-contract-schema.ts` is the source for the Studio Progress
  and Transport Report schemas. `progress-report.ts` and `transport-report.ts` define their
  normalization, validation, serialization, and hashing behavior. Keep these contracts separate from
  the closed Studio Apply Receipt `0.1.0`.
- `packages/studio-mcp-adapter/src/mcp/command.ts`, `capabilities.ts`, `session.ts`, and `client.ts`
  define local process resolution, tool discovery, exact Studio selection, and the isolated MCP SDK
  boundary.
- `packages/studio-mcp-adapter/src/connection/session-lease.ts` and `reconnect.ts` define poisoning,
  bounded replacement, exact-ID reselection, and observation-only reconnect behavior.
- `packages/studio-mcp-adapter/src/bridge/program.ts` and the action-specific bridge builders define
  the only fixed Luau programs Worldwright may send: `probe`, `snapshot`, `create`, `update`,
  `delete`, the separately versioned fixed `apply_chunk` composition, and the separate fixed
  sandbox-lease `read_lease`, `claim_lease`, and `bound_snapshot` actions. `program.ts` also defines
  Studio-side raw metadata hashing, decoded-state checks, actual engine verification, and compact
  encoding. Never expose its source or accept caller-supplied Luau.
- `packages/studio-mcp-adapter/src/engine-state.ts`, `snapshot.ts`, and `adapter.ts` define
  host-side canonical metadata hashing, compact transport integrity and reconstruction,
  unmanaged-root observation, compiler snapshot conversion, and the implementation of the compiler
  sequential, optional batch, and optional pre-mutation preparation adapter interfaces. Transaction
  safety remains in the compiler's shared transaction engine.
- `docs/studio-mcp-adapter/0.1.0.md` documents the published adapter, bridge, receipt, CLI, sandbox,
  security, and limitation baseline. `docs/studio-mcp-adapter/0.2.0.md` documents batch, reconnect,
  progress, report, compatibility, and current limitation behavior. Update the applicable reference
  with every Studio adapter contract or behavior change.
- The root `package.json` `packageManager` field and `pnpm-lock.yaml` define the package-manager
  version and dependency resolution.

## Setup and commands

Requires Node.js 22 or newer and Corepack.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Use the root scripts:

- `pnpm format` - write Prettier formatting.
- `pnpm format:check` - check formatting without changing files.
- `pnpm lint` - run ESLint.
- `pnpm typecheck` - build dependencies, then run strict TypeScript checks.
- `pnpm test` - build dependencies, then run Vitest.
- `pnpm build` - compile all packages with `tsc`.
- `pnpm test:dist` - build and smoke-test every compiled CLI, including documented exit codes.
- `pnpm schema:generate` - regenerate checked-in JSON Schemas for all schema-owning packages.
- `pnpm schema:check` - fail if any generated schema artifact has drifted.
- `pnpm fixture:generate` - regenerate deterministic generated fixture artifacts for every package
  that owns generated fixtures, currently the Roblox compiler, Architecture Planner, and Studio MCP
  Adapter; authored fixture inputs remain unchanged.
- `pnpm fixture:check` - fail when any generated fixture artifact differs from its deterministic
  generator output.
- `pnpm worldspec <command>` - run the WorldSpec CLI, for example `pnpm worldspec validate ...`.
- `pnpm roblox-compiler <command>` - run the offline compiler CLI, for example
  `pnpm roblox-compiler compile ...`.
- `pnpm architecture-planner <command>` - run the offline planner CLI, for example
  `pnpm architecture-planner build ...`.
- `pnpm studio-mcp <command>` - run the bounded Studio adapter CLI, for example
  `pnpm studio-mcp probe`.
- `pnpm studio:live-smoke -- --review` - print the offline reviewed live-sequence envelope and its
  full authorization hash without connecting to Studio.
- `pnpm studio:live-smoke -- --studio-id <id> --confirm <full-reviewed-live-sequence-sha256>` - run
  that exact separate real-Studio acceptance flow in a new unsaved local sandbox. This command is
  intentionally excluded from `pnpm check` and CI.
- `pnpm studio:batch-live-smoke -- --review` - print the offline reviewed Milestone 4 chunked and
  reconnectable live-sequence envelope and its full authorization hash without connecting to Studio.
- `pnpm studio:batch-live-smoke -- --studio-id <id> --confirm <full-reviewed-sequence-sha256>` - run
  that exact separate Milestone 4 real-Studio acceptance flow. This command is intentionally
  excluded from `pnpm check` and CI.
- `pnpm check` - run formatting, linting, build, type checks, tests, schema and fixture drift
  checks, and compiled-distribution smoke tests for all packages.

## Engineering standards

- Use ESM, strict TypeScript, and explicit return types on public APIs.
- Use `unknown` plus narrowing for untrusted values. Do not use `any`; if a library makes it
  unavoidable, isolate it at the boundary and explain why.
- Keep functions small and preferably pure. Treat caller-owned inputs as readonly and never mutate
  them.
- Preserve exhaustive handling for discriminated unions.
- Keep schema errors separate from semantic errors and expose stable diagnostics instead of raw
  third-party error text.
- Generated schema, fixtures, normalization, serialization, diagnostics, and machine-readable CLI
  output must be deterministic.
- Canonical compiler JSON uses code-point ordering, two-space indentation, and exactly one final
  line feed. Hash only canonical normalized values and emit lowercase hexadecimal SHA-256. Do not
  add timestamps, random IDs, machine paths, or locale-sensitive ordering to generated contracts.
- Keep dependencies few and justified. Use plain `tsc`; do not add a bundler or monorepo task
  framework.

## Architecture planner rules

- Keep WorldSpec canonical. Planner directives live in its open attribute maps, while the derived
  Architecture Plan remains a separate reviewable artifact and never replaces source semantics.
- Reserve the `archgen-` prefix for planner-generated IDs. IDs must be deterministic, valid under
  WorldSpec v0.1, at most 128 characters, collision-checked across the complete project namespace,
  and stable under unrelated source array reordering.
- Solve horizontal layout in safe integer grid cells. Define every candidate, expansion, pruning,
  scoring, remainder, and final tie order explicitly with code-point string comparison.
- Never use `Math.random`, random UUIDs, system time, locale-sensitive comparison, unbounded
  permutation generation, or undocumented object iteration order in planning.
- The v0.1 topology is the bounded `double_loaded_spine` only. Do not silently infer unsupported
  layouts, basements, split levels, curved geometry, or arbitrary constraints.
- Treat room rectangles as clear space, not wall volume. Generate canonical logical walls first,
  place explicit openings second, and subtract those openings into non-overlapping physical panels.
- Every navigation edge must come from an explicit door, open stair-hall connection, or stair run.
  Mere rectangle contact is never proof of circulation.
- Validate the canonical source hash again before emission, fully evaluate the plan, and compile the
  derived WorldSpec through the public compiler API before reporting success.
- Emit only the existing closed Roblox directive, class, material, shape, and property allowlists.
  Do not introduce scripts, asset IDs, content URLs, arbitrary classes, or property escape hatches.
- Keep planning and emission pure, bounded, non-mutating, offline, and free of network access.

## Roblox compiler and transaction rules

- Keep compilation pure. The compiler maps each explicitly directed WorldSpec entity to exactly one
  manifest node with the same ID and does not read or mutate a Roblox scene.
- Use only the closed directive, class, property, material, managed-attribute, and operation
  allowlists. Do not add arbitrary Roblox classes or properties, arbitrary attribute copying,
  executable source, asset IDs, or content URLs.
- Treat stable IDs and managed attributes as identity. `Instance.Name` is a display value only.
- Treat a manifest as desired state, a snapshot as observed state, and a change set as a dry-run
  transition with exact base, desired, and result hashes. Do not collapse these roles.
- Treat the complete normalized Change Set hash as the only mutation confirmation. A chunk ID, chunk
  hash, operation response, receipt, or transport report is not authorization.
- World-space transform semantics are fixed in compiler v0.1. Parent hierarchy controls organization
  only; it does not compose transforms.
- Reject class changes rather than silently replacing an existing node.
- Never delete, clone, reparent, serialize, quarantine, or otherwise mutate unmanaged content.
  Reject deletion or reparenting of a managed node when it or a managed descendant contains an
  unmanaged-root marker.
- Validate a fresh complete snapshot and its hash before mutation. A stale change set must call no
  adapter mutation method.
- Return a verified no-op before optional mutation preparation. For a nonempty prepared transaction,
  read a second complete prepared snapshot and require the exact original base hash before the first
  operation; preparation failure or a changed base attempts zero node operations and no rollback.
- Apply operations in exact canonical order through either the sequential adapter or deterministic
  nonempty batches that flatten to that exact sequence, and only after pure simulation. Return
  success only after a complete result snapshot verifies against the expected hash.
- Keep exact-prefix classification pure, non-mutating, bounded, and based on complete normalized
  base, observed, and Change Set values. Reject arbitrary subsets, skipped or reordered effects,
  third states, unrelated managed changes, changed unmanaged roots, and scope mismatch.
- On apply or verification failure, read a fresh complete snapshot and classify it before
  compensation. Never compensate a state outside the exact attempted prefix envelope, and never
  report rollback success until the complete restored snapshot hash is verified.
- Treat a thrown batch failure as uncertain and conservatively count the complete submitted chunk as
  attempted unless a trustworthy strict response proves a smaller exact attempted prefix. Never
  blindly retry an uncertain chunk or automatically resume forward work.
- Keep production adapter interfaces narrow and allowlisted. The in-memory adapter belongs under the
  testing export and must not be presented as a Studio adapter.

## Studio MCP adapter rules

- Support only Roblox Studio's built-in MCP server over a locally started stdio process. Do not add
  Streamable HTTP, SSE, TCP, remote URLs, downloaded servers, registry discovery, or arbitrary CLI
  commands.
- Treat MCP as a privileged local capability. Validate discovered schemas for `list_roblox_studios`,
  `set_active_studio`, `get_studio_state`, and `execute_luau` before use, and validate every bounded
  tool result. Never silently guess arguments for an incompatible tool.
- Require an exact discovered Studio ID for every mutating command, even when one Studio is
  connected. Do not select by focus, display name, active status, or list order. The Studio ID
  identifies the Studio target but is insufficient evidence that the same unsaved DataModel remains
  loaded.
- Read managed project state or mutate only in a new unsaved local sandbox with `PlaceId == 0`,
  `GameId == 0`, and Studio stopped in Edit mode. Never add a published-place or running-session
  bypass.
- Generate Luau only from the audited fixed `probe`, `snapshot`, `create`, `update`, and `delete`
  bridge builders, the separate fixed `apply_chunk` composition, or the separate strict sandbox-
  lease actions required to read, compare-and-set claim, and obtain a lease-bound snapshot, plus
  schema-validated JSON and deterministic safe literal encoding. Never expose raw `execute_luau`,
  arbitrary MCP tool calls, dynamic evaluation, script creation, arbitrary classes, generic property
  setters, generic attribute setters, assets, or network access.
- Authorize exactly one adapter-owned Workspace attribute: `WorldwrightStudioSandboxLeaseJson`.
  Never allow a caller-selected attribute name or generic Workspace attribute API. Read and write it
  only through the audited fixed lease protocol in an unsaved stopped sandbox; do not enumerate,
  copy, clear, or alter unrelated Workspace attributes.
- Rotate the sandbox lease once for every nonempty authorized transaction through canonical
  compare-and-set against the exact previously observed valid record or explicit absence. Generate
  the lease ID from 32 cryptographically random Node bytes. Leave the verified record on Workspace
  after completion; the next nonempty transaction rotates it. A no-op performs zero lease claims.
  Malformed existing lease data fails closed and is never overwritten.
- After claiming the lease, retain it only in the private Studio transaction context. Require a
  lease-bound second base snapshot before mutation and use that same lease for every forward batch,
  final verification, failure observation, compensation batch, reconnect observation, and restored-
  base verification. Never fall back to an unbound transaction snapshot.
- Partition batches deterministically without reordering or splitting operations. Enforce at most 32
  node operations, at most 3 MiB of canonical batch request data, the existing 4 MiB outer payload
  bound, the 45-second batch timeout, and the existing 512-operation transaction limit. Reject one
  operation that cannot fit before calling Studio.
- Build batch parent preconditions from transaction-observed expected state. Advance expected state
  only for an exact acknowledged prefix, and replace it completely after every fresh snapshot.
- The fixed batch program must build the selected-project managed index once before its operation
  loop, update that chunk-local index after each acknowledged operation, then perform one
  authoritative end-of-chunk rebuild and complete requested-state verification before returning
  success. Keep per-operation security and operation-local restoration in the shared audited
  helpers.
- Every batch request must carry the exact private sandbox lease ID, while chunk IDs and shareable
  hashes must not. Before processing the first operation, fixed batch Luau must validate the current
  canonical Workspace lease against its lease ID, project ID, and complete Change Set hash. Missing,
  malformed, stale, or mismatched lease data performs zero operations and is not local restoration.
- Treat the public managed attributes and canonical adapter-owned node-state metadata as necessary
  but insufficient evidence. Verify actual class, name, direct parent, public attributes, and every
  allowlisted engine property before returning a snapshot or targeting an operation. Drift fails
  closed and is never silently adopted.
- Preserve unmanaged and foreign-project roots. The required bounded snapshot scan may inspect only
  hierarchy, class, and ownership attributes to detect selected-project nodes outside their root; it
  records only direct structural boundaries and never reads source/content or serializes a protected
  subtree. Mutation lookup must start at direct `Workspace` roots and descend only through the exact
  selected-project managed lineage. Never attribute, rename, move, clone, or destroy protected
  content, and block destructive changes to protected managed lineages.
- Implement only the existing `RobloxAdapter` methods plus the optional generic compiler batch and
  pre-mutation preparation capabilities, and call the compiler's shared sequential or batched
  transaction entry point. Do not duplicate stale checks, simulation, exact-prefix admissibility,
  compensation, or result verification in the MCP package.
- Treat every timed-out, rejected, closed, lost, malformed, mismatched, incomplete, or
  locally-unrestored mutation response as uncertain. Poison and close that client, send it no later
  tool call, and never retransmit its uncertain chunk. Require proof that the old owned process tree
  terminated before starting or trusting a replacement; close failure or timeout blocks automatic
  recovery. Close every rejected replacement too; unproven candidate termination permanently blocks
  later replacement attempts.
- Reconnect for recovery observation only through a new default local-stdio process. Rediscover
  capabilities, require the exact original Studio ID, confirm it active, and re-probe zero
  PlaceId/GameId and stopped Edit mode. Then verify the exact original sandbox lease and obtain the
  complete project snapshot together in one fixed `bound_snapshot` call before classification. Never
  select another or same-named Studio, never use an unbound recovery snapshot, and never exceed two
  reconnect attempts per transaction.
- If the exact Studio ID now contains a missing, malformed, or different lease, another project, or
  another Change Set, treat it as a different DataModel: perform zero compensation mutations, report
  failed-unrestored with a strict sandbox-identity diagnostic, and never claim restoration.
- Require `--sandbox-lease-id <64-lowercase-hex>` for authoritative `progress` classification. The
  read-only command must use `bound_snapshot`, print no lease material, and provide no ignore,
  force, adopt, clear, or resume option.
- After uncertainty, report the forward transaction failed even when the complete desired state is
  observed. Version `0.1.0` compensates an exact admissible nonzero prefix, including the full
  result, back to the exact base; it does not resume forward automatically. Unsafe observations
  receive zero compensation mutations.
- Cross-check compensation against the pure safe snapshot transition, then execute the exact inverse
  forward prefix in reverse order so every partial compensation remains an independently
  classifiable shorter prefix. After uncertain compensation, replan only from a strictly shorter
  observed prefix; never retransmit the same zero-progress uncertain chunk.
- Keep the persisted `WorldwrightStudioAdapterVersion` meaning at `0.1.0` when the package version
  is `0.2.0`; existing Milestone 3 managed nodes must remain readable without metadata rewrites.
- Bound operations, managed nodes, payloads, results, tool-call durations, image content, and
  adapter metadata. Sanitize diagnostics, receipts, and transport reports; never expose raw Luau,
  MCP messages, Studio output, stderr, credentials, Studio IDs in shareable reports, machine paths,
  usernames, environment dumps, lease IDs, lease JSON, or previous Workspace lease contents.
- Keep viewport captures, receipts, and sanitized live summaries under
  `.worldwright/live-milestone-4/` and untracked for Milestone 4. A capture is evidence, not a
  visual-quality claim.
- Do not call ChangeHistoryService. The MCP bridge is not a plugin, Studio undo is not transaction
  isolation, and a future Forge history recording cannot replace snapshot verification.

## Tests and documentation

- Every behavior change requires focused tests and corresponding documentation.
- Assert behavior and stable diagnostic codes directly; avoid large opaque snapshots.
- Cover valid input, malformed input, semantic edge cases, non-mutation, deterministic output,
  schema and fixture drift, and CLI exit codes as applicable.
- Planner behavior requires focused tests for source profiles, grid and capacity arithmetic,
  candidate ordering, allocation, adjacency, walls, opening subtraction, slabs, aligned stairs,
  explicit circulation, metric and score recomputation, stale-plan rejection, emission, and
  generated-ID collisions.
- Planner integration requires a complete source-to-plan-to-derived-WorldSpec-to-manifest-to-change-
  set-to-simulated-snapshot test, including deterministic hashes and exact result verification.
- Transaction behavior requires tests for success, no-op, stale rejection before mutation, failures
  before and after mutation, verification mismatch, verified rollback, rollback failure,
  unmanaged-descendant protection, deterministic attempted-operation order, every exact progress
  prefix, unsafe unrelated state, sequential regression, batch success, uncertain failure, and
  conservative full-result compensation.
- Studio adapter behavior requires fake-MCP tests for command resolution, capability schema
  compatibility, exact session selection, sandbox rejection, adversarial literal encoding, response
  framing, engine drift, empty and populated snapshots, unmanaged and foreign-project boundaries,
  create/update/delete failure cleanup, existing transaction compensation, receipts, capture,
  process cleanup, deterministic chunking, batch contracts and fixed programs, response prefixes,
  expected parent progression, client poisoning, exact-ID reconnection, reconnect bounds, reports,
  progress CLI exit codes, confirmation, operation/payload bounds, lease contracts, compare-and-set
  rotation, lease-bound batches and snapshots, same-ID/different-DataModel rejection, preparation
  ordering, no-op zero-claim behavior, and sanitization. CI must not require Studio.
- A live Studio success claim requires an actual run against one unsaved local Edit-mode sandbox,
  exact canonical snapshot hash comparisons, actual chunk and mutation-execute call counts, at most
  16 forward mutation calls for the 400-create Cliffwatch transition, verified no-op and update
  repair, one lease claim per nonempty transaction, controlled lost-acknowledgment exact-ID
  reconnect with same-call lease-bound observation, exact-prefix classification, verified
  compensation, and untracked evidence with no shareable lease identifier. Fake-client tests do not
  prove live acceptance.
- Before claiming completion, run `pnpm check`. Also run a narrower command while iterating when it
  gives faster feedback.
- Report every failed or skipped check honestly. Never claim a command passed unless it ran
  successfully.

## Security and privacy

- Never commit secrets, credentials, tokens, personal data, or private reference content.
- No hidden network calls, telemetry, or analytics.
- Do not add an AI provider, another live Roblox integration, Forge plugin, external generation
  provider, database, authentication system, or production service without an explicit milestone
  authorizing it. Milestone 4 authorizes only deterministic chunking and reconnectable recovery
  within the bounded local Studio MCP adapter described above.
- WorldSpec is data only. Never accept or introduce arbitrary executable code, provider credentials,
  or chain-of-thought fields.
- Roblox compiler contracts are data only. Never introduce scripts, dynamic evaluation, arbitrary
  property setters, network calls, or mutation outside the selected managed project.
- Architecture contracts are data only. Never accept executable source, provider credentials, unsafe
  numeric values, unbounded user-controlled search, hidden source mutation, or emission against a
  stale source hash.
- Studio bridge and receipt contracts are data only. Never accept arbitrary Luau, executable Roblox
  Instances, arbitrary MCP payloads, credentials, logs, image bytes, machine paths, or environment
  dumps.
- Validate unknown external input before using it, and avoid exposing stack traces for expected user
  errors.

## Definition of done

A change is done only when its implementation, tests, generated schemas, generated fixtures, and
documentation agree; `pnpm check` passes; generated, normalized, and hashed output is deterministic;
transaction changes include verified rollback coverage; planner changes include complete geometry,
circulation, and offline pipeline coverage; Studio adapter changes preserve exact selection,
sandbox, fixed-program, engine-verification, ownership, receipt, and compensation boundaries; batch
changes preserve complete Change Set authorization, deterministic ordering and bounds, client
poisoning, exact-ID reconnect, same-DataModel sandbox leasing, lease-bound observation and mutation,
exact-prefix classification, no blind retry, no automatic resume, strict identity-free transport
reporting, and actual live call-count evidence; the diff contains no unrelated files, tracked live
evidence, or secrets; and implemented versus future Studio, playtesting, Forge, and Critic scope is
stated accurately. If any required check or real live acceptance cannot run or fails, leave a clear
record instead of declaring the live milestone complete.
