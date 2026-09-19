// Computes PerceptionFacts for a car from the world state and renders them
// with the shared serializer. All geometry, timing and comparisons happen
// here in code; the text only states results.

import {
  comfortableStopDistance,
  renderPerceptionText,
  renderSceneText,
  toMph,
  type CarPerception,
  type PerceptionExtras,
  type PerceptionFacts,
  type SceneFacts,
} from "@jev-city/shared";
import type { Car } from "./car.ts";
import { ARM_WORD, BOUND_WORD, OPPOSITE, type Arm, type Intersection } from "./city.ts";
import type { Simulation } from "./sim.ts";

export type PerceptionHook = (c: Car, f: PerceptionFacts, x: PerceptionExtras) => void;

const LOOK = 80;

function describeCar(c: Car, sim: Simulation): string {
  const st = c.route.currentBox(c.s) ?? c.route.nextStop(c.s);
  const bound = BOUND_WORD[c.route.pieces[c.route.pieceIndexAt(c.s)].lane?.headingArm ?? (st ? OPPOSITE[st.arm] : "N")];
  const turn = st ? (st.turn === "straight" ? "going straight" : `turning ${st.turn}`) : "";
  void sim;
  return `car ${c.label} (${c.kind === "ambulance" ? "ambulance, " : ""}${bound}${turn ? ", " + turn : ""})`;
}

export function perceive(sim: Simulation, c: Car): CarPerception {
  const r = c.route;
  const f: PerceptionFacts = {
    speedMph: toMph(c.v),
    limitMph: sim.limitMphAt(c, c.center),
    schoolZoneActive: false,
    nextControl: { kind: "none", distanceM: 0 },
    pedestriansInCrosswalk: 0,
    pedestriansAtCurb: 0,
  };
  const x: PerceptionExtras = { events: [] };

  const box = r.currentBox(c.s);
  const ns = r.nextStop(c.s);
  const schoolAhead = sim.lowerLimitAhead(c, 60);
  f.schoolZoneActive = sim.inActiveSchool(c) || (sim.schoolActive && !!schoolAhead);
  if (schoolAhead && f.limitMph > schoolAhead.mph) f.limitAhead = schoolAhead;

  if (box) {
    f.inIntersection = true;
    f.turn = box.turn;
  } else if (ns && ns.s - c.s <= LOOK) {
    const d = Math.max(0, ns.s - c.s);
    f.turn = ns.turn;
    const sig = sim.signals.get(ns.int.id);
    if (sig) {
      const light = sig.lightFor(ns.arm);
      const toRed = sig.secondsToRed(ns.arm);
      f.nextControl = {
        kind: "light",
        distanceM: d,
        lightState: light,
        secondsToRed: toRed,
        canStopComfortably: comfortableStopDistance(c.v) <= d,
        willClearBeforeRed:
          toRed === undefined ? undefined : c.v > 0.5 ? d / c.v < toRed : d < 1,
      };
    } else {
      f.nextControl = { kind: "stop_sign", distanceM: d };
    }

    const allWay = sim.isAllWay(ns.int);
    if (allWay) {
      f.hasStoppedAtLine = c.stopMarks.has(ns.idx);
      const waiting = sim.waitingAt(ns.int);
      const idx = waiting.findIndex((w) => w.car === c);
      if (idx >= 0) {
        f.arrivalRankAtStop = idx + 1;
        x.waitingCount = waiting.length;
        const earlier = waiting.slice(0, idx).filter((w) => sim.city.conflicts(w.stop.conn, ns.conn));
        f.earlierConflictingCars = earlier.length;
        if (earlier.length)
          x.arrivalDetail = earlier
            .slice(0, 2)
            .map((w) => `car ${w.car.label} from the ${ARM_WORD[w.stop.arm]}`)
            .join(", ");
      }
    }
    const blocker = sim.conflictInBox(ns.conn, c);
    f.intersectionClear = !blocker;
    if (blocker) x.boxDetail = describeCar(blocker, sim);
    f.exitHasRoom = sim.exitHasRoom(ns.conn.outLane);
    if (ns.turn === "left" && !allWay) {
      const gap = oncomingGap(sim, c, ns.int, ns.arm);
      f.oncomingGapSafe = gap.safe;
      if (gap.detail) x.oncomingDetail = gap.detail;
    }
  }

  // Vehicles.
  const lead = sim.findLeader(c, 60);
  if (lead && lead.car.kind !== "stalled") {
    f.leadVehicle = { distanceM: lead.gap, speedMph: toMph(lead.v), stopped: lead.v < 0.3 };
  }
  const follow = sim.findFollower(c, 60);
  if (follow) x.vehicleBehind = { distanceM: follow.gap, speedMph: toMph(follow.v) };

  for (const h of sim.perceptionHooks) h(c, f, x);
  return { carId: c.label, text: renderPerceptionText(c.label, f, x), facts: f };
}

/** Oncoming traffic check for a permissive left turn. */
function oncomingGap(sim: Simulation, c: Car, int: Intersection, arm: Arm): { safe: boolean; detail?: string } {
  const opp = OPPOSITE[arm];
  const oppLane = int.inLanes[opp];
  // Cars from the opposite arm already inside the box and going straight/right.
  for (const { car, stop } of sim.carsInBox(int)) {
    if (car === c || stop.arm !== opp || stop.turn === "left") continue;
    return { safe: false, detail: `${describeCar(car, sim)} is crossing now` };
  }
  if (!oppLane) return { safe: true };
  const sig = sim.signals.get(int.id);
  const oppGreen = sig ? sig.lightFor(opp) === "green" || sig.lightFor(opp) === "yellow" : true;
  if (!oppGreen) return { safe: true, detail: "oncoming traffic is held by a red light" };
  // A left turn from a standstill takes about 5 s to clear the conflict area.
  const needS = c.v < 1 ? 6.0 : 5.0;
  let worst: { t: number; car: Car; d: number } | undefined;
  for (const o of sim.occ.get(oppLane.id) ?? []) {
    const car = o.car;
    if (car.kind === "stalled") continue;
    const st = car.route.nextStop(car.s);
    if (!st || st.int !== int || st.turn === "left") continue;
    // A stopped car queued behind the stop line is not about to arrive.
    if (car.v < 1 && st.s - car.s > 3) continue;
    const dBox = st.boxS0 - car.s;
    const t = dBox / Math.max(car.v, 2.0);
    if (t < needS && (!worst || t < worst.t)) worst = { t, car, d: dBox };
  }
  if (worst)
    return {
      safe: false,
      detail: `car ${worst.car.label} is ${Math.round(worst.d)} m away at ${Math.round(toMph(worst.car.v))} mph, arriving in about ${worst.t.toFixed(1)} s`,
    };
  return { safe: true };
}

// ---------------------------------------------------------------------------
// Scene text per zone.

export function sceneFor(sim: Simulation, zoneId: string): string {
  const int = sim.city.byId.get(zoneId as "A");
  if (!int) {
    const events = sim.sceneEvents(zoneId);
    return renderSceneText({
      zoneId,
      title: `Road segment (${zoneId.replace("seg:", "")})`,
      controlText: "no traffic control on this segment",
      carsInBox: [],
      events,
    });
  }
  const sig = sim.signals.get(int.id);
  const ns = int.roadNS.name;
  const ew = int.roadEW.name;
  const s: SceneFacts = {
    zoneId,
    title: `Intersection ${int.id} (${ns} and ${ew})`,
    controlText: "all-way stop",
    carsInBox: sim.carsInBox(int).filter(({ car }) => car.kind !== "stalled").map(({ car }) => describeCar(car, sim)),
    events: sim.sceneEvents(zoneId),
    schoolZoneActive: int.school && sim.schoolActive,
  };
  if (sig) {
    if (sig.failed) {
      s.controlText = "traffic signal FAILED, flashing red on all approaches: all-way stop";
    } else {
      s.controlText = int.hasCrosswalks ? "traffic light with crosswalks" : "traffic light";
      const nsL = sig.lightFor("N").toUpperCase();
      const ewL = sig.lightFor("E").toUpperCase();
      const nsT = Math.round(sig.secondsToChange("N"));
      const ewT = Math.round(sig.secondsToChange("E"));
      s.signalText = `${ns} (north-south) ${nsL}, changes in about ${nsT} s; ${ew} (east-west) ${ewL}, changes in about ${ewT} s.`;
      if (int.pedestrians) {
        const w = (a: Arm) => sig.walkFor(a);
        const word = (x: string) => (x === "walk" ? "WALK" : x === "flash" ? "flashing DON'T WALK" : "DON'T WALK");
        s.walkText = `crossing ${ns}: ${word(w("N"))}; crossing ${ew}: ${word(w("E"))}.`;
      }
    }
  }
  if (sim.isAllWay(int)) {
    s.arrivalOrder = sim
      .waitingAt(int)
      .map((w) => `car ${w.car.label} (from the ${ARM_WORD[w.stop.arm]})`);
  }
  return renderSceneText(s);
}
