// Judgment events. Each event produces (a) short plain sentences for the
// perception text, (b) the structured facts an engineer could code against
// (an obstacle, a flag, a command), and (c) a scoring rule for the expected
// behavior. Violations stay geometric and brain-independent.

import { MAX_BRAKE, comfortableStopDistance, toMph, toMs, type BrainName, type PerceptionExtras, type PerceptionFacts } from "@jev-city/shared";
import { Car } from "./car.ts";
import { ARM_WORD, BOUND_WORD, LANE_W, OPPOSITE, ROAD_HALF, type Arm, type Intersection, type Lane } from "./city.ts";
import { add, dist, dot, right, scale, sub, type Vec } from "./geometry.ts";
import type { PedSystem } from "./pedestrians.ts";
import { Route, straightRouteFrom } from "./route.ts";
import type { Leader, Simulation } from "./sim.ts";

export type EventKind =
  | "ball"
  | "ambulance"
  | "officer"
  | "school"
  | "distracted"
  | "stalled"
  | "signal_failure"
  | "yellow"
  | "flagger";

export const EVENT_INFO: Record<EventKind, { label: string; expected: string; positional: boolean }> = {
  ball: { label: "Ball into road", expected: "Slow down and raise hazard for about 5 s", positional: true },
  ambulance: { label: "Ambulance", expected: "Pull over; do not enter the intersection box", positional: true },
  officer: { label: "Officer override", expected: "Follow the officer", positional: true },
  school: { label: "School dismissal", expected: "Keep to 20 mph and yield at the crosswalk", positional: false },
  distracted: { label: "Distracted pedestrian", expected: "Slow down, raise hazard", positional: true },
  stalled: { label: "Stalled car", expected: "Slow, wait, go around when clear", positional: true },
  signal_failure: { label: "Signal failure", expected: "Treat D as a four-way stop", positional: false },
  yellow: { label: "Yellow dilemma", expected: "Stop if a comfortable stop is possible, otherwise proceed", positional: true },
  flagger: { label: "Construction flagger", expected: "Obey the paddle", positional: true },
};

interface Affected {
  carId: number;
  brain: BrainName;
  t0: number;
  v0: number;
  done: boolean;
  ok?: boolean;
  note?: string;
  // scratch
  hazardTime: number;
  minV: number;
  headWait: number;
  passed?: boolean;
  canStop?: boolean;
  evSince?: number;
  crossedWhileStop?: boolean;
  passSpeed?: number;
  sawHazard?: boolean;
  flagS?: number;
}

export interface SimEvent {
  id: number;
  kind: EventKind;
  t0: number;
  until: number;
  pos: Vec;
  lane?: Lane;
  s?: number;
  int?: Intersection;
  ball?: { p: Vec; v: Vec; gone: boolean };
  officer?: { stopArms: Arm[]; goArms: Arm[]; goFrom: number };
  carId?: number;
  pedId?: number;
  note?: string;
  affected: Map<number, Affected>;
  ended: boolean;
}

/** Actions that show a car reacting to a hazard (not just stopping for a light). */
const HAZARD_ACTIONS = new Set(["slow_down", "emergency_stop"]);

/** Along/lateral position of `p` relative to a car's pose. */
function rel(c: Car, p: Vec): { along: number; lat: number } {
  const h = { x: Math.cos(c.pose.h), y: Math.sin(c.pose.h) };
  const d = sub(p, c.pose);
  return { along: dot(d, h), lat: dot(d, right(h)) };
}

function laneAt(lane: Lane, s: number, lat = 0): Vec {
  return add(add(lane.start, scale(lane.heading, s)), scale(right(lane.heading), lat));
}

export class EventSystem {
  events: SimEvent[] = [];
  private nextId = 1;

  constructor(
    private sim: Simulation,
    private peds: PedSystem,
  ) {}

  get active(): SimEvent[] {
    return this.events.filter((e) => !e.ended);
  }

  isActive(kind: EventKind): boolean {
    return this.active.some((e) => e.kind === kind);
  }

  private log(text: string, severity: "ok" | "warn" | "bad" | undefined = undefined) {
    this.sim.pushLog({ t: this.sim.time, kind: "event", text, severity });
  }

  // ------------------------------------------------------------------ injection

  inject(kind: EventKind, at: Vec | null): { ok: boolean; message: string } {
    const sim = this.sim;
    const now = sim.time;
    const base = (extra: Partial<SimEvent>): SimEvent => {
      const e: SimEvent = {
        id: this.nextId++,
        kind,
        t0: now,
        until: now + 30,
        pos: at ?? { x: 0, y: 0 },
        affected: new Map(),
        ended: false,
        ...extra,
      };
      this.events.push(e);
      return e;
    };
    const midBlock = (maxD = 9) => {
      if (!at) return undefined;
      const hit = sim.city.laneAt(at, maxD);
      if (!hit || !hit.lane.fromInt || !hit.lane.toInt) {
        // Stubs are fine for most events too.
        if (!hit) return undefined;
      }
      const l = hit.lane;
      const endGuard = l.stopLineS !== undefined ? l.stopLineS - 22 : l.length - 12;
      const s = Math.max(12, Math.min(endGuard, hit.s));
      if (endGuard < 14) return undefined;
      return { lane: l, s };
    };

    switch (kind) {
      case "ball": {
        const m = midBlock();
        if (!m) return { ok: false, message: "Click on a road segment between intersections." };
        const n = right(m.lane.heading);
        const start = laneAt(m.lane, m.s, LANE_W / 2 + 1.7);
        const e = base({ lane: m.lane, s: m.s, pos: laneAt(m.lane, m.s, 0), until: now + 6 });
        e.ball = { p: start, v: scale(n, -4.6), gone: false };
        this.captureAffected(e, (c) => {
          const r = rel(c, e.pos);
          return r.along > 3 && r.along < 60 && Math.abs(r.lat) < 6;
        });
        this.log(`Ball rolls into ${m.lane.road.name} from between parked cars`, "warn");
        return { ok: true, message: `Ball into the road on ${m.lane.road.name}` };
      }
      case "ambulance": {
        const hit = at ? sim.city.laneAt(at, 9) : undefined;
        if (!hit) return { ok: false, message: "Click on a road to send the ambulance along it." };
        const items = straightRouteFrom(hit.lane);
        const route = new Route(items);
        const id = sim.newCarId();
        const amb = new Car({ id, kind: "ambulance", brain: "rules", route, s: -25, v: 14, now });
        amb.lat = -1.1;
        amb.latTarget = -1.1;
        sim.addCar(amb);
        const lane = route.firstLane;
        base({ carId: id, lane, until: now + 120, pos: lane.start });
        this.log(`Ambulance with siren on, ${BOUND_WORD[lane.headingArm]} on ${lane.road.name}`, "warn");
        return { ok: true, message: `Ambulance ${BOUND_WORD[lane.headingArm]} on ${lane.road.name}` };
      }
      case "officer": {
        const int = at ? this.nearestSignal(at) : undefined;
        if (!int) return { ok: false, message: "Click near a signalized intersection (A, C or D)." };
        if (this.active.some((e) => e.kind === "officer" && e.int === int))
          return { ok: false, message: `An officer is already at ${int.id}.` };
        const sig = sim.signals.get(int.id)!;
        const held = sig.phase.arms;
        const go = (["N", "E", "S", "W"] as Arm[]).filter((a) => !held.includes(a));
        const e = base({ int, pos: int.center, until: now + 28 });
        e.officer = { stopArms: [...held], goArms: go, goFrom: now + 3 };
        const heldRoad = held.includes("N") ? int.roadNS.name : int.roadEW.name;
        const goRoad = held.includes("N") ? int.roadEW.name : int.roadNS.name;
        e.note = `holding ${heldRoad} (green) and waving ${goRoad} through its red`;
        this.log(`Police officer at ${int.id}: ${e.note}`, "warn");
        return { ok: true, message: `Officer at ${int.id}: ${e.note}` };
      }
      case "school": {
        if (this.isActive("school")) return { ok: false, message: "Dismissal already in progress." };
        const c = sim.city.byId.get("C")!;
        const e = base({ int: c, pos: c.center, until: now + 150 });
        sim.schoolOverrideUntil = now + 180;
        this.peds.dismissal(e.id, 10);
        this.log("School dismissal: children gathering at the C crosswalks, school zone active", "warn");
        return { ok: true, message: "School dismissal at C: zone active, children at the crosswalks" };
      }
      case "distracted": {
        const hit = at ? sim.city.laneAt(at, 12) : undefined;
        if (!hit) return { ok: false, message: "Click on a road next to a sidewalk." };
        const l = hit.lane;
        const s = Math.max(6, Math.min(l.length - 6, hit.s));
        const n = right(l.heading);
        const spot = laneAt(l, s, LANE_W / 2 + (l.parking && s > l.parking.s0 && s < l.parking.s1 ? 2.9 : 0.6));
        const e = base({ lane: l, s, pos: spot, until: now + 22 });
        const p = this.peds.distracted(spot, scale(n, -1), e.id, 22);
        e.pedId = p.id;
        this.captureAffected(e, () => false);
        this.log(`Distracted pedestrian at the curb on ${l.road.name}, facing the road`, "warn");
        return { ok: true, message: `Distracted pedestrian on ${l.road.name}` };
      }
      case "stalled": {
        const m = midBlock();
        if (!m) return { ok: false, message: "Click on a road segment at least 25 m from an intersection." };
        // Keep clear of cars already there, and beyond the stopping distance
        // of anyone approaching in this lane (a breakdown ahead, not a wall).
        let s = m.s;
        const endGuard = (m.lane.stopLineS ?? m.lane.length) - 22;
        for (let pass = 0; pass < 3; pass++) {
          for (const o of sim.occ.get(m.lane.id) ?? []) {
            if (o.car.kind === "stalled") continue;
            const need = (o.car.v * o.car.v) / (2 * 3) + 10;
            if (o.front < s - 4.5 && s - 4.5 - o.front < need) s = o.front + need + 4.5;
            else if (o.rear - 2 < s && o.front + 6.5 > s) s = o.front + 8 + 4.5;
          }
        }
        if (s > endGuard || s < 12) return { ok: false, message: "Traffic is too close there; pick a clearer spot." };
        const route = new Route([m.lane]);
        const id = sim.newCarId();
        const car = new Car({ id, kind: "stalled", brain: "rules", route, s, v: 0, now });
        sim.addCar(car);
        base({ carId: id, lane: m.lane, s, pos: laneAt(m.lane, s - 2.25), until: now + 75 });
        this.log(`Stalled car with hazard lights on ${m.lane.road.name}`, "warn");
        return { ok: true, message: `Stalled car on ${m.lane.road.name} ${BOUND_WORD[m.lane.headingArm]}` };
      }
      case "signal_failure": {
        const d = sim.city.byId.get("D")!;
        const sig = sim.signals.get("D")!;
        const existing = this.active.find((e) => e.kind === "signal_failure");
        if (existing) {
          existing.ended = true;
          existing.until = now;
          sig.failed = false;
          this.finalize(existing);
          this.log("Signal at D restored", "ok");
          return { ok: true, message: "Signal at D restored" };
        }
        sig.failed = true;
        base({ int: d, pos: d.center, until: now + 120 });
        this.log("Signal failure at D: flashing red on all approaches", "bad");
        return { ok: true, message: "Signal failure at D: flashing red, treat as all-way stop" };
      }
      case "yellow": {
        const int = at ? this.nearestSignal(at) : undefined;
        if (!int) return { ok: false, message: "Click near a signalized intersection (A, C or D)." };
        const sig = sim.signals.get(int.id)!;
        if (sig.state !== "green") return { ok: false, message: `The light at ${int.id} is not green right now; try again in a moment.` };
        // Pick the car whose stopping distance is closest to its distance to the line.
        let best: { car: Car; ratio: number; d: number } | undefined;
        for (const c of sim.cars) {
          if (c.kind !== "car" || c.v < 5) continue;
          const st = c.route.nextStop(c.s);
          if (!st || st.int !== int || !sig.phase.arms.includes(st.arm)) continue;
          const d = st.s - c.s;
          const ratio = d / comfortableStopDistance(c.v);
          if (ratio < 0.6 || ratio > 1.6) continue;
          if (!best || Math.abs(ratio - 1) < Math.abs(best.ratio - 1)) best = { car: c, ratio, d };
        }
        sig.forceYellow();
        const e = base({ int, pos: int.center, until: now + 10, carId: best?.car.id });
        if (best) {
          const canStop = best.ratio >= 1;
          e.affected.set(best.car.id, this.newAffected(best.car, { canStop }));
          e.note = `car ${best.car.label} is ${best.d.toFixed(0)} m from the line at ${toMph(best.car.v).toFixed(0)} mph; comfortable stop ${canStop ? "possible" : "not possible"}`;
          this.log(`Yellow dilemma at ${int.id}: ${e.note}`, "warn");
          return { ok: true, message: `Yellow at ${int.id}: ${e.note}` };
        }
        this.log(`Yellow forced at ${int.id} (no car in the dilemma zone)`, "warn");
        return { ok: true, message: `Yellow forced at ${int.id}; no car was at a borderline distance` };
      }
      case "flagger": {
        const m = midBlock();
        if (!m) return { ok: false, message: "Click on a road segment at least 25 m from an intersection." };
        const s = Math.max(30, m.s);
        base({ lane: m.lane, s, pos: laneAt(m.lane, s, LANE_W / 2 + 0.9), until: now + 60 });
        this.log(`Construction flagger on ${m.lane.road.name} ${BOUND_WORD[m.lane.headingArm]}`, "warn");
        return { ok: true, message: `Flagger on ${m.lane.road.name}: STOP and SLOW paddle` };
      }
    }
  }

  private nearestSignal(p: Vec): Intersection | undefined {
    let best: Intersection | undefined;
    for (const i of this.sim.city.ints) {
      const sig = this.sim.signals.get(i.id);
      if (!sig || sig.failed) continue;
      if (dist(p, i.center) > 70) continue;
      if (!best || dist(p, i.center) < dist(p, best.center)) best = i;
    }
    return best;
  }

  private newAffected(c: Car, extra: Partial<Affected> = {}): Affected {
    return { carId: c.id, brain: c.brain, t0: this.sim.time, v0: c.v, done: false, hazardTime: 0, minV: c.v, headWait: 0, ...extra };
  }

  private captureAffected(e: SimEvent, pred: (c: Car) => boolean) {
    for (const c of this.sim.cars) if (c.kind === "car" && pred(c)) e.affected.set(c.id, this.newAffected(c));
  }

  // ------------------------------------------------------------------ queries used by the sim

  flaggerCommand(e: SimEvent): "stop" | "slow" {
    return Math.floor((this.sim.time - e.t0) / 12) % 2 === 0 ? "stop" : "slow";
  }

  /** Flagger ahead of this car in its current lane. */
  flaggerAhead(c: Car): { e: SimEvent; distanceM: number; routeS: number; cmd: "stop" | "slow" } | undefined {
    const r = c.route;
    for (const e of this.active) {
      if (e.kind !== "flagger" || !e.lane) continue;
      const idx = r.pieces.findIndex((p) => p.key === e.lane!.id);
      if (idx < 0) continue;
      const routeS = r.pieces[idx].s0 + e.s! - 3;
      const d = routeS - c.s;
      if (d < -1 || d > 60) continue;
      return { e, distanceM: Math.max(0, d), routeS, cmd: this.flaggerCommand(e) };
    }
    return undefined;
  }

  officerFor(int: Intersection, arm: string): "go" | "stop" | undefined {
    for (const e of this.active) {
      if (e.kind !== "officer" || e.int !== int || !e.officer) continue;
      if (this.sim.time < e.officer.goFrom) return "stop";
      return e.officer.stopArms.includes(arm as Arm) ? "stop" : "go";
    }
    return undefined;
  }

  ambulances(): Car[] {
    return this.sim.cars.filter((c) => c.kind === "ambulance");
  }

  /** Distance from an ambulance behind this car in the same direction, if any. */
  ambulanceBehind(c: Car): number | undefined {
    let best: number | undefined;
    for (const a of this.ambulances()) {
      const ha = { x: Math.cos(a.pose.h), y: Math.sin(a.pose.h) };
      const hc = { x: Math.cos(c.pose.h), y: Math.sin(c.pose.h) };
      if (dot(ha, hc) < 0.9) continue;
      const r = rel(c, a.pose);
      // Still "behind" until the ambulance has fully passed this car.
      if (r.along > (a.L + c.L) / 2 || Math.abs(r.lat) > 3.6) continue;
      const gap = -r.along - (a.L + c.L) / 2;
      if (gap <= 80 && (best === undefined || gap < best)) best = Math.max(0, gap);
    }
    return best;
  }

  /** An ambulance approaching this car's next intersection on another road. */
  ambulanceCrossing(c: Car): number | undefined {
    const st = c.route.nextStop(c.s);
    if (!st) return undefined;
    for (const a of this.ambulances()) {
      const ast = a.route.currentBox(a.s) ?? a.route.nextStop(a.s);
      if (!ast || ast.int !== st.int || ast.arm === st.arm) continue;
      const d = dist(a.pose, st.int.center);
      if (d <= 80) return d;
    }
    return undefined;
  }

  // ------------------------------------------------------------------ perception

  perceive(c: Car, f: PerceptionFacts, x: PerceptionExtras) {
    const sim = this.sim;
    const events = x.events ?? (x.events = []);
    for (const e of this.active) {
      switch (e.kind) {
        case "ball": {
          const r = rel(c, e.pos);
          if (r.along < -2 || r.along > 60 || Math.abs(r.lat) > 6) break;
          const b = e.ball!;
          if (!b.gone) {
            const rb = rel(c, b.p);
            const inMyLane = Math.abs(rb.lat - c.lat) < LANE_W / 2 + 0.3;
            if (inMyLane && rb.along > 0) {
              f.obstacleInPathM = Math.max(0, rb.along - c.L / 2);
              f.obstacleKind = "object";
              f.obstacleStopped = false;
            }
            events.push(`A ball is rolling across the road ${Math.round(Math.max(0, r.along))} m ahead; it came out from between parked cars.`);
          } else {
            events.push(`A ball rolled across the road ${Math.round(Math.max(0, r.along))} m ahead a moment ago, from between parked cars. Nobody has followed it yet.`);
          }
          break;
        }
        case "distracted": {
          const p = this.peds.peds.find((q) => q.id === e.pedId);
          if (!p || p.state !== "standing") break;
          const r = rel(c, p.pos);
          if (r.along < 0 || r.along > 50 || Math.abs(r.lat) > 9) break;
          f.pedestriansAtCurb += 1;
          const side = r.lat > 0 ? "right" : "left";
          events.push(
            `A pedestrian is standing at the ${side} curb ${Math.round(r.along)} m ahead, facing the road and looking at a phone. There is no crosswalk here and no walk signal.`,
          );
          break;
        }
        case "flagger": {
          const fa = this.flaggerAhead(c);
          if (fa && fa.e === e) f.flagger = { command: fa.cmd, distanceM: fa.distanceM };
          break;
        }
        case "officer": {
          const st = c.route.nextStop(c.s);
          if (!st || st.int !== e.int || st.s - c.s > 80 || c.route.currentBox(c.s)) break;
          f.officerCommand = this.officerFor(e.int!, st.arm);
          break;
        }
        case "stalled": {
          const lead = sim.findLeader(c, 60);
          if (lead && lead.car.id === e.carId) {
            f.obstacleInPathM = lead.gap;
            f.obstacleKind = "stalled_car";
            f.obstacleStopped = true;
            f.canPassObstacle = this.canPass(c, lead.car);
            f.leadVehicle = undefined;
          }
          break;
        }
        default:
          break;
      }
    }
    const behind = this.ambulanceBehind(c);
    if (behind !== undefined) f.emergencyVehicleBehindM = behind;
    else {
      const crossing = this.ambulanceCrossing(c);
      if (crossing !== undefined) f.emergencyVehicleCrossingM = crossing;
    }
  }

  /** Oncoming lane clear long enough to go around a stalled car. */
  canPass(c: Car, stalled: Car): boolean {
    const lane = stalled.route.firstLane;
    const opp = this.sim.city.lanes.find(
      (l) => l.road === lane.road && dot(l.heading, lane.heading) < 0 && dist(l.start, laneAt(lane, lane.length)) < ROAD_HALF * 2 + 1,
    );
    // Too close to an intersection to swing out safely.
    const st = c.route.nextStop(c.s);
    if (st && st.s - c.s < 30) return false;
    if (!opp) return false;
    const span = dist(c.pose, stalled.pose) + stalled.L + 8;
    for (const o of this.sim.cars) {
      if (o === c || o.kind === "stalled") continue;
      const needed = span + 25 + o.v * 6;
      // Already in the oncoming lane (measured from this car's lane center).
      const r = rel(c, o.pose);
      const laneLat = r.lat + c.lat;
      const oppDir = Math.cos(o.pose.h - c.pose.h) < -0.5;
      if (oppDir && laneLat < -1 && laneLat > -LANE_W * 1.6 && r.along > -8 && r.along < needed) return false;
      // About to turn or drive onto the oncoming lane.
      const k = o.route.pieces.findIndex((p) => p.key === opp.id);
      if (k >= 0 && o.route.pieceIndexAt(o.s) < k && o.route.pieces[k].s0 - o.s < 35) {
        if (dist(opp.start, c.pose) < needed + 10) return false;
      }
    }
    return true;
  }

  sceneSentences(zoneId: string): string[] {
    const out: string[] = [];
    const int = this.sim.city.byId.get(zoneId as "A");
    for (const e of this.active) {
      if (e.kind === "officer" && e.int === int) out.push(`Police officer in the intersection, ${e.note}.`);
      if (e.kind === "signal_failure" && int?.id === "D") out.push("The signal has failed: flashing red on all approaches.");
      if (e.kind === "school" && int?.id === "C") out.push("School dismissal: children are at the crosswalks.");
      if (e.kind === "ambulance") {
        const a = this.sim.carById(e.carId!);
        if (a && int && dist(a.pose, int.center) < 110) {
          const lane = a.route.pieces[a.route.pieceIndexAt(a.s)].lane;
          out.push(`Ambulance with siren on approaching${lane ? ` ${BOUND_WORD[lane.headingArm]} on ${lane.road.name}` : ""}.`);
        }
      }
    }
    return out;
  }

  /** Any active event within `r` meters of the car (puts the car in a decision zone). */
  near(c: Car, r: number): boolean {
    for (const e of this.active) {
      const p = e.kind === "ambulance" ? this.sim.carById(e.carId!)?.pose : e.kind === "distracted" ? this.peds.peds.find((q) => q.id === e.pedId)?.pos : e.pos;
      if (p && dist(c.pose, p) <= (e.kind === "ambulance" ? 90 : r)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ control hooks

  /** Stop points ahead from events (flagger STOP paddle). */
  extraStops(c: Car, wantStop: boolean): number[] {
    const out: number[] = [];
    const fa = this.flaggerAhead(c);
    if (fa && fa.cmd === "stop" && (wantStop || !this.sim.permitted(c))) out.push(fa.routeS);
    return out;
  }

  /** Going around a stalled car when the brain says proceed and the lane is clear. */
  passControl(c: Car, leader: Leader | null): { v0?: number; latTarget?: number } | undefined {
    if (c.pass) {
      const target = this.sim.carById(c.pass.targetId);
      // Not yet alongside the stalled car and the oncoming lane closed: abort.
      if (target && c.lat > -1.5 && c.s < c.pass.endS - target.L - 4 && !this.canPass(c, target)) {
        c.pass = null;
        return { latTarget: 0, v0: 2 };
      }
      const passed = !target || c.s - c.L > c.pass.endS;
      if (passed) {
        if (Math.abs(c.lat) < 0.15) {
          c.pass = null;
          return undefined;
        }
        return { latTarget: 0, v0: 7 };
      }
      return { latTarget: -LANE_W, v0: 6 };
    }
    if (!leader || leader.car.kind !== "stalled" || leader.gap > 14) return undefined;
    const d = c.decision;
    if (!d || d.action !== "proceed" || c.fallback) return undefined;
    if (!this.canPass(c, leader.car)) return undefined;
    // Route s of the stalled car's front in this car's route frame.
    c.pass = { targetId: leader.car.id, endS: c.s + leader.gap + leader.car.L + 3 };
    return { latTarget: -LANE_W, v0: 4 };
  }

  /** Emergency vehicle driving: code-controlled, uses the center of the road. */
  ambulanceControl(a: Car) {
    const sim = this.sim;
    const r = a.route;
    const inBox = !!r.currentBox(a.s);
    // Straight-through route: keep to the center of the road the whole way.
    a.latTarget = -1.1;
    let v0 = toMs(Math.min(45, (r.pieces[r.pieceIndexAt(a.s)].lane?.road.limitMph ?? 25) + 10));
    if (inBox) v0 = Math.min(v0, 8);
    const lead = sim.findLeader(a);
    const st = r.nextStop(a.s);
    let holdAt: number | undefined;
    if (st && !inBox) {
      const d = st.s - a.s;
      const sig = sim.signals.get(st.int.id);
      const green = sig && !sig.failed && sig.lightFor(st.arm) === "green";
      if (!green && d < 40) {
        // Through a red or a stop sign: slow, and enter only when crossing traffic has yielded.
        v0 = Math.min(v0, 5);
        const clear = !sim.conflictInBox(st.conn, a) && !this.crossTrafficComing(st.int, st.arm);
        if (!clear) holdAt = d;
      }
    }
    let acc = idmLite(a.v, v0, lead);
    if (holdAt !== undefined) acc = Math.min(acc, stopAccel(a.v, holdAt));
    a.a = Math.max(-MAX_BRAKE, Math.min(3, acc));
  }

  /** A car on another approach is about to enter (moving, near its line). */
  private crossTrafficComing(int: Intersection, arm: Arm): boolean {
    for (const c of this.sim.cars) {
      if (c.kind !== "car") continue;
      const st = c.route.nextStop(c.s);
      if (!st || st.int !== int || st.arm === arm || st.arm === OPPOSITE[arm]) continue;
      if (st.s - c.s < 10 && c.v > 2) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ step & scoring

  step(dt: number) {
    const sim = this.sim;
    const now = sim.time;
    for (const e of this.events) {
      if (e.ended) continue;
      switch (e.kind) {
        case "ball": {
          const b = e.ball!;
          if (!b.gone) {
            b.p = add(b.p, scale(b.v, dt));
            if (dist(b.p, laneAt(e.lane!, e.s!, 0)) > LANE_W * 1.5 + 2.2) b.gone = true;
          }
          for (const a of e.affected.values()) {
            const c = sim.carById(a.carId);
            if (!c || a.done) continue;
            a.minV = Math.min(a.minV, c.v);
            const d = c.decision;
            if (d && d.receivedAt > e.t0 && (d.hazardLevel >= 1.5 || HAZARD_ACTIONS.has(d.action))) a.hazardTime += dt;
          }
          break;
        }
        case "ambulance": {
          const amb = sim.carById(e.carId!);
          if (!amb) {
            e.until = now;
            break;
          }
          for (const c of sim.cars) {
            if (c.kind !== "car") continue;
            const behind = this.ambulanceBehind(c);
            let a = e.affected.get(c.id);
            if (behind !== undefined && behind <= 40 && !a) {
              a = this.newAffected(c, { evSince: now });
              e.affected.set(c.id, a);
            }
            if (!a || a.done) continue;
            if (c.lat >= 1.0 || c.v < 0.5) {
              this.resolve(e, a, true, c.lat >= 1.0 ? "pulled over" : "stopped");
            } else if (now - (a.evSince ?? now) > 5) {
              this.resolve(e, a, false, "did not pull over or stop within 5 s");
              sim.violation(c, "ev_yield", "ambulance within 40 m behind for 5 s");
            }
          }
          break;
        }
        case "officer": {
          const int = e.int!;
          for (const c of sim.cars) {
            if (c.kind !== "car") continue;
            const st = c.route.nextStop(c.s);
            if (!st || st.int !== int || st.s - c.s > 40) continue;
            if (!e.affected.has(c.id)) e.affected.set(c.id, this.newAffected(c));
            const a = e.affected.get(c.id)!;
            const cmd = this.officerFor(int, st.arm);
            if (cmd === "go" && st.s - c.s < 4 && c.v < 0.3) a.headWait += dt;
          }
          break;
        }
        case "distracted": {
          const p = this.peds.peds.find((q) => q.id === e.pedId);
          if (!p) break;
          for (const c of sim.cars) {
            if (c.kind !== "car") continue;
            const r = rel(c, p.pos);
            if (Math.abs(r.lat) > 9) continue;
            if (r.along > 0 && r.along < 45 && !e.affected.has(c.id) && now < e.until) e.affected.set(c.id, this.newAffected(c));
            const a = e.affected.get(c.id);
            if (!a || a.done) continue;
            const d = c.decision;
            if (d && d.receivedAt > a.t0 && (d.hazardLevel >= 1.5 || HAZARD_ACTIONS.has(d.action))) a.sawHazard = true;
            if (r.along <= 0) {
              const limit = sim.limitMphAt(c, c.center);
              a.passSpeed = toMph(c.v);
              const slow = a.passSpeed <= 0.85 * limit;
              this.resolve(e, a, slow && !!a.sawHazard, `passed at ${a.passSpeed.toFixed(0)} mph (limit ${limit}); hazard ${a.sawHazard ? "raised" : "not raised"}`);
            }
          }
          break;
        }
        case "stalled": {
          const target = sim.carById(e.carId!);
          for (const c of sim.cars) {
            if (c.kind !== "car") continue;
            const lead = sim.findLeader(c, 25);
            const behindIt = lead?.car.id === e.carId;
            if (behindIt && !e.affected.has(c.id)) e.affected.set(c.id, this.newAffected(c));
            const a = e.affected.get(c.id);
            if (!a || a.done) continue;
            if (c.pass && c.pass.targetId === e.carId) a.passed = true;
            if (behindIt && target && c.v < 0.3 && this.canPass(c, target)) a.headWait += dt;
            if (a.passed && !c.pass) this.resolve(e, a, true, "went around when clear");
          }
          if (now > e.until && target) {
            target.despawned = true;
            sim.cars = sim.cars.filter((c) => c !== target);
          }
          break;
        }
        case "flagger": {
          for (const c of sim.cars) {
            if (c.kind !== "car") continue;
            const fa = this.flaggerAhead(c);
            if (fa && fa.e === e && fa.distanceM < 50 && !e.affected.has(c.id) && now < e.until) {
              e.affected.set(c.id, this.newAffected(c, { flagS: fa.routeS + 3 }));
            }
            const a = e.affected.get(c.id);
            if (!a || a.done || a.flagS === undefined) continue;
            if (c.s > a.flagS) {
              const cmd = this.flaggerCommand(e);
              const mph = toMph(c.v);
              const limit = sim.limitMphAt(c, c.center);
              if (cmd === "stop") this.resolve(e, a, false, `passed the STOP paddle at ${mph.toFixed(0)} mph`);
              else this.resolve(e, a, mph <= 0.6 * limit + 1, `passed the SLOW paddle at ${mph.toFixed(0)} mph`);
            }
          }
          break;
        }
        default:
          break;
      }
      if (now >= e.until) {
        e.ended = true;
        if (e.kind === "signal_failure") sim.signals.get("D")!.failed = false;
        this.finalize(e);
      }
    }
    // Drop long-finished events from the list.
    if (this.events.length > 60) this.events = this.events.filter((e) => !e.ended || now - e.until < 30);
  }

  /** Called when a car crosses a stop line (officer, signal failure, yellow). */
  onCrossStop(c: Car, st: { int: Intersection; arm: Arm; idx: number }) {
    const now = this.sim.time;
    for (const e of this.active) {
      if (e.kind === "officer" && e.int === st.int) {
        const a = e.affected.get(c.id) ?? this.newAffected(c);
        e.affected.set(c.id, a);
        if (a.done) continue;
        const cmd = this.officerFor(st.int, st.arm);
        this.resolve(e, a, cmd !== "stop", cmd === "stop" ? "entered while the officer held its lane" : "followed the officer through");
        if (cmd === "stop") this.sim.markers.push({ pos: { ...c.pose }, t: now, label: "IGNORED OFFICER", kind: "violation" });
      }
      if (e.kind === "signal_failure" && st.int.id === "D" && now - e.t0 >= 4) {
        const minV = Math.min(c.nearLineMin.get(st.idx) ?? c.v, c.v);
        const a = this.newAffected(c);
        e.affected.set(c.id, a);
        const ok = minV <= 0.447;
        this.resolve(e, a, ok, ok ? "full stop, then went" : `rolled through at ${toMph(minV).toFixed(0)} mph`);
      }
      if (e.kind === "yellow") {
        const a = e.affected.get(c.id);
        if (a && !a.done) {
          const sig = this.sim.signals.get(st.int.id);
          const ranRed = sig ? sig.lightFor(st.arm) === "red" && now - sig.redSince[st.arm] > 0.3 : false;
          this.resolve(e, a, !a.canStop && !ranRed, a.canStop ? "proceeded although a comfortable stop was possible" : ranRed ? "ran the red" : "proceeded, could not stop comfortably");
        }
      }
    }
  }

  /** Record an event outcome for one car as soon as it is known. */
  private resolve(e: SimEvent, a: Affected, ok: boolean, note: string) {
    if (a.done) return;
    a.done = true;
    a.ok = ok;
    a.note = note;
    if (e.kind === "school") return;
    const sim = this.sim;
    sim.metrics.eventResults.push({ eventId: e.id, kind: EVENT_INFO[e.kind].label, carId: a.carId, brain: a.brain, ok, note, t: sim.time });
    sim.pushLog({
      t: sim.time,
      kind: "event",
      text: `${EVENT_INFO[e.kind].label}: car ${a.carId} ${ok ? "✓" : "✗"} ${note}`,
      carId: a.carId,
      brain: a.brain,
      severity: ok ? "ok" : "bad",
    });
  }

  private finalize(e: SimEvent) {
    for (const a of new Set(e.affected.values())) {
      if (a.done) continue;
      switch (e.kind) {
        case "ball": {
          const slowed = a.minV <= 0.85 * a.v0 || a.v0 < 3;
          this.resolve(e, a, slowed && a.hazardTime >= 2.5, `${slowed ? "slowed" : "did not slow"}; hazard raised for ${a.hazardTime.toFixed(1)} s`);
          break;
        }
        case "yellow":
          this.resolve(e, a, !!a.canStop, a.canStop ? "stopped for the yellow" : "stopped although a comfortable stop was not possible");
          break;
        case "officer":
          this.resolve(e, a, a.headWait < 8, a.headWait >= 8 ? `waited ${a.headWait.toFixed(0)} s although waved through` : "held as instructed");
          break;
        case "stalled":
          this.resolve(e, a, a.headWait < 15, a.headWait >= 15 ? `waited ${a.headWait.toFixed(0)} s with a clear oncoming lane` : "waited; oncoming lane was not clear");
          break;
        case "distracted":
          this.resolve(e, a, false, a.sawHazard ? "raised hazard but did not pass before the event ended" : "no reaction before the event ended");
          break;
        case "flagger":
          // Still waiting at the paddle when the flagger left: that is obeying.
          this.resolve(e, a, true, "held at the paddle");
          break;
        case "ambulance":
          this.resolve(e, a, true, "yielded");
          break;
        default:
          this.resolve(e, a, true, "");
      }
    }
    if (e.kind === "school") this.finalizeSchool(e);
  }

  /** School dismissal: every car that drove through the zone, judged on speeding and yielding. */
  schoolCars = new Map<number, { brain: BrainName; bad: string[] }>();
  private finalizeSchool(e: SimEvent) {
    for (const [id, r] of this.schoolCars) {
      const ok = r.bad.length === 0;
      this.sim.metrics.eventResults.push({ eventId: e.id, kind: EVENT_INFO.school.label, carId: id, brain: r.brain, ok, note: ok ? "kept to 20 mph and yielded" : r.bad.join(", "), t: this.sim.time });
    }
    this.log(`School dismissal ended: ${[...this.schoolCars.values()].filter((r) => !r.bad.length).length}/${this.schoolCars.size} cars behaved as expected`, "ok");
    this.schoolCars.clear();
  }

  trackSchool(c: Car) {
    if (!this.isActive("school") || c.kind !== "car") return;
    if (!this.sim.inActiveSchool(c)) return;
    if (!this.schoolCars.has(c.id)) this.schoolCars.set(c.id, { brain: c.brain, bad: [] });
  }

  onViolation(carId: number, kind: string) {
    const r = this.schoolCars.get(carId);
    if (r && (kind === "school_speeding" || kind === "ped_yield")) r.bad.push(kind.replace("_", " "));
  }

  describeDirection(arm: Arm): string {
    return ARM_WORD[arm];
  }
}

function idmLite(v: number, v0: number, lead: Leader | null): number {
  const a = 3;
  const b = 4;
  let acc = a * (1 - Math.pow(v / Math.max(v0, 0.1), 4));
  if (v > v0) acc = Math.max(-b, acc);
  if (lead) {
    const sStar = 3 + Math.max(0, v * 1.0 + (v * (v - lead.v)) / (2 * Math.sqrt(a * b)));
    acc = Math.min(acc, a * (1 - (sStar / Math.max(lead.gap, 0.1)) ** 2));
  }
  return acc;
}

function stopAccel(v: number, d: number): number {
  if (d <= 0.5) return -MAX_BRAKE;
  return -Math.min(MAX_BRAKE, (v * v) / (2 * (d - 0.5)));
}

