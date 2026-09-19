// Headless run of the city with RuleBrain. Prints violations, gridlock and
// traffic through each intersection; exits non-zero if any ground-truth
// violation, safety intervention or gridlock occurred.
//
//   pnpm sim:check -- --minutes 5 --cars 30 --seed 1234 [--no-left] [--no-safety]

import { MockJevBrain, RuleBrain, percentile } from "@jev-city/shared";
import { DecisionScheduler, TokenBucket } from "../src/sim/decisions.ts";
import { installLayers } from "../src/sim/layers.ts";
import { VIOLATION_LABEL, type ViolationKind } from "../src/sim/metrics.ts";
import { DT, Simulation, type BrainMode } from "../src/sim/sim.ts";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const minutes = Number(arg("minutes", "5"));
const cars = Number(arg("cars", "30"));
const seed = Number(arg("seed", "1234"));
const brain = arg("brain", "rules") as BrainMode;
const sim = new Simulation({
  seed,
  carCount: cars,
  allowLeft: !flag("no-left"),
  safety: !flag("no-safety"),
  brainMode: brain,
});
installLayers(sim, { pedestrians: !flag("no-peds") });
new DecisionScheduler(sim, { rules: new RuleBrain(), "mock-jev": new MockJevBrain({ seed, realDelay: false }) }, new TokenBucket(1e9, 1e9));

const turns: Record<string, Record<string, number>> = {};
sim.onCrossStopHook = (c, st) => {
  (turns[st.int.id] ??= { straight: 0, right: 0, left: 0 })[st.turn]++;
  void c;
};

const t0 = Date.now();
const steps = Math.round((minutes * 60) / DT);
let maxCars = 0;
let sumCars = 0;
for (let i = 0; i < steps; i++) {
  sim.step(DT);
  const n = sim.cars.filter((c) => c.kind === "car").length;
  maxCars = Math.max(maxCars, n);
  sumCars += n;
}
const m = sim.metrics;
const wall = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\nJev City headless check: ${minutes} min sim, seed ${seed}, target ${cars} cars, brain ${brain} (${wall}s wall)`);
console.log(`cars on map: avg ${(sumCars / steps).toFixed(1)}, max ${maxCars}; trips completed ${m.trips.length}, avg trip ${(m.trips.reduce((a, b) => a + b, 0) / Math.max(1, m.trips.length)).toFixed(1)} s, p95 ${percentile(m.trips, 95).toFixed(1)} s`);
console.log("\nmovements entering each intersection:");
for (const id of ["A", "B", "C", "D"]) {
  const t = turns[id] ?? { straight: 0, right: 0, left: 0 };
  console.log(`  ${id}: straight ${t.straight}, right ${t.right}, left ${t.left}; exits/min ${(m.exits[id].length / minutes).toFixed(1)}`);
}
console.log("\nviolations:");
let total = 0;
for (const k of Object.keys(VIOLATION_LABEL) as ViolationKind[]) {
  const n = m.count(k);
  total += n;
  console.log(`  ${VIOLATION_LABEL[k].padEnd(34)} ${n}`);
}
for (const v of m.violations.slice(0, 12)) console.log(`    t=${v.t.toFixed(1)} car ${v.carId}: ${v.kind} ${v.detail}`);
console.log(`\nsafety interventions: ${m.interventions.length}`);
for (const v of m.interventions.slice(0, 12)) console.log(`    t=${v.t.toFixed(1)} car ${v.carId}: ${v.reason}`);
console.log(`gridlocks: ${m.gridlocks.length}${m.gridlocks.length ? " " + JSON.stringify(m.gridlocks.slice(0, 5)) : ""}`);
const b = m.brains[brain === "mixed" ? "rules" : brain];
console.log(`decisions: ${b.decisions}, requests ${b.requests}, stale ${b.stale}, low-confidence ${b.lowConf}`);
if (m.eventResults.length) console.log(`event results: ${m.eventResults.filter((r) => r.ok).length}/${m.eventResults.length} ok`);

const fail = total > 0 || m.gridlocks.length > 0 || m.interventions.length > 0;
console.log(fail ? "\nRESULT: FAIL" : "\nRESULT: PASS (no violations, no interventions, no gridlock)");
process.exit(fail ? 1 : 0);
