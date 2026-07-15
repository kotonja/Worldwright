# Worldwright repository guide

## Mission and vocabulary

Worldwright is an AI World Architect intended to turn human intent and references into coherent,
editable, testable, and performance-aware Roblox worlds. It is a world compiler, not a
text-to-random-parts or text-to-mesh toy.

- **Atlas** is the future reasoning and orchestration layer.
- **WorldSpec** is the versioned, JSON-serializable semantic world contract. The v0.1 foundation is
  the only one of these systems implemented in Milestone 0.
- **Forge** is the future Roblox Studio creator interface.
- **The Critic** is the future evaluation and localized-repair system.

Do not describe future systems as implemented.

## Sources of truth

- `packages/worldspec/src/schema.ts` is the source for the runtime TypeBox schema and derived static
  types.
- `packages/worldspec/schema/worldspec-0.1.0.schema.json` is generated. Never hand-edit it; use
  `pnpm schema:generate`, then verify with `pnpm schema:check`.
- Semantic invariants and stable diagnostic behavior belong in the validation layer, not in callers
  or prose-only rules.
- `docs/worldspec/0.1.0.md` documents the published v0.1 contract. Update it with every contract or
  behavior change.
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

- `pnpm format` — write Prettier formatting.
- `pnpm format:check` — check formatting without changing files.
- `pnpm lint` — run ESLint.
- `pnpm typecheck` — run strict TypeScript checks.
- `pnpm test` — run Vitest.
- `pnpm build` — compile with `tsc`.
- `pnpm test:dist` — smoke-test the compiled CLI, including its documented exit codes.
- `pnpm schema:generate` — regenerate the checked-in JSON Schema.
- `pnpm schema:check` — fail if the schema artifact has drifted.
- `pnpm worldspec <command>` — run the WorldSpec CLI, for example `pnpm worldspec validate ...`.
- `pnpm check` — run `format:check`, `lint`, `typecheck`, `test`, `schema:check`, `build`, and
  `test:dist` in that order.

## Engineering standards

- Use ESM, strict TypeScript, and explicit return types on public APIs.
- Use `unknown` plus narrowing for untrusted values. Do not use `any`; if a library makes it
  unavoidable, isolate it at the boundary and explain why.
- Keep functions small and preferably pure. Treat caller-owned inputs as readonly and never mutate
  them.
- Preserve exhaustive handling for discriminated unions.
- Keep schema errors separate from semantic errors and expose stable diagnostics instead of raw
  third-party error text.
- Generated schema, normalization, serialization, diagnostics, and machine-readable CLI output must
  be deterministic.
- Keep dependencies few and justified. Use plain `tsc`; do not add a bundler or monorepo task
  framework.

## Tests and documentation

- Every behavior change requires focused tests and corresponding documentation.
- Assert behavior and stable diagnostic codes directly; avoid large opaque snapshots.
- Cover valid input, malformed input, semantic edge cases, non-mutation, deterministic output,
  schema drift, and CLI exit codes as applicable.
- Before claiming completion, run `pnpm check`. Also run a narrower command while iterating when it
  gives faster feedback.
- Report every failed or skipped check honestly. Never claim a command passed unless it ran
  successfully.

## Security and privacy

- Never commit secrets, credentials, tokens, personal data, or private reference content.
- No hidden network calls, telemetry, or analytics.
- Do not add an AI provider, Roblox integration, external generation provider, database,
  authentication system, or production service without an explicit milestone authorizing it.
- WorldSpec is data only. Never accept or introduce arbitrary executable code, provider credentials,
  or chain-of-thought fields.
- Validate unknown external input before using it, and avoid exposing stack traces for expected user
  errors.

## Definition of done

A change is done only when its implementation, tests, generated artifacts, fixtures, and
documentation agree; `pnpm check` passes; generated and normalized output is deterministic; the diff
contains no unrelated files or secrets; and implemented versus future scope is stated accurately. If
any required check cannot run or fails, leave a clear record instead of declaring the work complete.
