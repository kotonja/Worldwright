# Worldwright

Worldwright is an AI World Architect for compiling human intent and references into coherent,
editable, testable, and performance-aware Roblox worlds.

> **Status:** Milestones 0 and 1 are complete. Milestone 2 is the current implementation: a
> deterministic architectural blockout planner that compiles a bounded room program through the
> existing offline Roblox pipeline. There is no live Roblox Studio integration.

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

## Not implemented yet

There is no live Roblox Studio adapter, Studio MCP connectivity, plugin, Forge interface,
ChangeHistoryService integration, or CLI apply command. Atlas orchestration, learned or
reference-image architectural generation, asset routing or generation, The Critic, and a polished
Reference-to-Mansion vertical slice remain future work.

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
|   |   `-- 0003-deterministic-orthogonal-architecture-planning.md
|   |-- architecture/
|   |   |-- architecture-planner.md
|   |   |-- roblox-compiler.md
|   |   `-- system-overview.md
|   |-- architecture-planner/0.1.0.md
|   |-- product/vision.md
|   |-- roblox-compiler/0.1.0.md
|   `-- worldspec/0.1.0.md
|-- packages/
|   |-- architecture-planner/
|   |   |-- fixtures/             # Authored program and generated pipeline artifacts
|   |   |-- schema/               # Generated architecture directive and plan schemas
|   |   |-- scripts/              # Schema, fixture, and compiled-CLI checks
|   |   |-- src/                  # Profile, solver, geometry, evaluation, emission, CLI
|   |   `-- test/                 # Contract, solver, geometry, pipeline, and CLI tests
|   |-- roblox-compiler/
|   |   |-- fixtures/             # Canonical WorldSpec, manifest, snapshot, and plan examples
|   |   |-- schema/               # Generated directive and compiler-contract schemas
|   |   |-- scripts/              # Schema, fixture, and compiled-CLI drift/smoke checks
|   |   |-- src/                  # Compile, validate, plan, simulate, transact, CLI
|   |   `-- test/                 # Unit, integration, transaction, and CLI tests
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

| Command                     | Purpose                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm format`               | Format supported files with Prettier.                                                              |
| `pnpm format:check`         | Check formatting without writing changes.                                                          |
| `pnpm lint`                 | Run ESLint.                                                                                        |
| `pnpm typecheck`            | Build dependencies, then type-check all workspace packages.                                        |
| `pnpm test`                 | Build dependencies, then run all Vitest suites.                                                    |
| `pnpm build`                | Compile all workspace packages with `tsc`.                                                         |
| `pnpm test:dist`            | Build and smoke-test compiled CLIs and their documented exit codes.                                |
| `pnpm schema:generate`      | Regenerate schemas for every package that owns schema artifacts.                                   |
| `pnpm schema:check`         | Check all generated schemas for drift.                                                             |
| `pnpm fixture:generate`     | Regenerate deterministic artifacts for every fixture-owning package.                               |
| `pnpm fixture:check`        | Fail when any generated fixture artifact differs from its deterministic generator output.          |
| `pnpm worldspec`            | Run the WorldSpec CLI.                                                                             |
| `pnpm roblox-compiler`      | Run the offline Roblox compiler CLI.                                                               |
| `pnpm architecture-planner` | Run the offline architectural blockout planner CLI.                                                |
| `pnpm check`                | Run formatting, lint, build, type, tests, schema and fixture drift, and distribution smoke checks. |

The root fixture commands currently cover generated artifacts owned by the Roblox compiler and
Architecture Planner. Authored fixture inputs remain unchanged and are never generated.

CI runs `pnpm check` with Node.js 22 for pull requests, pushes to `main`, and manual dispatches.
Generated `dist` directories remain uncommitted; deterministic schema and fixture artifacts are
checked in.

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

## Documentation

- [Product vision](docs/product/vision.md)
- [System overview](docs/architecture/system-overview.md)
- [Roblox compiler architecture](docs/architecture/roblox-compiler.md)
- [Architecture planner](docs/architecture/architecture-planner.md)
- [ADR 0001: WorldSpec is the canonical cross-system contract](docs/adr/0001-worldspec-as-canonical-contract.md)
- [ADR 0002: Use a declarative Roblox manifest and transactional reconciliation](docs/adr/0002-declarative-roblox-manifest-and-transactions.md)
- [ADR 0003: Use deterministic orthogonal planning before learned architectural generation](docs/adr/0003-deterministic-orthogonal-architecture-planning.md)
- [WorldSpec v0.1 reference](docs/worldspec/0.1.0.md)
- [Roblox compiler v0.1 reference](docs/roblox-compiler/0.1.0.md)
- [Architecture Planner v0.1 reference](docs/architecture-planner/0.1.0.md)

## Roadmap

1. **WorldSpec foundation** - schema, semantic validation, normalization, CLI, fixtures, tests, and
   repository quality gates (Milestone 0, complete).
2. **Transactional Roblox primitive compiler** - deterministic desired manifests, observed
   snapshots, dry-run change sets, pure simulation, and verified adapter transactions (Milestone 1,
   complete; offline only).
3. **Architectural blockout planner** - produce spatially coherent structure, floor, room, and route
   plans under constraints using a deterministic bounded topology (Milestone 2, current
   implementation; offline only).
4. **Studio MCP closed-loop testing** - implement a separately authorized live adapter, observe
   compiled results, exercise them in Studio, and feed structured findings into repair.
5. **Reference understanding** - extract evidence and style signals from images, plans, sketches,
   heightmaps, text, and existing places while preserving provenance.
6. **Reference-to-Mansion vertical slice** - integrate the system to produce and iteratively improve
   a complete mansion, interior, site, landscaping, lighting, interactions, and traversal.

Roadmap items after the architectural blockout planner describe direction, not current capability.
