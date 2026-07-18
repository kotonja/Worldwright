# Studio MCP adapter playtest boundary

## Scope

Milestone 5 adds a narrow playtest controller and a separately versioned fixed Server probe protocol
to `@worldwright/studio-mcp-adapter`. It observes one solo traversal in the exact unsaved DataModel
that already contains the desired managed world. It does not expand the core transaction adapter
into a general Studio automation API.

The package exposes no raw MCP client, generic `start_stop_play`, generic `character_navigation`,
generic console or capture tool, generic `execute_luau`, arbitrary Server or Client code, keyboard
or mouse input, script creation, asset action, HTTP transport, save, publish, or published-place
bypass.

## Primary platform references

- [Roblox Studio MCP server and current tool catalog](https://create.roblox.com/docs/studio/mcp)
- [Studio solo playtesting and Client/Server models](https://create.roblox.com/docs/studio/testing-modes)
- [PathfindingService](https://create.roblox.com/docs/reference/engine/classes/PathfindingService)
- [Path](https://create.roblox.com/docs/reference/engine/classes/Path)
- [Humanoid](https://create.roblox.com/docs/reference/engine/classes/Humanoid)
- [Player](https://create.roblox.com/docs/reference/engine/classes/Player)
- [Players](https://create.roblox.com/docs/reference/engine/classes/Players)
- [Workspace](https://create.roblox.com/docs/reference/engine/classes/Workspace)
- [RunService](https://create.roblox.com/docs/reference/engine/classes/RunService)
- [LogService](https://create.roblox.com/docs/reference/engine/classes/LogService)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

Runtime-discovered schemas remain authoritative for each connected Studio version. Documentation
names do not authorize guessed arguments.

## Conditional capability handshake

Core Edit observation and transactions continue to require only their existing tools. Creating a
playtest controller additionally requires and validates:

- `list_roblox_studios`
- `set_active_studio`
- `get_studio_state`
- `start_stop_play`
- `get_console_output`
- `character_navigation`
- `screen_capture`
- `execute_luau`

`execute_luau` must expose a source/code string field, `datamodel_type`, and exact Edit and Server
values. `character_navigation` must accept an exact world position. Version `0.1.0` does not use
instance-path targets or configurable speed unless the discovered schema and fixed controller
contract explicitly support the documented value.

An absent tool, incompatible schema, missing data-model value, or ambiguous result produces a stable
failure. The adapter does not guess fields and does not make these capabilities mandatory for normal
compiler transactions.

## Exact pre-play gate

Every authoritative live run requires private exact Studio and sandbox lease IDs, the complete last
applied Change Set, the Playtest Plan and Manifest, and exact full Plan hash confirmation. Before
Play the controller:

1. selects the exact Studio ID;
2. proves `PlaceId == 0` and `GameId == 0`;
3. proves stopped Edit mode;
4. reconstructs the exact lease record from the private lease ID, project ID, and Change Set hash;
5. obtains one same-call lease-bound complete managed snapshot;
6. validates that snapshot and records its canonical hash;
7. reconciles the desired Manifest to exactly zero operations; and
8. performs no Edit mutation.

Missing, malformed, changed, or wrong-project lease data; nonzero reconciliation; unmanaged
conflict; another Studio selection; running state; or a published place fails before start. The
private Studio and lease values are never printed in shareable JSON or reports.

## Playtest Plan confirmation

Live execution requires equality with the complete lowercase SHA-256 of the normalized Playtest
Plan. Prefixes, `yes`, `--force`, environment approval, the Manifest hash, and the Change Set hash
are not substitutes.

Review output may show project and public artifact hashes, required coverage, checkpoint/segment/
capture counts, sandbox Change Set hash, Edit snapshot hash, and a statement that the private lease
matched. It excludes private IDs, lease JSON, local evidence paths, and raw console text.

## Fixed probe protocol

The additive `0.1.0` protocol has schema IDs:

- `urn:worldwright:studio-playtest-probe-request:0.1.0`
- `urn:worldwright:studio-playtest-probe-response:0.1.0`

Responses use one exact framing prefix. Every action combines one audited fixed Luau program with
one strict JSON payload and deterministic safe long-bracket encoding. Source cannot come from a
caller file, CLI argument, or public API.

Every action carries and verifies project ID, expected Manifest root ID and source hash, expected
managed count, complete private sandbox lease record, and Playtest Plan hash. Actions never return
the lease or player identity.

### `identity_probe`

Runs in the Server data model and returns only project/root match, managed count, player count,
character readiness, data-model type, and play-running state. It verifies that exactly one managed
project root exists and, when required, exactly one test Player exists.

### `character_setup`

Finds the single character, Humanoid, and HumanoidRootPart; pivots the character to the exact Plan
setup position; zeros linear and angular assembly velocity; and rereads position. It does not create
an Instance, change health, anchor the character, mutate architecture, write an attribute, or change
the lease.

### `player_state`

Returns bounded position, velocity magnitude, health, maximum health, Humanoid state, floor
material, root existence, alive status, support result, managed support ID when available, and
current level classification. It returns no player name, user ID, account identity, descendant name,
script source, path, or arbitrary property.

### `path_probe`

Uses PathfindingService with the Plan's fixed agent profile and exact target. It returns bounded
status, waypoint count and positions, total distance, jump requirement, and source/target checkpoint
IDs. It creates no visual waypoint Part or other Instance and retains no Path object. Non-success
Path status or a jump waypoint under the non-jumping profile fails the segment.

### `clearance_probe`

Runs bounded read-only support, head, and body queries around the reached character. It excludes the
character and returns support state/distance, managed support ID, body/head clear booleans,
unmanaged blocker count, and bounded managed blocker IDs. It neither names unmanaged objects nor
changes collision state.

## Start state machine

The normal path calls `start_stop_play` once, then polls bounded `get_studio_state` until Play and
Server availability are observed. The fixed Server identity probe must pass before character setup
or traversal.

If start acknowledgment is uncertain, the affected client is poisoned when appropriate. Recovery
uses a new default local-stdio connection, selects the exact Studio ID, and observes state:

- still stopped Edit means start failed and no second start is issued;
- running plus exact Server identity means the run may continue; and
- running without exact identity means failure, zero navigation, and no claim that the simulation
  belongs to Worldwright.

The controller does not automatically Stop an unverified play session that may belong to another
actor.

## Character readiness and setup

Bounded identity probes require exactly one Player, one Character, Humanoid, HumanoidRootPart, and
positive health. Zero or multiple Players, missing character components, death, or timeout is
explicit run evidence. Setup executes once and is independently position-verified. It is not a
scored route segment.

## Segment state machine

For every planned segment, the controller:

1. observes a living character;
2. runs one path probe;
3. stops further traversal on path failure;
4. calls `character_navigation` at most once;
5. independently polls player state for arrival, timeout, death, or fall;
6. runs one clearance probe after arrival;
7. normalizes complete segment evidence; and
8. captures only a selected Plan checkpoint.

An uncertain navigation response receives no retry. Independent player state may prove arrival and
retain `acknowledgmentCertain: false`; otherwise the segment fails. The navigation tool response
alone never proves arrival.

## Console evidence

The controller validates the actual discovered `get_console_output` result shape instead of assuming
raw strings. It observes a bounded baseline before Play, a bounded final set while the run identity
remains valid, and an optional bounded post-Stop set where supported. Entry count, entry bytes,
total bytes, severity, and source are capped.

Raw output remains ignored private evidence. Strict reports receive only evidence ID, severity,
source classification, message hash, fixed classification, and baseline-difference status. Unsafe
differencing caused by truncation, reordering, or incompatible structure becomes incomplete
evidence. The current built-in MCP's exact empty-text result is accepted as complete zero-entry
runtime evidence; every nonempty unstructured result still fails closed.

## Viewport evidence

`screen_capture` is available only through the high-level capture operation and only for Plan-
selected checkpoints. Existing JPEG media and byte validation applies. At most eight captures occur.
Reports contain hashes and sizes, never bytes or paths, and no visual score is produced.

## Stop state machine

After Worldwright has proved that the running simulation belongs to this run, Stop is mandatory in a
`finally` path. The normal path sends one Stop and polls until Edit is observed.

If acknowledgment is uncertain, recovery reconnects to the exact Studio and observes state. Already
Edit permits integrity verification. Still playing permits one observed-state-based Stop only after
the fixed identity probe reproves the original run. An unverified running session receives no Stop,
and no path loops indefinitely.

Mandatory Stop recovery owns two non-resettable phase-local states. Pre-Stop identity recovery and
subsequent Stop-outcome resolution are each capped by the existing two-attempt local replacement
bound. Start, traversal, navigation, capture, or console recovery can therefore never consume the
capacity needed to reselect the exact Studio, re-prove the running identity, and resolve Stop.
Cleanup may replace at most four local-stdio clients across both phases, but this separation does
not authorize an additional blind Stop: the normal request and the single observed-state-based
request remain the only possible Stop actions.

After Edit is restored, the controller reproves the zero-ID stopped sandbox, obtains one same-lease
bound snapshot, requires exact equality with the pre-play snapshot hash, and requires final Manifest
reconciliation to contain zero operations. Ordinary Studio reset behavior is not accepted without
these checks.

## Controller boundary and lifecycle

One controller serializes one complete run. High-level operations accept strict domain types and may
verify Edit world, start, wait for character, setup, probe path, navigate a segment, observe state
and clearance, capture evidence, collect console evidence, and stop with Edit verification. They do
not accept raw MCP arguments.

Worldwright does not run mutation and playtest operations concurrently against one Studio. Every
call, poll loop, character wait, segment wait, total run, and Stop wait is bounded. No start,
navigation, or Stop action is blindly retried.

## Evidence privacy

Raw console data and JPEG bytes remain only under `.worldwright/live-milestone-5/`, ignored and
untracked. Shareable summaries may contain zero PlaceId/GameId facts, artifact and snapshot hashes,
bounded coverage and outcome counts, finding codes, report hashes, and viewport hashes/sizes.

They contain no Studio ID, lease ID or JSON, previous Workspace lease data, place name, local path,
raw MCP message, raw Luau, raw console line, stack trace, image bytes, username, account ID, machine
information, credential, or environment dump.

## Non-goals

This boundary does not add multiplayer, device, network, UI, keyboard, mouse, gameplay objective,
combat, NPC, performance, visual-quality, image-understanding, repair, plugin, Forge, Atlas, AI,
asset, database, authentication, telemetry, deployment, saving, or publishing behavior. It never
calls ChangeHistoryService.
