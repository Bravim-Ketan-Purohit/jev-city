// RuleBrain: the deterministic baseline. It reads only the structured facts,
// never the free text, and is meant to be what a careful engineer would write
// in an afternoon: lights with yellow feasibility, all-way stops with arrival
// order, the school zone, crosswalks, obstacles, emergency vehicles, officers
// and flaggers.

import {
  ACTIONS,
  needsRightOfWay,
  type Action,
  type Brain,
  type CarDecision,
  type DecisionRequest,
  type PerceptionFacts,
} from "./brain.ts";
import { COMFORT_BRAKE, MAX_BRAKE, comfortableStopDistance, toMs } from "./config.ts";

export interface RuleOutput {
  action: Action;
  /** Second-best action, used by MockJevBrain. */
  alt: Action;
  speedLevel: number;
  mustStop: boolean;
  hazard: number;
  rightOfWay?: boolean;
}

function lawRequiresStop(f: PerceptionFacts): boolean {
  if (f.inIntersection) return false;
  if (f.officerCommand === "stop") return true;
  if (f.officerCommand === "go") return false;
  if (f.flagger?.command === "stop") return true;
  if (f.pedestriansInCrosswalk > 0 && (f.crosswalkAheadM ?? Infinity) <= 40) return true;
  const nc = f.nextControl;
  if (nc.kind === "stop_sign") return !f.hasStoppedAtLine;
  if (nc.kind === "light") {
    switch (nc.lightState) {
      case "red":
        return true;
      case "yellow":
        return nc.canStopComfortably === true;
      case "flashing_red":
        return !f.hasStoppedAtLine;
      default:
        return false;
    }
  }
  return false;
}

/** Speed level for a controlled stop, by distance to the line. */
function approachLevel(distanceM: number): number {
  if (distanceM > 50) return 2;
  if (distanceM > 20) return 1;
  return 0;
}

export function ruleDecide(f: PerceptionFacts): RuleOutput {
  const v = toMs(f.speedMph);
  const nc = f.nextControl;
  const mustStop = lawRequiresStop(f);
  const rowApplies = needsRightOfWay(f);

  let hazard = 0;
  if (f.schoolZoneActive) hazard = Math.max(hazard, 1);
  if (f.pedestriansAtCurb > 0) hazard = Math.max(hazard, 1);
  if (f.flagger) hazard = Math.max(hazard, 1);
  if (f.pedestriansInCrosswalk > 0 && (f.crosswalkAheadM ?? Infinity) <= 40) hazard = Math.max(hazard, 2);
  if (f.obstacleInPathM !== undefined && f.obstacleInPathM < 40) hazard = Math.max(hazard, 2);
  if (f.emergencyVehicleBehindM !== undefined || f.emergencyVehicleCrossingM !== undefined)
    hazard = Math.max(hazard, 2);

  // Cruise level: at the limit, a notch lower near waiting pedestrians.
  let cruise = 3;
  if (f.pedestriansAtCurb > 0 && (f.crosswalkAheadM ?? Infinity) < 40) cruise = 2;
  if (f.leadVehicle?.stopped && f.leadVehicle.distanceM < 25) cruise = Math.min(cruise, 1);

  const out = (
    action: Action,
    alt: Action,
    speedLevel: number,
    extra: Partial<RuleOutput> = {},
  ): RuleOutput => ({
    action,
    alt,
    speedLevel,
    mustStop,
    hazard,
    rightOfWay: rowApplies ? action === "proceed" : undefined,
    ...extra,
  });

  // 1. Something in the path.
  if (f.obstacleInPathM !== undefined) {
    const d = f.obstacleInPathM;
    const comfortable = (v * v) / (2 * COMFORT_BRAKE) + 2;
    const hard = (v * v) / (2 * MAX_BRAKE) + 1;
    if (d <= hard + 1 && v > 1) return out("emergency_stop", "stop_at_line", 0, { hazard: 3 });
    if (f.obstacleKind === "stalled_car" && f.obstacleStopped) {
      const nearControl = nc.kind !== "none" && nc.distanceM < 30;
      if (f.canPassObstacle && !nearControl && d < 25) return out("proceed", "yield", 1);
      if (d < comfortable + 10) return out("yield", "stop_at_line", 0.5);
      return out("slow_down", "yield", 1.5);
    }
    if (d < comfortable) return out("emergency_stop", "slow_down", 0, { hazard: 3 });
    return out("slow_down", "emergency_stop", 1);
  }

  // 2. Emergency vehicle behind: clear the box if inside it, otherwise pull over.
  if (f.emergencyVehicleBehindM !== undefined && f.emergencyVehicleBehindM <= 80) {
    if (f.inIntersection) return out("proceed", "pull_over", 1.5);
    return out("pull_over", "yield", 0);
  }

  // 3. Inside the box: keep going and clear it, yielding only to a crosswalk.
  if (f.inIntersection) {
    if (f.pedestriansInCrosswalk > 0 && (f.crosswalkAheadM ?? Infinity) < 15)
      return out("yield", "stop_at_line", 0.5);
    return out("proceed", "slow_down", 2);
  }

  // 4. Emergency vehicle about to cross the intersection: hold at the line.
  if (f.emergencyVehicleCrossingM !== undefined && nc.kind !== "none" && nc.distanceM < 60)
    return out("yield", "stop_at_line", approachLevel(nc.distanceM));

  // 5. Officer overrides the signal.
  if (f.officerCommand === "stop") return out("stop_at_line", "yield", approachLevel(nc.distanceM));
  if (f.officerCommand === "go") {
    if (f.pedestriansInCrosswalk > 0 && (f.crosswalkAheadM ?? Infinity) <= 40)
      return out("yield", "stop_at_line", 0.5);
    if (f.intersectionClear === false) return out("yield", "stop_at_line", 0.5);
    return out("proceed", "slow_down", 2);
  }

  // 6. Construction flagger.
  if (f.flagger?.command === "stop") return out("stop_at_line", "yield", approachLevel(f.flagger.distanceM));
  if (f.flagger?.command === "slow") return out("slow_down", "proceed", 1);

  // 7. Pedestrians in a crosswalk on the path.
  if (f.pedestriansInCrosswalk > 0 && (f.crosswalkAheadM ?? Infinity) <= 40)
    return out("yield", "stop_at_line", approachLevel(f.crosswalkAheadM ?? 0));

  // 8. Traffic control.
  if (nc.kind === "light" && nc.lightState !== "flashing_red") {
    switch (nc.lightState) {
      case "green":
        if (f.turn === "left" && f.oncomingGapSafe === false)
          return out("yield", "stop_at_line", approachLevel(nc.distanceM));
        if (f.exitHasRoom === false) return out("stop_at_line", "yield", approachLevel(nc.distanceM));
        if (f.intersectionClear === false && nc.distanceM < comfortableStopDistance(v) + 12)
          return out("yield", "stop_at_line", approachLevel(nc.distanceM));
        return out("proceed", "slow_down", cruise);
      case "yellow":
        if (nc.canStopComfortably) return out("stop_at_line", "proceed", approachLevel(nc.distanceM));
        return out("proceed", "stop_at_line", cruise);
      case "red":
      default:
        return out("stop_at_line", "yield", approachLevel(nc.distanceM));
    }
  }

  if (nc.kind === "stop_sign" || nc.lightState === "flashing_red") {
    if (!f.hasStoppedAtLine) return out("stop_at_line", "yield", approachLevel(nc.distanceM));
    const myTurn =
      f.intersectionClear !== false &&
      (f.earlierConflictingCars ?? 0) === 0 &&
      (f.turn !== "left" || f.oncomingGapSafe !== false) &&
      f.exitHasRoom !== false;
    if (myTurn) return out("proceed", "yield", 1.5);
    return out("yield", "stop_at_line", 0);
  }

  // Open road.
  return out("proceed", "slow_down", cruise);
}

function oneHot(a: Action): Record<Action, number> {
  return Object.fromEntries(ACTIONS.map((x) => [x, x === a ? 1 : 0])) as Record<Action, number>;
}

export function ruleToDecision(carId: string, r: RuleOutput): CarDecision {
  return {
    carId,
    action: r.action,
    actionProbs: oneHot(r.action),
    actionConfidence: 1,
    speedLevel: r.speedLevel,
    mustStopProb: r.mustStop ? 1 : 0,
    hazardLevel: r.hazard,
    rightOfWayProb: r.rightOfWay === undefined ? undefined : r.rightOfWay ? 1 : 0,
    latencyMs: 0,
    model: "rules",
  };
}

export class RuleBrain implements Brain {
  readonly name = "rules" as const;
  decideSync(req: DecisionRequest): CarDecision[] {
    return req.cars.map((c) => ruleToDecision(c.carId, ruleDecide(c.facts)));
  }
  async decide(req: DecisionRequest): Promise<CarDecision[]> {
    return this.decideSync(req);
  }
}
