# ADR 0001: WorldSpec is the canonical cross-system contract

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

Worldwright will eventually coordinate reference understanding, reasoning, spatial planning,
constraint solving, asset generation, Roblox compilation, a creator-facing Studio interface,
evaluation, and localized repair. Those systems may run in different languages and processes and
will evolve at different rates.

Passing prose prompts or provider-specific objects directly between them would hide assumptions,
make failures difficult to diagnose, and allow the meaning of a world to fragment across components.
Generating Roblox objects immediately would also discard important information about intent,
provenance, constraints, locks, and performance budgets before planning and evaluation can use it.

The system therefore needs one strict, versioned, machine-readable semantic representation before
those components are built.

## Decision

WorldSpec is the canonical cross-system contract for semantic world plans.

For version `0.1.0`:

- the wire representation is JSON;
- the schema identifier is `urn:worldwright:worldspec:0.1.0`;
- TypeBox is the source for the runtime schema and derived TypeScript types;
- a deterministic draft 2020-12 JSON Schema artifact is checked into the repository for
  language-neutral consumers;
- all defined domain objects are closed with `additionalProperties: false`;
- only explicitly named JSON-compatible extension maps, such as `attributes` and `parameters`, are
  open-ended;
- validation has a portable schema phase and a separate semantic phase;
- callers receive stable structured diagnostics rather than raw Ajv error messages;
- normalization and serialization are deterministic and do not mutate caller input; and
- provenance explicitly distinguishes `observed`, `inferred`, and `invented` information.

WorldSpec describes semantic intent and organization. It is not a generated mesh format, Roblox
Instance dump, executable plan, AI trace, or credentials container.

## Why JSON-serializable data is mandatory

The contract must cross package, process, language, tool, log, fixture, and version-control
boundaries. JSON provides a small, widely supported interchange model that future TypeScript,
Python, and Luau-facing tooling can implement without sharing runtime objects.

Restricting WorldSpec to JSON values also makes documents inspectable, diffable, cacheable,
hashable, testable, and deterministic. Functions, symbols, class instances, `Date`, `BigInt`,
`undefined`, `NaN`, and infinities either have ambiguous behavior or cannot survive a JSON round
trip faithfully; accepting them in memory would make library behavior differ from file behavior.
They are therefore invalid WorldSpec values.

JSON compatibility does not mean arbitrary shape. Domain objects remain closed and versioned so that
misspellings and unsupported fields fail visibly instead of being silently ignored.

## Why schema and semantic validation are separate

JSON Schema is the correct portable mechanism for local structure: required properties, closed
objects, primitive types, enumerations, identifier patterns, array cardinality, and numeric ranges.
Keeping these rules in the generated artifact lets non-TypeScript consumers validate the same
document shape.

Graph-wide invariants are a different concern. Global identifier uniqueness, root correctness,
acyclic parent chains, reachability, and cross-reference integrity depend on multiple locations in a
document. Encoding all of those constraints in JSON Schema would be infeasible,
implementation-specific, or much harder to understand and maintain.

WorldSpec validation therefore runs in two phases:

1. schema validation establishes that the value has the v0.1 shape; and
2. semantic validation evaluates cross-document invariants on schema-valid data.

The phases remain distinguishable through diagnostic codes. Public callers never need to parse Ajv
prose to decide what failed.

## Alternatives considered

### Pass natural language and prompts between components

Rejected. Prose is valuable as an input but is not a stable contract. It cannot reliably express
hierarchy, provenance, constraints, locks, referential integrity, or deterministic change review.

### Use Roblox Instances or a place file as the canonical model

Rejected. That representation is too late in the pipeline, couples every producer to Roblox, and
loses the distinction between user intent, planning decisions, and compiled output. It is also a
poor interchange format for future non-Roblox planners and evaluation services.

### Make TypeScript interfaces the only contract

Rejected. Interfaces are erased at runtime, do not validate untrusted input, and do not provide a
language-neutral artifact. TypeBox allows one runtime schema to derive TypeScript types and
deterministic JSON Schema.

### Use an unrestricted JSON document

Rejected. Open domain objects would turn typos and unsupported behavior into silently accepted data
and would make compatibility claims meaningless. Extensibility is limited to clearly named
JSON-value maps.

### Put all validation in JSON Schema

Rejected. Cross-document graph invariants are clearer, more testable, and more portable as a second
semantic pass with stable diagnostics.

### Adopt a binary serialization format first

Rejected for v0.1. A binary format would add tooling and compatibility costs before document scale
justifies them, while making review and fixtures less approachable. A later transport may encode
equivalent WorldSpec data, but it must not silently become a different semantic contract.

## Consequences

### Positive

- Current and future components share explicit vocabulary and versioned behavior.
- Untrusted documents can be rejected at system boundaries with machine-readable diagnostics.
- Checked-in fixtures and schema artifacts support multiple languages and review workflows.
- Deterministic normalization makes diffs, caching, testing, and repeat execution reliable.
- Provenance prevents inferred or invented completion from being misrepresented as observed
  evidence.
- Locks and semantic IDs provide foundations for local regeneration and repair.

### Costs and constraints

- Schema changes require coordinated implementation, tests, documentation, fixture, and
  generated-artifact updates.
- Producers must supply hierarchy and references that pass semantic validation rather than emitting
  partial arbitrary objects.
- Closed objects require deliberate versioned extensions.
- WorldSpec does not eliminate component-specific internal models; it defines what crosses system
  boundaries.
- The v0.1 model is intentionally incomplete for geometry, compilation, and evaluation and will need
  compatible evolution.

## Versioning implications

`schemaVersion` is required in every document and must match the schema being validated. The schema
ID and checked-in artifact are version-specific.

- Patch releases may clarify documentation or correct behavior without changing the accepted
  document shape or meaning.
- Backward-compatible additions require at least a minor WorldSpec version and a new schema
  artifact.
- Removal, renaming, reinterpretation, or narrowing of accepted data requires a major version.
- A consumer must not silently coerce an unsupported version into the current one.
- Future migrations must be explicit, deterministic, tested, and preserve intent; they are not part
  of v0.1.

Because domain objects are closed, even an optional new field changes the schema and must follow the
versioning process. Generated schema drift is a failing check, ensuring that the source schema and
published artifact cannot diverge unnoticed.
