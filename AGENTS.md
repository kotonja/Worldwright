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
  Luau or Studio automation API.
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
- `packages/roblox-compiler/src/compile.ts`, `reconcile.ts`, `simulate.ts`, and `transaction.ts`
  define compiler, planning, simulation, and transaction behavior. Safety invariants belong in those
  package boundaries rather than only in a caller or adapter.
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
- `packages/studio-mcp-adapter/src/mcp/command.ts`, `capabilities.ts`, `session.ts`, and `client.ts`
  define local process resolution, tool discovery, exact Studio selection, and the isolated MCP SDK
  boundary.
- `packages/studio-mcp-adapter/src/bridge/program.ts` and the action-specific bridge builders define
  the only fixed Luau programs Worldwright may send: `probe`, `snapshot`, `create`, `update`, and
  `delete`. Never expose their source or accept caller-supplied Luau.
- `packages/studio-mcp-adapter/src/engine-state.ts`, `snapshot.ts`, and `adapter.ts` define actual
  engine verification, unmanaged-root observation, and the implementation of the existing compiler
  adapter interface. Transaction safety remains in the compiler's `applyRobloxChangeSet`.
- `docs/studio-mcp-adapter/0.1.0.md` documents the published adapter, bridge, receipt, CLI, sandbox,
  security, and limitation behavior. Update it with every Studio adapter contract or behavior
  change.
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
- World-space transform semantics are fixed in compiler v0.1. Parent hierarchy controls organization
  only; it does not compose transforms.
- Reject class changes rather than silently replacing an existing node.
- Never delete, clone, reparent, serialize, quarantine, or otherwise mutate unmanaged content.
  Reject deletion or reparenting of a managed node when it or a managed descendant contains an
  unmanaged-root marker.
- Validate a fresh complete snapshot and its hash before mutation. A stale change set must call no
  adapter mutation method.
- Apply operations sequentially only after pure simulation. Return success only after a complete
  result snapshot verifies against the expected hash.
- On apply or verification failure, plan compensation from observed current state back to the exact
  initial snapshot. Never report rollback success until the complete restored snapshot hash is
  verified.
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
  connected. Do not select by focus, display name, active status, or list order.
- Read managed project state or mutate only in a new unsaved local sandbox with `PlaceId == 0`,
  `GameId == 0`, and Studio stopped in Edit mode. Never add a published-place or running-session
  bypass.
- Generate Luau only from the audited fixed `probe`, `snapshot`, `create`, `update`, and `delete`
  bridge builders plus schema-validated JSON and deterministic safe literal encoding. Never expose
  raw `execute_luau`, arbitrary MCP tool calls, dynamic evaluation, script creation, arbitrary
  classes, generic property setters, generic attribute setters, assets, or network access.
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
- Implement only the existing `RobloxAdapter` methods and call the compiler's
  `applyRobloxChangeSet`. Do not duplicate stale checks, simulation, rollback admissibility,
  compensation, or result verification in the MCP package.
- Bound operations, managed nodes, payloads, results, tool-call durations, image content, and
  adapter metadata. Sanitize diagnostics and receipts; never expose raw Luau, MCP messages, Studio
  output, stderr, credentials, machine paths, usernames, or environment dumps.
- Keep viewport captures, receipts, and sanitized live summaries under
  `.worldwright/live-milestone-3/` and untracked. A capture is evidence, not a visual-quality claim.
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
  unmanaged-descendant protection, and deterministic attempted-operation order.
- Studio adapter behavior requires fake-MCP tests for command resolution, capability schema
  compatibility, exact session selection, sandbox rejection, adversarial literal encoding, response
  framing, engine drift, empty and populated snapshots, unmanaged and foreign-project boundaries,
  create/update/delete failure cleanup, existing transaction compensation, receipts, capture,
  process cleanup, CLI confirmation, operation bounds, and sanitization. CI must not require Studio.
- A live Studio success claim requires an actual run against one unsaved local Edit-mode sandbox,
  exact canonical snapshot hash comparisons, tested ownership boundaries, verified no-op and update
  repair, verified controlled-failure compensation, and untracked evidence. Fake-client tests do not
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
  authorizing it. Milestone 3 authorizes only the bounded local Studio MCP adapter described above.
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
sandbox, fixed-program, engine-verification, ownership, receipt, and compensation boundaries; the
diff contains no unrelated files, tracked live evidence, or secrets; and implemented versus future
Studio, playtesting, Forge, and Critic scope is stated accurately. If any required check or real
live acceptance cannot run or fails, leave a clear record instead of declaring the live milestone
complete.
