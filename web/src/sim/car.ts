import type { BrainName, CarDecision, CarPerception } from "@jev-city/shared";
import type { Route } from "./route.ts";

export type CarKind = "car" | "ambulance" | "stalled";
export type FallbackReason = "stale" | "low_conf" | "api_error" | "other";

export interface ActiveDecision extends CarDecision {
  brain: BrainName;
  /** Sim time of the perception snapshot the decision was made from. */
  issuedAt: number;
  receivedAt: number;
  zoneId: string;
}

export interface Pose {
  x: number;
  y: number;
  h: number; // heading angle (rad)
}

export class Car {
  readonly id: number;
  readonly label: string;
  kind: CarKind;
  brain: BrainName;
  route: Route;
  s: number;
  v: number;
  a = 0;
  lat = 0;
  latTarget = 0;
  readonly L: number;
  readonly W: number;
  readonly spawnTime: number;

  decision: ActiveDecision | null = null;
  fallback: FallbackReason | null = null;
  apiError = false;
  zoneId: string | null = null;
  zoneEnteredAt = 0;
  perception?: CarPerception;
  perceivedAt = -1;

  /** Stop-line index -> sim time the car first came to a full stop at it. */
  stopMarks = new Map<number, number>();
  /** Stop-line index -> minimum speed seen within 3 m before the line. */
  nearLineMin = new Map<number, number>();
  crossed = new Set<number>();
  /** Sim time the front crossed the most recent stop line. */
  boxEnter?: number;
  reflex = false;
  reflexCount = 0;
  hardBrake = false;
  /** Going around a stalled car. */
  pass: { targetId: number; endS: number } | null = null;
  overLimitFor = 0;
  speedingFlag = false;
  schoolFlag = false;
  pose: Pose = { x: 0, y: 0, h: 0 };
  prevPose: Pose = { x: 0, y: 0, h: 0 };
  despawned = false;
  /** Hazard-light blink for stalled cars / ambulance strobe phase. */
  blink = 0;

  constructor(opts: {
    id: number;
    kind: CarKind;
    brain: BrainName;
    route: Route;
    s: number;
    v: number;
    now: number;
  }) {
    this.id = opts.id;
    this.label = String(opts.id);
    this.kind = opts.kind;
    this.brain = opts.brain;
    this.route = opts.route;
    this.s = opts.s;
    this.v = opts.v;
    this.spawnTime = opts.now;
    this.L = opts.kind === "ambulance" ? 6.2 : 4.5;
    this.W = opts.kind === "ambulance" ? 2.2 : 1.9;
  }

  get rear(): number {
    return this.s - this.L;
  }
  get center(): number {
    return this.s - this.L / 2;
  }
}
