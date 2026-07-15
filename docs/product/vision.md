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

The loop is a product direction. Milestone 0 implements its shared data foundation, not the
end-to-end loop.

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
Instance format.

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

Milestone 0 is **WorldSpec v0.1 and the Worldwright repository foundation**. It establishes a strict
machine-readable contract before any plugin, orchestrator, solver, generator, or compiler is built.
Its scope is intentionally narrow: schema and types, semantic validation, deterministic
normalization, CLI tooling, fixtures, tests, documentation, and automated quality checks.

## Current non-goals

Milestone 0 does not include:

- Atlas or AI orchestration;
- calls to OpenAI or another AI or generation provider;
- image, plan, sketch, heightmap, or existing-place understanding;
- spatial planning or constraint solving;
- asset routing, asset generation, or mesh generation;
- a Roblox compiler or Roblox Instance serialization;
- Forge, a Roblox Studio plugin, Luau code, or Studio/MCP integration;
- The Critic, visual inspection, gameplay testing, or automated repair;
- the complete Reference-to-Mansion vertical slice;
- a database, production service, web application, authentication, telemetry, or analytics; or
- licensing or commercial packaging decisions.

Those capabilities require explicit future milestones and must not be inferred from the presence of
the WorldSpec foundation.
