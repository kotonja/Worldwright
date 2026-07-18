# Playtest Critic evidence model

## Evidence layers

Milestone 5 separates four layers that must not be collapsed:

1. a Playtest Plan states what must be exercised;
2. private Studio evidence records what tools and the engine returned;
3. a strict Playtest Run Report retains bounded sanitized observations; and
4. a pure Critic Report deterministically evaluates those observations.

Tool acknowledgment is not engine truth, a screenshot is not a visual score, and a Critic Report is
not repair authorization.

## Run identity

Before Play, private inputs select the exact Studio and reconstruct the complete sandbox lease from
the private lease ID, project ID, and last applied Change Set hash. Shared evidence records only
that exact Studio selection and lease verification succeeded. It never stores either identifier.

The pre-play bound snapshot, exact Manifest no-op, Plan confirmation hash, Manifest
root/source/count identity, and fixed Server identity probe together establish the run boundary. A
running Studio state without the Server identity probe is not evidence that the simulation belongs
to Worldwright.

## Start evidence

The Run Report records whether start was requested, whether its acknowledgment was certain, whether
Play was independently observed, whether identity passed, whether one character became ready, and a
closed failure code when applicable.

An uncertain start may be resolved by reconnecting, observing the exact Studio state, and running
the Server identity probe. It is never resolved by issuing a blind second start. An unverified
running session receives no navigation and no automatic Stop.

## Setup evidence

Setup records the requested position, verified resulting position, whether the one fixed action was
attempted and succeeded, and `excludedFromScoring: true`. A setup failure cannot be converted into
traversal coverage. The report contains no character or player identity.

## Segment evidence

Every planned segment has one result in plan sequence, including segments not attempted after an
earlier hard failure. Tagged variants preserve absence honestly.

### Path result

Path evidence records success or a closed failure, waypoint count, total distance, jump-waypoint
count, and a deterministic digest of bounded waypoint positions. A non-success Path status, too many
waypoints, or any jump under the fixed non-jumping profile blocks navigation for that segment.

Path success proves only that the Server PathfindingService produced an allowed path at preflight
time. It does not prove the character moved or arrived.

### Navigation and arrival

Navigation evidence records that the exact target was requested no more than once, acknowledgment
certainty, and the final independently observed position, horizontal and vertical error, and
velocity where available.

Arrival is a separate observation. It succeeds only when fixed horizontal and vertical tolerances
pass through `player_state`. An uncertain navigation acknowledgment may produce a warning when
independent arrival succeeds; it may not cause a retry. An acknowledgment without independent
arrival is a failure.

### Character state

Observed character evidence contains alive status, health, maximum health, Humanoid state, fall
status, expected level, and observed level. It omits player name, user ID, account identity,
descendant names, scripts, paths, and arbitrary properties.

Before a navigation request, expected level is the segment's source checkpoint level; after the
single navigation request, it is the target checkpoint level. This keeps failed cross-floor path
preflights from being mislabeled as wrong-floor arrivals.

Fall detection uses the segment's allowed floor envelope and the fixed maximum of 12 studs below it.
Stair completion also requires the expected destination level. Death, zero health, excessive fall,
or wrong-floor completion is hard evidence.

### Support and clearance

Clearance evidence records support, head and body clearance, managed support entity ID when known,
sorted managed blocker IDs, and unmanaged blocker count. It never records unmanaged names or paths.

Support and clearance are read-only observations after arrival. Missing support, blocked head, or
blocked body is hard. The strict report requires clearance exactly for an independently reached
segment and rejects destination-clearance claims for missed or unobserved arrivals. A nearby
unmanaged blocker that did not prevent arrival may be a warning.

## Console evidence

The Studio adapter collects bounded baseline, final, and optional post-Stop observations through the
validated current `get_console_output` result shape. It limits entries, message bytes, total bytes,
severity, and source before retaining private raw evidence.

Raw output stays under `.worldwright/live-milestone-5/` and remains ignored. It may contain stack
traces, local paths, script names, account or user text, and terminal control characters. It cannot
enter committed fixtures, Run Reports, Critic Reports, normal CLI JSON, PR bodies, or shareable
summaries.

A sanitized console entry contains only:

- deterministic evidence ID;
- allowed severity;
- Edit or Server source classification;
- lowercase SHA-256 of the normalized message;
- a fixed classification code; and
- whether it is new relative to baseline.

When stable entry identity is unavailable, differencing uses deterministic bounded sequence
comparison. Truncation, reordering, or incompatible structure that prevents safe comparison sets
`evidenceComplete` false. Incomplete console evidence is a hard Critic finding; it never means zero
new errors. Every new error is hard. A new warning is a warning unless another documented hard rule
also fails.

## Viewport evidence

Captures occur only at the Plan's bounded capture checkpoints and use the existing JPEG validation
and byte cap. Private image bytes remain ignored. A strict viewport record contains only:

- deterministic evidence ID;
- checkpoint ID;
- `image/jpeg` media type;
- lowercase SHA-256; and
- byte length.

It contains no bytes, local path, Studio or lease identity, camera internals, or visual score. A
capture is evidence that a viewport image was collected, not evidence of beauty, style, fidelity,
lighting quality, or publish readiness. A segment may reference a capture only when that same
segment independently reached the capture checkpoint; an earlier visit to a repeated checkpoint
cannot authorize a later failed segment's capture claim.

## Stop and Edit-integrity evidence

Stop evidence records whether Stop was requested, acknowledgment certainty, whether Edit was
observed, and whether run identity was reverified before an observed-state-based second Stop.
Second-Stop identity evidence is valid only after an uncertain first Stop request.

After Edit returns, integrity evidence records the exact pre-play and post-play lease-bound managed
snapshot hashes, their equality, and final Manifest reconciliation operation count. Success requires
exact hash equality and zero operations. The `exactMatch` boolean is derived in both directions from
those hashes; it cannot contradict them. Studio's normal reset claim, a viewport appearance, or an
unbound snapshot is insufficient.

If the running session cannot be verified, Worldwright does not send Stop into it. If Stop cannot be
resolved safely, Edit is not restored, the lease differs, the hash changes, or reconciliation is
nonzero, the run fails.

## Coverage evidence

Coverage records required and reached counts for checkpoints, rooms, floors, and stair runs plus
sorted missed IDs. The Run Report validator and Critic recompute these values from Plan references
and reached segment evidence.

A room counts only when its required checkpoint was independently reached. A floor counts only when
required checkpoints on that floor were reached. A stair run counts only when the planned stair
segment reached the destination landing at the expected level. Static geometry, checkpoint
generation, path success, or navigation acknowledgment alone cannot create coverage.

## Run summary

Summary status is one of `completed`, `aborted`, `failed_to_start`, or `failed_to_stop`. It records
planned, attempted, and reached segment counts, required coverage, survival, path/arrival/clearance
failure counts, console counts, and Edit-integrity result. It contains no timestamp or wall-clock
duration.

Counts are derived, not trusted. Contradictory start, Stop, segment, coverage, console, or summary
values make the report invalid before Critic evaluation.

## Critic evidence and findings

The Critic binds canonical Plan and Run Report hashes. It recomputes exact metrics and emits only
closed findings with fixed messages and suggestion codes. Related semantic, checkpoint, segment, and
evidence IDs localize the observation. Deterministic IDs and ordering make repeated evaluation
byte-identical.

`pass` requires complete warning-free hard-rule success. `pass_with_warnings` requires every hard
rule to pass with at least one warning. Any error yields `fail`. No finding contains
chain-of-thought, arbitrary model prose, confidence, raw evidence, executable repair instruction, or
Change Set.

## Local evidence storage

Real-Studio artifacts remain under:

```text
.worldwright/live-milestone-5/
```

The local set may contain the Plan, Run Report, Critic Report, sanitized summary, raw console
evidence, viewport JPEGs, and a hash manifest. Every file stays ignored and untracked. Output paths
are reserved exclusively before Play and existing evidence is never overwritten.

Shareable evidence may include only zero PlaceId/GameId facts, canonical hashes, bounded counts,
coverage, path/navigation/clearance outcomes, console counts, Critic status and finding codes, and
viewport hashes and byte lengths. It excludes Studio ID, lease ID or JSON, place name, local path,
raw log, stack trace, image bytes, username, account identity, and machine information.

## Security interpretation

Evidence can establish a bounded observed result; it cannot authenticate a creator, sign an
artifact, publish a place, authorize a mutation, or repair a world. Milestone 5 ends after the
Critic Report.
