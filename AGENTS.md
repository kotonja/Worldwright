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
- `pnpm fixture:generate` - regenerate deterministic Roblox compiler fixture artifacts.
- `pnpm fixture:check` - fail if any generated fixture artifact has drifted.
- `pnpm worldspec <command>` - run the WorldSpec CLI, for example `pnpm worldspec validate ...`.
- `pnpm roblox-compiler <command>` - run the offline compiler CLI, for example
  `pnpm roblox-compiler compile ...`.
- `pnpm architecture-planner <command>` - run the offline planner CLI, for example
  `pnpm architecture-planner build ...`.
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
- Before claiming completion, run `pnpm check`. Also run a narrower command while iterating when it
  gives faster feedback.
- Report every failed or skipped check honestly. Never claim a command passed unless it ran
  successfully.

## Security and privacy

- Never commit secrets, credentials, tokens, personal data, or private reference content.
- No hidden network calls, telemetry, or analytics.
- Do not add an AI provider, live Roblox Studio adapter, Studio MCP integration, Forge plugin,
  external generation provider, database, authentication system, or production service without an
  explicit milestone authorizing it.
- WorldSpec is data only. Never accept or introduce arbitrary executable code, provider credentials,
  or chain-of-thought fields.
- Roblox compiler contracts are data only. Never introduce scripts, dynamic evaluation, arbitrary
  property setters, network calls, or mutation outside the selected managed project.
- Architecture contracts are data only. Never accept executable source, provider credentials, unsafe
  numeric values, unbounded user-controlled search, hidden source mutation, or emission against a
  stale source hash.
- Validate unknown external input before using it, and avoid exposing stack traces for expected user
  errors.

## Definition of done

A change is done only when its implementation, tests, generated schemas, generated fixtures, and
documentation agree; `pnpm check` passes; generated, normalized, and hashed output is deterministic;
transaction changes include verified rollback coverage; planner changes include complete geometry,
circulation, and offline pipeline coverage; the diff contains no unrelated files or secrets; and
implemented versus future Studio scope is stated accurately. If any required check cannot run or
fails, leave a clear record instead of declaring the work complete.
