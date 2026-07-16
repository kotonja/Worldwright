# Studio MCP transaction recovery runbook

## Purpose

Use this runbook when a chunked Studio transaction reports a timeout, lost or malformed response,
reconnect failure, failed compensation, unsafe observation, or an interrupted local process. It is
for the Milestone 4 unsaved-sandbox adapter only.

The safe default is to stop mutation and preserve evidence. Do not retry the uncertain chunk, run an
unreviewed inverse, delete unexpected managed content, switch to another Studio session, or use raw
Luau. Version `0.1.0` has no manual automatic-recovery or forward-resume command.

## Safety invariants

Recovery is safe only when all of these remain true:

- the target is the exact original Studio ID;
- `PlaceId == 0` and `GameId == 0`;
- Studio is stopped in Edit mode;
- the reviewed complete Change Set and its base snapshot are unchanged;
- a fresh complete snapshot classifies as the exact base, one canonical prefix, or complete result;
- unmanaged-root boundaries are unchanged;
- any compensation stays inside the transaction's conservative attempted-operation envelope; and
- successful restoration is proved by the complete original base snapshot hash.

Display name, focus, the active flag, or there being one Studio window is not enough. A state that
looks visually correct is not exact-prefix or restoration proof.

## Before a live transaction

1. Open a fresh new local baseplate. Do not open or select a published or production place for the
   test.
2. Enable Roblox Studio MCP and leave Studio stopped in Edit mode.
3. List and record the exact Studio ID privately.
4. Keep the reviewed complete Change Set and complete base snapshot in ignored local evidence under
   `.worldwright/live-milestone-4/`.
5. Record the complete normalized Change Set SHA-256, base snapshot hash, and expected result hash.
6. Run the offline live-sequence review before the real acceptance command.
7. Do not operate another trusted MCP client against the same Studio during the transaction.

Never commit or paste the Studio ID, place name, local paths, raw MCP messages, Luau, server stderr,
image bytes, usernames, or machine information into a pull request.

## Normal built-in recovery path

When one mutation call becomes uncertain, the running transaction performs this bounded sequence:

1. Marks the current MCP client poisoned.
2. Closes its owned local process tree.
3. Sends no later tool through that client.
4. Does not resend the uncertain chunk.
5. Starts a new default local-stdio MCP process for the next required observation.
6. Rediscovers and validates required tools.
7. Finds and selects the exact original Studio ID.
8. Confirms that exact session became active.
9. Re-probes zero PlaceId/GameId and stopped Edit mode.
10. Reads a fresh complete project snapshot.
11. Classifies the observation against the exact reviewed base and Change Set.
12. Compensates only an exact admissible nonzero prefix, including a complete desired result after
    acknowledgment loss.
13. Reads another complete snapshot and requires the original base hash.

The original forward transaction still reports failure when an acknowledgment was uncertain, even if
Studio applied its complete desired result. The creator must explicitly rerun the complete reviewed
Change Set after verified restoration.

At most two reconnect attempts are available to a transaction: one after uncertain forward work and
one after uncertain compensation. There is no reconnect loop.

The poisoned client's owned process tree must be proven terminated before either attempt begins. A
close error or timeout leaves termination unproven; Worldwright fails closed and does not establish
a replacement observation lane while the old privileged process may still be running. The same rule
applies to a replacement rejected during capability discovery, exact-ID selection, or sandbox
re-probe: if its process tree cannot be proven closed, no later replacement is started.

After uncertain compensation, a fresh observation must show either the exact base or a strictly
shorter admissible prefix. An unchanged prefix means the same uncertain chunk would be resent, so
Worldwright stops as `failed-unrestored` and requires manual inspection.

## Read-only progress inspection

If a command was interrupted, or if you need to independently inspect the live state, first ensure
Studio is still the original unsaved stopped sandbox. Then run:

```sh
pnpm studio-mcp progress \
  --studio-id <exact-original-studio-id> \
  --base-snapshot .worldwright/live-milestone-4/<reviewed-base>.snapshot.json \
  --change-set .worldwright/live-milestone-4/<reviewed>.change-set.json \
  --json
```

This command is read-only. It connects to the exact ID, proves the sandbox gate, reads a fresh
snapshot, and returns a strict Studio Progress Report and deterministic report hash. It does not
compensate, resume, clear, adopt, or repair anything.

Use only the base document that hashes to the Change Set's `baseSnapshotHash`. The Change Set alone
does not contain enough state to prove an exact prefix.

## Interpret the result

### `base`

The fresh observation equals the exact original base at prefix zero.

- If the transaction report is `failed-restored`, confirm its `restoredSnapshotHash` equals the base
  hash and preserve the receipt and transport-report hashes.
- If no compensation ran because Studio applied nothing, the original transaction is still failed,
  but no recovery mutation is needed.
- Rerun only after reviewing and explicitly confirming the complete unchanged Change Set again.

Do not reinterpret the failed attempt as success.

### `prefix`

The observation equals an exact nonzero proper prefix and reports `appliedPrefixLength` and the next
operation ID.

- If this classification occurred inside the still-running authorized transaction and is within its
  attempted envelope, let that transaction's compiler-owned recovery path compensate.
- If the original process is gone or the transaction has already returned without restoration,
  preserve the report and stop. Adapter `0.2.0` intentionally has no standalone recovery command; do
  not improvise a partial inverse or rerun the forward Change Set over the prefix.

Escalate with the sanitized hashes and counts. A new separately reviewed managed transition may be
prepared later, but it is not authorized by the failed Change Set.

### `complete`

The observation equals the result after every operation. After a lost acknowledgment this is still
an uncertain original transaction, not forward success.

- Inside the authorized transaction, version `0.1.0` compensates the complete prefix to the exact
  base and reports `failed-restored` only after hash verification.
- If the process is gone or compensation cannot continue, preserve evidence and stop. Do not adopt
  the result as acknowledged success and do not rerun the Change Set.

Automatic forward resume or acceptance of the completed result is deferred to a future reviewed
protocol.

### `unsafe`

The observation is not an exact canonical prefix. Typical causes include an unrelated managed edit,
addition or deletion; changed unmanaged-root boundary; project or target mismatch; stale or wrong
base; a third target state; invalid hierarchy; or malformed input.

- Perform zero compensation mutations.
- Do not run `apply` against this state.
- Do not delete or adopt unexpected content.
- Preserve the progress report, receipt, and transport report locally.
- Stop other clients from editing the sandbox, but do not alter content merely to make the report
  pass.
- Inspect the deterministic `progress.*` diagnostics and determine whether the reviewed input is
  wrong or another actor changed the place.

If creator or foreign-project content changed, the creator owns the recovery decision.

## Interpret the transport outcome

| `finalOutcome`      | Meaning                                                                                         | Next action                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `applied`           | Forward chunks completed and the independent final snapshot matched.                            | No recovery. Verify receipt/result hashes and continue the reviewed workflow.        |
| `noop`              | The base already matched the reviewed desired state; zero mutation calls.                       | No recovery.                                                                         |
| `failed-restored`   | The forward attempt failed, compensation ran when needed, and the exact base hash was restored. | Preserve evidence; explicitly review and rerun the full Change Set if still desired. |
| `failed-unsafe`     | Fresh state was outside the exact admissible prefix. No safe compensation was allowed.          | Stop all mutation and investigate.                                                   |
| `failed-unrestored` | Recovery could not prove the exact base hash.                                                   | Stop all mutation and investigate; do not rerun.                                     |

Check the counts rather than inferring them from status:

- `operationsAttempted` counts forward node operations, not calls;
- `chunksAttempted + compensationChunksAttempted` must equal `mutationExecuteCalls`;
- uncertainty must increment `uncertainTransportEvents`;
- successful replacement increments both `reconnectAttempts` and `reconnectsSucceeded`;
- a compensated case records compensation operation and chunk counts; and
- only a verified base snapshot can justify `failed-restored`.

## Reconnect failures

Stop without compensation when any of these occurs:

- the exact original Studio ID is absent;
- only a different or same-named Studio remains;
- the new MCP process lacks a required tool or has an incompatible schema;
- Studio became published, entered Play/Run, or changed away from the eligible sandbox;
- the replacement cannot confirm the exact active selection;
- the second reconnect was consumed and another uncertain call occurred; or
- the new snapshot is invalid or unsafe.

Do not auto-select another session or relax the sandbox gate. Close Worldwright's client cleanly and
keep the Studio window unchanged for creator inspection.

## Evidence checklist

Keep private raw artifacts only under `.worldwright/live-milestone-4/` and untracked. A sanitized
incident or pull-request note may report:

- PlaceId and GameId were zero;
- complete Change Set hash;
- base, expected-result, observed-failure, and restored hashes as applicable;
- operation, chunk, mutation-call, uncertainty, reconnect, and compensation counts;
- progress classification and applied prefix length;
- receipt, progress-report, and transport-report hashes;
- whether exact base restoration succeeded; and
- viewport evidence SHA-256 and byte length, without the bytes.

Do not report recovery success without the complete restored base hash. Do not report a reconnect as
safe without exact-ID selection and the renewed sandbox probe. Do not make a visual-quality claim
from viewport evidence.

Before committing, verify that no `.worldwright/live-milestone-4/` file, raw receipt, screenshot,
log, binary, path-bearing artifact, or Studio identity is tracked.

## Forbidden recovery actions

There is intentionally no supported:

- blind chunk retry;
- automatic forward resume;
- `--force`, `--resume`, `--clear`, `--delete-managed`, `--adopt`, or `--repair-anyway`;
- arbitrary Luau or MCP tool invocation;
- published-place bypass;
- selection by name, focus, active status, or list order;
- mutation of unmanaged or foreign-project content;
- ChangeHistoryService rollback claim; or
- playtest, console, navigation, visual-critique, or Critic step.

See [ADR 0005](../adr/0005-chunk-studio-mutations-and-recover-by-observation.md) for the decision
and [Studio MCP Adapter 0.2](0.2.0.md) for the contracts and limits.
