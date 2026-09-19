// Builds bench/scenarios.json from structured facts, rendering the text with
// the same serializer the live simulation uses.
//
//   pnpm --filter @jev-city/bench scenarios
//
// The labels are the ground truth for the benchmark.
//
// must_stop label convention (read literally, like the question): true when
// traffic law requires the car to stop at or before the next stop line: a
// red light, a yellow light it can stop for comfortably (the spec's rule), a
// stop sign or flashing red (true even after the stop has been made), an
// officer or flagger showing stop, a pedestrian in the crosswalk at that
// line, or an emergency vehicle crossing the intersection. False otherwise,
// including open-road hazards: a child in the road calls for an emergency
// stop, but there is no stop line involved.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderPerceptionText,
  renderSceneText,
  type Action,
  type LightState,
  type PerceptionExtras,
  type PerceptionFacts,
  type Scenario,
  type ScenarioCategory,
  type ScenarioFile,
  type Turn,
} from "@jev-city/shared";

// ------------------------------------------------------------------ helpers

type F = Partial<PerceptionFacts>;

function facts(o: F): PerceptionFacts {
  return {
    speedMph: 25,
    limitMph: 25,
    schoolZoneActive: false,
    nextControl: { kind: "none", distanceM: 0 },
    pedestriansInCrosswalk: 0,
    pedestriansAtCurb: 0,
    ...o,
  };
}

const MPS = 0.44704;
/** Light facts with the feasibility numbers computed like the simulation does. */
function light(state: LightState, d: number, speedMph: number, secondsToRed?: number): PerceptionFacts["nextControl"] {
  const v = speedMph * MPS;
  const comfy = v * 0.4 + (v * v) / 8;
  return {
    kind: "light",
    distanceM: d,
    lightState: state,
    secondsToRed,
    canStopComfortably: comfy <= d,
    willClearBeforeRed: secondsToRed === undefined ? undefined : v > 0.5 ? d / v < secondsToRed : d < 1,
  };
}
const stopSign = (d: number): PerceptionFacts["nextControl"] => ({ kind: "stop_sign", distanceM: d });

interface SceneOpts {
  id?: "A" | "B" | "C" | "D";
  ns?: LightState;
  ew?: LightState;
  nsT?: number;
  ewT?: number;
  allWay?: boolean;
  failed?: boolean;
  inBox?: string[];
  arrival?: string[];
  school?: boolean;
  walk?: string;
  events?: string[];
  segment?: string;
}

const NAMES: Record<string, [string, string]> = {
  A: ["Grand Ave", "Elm St"],
  B: ["Maple St", "Elm St"],
  C: ["Grand Ave", "Oak St"],
  D: ["Maple St", "Oak St"],
};

function scene(o: SceneOpts): string {
  if (o.segment) {
    return renderSceneText({ zoneId: `seg:${o.segment}`, title: `Road segment (${o.segment})`, controlText: "no traffic control on this segment", carsInBox: [], events: o.events ?? [] });
  }
  const id = o.id ?? "A";
  const [ns, ew] = NAMES[id];
  let controlText = "traffic light";
  let signalText: string | undefined;
  if (o.allWay) controlText = "all-way stop";
  else if (o.failed) controlText = "traffic signal FAILED, flashing red on all approaches: all-way stop";
  else {
    controlText = id === "A" || id === "C" ? "traffic light with crosswalks" : "traffic light";
    signalText = `${ns} (north-south) ${(o.ns ?? "green").toUpperCase()}, changes in about ${o.nsT ?? 8} s; ${ew} (east-west) ${(o.ew ?? "red").toUpperCase()}, changes in about ${o.ewT ?? 12} s.`;
  }
  return renderSceneText({
    zoneId: id,
    title: `Intersection ${id} (${ns} and ${ew})`,
    controlText,
    signalText,
    walkText: o.walk,
    schoolZoneActive: o.school,
    carsInBox: o.inBox ?? [],
    arrivalOrder: o.arrival,
    events: o.events ?? [],
  });
}

const all: Scenario[] = [];
let n = 0;
function S(
  cat: ScenarioCategory,
  title: string,
  f: PerceptionFacts,
  x: PerceptionExtras,
  sceneText: string,
  expected: Action,
  acceptable: Action[],
  mustStop: boolean,
  notes?: string,
) {
  n++;
  const carId = String(10 + ((n * 7) % 80));
  const id = `${cat[0].toUpperCase()}${String(all.filter((s) => s.category === cat).length + 1).padStart(2, "0")}`;
  all.push({
    id,
    category: cat,
    title,
    sceneText,
    perception: { carId, facts: f, text: renderPerceptionText(carId, f, x) },
    expectedAction: expected,
    acceptableActions: [...new Set([expected, ...acceptable])],
    expectedMustStop: mustStop,
    notes,
  });
}

const none = {};
const behind = (d: number, mph: number): PerceptionExtras => ({ vehicleBehind: { distanceM: d, speedMph: mph } });
const turn = (t: Turn) => t;

// ------------------------------------------------------------------ RULE (40)
// Clear-cut: the law and the pre-computed facts settle the answer.

S("rule", "Red light, 45 m ahead at 25 mph", facts({ speedMph: 25, nextControl: light("red", 45, 25), turn: "straight" }), none, scene({ id: "D", ns: "red", ew: "green" }), "stop_at_line", ["slow_down"], true);
S("rule", "Red light, stopped at the line", facts({ speedMph: 0, nextControl: light("red", 1, 0), turn: "straight" }), behind(3, 0), scene({ id: "A", ns: "red", ew: "green" }), "stop_at_line", ["yield"], true);
S("rule", "Red light, 20 m ahead at 18 mph", facts({ speedMph: 18, nextControl: light("red", 20, 18), turn: "right" }), none, scene({ id: "C", ns: "green", ew: "red" }), "stop_at_line", [], true);
S("rule", "Red light on the 35 mph arterial, 70 m ahead", facts({ speedMph: 34, limitMph: 35, nextControl: light("red", 70, 34), turn: "straight" }), none, scene({ id: "A", ns: "red", ew: "green" }), "stop_at_line", ["slow_down"], true);
S("rule", "Green light, 50 m ahead, clear", facts({ speedMph: 24, nextControl: light("green", 50, 24), turn: "straight", intersectionClear: true, exitHasRoom: true }), none, scene({ id: "D", ns: "green", ew: "red" }), "proceed", [], false);
S("rule", "Green light, 15 m ahead, clear", facts({ speedMph: 25, nextControl: light("green", 15, 25), turn: "straight", intersectionClear: true, exitHasRoom: true }), behind(20, 24), scene({ id: "D", ns: "green", ew: "red" }), "proceed", [], false);
S("rule", "Green light on the arterial, 35 mph", facts({ speedMph: 35, limitMph: 35, nextControl: light("green", 60, 35), turn: "straight", intersectionClear: true, exitHasRoom: true }), none, scene({ id: "A", ns: "green", ew: "red", nsT: 14 }), "proceed", [], false);
S("rule", "Green light, turning right, clear", facts({ speedMph: 14, nextControl: light("green", 12, 14), turn: "right", intersectionClear: true, exitHasRoom: true }), none, scene({ id: "D", ns: "red", ew: "green" }), "proceed", ["slow_down"], false);
S("rule", "Yellow, 45 m ahead at 30 mph: can stop, will not clear", facts({ speedMph: 30, limitMph: 35, nextControl: light("yellow", 45, 30, 3.0), turn: "straight" }), none, scene({ id: "A", ns: "yellow", ew: "red", nsT: 3 }), "stop_at_line", [], true);
S("rule", "Yellow, 6 m ahead at 30 mph: cannot stop comfortably", facts({ speedMph: 30, limitMph: 35, nextControl: light("yellow", 6, 30, 3.5), turn: "straight" }), behind(10, 29), scene({ id: "A", ns: "yellow", ew: "red", nsT: 4 }), "proceed", [], false);
S("rule", "Yellow, 60 m ahead at 25 mph", facts({ speedMph: 25, nextControl: light("yellow", 60, 25, 3.2), turn: "straight" }), none, scene({ id: "D", ns: "yellow", ew: "red", nsT: 3 }), "stop_at_line", ["slow_down"], true);
S("rule", "Yellow, 4 m ahead at 35 mph", facts({ speedMph: 35, limitMph: 35, nextControl: light("yellow", 4, 35, 3.8), turn: "straight" }), none, scene({ id: "C", ns: "yellow", ew: "red", nsT: 4 }), "proceed", [], false);
S("rule", "Yellow, 30 m ahead at 22 mph", facts({ speedMph: 22, nextControl: light("yellow", 30, 22, 2.5), turn: "left" }), none, scene({ id: "D", ew: "yellow", ns: "red", ewT: 2 }), "stop_at_line", [], true);
S("rule", "Yellow, 11 m ahead at 34 mph", facts({ speedMph: 34, limitMph: 35, nextControl: light("yellow", 11, 34, 3.9), turn: "straight" }), none, scene({ id: "A", ns: "yellow", ew: "red", nsT: 4 }), "proceed", [], false);
S("rule", "Stop sign 35 m ahead, not yet stopped", facts({ speedMph: 24, nextControl: stopSign(35), turn: "straight", hasStoppedAtLine: false, intersectionClear: true }), none, scene({ id: "B", allWay: true }), "stop_at_line", ["slow_down"], true);
S("rule", "Stop sign 8 m ahead at 10 mph", facts({ speedMph: 10, nextControl: stopSign(8), turn: "right", hasStoppedAtLine: false, intersectionClear: true }), none, scene({ id: "B", allWay: true }), "stop_at_line", [], true);
S("rule", "Stopped at stop sign, arrived first, box clear", facts({ speedMph: 0, nextControl: stopSign(1), turn: "straight", hasStoppedAtLine: true, arrivalRankAtStop: 1, earlierConflictingCars: 0, intersectionClear: true, exitHasRoom: true }), { waitingCount: 2 }, scene({ id: "B", allWay: true, arrival: ["car 31 (from the south)", "car 44 (from the east)"] }), "proceed", [], true);
S("rule", "Stopped at stop sign, arrived second, earlier car crosses its path", facts({ speedMph: 0, nextControl: stopSign(1), turn: "straight", hasStoppedAtLine: true, arrivalRankAtStop: 2, earlierConflictingCars: 1, intersectionClear: true }), { waitingCount: 2, arrivalDetail: "car 22 from the east" }, scene({ id: "B", allWay: true, arrival: ["car 22 (from the east)", "car 58 (from the south)"] }), "yield", ["stop_at_line"], true);
S("rule", "Stopped at stop sign, first, but crossing car inside the box", facts({ speedMph: 0, nextControl: stopSign(1), turn: "left", hasStoppedAtLine: true, arrivalRankAtStop: 1, earlierConflictingCars: 0, intersectionClear: false }), { waitingCount: 1, boxDetail: "car 19 (westbound, going straight)" }, scene({ id: "B", allWay: true, inBox: ["car 19 (westbound, going straight)"] }), "yield", ["stop_at_line"], true);
S("rule", "Stopped at stop sign, first, turning left, box clear", facts({ speedMph: 0, nextControl: stopSign(1), turn: "left", hasStoppedAtLine: true, arrivalRankAtStop: 1, earlierConflictingCars: 0, intersectionClear: true, exitHasRoom: true }), { waitingCount: 1 }, scene({ id: "B", allWay: true }), "proceed", [], true);
S("rule", "Failed signal (flashing red), 25 m ahead", facts({ speedMph: 22, nextControl: light("flashing_red", 25, 22), turn: "straight", hasStoppedAtLine: false, intersectionClear: true }), none, scene({ id: "D", failed: true }), "stop_at_line", ["slow_down"], true);
S("rule", "Failed signal, stopped, arrived first, clear", facts({ speedMph: 0, nextControl: light("flashing_red", 1, 0), turn: "right", hasStoppedAtLine: true, arrivalRankAtStop: 1, earlierConflictingCars: 0, intersectionClear: true, exitHasRoom: true }), { waitingCount: 2 }, scene({ id: "D", failed: true, arrival: ["car 71 (from the west)", "car 12 (from the north)"] }), "proceed", [], true);
S("rule", "Open road at the limit, nothing ahead", facts({ speedMph: 25, nextControl: { kind: "none", distanceM: 0 } }), none, scene({ segment: "Elm St E" }), "proceed", [], false);
S("rule", "Open road on the arterial, car ahead moving", facts({ speedMph: 33, limitMph: 35, leadVehicle: { distanceM: 40, speedMph: 34, stopped: false } }), none, scene({ segment: "Grand Ave S" }), "proceed", [], false);
S("rule", "Two pedestrians in the crosswalk 12 m ahead, green light", facts({ speedMph: 15, nextControl: light("green", 5, 15), turn: "straight", pedestriansInCrosswalk: 2, crosswalkAheadM: 12, intersectionClear: true }), { crosswalkWhere: "on the far side of the intersection" }, scene({ id: "C", ns: "green", ew: "red", walk: "crossing Grand Ave: DON'T WALK; crossing Oak St: WALK." }), "yield", ["stop_at_line"], true);
S("rule", "Turning right on green, pedestrian in the crosswalk past the turn", facts({ speedMph: 8, nextControl: light("green", 3, 8), turn: "right", pedestriansInCrosswalk: 1, crosswalkAheadM: 14, intersectionClear: true }), { crosswalkWhere: "just past the turn" }, scene({ id: "C", ns: "red", ew: "green", walk: "crossing Grand Ave: WALK; crossing Oak St: DON'T WALK." }), "yield", ["stop_at_line", "slow_down"], true);
S("rule", "Inside the box, turning right, pedestrian in the exit crosswalk", facts({ speedMph: 6, inIntersection: true, turn: "right", intersectionClear: true, pedestriansInCrosswalk: 1, crosswalkAheadM: 4 }), { crosswalkWhere: "just past the turn" }, scene({ id: "C", ns: "red", ew: "green" }), "yield", ["emergency_stop", "stop_at_line"], true);
S("rule", "Inside the box going straight, clear", facts({ speedMph: 24, inIntersection: true, turn: "straight", intersectionClear: true }), none, scene({ id: "D", ns: "green", ew: "red", inBox: ["car 40 (southbound, going straight)"] }), "proceed", [], false);
S("rule", "Left turn on green, oncoming car 20 m away", facts({ speedMph: 4, nextControl: light("green", 2, 4), turn: "left", intersectionClear: true, oncomingGapSafe: false, exitHasRoom: true }), { oncomingDetail: "car 63 is 20 m away at 25 mph, arriving in about 1.8 s" }, scene({ id: "D", ns: "green", ew: "red" }), "yield", ["stop_at_line"], false, "Left turns may legally enter and wait; stopping before the line is not strictly required.");
S("rule", "Left turn on green, oncoming gap is long enough", facts({ speedMph: 8, nextControl: light("green", 6, 8), turn: "left", intersectionClear: true, oncomingGapSafe: true, exitHasRoom: true }), none, scene({ id: "D", ns: "green", ew: "red" }), "proceed", ["slow_down"], false);
S("rule", "Green light but the exit lane is backed up", facts({ speedMph: 10, nextControl: light("green", 8, 10), turn: "straight", intersectionClear: true, exitHasRoom: false }), none, scene({ id: "A", ns: "green", ew: "red" }), "stop_at_line", ["yield"], true, "Do not block the box.");
S("rule", "Officer waves the lane through a red light", facts({ speedMph: 0, nextControl: light("red", 1, 0), turn: "straight", officerCommand: "go", intersectionClear: true, exitHasRoom: true }), none, scene({ id: "A", ns: "red", ew: "green", events: ["Police officer in the intersection, holding Elm St (green) and waving Grand Ave through its red."] }), "proceed", [], false);
S("rule", "Officer holds the lane on a green light", facts({ speedMph: 20, nextControl: light("green", 30, 20), turn: "straight", officerCommand: "stop", intersectionClear: true }), none, scene({ id: "A", ns: "green", ew: "red", events: ["Police officer in the intersection, holding Grand Ave (green) and waving Elm St through its red."] }), "stop_at_line", ["yield"], true);
S("rule", "Construction flagger shows STOP 30 m ahead", facts({ speedMph: 22, flagger: { command: "stop", distanceM: 30 } }), none, scene({ segment: "Elm St W" }), "stop_at_line", ["yield"], true);
S("rule", "Construction flagger shows SLOW 40 m ahead", facts({ speedMph: 24, flagger: { command: "slow", distanceM: 40 } }), none, scene({ segment: "Oak St E" }), "slow_down", [], false);
S("rule", "Ambulance 30 m behind in the same lane, open road", facts({ speedMph: 24, emergencyVehicleBehindM: 30 }), none, scene({ segment: "Elm St E", events: ["Ambulance with siren on approaching eastbound on Elm St."] }), "pull_over", [], false);
S("rule", "Ambulance about to cross the intersection, light green", facts({ speedMph: 22, nextControl: light("green", 28, 22), turn: "straight", intersectionClear: true, emergencyVehicleCrossingM: 35 }), none, scene({ id: "D", ns: "green", ew: "red", events: ["Ambulance with siren on approaching westbound on Oak St."] }), "yield", ["stop_at_line"], true);
S("rule", "School zone active at 19 mph, nothing ahead", facts({ speedMph: 19, limitMph: 20, schoolZoneActive: true }), none, scene({ segment: "Grand Ave S" }), "proceed", [], false);
S("rule", "Red light 3 m ahead at 12 mph", facts({ speedMph: 12, nextControl: light("red", 3, 12), turn: "straight" }), none, scene({ id: "D", ns: "red", ew: "green" }), "stop_at_line", ["emergency_stop"], true);
S("rule", "Stop sign 60 m ahead at 25 mph", facts({ speedMph: 25, nextControl: stopSign(60), turn: "left", hasStoppedAtLine: false, intersectionClear: true }), none, scene({ id: "B", allWay: true }), "stop_at_line", ["slow_down", "proceed"], true, "Far from the line; continuing for now is also reasonable.");

// ------------------------------------------------------------------ JUDGMENT (40)
// Events and situations with no single rule to fire.

S("judgment", "Ball just rolled across the road 25 m ahead", facts({ speedMph: 24 }), { events: ["A ball rolled across the road 25 m ahead a moment ago, from between parked cars. Nobody has followed it yet."] }, scene({ segment: "Elm St E" }), "slow_down", [], false);
S("judgment", "Ball rolling across the lane 18 m ahead", facts({ speedMph: 23, obstacleInPathM: 18, obstacleKind: "object", obstacleStopped: false }), { events: ["A ball is rolling across the road 18 m ahead; it came out from between parked cars."] }, scene({ segment: "Oak St W" }), "slow_down", ["emergency_stop", "stop_at_line", "yield"], false);
S("judgment", "Ball rolled across 45 m ahead, car at 25 mph", facts({ speedMph: 25 }), { events: ["A ball rolled across the road 45 m ahead a moment ago, from between parked cars. Nobody has followed it yet."] }, scene({ segment: "Maple St S" }), "slow_down", [], false);
S("judgment", "Child runs into the road after a ball 12 m ahead", facts({ speedMph: 22, obstacleInPathM: 12, obstacleKind: "object", obstacleStopped: false }), { events: ["A child is running into the road after a ball, 12 m ahead in this lane."] }, scene({ segment: "Elm St W" }), "emergency_stop", [], false);
S("judgment", "Distracted pedestrian at the right curb 30 m ahead", facts({ speedMph: 24, pedestriansAtCurb: 1 }), { events: ["A pedestrian is standing at the right curb 30 m ahead, facing the road and looking at a phone. There is no crosswalk here and no walk signal."] }, scene({ segment: "Oak St E" }), "slow_down", [], false);
S("judgment", "Distracted pedestrian at the right curb 12 m ahead", facts({ speedMph: 20, pedestriansAtCurb: 1 }), { events: ["A pedestrian is standing at the right curb 12 m ahead, facing the road and looking at a phone. There is no crosswalk here and no walk signal."] }, scene({ segment: "Elm St E" }), "slow_down", ["yield"], false);
S("judgment", "Distracted pedestrian at the left curb, far side, 35 m", facts({ speedMph: 25, pedestriansAtCurb: 1 }), { events: ["A pedestrian is standing at the left curb 35 m ahead, facing the road and looking at a phone. There is no crosswalk here and no walk signal."] }, scene({ segment: "Maple St N" }), "slow_down", [], false);
S("judgment", "Children at the curb by the crosswalk, one stepping toward the road", facts({ speedMph: 19, limitMph: 20, schoolZoneActive: true, nextControl: light("green", 30, 19), turn: "straight", pedestriansAtCurb: 3, crosswalkAheadM: 33, intersectionClear: true }), { childrenPresent: true, pedestrianDetail: "Crosswalk 33 m ahead (just past the stop line): 3 waiting at the curb; 3 of them are children, one stepping toward the road." }, scene({ id: "C", ns: "green", ew: "red", school: true, events: ["School dismissal: children are at the crosswalks."] }), "slow_down", ["yield"], false);
S("judgment", "Children crossing in the crosswalk ahead, school zone", facts({ speedMph: 12, limitMph: 20, schoolZoneActive: true, nextControl: light("green", 10, 12), turn: "right", pedestriansInCrosswalk: 2, crosswalkAheadM: 18, intersectionClear: true }), { childrenPresent: true, pedestrianDetail: "Crosswalk 18 m ahead (on the far side of the intersection): 2 people in it; 2 of them are children." }, scene({ id: "C", ns: "red", ew: "green", school: true }), "yield", ["stop_at_line", "slow_down"], true);
S("judgment", "School zone active, children near the curb, no crosswalk use yet", facts({ speedMph: 20, limitMph: 20, schoolZoneActive: true, pedestriansAtCurb: 2, crosswalkAheadM: 45, nextControl: light("green", 42, 20), turn: "straight", intersectionClear: true }), { childrenPresent: true, pedestrianDetail: "Crosswalk 45 m ahead (just past the stop line): 2 waiting at the curb; 2 of them are children." }, scene({ id: "C", ns: "green", ew: "red", school: true }), "slow_down", [], false);
S("judgment", "Ambulance behind while waiting at a red light", facts({ speedMph: 0, nextControl: light("red", 1, 0), turn: "straight", emergencyVehicleBehindM: 20 }), behind(4, 0), scene({ id: "A", ns: "red", ew: "green", events: ["Ambulance with siren on approaching northbound on Grand Ave."] }), "pull_over", ["stop_at_line", "yield"], true, "At a red with cars around, staying put (not entering the box) is acceptable.");
S("judgment", "Ambulance 25 m behind approaching a green light", facts({ speedMph: 22, nextControl: light("green", 30, 22), turn: "straight", intersectionClear: true, emergencyVehicleBehindM: 25 }), none, scene({ id: "D", ns: "green", ew: "red", events: ["Ambulance with siren on approaching southbound on Maple St."] }), "pull_over", ["yield", "stop_at_line"], false);
S("judgment", "Ambulance behind while inside the intersection", facts({ speedMph: 14, inIntersection: true, turn: "straight", intersectionClear: true, emergencyVehicleBehindM: 15 }), none, scene({ id: "A", ns: "green", ew: "red", events: ["Ambulance with siren on approaching northbound on Grand Ave."] }), "proceed", ["pull_over"], false, "Clear the box first, then pull over.");
S("judgment", "Ambulance crossing on the other road, this car has a green", facts({ speedMph: 25, nextControl: light("green", 40, 25), turn: "straight", intersectionClear: true, emergencyVehicleCrossingM: 45 }), none, scene({ id: "C", ns: "green", ew: "red", events: ["Ambulance with siren on approaching eastbound on Oak St."] }), "yield", ["stop_at_line", "slow_down"], true);
S("judgment", "Stalled car 10 m ahead, oncoming lane clear", facts({ speedMph: 0, obstacleInPathM: 10, obstacleKind: "stalled_car", obstacleStopped: true, canPassObstacle: true }), none, scene({ segment: "Maple St S" }), "proceed", [], false, "Go around carefully.");
S("judgment", "Stalled car 10 m ahead, oncoming traffic", facts({ speedMph: 0, obstacleInPathM: 10, obstacleKind: "stalled_car", obstacleStopped: true, canPassObstacle: false }), none, scene({ segment: "Maple St S" }), "yield", ["stop_at_line"], false);
S("judgment", "Stalled car 45 m ahead, approaching at 25 mph", facts({ speedMph: 25, obstacleInPathM: 45, obstacleKind: "stalled_car", obstacleStopped: true, canPassObstacle: false }), none, scene({ segment: "Elm St E" }), "slow_down", ["yield"], false);
S("judgment", "Stalled car 20 m ahead, oncoming clear, car slowing", facts({ speedMph: 8, obstacleInPathM: 20, obstacleKind: "stalled_car", obstacleStopped: true, canPassObstacle: true }), none, scene({ segment: "Oak St E" }), "slow_down", ["proceed", "yield"], false);
S("judgment", "Officer waves the lane through a red, crossing car still in the box", facts({ speedMph: 0, nextControl: light("red", 1, 0), turn: "straight", officerCommand: "go", intersectionClear: false }), { boxDetail: "car 81 (northbound, going straight)" }, scene({ id: "C", ns: "green", ew: "red", inBox: ["car 81 (northbound, going straight)"], events: ["Police officer in the intersection, holding Grand Ave (green) and waving Oak St through its red."] }), "yield", ["stop_at_line"], false);
S("judgment", "Officer holds the lane while the light turns green", facts({ speedMph: 0, nextControl: light("green", 1, 0), turn: "left", officerCommand: "stop", intersectionClear: true }), none, scene({ id: "D", ns: "green", ew: "red", events: ["Police officer in the intersection, holding Maple St (green) and waving Oak St through its red."] }), "stop_at_line", ["yield"], true);
S("judgment", "Signal failed, stopped, arrived second, earlier car crosses", facts({ speedMph: 0, nextControl: light("flashing_red", 1, 0), turn: "straight", hasStoppedAtLine: true, arrivalRankAtStop: 2, earlierConflictingCars: 1, intersectionClear: true }), { waitingCount: 2, arrivalDetail: "car 27 from the west" }, scene({ id: "D", failed: true, arrival: ["car 27 (from the west)", "car 64 (from the north)"] }), "yield", ["stop_at_line"], true);
S("judgment", "Signal failed, approaching at 25 mph", facts({ speedMph: 25, nextControl: light("flashing_red", 40, 25), turn: "straight", hasStoppedAtLine: false, intersectionClear: true }), none, scene({ id: "D", failed: true }), "stop_at_line", ["slow_down"], true);
S("judgment", "Yellow dilemma: comfortable stop barely possible", facts({ speedMph: 25, nextControl: light("yellow", 21, 25, 3.5), turn: "straight" }), behind(25, 25), scene({ id: "D", ns: "yellow", ew: "red", nsT: 3 }), "stop_at_line", [], true);
S("judgment", "Yellow dilemma: comfortable stop just not possible", facts({ speedMph: 25, nextControl: light("yellow", 14, 25, 3.5), turn: "straight" }), behind(12, 25), scene({ id: "D", ns: "yellow", ew: "red", nsT: 3 }), "proceed", [], false);
S("judgment", "Yellow on the arterial, 33 m at 35 mph", facts({ speedMph: 35, limitMph: 35, nextControl: light("yellow", 33, 35, 4.0), turn: "straight" }), none, scene({ id: "A", ns: "yellow", ew: "red", nsT: 4 }), "proceed", [], false);
S("judgment", "Yellow on the arterial, 40 m at 35 mph", facts({ speedMph: 35, limitMph: 35, nextControl: light("yellow", 40, 35, 4.0), turn: "straight" }), none, scene({ id: "A", ns: "yellow", ew: "red", nsT: 4 }), "stop_at_line", [], true);
S("judgment", "Flagger shows STOP 12 m ahead while the light beyond is green", facts({ speedMph: 14, flagger: { command: "stop", distanceM: 12 }, nextControl: light("green", 70, 14), turn: "straight" }), none, scene({ segment: "Elm St W" }), "stop_at_line", ["yield", "emergency_stop"], true);
S("judgment", "Flagger switches to SLOW while this car waits", facts({ speedMph: 0, flagger: { command: "slow", distanceM: 3 } }), none, scene({ segment: "Oak St E" }), "slow_down", ["proceed"], false);
S("judgment", "Object lying in the lane 35 m ahead", facts({ speedMph: 25, obstacleInPathM: 35, obstacleKind: "object", obstacleStopped: true }), { events: ["A cardboard box is lying in this lane 35 m ahead."] }, scene({ segment: "Maple St N" }), "slow_down", ["yield"], false);
S("judgment", "Pedestrian waiting at the crosswalk, DON'T WALK, car turning right", facts({ speedMph: 10, nextControl: light("green", 8, 10), turn: "right", pedestriansAtCurb: 1, crosswalkAheadM: 22, intersectionClear: true }), { crosswalkWhere: "just past the turn" }, scene({ id: "C", ns: "green", ew: "red", walk: "crossing Grand Ave: DON'T WALK; crossing Oak St: DON'T WALK." }), "slow_down", ["proceed"], false);
S("judgment", "Vehicle ahead stopped suddenly 10 m ahead at 25 mph", facts({ speedMph: 25, leadVehicle: { distanceM: 10, speedMph: 0, stopped: true } }), none, scene({ segment: "Elm St E" }), "emergency_stop", ["slow_down"], false);
S("judgment", "Children gathered at the curb, school zone, car at 20 mph", facts({ speedMph: 20, limitMph: 20, schoolZoneActive: true, pedestriansAtCurb: 4, crosswalkAheadM: 20, nextControl: light("green", 16, 20), turn: "straight", intersectionClear: true }), { childrenPresent: true, pedestrianDetail: "Crosswalk 20 m ahead (just past the stop line): 4 waiting at the curb; 4 of them are children, one stepping toward the road." }, scene({ id: "C", ns: "green", ew: "red", school: true }), "slow_down", ["yield"], false);
S("judgment", "Ball in the road near a school crosswalk", facts({ speedMph: 18, limitMph: 20, schoolZoneActive: true, obstacleInPathM: 15, obstacleKind: "object", obstacleStopped: false }), { childrenPresent: true, events: ["A ball is rolling across the road 15 m ahead; it came out from between parked cars."] }, scene({ segment: "Oak St W", events: ["School dismissal: children are at the crosswalks."] }), "slow_down", ["emergency_stop", "yield"], false);
S("judgment", "Ambulance 60 m behind, car approaching a red light", facts({ speedMph: 18, nextControl: light("red", 25, 18), turn: "straight", emergencyVehicleBehindM: 60 }), none, scene({ id: "D", ns: "red", ew: "green", events: ["Ambulance with siren on approaching southbound on Maple St."] }), "pull_over", ["stop_at_line"], true);
S("judgment", "Distracted pedestrian beside a green light approach", facts({ speedMph: 24, nextControl: light("green", 50, 24), turn: "straight", intersectionClear: true, pedestriansAtCurb: 1 }), { events: ["A pedestrian is standing at the right curb 20 m ahead, facing the road and looking at a phone. There is no crosswalk here and no walk signal."] }, scene({ id: "D", ns: "green", ew: "red" }), "slow_down", [], false);
S("judgment", "Officer waves through a red, turning left, oncoming also waved", facts({ speedMph: 0, nextControl: light("red", 1, 0), turn: "left", officerCommand: "go", intersectionClear: true, oncomingGapSafe: false }), { oncomingDetail: "car 52 is 15 m away at 18 mph, arriving in about 1.9 s" }, scene({ id: "A", ns: "red", ew: "green", events: ["Police officer in the intersection, holding Elm St (green) and waving Grand Ave through its red."] }), "yield", ["stop_at_line"], false);
S("judgment", "Children leave the crosswalk; light green; one child still at the far curb", facts({ speedMph: 5, limitMph: 20, schoolZoneActive: true, nextControl: light("green", 3, 5), turn: "straight", pedestriansAtCurb: 1, crosswalkAheadM: 5, intersectionClear: true }), { childrenPresent: true, pedestrianDetail: "Crosswalk 5 m ahead (just past the stop line): 1 waiting at the curb; 1 of them are children." }, scene({ id: "C", ns: "green", ew: "red", school: true }), "slow_down", ["proceed"], false);
S("judgment", "Stalled car just before the intersection, oncoming clear", facts({ speedMph: 0, obstacleInPathM: 8, obstacleKind: "stalled_car", obstacleStopped: true, canPassObstacle: false, nextControl: light("green", 20, 0), turn: "straight" }), none, scene({ id: "D", ns: "green", ew: "red" }), "yield", ["stop_at_line"], false, "Too close to the intersection to swing out.");
S("judgment", "Ambulance siren behind, car stopped at stop sign with the right of way", facts({ speedMph: 0, nextControl: stopSign(1), turn: "straight", hasStoppedAtLine: true, arrivalRankAtStop: 1, earlierConflictingCars: 0, intersectionClear: true, emergencyVehicleBehindM: 18 }), { waitingCount: 1 }, scene({ id: "B", allWay: true, events: ["Ambulance with siren on approaching westbound on Elm St."] }), "pull_over", ["yield", "stop_at_line", "proceed"], true, "Proceeding to clear the way is defensible; staying put or pulling over also.");
S("judgment", "Ball rolled across, car stopped at a red light nearby", facts({ speedMph: 0, nextControl: light("red", 1, 0), turn: "straight" }), { events: ["A ball rolled across the road 10 m ahead a moment ago, from between parked cars. Nobody has followed it yet."] }, scene({ id: "D", ns: "red", ew: "green" }), "stop_at_line", ["yield"], true);

// ------------------------------------------------------------------ AMBIGUOUS (20)
// Reasonable drivers disagree; the acceptable set is wider.

S("ambiguous", "Green light, pedestrian waiting at the curb on WALK", facts({ speedMph: 18, nextControl: light("green", 20, 18), turn: "straight", pedestriansAtCurb: 1, crosswalkAheadM: 24, intersectionClear: true }), { crosswalkWhere: "just past the stop line" }, scene({ id: "C", ns: "green", ew: "red", walk: "crossing Grand Ave: DON'T WALK; crossing Oak St: WALK." }), "slow_down", ["proceed"], false);
S("ambiguous", "Yellow exactly at the comfortable stopping distance", facts({ speedMph: 25, nextControl: { kind: "light", distanceM: 22, lightState: "yellow", secondsToRed: 3.2, canStopComfortably: true, willClearBeforeRed: true }, turn: "straight" }), none, scene({ id: "D", ns: "yellow", ew: "red", nsT: 3 }), "stop_at_line", ["proceed"], true);
S("ambiguous", "Stale green, 25 m ahead, turns red in 5 s", facts({ speedMph: 25, nextControl: light("green", 25, 25, 5.0), turn: "straight", intersectionClear: true, exitHasRoom: true }), none, scene({ id: "D", ns: "green", ew: "red", nsT: 2 }), "proceed", ["slow_down"], false);
S("ambiguous", "Left turn, oncoming car 60 m away at 25 mph", facts({ speedMph: 3, nextControl: light("green", 1, 3), turn: "left", intersectionClear: true, oncomingGapSafe: true, exitHasRoom: true }), { oncomingDetail: "nearest oncoming car is 60 m away" }, scene({ id: "D", ns: "green", ew: "red" }), "proceed", ["yield"], false);
S("ambiguous", "Queue ahead creeping forward at a green", facts({ speedMph: 5, nextControl: light("green", 17, 5), turn: "straight", leadVehicle: { distanceM: 5, speedMph: 1, stopped: false }, intersectionClear: true }), none, scene({ id: "A", ns: "green", ew: "red" }), "proceed", ["slow_down"], false);
S("ambiguous", "All-way stop, opposite car arrived at the same time, both straight", facts({ speedMph: 0, nextControl: stopSign(1), turn: "straight", hasStoppedAtLine: true, arrivalRankAtStop: 1, earlierConflictingCars: 0, intersectionClear: true, exitHasRoom: true }), { waitingCount: 2 }, scene({ id: "B", allWay: true, arrival: ["car 50 (from the north)", "car 17 (from the south)"] }), "proceed", ["yield"], true);
S("ambiguous", "Ambulance approaching the intersection 70 m away on the cross street", facts({ speedMph: 24, nextControl: light("green", 50, 24), turn: "straight", intersectionClear: true, emergencyVehicleCrossingM: 70 }), none, scene({ id: "D", ns: "green", ew: "red", events: ["Ambulance with siren on approaching eastbound on Oak St."] }), "slow_down", ["yield", "proceed", "stop_at_line"], false);
S("ambiguous", "Distracted pedestrian on the far side 50 m ahead", facts({ speedMph: 25, pedestriansAtCurb: 1 }), { events: ["A pedestrian is standing at the left curb 50 m ahead, facing the road and looking at a phone. There is no crosswalk here and no walk signal."] }, scene({ segment: "Maple St N" }), "slow_down", ["proceed"], false);
S("ambiguous", "School zone active, no children visible, at 20 mph", facts({ speedMph: 20, limitMph: 20, schoolZoneActive: true, nextControl: light("green", 55, 20), turn: "straight", intersectionClear: true }), none, scene({ id: "C", ns: "green", ew: "red", school: true }), "proceed", ["slow_down"], false);
S("ambiguous", "School zone begins 30 m ahead, car at 34 mph", facts({ speedMph: 34, limitMph: 35, limitAhead: { mph: 20, distanceM: 30 } }), none, scene({ segment: "Grand Ave S" }), "slow_down", ["proceed"], false);
S("ambiguous", "Stalled car in the oncoming lane, not this one", facts({ speedMph: 24 }), { events: ["A stalled car with hazard lights is stopped in the oncoming lane 30 m ahead."] }, scene({ segment: "Elm St E" }), "slow_down", ["proceed"], false);
S("ambiguous", "Vehicle behind following closely on a yellow you can stop for", facts({ speedMph: 25, nextControl: light("yellow", 26, 25, 3.3), turn: "straight" }), behind(4, 26), scene({ id: "D", ns: "yellow", ew: "red", nsT: 3 }), "stop_at_line", ["proceed"], true);
S("ambiguous", "Green light, a car in the box finishing a left turn across the path", facts({ speedMph: 12, nextControl: light("green", 14, 12), turn: "straight", intersectionClear: false, exitHasRoom: true }), { boxDetail: "car 34 (southbound, turning left)" }, scene({ id: "D", ns: "green", ew: "red", inBox: ["car 34 (southbound, turning left)"] }), "yield", ["slow_down", "stop_at_line"], false);
S("ambiguous", "Pedestrian in the crosswalk on the far side of the road, moving away", facts({ speedMph: 8, nextControl: light("green", 2, 8), turn: "right", pedestriansInCrosswalk: 1, crosswalkAheadM: 13, intersectionClear: true }), { crosswalkWhere: "just past the turn", pedestrianDetail: "Crosswalk 13 m ahead (just past the turn): 1 pedestrian in it, on the far side of the road and walking away from this lane." }, scene({ id: "C", ns: "red", ew: "green" }), "yield", ["slow_down"], true);
S("ambiguous", "Flashing red, stopped, arrived first, a car from the right arrived moments later", facts({ speedMph: 0, nextControl: light("flashing_red", 1, 0), turn: "straight", hasStoppedAtLine: true, arrivalRankAtStop: 1, earlierConflictingCars: 0, intersectionClear: true, exitHasRoom: true }), { waitingCount: 2 }, scene({ id: "D", failed: true, arrival: ["car 29 (from the south)", "car 88 (from the east)"] }), "proceed", ["yield"], true);
S("ambiguous", "Ball rolled across 60 m ahead on the far side", facts({ speedMph: 24 }), { events: ["A ball rolled across the road 60 m ahead a moment ago, from between parked cars. Nobody has followed it yet."] }, scene({ segment: "Oak St E" }), "slow_down", ["proceed"], false);
S("ambiguous", "Officer present but not signalling this lane, light green", facts({ speedMph: 20, nextControl: light("green", 35, 20), turn: "straight", officerCommand: "none", intersectionClear: true }), { events: ["A police officer is standing at the corner of the intersection, not directing traffic."] }, scene({ id: "A", ns: "green", ew: "red" }), "proceed", ["slow_down"], false);
S("ambiguous", "Inside the box turning left, oncoming gap closing", facts({ speedMph: 3, inIntersection: true, turn: "left", intersectionClear: true, oncomingGapSafe: false }), { oncomingDetail: "car 90 is 25 m away at 20 mph, arriving in about 2.8 s" }, scene({ id: "D", ns: "yellow", ew: "red" }), "yield", ["proceed"], false, "Entered on yellow; finishing the turn at the end of the phase is common.");
S("ambiguous", "Construction flagger turning the paddle, now SLOW, car stopped first in line", facts({ speedMph: 0, flagger: { command: "slow", distanceM: 2 } }), behind(6, 0), scene({ segment: "Elm St W" }), "proceed", ["slow_down"], false);
S("ambiguous", "Emergency vehicle 80 m behind, siren faint", facts({ speedMph: 25, emergencyVehicleBehindM: 80 }), none, scene({ segment: "Grand Ave N", events: ["Ambulance with siren on approaching northbound on Grand Ave."] }), "pull_over", ["slow_down", "proceed"], false);

// ------------------------------------------------------------------ write

const counts = { rule: 0, judgment: 0, ambiguous: 0 };
for (const s of all) counts[s.category]++;
const file: ScenarioFile = {
  version: 1,
  scenarios: all,
};
const out = resolve(fileURLToPath(new URL(".", import.meta.url)), "../scenarios.json");
writeFileSync(out, JSON.stringify(file, null, 2) + "\n");
console.log(`wrote ${all.length} scenarios (${counts.rule} rule, ${counts.judgment} judgment, ${counts.ambiguous} ambiguous) to ${out}`);
void turn;
