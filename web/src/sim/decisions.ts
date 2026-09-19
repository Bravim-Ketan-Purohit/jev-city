// Decision layer: event-driven, batched by zone at ~3 Hz of sim time, with a
// global token bucket for remote brains. A car keeps executing its last
// decision while the next one is in flight.

import {
  buildJevPayload,
  estimateTokens,
  type Brain,
  type BrainName,
  type CarDecision,
  type DecideMeta,
  type DecisionRequest,
} from "@jev-city/shared";
import type { Car } from "./car.ts";
import { perceive, sceneFor } from "./perceive.ts";
import type { Simulation } from "./sim.ts";

const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Global request limiter (real time), shared by every simulation on the page. */
export class TokenBucket {
  private tokens: number;
  private last = nowMs();
  constructor(
    public rate: number,
    public burst: number,
  ) {
    this.tokens = burst;
  }
  take(): boolean {
    const t = nowMs();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
  /** Requests sent in the last second (for the UI gauge). */
  sent: number[] = [];
  mark() {
    const t = nowMs();
    this.sent.push(t);
    while (this.sent.length && this.sent[0] < t - 1000) this.sent.shift();
  }
  get perSecond(): number {
    const t = nowMs();
    while (this.sent.length && this.sent[0] < t - 1000) this.sent.shift();
    return this.sent.length;
  }
}

interface InboxEntry {
  brain: BrainName;
  req: DecisionRequest;
  issuedAt: number;
  cars: number[];
  decisions?: CarDecision[];
  meta?: DecideMeta;
  error?: string;
}

export interface DecisionRecord {
  t: number;
  zone: string;
  carId: number;
  brain: BrainName;
  d: CarDecision;
}

export class DecisionScheduler {
  private lastTick = -1e9;
  private inFlight = new Set<string>();
  private inbox: InboxEntry[] = [];
  /** Recent decisions for the UI log (ring buffer). */
  recent: DecisionRecord[] = [];
  /** Last scene text sent for each zone (Inspector). */
  lastScene = new Map<string, string>();

  constructor(
    readonly sim: Simulation,
    public brains: Partial<Record<BrainName, Brain>>,
    readonly bucket: TokenBucket,
  ) {
    sim.decisionTick = () => this.tick();
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  tick() {
    this.drain();
    const sim = this.sim;
    const now = sim.time;
    const cfg = sim.opts.decision;
    if (now - this.lastTick < 1 / cfg.decisionHz - 1e-6) return;
    this.lastTick = now;

    const groups = new Map<string, { brain: BrainName; zoneId: string; cars: Car[] }>();
    for (const c of sim.cars) {
      if (!c.zoneId) continue;
      const key = cfg.batching === "per-car" ? `${c.brain}|car${c.id}` : `${c.brain}|${c.zoneId}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { brain: c.brain, zoneId: c.zoneId, cars: [] }));
      g.cars.push(c);
    }

    for (const [key, g] of groups) {
      if (this.inFlight.has(key)) continue;
      const brain = this.brains[g.brain];
      if (!brain) continue;
      const remote = !brain.decideSync;
      if (remote && !this.bucket.take()) {
        sim.metrics.throttled++;
        continue;
      }
      const cars = g.cars.map((c) => {
        const p = perceive(sim, c);
        c.perception = p;
        c.perceivedAt = now;
        return p;
      });
      const req: DecisionRequest = { zoneId: g.zoneId, sceneText: sceneFor(sim, g.zoneId), cars, simTime: now };
      this.lastScene.set(g.zoneId, req.sceneText);
      const carIds = g.cars.map((c) => c.id);
      sim.metrics.brains[g.brain].requests++;
      if (brain.decideSync) {
        const t0 = nowMs();
        const decisions = brain.decideSync(req);
        this.apply({
          brain: g.brain,
          req,
          issuedAt: now,
          cars: carIds,
          decisions,
          meta: { inputTokens: 0, tokensEstimated: false, model: "rules", requestLatencyMs: nowMs() - t0 },
        });
        continue;
      }
      this.inFlight.add(key);
      this.bucket.mark();
      const t0 = nowMs();
      const p = brain.decideWithMeta
        ? brain.decideWithMeta(req)
        : brain.decide(req).then((decisions) => ({
            decisions,
            meta: {
              inputTokens: estimateTokens(buildJevPayload(req)),
              tokensEstimated: true,
              requestLatencyMs: nowMs() - t0,
            } as DecideMeta,
          }));
      p.then(
        (res) => this.inbox.push({ brain: g.brain, req, issuedAt: now, cars: carIds, ...res }),
        (err: unknown) =>
          this.inbox.push({
            brain: g.brain,
            req,
            issuedAt: now,
            cars: carIds,
            error: err instanceof Error ? err.message : String(err),
          }),
      ).finally(() => this.inFlight.delete(key));
    }
  }

  /** Apply responses that arrived since the last step. */
  drain() {
    const items = this.inbox;
    this.inbox = [];
    for (const e of items) this.apply(e);
  }

  private apply(e: InboxEntry) {
    const sim = this.sim;
    const stats = sim.metrics.brains[e.brain];
    if (e.error !== undefined) {
      stats.apiErrors++;
      for (const id of e.cars) {
        const c = sim.carById(id);
        if (c) c.apiError = true;
      }
      sim.pushLog({
        t: sim.time,
        kind: "fallback",
        text: `${e.brain} request for ${e.req.zoneId} failed (${e.error.slice(0, 80)}); ${e.cars.length} car(s) cautious`,
        brain: e.brain,
        severity: "bad",
      });
      return;
    }
    const meta = e.meta!;
    stats.inputTokens += meta.inputTokens;
    stats.tokensEstimated ||= meta.tokensEstimated;
    if (meta.model) stats.models.add(meta.model);
    stats.latencies.push(meta.requestLatencyMs);
    if (stats.latencies.length > 5000) stats.latencies.splice(0, 1000);
    const minConf = sim.opts.decision.minConfidence;
    for (const d of e.decisions ?? []) {
      const c = sim.carById(Number(d.carId));
      if (!c) continue;
      c.apiError = false;
      c.decision = { ...d, brain: e.brain, issuedAt: e.issuedAt, receivedAt: sim.time, zoneId: e.req.zoneId };
      stats.decisions++;
      if (d.actionConfidence < minConf) {
        stats.lowConf++;
        sim.pushLog({
          t: sim.time,
          kind: "fallback",
          text: `Car ${c.label}: low confidence ${(d.actionConfidence * 100).toFixed(0)}% on ${d.action}, cautious mode`,
          carId: c.id,
          brain: e.brain,
          severity: "warn",
        });
      }
      const rec: DecisionRecord = { t: sim.time, zone: e.req.zoneId, carId: c.id, brain: e.brain, d };
      this.recent.push(rec);
      if (this.recent.length > 300) this.recent.splice(0, this.recent.length - 300);
      if (sim.decisionLog.length < 50000) {
        const p = e.req.cars.find((x) => x.carId === d.carId);
        sim.decisionLog.push({
          simTime: +e.issuedAt.toFixed(3),
          appliedAt: +sim.time.toFixed(3),
          zone: e.req.zoneId,
          car: c.id,
          brain: e.brain,
          model: d.model,
          action: d.action,
          confidence: +d.actionConfidence.toFixed(4),
          probs: d.actionProbs,
          speedLevel: +d.speedLevel.toFixed(3),
          mustStop: +d.mustStopProb.toFixed(4),
          hazard: +d.hazardLevel.toFixed(3),
          rightOfWay: d.rightOfWayProb,
          latencyMs: Math.round(d.latencyMs),
          facts: p?.facts,
          text: p?.text,
        });
      }
    }
  }
}
