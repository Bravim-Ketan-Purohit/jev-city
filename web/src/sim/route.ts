// A car's route: an ordered list of lanes and intersection connectors laid
// end to end, with route-wide arc length `s`, stop lines and crosswalks.

import type { Turn } from "@jev-city/shared";
import type { Arm, City, Connector, Crosswalk, Intersection, Lane } from "./city.ts";
import type { PathSample } from "./geometry.ts";

export interface Piece {
  key: string;
  kind: "lane" | "conn";
  lane?: Lane;
  conn?: Connector;
  s0: number;
  length: number;
}

export interface StopRec {
  idx: number;
  /** Route s of the stop line (front bumper reference). */
  s: number;
  int: Intersection;
  arm: Arm;
  conn: Connector;
  turn: Turn;
  /** Route s where the box starts / ends (connector span). */
  boxS0: number;
  boxS1: number;
  laneIdx: number;
  connIdx: number;
}

export interface RouteCrosswalk {
  cw: Crosswalk;
  s0: number;
  s1: number;
  where: "entry" | "exit";
  lane: Lane;
}

export class Route {
  readonly pieces: Piece[];
  readonly length: number;
  readonly stops: StopRec[] = [];
  readonly crosswalks: RouteCrosswalk[] = [];

  constructor(items: (Lane | Connector)[]) {
    this.pieces = [];
    let s = 0;
    for (const it of items) {
      const isConn = "turn" in it;
      const length = isConn ? it.path.length : it.length;
      this.pieces.push({
        key: it.id,
        kind: isConn ? "conn" : "lane",
        lane: isConn ? undefined : (it as Lane),
        conn: isConn ? (it as Connector) : undefined,
        s0: s,
        length,
      });
      s += length;
    }
    this.length = s;
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i];
      if (p.kind === "conn" && i > 0) {
        const lanePiece = this.pieces[i - 1];
        const lane = lanePiece.lane!;
        const c = p.conn!;
        this.stops.push({
          idx: this.stops.length,
          s: lanePiece.s0 + (lane.stopLineS ?? lane.length - 1),
          int: c.int,
          arm: c.from,
          conn: c,
          turn: c.turn,
          boxS0: p.s0,
          boxS1: p.s0 + p.length,
          laneIdx: i - 1,
          connIdx: i,
        });
      }
      if (p.kind === "lane") {
        const l = p.lane!;
        if (l.cwOut && i > 0) this.crosswalks.push({ cw: l.cwOut.cw, s0: p.s0 + l.cwOut.s0, s1: p.s0 + l.cwOut.s1, where: "exit", lane: l });
        if (l.cwIn && i < this.pieces.length - 1)
          this.crosswalks.push({ cw: l.cwIn.cw, s0: p.s0 + l.cwIn.s0, s1: p.s0 + l.cwIn.s1, where: "entry", lane: l });
      }
    }
  }

  pieceIndexAt(s: number): number {
    const ps = this.pieces;
    if (s <= 0) return 0;
    let lo = 0;
    let hi = ps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ps[mid].s0 <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  sample(s: number): PathSample {
    const i = this.pieceIndexAt(s);
    const p = this.pieces[i];
    const path = p.kind === "lane" ? p.lane!.path : p.conn!.path;
    return path.sample(s - p.s0);
  }

  /** First stop line the front bumper has not crossed yet. */
  nextStop(s: number): StopRec | undefined {
    for (const st of this.stops) if (st.s >= s - 1e-6) return st;
    return undefined;
  }

  /** Stop whose line has been crossed but whose box the front has not left. */
  currentBox(s: number): StopRec | undefined {
    for (const st of this.stops) if (s > st.s && s <= st.boxS1 + 0.5) return st;
    return undefined;
  }

  get firstLane(): Lane {
    return this.pieces[0].lane!;
  }
  get lastLane(): Lane {
    return this.pieces[this.pieces.length - 1].lane!;
  }
}

/** Breadth-first route search over lanes, at most `maxInts` intersections. */
export function planRoute(
  city: City,
  entry: Lane,
  exit: Lane,
  allowLeft: boolean,
  maxInts = 4,
): (Lane | Connector)[] | undefined {
  interface Node {
    lane: Lane;
    prev?: Node;
    via?: Connector;
    depth: number;
  }
  const q: Node[] = [{ lane: entry, depth: 0 }];
  const seen = new Set<string>([entry.id]);
  while (q.length) {
    const n = q.shift()!;
    if (n.lane === exit) {
      const out: (Lane | Connector)[] = [];
      for (let m: Node | undefined = n; m; m = m.prev) {
        out.unshift(m.lane);
        if (m.via) out.unshift(m.via);
      }
      return out;
    }
    const to = n.lane.toInt;
    if (!to || n.depth >= maxInts) continue;
    for (const c of to.int.connectors.values()) {
      if (c.from !== to.arm) continue;
      if (c.turn === "left" && !allowLeft) continue;
      if (seen.has(c.outLane.id)) continue;
      seen.add(c.outLane.id);
      q.push({ lane: c.outLane, prev: n, via: c, depth: n.depth + 1 });
    }
  }
  void city;
  return undefined;
}

/** Straight-through route along a road starting from the lane at `lane`. */
export function straightRouteFrom(lane: Lane): (Lane | Connector)[] {
  // Walk upstream to the map edge, then downstream to the far edge.
  let first = lane;
  while (first.fromInt) {
    const i = first.fromInt.int;
    const inL = i.inLanes[first.fromInt.arm === "N" ? "S" : first.fromInt.arm === "S" ? "N" : first.fromInt.arm === "E" ? "W" : "E"];
    if (!inL) break;
    first = inL;
  }
  const out: (Lane | Connector)[] = [first];
  let cur = first;
  while (cur.toInt) {
    const i = cur.toInt.int;
    const straight = [...i.connectors.values()].find((c) => c.from === cur.toInt!.arm && c.turn === "straight");
    if (!straight) break;
    out.push(straight, straight.outLane);
    cur = straight.outLane;
  }
  return out;
}
