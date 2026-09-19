// The simulation: fixed 30 Hz control step, a code-owned safety reflex, and
// an asynchronous decision layer fed by a brain (Rules, Mock or Jev).

import {
  ACCEL,
  COMFORT_BRAKE,
  DEFAULT_DECISION_CONFIG,
  MAX_BRAKE,
  streamRng,
  toMph,
  toMs,
  type BrainName,
  type DecisionConfig,
  type Rng,
} from "@jev-city/shared";
import { Car, type FallbackReason } from "./car.ts";
import { City, type Connector, type Intersection, type Lane } from "./city.ts";
import { dot, obbOverlap, right, type OBB, type Vec } from "./geometry.ts";
import { Metrics, type ViolationKind } from "./metrics.ts";
import { Route, planRoute, type StopRec } from "./route.ts";
import { makeSignals, type Signal } from "./signals.ts";
import type { PerceptionHook } from "./perceive.ts";

export const DT = 1 / 30;
export const PULL_LAT = 1.4;
const CRAWL = 2.2;

export type BrainMode = "rules" | "mock-jev" | "jev" | "mixed";

export interface SimOptions {
  seed: number;
  carCount: number;
  allowLeft: boolean;
  safety: boolean;
  brainMode: BrainMode;
  /** Share of cars driven by Jev in mixed mode (0..1). */
  mixedShare: number;
  /** Brain used for the "Jev" share when mixed (jev or mock-jev). */
  mixedJevBrain: "jev" | "mock-jev";
  /** Sim clock at t=0, seconds after midnight. */
  startClock: number;
  decision: DecisionConfig;
}

export const DEFAULT_SIM_OPTIONS: SimOptions = {
  seed: 1234,
  carCount: 30,
  allowLeft: true,
  safety: true,
  brainMode: "rules",
  mixedShare: 0.5,
  mixedJevBrain: "mock-jev",
  startClock: 14 * 3600 + 5 * 60,
  decision: { ...DEFAULT_DECISION_CONFIG },
};

interface Occ {
  car: Car;
  rear: number;
  front: number;
}

export interface Leader {
  car: Car;
  gap: number;
  v: number;
}

export interface LogEntry {
  t: number;
  kind: "decision" | "violation" | "intervention" | "event" | "fallback" | "info" | "gridlock";
  text: string;
  carId?: number;
  brain?: BrainName;
  severity?: "ok" | "warn" | "bad";
}

export interface Marker {
  pos: Vec;
  t: number;
  label: string;
  kind: "violation" | "intervention";
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function idm(v: number, v0: number, gap?: number, dv = 0, s0 = 2, T = 1.2): number {
  const a = ACCEL;
  const b = COMFORT_BRAKE;
  let free: number;
  if (v0 <= 0.05) free = v > 0.05 ? -b : 0;
  else free = a * (1 - Math.pow(v / v0, 4));
  if (v > v0) free = Math.max(-b, free);
  if (gap === undefined) return free;
  const sStar = s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(a * b)));
  const g = Math.max(gap, 0.05);
  const inter = (sStar / g) ** 2;
  if (v <= v0 && v0 > 0.05) return a * (1 - Math.pow(v / v0, 4) - inter);
  return Math.min(free, a * (1 - inter));
}

export class Simulation {
  readonly opts: SimOptions;
  readonly city: City;
  readonly signals: Map<string, Signal>;
  cars: Car[] = [];
  time = 0;
  metrics = new Metrics();
  log: LogEntry[] = [];
  markers: Marker[] = [];
  /** Every decision, for JSONL export. */
  decisionLog: object[] = [];

  private rngSpawn: Rng;
  private rngRoute: Rng;
  private nextCarId = 1;
  private nextSpawnAt = 0;
  occ = new Map<string, Occ[]>();
  boxOcc = new Map<string, { car: Car; stop: StopRec }[]>();
  private collisions = new Set<string>();
  private still: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
  private gridFlag: Record<string, boolean> = { A: false, B: false, C: false, D: false };
  /** When the school zone last became active (for a short enforcement grace). */
  schoolActiveSince = -1e9;
  private schoolWasActive = false;
  /** School dismissal override (event) until this sim time. */
  schoolOverrideUntil = -1;
  /** Extra per-step hooks (pedestrians, events) registered by later layers. */
  hooks: { pre?: (dt: number) => void; post?: (dt: number) => void }[] = [];

  constructor(opts: Partial<SimOptions> = {}) {
    this.opts = { ...DEFAULT_SIM_OPTIONS, ...opts, decision: { ...DEFAULT_SIM_OPTIONS.decision, ...(opts.decision ?? {}) } };
    this.city = new City();
    this.signals = makeSignals(this.city.ints);
    for (const sig of this.signals.values()) sig.onRed = (arms, t) => this.onRed(sig, arms, t);
    this.rngSpawn = streamRng(this.opts.seed, "spawn");
    this.rngRoute = streamRng(this.opts.seed, "route");
  }

  // ---------------------------------------------------------------- clock

  get clockSeconds(): number {
    return (this.opts.startClock + this.time) % 86400;
  }

  clockText(): string {
    const t = Math.floor(this.clockSeconds);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  scheduleSchoolActive(): boolean {
    const t = this.clockSeconds;
    return (t >= 7.5 * 3600 && t < 8.5 * 3600) || (t >= 14.5 * 3600 && t < 15.5 * 3600);
  }

  /** Extra reasons the school zone is active (children visible), set by the pedestrian layer. */
  childrenNearSchool = false;

  get schoolActive(): boolean {
    return this.scheduleSchoolActive() || this.time < this.schoolOverrideUntil || this.childrenNearSchool;
  }

  // ---------------------------------------------------------------- brains

  brainFor(id: number): BrainName {
    const m = this.opts.brainMode;
    if (m !== "mixed") return m;
    // Deterministic split by id so both panes of side-by-side agree.
    const h = Math.imul(id ^ this.opts.seed, 2654435761) >>> 0;
    return (h % 1000) / 1000 < this.opts.mixedShare ? this.opts.mixedJevBrain : "rules";
  }

  setBrainMode(mode: BrainMode) {
    this.opts.brainMode = mode;
    for (const c of this.cars) if (c.kind === "car") c.brain = this.brainFor(c.id);
  }

  // ---------------------------------------------------------------- limits

  limitMphAt(c: Car, s: number): number {
    const r = c.route;
    const i = r.pieceIndexAt(s);
    const p = r.pieces[i];
    const local = s - p.s0;
    const school = this.schoolActive;
    if (p.kind === "lane") {
      const l = p.lane!;
      if (school && l.school && local >= l.school.s0 && local <= l.school.s1) return 20;
      return l.road.limitMph;
    }
    const cn = p.conn!;
    if (school && cn.int.school) return 20;
    return Math.min(cn.outLane.road.limitMph, cn.inLane.road.limitMph);
  }

  inActiveSchool(c: Car): boolean {
    return this.schoolActive && this.limitMphAt(c, c.center) === 20;
  }

  /** A lower limit that starts ahead of the front bumper (school zone). */
  lowerLimitAhead(c: Car, within = 80): { mph: number; distanceM: number } | undefined {
    if (!this.schoolActive) return undefined;
    const r = c.route;
    const here = this.limitMphAt(c, c.s);
    if (here <= 20) return undefined;
    for (let i = r.pieceIndexAt(c.s); i < r.pieces.length; i++) {
      const p = r.pieces[i];
      if (p.s0 - c.s > within) break;
      let start: number | undefined;
      if (p.kind === "lane" && p.lane!.school) start = p.s0 + p.lane!.school.s0;
      else if (p.kind === "conn" && p.conn!.int.school) start = p.s0;
      if (start !== undefined && start > c.s && start - c.s <= within) return { mph: 20, distanceM: start - c.s };
    }
    return undefined;
  }

  /** Limit the control layer maps speed levels onto: anticipates a lower limit ahead. */
  effectiveLimitMph(c: Car): number {
    const here = this.limitMphAt(c, c.center);
    const ahead = this.lowerLimitAhead(c);
    if (ahead && ahead.mph < here) {
      const need = (toMs(here) ** 2 - toMs(ahead.mph) ** 2) / (2 * 2.5) + 12;
      if (ahead.distanceM <= need) return ahead.mph;
    }
    return here;
  }

  /** Lowest turn speed cap reachable from here, as an allowed speed now. */
  private turnCap(c: Car): number {
    const r = c.route;
    let cap = Infinity;
    for (let i = r.pieceIndexAt(c.s); i < r.pieces.length; i++) {
      const p = r.pieces[i];
      const d = Math.max(0, p.s0 - c.s);
      if (d > 70) break;
      if (p.kind === "conn" && isFinite(p.conn!.capMs)) {
        cap = Math.min(cap, Math.sqrt(p.conn!.capMs ** 2 + 2 * 2.5 * d));
      }
    }
    // Still on a turn with the rear: keep the cap until the body has left it.
    const ri = r.pieceIndexAt(Math.max(0, c.rear));
    const rp = r.pieces[ri];
    if (rp.kind === "conn" && isFinite(rp.conn!.capMs)) cap = Math.min(cap, rp.conn!.capMs);
    return cap;
  }

  // ---------------------------------------------------------------- occupancy

  private buildOcc() {
    this.occ.clear();
    this.boxOcc.clear();
    for (const i of this.city.ints) this.boxOcc.set(i.id, []);
    for (const c of this.cars) {
      const r = c.route;
      const i1 = r.pieceIndexAt(c.s);
      const i0 = r.pieceIndexAt(Math.max(0, c.rear));
      for (let k = i0; k <= i1; k++) {
        const p = r.pieces[k];
        let list = this.occ.get(p.key);
        if (!list) this.occ.set(p.key, (list = []));
        list.push({ car: c, rear: c.rear - p.s0, front: c.s - p.s0 });
      }
      const st = r.currentBox(c.s) ?? this.rearInBox(c);
      if (st) this.boxOcc.get(st.int.id)!.push({ car: c, stop: st });
    }
  }

  /** Box the car's rear is still inside after the front has left it. */
  private rearInBox(c: Car): StopRec | undefined {
    for (const st of c.route.stops) if (c.rear < st.boxS1 && c.s > st.boxS1) return st;
    return undefined;
  }

  findLeader(c: Car, maxDist = 90): Leader | null {
    const r = c.route;
    let best: Leader | null = null;
    const i0 = r.pieceIndexAt(c.s);
    for (let k = i0; k < r.pieces.length; k++) {
      const p = r.pieces[k];
      if (p.s0 - c.s > maxDist) break;
      const consider = (o: Occ, base: number) => {
        if (o.car === c) return;
        if (c.pass && o.car.id === c.pass.targetId) return;
        if (c.kind === "ambulance" && o.car.lat >= 1.0) return; // pulled over
        const frontRoute = base + o.front;
        if (frontRoute <= c.s + 0.01 && k === i0) return; // behind us
        const gap = Math.max(0, base + o.rear - c.s);
        if (!best || gap < best.gap) best = { car: o.car, gap, v: o.car.v };
      };
      for (const o of this.occ.get(p.key) ?? []) consider(o, p.s0);
      if (p.kind === "conn") {
        const cn = p.conn!;
        const atBox = p.s0 - c.s < 3;
        for (const other of cn.int.connectors.values()) {
          if (other === cn) continue;
          // Diverging movements (same approach lane) share the first meters of the box.
          if (other.from === cn.from) {
            for (const o of this.occ.get(other.id) ?? []) if (o.rear < 7) consider(o, p.s0);
          }
          // Merging movements: once at the box, whoever is closer to the shared exit leads.
          if (atBox && other.to === cn.to && other.from !== cn.from) {
            const myToExit = p.s0 + p.length - c.s;
            for (const o of this.occ.get(other.id) ?? []) {
              if (o.car === c) continue;
              const theirs = other.path.length - o.rear;
              if (theirs < myToExit - 0.5) {
                const gap = Math.max(0, myToExit - theirs);
                if (!best || gap < best.gap) best = { car: o.car, gap, v: o.car.v };
              }
            }
          }
        }
      }
      if (best && (best as Leader).gap < p.s0 + p.length - c.s) break;
    }
    return best;
  }

  /** Nearest vehicle behind in the same piece chain (for perception). */
  findFollower(c: Car, maxDist = 60): Leader | null {
    let best: Leader | null = null;
    for (const o of this.cars) {
      if (o === c || o.kind === "stalled") continue;
      const l = this.findLeaderQuick(o, c, maxDist);
      if (l !== undefined && (!best || l < best.gap)) best = { car: o, gap: l, v: o.v };
    }
    return best;
  }

  private findLeaderQuick(o: Car, target: Car, maxDist: number): number | undefined {
    // Is `target` directly ahead of `o` on o's route within maxDist?
    const r = o.route;
    for (let k = r.pieceIndexAt(o.s); k < r.pieces.length; k++) {
      const p = r.pieces[k];
      if (p.s0 - o.s > maxDist) return undefined;
      for (const x of this.occ.get(p.key) ?? []) {
        if (x.car === target) {
          const gap = p.s0 + x.rear - o.s;
          return gap >= 0 && gap <= maxDist ? gap : undefined;
        }
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------- intersections

  carsInBox(int: Intersection): { car: Car; stop: StopRec }[] {
    return this.boxOcc.get(int.id) ?? [];
  }

  /** A car whose path crosses `conn` is inside the box. */
  conflictInBox(conn: Connector, self?: Car): Car | undefined {
    for (const { car, stop } of this.carsInBox(conn.int)) {
      if (car === self) continue;
      if (this.city.conflicts(stop.conn, conn)) return car;
    }
    return undefined;
  }

  /** Cars stopped at the stop lines of an all-way stop, in arrival order. */
  waitingAt(int: Intersection): { car: Car; stop: StopRec; t: number }[] {
    const out: { car: Car; stop: StopRec; t: number }[] = [];
    for (const c of this.cars) {
      if (c.kind !== "car") continue;
      const ns = c.route.nextStop(c.s);
      if (!ns || ns.int !== int) continue;
      const t = c.stopMarks.get(ns.idx);
      if (t === undefined) continue;
      out.push({ car: c, stop: ns, t });
    }
    const before = (a: (typeof out)[0], b: (typeof out)[0]) => {
      if (Math.abs(a.t - b.t) > 1.0) return a.t < b.t;
      // Simultaneous arrival: yield to the car on the right.
      const rightOf: Record<string, string> = { S: "E", E: "N", N: "W", W: "S" };
      if (rightOf[b.stop.arm] === a.stop.arm) return true;
      if (rightOf[a.stop.arm] === b.stop.arm) return false;
      return a.t < b.t || (a.t === b.t && a.car.id < b.car.id);
    };
    const ranked = out.map((x) => ({ x, rank: 1 + out.filter((y) => y !== x && before(y, x)).length }));
    ranked.sort((p, q) => p.rank - q.rank || p.x.car.id - q.x.car.id);
    return ranked.map((r) => r.x);
  }

  isAllWay(int: Intersection): boolean {
    if (int.control === "stop") return true;
    return this.signals.get(int.id)?.failed ?? false;
  }

  /** Room on an exit lane for one more car. */
  exitHasRoom(lane: Lane): boolean {
    let minRear = Infinity;
    let v = 0;
    for (const o of this.occ.get(lane.id) ?? []) {
      if (o.rear < minRear) {
        minRear = o.rear;
        v = o.car.v;
      }
    }
    const need = 7 + (lane.cwOut ? lane.cwOut.s1 : 0);
    return minRear >= need || v > 3;
  }

  // ---------------------------------------------------------------- spawning

  private spawnTick() {
    const nCars = this.cars.filter((c) => c.kind === "car").length;
    if (nCars >= this.opts.carCount || this.time < this.nextSpawnAt) return;
    const entry = this.rngSpawn.pick(this.city.entries);
    let minRear = Infinity;
    let leadV = 0;
    for (const o of this.occ.get(entry.id) ?? []) {
      if (o.rear < minRear) {
        minRear = o.rear;
        leadV = o.car.v;
      }
    }
    if (minRear < 12) {
      this.nextSpawnAt = this.time + 0.15;
      return;
    }
    const exits = this.city.exits.filter((x) => !(x.road === entry.road && dot(x.heading, entry.heading) < 0));
    let items: (Lane | Connector)[] | undefined;
    for (let tries = 0; tries < 6 && !items; tries++) {
      const dest = this.rngRoute.pick(exits);
      items = planRoute(this.city, entry, dest, this.opts.allowLeft, 3);
    }
    if (!items) return;
    const route = new Route(items);
    const limit = toMs(entry.road.limitMph);
    let v = limit * 0.9;
    if (isFinite(minRear)) v = Math.min(v, Math.max(leadV, Math.sqrt(2 * COMFORT_BRAKE * Math.max(0, minRear - 10))));
    const id = this.nextCarId++;
    const car = new Car({ id, kind: "car", brain: this.brainFor(id), route, s: 4.5, v, now: this.time });
    this.cars.push(car);
    this.updatePose(car);
    car.prevPose = { ...car.pose };
    this.nextSpawnAt = this.time + this.rngSpawn.range(0.3, 1.0);
  }

  addCar(car: Car) {
    this.cars.push(car);
    this.updatePose(car);
    car.prevPose = { ...car.pose };
  }

  newCarId(): number {
    return this.nextCarId++;
  }

  // ---------------------------------------------------------------- zones

  /** Zone the car needs decisions for, or null when cruising. */
  zoneFor(c: Car): string | null {
    if (c.kind !== "car") return null;
    const r = c.route;
    const box = r.currentBox(c.s);
    if (box) return box.int.id;
    const ns = r.nextStop(c.s);
    if (ns && ns.s - c.s <= this.opts.decision.decisionRadiusM) return ns.int.id;
    // Just left a box: still near its exit crosswalk.
    for (const st of r.stops) if (c.s > st.boxS1 && c.s - st.boxS1 < 8) return st.int.id;
    const lane = r.pieces[r.pieceIndexAt(c.s)].lane;
    const seg = `seg:${lane ? lane.road.name + " " + lane.headingArm : "box"}`;
    if (this.eventNear(c)) return seg;
    if (c.decision && c.decision.action !== "proceed") return seg;
    if (c.fallback) return seg;
    return null;
  }

  /** Overridden by the event layer. */
  eventNear: (c: Car) => boolean = () => false;
  /** Extra perception facts (pedestrians, events), added by later layers. */
  perceptionHooks: PerceptionHook[] = [];
  /** Event sentences for a zone's scene text. */
  sceneEvents: (zoneId: string) => string[] = () => [];

  // ---------------------------------------------------------------- control

  /** Crosswalk / flagger stop points, provided by later layers. */
  extraStops: (c: Car, forYield: boolean) => number[] = () => [];
  /** Crosswalk safety check, provided by the pedestrian layer. */
  crosswalkThreat: (c: Car, planned: number) => boolean = () => false;
  /** Pass maneuver control, provided by the event layer. */
  passControl: (c: Car, leader: Leader | null) => { v0?: number; latTarget?: number } | undefined = () => undefined;
  /** Ambulance control, provided by the event layer. */
  ambulanceControl: (c: Car) => void = () => {};

  fallbackFor(c: Car): FallbackReason | null {
    const cfg = this.opts.decision;
    const d = c.decision;
    if (c.apiError) return "api_error";
    if (c.zoneId !== null) {
      const ref = d ? Math.max(d.issuedAt, c.zoneEnteredAt) : c.zoneEnteredAt;
      if (this.time - ref > cfg.decisionExpiryS) return "stale";
    }
    if (d && d.action === "other") return "other";
    if (d && d.actionConfidence < cfg.minConfidence) return "low_conf";
    return null;
  }

  /** May the car cross its next stop line under its current decision? */
  permitted(c: Car): boolean {
    const cfg = this.opts.decision;
    if (c.fallback) return false;
    const d = c.decision;
    if (!d) return true; // cruising default before the first decision
    if (d.action !== "proceed" && d.action !== "slow_down") return false;
    if (d.actionConfidence < cfg.enterConfidence) return false;
    if (d.rightOfWayProb !== undefined && d.rightOfWayProb < cfg.rightOfWayMin) return false;
    return true;
  }

  private controlCar(c: Car) {
    if (c.kind === "stalled") {
      c.a = 0;
      c.v = 0;
      return;
    }
    if (c.kind === "ambulance") {
      this.ambulanceControl(c);
      return;
    }
    const now = this.time;
    const fb = this.fallbackFor(c);
    if (fb !== c.fallback) {
      if (fb === "stale") {
        this.metrics.brains[c.brain].stale++;
        this.pushLog({ t: now, kind: "fallback", text: `Car ${c.label}: decision stale, cautious mode`, carId: c.id, brain: c.brain, severity: "warn" });
      }
      c.fallback = fb;
    }
    const limit = toMs(this.effectiveLimitMph(c));
    const d = c.decision;
    const r = c.route;
    const inBox = !!r.currentBox(c.s);
    const lvl = d ? (clamp(d.speedLevel, 0, 3) * limit) / 3 : limit;
    let v0 = limit;
    let wantStop = false;
    let forYield = false;
    let emergency = false;
    let latT = 0;
    if (fb) {
      v0 = 0.5 * limit;
      wantStop = true;
    } else if (d) {
      switch (d.action) {
        case "proceed":
          v0 = Math.max(lvl, CRAWL);
          break;
        case "slow_down":
          v0 = Math.max(Math.min(lvl, 0.6 * limit), CRAWL);
          break;
        case "stop_at_line":
          v0 = Math.max(lvl, 0.5 * limit);
          wantStop = true;
          break;
        case "emergency_stop":
          v0 = 0;
          emergency = true;
          break;
        case "yield":
          v0 = Math.min(Math.max(lvl, CRAWL), 0.5 * limit);
          wantStop = true;
          forYield = true;
          break;
        case "pull_over":
          if (!inBox) {
            latT = PULL_LAT;
            v0 = 0;
          } else v0 = CRAWL * 2;
          break;
        default:
          v0 = 0.5 * limit;
          wantStop = true;
      }
    }
    const ok = this.permitted(c);
    let stopS: number | undefined;
    const ns = r.nextStop(c.s);
    const cands: number[] = [];
    if ((wantStop || !ok) && ns && ns.s - c.s < 150) cands.push(ns.s);
    for (const s of this.extraStops(c, forYield || wantStop || !ok)) cands.push(s);
    for (const s of cands) if (s > c.s - 0.5 && (stopS === undefined || s < stopS)) stopS = s;
    if (stopS !== undefined) {
      const gap = stopS - c.s;
      const need = (c.v * c.v) / (2 * Math.max(gap, 0.01));
      if (need > MAX_BRAKE && gap < c.v * 1.2) stopS = undefined; // cannot stop: committed
    }

    const leader = this.findLeader(c);
    const pc = this.passControl(c, leader);
    if (pc?.v0 !== undefined) v0 = Math.min(v0, pc.v0);
    if (pc?.latTarget !== undefined) latT = pc.latTarget;
    v0 = Math.min(v0, this.turnCap(c));

    let a = idm(c.v, v0);
    const lead = c.pass ? null : leader;
    if (lead) {
      const s0 = lead.car.kind === "stalled" ? 3 : 2;
      a = Math.min(a, idm(c.v, v0, lead.gap, c.v - lead.v, s0, 1.2));
    }
    if (stopS !== undefined) a = Math.min(a, idm(c.v, v0, stopS - c.s, c.v, 0.5, 0.8));
    if (emergency) a = -MAX_BRAKE;
    a = clamp(a, -MAX_BRAKE, ACCEL);
    c.hardBrake = a < -COMFORT_BRAKE - 0.5;

    const threat = this.safetyThreat(c, lead, a);
    if (this.opts.safety && threat) {
      a = -MAX_BRAKE;
      if (!c.reflex) {
        c.reflexCount++;
        const pos = { x: c.pose.x, y: c.pose.y };
        this.metrics.interventions.push({ t: now, carId: c.id, brain: c.brain, pos, reason: threat });
        this.metrics.brains[c.brain].interventions++;
        this.markers.push({ pos, t: now, label: "SAFETY", kind: "intervention" });
        this.pushLog({ t: now, kind: "intervention", text: `Car ${c.label}: safety reflex (${threat})`, carId: c.id, brain: c.brain, severity: "warn" });
      }
      c.reflex = true;
    } else c.reflex = false;
    c.a = a;
    c.latTarget = latT;
  }

  /**
   * True when the planned acceleration will carry the front past `lineS`:
   * the car is not braking hard enough to stop before it, and it is at the
   * last point where a comfortable stop is still possible.
   */
  willCross(c: Car, lineS: number, planned: number): boolean {
    const d = lineS - c.s;
    if (d < -0.1 || c.v < 0.3) return false;
    if (d / c.v > 1.2) return false; // time to reach it is still above 1.2 s
    const req = (c.v * c.v) / (2 * Math.max(d, 0.1));
    return planned > -req + 0.05;
  }

  /** Reasons the code-owned safety reflex would brake hard right now. */
  safetyThreat(c: Car, lead: Leader | null, planned: number): string | null {
    if (lead && c.v > lead.v + 0.1) {
      const ttc = lead.gap / (c.v - lead.v);
      if (ttc < 1.2) return "time-to-collision";
    }
    const r = c.route;
    const inBox = r.currentBox(c.s);
    const st = inBox ?? r.nextStop(c.s);
    if (st) {
      const aboutToEnter = !inBox && this.willCross(c, st.boxS0, planned);
      const inside = inBox && c.s < st.boxS1 - 2;
      if (aboutToEnter || inside) {
        for (const { car: o, stop } of this.carsInBox(st.int)) {
          if (o === c || !this.city.conflicts(stop.conn, st.conn)) continue;
          if (inside) {
            // Both inside: the later entrant yields, and only when close.
            const mine = c.boxEnter ?? 0;
            const theirs = o.boxEnter ?? 0;
            if (theirs <= mine && Math.hypot(o.pose.x - c.pose.x, o.pose.y - c.pose.y) < 9) return "crossing traffic in box";
          } else return "crossing traffic in box";
        }
      }
    }
    if (this.crosswalkThreat(c, planned)) return "pedestrian in crosswalk";
    return null;
  }

  // ---------------------------------------------------------------- integration

  private integrate(c: Car, dt: number) {
    if (c.kind === "stalled") return;
    const v0 = c.v;
    let v1 = v0 + c.a * dt;
    let ds: number;
    if (v1 < 0) {
      ds = c.a < 0 ? (v0 * v0) / (2 * -c.a) : 0;
      v1 = 0;
    } else ds = ((v0 + v1) / 2) * dt;
    const sPrev = c.s;
    c.s += ds;
    c.v = v1;
    const dl = c.latTarget - c.lat;
    c.lat += clamp(dl, -1.3 * dt, 1.3 * dt);

    if (c.kind !== "car") {
      this.checkBoxExit(c, sPrev);
      return;
    }
    for (const st of c.route.stops) {
      if (c.crossed.has(st.idx)) continue;
      if (c.s >= st.s - 3 && c.s <= st.s + 0.05) {
        // Within 3 m before the line: track the slowest speed and full stops.
        c.nearLineMin.set(st.idx, Math.min(c.nearLineMin.get(st.idx) ?? Infinity, c.v));
        if (c.v < 0.3 && !c.stopMarks.has(st.idx)) c.stopMarks.set(st.idx, this.time);
      }
      if (sPrev < st.s && c.s >= st.s) this.onCrossStop(c, st);
    }
    this.checkBoxExit(c, sPrev);
    this.afterMove?.(c, sPrev);
  }

  /** Hook for crosswalk-entry checks (pedestrian layer). */
  afterMove?: (c: Car, sPrev: number) => void;

  private checkBoxExit(c: Car, sPrev: number) {
    for (const st of c.route.stops) {
      if (sPrev <= st.boxS1 && c.s > st.boxS1) this.metrics.exits[st.int.id].push(this.time);
    }
  }

  /** Officer command for an approach, provided by the event layer. */
  officerFor: (int: Intersection, arm: string) => "go" | "stop" | undefined = () => undefined;

  private onCrossStop(c: Car, st: StopRec) {
    c.crossed.add(st.idx);
    c.boxEnter = this.time;
    const sig = this.signals.get(st.int.id);
    const officer = this.officerFor(st.int, st.arm);
    if (sig && !sig.failed && officer !== "go") {
      const light = sig.lightFor(st.arm);
      if (light === "red" && this.time - sig.redSince[st.arm] > 0.3) {
        this.violation(c, "ran_red", `${st.int.id} from the ${armWord(st.arm)}`);
      }
    }
    if (this.isAllWay(st.int)) {
      const minV = Math.min(c.nearLineMin.get(st.idx) ?? c.v, c.v);
      if (minV > 0.447) this.violation(c, "rolled_stop", `${st.int.id} from the ${armWord(st.arm)} at ${toMph(minV).toFixed(0)} mph`);
    }
    this.onCrossStopHook?.(c, st);
  }

  onCrossStopHook?: (c: Car, st: StopRec) => void;

  private onRed(sig: Signal, arms: string[], t: number) {
    for (const { car, stop } of this.carsInBox(sig.int)) {
      if (car.kind !== "car") continue;
      if (arms.includes(stop.arm) && car.v < 0.5 && car.s > stop.boxS0 + 0.5) {
        this.violation(car, "blocked_box", `stopped in box ${sig.int.id} at red`);
      }
    }
    void t;
  }

  violation(c: Car, kind: ViolationKind, detail: string, pos?: Vec) {
    const p = pos ?? { x: c.pose.x, y: c.pose.y };
    this.metrics.violations.push({ kind, t: this.time, carId: c.id, brain: c.brain, pos: p, detail });
    this.metrics.brains[c.brain].violations++;
    this.markers.push({ pos: p, t: this.time, label: kind.replace("_", " ").toUpperCase(), kind: "violation" });
    this.pushLog({ t: this.time, kind: "violation", text: `Car ${c.label}: ${kindText(kind)} (${detail})`, carId: c.id, brain: c.brain, severity: "bad" });
  }

  pushLog(e: LogEntry) {
    this.log.push(e);
    if (this.log.length > 600) this.log.splice(0, this.log.length - 600);
  }

  // ---------------------------------------------------------------- checks

  private checkSpeeding(c: Car, dt: number) {
    if (c.kind !== "car") return;
    const lim = this.limitMphAt(c, c.center);
    const mph = toMph(c.v);
    if (mph > lim + 3) {
      c.overLimitFor += dt;
      if (c.overLimitFor > 2 && !c.speedingFlag) {
        c.speedingFlag = true;
        this.violation(c, "speeding", `${mph.toFixed(0)} mph in a ${lim} zone`);
      }
    } else {
      c.overLimitFor = 0;
      c.speedingFlag = false;
    }
    const inZone = this.inActiveSchool(c);
    if (inZone && this.time - this.schoolActiveSince > 4 && mph > 22) {
      if (!c.schoolFlag) {
        c.schoolFlag = true;
        this.violation(c, "school_speeding", `${mph.toFixed(0)} mph in the active school zone`);
      }
    } else if (!inZone) c.schoolFlag = false;
  }

  private obb(c: Car): OBB {
    const h = { x: Math.cos(c.pose.h), y: Math.sin(c.pose.h) };
    return { c: { x: c.pose.x, y: c.pose.y }, h, hl: c.L / 2, hw: c.W / 2 };
  }

  private checkCollisions() {
    const cell = 12;
    const grid = new Map<string, Car[]>();
    for (const c of this.cars) {
      const k = `${Math.floor(c.pose.x / cell)},${Math.floor(c.pose.y / cell)}`;
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push(c);
    }
    const now = new Set<string>();
    for (const c of this.cars) {
      const gx = Math.floor(c.pose.x / cell);
      const gy = Math.floor(c.pose.y / cell);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          for (const o of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
            if (o.id <= c.id) continue;
            if (!obbOverlap(this.obb(c), this.obb(o))) continue;
            const key = `${c.id}-${o.id}`;
            now.add(key);
            if (!this.collisions.has(key)) {
              const pos = { x: (c.pose.x + o.pose.x) / 2, y: (c.pose.y + o.pose.y) / 2 };
              const culprit = c.kind === "car" ? c : o;
              this.violation(culprit, "collision", `car ${c.label} and car ${o.label}`, pos);
            }
          }
        }
    }
    this.collisions = now;
  }

  private checkGridlock(dt: number) {
    for (const i of this.city.ints) {
      const inBox = this.carsInBox(i).filter(({ car, stop }) => car.s >= stop.boxS0 && car.kind === "car");
      if (inBox.length && inBox.every(({ car }) => car.v < 0.3)) {
        this.still[i.id] += dt;
        if (this.still[i.id] >= 10 && !this.gridFlag[i.id]) {
          this.gridFlag[i.id] = true;
          this.metrics.gridlocks.push({ t: this.time, int: i.id });
          this.pushLog({ t: this.time, kind: "gridlock", text: `Gridlock at ${i.id}: box frozen for 10 s`, severity: "bad" });
        }
      } else {
        this.still[i.id] = 0;
        this.gridFlag[i.id] = false;
      }
    }
  }

  // ---------------------------------------------------------------- pose

  updatePose(c: Car) {
    const smp = c.route.sample(c.center);
    const n = right(smp.t);
    c.pose = {
      x: smp.p.x + n.x * c.lat,
      y: smp.p.y + n.y * c.lat,
      h: Math.atan2(smp.t.y, smp.t.x),
    };
  }

  // ---------------------------------------------------------------- step

  /** Decision layer, registered by the scheduler. */
  decisionTick?: () => void;

  step(dt = DT) {
    this.time += dt;
    const active = this.schoolActive;
    if (active && !this.schoolWasActive) this.schoolActiveSince = this.time;
    this.schoolWasActive = active;

    for (const sig of this.signals.values()) sig.step(dt, this.time);
    for (const h of this.hooks) h.pre?.(dt);
    this.buildOcc();
    this.spawnTick();

    // Zones for the decision layer.
    for (const c of this.cars) {
      const z = this.zoneFor(c);
      if (z !== null && c.zoneId === null) c.zoneEnteredAt = this.time;
      c.zoneId = z;
    }
    this.decisionTick?.();

    for (const c of this.cars) this.controlCar(c);
    for (const c of this.cars) {
      c.prevPose = c.pose;
      this.integrate(c, dt);
      this.updatePose(c);
      this.checkSpeeding(c, dt);
      c.blink += dt;
    }
    // Despawn at the end of the route.
    const keep: Car[] = [];
    for (const c of this.cars) {
      if (c.rear > c.route.length - 0.5 && c.kind !== "stalled") {
        c.despawned = true;
        if (c.kind === "car") this.metrics.trips.push(this.time - c.spawnTime);
        this.onDespawn?.(c);
      } else keep.push(c);
    }
    this.cars = keep;
    this.checkCollisions();
    this.checkGridlock(dt);
    for (const h of this.hooks) h.post?.(dt);
    // Markers fade after 2.5 s.
    if (this.markers.length && this.markers[0].t < this.time - 3) this.markers = this.markers.filter((m) => m.t > this.time - 3);
  }

  onDespawn?: (c: Car) => void;

  /** Run with Rules for a while so the city starts busy, then reset metrics. */
  warmup(seconds: number, withRules: (sim: Simulation) => void) {
    withRules(this);
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) this.step(DT);
    this.metrics.reset(this.time);
    this.log = [];
    this.markers = [];
    this.decisionLog = [];
  }

  carById(id: number): Car | undefined {
    return this.cars.find((c) => c.id === id);
  }
}

function armWord(a: string): string {
  return ({ N: "north", E: "east", S: "south", W: "west" } as Record<string, string>)[a] ?? a;
}

function kindText(k: ViolationKind): string {
  return {
    ran_red: "ran a red light",
    rolled_stop: "rolled a stop",
    speeding: "speeding",
    school_speeding: "speeding in the school zone",
    ped_yield: "failed to yield to a pedestrian",
    ev_yield: "failed to yield to the ambulance",
    blocked_box: "blocked the box",
    collision: "collision",
  }[k];
}
