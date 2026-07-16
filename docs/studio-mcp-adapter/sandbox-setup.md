# Studio MCP sandbox setup

## Safety boundary

Use this workflow only with a new, unsaved local Roblox Studio place. Do not open an existing
production, published, cloud-associated, or team-created place for Milestone 3 testing. The adapter
requires both `game.PlaceId` and `game.GameId` to be zero and Studio to be stopped in Edit mode. It
has no bypass for those checks.

Enabling Studio MCP grants a privileged local capability. Connect only trusted clients, keep the
exact Studio ID local, and never commit it with evidence.

## Prerequisites

- Node.js 22 or newer and Corepack
- repository dependencies installed with `pnpm install --frozen-lockfile`
- a Roblox Studio release that includes the built-in MCP server
- Studio stopped in Edit mode, not Play, Run, or simulation

## End-to-end setup

### 1. Open a new unsaved Roblox Studio baseplate

Start Roblox Studio and create a new Baseplate without publishing or saving it to Roblox. Do not use
a copy of a production place. Leave the data model stopped in Edit mode.

### 2. Enable Studio as an MCP server

Use Roblox Studio's MCP controls to enable the built-in Studio MCP server. Worldwright starts the
documented local Studio MCP executable; it does not install a plugin or connect to a remote server.

### 3. Confirm the MCP connection indicator

Wait for Studio to show that an MCP client is connected. Do not proceed if Studio reports no
connection, if the place was published, or if a Play or Run session is active.

### 4. Run probe

From the Worldwright repository root, list and probe the connected sessions:

```sh
pnpm studio-mcp probe
```

For stable machine-readable output:

```sh
pnpm studio-mcp probe --json
```

Confirm that the intended place reports `placeId: 0`, `gameId: 0`, stopped Edit mode, and Edit
execution available. Probe may describe an ineligible place, but later project reads and mutations
will reject it.

### 5. Copy the exact Studio ID

Copy the exact opaque Studio ID for the new baseplate. Do not choose by focus, window title, display
name, active state, or list order. Keep this value only in the local terminal or untracked evidence;
do not put it in documentation, fixtures, commits, or a pull-request body.

The examples below use a shell placeholder:

```text
<exact-studio-id>
```

Replace it with the complete value returned by probe.

### 6. Run snapshot or plan-live

Create the ignored evidence directory before asking a CLI command to write into it. In PowerShell:

```powershell
New-Item -ItemType Directory -Force .worldwright/live-milestone-3 | Out-Null
```

To observe a known Worldwright project directly, provide its project ID and an explicit output path:

```powershell
pnpm studio-mcp snapshot --studio-id <exact-studio-id> --project-id <project-id> --output .worldwright/live-milestone-3/before.snapshot.json
```

To reconcile the checked-in Cliffwatch manifest against live Studio state, create a change-set file:

```powershell
pnpm studio-mcp plan-live --studio-id <exact-studio-id> --manifest packages/architecture-planner/fixtures/manifest/cliffwatch-mansion-blockout.manifest.json --output .worldwright/live-milestone-3/cliffwatch.change-set.json
```

If the checked-in generated artifact uses a different manifest filename in the current release,
select that exact Cliffwatch manifest under `packages/architecture-planner/fixtures/`; never
substitute an unreviewed production-place export.

### 7. Review the change set

Open the generated change set and verify at least:

- `projectId` and target are expected;
- the base snapshot hash matches the just-observed sandbox;
- the desired manifest hash names the reviewed Cliffwatch manifest;
- create, update, delete, and total counts are expected;
- the total does not exceed 512;
- every operation contains only the supported managed classes and properties; and
- the expected result snapshot hash is present.

Planning does not authorize mutation. Keep `plan-live` and `apply` as separate decisions.

### 8. Run apply with the full confirmation hash

Copy the complete lowercase SHA-256 hash of the normalized change set. A prefix, `yes`, manifest
hash, environment variable, or force flag is not accepted. Apply with the same exact Studio ID:

```powershell
pnpm studio-mcp apply --studio-id <exact-studio-id> --change-set .worldwright/live-milestone-3/cliffwatch.change-set.json --confirm <full-change-set-sha256> --receipt-output .worldwright/live-milestone-3/applied.receipt.json
```

Read the human confirmation summary before the first mutation. It should name the unsaved place,
project, operation counts, base hash, desired hash, expected result hash, and required confirmation
hash.

### 9. Inspect the generated result

Inspect the managed hierarchy and viewport in Studio without entering Play mode. Verify against the
same manifest:

```powershell
pnpm studio-mcp verify --studio-id <exact-studio-id> --manifest packages/architecture-planner/fixtures/manifest/cliffwatch-mansion-blockout.manifest.json
```

Plan the same manifest again and review that it is a no-op before optionally applying that no-op. If
`screen_capture` is available, save evidence only to the ignored local directory:

```powershell
pnpm studio-mcp capture --studio-id <exact-studio-id> --output .worldwright/live-milestone-3/cliffwatch.png
```

A matching snapshot hash proves state convergence. A viewport capture is evidence only and does not
prove visual quality, traversal, gameplay, or performance.

For the complete controlled live acceptance sequence, skip the manual `apply` in step 8. First run
the no-connect review mode and inspect its complete authorization envelope. It pins the allowed
empty-create or canonical-no-op transition, one-name update, inverse repair, controlled fault,
compensation, PNG capture, and final no-op. Copy the complete
`requiredLiveSequenceConfirmationHash`, then run the selected-place flow:

```powershell
pnpm studio:live-smoke -- --review
pnpm studio:live-smoke -- --studio-id <exact-studio-id> --confirm <full-reviewed-live-sequence-sha256>
```

The review command performs no Studio connection or mutation. The selected-place command requires
the entire lowercase hash of that exact reviewed sequence. It rejects a prefix, `yes`, a manifest
hash, a different full hash, and fixture drift before it connects. After connection it matches the
live empty or canonical initial plan to the corresponding reviewed hash. Before mutation it prints a
JSON-escaped review with the exact session, unsaved place, initial-state classification, operation
counts, base hash, desired hash, expected result hash, planned change-set hash, and required
sequence hash.

The command accepts either a completely empty managed project or the exact canonical Cliffwatch
snapshot left by an interrupted run. It never deletes or adopts an unexpected managed state. It also
never overwrites `applied.receipt.json`, `noop.receipt.json`, `rollback.receipt.json`,
`summary.json`, or a prior viewport image. It reserves all five files before connecting to Studio
and removes all reservations if the run is incomplete. Archive or remove prior untracked evidence
before an intentional rerun. This command is deliberately excluded from `pnpm check` and ordinary
CI.

### Optional manual live ownership-boundary check

The fixed bridge cannot safely manufacture unmanaged or foreign-project content. Consequently, the
regular live smoke records `not-run-manual-setup-required` for this check; fake-MCP tests remain the
ownership evidence unless this separate manual procedure is completed.

After a successful smoke leaves canonical Cliffwatch state:

1. In Studio Explorer, select `Slab Panel 0-1` and verify its `WorldwrightEntityId` is exactly
   `archgen-slab-panel-floor-ground-1-26943878e1ddda92`.
2. Using Explorer only, insert one ordinary `Folder` named `Creator Ownership Check` directly under
   that Part. Do not add Worldwright attributes, a Script, an asset, or Luau.
3. Run `studio-mcp snapshot` for project `project-cliffwatch-mansion` to a new ignored evidence
   file. Verify it contains exactly one new unmanaged-root record whose managed parent ID is the
   Part ID above. Run `verify --json` and record its `snapshotHash` locally:

   ```sh
   pnpm studio-mcp snapshot --studio-id <exact-studio-id> --project-id project-cliffwatch-mansion --output .worldwright/live-milestone-3/ownership-before.snapshot.json --json
   pnpm studio-mcp verify --studio-id <exact-studio-id> --manifest packages/architecture-planner/fixtures/manifest/cliffwatch-mansion-blockout.manifest.json --json
   ```

4. Copy the checked-in Cliffwatch manifest to
   `.worldwright/live-milestone-3/ownership-reparent.manifest.json`. In only that ignored copy,
   change that Part's `parentId` from `archgen-slab-group-floor-ground` to `world-cliffwatch`.
5. Run `studio-mcp plan-live` against the ignored modified manifest. It must fail with
   `plan.unmanaged_descendant_conflict`, write no applicable change set, and make no Studio
   mutation.

   ```sh
   pnpm studio-mcp plan-live --studio-id <exact-studio-id> --manifest .worldwright/live-milestone-3/ownership-reparent.manifest.json --json
   ```

6. Run the same `verify --json` command again and confirm its complete `snapshotHash` is unchanged.
   Then remove only the manually created `Creator Ownership Check` Folder in Explorer and verify the
   original Cliffwatch manifest again.

This proves live observation and planning protection for one manually created unmanaged boundary
without raw Luau or a sixth action. Foreign-project protection remains offline-only unless a second
legitimately Worldwright-managed project is introduced through its own reviewed transaction and
manually nested for a separate test; never fabricate foreign ownership attributes. If this manual
procedure is not actually run, report ownership protection as offline-tested, not live-proven.

### 10. Close without publishing when testing is complete

Confirm that the live smoke run left the sandbox in the original canonical Cliffwatch manifest
state. Review local evidence under `.worldwright/live-milestone-3/`, then close Studio without
publishing the place. Keep the evidence untracked and do not commit images, Studio IDs, local paths,
raw MCP logs, Studio output logs, usernames, machine details, or environment values.

## If a gate fails

- A nonzero place or game ID is intentionally rejected with `studio.published_place_forbidden`.
  Close it and create a new unsaved baseplate; there is no override.
- Play, Run, simulation, or unavailable Edit execution is rejected with `studio.edit_mode_required`.
  Stop the session and probe again.
- Multiple sessions without an exact ID are rejected with `studio.session_ambiguous`. Copy the
  intended ID from probe; do not close safety checks by choosing an "active" session.
- Missing or incompatible Studio tools fail before project inspection or mutation. Update Studio or
  correct its MCP setup; do not bypass tool-schema validation.
- Engine drift or malformed adapter metadata fails closed. Do not rerun apply as an adoption
  mechanism; inspect the affected managed node and preserve the evidence.
- An unmanaged-content conflict means creator-owned or foreign-project content blocks the proposed
  destructive change. Worldwright will not move or delete that content.

See the [Studio MCP Adapter 0.1 reference](0.1.0.md) and
[adapter architecture](../architecture/studio-mcp-adapter.md) for the complete boundary.
