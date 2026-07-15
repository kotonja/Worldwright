# ADR 0003: Use deterministic orthogonal planning before learned architectural generation

- **Status:** Accepted
- **Date:** 2026-07-15

## Context

WorldSpec records semantic intent: entities, hierarchy, provenance, relationships, constraints,
locks, and budgets. The Roblox compiler records a separate desired engine representation and can
reconcile it transactionally with an abstract observed scene. Neither contract decides where rooms
belong, whether a corridor connects them, where an opening fits, or how an upper floor joins the
floor below.

Worldwright needs an architectural step between those boundaries. That step must turn an authored
room program into coherent spatial decisions that creators can inspect before any Roblox state is
considered. Its first implementation must also establish reliable invariants for containment,
non-overlap, dimensions, adjacency, avoidance, openings, stairs, and reachability. A learned
generator introduced before those invariants exist would make failure difficult to reproduce and
would make it unclear whether a result satisfied the authored program by design or by accident.

The repository does not yet contain a live Studio boundary, a reference-image understanding system,
Atlas orchestration, Forge review, or The Critic. Milestone 2 must not imply that any of those
future systems are present.

## Decision

Worldwright first implements a pure, offline, deterministic orthogonal architecture planner. Planner
version `0.1.0` supports one intentionally bounded topology: a centered, double-loaded straight
corridor, one rectangular room band on each side, rectangular rooms tiled along each band, and one
aligned rear stair core for multi-floor buildings.

The planner:

1. validates an unknown input as WorldSpec `0.1.0`;
2. extracts strict, versioned architecture directives from WorldSpec attribute maps;
3. converts grid-aligned horizontal dimensions to safe integer cells;
4. evaluates a finite, canonically ordered set of corridor, stair-side, sequence, and end-placement
   candidates with bounded deterministic search;
5. emits a separate Architecture Plan containing clear-space rectangles, logical walls, openings,
   stair runs, a circulation graph, exact metrics, and an integer score breakdown;
6. semantically re-evaluates that plan;
7. emits a deep-independent derived WorldSpec with honest generated provenance and only allowlisted
   Roblox primitive directives; and
8. compiles that derived WorldSpec through the existing public Roblox compiler as final offline
   verification.

Planning, evaluation, emission, and compilation remain data transformations. They perform no network
access and cause no live Roblox mutation.

## Why WorldSpec remains canonical

The Architecture Plan is a derived spatial artifact, not a replacement semantic model. WorldSpec
continues to own human intent, semantic identity, names, hierarchy, evidence, relationships,
constraints, locks, and budgets. Source room IDs remain the room placement IDs in the plan and the
semantic IDs in the derived WorldSpec.

Making the Architecture Plan canonical would force later planners to encode author intent in a
solver-specific layout representation and would erase the distinction between a requested room and
one selected rectangle. Instead, a plan records the exact canonical source WorldSpec hash that it
elaborates. Emission recomputes that hash and rejects stale or unrelated plans.

## Why planner directives use open attributes

WorldSpec `0.1.0` is already published as a closed semantic contract with explicitly open JSON-value
maps at `entity.attributes` and `relationship.attributes`. Architecture-specific configuration
belongs in those extension points under `worldwright.architecture`; adding fields directly to
WorldSpec entities would change the WorldSpec wire contract and couple every consumer to this one
planner.

The attribute maps are open, but the values beneath the planner key are not. Entity and relationship
directives are strict TypeBox contracts, use a `schemaVersion` discriminator, reject unknown fields,
and are accepted only on the matching WorldSpec kinds and relationships. This preserves WorldSpec
compatibility without turning planner behavior into an untyped convention.

## Why the Architecture Plan is a separate reviewable artifact

Room rectangles alone do not explain a building. A useful review artifact must expose the selected
corridor axis, band allocation, wall identities, every opening, stair dimensions, circulation edges,
hard-rule metrics, and the components of the selection score. Keeping those decisions in a strict
Architecture Plan makes them diffable, hashable, independently validatable, and suitable for future
Forge review.

The complete plan is not embedded in the derived WorldSpec. The structure stores only a compact
result record containing the source and plan hashes. This avoids duplicating a large derived
contract and leaves WorldSpec focused on semantic intent plus the entities needed by downstream
compilation.

## Why v0.1 supports one bounded topology

Architectural topology multiplies the hard cases in room packing, adjacency, circulation, wall
deduplication, opening placement, slabs, and stairs. Supporting L-shaped corridors, courtyards,
split levels, curved rooms, or multiple stair cores superficially would weaken every guarantee.

The double-loaded spine is broad enough to prove the complete planning pipeline while remaining
small enough to evaluate exhaustively within fixed bounds. Unsupported topologies fail explicitly.
Later topologies require versioned directive and plan-contract evolution plus their own geometry and
circulation tests.

## Why solving uses an integer grid

Horizontal planning decisions are combinatorial: a room consumes cells, dividers consume cells, and
the remaining band capacity must equal an exact total. Safe integer cells avoid tolerance-dependent
fit decisions and make pruning, area bounds, candidate signatures, and deterministic ordering
portable. Inputs that should align to the configured grid are rejected when they do not.

Stud values are recovered only after a candidate is selected. Vertical stair values may be
fractional because a fixed rise is divided by an integer step count; those calculations use finite,
checked arithmetic and documented tolerances where exact integer comparison is impossible.

## Why beam search is bounded and deterministic

Assigning rooms to either band and either sequence end grows exponentially. An unbounded exhaustive
search would let user-controlled programs consume unpredictable time. Planner v0.1 therefore uses a
fixed beam width and a finite candidate set. Hard-infeasible states are pruned first. Remaining
partial states are ordered by a deterministic capacity-balance heuristic—the absolute difference
between the two bands' assigned preferred-minus-minimum length slack—and then by canonical
signature. This heuristic is not an admissible lower bound on the final primary score. The
project-seed tie key is deliberately excluded from partial pruning and is applied only after
complete candidates tie on every non-seed score component.

The bound is part of planner behavior: it makes runtime practical and repeatable, although it also
means that an unusually difficult feasible program may be reported infeasible. The planner does not
claim global optimality.

## Why the seed only resolves equal-quality alternatives

The WorldSpec project seed contributes a SHA-256 tie key derived from the seed and canonical
candidate signature. It does not randomize candidate generation, perturb dimensions, or outrank a
better primary score. A different seed can choose a different plan only when every non-seed score
component is equal. The same document and seed therefore produce byte-identical canonical output.

## Why clear-space rectangles are distinct from wall volume

Room, corridor, and stair-hall rectangles describe usable clear space between wall faces. The outer
footprint describes the exterior faces of the exterior walls. Wall and slab thicknesses consume
separate volume and are included explicitly in capacity calculations.

This distinction prevents room rectangles from overlapping walls and makes actual clear area,
opening offsets, adjacency, and band tiling unambiguous. A sequence of rooms consumes the sum of its
clear lengths plus the divider thicknesses between them; a stair reservation also includes its
divider.

## Why logical walls precede wall-panel primitives

Adjacency and openings are architectural facts about complete wall segments, while Roblox requires
solid parts around empty openings. The planner therefore builds canonical logical walls first,
deduplicates them by geometry and adjacency identity, validates their openings, and only then
subtracts opening intervals into non-overlapping wall panels.

This ordering makes a required room-to-room door one opening in one shared divider rather than two
nearly coincident holes. It also permits an exact coverage invariant: panel area equals logical wall
area minus opening area, with zero-sized panels omitted.

## Why all circulation requires explicit openings

Touching rectangles are not proof of navigability. The plan contains an explicit undirected graph
whose edges come only from an exterior entrance door, room-to-corridor door, room-to-room door,
corridor-to-stair-hall opening, or stair run. Iterative graph search begins outside the entrance and
must reach every room, corridor, stair hall, and floor.

This prevents reports from claiming reachability based on geometric proximity or hierarchy alone.
Door openings remain empty blockout gaps in Milestone 2; no moving door, interaction script, or
gameplay behavior is implied.

## Why generated geometry receives honest provenance

A source entity may be observed in a reference while the geometry required to realize it remains
hidden. Generated walls, slabs, windows, steps, and landings are therefore classified as invented
deterministic blockout output. Relevant reference IDs may be carried from the nearest semantic
source, but generated notes must not imply that unobserved dimensions or interior arrangements were
seen in evidence.

## Why live Studio integration remains deferred

Milestone 2 ends with an offline Roblox Manifest and, where requested, a simulated change set from
an abstract snapshot. It adds no Studio adapter, Studio MCP transport, plugin, Forge UI, HTTP
service, deployment, authentication, database, or telemetry.

Live mutation introduces creator authorization, connection lifetime, engine API behavior,
ChangeHistoryService, concurrent edits, and operational recovery. Those concerns require an explicit
future milestone and must preserve the compiler's existing snapshot, stale-state, unmanaged-content,
verification, and compensation boundaries.

## Alternatives considered

### Generate architecture directly with a learned model

Rejected as the first planner. Learned generation may later propose programs, constraints, or
candidates, but it cannot substitute for explicit contracts and deterministic validation. Without
the bounded baseline, regressions and hard-rule failures would be difficult to reproduce.

### Generate Roblox primitives directly from the room program

Rejected. It would hide spatial decisions inside one-to-many emission, prevent plan review, and
collapse semantic intent, architecture, and engine representation into one step.

### Extend the closed WorldSpec entity schema with planning fields

Rejected for v0.1. The existing strict attribute extension point carries a separately versioned
directive without changing the published WorldSpec wire contract.

### Use floating-point continuous optimization

Rejected for horizontal v0.1 planning. It would introduce tolerance-sensitive fit and ordering
decisions where all supported dimensions are grid aligned. Continuous methods may be appropriate for
later curved or terrain-aware topologies under a new contract.

### Use greedy placement only

Rejected. A single greedy order is brittle in the presence of required adjacency, avoidance, two
bands, and a reserved stair core. Bounded beam search keeps several promising partial layouts while
retaining a fixed performance ceiling.

### Store only emitted WorldSpec geometry

Rejected. Generated primitives do not preserve the selected alternatives, logical-wall model,
circulation proof, score breakdown, or exact architectural metrics needed for review and repair.

## Consequences

### Positive

- One source program produces deterministic, reviewable layout and geometry artifacts.
- Hard requirements are evaluated explicitly rather than inferred from a plausible-looking model.
- WorldSpec and Roblox compiler `0.1.0` wire contracts remain unchanged.
- Source hashes prevent a reviewed plan from being emitted against changed intent.
- Bounded search and integer arithmetic give practical, reproducible performance.
- Logical walls and explicit openings provide stable foundations for later localized repair.
- The pipeline can be tested completely without Roblox Studio or an external service.

### Costs and constraints

- Planner v0.1 accepts only a narrow source profile and one rectangular topology.
- Rooms are rectangular, corridors are straight and centered, stairs are blockout approximations,
  and yaw is limited to quarter turns.
- A bounded beam can reject a feasible program that falls outside the retained search frontier.
- The output is a coherent blockout, not finished architectural design, code-compliant construction,
  finished visual art, or engine-verified gameplay traversal.
- Generated entity counts can be much larger than the authored program because every physical part
  remains an explicit compiler entity.
- Schema, fixture, documentation, and deterministic ordering changes must move together.

## Versioning implications

The entity directive, relationship directive, Architecture Plan, and planner implementation each
declare version `0.1.0`, but they are independently named contracts. Consumers reject unsupported
versions rather than coercing them.

- Documentation or implementation corrections that preserve accepted shape and semantics may use a
  patch release.
- New optional fields, topology values, or compatible domain variants require a new minor contract
  version and generated schema artifacts.
- Removed, renamed, narrowed, or reinterpreted fields require a major version.
- Changes to coordinate meaning, grid rounding, candidate ordering, beam width, score ordering, seed
  behavior, generated-ID derivation, wall canonicalization, circulation semantics, or hash inputs
  are semantic changes and must be versioned deliberately.
- WorldSpec and Roblox compiler versions remain independent. Architecture planning must continue to
  name and validate the exact versions it consumes and emits.

Future learned or reference-aware planning may propose inputs or alternatives around this boundary.
It must not silently change the meaning of an existing deterministic `0.1.0` plan.
