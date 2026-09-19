// Real-time check of the asynchronous decision path with MockJevBrain
// (70-500 ms latency) or JevBrain via the server. Runs the sim paced to wall
// clock at a chosen speed and reports latency, stale decisions and
// fallbacks.
//
//   pnpm --filter @jev-city/web exec tsx scripts/async-check.ts --seconds 30 --speed 1 [--brain jev]

import { MockJevBrain, RuleBrain, percentile, type Brain } from "@jev-city/shared";
import { DecisionScheduler, TokenBucket } from "../src/sim/decisions.ts";
import { installLayers } from "../src/sim/layers.ts";
import { DT, Simulation } from "../src/sim/sim.ts";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const seconds = Number(arg("seconds", "30"));
const speed = Number(arg("speed", "1"));
const brainName = arg("brain", "mock-jev") as "mock-jev" | "jev";
const server = arg("server", "http://localhost:8787");

let jev: Brain | undefined;
if (brainName === "jev") {
  // Node has fetch; point the browser client at the server directly.
  const { JevBrain } = await import("../src/brains/jev.ts");
  const orig = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    orig(typeof url === "string" && url.startsWith("/") ? server + url : url, init)) as typeof fetch;
  jev = new JevBrain();
}

const sim = new Simulation({ seed: 1234, carCount: Number(arg("cars", "30")), brainMode: "rules" });
installLayers(sim, { pedestrians: true });
const bucket = new TokenBucket(15, 15);
const sched = new DecisionScheduler(
  sim,
  { rules: new RuleBrain(), "mock-jev": new MockJevBrain({ seed: 1 }), ...(jev ? { jev } : {}) },
  bucket,
);
sim.warmup(20, () => {});
sim.setBrainMode(brainName);

const sentPerSec: number[] = [];
let lastSent = 0;
const t0 = Date.now();
await new Promise<void>((resolve) => {
  let acc = 0;
  let last = Date.now();
  const iv = setInterval(() => {
    const now = Date.now();
    acc += ((now - last) / 1000) * speed;
    last = now;
    while (acc >= DT) {
      sim.step(DT);
      acc -= DT;
    }
    if (now - t0 >= seconds * 1000) {
      clearInterval(iv);
      resolve();
    }
  }, 10);
  const perSec = setInterval(() => {
    const req = sim.metrics.brains[brainName].requests;
    sentPerSec.push(req - lastSent);
    lastSent = req;
    if (Date.now() - t0 >= seconds * 1000) clearInterval(perSec);
  }, 1000);
});
// Let in-flight requests land.
await new Promise((r) => setTimeout(r, 1500));
sched.drain();

const b = sim.metrics.brains[brainName];
const lat = b.latencies;
console.log(`\n${brainName} at ${speed}x for ${seconds}s wall (${(sim.metrics.startedAt + 0).toFixed(0)}s warmup):`);
console.log(`  requests ${b.requests}, decisions ${b.decisions}, peak requests/s ${Math.max(...sentPerSec)}, throttled ticks ${sim.metrics.throttled}`);
console.log(`  latency p50 ${percentile(lat, 50).toFixed(0)} ms, p95 ${percentile(lat, 95).toFixed(0)} ms`);
console.log(`  stale ${b.stale}, low-confidence ${b.lowConf}, api errors ${b.apiErrors}`);
console.log(`  tokens ${b.inputTokens}${b.tokensEstimated ? " (estimated)" : ""}, models ${[...b.models].join(", ")}`);
console.log(`  violations ${sim.metrics.violations.length} ${JSON.stringify(sim.metrics.violations.map((v) => v.kind))}, interventions ${sim.metrics.interventions.length}, gridlocks ${sim.metrics.gridlocks.length}`);
const cautious = sim.cars.filter((c) => c.fallback).length;
console.log(`  cars in cautious mode now: ${cautious}/${sim.cars.length}`);
process.exit(0);
