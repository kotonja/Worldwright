# ADR 0006: Observe and evaluate playtests before automatic repair

- **Status:** Accepted
- **Date:** 2026-07-17

## Context

Milestones 1 through 4 established a bounded path from validated semantic input to a deterministic
Roblox Manifest, an exact Change Set, and verified managed state in one unsaved Studio DataModel.
The Studio adapter now requires exact session selection, an unsaved stopped sandbox, complete
snapshot checks, transaction-scoped Workspace leasing, fixed mutation programs, and conservative
recovery. Those controls are sufficient to observe a built world without widening the mutation
boundary.

Worldwright still lacks evidence that an avatar can traverse the architecture it emitted. A valid
room rectangle or a successful compiler transaction does not prove that PathfindingService can find
a route, that Studio navigation reaches the target, that the character remains alive and supported,
or that the world returns to its exact Edit state after Play. Visual evaluation is also premature:
the first useful Critic should establish architectural and functional facts before judging style.

The Architecture Plan already supplies deterministic clear rectangles, explicit openings,
circulation edges, floor elevations, and stair runs. It is therefore the appropriate source for
repeatable checkpoints and routes. The Roblox Manifest separately identifies the exact desired
managed world that must already exist in Studio.

One provenance limit must remain explicit. The Architecture Plan hashes the authored source
WorldSpec, while the Manifest hashes the planner-emitted derived WorldSpec. The closed Manifest
contract does not carry the Architecture Plan hash or the authored source hash. Plan plus Manifest
can therefore prove exact artifact identity and complete semantic and geometry correspondence, but
cannot provide a cryptographic proof that one was derived from the other. Milestone 5 binds both
canonical hashes, rejects mismatched project, root, source, semantic, and geometry evidence, and
does not describe that structural proof as cryptographic derivation proof.

## Decision

Worldwright adds `@worldwright/playtest-critic` version `0.1.0` and an additive playtest boundary in
`@worldwright/studio-mcp-adapter`. Together they implement a deterministic build-test-evaluate loop
for one supported solo architectural traversal.

### Plan traversal from semantic architecture

A Playtest Plan is a strict, versioned artifact derived from one validated Architecture Plan and one
validated Roblox Manifest. Planning verifies exact artifact hashes and complete structural
correspondence, then derives safe checkpoints from room, corridor, opening, stair-hall, and landing
geometry. It builds a graph only from explicit circulation evidence and visits required targets in
the documented deterministic order through iterative breadth-first search.

Rectangle contact never creates circulation. A room is not counted as covered because its rectangle
exists or because its checkpoint was generated; coverage requires independently observed arrival
during the run.

### Separate path, navigation, and arrival evidence

Every scored segment receives one PathfindingService preflight followed, only on path success, by at
most one `character_navigation` request. The navigation response is transport evidence, not arrival
proof. A fixed Server-side player-state observation independently checks position, tolerances,
velocity, health, humanoid state, support, and floor assignment. Clearance is observed separately
after arrival.

This separation distinguishes three materially different failures: no path exists, the movement
request did not produce arrival, or the character arrived in an unsafe state. Blind navigation retry
is prohibited because it would erase the evidence associated with the original request.

### Keep setup narrow and outside the score

One fixed play-only setup action pivots the single local test character to the plan's exterior setup
position and zeros assembly velocity. It may not create an Instance, alter managed architecture,
write a script or Workspace attribute, change the sandbox lease, or alter health. Setup is verified
but excluded from traversal scoring because it is an instrumentation step, not evidence that the
avatar traversed from an arbitrary Roblox spawn.

### Bound and sanitize evidence

Console observations are collected at bounded phases, differenced against a baseline, and retained
in strict reports only as severity, source classification, deterministic message digest, and
new-versus-baseline status. Raw output remains ignored local evidence because it may contain paths,
stack traces, names, control characters, or user text. Ambiguous or truncated differencing becomes
`console_evidence_incomplete`; it cannot silently mean zero new errors.

Viewport captures are bounded, validated JPEG evidence. Reports contain only checkpoint identity,
media type, hash, and byte length. Image bytes remain ignored and receive no visual score in this
milestone.

### Verify start, Stop, and Edit integrity independently

Worldwright confirms the complete Playtest Plan hash, selects the exact Studio, verifies the private
sandbox lease, proves the desired Manifest is already a no-op, and records the complete pre-play
Edit snapshot hash before starting Play. It issues one normal start request and resolves an
uncertain response through observed state and the fixed Server identity probe, never through a blind
retry.

After Worldwright has proved ownership of the running simulation, a Stop attempt runs in a `finally`
path. An uncertain Stop may receive one additional observed-state-based Stop only after the exact
run identity is reverified. Success requires Studio to return to Edit, the same lease-bound managed
snapshot hash to equal the pre-play hash exactly, and final Manifest reconciliation to remain a
no-op. Roblox Studio's ordinary reset behavior is not sufficient proof by itself.

### Localize findings without repairing

The pure Critic evaluates a strict Playtest Run Report and emits deterministic error or warning
findings tied to semantic source, checkpoint, segment, opening, floor, wall, corridor, or stair IDs.
Suggestion codes are review hints only. Milestone 5 does not emit a WorldSpec edit, Architecture
Plan, Manifest, Change Set, Studio mutation, or automatic repair.

## Alternatives considered

### Infer traversability from generated geometry

Rejected. Static clear rectangles and opening arithmetic are valuable preconditions but do not
exercise Roblox pathfinding, humanoid movement, collisions, support, or play-mode reset behavior.

### Treat PathfindingService success as traversal success

Rejected. A path can exist while navigation or arrival fails. Both requested movement and
independent arrival evidence are required.

### Trust `character_navigation` acknowledgment

Rejected. A response can be uncertain or can acknowledge a request that does not end inside the plan
tolerances. Player state is observed independently and the movement request is never blindly
repeated.

### Drive the character through keyboard or mouse input

Rejected. UI and arbitrary input simulation would widen the privileged surface and make traversal
dependent on focus, camera, controls, and timing. Milestone 5 uses only exact world-position
navigation.

### Score setup as traversal

Rejected. The controlled pivot exists to remove spawn placement from the architectural experiment.
Counting it as movement would overstate coverage.

### Store raw console output or screenshots in reports

Rejected. Raw logs and image bytes are private, potentially large, and unnecessary for deterministic
machine evaluation. Strict reports carry bounded digests and metadata.

### Trust Studio's normal Stop reset

Rejected. Reset behavior is not evidence that this exact leased DataModel returned to the exact
pre-play managed state. A post-play bound snapshot and hash comparison remain mandatory.

### Generate a repair immediately from each finding

Deferred. The first Critic establishes trustworthy, localized evidence. Repair authorization,
planning, review, and transaction semantics belong to a later milestone.

### Claim cryptographic Plan-to-Manifest derivation from structural correspondence

Rejected. Existing closed contracts do not carry that proof. Milestone 5 states the exact structural
proof boundary and binds both artifact hashes without overstating provenance.

## Consequences

### Positive

- Worldwright can distinguish static design validity from live architectural traversal.
- Every required room, floor, opening, corridor, and stair is evaluated through explicit evidence.
- Path existence, movement request, arrival, survival, support, and clearance remain separate facts.
- Start, navigation, and Stop uncertainty are resolved through bounded observation rather than blind
  retries.
- Strict reports are deterministic, portable, and free of raw Studio, account, lease, path, and
  image data.
- Findings are localized enough for later reviewed repair planning without granting repair authority
  now.

### Costs and constraints

- A complete run requires many bounded path, navigation, state, and clearance calls.
- The supported profile is one solo character in the current bounded blockout topology.
- Environment and Roblox pathfinding behavior can reveal failures not present in offline fixtures.
- A missing or incompatible playtest capability blocks the live controller but does not block the
  core Studio transaction adapter.
- Plan plus Manifest source binding is exact and structural, not cryptographic derivation proof.
- A failed Stop or post-play hash mismatch leaves the run failed even when earlier traversal passed.

## Versioning implications

Milestone 5 adds these contracts without changing existing WorldSpec, Architecture Plan, Roblox
compiler, Studio bridge, receipt, batch, lease, progress, or transport meanings:

- `urn:worldwright:playtest-plan:0.1.0`
- `urn:worldwright:playtest-run-report:0.1.0`
- `urn:worldwright:critic-report:0.1.0`
- `urn:worldwright:studio-playtest-probe-request:0.1.0`
- `urn:worldwright:studio-playtest-probe-response:0.1.0`

The Studio adapter package may advance to `0.3.0`; persisted managed-node adapter metadata retains
its existing `0.1.0` meaning. Changes to checkpoint coordinates, route ordering, agent constants,
evidence semantics, hard rules, or finding ordering require an intentional contract-version
decision. Automatic repair requires a separate future decision.

## Primary references

- [Roblox Studio MCP server](https://create.roblox.com/docs/studio/mcp)
- [Roblox Studio testing modes](https://create.roblox.com/docs/studio/testing-modes)
- [PathfindingService](https://create.roblox.com/docs/reference/engine/classes/PathfindingService)
- [Path](https://create.roblox.com/docs/reference/engine/classes/Path)
- [Humanoid](https://create.roblox.com/docs/reference/engine/classes/Humanoid)
- [Players](https://create.roblox.com/docs/reference/engine/classes/Players)
- [Workspace](https://create.roblox.com/docs/reference/engine/classes/Workspace)
- [RunService](https://create.roblox.com/docs/reference/engine/classes/RunService)
- [LogService](https://create.roblox.com/docs/reference/engine/classes/LogService)
- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
