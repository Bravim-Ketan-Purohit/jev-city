// Optional simulation layers: pedestrians and judgment events, plus the
// crosswalk facts, yield stops, pedestrian reflex and failed-to-yield check.

import type { Car } from "./car.ts";
import { ARM_DIR } from "./city.ts";
import { dot, right, sub } from "./geometry.ts";
import { EventSystem } from "./events.ts";
import { PedSystem, type Ped } from "./pedestrians.ts";
import type { RouteCrosswalk } from "./route.ts";
import type { Simulation } from "./sim.ts";

export interface LayerOptions {
  pedestrians: boolean;
}

export interface Layers {
  peds: PedSystem;
  events: EventSystem;
}

const layerMap = new WeakMap<Simulation, Layers>();
export const layersOf = (sim: Simulation): Layers | undefined => layerMap.get(sim);

/** Crosswalks on the car's path that it has not fully passed, nearest first. */
function crosswalksAhead(c: Car, within = 60): RouteCrosswalk[] {
  return c.route.crosswalks.filter((rc) => rc.s1 > c.s - 0.5 && rc.s0 - c.s <= within).sort((a, b) => a.s0 - b.s0);
}

/** Lateral distance of a pedestrian from the car's path where it crosses the crosswalk. */
function lateralFromPath(c: Car, rc: RouteCrosswalk, p: Ped): number {
  const at = c.route.sample((rc.s0 + rc.s1) / 2).p;
  const axis = right(ARM_DIR[rc.cw.arm]);
  return Math.abs(dot(sub(p.pos, at), axis));
}

export function installLayers(sim: Simulation, opts: LayerOptions): Layers {
  const peds = new PedSystem(sim);
  const events = new EventSystem(sim, peds);
  const layers = { peds, events };
  layerMap.set(sim, layers);
  if (!opts.pedestrians) peds.step = () => {};

  sim.hooks.push({
    pre: (dt) => {
      peds.step(dt);
      events.step(dt);
    },
    post: () => {
      for (const c of sim.cars) events.trackSchool(c);
    },
  });

  sim.eventNear = (c) => events.near(c, sim.opts.decision.eventRadiusM);
  sim.sceneEvents = (zone) => events.sceneSentences(zone);
  sim.officerFor = (int, arm) => events.officerFor(int, arm);
  sim.passControl = (c, l) => events.passControl(c, l);
  sim.ambulanceControl = (a) => events.ambulanceControl(a);
  sim.crossStopHooks.push((c, st) => events.onCrossStop(c, st));
  sim.onViolation = (c, kind) => events.onViolation(c.id, kind);

  // Pedestrian facts for the perception.
  sim.perceptionHooks.push((c, f, x) => {
    const ahead = crosswalksAhead(c).slice(0, 2);
    let nearest: { d: number; rc: RouteCrosswalk } | undefined;
    let children = 0;
    let stepping = false;
    for (const rc of ahead) {
      const inCw = peds.inCrosswalk(rc.cw);
      const curb = peds.atCurb(rc.cw);
      f.pedestriansInCrosswalk += inCw.length;
      f.pedestriansAtCurb += curb.length;
      children += [...inCw, ...curb].filter((p) => p.kind === "child").length;
      if (curb.some((p) => p.stepping > 0.4)) stepping = true;
      const d = Math.max(0, rc.s0 - c.s);
      if ((inCw.length || curb.length) && (!nearest || d < nearest.d)) nearest = { d, rc };
    }
    if (nearest) {
      f.crosswalkAheadM = nearest.d;
      x.crosswalkWhere =
        nearest.rc.where === "entry" ? "just past the stop line" : c.route.currentBox(c.s) ? "just past the turn" : "on the far side of the intersection";
      if (children) {
        const inC = f.pedestriansInCrosswalk;
        const parts: string[] = [];
        if (inC) parts.push(`${inC} ${inC > 1 ? "people" : "person"} in it`);
        if (f.pedestriansAtCurb) parts.push(`${f.pedestriansAtCurb} waiting at the curb`);
        x.pedestrianDetail = `Crosswalk ${Math.round(nearest.d)} m ahead (${x.crosswalkWhere}): ${parts.join(", ")}; ${children} of them are children${stepping ? ", one stepping toward the road" : ""}.`;
        x.childrenPresent = true;
      }
    } else if (ahead.length && sim.schoolActive && sim.childrenNearSchool && ahead[0].cw.int.school) {
      x.childrenPresent = true;
    }
    if (sim.childrenNearSchool && sim.inActiveSchool(c)) x.childrenPresent = true;
    events.perceive(c, f, x);
  });

  // Yield stop before a crosswalk with people in it, plus event stop points.
  sim.extraStops = (c, want) => {
    const out = events.extraStops(c, want);
    if (!want) return out;
    for (const rc of crosswalksAhead(c, 45)) {
      if (rc.s0 - c.s < -0.2) continue;
      if (peds.inCrosswalk(rc.cw).some((p) => lateralFromPath(c, rc, p) < 6)) out.push(rc.s0 - 1.0);
    }
    return out;
  };

  // Safety reflex: about to enter a crosswalk with a pedestrian in the car's path.
  sim.crosswalkThreat = (c, planned) => {
    for (const rc of crosswalksAhead(c, 25)) {
      if (rc.s0 - c.s < -0.2) continue;
      if (!peds.inCrosswalk(rc.cw).some((p) => lateralFromPath(c, rc, p) < 3.6)) continue;
      if (sim.willCross(c, rc.s0 - 0.3, planned)) return true;
    }
    return false;
  };

  // Ground truth: entered a crosswalk while a pedestrian was in it near the car's path.
  sim.afterMove = (c, sPrev) => {
    for (const rc of c.route.crosswalks) {
      if (!(sPrev < rc.s0 && c.s >= rc.s0)) continue;
      const hit = peds.inCrosswalk(rc.cw).find((p) => lateralFromPath(c, rc, p) < 3.6);
      if (hit) {
        sim.violation(c, "ped_yield", `${hit.kind === "child" ? "child" : "pedestrian"} in the ${rc.cw.int.id} crosswalk`, { x: hit.pos.x, y: hit.pos.y });
      }
    }
  };

  return layers;
}
