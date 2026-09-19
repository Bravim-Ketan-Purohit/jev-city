// Two-phase traffic signals with yellow and all-red clearance, pedestrian
// WALK / flashing DON'T WALK, forced yellow (yellow-dilemma event) and
// signal failure (flashing red).

import type { LightState } from "@jev-city/shared";
import type { Arm, Intersection } from "./city.ts";

export interface PhaseSpec {
  arms: Arm[];
  green: number;
  yellow: number;
  allRed: number;
  /** Crosswalk arms that get WALK during this phase (parallel crossings). */
  walkArms: Arm[];
  walk: number;
}

export type WalkState = "walk" | "flash" | "dont" | "dark";

export class Signal {
  readonly int: Intersection;
  readonly phases: PhaseSpec[];
  idx = 0;
  state: "green" | "yellow" | "allred" = "green";
  t = 0;
  private _failed = false;
  /** Sim time the signal last went to flashing red. */
  failedSince = -1e9;
  get failed(): boolean {
    return this._failed;
  }
  set failed(v: boolean) {
    if (v && !this._failed) this.failedSince = this.lastNow;
    this._failed = v;
  }
  private lastNow = 0;
  /** Sim time each arm last turned red. */
  redSince: Record<Arm, number> = { N: -1e9, E: -1e9, S: -1e9, W: -1e9 };
  /** Called with the arms that just turned red. */
  onRed?: (arms: Arm[], now: number) => void;

  constructor(int: Intersection, phases: PhaseSpec[], offset: number) {
    this.int = int;
    this.phases = phases;
    // Arms not green at t=0 are red from the start.
    for (const a of ["N", "E", "S", "W"] as Arm[]) if (!phases[0].arms.includes(a)) this.redSince[a] = -1e9;
    this.advance(offset, 0, true);
  }

  get phase(): PhaseSpec {
    return this.phases[this.idx];
  }

  private advance(dt: number, now: number, silent = false) {
    this.t += dt;
    for (let guard = 0; guard < 10; guard++) {
      const p = this.phase;
      if (this.state === "green" && this.t >= p.green) {
        this.t -= p.green;
        this.state = "yellow";
      } else if (this.state === "yellow" && this.t >= p.yellow) {
        this.t -= p.yellow;
        this.state = "allred";
        const at = now - this.t;
        for (const a of p.arms) this.redSince[a] = silent ? -1e9 : at;
        if (!silent) this.onRed?.(p.arms, at);
      } else if (this.state === "allred" && this.t >= p.allRed) {
        this.t -= p.allRed;
        this.state = "green";
        this.idx = (this.idx + 1) % this.phases.length;
      } else break;
    }
  }

  step(dt: number, now: number) {
    this.lastNow = now;
    this.advance(dt, now);
  }

  /** Force the current green to yellow now (yellow-dilemma event). */
  forceYellow(): Arm[] | undefined {
    if (this.failed || this.state !== "green") return undefined;
    this.state = "yellow";
    this.t = 0;
    return this.phase.arms;
  }

  lightFor(arm: Arm): LightState {
    if (this.failed) return "flashing_red";
    if (!this.phase.arms.includes(arm)) return "red";
    if (this.state === "green") return "green";
    if (this.state === "yellow") return "yellow";
    return "red";
  }

  /** Seconds until this arm turns red (green or yellow only). */
  secondsToRed(arm: Arm): number | undefined {
    if (this.failed || !this.phase.arms.includes(arm)) return undefined;
    const p = this.phase;
    if (this.state === "green") return p.green - this.t + p.yellow;
    if (this.state === "yellow") return p.yellow - this.t;
    return undefined;
  }

  /** Seconds until this arm's light changes (for the scene text). */
  secondsToChange(arm: Arm): number {
    const p = this.phase;
    if (this.phase.arms.includes(arm)) {
      if (this.state === "green") return p.green - this.t;
      if (this.state === "yellow") return p.yellow - this.t;
    }
    // Red: time until this arm's phase turns green.
    let t = 0;
    let i = this.idx;
    let st = this.state;
    t += st === "green" ? p.green - this.t + p.yellow + p.allRed : st === "yellow" ? p.yellow - this.t + p.allRed : p.allRed - this.t;
    for (let k = 0; k < this.phases.length; k++) {
      i = (i + 1) % this.phases.length;
      if (this.phases[i].arms.includes(arm)) return t;
      const q = this.phases[i];
      t += q.green + q.yellow + q.allRed;
      st = "green";
    }
    return t;
  }

  walkFor(cwArm: Arm): WalkState {
    if (this.failed) return "dark";
    const p = this.phase;
    if (!p.walkArms.includes(cwArm)) return "dont";
    if (this.state !== "green") return "dont";
    return this.t < p.walk ? "walk" : "flash";
  }
}

export function makeSignals(ints: Intersection[]): Map<string, Signal> {
  const out = new Map<string, Signal>();
  for (const i of ints) {
    if (i.control !== "light") continue;
    let phases: PhaseSpec[];
    let offset = 0;
    if (i.id === "A" || i.id === "C") {
      // Grand Ave is the 35 mph arterial: longer green and a 4 s yellow.
      phases = [
        { arms: ["N", "S"], green: 20, yellow: 4, allRed: 1.5, walkArms: ["E", "W"], walk: 8 },
        { arms: ["E", "W"], green: 14, yellow: 3.5, allRed: 1.5, walkArms: ["N", "S"], walk: 6 },
      ];
      offset = i.id === "A" ? 0 : 11;
    } else {
      phases = [
        { arms: ["N", "S"], green: 16, yellow: 3.5, allRed: 1.5, walkArms: ["E", "W"], walk: 6 },
        { arms: ["E", "W"], green: 16, yellow: 3.5, allRed: 1.5, walkArms: ["N", "S"], walk: 6 },
      ];
      offset = 23;
    }
    out.set(i.id, new Signal(i, phases, offset));
  }
  return out;
}
