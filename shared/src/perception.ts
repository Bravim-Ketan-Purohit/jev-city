// Perception serializer: turns code-computed facts into short plain text.
// All arithmetic (distances, times, feasibility, arrival order) is done
// before this point; the text states the results in words so Jev only has
// to make the judgment.

import type { LightState, PerceptionFacts, Turn } from "./brain.ts";

export interface PerceptionExtras {
  /** Car following this one, if within 60 m. */
  vehicleBehind?: { distanceM: number; speedMph: number };
  /** Where the crosswalk sits relative to the car's path. */
  crosswalkWhere?: "before the stop line" | "just past the stop line" | "just past the turn" | "ahead";
  /** Replaces the default crosswalk sentence (e.g. children detail). */
  pedestrianDetail?: string;
  /** Detail on the oncoming traffic for a left turn. */
  oncomingDetail?: string;
  /** Detail on the crossing traffic inside the box. */
  boxDetail?: string;
  /** Detail on who arrived earlier at an all-way stop. */
  arrivalDetail?: string;
  /** Total cars waiting at the all-way stop, including this one. */
  waitingCount?: number;
  /** Plain event sentences within 60 m. */
  events?: string[];
  /** Children are visible near the school zone. */
  childrenPresent?: boolean;
}

const r0 = (n: number) => Math.max(0, Math.round(n));
const r1 = (n: number) => Math.max(0, Math.round(n * 10) / 10);

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function turnPhrase(t: Turn | undefined): string {
  if (t === "left") return "turning left";
  if (t === "right") return "turning right";
  return "going straight";
}

function lightWord(s: LightState): string {
  return s === "flashing_red" ? "FLASHING RED" : s.toUpperCase();
}

export function renderPerceptionText(
  carId: string,
  f: PerceptionFacts,
  x: PerceptionExtras = {},
): string {
  const lines: string[] = [];

  // Speed and limit.
  let l1 = `Car ${carId}. Current speed ${r0(f.speedMph)} mph. Limit here ${r0(f.limitMph)} mph`;
  if (f.schoolZoneActive) {
    l1 += ": school zone ACTIVE";
    if (x.childrenPresent) l1 += ", children present";
  }
  l1 += ".";
  if (f.limitAhead) {
    l1 += ` Active school zone starts in ${r0(f.limitAhead.distanceM)} m: limit there ${r0(f.limitAhead.mph)} mph.`;
  }
  lines.push(l1);

  const nc = f.nextControl;
  if (f.inIntersection) {
    lines.push(`This car is inside the intersection box now, ${turnPhrase(f.turn)}.`);
  } else if (nc.kind === "light" && nc.lightState === "flashing_red") {
    lines.push(
      `Next control: traffic signal, stop line ${r0(nc.distanceM)} m ahead, ${turnPhrase(f.turn)}. The signal has FAILED and is FLASHING RED: it works as an all-way stop.`,
    );
  } else if (nc.kind === "light" && nc.lightState) {
    let s = `Next control: traffic light, stop line ${r0(nc.distanceM)} m ahead, ${turnPhrase(f.turn)}. Light is ${lightWord(nc.lightState)}`;
    if (nc.lightState === "yellow" && nc.secondsToRed !== undefined) {
      s += ` and turns red in about ${r1(nc.secondsToRed)} s`;
    } else if (nc.lightState === "green" && nc.secondsToRed !== undefined && nc.secondsToRed < 8) {
      s += ` and turns red in about ${r1(nc.secondsToRed)} s`;
    }
    lines.push(s + ".");
    const timed =
      nc.lightState === "yellow" ||
      (nc.lightState === "green" && nc.secondsToRed !== undefined && nc.secondsToRed < 8);
    if (timed && nc.willClearBeforeRed !== undefined && f.speedMph > 1) {
      const t = nc.distanceM / Math.max(0.5, f.speedMph * 0.44704);
      lines.push(
        `At current speed this car reaches the stop line in ${r1(t)} s, so it ${nc.willClearBeforeRed ? "WILL clear" : "will NOT clear"} before red.`,
      );
    }
    if (nc.lightState !== "green" && nc.canStopComfortably !== undefined) {
      lines.push(`Comfortable stop before the line: ${nc.canStopComfortably ? "YES" : "NO"}.`);
    }
  } else if (nc.kind === "stop_sign") {
    lines.push(
      `Next control: all-way stop sign, stop line ${r0(nc.distanceM)} m ahead, ${turnPhrase(f.turn)}.`,
    );
  } else {
    lines.push("Next control: none within 80 m.");
  }

  // All-way stop bookkeeping (stop signs and failed signals).
  const allWay =
    !f.inIntersection &&
    (nc.kind === "stop_sign" || nc.lightState === "flashing_red");
  if (allWay) {
    lines.push(`Full stop at the line already made: ${f.hasStoppedAtLine ? "YES" : "NO"}.`);
    if (f.arrivalRankAtStop !== undefined) {
      const of = x.waitingCount && x.waitingCount > 1 ? ` of ${x.waitingCount} waiting cars` : "";
      let s = `Arrival order: this car arrived ${ordinal(f.arrivalRankAtStop)}${of}.`;
      if (f.earlierConflictingCars !== undefined) {
        s +=
          f.earlierConflictingCars === 0
            ? " No earlier arrival crosses this car's path."
            : ` Earlier arrivals crossing this car's path: ${f.earlierConflictingCars}${x.arrivalDetail ? ` (${x.arrivalDetail})` : ""}.`;
      }
      lines.push(s);
    }
  }

  if (!f.inIntersection && nc.kind !== "none") {
    // Box and gap details only matter when this car could be entering soon.
    const relevant = nc.lightState !== "red" && nc.distanceM < 40;
    if (f.intersectionClear === false && relevant) {
      lines.push(`Crossing traffic inside the intersection box: YES${x.boxDetail ? ` (${x.boxDetail})` : ""}.`);
    } else if (allWay && f.intersectionClear && nc.distanceM < 40) {
      lines.push("Crossing traffic inside the intersection box: none.");
    }
    if (f.turn === "left" && f.oncomingGapSafe !== undefined && relevant) {
      lines.push(
        `Oncoming traffic gap long enough to complete the left turn: ${f.oncomingGapSafe ? "YES" : "NO"}${x.oncomingDetail ? ` (${x.oncomingDetail})` : ""}.`,
      );
    }
    if (f.exitHasRoom === false) {
      lines.push("Exit lane past the intersection is backed up: no room for this car on the far side.");
    }
  }

  if (f.officerCommand && f.officerCommand !== "none") {
    lines.push(
      f.officerCommand === "go"
        ? "Police officer in the intersection is waving this lane through; the officer overrides the signal."
        : "Police officer in the intersection is holding this lane with a raised hand; the officer overrides the signal.",
    );
  }

  if (f.flagger) {
    lines.push(
      `Construction flagger ${r0(f.flagger.distanceM)} m ahead in this lane showing a ${f.flagger.command.toUpperCase()} paddle.`,
    );
  }

  // Pedestrians.
  if (x.pedestrianDetail) {
    lines.push(x.pedestrianDetail);
  } else if (f.crosswalkAheadM !== undefined && (f.pedestriansInCrosswalk > 0 || f.pedestriansAtCurb > 0)) {
    const where = x.crosswalkWhere ?? "ahead";
    const parts: string[] = [];
    if (f.pedestriansInCrosswalk > 0)
      parts.push(`${f.pedestriansInCrosswalk} pedestrian${f.pedestriansInCrosswalk > 1 ? "s" : ""} in it`);
    if (f.pedestriansAtCurb > 0)
      parts.push(`${f.pedestriansAtCurb} waiting at the curb`);
    lines.push(`Crosswalk ${r0(f.crosswalkAheadM)} m ahead (${where}): ${parts.join(", ")}.`);
  }

  // Obstacles.
  if (f.obstacleInPathM !== undefined) {
    if (f.obstacleKind === "stalled_car") {
      let s = `Stalled car with hazard lights on, stopped in this lane ${r0(f.obstacleInPathM)} m ahead.`;
      if (f.canPassObstacle !== undefined)
        s += ` Oncoming lane clear to go around it: ${f.canPassObstacle ? "YES" : "NO"}.`;
      lines.push(s);
    } else {
      lines.push(`Object in this lane ${r0(f.obstacleInPathM)} m ahead.`);
    }
  }

  // Vehicles.
  if (f.leadVehicle) {
    lines.push(
      `Vehicle ahead: ${r0(f.leadVehicle.distanceM)} m, ${r0(f.leadVehicle.speedMph)} mph${f.leadVehicle.stopped ? ", stopped" : ""}.`,
    );
  } else {
    lines.push("Vehicle ahead: none within 60 m.");
  }
  if (x.vehicleBehind) {
    lines[lines.length - 1] += ` Vehicle behind: ${r0(x.vehicleBehind.distanceM)} m back, ${r0(x.vehicleBehind.speedMph)} mph.`;
  }

  if (f.emergencyVehicleBehindM !== undefined) {
    lines.push(
      `Ambulance with siren on, ${r0(f.emergencyVehicleBehindM)} m behind this car in the same lane and closing.`,
    );
  } else if (f.emergencyVehicleCrossingM !== undefined) {
    lines.push(
      `Ambulance with siren on, approaching this intersection on another road, ${r0(f.emergencyVehicleCrossingM)} m away.`,
    );
  } else {
    lines.push("Emergency vehicles: none.");
  }

  for (const e of x.events ?? []) lines.push(e);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Scene text for a zone (intersection or road segment).

export interface SceneFacts {
  zoneId: string;
  title: string; // e.g. "Intersection C (Grand Ave and Oak St)"
  controlText: string; // e.g. "traffic light with crosswalks"
  signalText?: string; // e.g. "Grand Ave GREEN for about 6 s more; Oak St RED."
  walkText?: string;
  schoolZoneActive?: boolean;
  carsInBox: string[];
  arrivalOrder?: string[];
  events: string[];
}

export function renderSceneText(s: SceneFacts): string {
  const out: string[] = [`${s.title}: ${s.controlText}.`];
  if (s.signalText) out.push(`Signal: ${s.signalText}`);
  if (s.walkText) out.push(`Pedestrian signals: ${s.walkText}`);
  if (s.schoolZoneActive) out.push("School zone ACTIVE: 20 mph.");
  out.push(
    s.carsInBox.length
      ? `Inside the intersection box: ${s.carsInBox.join("; ")}.`
      : "Inside the intersection box: no vehicles.",
  );
  if (s.arrivalOrder && s.arrivalOrder.length)
    out.push(`All-way stop arrival order: ${s.arrivalOrder.join(", then ")}.`);
  if (s.events.length) out.push(`Active events: ${s.events.join(" ")}`);
  return out.join("\n");
}
