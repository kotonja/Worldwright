# Playtest Critic traversal model

## Purpose

The traversal model turns one validated Architecture Plan and one structurally corresponding Roblox
Manifest into a deterministic sequence of architectural checkpoints. It answers what must be tested
and in what order. It does not inspect Studio to invent coordinates, infer openings from visual
contact, or claim that generated points were reached.

## Source indices

Planning builds bounded maps for floors, spaces, rooms, corridors, stair halls, walls, openings,
stair runs, circulation nodes, circulation edges, and Manifest nodes. Duplicate IDs fail before any
map is used. Every reference resolves exactly once.

The source check requires exact Plan and Manifest hashes, project identity, Manifest root and source
metadata, managed count, semantic container IDs, managed parentage, and geometry for required walls,
openings, corridors, stair halls, landings, and stairs. This is exact structural correspondence, not
cryptographic Plan-to-Manifest derivation proof; the existing closed Manifest carries no Plan hash.

## Coordinate frames

Architecture Plan rectangles are horizontal clear spaces in the footprint-centered local frame. For
a local point `(x, z)` and building origin `(ox, oz)`, world conversion is:

| Yaw   | World X  | World Z  |
| ----- | -------- | -------- |
| `0`   | `ox + x` | `oz + z` |
| `90`  | `ox - z` | `oz + x` |
| `180` | `ox - x` | `oz - z` |
| `270` | `ox + z` | `oz - x` |

No sine or cosine approximation is used. Checkpoint world Y is finished-floor elevation plus the
fixed `3`-stud HumanoidRootPart offset. Canonical normalization converts negative zero to zero.

## Checkpoint derivation

### Exterior entrance

The entrance room and its explicit exterior door identify the facade wall and opening center. The
exterior point lies beyond the outside wall face by the fixed safe offset. Its corresponding
interior threshold lies inside the entrance room. Setup uses the exterior point but remains excluded
from scored movement.

### Room centers

Every source room receives one required checkpoint at the exact center of its clear-space rectangle.
The center is semantic coverage evidence only after independent live arrival.

### Opening thresholds

Door and open-connection points use the wall's canonical axis, opening offset and width, wall
constant and thickness, and a fixed offset beyond each face. Each point is assigned to the exact
space on its side. It must remain inside that room, corridor, or stair-hall clear rectangle.

Direct room-to-room doors receive threshold points on both room sides. Room-to-corridor and
corridor-to-stair-hall connections retain their corresponding room, corridor, or stair-hall IDs.
Windows never create traversal.

### Corridors

Corridor checkpoints lie inside corridor clear space at a deterministic safe position associated
with an explicit opening. They allow the route to retain travel within a corridor while preserving
the source circulation edge that authorizes the connection.

### Stair halls and landings

Every participating floor receives a stair-hall checkpoint. Every stair run receives lower and upper
landing checkpoints at the documented clear centers of its retained landing rectangles. The route
uses only the explicit stair circulation edge between the corresponding floor nodes.

## Clear-space validation

A candidate checkpoint fails planning if it is:

- outside its owning clear rectangle;
- in logical or physical wall volume;
- in window glass;
- in slab or stair-step volume;
- on a blocked edge of an opening;
- outside the expected floor's vertical zone; or
- too close to a boundary for the fixed agent radius and safe offset.

The planner does not clamp or nudge an invalid point in Studio. A visible deterministic diagnostic
is safer than an unreviewed target change.

## Traversal graph

The graph contains checkpoint nodes and only edges justified by an Architecture Plan circulation
edge, its opening, or its stair run. A semantic connection may expand into a short checkpoint chain,
for example room center to room threshold to corridor threshold to corridor checkpoint. Each
resulting segment retains the exact source circulation edge and a traversal type:

- `door` for a door threshold crossing;
- `open` for an explicit open stair-hall connection;
- `corridor` for movement within the corridor side of an explicit connection; or
- `stair` for the explicit lower-to-upper landing connection.

Geometric adjacency or rectangle contact alone never creates an edge.

## Target order

Required targets sort as follows:

1. exterior entrance;
2. entrance room;
3. ascending floor level;
4. public rooms;
5. service rooms;
6. private rooms; and
7. source room ID by Unicode code point within the same floor and category.

Stair transitions occur when the next target belongs to another floor. The plan seed and source
array order do not affect this ordering.

## Deterministic shortest routes

For each next target, planning runs iterative breadth-first search from the current node. Adjacency
lists are precomputed and sorted by code-point checkpoint ID. The first discovered shortest route is
therefore deterministic. The route appends that path, removes only consecutive duplicate
checkpoints, and keeps later repeated travel through a corridor, opening, or stair.

Segments receive a contiguous sequence and deterministic ID derived from sequence, endpoints, and
source edge. Generated IDs satisfy the 128-character identifier bound and use a lowercase SHA-256
suffix when a readable form would be too long or collide.

The algorithm uses no recursion dependent on route depth, all-permutation search, random value,
system time, locale comparison, or object insertion order.

## Coverage validation

Before a Plan is emitted, validation proves:

- one setup/exterior sequence begins the route;
- every checkpoint and segment reference resolves;
- every required room has a room-center checkpoint in the route;
- every required floor and corridor appears;
- every required opening is exercised by a route segment;
- every required stair run has both landings and is crossed when floor coverage requires it;
- every segment is backed by explicit circulation; and
- checkpoint, capture, and segment limits are respected.

These are planning guarantees, not live success. Run coverage is recomputed only from independently
reached checkpoints and successful stair transitions. Neither a room rectangle nor a planned route
can be reported as traversed without that evidence.

## Capture selection

The capture set is a deterministic subset of at most eight checkpoint IDs. It prefers the exterior
entrance, entrance room, main ground corridor, lower and upper stair areas, upper corridor, and
final room when present. Selection uses semantic roles and code-point tie breaks, never source
order, seed, camera state, or runtime success.

Capture failure at a nonessential evidence point can become a warning. It never changes route
coverage and never receives a visual score.

## Performance bounds

The Plan permits at most 128 checkpoints and 256 route segments. Planning precomputes maps and
adjacency lists and uses bounded iterative graph traversal. It avoids repeated full serialization in
inner loops and does not impose a flaky wall-clock threshold.

## Interpretation limits

This model exercises the supported blockout with one fixed character profile. It is not a proof of
accessibility, real-world building codes, emergency egress, multiplayer behavior, game objectives,
or aesthetic quality. A later milestone may use findings to propose a reviewed repair, but this
model neither generates nor authorizes one.
