// Brain interface shared by the simulation, the server and the benchmark.
// The first part mirrors the build spec exactly; fields marked "extension"
// are extra structured facts the rule baseline needs to be fair (turn
// direction, whether the box is clear, left-turn gaps, flaggers, ...).

export type Action =
  | "proceed"
  | "slow_down"
  | "stop_at_line"
  | "emergency_stop"
  | "yield"
  | "pull_over"
  | "other";

export const ACTIONS: Action[] = [
  "proceed",
  "slow_down",
  "stop_at_line",
  "emergency_stop",
  "yield",
  "pull_over",
  "other",
];

export type LightState = "green" | "yellow" | "red" | "flashing_red";
export type Turn = "straight" | "right" | "left";

export interface PerceptionFacts {
  speedMph: number;
  limitMph: number;
  schoolZoneActive: boolean;
  nextControl: {
    kind: "light" | "stop_sign" | "none";
    distanceM: number;
    lightState?: LightState;
    secondsToRed?: number;
    canStopComfortably?: boolean;
    willClearBeforeRed?: boolean;
  };
  leadVehicle?: { distanceM: number; speedMph: number; stopped: boolean };
  pedestriansInCrosswalk: number;
  pedestriansAtCurb: number;
  emergencyVehicleBehindM?: number;
  officerCommand?: "go" | "stop" | "none";
  arrivalRankAtStop?: number; // 1 = arrived first
  obstacleInPathM?: number;

  // ---- extensions (structured, code-computed) ----
  /** Movement at the next intersection. */
  turn?: Turn;
  /** The car is inside an intersection box right now. */
  inIntersection?: boolean;
  /** Stop sign / flashing red: the car already came to a full stop at this line. */
  hasStoppedAtLine?: boolean;
  /** No vehicle whose path crosses this car's path is inside the intersection box. */
  intersectionClear?: boolean;
  /** Stop sign / flashing red: waiting cars that arrived earlier and cross this car's path. */
  earlierConflictingCars?: number;
  /** There is room on the exit lane past the intersection for this car. */
  exitHasRoom?: boolean;
  /** Left turns: the oncoming gap is long enough to complete the turn. */
  oncomingGapSafe?: boolean;
  /** Distance to the nearest crosswalk on this car's path (within 60 m). */
  crosswalkAheadM?: number;
  /** A lower speed limit starts ahead (school zone). */
  limitAhead?: { mph: number; distanceM: number };
  /** What the obstacle in the path is and whether it is stationary. */
  obstacleKind?: "stalled_car" | "object";
  obstacleStopped?: boolean;
  /** Stalled car ahead: the oncoming lane is clear long enough to go around it. */
  canPassObstacle?: boolean;
  /** A construction flagger ahead in this lane. */
  flagger?: { command: "slow" | "stop"; distanceM: number };
  /** An emergency vehicle is approaching the next intersection on another road. */
  emergencyVehicleCrossingM?: number;
}

export interface CarPerception {
  carId: string;
  text: string; // plain-language rendering of the facts plus event descriptions
  facts: PerceptionFacts; // structured, used by RuleBrain and for scoring
}

export interface DecisionRequest {
  zoneId: string; // intersection or road segment
  sceneText: string; // shared context for the zone
  cars: CarPerception[];
  simTime: number;
}

export interface CarDecision {
  carId: string;
  action: Action;
  actionProbs: Record<Action, number>;
  actionConfidence: number;
  speedLevel: number; // 0..3, fractional, mapped to mph by code
  mustStopProb: number;
  hazardLevel: number; // 0..3, fractional
  rightOfWayProb?: number; // four-way stops, left turns, signal failure only
  latencyMs: number;
  model?: string;
}

export type BrainName = "rules" | "mock-jev" | "jev";

/** Metadata a brain reports about one request (tokens, model, errors). */
export interface DecideMeta {
  inputTokens: number;
  tokensEstimated: boolean;
  model?: string;
  requestLatencyMs: number;
}

export interface DecideResult {
  decisions: CarDecision[];
  meta: DecideMeta;
}

export interface Brain {
  name: BrainName;
  decide(req: DecisionRequest): Promise<CarDecision[]>;
  /** Optional synchronous path (RuleBrain) so headless runs stay deterministic. */
  decideSync?(req: DecisionRequest): CarDecision[];
  /** Same as decide, plus per-request metadata (tokens, model, latency). */
  decideWithMeta?(req: DecisionRequest): Promise<DecideResult>;
}

/** True when the right-of-way question applies to this car. */
export function needsRightOfWay(f: PerceptionFacts): boolean {
  if (f.inIntersection) return false;
  if (f.nextControl.kind === "stop_sign") return true;
  if (f.nextControl.lightState === "flashing_red") return true;
  return f.turn === "left" && f.nextControl.kind !== "none";
}
