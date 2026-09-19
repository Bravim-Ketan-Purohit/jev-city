// Static road network: a 2x2 grid of intersections joined by two-way roads
// with one lane each way, stubs off every edge, turn connectors inside each
// box, stop lines, crosswalks and the school zone.

import {
  Path,
  add,
  bezier,
  cross,
  dist,
  dot,
  right,
  scale,
  sub,
  vec,
  type Rect,
  type Vec,
} from "./geometry.ts";
import type { Turn } from "@jev-city/shared";

export type Arm = "N" | "E" | "S" | "W";
export const ARMS: Arm[] = ["N", "E", "S", "W"];
export type IntersectionId = "A" | "B" | "C" | "D";

export const LANE_W = 3.6;
export const ROAD_HALF = LANE_W; // two lanes
export const BOX_HALF = 9; // intersection area incl. curb returns
export const CW_NEAR = BOX_HALF + 0.8;
export const CW_FAR = BOX_HALF + 3.8;
export const CW_MID = (CW_NEAR + CW_FAR) / 2;
export const SIDEWALK = 4.6; // verge + walkway beyond the curb
export const LX = 170;
export const LY = 130;
export const STUB_X = 75;
export const STUB_Y = 58;
export const SCHOOL_RADIUS = 60;
export const TURN_LAT_ACCEL = 3.0;

export const WORLD: Rect = { x0: -STUB_X, y0: -STUB_Y, x1: LX + STUB_X, y1: LY + STUB_Y };

export const ARM_DIR: Record<Arm, Vec> = {
  N: vec(0, -1),
  E: vec(1, 0),
  S: vec(0, 1),
  W: vec(-1, 0),
};
export const OPPOSITE: Record<Arm, Arm> = { N: "S", S: "N", E: "W", W: "E" };
/** Arm on the right of a driver entering from `arm`. */
export const RIGHT_OF: Record<Arm, Arm> = { S: "E", E: "N", N: "W", W: "S" };
export const ARM_WORD: Record<Arm, string> = { N: "north", E: "east", S: "south", W: "west" };
/** Travel direction word for a heading pointing toward `arm`. */
export const BOUND_WORD: Record<Arm, string> = {
  N: "northbound",
  E: "eastbound",
  S: "southbound",
  W: "westbound",
};

function armOfHeading(h: Vec): Arm {
  if (Math.abs(h.x) > Math.abs(h.y)) return h.x > 0 ? "E" : "W";
  return h.y > 0 ? "S" : "N";
}

export interface Road {
  code: string;
  name: string;
  axis: "h" | "v";
  coord: number;
  from: number;
  to: number;
  limitMph: number;
  parking: boolean;
}

export interface Crosswalk {
  id: string;
  int: Intersection;
  arm: Arm;
  rect: Rect;
  /** Walking line endpoints on each curb (standing spots on the sidewalk). */
  a: Vec;
  b: Vec;
  /** Points where the walking line meets each curb. */
  curbA: Vec;
  curbB: Vec;
}

export interface Lane {
  id: string;
  road: Road;
  heading: Vec;
  headingArm: Arm;
  start: Vec;
  end: Vec;
  length: number;
  path: Path;
  /** Intersection this lane leaves (via arm), if any. */
  fromInt?: { int: Intersection; arm: Arm };
  /** Intersection this lane enters (via arm), if any. */
  toInt?: { int: Intersection; arm: Arm };
  isEntry: boolean;
  isExit: boolean;
  stopLineS?: number;
  /** Crosswalk the lane passes just before the box (incoming) ... */
  cwIn?: { cw: Crosswalk; s0: number; s1: number };
  /** ... or just after the box (outgoing). */
  cwOut?: { cw: Crosswalk; s0: number; s1: number };
  /** Portion of the lane inside the school zone. */
  school?: { s0: number; s1: number };
  /** Mid-block portion with parking lay-bys (for parked cars / ball event). */
  parking?: { s0: number; s1: number };
}

export interface Connector {
  id: string;
  int: Intersection;
  from: Arm;
  to: Arm;
  turn: Turn;
  inLane: Lane;
  outLane: Lane;
  path: Path;
  capMs: number;
}

export interface Intersection {
  id: IntersectionId;
  name: string;
  center: Vec;
  control: "light" | "stop";
  hasCrosswalks: boolean;
  pedestrians: boolean;
  school: boolean;
  box: Rect;
  roadNS: Road;
  roadEW: Road;
  inLanes: Partial<Record<Arm, Lane>>;
  outLanes: Partial<Record<Arm, Lane>>;
  crosswalks: Partial<Record<Arm, Crosswalk>>;
  connectors: Map<string, Connector>;
  /** Connector-id pairs that cross or merge. */
  conflicts: Set<string>;
}

export const connKey = (from: Arm, to: Arm) => `${from}${to}`;

export class City {
  roads: Road[] = [];
  lanes: Lane[] = [];
  ints: Intersection[] = [];
  byId = new Map<IntersectionId, Intersection>();
  entries: Lane[] = [];
  exits: Lane[] = [];

  constructor() {
    const grand: Road = { code: "GA", name: "Grand Ave", axis: "v", coord: 0, from: WORLD.y0, to: WORLD.y1, limitMph: 35, parking: false };
    const maple: Road = { code: "MA", name: "Maple St", axis: "v", coord: LX, from: WORLD.y0, to: WORLD.y1, limitMph: 25, parking: true };
    const elm: Road = { code: "EL", name: "Elm St", axis: "h", coord: 0, from: WORLD.x0, to: WORLD.x1, limitMph: 25, parking: true };
    const oak: Road = { code: "OK", name: "Oak St", axis: "h", coord: LY, from: WORLD.x0, to: WORLD.x1, limitMph: 25, parking: true };
    this.roads = [grand, maple, elm, oak];

    const mk = (id: IntersectionId, c: Vec, control: "light" | "stop", ns: Road, ew: Road, opts: Partial<Intersection>): Intersection => ({
      id,
      name: `${ns.name} and ${ew.name}`,
      center: c,
      control,
      hasCrosswalks: false,
      pedestrians: false,
      school: false,
      box: { x0: c.x - BOX_HALF, y0: c.y - BOX_HALF, x1: c.x + BOX_HALF, y1: c.y + BOX_HALF },
      roadNS: ns,
      roadEW: ew,
      inLanes: {},
      outLanes: {},
      crosswalks: {},
      connectors: new Map(),
      conflicts: new Set(),
      ...opts,
    });
    this.ints = [
      mk("A", vec(0, 0), "light", grand, elm, { hasCrosswalks: true }),
      mk("B", vec(LX, 0), "stop", maple, elm, {}),
      mk("C", vec(0, LY), "light", grand, oak, { hasCrosswalks: true, pedestrians: true, school: true }),
      mk("D", vec(LX, LY), "light", maple, oak, {}),
    ];
    for (const i of this.ints) this.byId.set(i.id, i);

    for (const i of this.ints) if (i.hasCrosswalks) this.buildCrosswalks(i);
    for (const r of this.roads) this.buildLanes(r);
    for (const i of this.ints) this.buildConnectors(i);
    this.markSchoolZone(this.byId.get("C")!);
  }

  private intsOnRoad(r: Road): Intersection[] {
    return this.ints
      .filter((i) => (r.axis === "v" ? i.center.x === r.coord : i.center.y === r.coord))
      .sort((a, b) => (r.axis === "v" ? a.center.y - b.center.y : a.center.x - b.center.x));
  }

  private buildCrosswalks(i: Intersection) {
    const c = i.center;
    for (const arm of ARMS) {
      const d = ARM_DIR[arm];
      const across = right(d);
      const mid = add(c, scale(d, CW_MID));
      const halfSpan = ROAD_HALF + 1.2;
      const p0 = add(c, scale(d, CW_NEAR));
      const p1 = add(c, scale(d, CW_FAR));
      const e0 = scale(across, ROAD_HALF + 0.4);
      const corners = [add(p0, e0), sub(p0, e0), add(p1, e0), sub(p1, e0)];
      const rect: Rect = {
        x0: Math.min(...corners.map((q) => q.x)),
        y0: Math.min(...corners.map((q) => q.y)),
        x1: Math.max(...corners.map((q) => q.x)),
        y1: Math.max(...corners.map((q) => q.y)),
      };
      i.crosswalks[arm] = {
        id: `${i.id}-cw-${arm}`,
        int: i,
        arm,
        rect,
        a: add(mid, scale(across, -halfSpan)),
        b: add(mid, scale(across, halfSpan)),
        curbA: add(mid, scale(across, -ROAD_HALF)),
        curbB: add(mid, scale(across, ROAD_HALF)),
      };
    }
  }

  private buildLanes(r: Road) {
    const ints = this.intsOnRoad(r);
    for (const dir of [1, -1]) {
      const heading = r.axis === "h" ? vec(dir, 0) : vec(0, dir);
      const hArm = armOfHeading(heading);
      const off = scale(right(heading), LANE_W / 2);
      const ordered = dir > 0 ? ints : [...ints].reverse();
      const startPos = dir > 0 ? r.from : r.to;
      const endPos = dir > 0 ? r.to : r.from;
      const at = (p: number): Vec => add(r.axis === "h" ? vec(p, r.coord) : vec(r.coord, p), off);
      let cursor = startPos;
      let prev: Intersection | undefined;
      let idx = 0;
      const make = (a: number, b: number, fromI?: Intersection, toI?: Intersection) => {
        const start = at(a);
        const end = at(b);
        const lane: Lane = {
          id: `${r.code}-${hArm}${idx++}`,
          road: r,
          heading,
          headingArm: hArm,
          start,
          end,
          length: dist(start, end),
          path: new Path([start, end]),
          fromInt: fromI ? { int: fromI, arm: hArm } : undefined,
          toInt: toI ? { int: toI, arm: OPPOSITE[hArm] } : undefined,
          isEntry: !fromI,
          isExit: !toI,
        };
        this.lanes.push(lane);
        if (lane.isEntry) this.entries.push(lane);
        if (lane.isExit) this.exits.push(lane);
        if (fromI) fromI.outLanes[hArm] = lane;
        if (toI) {
          const arm = OPPOSITE[hArm];
          toI.inLanes[arm] = lane;
          const cw = toI.crosswalks[arm];
          if (cw) {
            lane.cwIn = { cw, s0: lane.length - (CW_FAR - BOX_HALF), s1: lane.length - (CW_NEAR - BOX_HALF) };
            lane.stopLineS = lane.cwIn.s0 - 1.2;
          } else {
            lane.stopLineS = lane.length - 1.0;
          }
        }
        if (fromI) {
          const cw = fromI.crosswalks[hArm];
          if (cw) lane.cwOut = { cw, s0: CW_NEAR - BOX_HALF, s1: CW_FAR - BOX_HALF };
        }
        if (r.parking && fromI && toI && lane.length > 80) {
          lane.parking = { s0: 22, s1: lane.length - 26 };
        }
        return lane;
      };
      for (const i of ordered) {
        const p = r.axis === "h" ? i.center.x : i.center.y;
        make(cursor, p - dir * BOX_HALF, prev, i);
        cursor = p + dir * BOX_HALF;
        prev = i;
      }
      make(cursor, endPos, prev, undefined);
    }
  }

  private buildConnectors(i: Intersection) {
    for (const from of ARMS) {
      const inL = i.inLanes[from];
      if (!inL) continue;
      for (const to of ARMS) {
        if (to === from) continue;
        const outL = i.outLanes[to];
        if (!outL) continue;
        const hin = inL.heading;
        const hout = outL.heading;
        const p0 = inL.end;
        const p1 = outL.start;
        let turn: Turn = "straight";
        let pts: Vec[];
        let cap = Infinity;
        if (dot(hin, hout) > 0.9) {
          pts = [p0, p1];
        } else {
          turn = cross(hin, hout) > 0 ? "right" : "left";
          const r = dist(p0, p1) / Math.SQRT2;
          const k = 0.5523 * r;
          pts = bezier(p0, add(p0, scale(hin, k)), sub(p1, scale(hout, k)), p1, 18);
          cap = Math.sqrt(TURN_LAT_ACCEL * r);
        }
        const c: Connector = {
          id: `${i.id}:${from}${to}`,
          int: i,
          from,
          to,
          turn,
          inLane: inL,
          outLane: outL,
          path: new Path(pts),
          capMs: cap,
        };
        i.connectors.set(connKey(from, to), c);
      }
    }
    // Conflicts: merges (same exit arm) and geometric crossings.
    const cs = [...i.connectors.values()];
    for (let a = 0; a < cs.length; a++) {
      for (let b = a + 1; b < cs.length; b++) {
        const x = cs[a];
        const y = cs[b];
        if (x.from === y.from) continue; // same queue, handled by following
        let conflict = x.to === y.to;
        if (!conflict) conflict = minPathDistance(x.path, y.path) < 2.8;
        if (conflict) {
          i.conflicts.add(`${x.id}|${y.id}`);
          i.conflicts.add(`${y.id}|${x.id}`);
        }
      }
    }
  }

  private markSchoolZone(c: Intersection) {
    for (const lane of this.lanes) {
      const onRoad =
        (lane.road === c.roadNS || lane.road === c.roadEW) &&
        (lane.toInt?.int === c || lane.fromInt?.int === c);
      if (!onRoad) continue;
      if (lane.toInt?.int === c) {
        lane.school = { s0: Math.max(0, lane.length - (SCHOOL_RADIUS - BOX_HALF)), s1: lane.length };
      } else {
        lane.school = { s0: 0, s1: Math.min(lane.length, SCHOOL_RADIUS - BOX_HALF) };
      }
    }
  }

  conflicts(a: Connector, b: Connector): boolean {
    return a.int === b.int && a.int.conflicts.has(`${a.id}|${b.id}`);
  }

  /** Nearest lane position to a world point, within `maxD` meters. */
  laneAt(p: Vec, maxD = 7): { lane: Lane; s: number; d: number } | undefined {
    let best: { lane: Lane; s: number; d: number } | undefined;
    for (const l of this.lanes) {
      const s = Math.max(0, Math.min(l.length, dot(sub(p, l.start), l.heading)));
      const q = add(l.start, scale(l.heading, s));
      const d = dist(p, q);
      if (d <= maxD && (!best || d < best.d)) best = { lane: l, s, d };
    }
    return best;
  }

  nearestIntersection(p: Vec): Intersection {
    let best = this.ints[0];
    for (const i of this.ints) if (dist(p, i.center) < dist(p, best.center)) best = i;
    return best;
  }
}

function minPathDistance(a: Path, b: Path): number {
  const sa = densify(a);
  const sb = densify(b);
  let m = Infinity;
  for (const p of sa) for (const q of sb) m = Math.min(m, dist(p, q));
  return m;
}

function densify(p: Path, step = 0.5): Vec[] {
  const out: Vec[] = [];
  for (let s = 0; s <= p.length; s += step) out.push(p.sample(s).p);
  return out;
}
