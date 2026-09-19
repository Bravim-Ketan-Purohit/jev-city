// Ground-truth counters. Violations are detected geometrically by the
// simulation, independent of any brain.

import { percentile, type BrainName } from "@jev-city/shared";
import type { Vec } from "./geometry.ts";

export type ViolationKind =
  | "ran_red"
  | "rolled_stop"
  | "speeding"
  | "school_speeding"
  | "ped_yield"
  | "ev_yield"
  | "blocked_box"
  | "collision";

export const VIOLATION_LABEL: Record<ViolationKind, string> = {
  ran_red: "Ran red",
  rolled_stop: "Rolled stop",
  speeding: "Speeding",
  school_speeding: "School-zone speeding",
  ped_yield: "Failed to yield to pedestrian",
  ev_yield: "Failed to yield to ambulance",
  blocked_box: "Blocked the box",
  collision: "Collision",
};

export interface Violation {
  kind: ViolationKind;
  t: number;
  carId: number;
  brain: BrainName;
  pos: Vec;
  detail: string;
}

export interface Intervention {
  t: number;
  carId: number;
  brain: BrainName;
  pos: Vec;
  reason: string;
}

export interface BrainStats {
  decisions: number;
  requests: number;
  lowConf: number;
  stale: number;
  apiErrors: number;
  interventions: number;
  violations: number;
  latencies: number[];
  inputTokens: number;
  tokensEstimated: boolean;
  models: Set<string>;
}

const emptyBrain = (): BrainStats => ({
  decisions: 0,
  requests: 0,
  lowConf: 0,
  stale: 0,
  apiErrors: 0,
  interventions: 0,
  violations: 0,
  latencies: [],
  inputTokens: 0,
  tokensEstimated: false,
  models: new Set(),
});

export interface EventResult {
  eventId: number;
  kind: string;
  carId: number;
  brain: BrainName;
  ok: boolean;
  note: string;
  t: number;
}

export class Metrics {
  violations: Violation[] = [];
  interventions: Intervention[] = [];
  gridlocks: { t: number; int: string }[] = [];
  exits: Record<string, number[]> = { A: [], B: [], C: [], D: [] };
  trips: number[] = [];
  brains: Record<BrainName, BrainStats> = { rules: emptyBrain(), "mock-jev": emptyBrain(), jev: emptyBrain() };
  eventResults: EventResult[] = [];
  throttled = 0;
  startedAt = 0;

  reset(now: number) {
    this.violations = [];
    this.interventions = [];
    this.gridlocks = [];
    this.exits = { A: [], B: [], C: [], D: [] };
    this.trips = [];
    this.brains = { rules: emptyBrain(), "mock-jev": emptyBrain(), jev: emptyBrain() };
    this.eventResults = [];
    this.throttled = 0;
    this.startedAt = now;
  }

  count(kind: ViolationKind): number {
    let n = 0;
    for (const v of this.violations) if (v.kind === kind) n++;
    return n;
  }

  /** Cars leaving each intersection per minute over the last 60 s. */
  throughput(now: number): Record<string, number> {
    const win = Math.min(60, Math.max(1, now - this.startedAt));
    const out: Record<string, number> = {};
    for (const [k, ts] of Object.entries(this.exits)) {
      let n = 0;
      for (let i = ts.length - 1; i >= 0 && ts[i] > now - 60; i--) n++;
      out[k] = (n * 60) / win;
    }
    return out;
  }

  /** Total exits in fixed buckets for the sparkline. */
  sparkline(now: number, bucket = 10, n = 18): number[] {
    const all = Object.values(this.exits).flat();
    const out = new Array(n).fill(0);
    for (const t of all) {
      const k = Math.floor((now - t) / bucket);
      if (k >= 0 && k < n) out[n - 1 - k]++;
    }
    return out;
  }

  latency(brain: BrainName): { p50: number; p95: number; n: number } {
    const l = this.brains[brain].latencies;
    return { p50: percentile(l, 50), p95: percentile(l, 95), n: l.length };
  }
}
