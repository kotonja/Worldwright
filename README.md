# Worldwright

Worldwright is an AI World Architect for compiling human intent and references into coherent,
editable, testable, and performance-aware Roblox worlds.

> **Status:** Milestones 0 through 4 are complete. Milestone 5 is the current implementation: a
> deterministic, architectural build-test-evaluate loop that derives a source-bound traversal plan,
> observes one solo playtest, and produces the first narrow Critic report. **Live work remains
> restricted to a new unsaved local place (`PlaceId == 0`, `GameId == 0`) selected by its exact
> Studio ID. Play may begin only after the desired Manifest is an exact no-op in the leased
> DataModel, and Stop must be followed by an exact lease-bound Edit snapshot hash check.**

## Product principles

- **Compile worlds, not isolated assets.** Spatial hierarchy, traversal, constraints, provenance,
  style, and budgets must remain connected.
- **Keep intent machine-readable.** Strict, versioned contracts let independent systems exchange
  semantic plans, desired state, observations, and reviewed changes without prompt-shaped objects.
- **Be honest about evidence.** WorldSpec distinguishes observed, inferred, and invented
  information; the compiler distinguishes desired state from observed scene state.
- **Preserve creator ownership.** Managed identity is explicit, and destructive changes stop when
  unmanaged descendants are present.
- **Repair locally.** Locks, semantic IDs, and complete before/after nodes are foundations for
  improving one area without needlessly rebuilding the rest.
- **Treat quality and performance as correctness.** Traversal, visual coherence, and device budgets
  are not optional finishing steps.
- **Prefer deterministic foundations.** Validation, normalization, serialization, hashing, planning,
  generated artifacts, and CLI output are reproducible.

## Implemented scope

Milestone 0 provides:

- the strict WorldSpec `0.1.0` TypeBox schema and deterministic draft 2020-12 JSON Schema;
- static TypeScript types, schema and semantic validation, and stable diagnostics;
- deterministic, non-mutating normalization and serialization;
- the WorldSpec validation and normalization CLI; and
- fixtures, tests, generated-schema drift checks, and the repository quality toolchain.

Milestone 1 adds the private `@worldwright/roblox-compiler` package:

- strict `0.1.0` schemas for per-entity Roblox directives, Roblox Manifests, Scene Snapshots, and
  Change Sets;
- pure compilation of explicitly directed WorldSpec entities into allowlisted Roblox containers and
  anchored primitives;
- deterministic canonical JSON and lowercase SHA-256 hashes over desired and observed state;
- pure dry-run reconciliation with complete `create`, `update`, and `delete` operations;
- unmanaged-descendant protection, class-change conflicts, and stale-snapshot preconditions;
- pure change-set simulation and exact expected-result snapshots;
- an asynchronous transaction executor that verifies the result or performs and verifies a
  snapshot-based rollback;
- a deterministic in-memory adapter and fault injection for transaction tests;
- checked-in schemas, a primitive courtyard fixture, manifests, snapshots, and change sets; and
- CLI commands for offline `compile` and `plan` workflows.

The compiler maps one WorldSpec entity to one managed node. It supports `Folder`, `Model`, `Part`,
`WedgePart`, and `CornerWedgePart` through explicit `attributes["worldwright.roblox"]` directives.
It does not infer architecture, generate assets, emit Luau, or mutate Studio.

Milestone 2 adds the private `@worldwright/architecture-planner` package:

- strict `0.1.0` entity, relationship, and Architecture Plan contracts;
- a bounded deterministic integer-grid solver for one- to three-floor, double-loaded-spine
  blockouts;
- explicit room allocation, logical walls, doors, windows, aligned straight-run stairs, and an
  evaluated circulation graph;
- deterministic emission of source semantics plus allowlisted Roblox blockout primitives;
- source and plan integrity hashes, generated-ID collision protection, and exact instance-budget
  checks;
- an end-to-end offline pipeline from an authored WorldSpec program to a Roblox Manifest, Scene
  Snapshot transition, and pure simulated result; and
- checked-in mansion program, plan, derived WorldSpec, manifest, snapshot, and change-set fixtures.

The planner produces a coherent, editable architectural blockout. It is not finished visual art,
does not claim building-code compliance, and does not infer unspecified architecture from prose or
images.

Milestone 3 adds the private `@worldwright/studio-mcp-adapter` package:

- a pinned MCP v1 client that starts Roblox Studio's built-in server over local stdio only;
- runtime discovery and schema validation for required Studio tools;
- exact Studio-session selection and an unsaved-local-sandbox, stopped-Edit-mode gate;
- fixed `probe`, `snapshot`, `create`, `update`, and `delete` Luau bridge programs with inert
  schema-validated JSON payloads;
- live conversion of managed Instances into the existing compiler Scene Snapshot contract;
- structural unmanaged-root mapping and protection for creator-owned and foreign-project content;
- canonical per-node adapter metadata plus verification against actual engine properties;
- an implementation of the existing compiler `RobloxAdapter` interface, using the existing
  `applyRobloxChangeSet` executor for stale checks, simulation, exact result verification, and
  compensation;
- strict deterministic Studio Apply Receipts and optional untracked viewport evidence; and
- a dependency-light CLI, fake-MCP test boundary, generated schemas, and live acceptance runner.

The public package API and CLI cannot accept raw Luau, arbitrary Studio tool calls, arbitrary Roblox
classes or properties, scripts, assets, network endpoints, or a published-place bypass. Enabling
Studio MCP remains privileged; creators should connect only trusted clients.

Milestone 4 extends that accepted bridge with a reliability layer:

- pure exact-prefix classification of a fresh observed snapshot against one complete Change Set;
- one shared compiler transaction engine for compatible sequential and intentional batch adapters;
- deterministic chunks of at most 32 node operations and 3 MiB of canonical request data;
- a separate strict fixed `apply_chunk` bridge request and response protocol;
- expected parent-state progression within and across chunks;
- independent final snapshot verification after every successful forward transition;
- client poisoning after a timeout, lost or malformed acknowledgment, or other uncertain mutation;
- one private transaction-scoped Workspace sandbox lease, canonically compare-and-set after
  preflight for every nonempty transaction and left in place for the next transaction to rotate;
- zero sandbox-lease claims for a verified no-op;
- lease-bound batches and complete snapshots, including final verification and compensation;
- bounded reconnection to the exact original Studio ID with a renewed unsaved stopped-sandbox gate
  and a same-call lease-bound snapshot proving the original unsaved DataModel is still loaded;
- conservative compensation of an exact observed prefix, including a complete desired result after
  acknowledgment loss;
- strict deterministic Studio Progress and Transport Reports; and
- a read-only `progress` CLI plus a separate real-Studio batch acceptance sequence.

Milestone 3 remains accepted: it proved exact selection, fixed programs, engine-state verification,
ownership protection, and verified compensation. Milestone 4 comes before playtesting because two
bounded live attempts at the 400-node Cliffwatch build encountered intermittent timeouts during the
old 400-call mutation phase. Chunking reduces that forward create to 13 bounded calls, while fresh
observation and exact-prefix classification preserve the existing safety model if an acknowledgment
is lost.

Milestone 5 adds the private `@worldwright/playtest-critic` package and a separate playtest boundary
to the Studio adapter:

- strict `0.1.0` Playtest Plan, Playtest Run Report, and Critic Report contracts;
- deterministic quarter-turn checkpoint geometry and iterative breadth-first routes derived only
  from explicit Architecture Plan circulation;
- source, Manifest, root, semantic-container, and geometry binding before a plan is accepted;
- a fixed non-jumping character profile, PathfindingService preflight, one navigation request per
  segment, and independent arrival, floor, survival, support, and clearance evidence;
- playtest-only capability discovery and fixed `identity_probe`, `character_setup`, `player_state`,
  `path_probe`, and `clearance_probe` Server actions;
- bounded console differencing and private viewport evidence without raw logs, image bytes, Studio
  identity, or lease identity in strict reports;
- observed-state start and stop handling with no blind retry, followed by an exact post-play Edit
  snapshot and final Manifest no-op check; and
- a pure deterministic architectural Critic that localizes path, navigation, clearance, circulation,
  stair, console, evidence, stop, and integrity findings without generating a repair.

The closed Architecture Plan and Manifest contracts carry hashes for different WorldSpec stages.
Milestone 5 therefore proves both exact artifacts and exhaustive supported structural
correspondence, but cannot cryptographically prove authored-Plan-to-derived-Manifest provenance
without an additional trusted input or additive provenance field.

This Critic is functional and architectural. It does not score beauty, style, lighting, textures,
furnishing, reference fidelity, gameplay fun, performance under load, or publish readiness.

## Not implemented yet

There is no Studio plugin, Forge interface, ChangeHistoryService integration, published-place
mutation, arbitrary Play-mode automation, visual critique, image understanding, or automatic repair.
Atlas orchestration, learned or reference-image architectural generation, asset routing or
generation, the visual Critic, and a polished Reference-to-Mansion vertical slice remain future
work.

The repository makes no external generation or AI calls and contains no production service,
database, authentication, telemetry, analytics, or deployment integration.

## Repository structure

```text
.
|-- .github/workflows/ci.yml
|-- docs/
|   |-- adr/
|   |   |-- 0001-worldspec-as-canonical-contract.md
|   |   |-- 0002-declarative-roblox-manifest-and-transactions.md
|   |   |-- 0003-deterministic-orthogonal-architecture-planning.md
|   |   |-- 0004-use-studio-mcp-for-the-first-live-adapter.md
|   |   |-- 0005-chunk-studio-mutations-and-recover-by-observation.md
|   |   `-- 0006-observe-playtests-before-automatic-repair.md
|   |-- architecture/
|   |   |-- architecture-planner.md
|   |   |-- roblox-compiler.md
|   |   |-- studio-mcp-adapter.md
|   |   |-- studio-transaction-batching.md
|   |   |-- system-overview.md
|   |   `-- playtest-observation-and-critic.md
|   |-- architecture-planner/0.1.0.md
|   |-- playtest-critic/
|   |   |-- 0.1.0.md
|   |   |-- evidence-model.md
|   |   `-- traversal-model.md
|   |-- product/vision.md
|   |-- roblox-compiler/0.1.0.md
|   |-- studio-mcp-adapter/
|   |   |-- 0.1.0.md
|   |   |-- 0.2.0.md
|   |   |-- recovery.md
|   |   `-- sandbox-setup.md
|   `-- worldspec/0.1.0.md
|-- packages/
|   |-- architecture-planner/
|   |   |-- fixtures/             # Authored program and generated pipeline artifacts
|   |   |-- schema/               # Generated architecture directive and plan schemas
|   |   |-- scripts/              # Schema, fixture, and compiled-CLI checks
|   |   |-- src/                  # Profile, solver, geometry, evaluation, emission, CLI
|   |   `-- test/                 # Contract, solver, geometry, pipeline, and CLI tests
|   |-- playtest-critic/
|   |   |-- fixtures/             # Generated plans, run reports, and Critic reports
|   |   |-- schema/               # Generated plan, run-report, and Critic schemas
|   |   |-- scripts/              # Schema, fixture, and compiled-CLI checks
|   |   |-- src/                  # Source binding, traversal planning, reports, Critic, CLI
|   |   `-- test/                 # Contract, geometry, route, pipeline, scale, and CLI tests
|   |-- roblox-compiler/
|   |   |-- fixtures/             # Canonical WorldSpec, manifest, snapshot, and plan examples
|   |   |-- schema/               # Generated directive and compiler-contract schemas
|   |   |-- scripts/              # Schema, fixture, and compiled-CLI drift/smoke checks
|   |   |-- src/                  # Compile, validate, plan, simulate, transact, CLI
|   |   `-- test/                 # Unit, integration, transaction, and CLI tests
|   |-- studio-mcp-adapter/
|   |   |-- fixtures/             # Deterministic bridge and receipt examples
|   |   |-- schema/               # Generated bridge and receipt schemas
|   |   |-- scripts/              # Schema, dist, and explicit live-smoke entry points
|   |   |-- src/                  # MCP boundary, fixed bridge, adapter, receipts, capture, CLI
|   |   `-- test/                 # Fake-MCP, engine, transaction, receipt, and CLI tests
|   `-- worldspec/
|       |-- fixtures/             # Valid and intentionally invalid semantic examples
|       |-- schema/               # Generated WorldSpec schema
|       |-- scripts/              # Schema generation and drift checks
|       |-- src/                  # Schema, validation, normalization, API, CLI
|       `-- test/                 # Unit and CLI integration tests
|-- AGENTS.md
|-- package.json
|-- pnpm-lock.yaml
`-- pnpm-workspace.yaml
```

## Setup

Prerequisites:

- Node.js 22 or newer
- Corepack available on `PATH`

From a fresh clone:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

The root `package.json` pins `pnpm@11.7.0` through `packageManager`; Corepack selects that exact
version.

## Commands

| Command                           | Purpose                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm format`                     | Format supported files with Prettier.                                                              |
| `pnpm format:check`               | Check formatting without writing changes.                                                          |
| `pnpm lint`                       | Run ESLint.                                                                                        |
| `pnpm typecheck`                  | Build dependencies, then type-check all workspace packages.                                        |
| `pnpm test`                       | Build dependencies, then run all Vitest suites.                                                    |
| `pnpm build`                      | Compile all workspace packages with `tsc`.                                                         |
| `pnpm test:dist`                  | Build and smoke-test compiled CLIs and their documented exit codes.                                |
| `pnpm schema:generate`            | Regenerate schemas for every package that owns schema artifacts.                                   |
| `pnpm schema:check`               | Check all generated schemas for drift.                                                             |
| `pnpm fixture:generate`           | Regenerate deterministic artifacts for every fixture-owning package.                               |
| `pnpm fixture:check`              | Fail when any generated fixture artifact differs from its deterministic generator output.          |
| `pnpm worldspec`                  | Run the WorldSpec CLI.                                                                             |
| `pnpm roblox-compiler`            | Run the offline Roblox compiler CLI.                                                               |
| `pnpm architecture-planner`       | Run the offline architectural blockout planner CLI.                                                |
| `pnpm playtest-critic`            | Plan deterministic traversal or evaluate a strict run report.                                      |
| `pnpm studio-mcp`                 | Run the bounded local Studio MCP adapter CLI.                                                      |
| `pnpm studio:live-smoke`          | Run explicit real-Studio acceptance in an unsaved sandbox; excluded from `pnpm check` and CI.      |
| `pnpm studio:batch-live-smoke`    | Review or run Milestone 4 batch and reconnect acceptance; excluded from `pnpm check` and CI.       |
| `pnpm studio:playtest-live-smoke` | Review or run Milestone 5 playtest acceptance; excluded from `pnpm check` and CI.                  |
| `pnpm check`                      | Run formatting, lint, build, type, tests, schema and fixture drift, and distribution smoke checks. |

The root fixture commands cover generated artifacts owned by the Roblox compiler, Architecture
Planner, Playtest Critic, and Studio MCP Adapter. Authored fixture inputs remain unchanged and are
never generated.

CI runs `pnpm check` with Node.js 22 for pull requests, pushes to `main`, and manual dispatches. It
uses fake MCP clients and requires no Studio installation. Generated `dist` directories remain
uncommitted; deterministic schema and fixture artifacts are checked in. Live receipts and images
remain under the ignored `.worldwright/` directory.

## WorldSpec CLI

Validate and normalize WorldSpec documents:

```sh
pnpm worldspec validate packages/worldspec/fixtures/valid/reference-mansion.worldspec.json
pnpm worldspec validate path/to/world.worldspec.json --json
pnpm worldspec normalize path/to/world.worldspec.json
pnpm worldspec normalize path/to/world.worldspec.json --output path/to/normalized.worldspec.json
pnpm worldspec schema
```

See the [WorldSpec v0.1 reference](docs/worldspec/0.1.0.md) for its contract, diagnostics,
normalization rules, and CLI exit codes.

## Roblox compiler CLI

Compile the directed primitive courtyard into a canonical manifest:

```sh
pnpm roblox-compiler compile packages/roblox-compiler/fixtures/worldspec/primitive-courtyard.worldspec.json
```

Write only to an explicit output path or request stable machine-readable output:

```sh
pnpm roblox-compiler compile packages/roblox-compiler/fixtures/worldspec/primitive-courtyard.worldspec.json --output courtyard.manifest.json
pnpm roblox-compiler compile packages/roblox-compiler/fixtures/worldspec/primitive-courtyard.worldspec.json --json
```

Plan creation from the canonical empty snapshot, or repair from the checked-in modified snapshot:

```sh
pnpm roblox-compiler plan packages/roblox-compiler/fixtures/manifest/primitive-courtyard.manifest.json --snapshot packages/roblox-compiler/fixtures/snapshots/empty.snapshot.json
pnpm roblox-compiler plan packages/roblox-compiler/fixtures/manifest/primitive-courtyard.manifest.json --snapshot packages/roblox-compiler/fixtures/snapshots/modified.snapshot.json --output courtyard-repair.change-set.json
```

Omitting `--snapshot` plans against a canonical empty snapshot for the manifest's project and
`Workspace` target. The CLI has no `apply` command and cannot connect to or modify Roblox Studio.

See the [Roblox compiler v0.1 reference](docs/roblox-compiler/0.1.0.md) for contracts, allowlists,
spatial semantics, diagnostics, and CLI behavior.

## Architecture planner CLI

Plan the checked-in mansion program, emit its compiler-ready WorldSpec, or run both stages:

```sh
pnpm architecture-planner plan packages/architecture-planner/fixtures/input/cliffwatch-mansion-program.worldspec.json
pnpm architecture-planner emit packages/architecture-planner/fixtures/input/cliffwatch-mansion-program.worldspec.json --plan packages/architecture-planner/fixtures/plans/cliffwatch-mansion.architecture-plan.json
pnpm architecture-planner build packages/architecture-planner/fixtures/input/cliffwatch-mansion-program.worldspec.json --plan-output cliffwatch.plan.json --worldspec-output cliffwatch.worldspec.json
```

Each command supports stable JSON mode. Output files are written only when an explicit path is
provided, and source or plan inputs are never overwritten. The planner is offline: it emits data for
the existing compiler and has no command that applies changes to Roblox Studio.

The fixture walkthrough is the complete local pipeline:

```text
cliffwatch-mansion-program.worldspec.json
  -> cliffwatch-mansion.architecture-plan.json
  -> cliffwatch-mansion-blockout.worldspec.json
  -> cliffwatch-mansion-blockout.manifest.json
  -> create-cliffwatch-blockout.change-set.json
  -> pure simulated snapshot
```

See the [Architecture Planner v0.1 reference](docs/architecture-planner/0.1.0.md) for its supported
profile, coordinate model, contracts, diagnostics, security boundary, and limitations.

## Playtest Critic CLI

Derive the deterministic Cliffwatch traversal plan from the validated Architecture Plan and its
exact compiled Manifest:

```sh
pnpm playtest-critic plan packages/architecture-planner/fixtures/plans/cliffwatch-mansion.architecture-plan.json --manifest packages/architecture-planner/fixtures/manifest/cliffwatch-mansion-blockout.manifest.json
pnpm playtest-critic plan packages/architecture-planner/fixtures/plans/cliffwatch-mansion.architecture-plan.json --manifest packages/architecture-planner/fixtures/manifest/cliffwatch-mansion-blockout.manifest.json --output cliffwatch.playtest-plan.json
```

Evaluate a strict run report through the pure deterministic Critic:

```sh
pnpm playtest-critic evaluate --plan packages/playtest-critic/fixtures/plans/cliffwatch.playtest-plan.json --run-report packages/playtest-critic/fixtures/run-reports/cliffwatch-pass.playtest-run.json
pnpm playtest-critic evaluate --plan cliffwatch.playtest-plan.json --run-report run.playtest-run.json --output run.critic.json
```

Planning derives world positions only from the Architecture Plan's exact quarter-turn coordinate
model and follows only explicit doors, open stair-hall connections, and stair runs. Evaluation reads
strict structured evidence; it does not connect to Studio, inspect images, generate a Change Set, or
apply a repair. See the [Playtest Critic v0.1 reference](docs/playtest-critic/0.1.0.md).

## Studio MCP adapter CLI

Start with a new unsaved Roblox Studio baseplate, enable Studio's built-in MCP server, leave Studio
stopped in Edit mode, and list the connected sessions:

```sh
pnpm studio-mcp probe
```

Copy the exact Studio ID. Plan against the checked-in Cliffwatch manifest, review the complete
change set, and apply it only with its full lowercase SHA-256 confirmation hash:

```sh
pnpm studio-mcp plan-live --studio-id <exact-studio-id> --manifest packages/architecture-planner/fixtures/manifest/cliffwatch-mansion-blockout.manifest.json --output .worldwright/live-milestone-4/cliffwatch.change-set.json
pnpm studio-mcp apply --studio-id <exact-studio-id> --change-set .worldwright/live-milestone-4/cliffwatch.change-set.json --confirm <full-change-set-sha256> --receipt-output .worldwright/live-milestone-4/applied.receipt.json
pnpm studio-mcp verify --studio-id <exact-studio-id> --manifest packages/architecture-planner/fixtures/manifest/cliffwatch-mansion-blockout.manifest.json
```

`plan-live` and `apply` are intentionally separate. Mutation never auto-selects a session, and there
is no `--force`, `--yes`, production-place bypass, custom MCP command, or raw Luau option. The
complete Change Set hash remains the authorization unit; chunk hashes do not authorize mutation. The
package generates only its audited fixed bridge actions and fixed `apply_chunk` program. Exact
Studio selection identifies the Studio target, not the unsaved DataModel inside it. A nonempty apply
therefore claims and verifies one private transaction lease stored only in the fixed
`WorldwrightStudioSandboxLeaseJson` attribute on `Workspace`. The lease is transport evidence, not
creator approval, authentication, a signature, permanent object identity, or a substitute for
snapshot hashes.

Inspect current progress without mutation by supplying the exact reviewed base document as well as
the Change Set:

```sh
pnpm studio-mcp progress --studio-id <exact-studio-id> --sandbox-lease-id <64-lowercase-hex> --base-snapshot .worldwright/live-milestone-4/base.snapshot.json --change-set .worldwright/live-milestone-4/cliffwatch.change-set.json
pnpm studio-mcp progress --studio-id <exact-studio-id> --sandbox-lease-id <64-lowercase-hex> --base-snapshot .worldwright/live-milestone-4/base.snapshot.json --change-set .worldwright/live-milestone-4/cliffwatch.change-set.json --json
```

The command returns `base`, exact `prefix`, `complete`, or `unsafe`; it has no resume or recovery
mutation option. Its lease argument is required for authoritative recovery inspection but is never
printed or placed in the Progress Report. The lease check and complete snapshot occur in one fixed
`bound_snapshot` call. A Change Set contains only its base hash, so the complete reviewed base
snapshot is also required to prove an exact prefix.

Alternatively, use the complete real-Studio acceptance sequence instead of the manual `apply` above.
First print and review the offline sequence envelope. It pins the allowed create or canonical no-op,
one-node update, inverse repair, controlled fault, JPEG capture, and final no-op hashes without
connecting to Studio. Then pass that envelope's complete hash explicitly:

```sh
pnpm studio:batch-live-smoke -- --review
pnpm studio:batch-live-smoke -- --studio-id <exact-studio-id> --confirm <full-reviewed-live-sequence-sha256>
```

Follow the [sandbox setup guide](docs/studio-mcp-adapter/sandbox-setup.md). Do not test against an
existing or published place, and do not commit the Studio ID, receipts, image, local paths, or raw
logs. The acceptance command rejects prefixes and implicit approval, matches the live initial plan
to one reviewed transition, prints the complete selected-place plan before mutation, and reserves
all evidence outputs exclusively before it connects or mutates.

The Milestone 4 sequence asserts the actual mutation-call count, an independently verified no-op,
one harmless update and inverse repair, and a testing-only lost acknowledgment. The latter must
poison the old client, reconnect through a new local-stdio process to the exact same Studio ID,
re-probe the sandbox, verify the original private lease and read the snapshot in one fixed call,
classify the exact observed prefix, compensate under that same lease to the canonical base, and
verify its complete hash. A missing, malformed, or different lease blocks classification and all
compensation. A viewport capture is evidence only, not a visual-quality claim.

Milestone 5 has a separate review-first playtest sequence. It is excluded from `pnpm check` and CI,
requires the complete reviewed sequence hash, and accepts the private Studio and sandbox-lease
identity only at runtime:

```sh
pnpm studio:playtest-live-smoke -- --review
pnpm studio:playtest-live-smoke -- --studio-id <exact-studio-id> --sandbox-lease-id <private-64-lowercase-hex> --confirm <full-reviewed-playtest-sequence-sha256> --confirm-plan <exact-playtest-plan-sha256> --confirm-change-set <complete-change-set-sha256>
```

The review command prints all three required hashes without printing a Studio ID, sandbox lease, or
local path.

The controller first proves the exact desired Manifest is already present in the leased unsaved
DataModel. It then starts one solo simulation, proves Server-side project identity, traverses the
confirmed plan with path preflight and one navigation request per segment, and always resolves Stop
through observed state. Success additionally requires the exact pre-play and post-play lease-bound
Edit snapshot hashes to match and the final Manifest reconciliation to remain a no-op. Raw console
messages, image bytes, Studio identity, and lease identity stay under the ignored
`.worldwright/live-milestone-5/` evidence directory.

## Documentation

- [Product vision](docs/product/vision.md)
- [System overview](docs/architecture/system-overview.md)
- [Roblox compiler architecture](docs/architecture/roblox-compiler.md)
- [Architecture planner](docs/architecture/architecture-planner.md)
- [Studio MCP adapter architecture](docs/architecture/studio-mcp-adapter.md)
- [Studio transaction batching and reconnectable recovery](docs/architecture/studio-transaction-batching.md)
- [Playtest observation and the architectural Critic](docs/architecture/playtest-observation-and-critic.md)
- [ADR 0001: WorldSpec is the canonical cross-system contract](docs/adr/0001-worldspec-as-canonical-contract.md)
- [ADR 0002: Use a declarative Roblox manifest and transactional reconciliation](docs/adr/0002-declarative-roblox-manifest-and-transactions.md)
- [ADR 0003: Use deterministic orthogonal planning before learned architectural generation](docs/adr/0003-deterministic-orthogonal-architecture-planning.md)
- [ADR 0004: Use Roblox Studio MCP for the first live adapter](docs/adr/0004-use-studio-mcp-for-the-first-live-adapter.md)
- [ADR 0005: Chunk Studio mutations and recover uncertain transport by observation](docs/adr/0005-chunk-studio-mutations-and-recover-by-observation.md)
- [ADR 0006: Observe and evaluate playtests before automatic repair](docs/adr/0006-observe-playtests-before-automatic-repair.md)
- [WorldSpec v0.1 reference](docs/worldspec/0.1.0.md)
- [Roblox compiler v0.1 reference](docs/roblox-compiler/0.1.0.md)
- [Architecture Planner v0.1 reference](docs/architecture-planner/0.1.0.md)
- [Playtest Critic v0.1 reference](docs/playtest-critic/0.1.0.md)
- [Studio MCP Adapter v0.1 reference](docs/studio-mcp-adapter/0.1.0.md)
- [Studio MCP Adapter v0.2 reference](docs/studio-mcp-adapter/0.2.0.md)
- [Studio MCP transaction recovery runbook](docs/studio-mcp-adapter/recovery.md)
- [Studio MCP sandbox setup](docs/studio-mcp-adapter/sandbox-setup.md)

## Roadmap

1. **WorldSpec foundation** - schema, semantic validation, normalization, CLI, fixtures, tests, and
   repository quality gates (Milestone 0, complete).
2. **Transactional Roblox primitive compiler** - deterministic desired manifests, observed
   snapshots, dry-run change sets, pure simulation, and verified adapter transactions (Milestone 1,
   complete; offline only).
3. **Architectural blockout planner** - produce spatially coherent structure, floor, room, and route
   plans under constraints using a deterministic bounded topology (Milestone 2, complete; offline
   only).
4. **Studio MCP transaction bridge** - select one exact unsaved local Edit-mode sandbox, observe and
   verify managed state, apply confirmed change sets through fixed bridge actions, compensate
   safely, and record sanitized evidence (Milestone 3, complete).
5. **Chunked Studio transactions and reconnectable recovery** - partition a complete authorized
   Change Set into deterministic bounded chunks, poison uncertain clients, reconnect only to the
   exact Studio target and transaction-leased unsaved DataModel, classify lease-bound fresh state by
   exact prefix, and compensate conservatively to a verified base (Milestone 4, complete).
6. **Live playtest observation and critique** - exercise traversal and interactions under separate
   authorization, collect structured architectural evidence, and introduce the first narrow Critic
   without confusing a successful transaction with quality evaluation (Milestone 5, current
   implementation).
7. **Reference understanding** - extract evidence and style signals from images, plans, sketches,
   heightmaps, text, and existing places while preserving provenance.
8. **Reference-to-Mansion vertical slice** - integrate the system to produce and iteratively improve
   a complete mansion, interior, site, landscaping, lighting, interactions, and traversal.

Roadmap items after live architectural playtest observation describe direction, not current
capability. Visual evaluation, image understanding, automatic repair, and localized regeneration
remain future work.
