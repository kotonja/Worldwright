# Worldwright product vision

## Core promise

Worldwright is an AI World Architect for Roblox Studio. Its goal is to turn natural-language intent,
reference images, plans, sketches, heightmaps, and existing places into coherent, attractive,
functional, editable, and performance-aware worlds.

The promise is larger than producing a mesh or scattering plausible parts. A world has hierarchy,
routes, sight lines, repeated motifs, authored exceptions, gameplay needs, device limits, and
relationships between spaces. Worldwright must understand and preserve those connections while a
creator iterates.

## A world compiler, not a text-to-mesh generator

A text-to-mesh generator can return an isolated asset without understanding what surrounds it. A
world compiler must retain semantics from intent through implementation:

- what a place is for;
- how regions, structures, floors, rooms, routes, and objects relate;
- which details came from a reference and which were inferred or invented;
- which requirements are hard constraints and which are preferences;
- which areas the creator locked against change;
- how players traverse and interact with the result; and
- what performance envelope the target devices require.

This compiler framing makes generation inspectable and repairable. It also creates boundaries
between reasoning, planning, compilation, and evaluation so that each can evolve without passing
unstructured prompt fragments to the next.

## The closed loop

Worldwright is intended to operate as a repeated loop:

1. **Understand** — interpret intent and references, record evidence, and distinguish observed facts
   from inferred or invented completion.
2. **Plan** — produce a semantic hierarchy, spatial relationships, constraints, style decisions,
   budgets, and locks.
3. **Build** — compile the plan into editable Roblox-native content.
4. **Observe** — inspect the actual result rather than assuming compilation produced the intended
   experience.
5. **Test** — exercise traversal, interactions, architectural rules, and performance targets.
6. **Critique** — compare the observed world against intent, references, constraints, quality
   targets, and budgets.
7. **Repair** — make localized changes, respect locks, and return to observation and testing.

The loop is a product direction. Milestone 0 implements the WorldSpec and canonical semantic-data
foundation. Milestone 1 implements the offline manifest, snapshot, change-set, simulation,
transaction, and in-memory adapter boundary for a bounded primitive subset. Milestone 2 implements
the offline deterministic architectural blockout planner. These three foundations still do not
constitute the complete live loop: no Roblox Studio connection or observation, gameplay execution,
visual critique, or automated repair has occurred.

## System vocabulary

### Atlas

Atlas will be the reasoning and orchestration layer. It will coordinate understanding, planning,
specialized workers, evaluation, and repair. Atlas is future work.

### WorldSpec

WorldSpec is the versioned, JSON-serializable semantic representation of a world. It records project
intent, references, Style DNA, entity hierarchy, provenance, relationships, constraints, locks, and
budgets. It is the canonical contract between current and future Worldwright components.

Milestone 0 implements WorldSpec v0.1 schema generation, validation, normalization, serialization,
diagnostics, a CLI, fixtures, and tests. WorldSpec v0.1 is a semantic plan, not a geometry or Roblox
Instance format. The Milestone 1 compiler and Milestone 2 Architecture Planner consume it through
public package APIs without changing its `0.1.0` wire contract.

### Roblox Manifest, Scene Snapshot, and Change Set

The Roblox Manifest is the complete desired Worldwright-managed state compiled from one WorldSpec
document. The Scene Snapshot is observed managed state for one project and records direct unmanaged
child roots that Worldwright must protect. The Change Set is a deterministic, reviewable dry-run
transition from one exact snapshot to one exact desired manifest.

Milestone 1 implements strict `0.1.0` contracts for these representations, an allowlisted primitive
compiler, pure planning and simulation, an abstract transaction executor, and an in-memory test
adapter. These are safe offline foundations for future Studio integrations; they do not create or
modify Roblox Instances in a live place.

### Architecture Planner

`@worldwright/architecture-planner` is the Milestone 2 offline deterministic blockout planner. It
consumes a narrow, explicit WorldSpec architectural profile, produces a separate source-bound
Architecture Plan, and emits a compiler-ready derived WorldSpec containing deterministic Roblox
blockout primitives. Its implemented topology is bounded `double_loaded_spine` planning. It does not
infer architecture from images or unconstrained prose and does not connect to or modify Roblox
Studio.

### Forge

Forge will be the creator-facing interface in Roblox Studio. It should present plans and changes in
creator terms, support review and local regeneration, expose locks, and keep results editable. Forge
is future work.

### The Critic

The Critic will evaluate visual quality, architecture, gameplay, traversal, and performance against
the WorldSpec and observed Roblox world. Its findings will guide localized repair instead of
indiscriminate regeneration. The Critic is future work.

## Flagship vertical slice: Reference-to-Mansion

The first flagship vertical slice will take text and reference images and produce a complete mansion
experience: coherent site placement, exterior massing, logical floors and rooms, circulation,
landscaping, lighting, interactions, and traversable gameplay space.

This slice is intentionally demanding. A convincing facade alone is insufficient. The interior must
relate to the exterior, stairs and routes must work, hidden geometry must be labeled as inferred or
invented rather than observed, the site must support the building, and the result must fit Roblox
performance constraints. Creators must be able to protect successful areas and regenerate a local
problem without losing unrelated work.

The checked-in reference mansion WorldSpec fixture demonstrates the shape of a semantic plan for
this future slice. It is not a generated mansion and does not imply that the vertical slice is
implemented.

The separate Cliffwatch mansion fixture is an implemented Milestone 2 architectural-program and
blockout fixture. It begins with explicit architecture directives and proves the deterministic
offline path through an Architecture Plan, derived WorldSpec, compiler output, reconciliation, and
simulation. It does not understand reference media and does not include finished art, facade
reconstruction, landscaping, lighting, interactions, gameplay validation, or live Studio
observation.

## Non-negotiable qualities

- **Editability:** output should remain Roblox-native and creator-owned, not an opaque terminal
  artifact.
- **Semantic understanding:** systems must operate on meaningful entities and relationships, not
  anonymous geometry alone.
- **Local regeneration:** repair should target the smallest useful region while honoring explicit
  locks and preserved intent.
- **Visual quality:** composition, style coherence, material language, lighting, and detail
  hierarchy must be evaluated, not assumed.
- **Traversal:** spaces, routes, clearances, entrances, stairs, and interactions must work for
  players.
- **Roblox performance:** target devices, streaming strategy, and content budgets must shape plans
  and compilation.
- **Provenance honesty:** observed, inferred, and invented details must remain distinguishable.

## Current milestone

Milestone 0, **WorldSpec v0.1 and the Worldwright repository foundation**, is complete. It
established the strict machine-readable semantic contract, validation, deterministic normalization,
CLI tooling, fixtures, tests, documentation, and automated quality checks.

Milestone 1, **the transactional Roblox primitive compiler**, is complete. It compiles explicitly
directed WorldSpec entities into a deterministic desired manifest, reconciles that manifest against
an observed snapshot, produces and simulates a dry-run change set, and executes that plan through an
abstract adapter with result verification and snapshot-based rollback.

Milestone 2, **the deterministic architectural blockout planner**, is the current implemented
milestone on this branch. It adds deterministic integer-grid architectural planning, separate
reviewable Architecture Plans, walls, doors, windows, aligned stairs, explicit circulation,
compiler-ready WorldSpec emission, compiler verification, and offline reconciliation and simulation.
Its output is a coherent architectural blockout, not finished visual art. The only implemented
adapter remains the in-memory test adapter.

## Current repository non-goals

The implemented bounded Architecture Planner does not include:

- arbitrary, broader, or learned architectural topology generation beyond its bounded
  `double_loaded_spine` profile;
- reference-image, plan, sketch, heightmap, unconstrained-prose, or existing-place understanding;
- facade reconstruction, roofs, terrain, furnishings, lighting, landscaping, or polished art;
- asset routing, asset generation, mesh generation, terrain editing, or asset insertion;
- Atlas, AI orchestration, or calls to OpenAI or another generation provider;
- arbitrary Roblox class or property support, Roblox Instance serialization, or executable Luau;
- a live Roblox Studio adapter, Studio MCP connectivity, Forge, a Studio plugin, or
  ChangeHistoryService integration;
- live traversal, interaction, or gameplay testing;
- The Critic, visual inspection, localized automated repair, or the complete Reference-to-Mansion
  vertical slice;
- databases, production services, web applications, authentication, deployment, telemetry, or
  analytics; or
- licensing or commercial packaging decisions.

Those capabilities require later explicitly authorized milestones. The current repository proves
deterministic offline semantic, planning, compiler, transaction, and simulation boundaries against
an in-memory adapter; it makes no claim that Roblox Studio was connected to, observed, or modified.
