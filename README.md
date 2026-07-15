# Worldwright

Worldwright is an AI World Architect for compiling human intent and references into coherent,
editable, testable, and performance-aware Roblox worlds.

> **Status:** early foundational development. Milestone 0 establishes WorldSpec v0.1 and the
> repository toolchain; it does not yet generate or modify Roblox worlds.

## Product principles

- **Compile worlds, not isolated assets.** Spatial hierarchy, traversal, constraints, provenance,
  style, and budgets must remain connected.
- **Keep intent machine-readable.** A strict, versioned semantic contract lets independent systems
  exchange plans without relying on prompt-shaped objects.
- **Be honest about evidence.** WorldSpec distinguishes observed, inferred, and invented
  information.
- **Preserve editability.** Future compilation should produce Roblox-native content that creators
  can inspect and revise.
- **Repair locally.** Locks and semantic boundaries are foundations for improving one area without
  needlessly rebuilding the rest.
- **Treat quality and performance as correctness.** Traversal, visual coherence, and device budgets
  are not optional finishing steps.
- **Prefer deterministic foundations.** Validation, normalization, serialization, schema generation,
  and CLI output are reproducible.

## Implemented scope

Milestone 0 provides:

- the strict TypeBox source schema for WorldSpec `0.1.0` and its deterministic draft 2020-12 JSON
  Schema artifact;
- static TypeScript types derived from the runtime schema;
- schema and semantic validation with structured, stable diagnostics;
- deterministic, non-mutating normalization and serialization;
- a dependency-light CLI for validation, normalization, and schema output;
- a semantic neo-gothic cliffside mansion fixture plus focused invalid fixtures;
- tests for the schema, semantic invariants, normalization, schema drift, and CLI behavior; and
- an ESM, strict-TypeScript pnpm workspace with formatting, linting, build, test, and CI checks.

## Not implemented yet

Atlas orchestration, planners, constraint solving, asset routing or generation, the Roblox compiler,
the Forge Studio interface, The Critic, Studio/MCP integration, and the Reference-to-Mansion
vertical slice are future work. This repository currently makes no external generation or AI calls
and contains no Roblox integration, production service, database, authentication, telemetry, or
analytics.

## Repository structure

```text
.
├── .github/workflows/ci.yml
├── docs/
│   ├── adr/0001-worldspec-as-canonical-contract.md
│   ├── architecture/system-overview.md
│   ├── product/vision.md
│   └── worldspec/0.1.0.md
├── packages/worldspec/
│   ├── fixtures/             # Valid and intentionally invalid examples
│   ├── schema/               # Generated JSON Schema artifact
│   ├── scripts/              # Schema generation and drift checks
│   ├── src/                  # Schema, validation, normalization, API, CLI
│   └── test/                 # Unit and CLI integration tests
├── AGENTS.md
├── package.json
├── pnpm-lock.yaml
└── pnpm-workspace.yaml
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

| Command                | Purpose                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `pnpm format`          | Format supported files with Prettier.                                                  |
| `pnpm format:check`    | Check formatting without writing changes.                                              |
| `pnpm lint`            | Run ESLint.                                                                            |
| `pnpm typecheck`       | Type-check all workspace packages.                                                     |
| `pnpm test`            | Run the Vitest suite.                                                                  |
| `pnpm build`           | Compile packages with `tsc`.                                                           |
| `pnpm test:dist`       | Smoke-test the compiled WorldSpec CLI and its exit codes.                              |
| `pnpm schema:generate` | Regenerate the checked-in WorldSpec JSON Schema.                                       |
| `pnpm schema:check`    | Check the generated schema for drift.                                                  |
| `pnpm worldspec`       | Run the WorldSpec CLI.                                                                 |
| `pnpm check`           | Run format, lint, type, tests, schema drift, build, then the compiled-CLI smoke check. |

`pnpm test:dist` launches the emitted `dist/cli.js` directly and verifies the documented valid,
invalid, and usage exit paths. Run `pnpm build` first; `pnpm check` does so automatically.

CI runs `pnpm check` with Node.js 22 for pull requests, pushes to `main`, and manual dispatches.
Concurrency cancellation replaces superseded runs for the same pull request or branch.

## WorldSpec CLI

Validate the reference fixture:

```sh
pnpm worldspec validate packages/worldspec/fixtures/valid/reference-mansion.worldspec.json
```

Return stable JSON diagnostics for automation:

```sh
pnpm worldspec validate path/to/world.worldspec.json --json
```

Normalize to standard output or to an explicitly selected file:

```sh
pnpm worldspec normalize path/to/world.worldspec.json
pnpm worldspec normalize path/to/world.worldspec.json --output path/to/normalized.worldspec.json
```

Print the generated schema:

```sh
pnpm worldspec schema
```

See the [WorldSpec v0.1 reference](docs/worldspec/0.1.0.md) for the contract, diagnostics,
normalization rules, and CLI exit codes.

## Documentation

- [Product vision](docs/product/vision.md)
- [System overview](docs/architecture/system-overview.md)
- [ADR 0001: WorldSpec is the canonical cross-system contract](docs/adr/0001-worldspec-as-canonical-contract.md)
- [WorldSpec v0.1 reference](docs/worldspec/0.1.0.md)

## Roadmap

1. **WorldSpec foundation** — schema, semantic validation, normalization, CLI, fixtures, tests, and
   repository quality gates (Milestone 0).
2. **Transactional Roblox primitive compiler** — compile a bounded WorldSpec subset into reversible
   Roblox-native primitive operations.
3. **Architectural blockout planner** — produce spatially coherent structure, floor, room, and route
   plans under constraints.
4. **Studio MCP closed-loop testing** — observe compiled results, exercise them in Studio, and feed
   structured findings back into repair.
5. **Reference understanding** — extract evidence and style signals from images, plans, sketches,
   heightmaps, text, and existing places while preserving provenance.
6. **Reference-to-Mansion vertical slice** — integrate the system to produce and iteratively improve
   a complete mansion, interior, site, landscaping, lighting, interactions, and traversal.

Roadmap items after the WorldSpec foundation describe direction, not current capability.
