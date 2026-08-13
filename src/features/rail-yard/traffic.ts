/**
 * Movement authority: how far a train is allowed to go, and why it has to stop.
 *
 * The model this replaces was a reservation map that trains wrote claims into. It had two
 * faults that between them are most of "it looks like an animation, not a simulation".
 *
 * The first was a race. `reserve()` set `train.blocked` *after* the speed code had already
 * read it, and the next step cleared it before the read — so a train stopped by occupied
 * track never braked at all. It ran at full line speed into the boundary and had its speed
 * retroactively assigned to zero in a single 20 ms step. What you saw was a locomotive
 * hitting an invisible wall.
 *
 * The second was resolution. A claim covered a whole edge, so two trains could not be
 * closer than one edge apart — a follower on the 230-unit loading road stopped 230 units
 * back, and the two never looked aware of each other.
 *
 * Both go away by making occupancy **derived**. Nothing is claimed and nothing is released;
 * every step reads where the trains actually are and works out how far each may go. There
 * is no stale claim to leak, no ordering to get wrong, and the answer is continuous rather
 * than quantised to a block — a follower closes to `YARD.HEADWAY` behind the coupling in
 * front of it, wherever that happens to be.
 *
 * Deadlock is impossible for a reason that lives in scene.ts rather than here: every road
 * is worked in one direction, so a train only ever waits for a train *ahead of it on its
 * own route*. A circular wait would need the trains to fill the whole circuit end to end,
 * and three of them on ten thousand units of railway cannot.
 */

import { YARD } from "./config";
import { edgeIndexAt, edgeStart, type Path, type RailGraph } from "./graph";

/** Where a train's body lies on one edge, in that edge's own arc length. */
type Span = { readonly edge: string; readonly from: number; readonly to: number };

/**
 * A train's interest in a node: how far its nose still has to run to reach it, negative
 * once it is standing across it. This is what arbitrates a junction.
 */
type NodeClaim = { readonly train: string; readonly away: number };

export type Occupancy = {
  /** edge id → the bodies lying on it. All traffic is one-way, so all are same-sense. */
  readonly onEdge: ReadonlyMap<string, readonly (Span & { readonly train: string })[]>;
  readonly atNode: ReadonlyMap<string, readonly NodeClaim[]>;
};

type AuthorityReason = "clear" | "junction" | "headway" | "stop";

export type Authority = {
  /** Arc length along the train's own path that its leading coupling may not pass. */
  readonly limit: number;
  readonly reason: AuthorityReason;
};

type Body = {
  readonly id: string;
  readonly path: Path;
  readonly distance: number;
  readonly length: number;
};

/**
 * Where every train's body lies, as edges and nodes.
 *
 * Rebuilt from scratch each step. That sounds wasteful and is not: three trains spanning
 * two or three edges each is a couple of dozen entries, and rebuilding is what makes a
 * stale claim — the previous model's actual failure — unrepresentable.
 */
export function occupancyOf(graph: RailGraph, bodies: readonly Body[]): Occupancy {
  const onEdge = new Map<string, (Span & { train: string })[]>();
  const atNode = new Map<string, NodeClaim[]>();

  const claim = (node: string, train: string, away: number) => {
    const claims = atNode.get(node);
    if (claims) claims.push({ train, away });
    else atNode.set(node, [{ train, away }]);
  };

  for (const body of bodies) {
    const { path } = body;
    if (path.edges.length === 0) continue;

    const nose = Math.min(body.distance, path.length);
    const tail = body.distance - body.length;

    const first = edgeIndexAt(path, Math.max(tail, 0));
    const last = edgeIndexAt(path, Math.max(nose, 0));

    if (nose > 0 && tail < path.length) {
      for (let index = first; index <= last; index++) {
        const id = path.edges[index];
        if (id === undefined) continue;
        const start = edgeStart(path, index);
        const span = {
          train: body.id,
          edge: id,
          from: Math.max(0, tail - start),
          to: nose - start,
        };
        const list = onEdge.get(id);
        if (list) list.push(span);
        else onEdge.set(id, [span]);
      }
    }

    /*
     * Every node from the one under the tail to the furthest one the nose could reach
     * before it could possibly stop. Claiming ahead rather than only where the body is is
     * what turns a converging junction from a race into an interlock.
     */
    const reach = body.distance + YARD.JUNCTION_LOOKAHEAD;
    for (let index = 0; index < path.edges.length; index++) {
      const start = edgeStart(path, index);
      if (start > reach) break;
      if (start < tail) continue;
      const node = graph.edges.get(path.edges[index]!)?.from;
      if (node !== undefined) claim(node, body.id, start - body.distance);
    }
    // And the node this leg ends at, which no edge on this path names as a `from`.
    const lastEdge = path.edges[path.edges.length - 1];
    const terminus = lastEdge === undefined ? undefined : graph.edges.get(lastEdge)?.to;
    if (terminus !== undefined && path.length <= reach && path.length >= tail) {
      claim(terminus, body.id, path.length - body.distance);
    }
  }

  return { onEdge, atNode };
}

/**
 * Whether this train has to give way at a node.
 *
 * Nearest first, and the id breaks a tie. Both trains read the same snapshot and apply the
 * same rule, so they always agree on who goes — which is what makes the interlock an
 * interlock rather than two independent guesses.
 */
function mustYield(claims: readonly NodeClaim[], train: string, away: number): boolean {
  return claims.some(
    (claim) =>
      claim.train !== train &&
      (claim.away < away || (claim.away === away && claim.train < train)),
  );
}

/**
 * How far this train may run, and what is stopping it.
 *
 * Three authorities, and the answer is the nearest of them:
 *
 *  1. **The movement's own stop** — where the phase says to finish, passed in by the caller
 *     because only the phase machine knows whether this leg terminates at a node or runs on
 *     off the side of the world.
 *  2. **Junctions** — a node further along the path that another train is standing across.
 *     This is what stops the two workings that converge at the east throat driving through
 *     one another, and it is the whole of what the previous edge-claim model was trying to
 *     express.
 *  3. **Headway** — the rear coupling of a train ahead on a piece of track this one is
 *     going to be on, less `YARD.HEADWAY`. Continuous, so a follower closes up properly.
 *
 * All three are returned as an arc length rather than as a boolean, which is the point: the
 * caller applies one braking curve to `limit - distance` and does not care which of the
 * three produced it. A signal, a queue and a station stop all decelerate identically.
 */
export function limitFor(
  graph: RailGraph,
  occupancy: Occupancy,
  train: Body,
  stopAt: number,
): Authority {
  const { path } = train;
  if (path.edges.length === 0) return { limit: stopAt, reason: "stop" };

  let limit = stopAt;
  let reason: AuthorityReason = stopAt < Infinity ? "stop" : "clear";

  const take = (candidate: number, next: AuthorityReason) => {
    if (candidate >= limit) return;
    limit = candidate;
    reason = next;
  };

  const noseIndex = edgeIndexAt(path, Math.max(0, train.distance));

  for (let index = noseIndex; index < path.edges.length; index++) {
    const id = path.edges[index]!;
    const start = edgeStart(path, index);

    /*
     * A junction ahead. Checked from the edge *after* the nose's, because the node under a
     * train's own nose is one it is already standing on — contesting that was how the old
     * model managed to block every train in the yard against itself on the first frame.
     */
    if (index > noseIndex) {
      const node = graph.edges.get(id)?.from;
      const claims = node === undefined ? undefined : occupancy.atNode.get(node);
      if (claims && mustYield(claims, train.id, start - train.distance)) {
        take(start - YARD.HEADWAY, "junction");
        break;
      }
    }

    for (const span of occupancy.onEdge.get(id) ?? []) {
      if (span.train === train.id) continue;
      // Same sense on every edge, so their tail maps straight into our path coordinate.
      const theirTail = start + span.from;
      if (theirTail <= train.distance) continue;
      take(theirTail - YARD.HEADWAY, "headway");
    }
  }

  return { limit, reason };
}

/**
 * What a signal shows.
 *
 * Derived from the same occupancy the trains are driving on rather than animated alongside
 * it, so a red lamp is a report and never a decoration: stop if the edge it guards is
 * occupied, caution if anything beyond it is, clear otherwise.
 *
 * Red against green carries no information a colour-blind visitor would miss — every state
 * it reports is already visible as a train standing still, and the canvas is `aria-hidden`
 * decoration in any case.
 */
export function aspectOf(
  graph: RailGraph,
  occupancy: Occupancy,
  edgeId: string,
): "go" | "caution" | "stop" {
  if ((occupancy.onEdge.get(edgeId)?.length ?? 0) > 0) return "stop";
  const beyond = graph.edges.get(edgeId)?.to;
  if (beyond === undefined) return "go";
  if ((occupancy.atNode.get(beyond)?.length ?? 0) > 0) return "caution";
  for (const next of graph.out.get(beyond) ?? []) {
    if ((occupancy.onEdge.get(next.id)?.length ?? 0) > 0) return "caution";
  }
  return "go";
}
