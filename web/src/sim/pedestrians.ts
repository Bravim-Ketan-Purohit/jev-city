// Pedestrians: simple agents at the C crosswalks (wait at the curb, cross on
// WALK), school children at dismissal, and roadside pedestrians placed by
// events (the distracted pedestrian).

import { streamRng, type Rng } from "@jev-city/shared";
import { ARM_DIR, BOX_HALF, LY, ROAD_HALF, SIDEWALK, type Arm, type Crosswalk, type Intersection } from "./city.ts";
import { add, dist, norm, right, scale, sub, type Vec } from "./geometry.ts";
import type { Simulation } from "./sim.ts";

export type PedKind = "adult" | "child" | "distracted";
export type PedState = "approach" | "waiting" | "crossing" | "leaving" | "standing" | "gathered";

export interface Ped {
  id: number;
  kind: PedKind;
  pos: Vec;
  facing: Vec;
  state: PedState;
  speed: number;
  /** Crosswalk this pedestrian uses, and the direction across it. */
  cw?: Crosswalk;
  fromA?: boolean;
  /** Waypoints for approach / leave. */
  path: Vec[];
  born: number;
  until?: number;
  /** 0..1: how far a child at the curb is leaning/stepping toward the road. */
  stepping: number;
  eventId?: number;
  phone?: boolean;
}

export class PedSystem {
  peds: Ped[] = [];
  private rng: Rng;
  private nextId = 1;
  private nextSpawn = 4;
  private readonly c: Intersection;

  constructor(private sim: Simulation) {
    this.rng = streamRng(sim.opts.seed, "peds");
    this.c = sim.city.byId.get("C")!;
  }

  private cwEnds(cw: Crosswalk, fromA: boolean): { start: Vec; end: Vec } {
    return fromA ? { start: cw.a, end: cw.b } : { start: cw.b, end: cw.a };
  }

  /** A point on the sidewalk further along the arm from a crosswalk end. */
  private outward(cw: Crosswalk, end: Vec, d: number): Vec {
    return add(end, scale(ARM_DIR[cw.arm], d));
  }

  spawnCrosser(kind: PedKind, cw: Crosswalk, fromA: boolean, delay = 0, eventId?: number): Ped {
    const { start } = this.cwEnds(cw, fromA);
    const origin = this.outward(cw, start, 14 + this.rng.range(0, 6));
    const p: Ped = {
      id: this.nextId++,
      kind,
      pos: origin,
      facing: norm(sub(start, origin)),
      state: "approach",
      speed: kind === "child" ? 1.0 + this.rng.range(0, 0.25) : 1.2 + this.rng.range(0, 0.3),
      cw,
      fromA,
      path: [add(start, { x: this.rng.range(-0.5, 0.5) * (cw.arm === "N" || cw.arm === "S" ? 0 : 1), y: 0 })],
      born: this.sim.time + delay,
      stepping: 0,
      eventId,
    };
    this.peds.push(p);
    return p;
  }

  /** School children: some cross at C, some gather at the south-west corner. */
  dismissal(eventId: number, count = 10) {
    const cwW = this.c.crosswalks.W!;
    const cwS = this.c.crosswalks.S!;
    const school: Vec = { x: -ROAD_HALF - SIDEWALK - 14, y: LY + ROAD_HALF + SIDEWALK + 6 };
    for (let i = 0; i < count; i++) {
      const delay = i * 1.3 + this.rng.range(0, 1);
      if (i % 3 === 2) {
        // Gather on the south-west corner near the curb and linger.
        const spot = add(cwS.b, { x: -this.rng.range(0.4, 3.5), y: this.rng.range(0.3, 2.2) });
        this.peds.push({
          id: this.nextId++,
          kind: "child",
          pos: add(school, { x: this.rng.range(-2, 2), y: this.rng.range(-2, 2) }),
          facing: { x: 1, y: 0 },
          state: "approach",
          speed: 1.0,
          path: [spot],
          born: this.sim.time + delay,
          until: this.sim.time + 95 + this.rng.range(0, 20),
          stepping: 0,
          eventId,
        });
      } else {
        const cw = i % 2 === 0 ? cwW : cwS;
        // South-west corner is `a` on the west crosswalk and `b` on the south one.
        const p = this.spawnCrosser("child", cw, cw === cwW, delay, eventId);
        p.pos = add(school, { x: this.rng.range(-2, 2), y: this.rng.range(-2, 2) });
        p.path = [{ x: -ROAD_HALF - 3, y: LY + ROAD_HALF + 3 }, ...p.path];
      }
    }
  }

  /** A pedestrian standing at the curb facing the road, looking at a phone. */
  distracted(at: Vec, facing: Vec, eventId: number, seconds = 22): Ped {
    const p: Ped = {
      id: this.nextId++,
      kind: "distracted",
      pos: at,
      facing,
      state: "standing",
      speed: 1.1,
      path: [],
      born: this.sim.time,
      until: this.sim.time + seconds,
      stepping: 0,
      eventId,
      phone: true,
    };
    this.peds.push(p);
    return p;
  }

  step(dt: number) {
    const sim = this.sim;
    const now = sim.time;
    // Regular pedestrians at C.
    if (now >= this.nextSpawn) {
      this.nextSpawn = now + this.rng.range(9, 20);
      const arms: Arm[] = ["N", "E", "S", "W"];
      const cw = this.c.crosswalks[this.rng.pick(arms)]!;
      this.spawnCrosser("adult", cw, this.rng.chance(0.5));
    }
    const sig = sim.signals.get("C")!;
    const keep: Ped[] = [];
    for (const p of this.peds) {
      if (now < p.born) {
        keep.push(p);
        continue;
      }
      let alive = true;
      switch (p.state) {
        case "approach":
        case "leaving": {
          const target = p.path[0];
          if (!target) {
            alive = p.state !== "leaving";
            if (p.state === "approach") p.state = p.cw ? "waiting" : "gathered";
            break;
          }
          const d = sub(target, p.pos);
          const L = Math.hypot(d.x, d.y);
          if (L < 0.15) {
            p.path.shift();
            if (!p.path.length) {
              if (p.state === "leaving") alive = false;
              else p.state = p.cw ? "waiting" : "gathered";
            }
          } else {
            const step = Math.min(L, p.speed * dt);
            p.facing = scale(d, 1 / L);
            p.pos = add(p.pos, scale(p.facing, step));
          }
          break;
        }
        case "waiting": {
          const cw = p.cw!;
          const { start, end } = this.cwEnds(cw, p.fromA!);
          p.facing = norm(sub(end, start));
          const w = sig.walkFor(cw.arm);
          // Pedestrians look before stepping off the curb, even on WALK.
          if ((w === "walk" || w === "dark") && !this.carArriving(cw)) {
            p.state = "crossing";
          }
          break;
        }
        case "crossing": {
          const cw = p.cw!;
          const { end } = this.cwEnds(cw, p.fromA!);
          const d = sub(end, p.pos);
          const L = Math.hypot(d.x, d.y);
          if (L < 0.15) {
            p.state = "leaving";
            p.path = [this.outward(cw, end, 14)];
          } else {
            p.facing = scale(d, 1 / L);
            p.pos = add(p.pos, scale(p.facing, Math.min(L, p.speed * dt)));
          }
          break;
        }
        case "gathered": {
          // Children at the curb; now and then one steps toward the road.
          const phase = (now + p.id * 3.7) % 9;
          p.stepping = phase < 2.2 ? Math.sin((phase / 2.2) * Math.PI) : 0;
          p.facing = { x: 1, y: 0 };
          if (p.until !== undefined && now > p.until) {
            p.state = "leaving";
            p.path = [add(p.pos, { x: -18, y: 6 })];
          }
          break;
        }
        case "standing": {
          if (p.until !== undefined && now > p.until) {
            p.state = "leaving";
            p.path = [add(p.pos, scale(right(p.facing), 16))];
          }
          break;
        }
      }
      if (alive) keep.push(p);
    }
    this.peds = keep;
    sim.childrenNearSchool = this.peds.some(
      (p) => p.kind === "child" && now >= p.born && dist(p.pos, this.c.center) < 60,
    );
  }

  /** A moving car will reach this crosswalk within about 2 s. */
  private carArriving(cw: Crosswalk): boolean {
    for (const c of this.sim.cars) {
      if (c.v < 1) continue;
      for (const rc of c.route.crosswalks) {
        if (rc.cw !== cw) continue;
        const d = rc.s0 - c.s;
        if (d > -c.L && d < c.v * 2 + 2) return true;
      }
    }
    return false;
  }

  /** Pedestrians on the crosswalk, including one stepping off the curb into it. */
  inCrosswalk(cw: Crosswalk): Ped[] {
    return this.peds.filter((p) => p.cw === cw && p.state === "crossing" && this.sim.time >= p.born);
  }

  /** Pedestrians waiting at either curb of a crosswalk (incl. children gathered there). */
  atCurb(cw: Crosswalk): Ped[] {
    return this.peds.filter(
      (p) =>
        this.sim.time >= p.born &&
        ((p.cw === cw && p.state === "waiting") ||
          (p.state === "gathered" && (dist(p.pos, cw.a) < 5 || dist(p.pos, cw.b) < 5))),
    );
  }

  /** Is a crosswalk's walking line within the box distance of its intersection? */
  static nearBox(p: Vec, i: Intersection): boolean {
    return Math.abs(p.x - i.center.x) < BOX_HALF + 6 && Math.abs(p.y - i.center.y) < BOX_HALF + 6;
  }
}
