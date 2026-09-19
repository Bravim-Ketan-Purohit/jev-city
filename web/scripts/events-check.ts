// Headless run that injects every judgment event on a schedule and prints
// the scored event responses, violations and interventions per brain.
//
//   pnpm --filter @jev-city/web exec tsx scripts/events-check.ts [--brain rules|mock-jev|jev] [--seed 1234]

import { MockJevBrain, RuleBrain, type Brain } from "@jev-city/shared";
import { DecisionScheduler, TokenBucket } from "../src/sim/decisions.ts";
import { EVENT_INFO, type EventKind } from "../src/sim/events.ts";
import { installLayers } from "../src/sim/layers.ts";
import { LANE_W, LX, LY } from "../src/sim/city.ts";
import { DT, Simulation, type BrainMode } from "../src/sim/sim.ts";
import type { Vec } from "../src/sim/geometry.ts";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const brain = arg("brain", "rules") as BrainMode;
const seed = Number(arg("seed", "1234"));
const realtime = brain === "jev";

let jev: Brain | undefined;
if (brain === "jev") {
  const { JevBrain } = await import("../src/brains/jev.ts");
  const orig = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    orig(typeof url === "string" && url.startsWith("/") ? "http://localhost:8787" + url : url, init)) as typeof fetch;
  jev = new JevBrain();
}

const sim = new Simulation({ seed, carCount: 30, brainMode: "rules" });
const layers = installLayers(sim, { pedestrians: true });
const sched = new DecisionScheduler(
  sim,
  { rules: new RuleBrain(), "mock-jev": new MockJevBrain({ seed, realDelay: realtime }), ...(jev ? { jev } : {}) },
  new TokenBucket(realtime ? 15 : 1e9),
);
sim.warmup(20, () => {});
sim.setBrainMode(brain);

const plan: [number, EventKind, Vec | null][] = [
  [8, "ball", { x: LX / 2, y: LANE_W / 2 }],
  [20, "ambulance", { x: -40, y: LANE_W / 2 }],
  [34, "officer", { x: 0, y: 0 }],
  [48, "school", null],
  [60, "distracted", { x: LX / 2, y: LY + 6 }],
  [72, "stalled", { x: LX - LANE_W / 2, y: LY / 2 }],
  [86, "signal_failure", null],
  [98, "yellow", { x: 0, y: LY }],
  [110, "flagger", { x: LX / 2 + 20, y: -LANE_W / 2 }],
];
const end = Number(arg("seconds", "200"));
const t0 = sim.time;
let next = 0;
const tick = () => {
  while (next < plan.length && sim.time - t0 >= plan[next][0]) {
    const [, kind, at] = plan[next++];
    const r = layers.events.inject(kind, at);
    console.log(`t=${(sim.time - t0).toFixed(0).padStart(3)}s inject ${kind.padEnd(15)} ${r.ok ? "ok " : "ERR"} ${r.message}`);
    if (kind === "yellow" && !r.ok) plan.push([sim.time - t0 + 3, "yellow", at]);
  }
};
if (realtime) {
  await new Promise<void>((resolve) => {
    let last = Date.now();
    let acc = 0;
    const iv = setInterval(() => {
      const now = Date.now();
      acc += (now - last) / 1000;
      last = now;
      while (acc >= DT) {
        sim.step(DT);
        tick();
        acc -= DT;
      }
      if (sim.time - t0 >= end) {
        clearInterval(iv);
        resolve();
      }
    }, 10);
  });
  await new Promise((r) => setTimeout(r, 1000));
  sched.drain();
} else {
  while (sim.time - t0 < end) {
    sim.step(DT);
    tick();
  }
}

const m = sim.metrics;
console.log(`\n=== ${brain}, seed ${seed}: event responses ===`);
const by = new Map<string, { ok: number; n: number; notes: string[] }>();
for (const r of m.eventResults) {
  const e = by.get(r.kind) ?? { ok: 0, n: 0, notes: [] };
  e.n++;
  if (r.ok) e.ok++;
  if (e.notes.length < 3) e.notes.push(`car ${r.carId} ${r.ok ? "✓" : "✗"} ${r.note}`);
  by.set(r.kind, e);
}
for (const k of Object.keys(EVENT_INFO) as EventKind[]) {
  const label = EVENT_INFO[k].label;
  const e = by.get(label);
  console.log(`${label.padEnd(22)} ${e ? `${e.ok}/${e.n}` : "–"}${e ? "   " + e.notes.join(" | ") : ""}`);
}
console.log(`\nviolations: ${m.violations.length} ${JSON.stringify(m.violations.map((v) => `${v.kind}:car${v.carId}`))}`);
console.log(`interventions: ${m.interventions.length} ${JSON.stringify(m.interventions.map((v) => v.reason))}`);
console.log(`gridlocks: ${m.gridlocks.length}; stale ${m.brains[brain === "mixed" ? "rules" : brain].stale}; low-conf ${m.brains[brain === "mixed" ? "rules" : brain].lowConf}`);
process.exit(0);
