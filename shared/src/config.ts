// Tunable constants shared by the sim, server and bench.

export const JEV_MODEL = "jev-1.13.0";

/** USD per million input tokens for jev-1.13.0 (output tokens are free). */
export const PRICE_PER_MTOK = 0.042;

export interface DecisionConfig {
  /** Decision ticks per second of sim time, per zone. */
  decisionHz: number;
  /** A decision older than this (sim seconds) is stale and the car goes cautious. */
  decisionExpiryS: number;
  /** Below this action confidence the car falls back to cautious mode. */
  minConfidence: number;
  /** Entering an intersection with `proceed` needs at least this confidence. */
  enterConfidence: number;
  /** Where the right-of-way question applies, entering needs at least this probability. */
  rightOfWayMin: number;
  /** A car asks for decisions within this distance of the next stop line (m). */
  decisionRadiusM: number;
  /** Events within this distance put a car into a decision zone (m). */
  eventRadiusM: number;
  /** Global request cap for remote brains (requests per second). */
  maxRequestsPerSecond: number;
  batching: "per-zone" | "per-car";
}

export const DEFAULT_DECISION_CONFIG: DecisionConfig = {
  decisionHz: 3,
  decisionExpiryS: 1.0,
  minConfidence: 0.5,
  enterConfidence: 0.7,
  rightOfWayMin: 0.5,
  decisionRadiusM: 80,
  eventRadiusM: 60,
  maxRequestsPerSecond: 15,
  batching: "per-zone",
};

export const MPH = 0.44704; // m/s per mph
export const toMph = (ms: number) => ms / MPH;
export const toMs = (mph: number) => mph * MPH;

/** Comfortable braking used for "can stop comfortably" (m/s^2). */
export const COMFORT_BRAKE = 4;
export const MAX_BRAKE = 8;
export const ACCEL = 3;
/** Reaction allowance included in stopping feasibility (s). */
export const REACTION_S = 0.4;

export function comfortableStopDistance(speedMs: number): number {
  return speedMs * REACTION_S + (speedMs * speedMs) / (2 * COMFORT_BRAKE);
}
