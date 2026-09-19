// MockJevBrain: wraps RuleBrain, adds noise to the probabilities, a random
// latency of 70-500 ms, and picks the second-best action about 5% of the
// time. It exercises every UI and latency path without an API key.

import {
  ACTIONS,
  type Action,
  type Brain,
  type CarDecision,
  type DecideResult,
  type DecisionRequest,
} from "./brain.ts";
import { buildJevPayload, estimateTokens } from "./questions.ts";
import { ruleDecide, type RuleOutput } from "./rules.ts";
import { Rng } from "./rng.ts";
import { entropyConfidence } from "./stats.ts";

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export interface MockOptions {
  seed?: number;
  minLatencyMs?: number;
  maxLatencyMs?: number;
  flipRate?: number;
  /** When false the latency is sampled and reported but not awaited (bench). */
  realDelay?: boolean;
}

export class MockJevBrain implements Brain {
  readonly name = "mock-jev" as const;
  private rng: Rng;
  private opts: Required<MockOptions>;

  constructor(opts: MockOptions = {}) {
    this.opts = {
      seed: 7,
      minLatencyMs: 70,
      maxLatencyMs: 500,
      flipRate: 0.05,
      realDelay: true,
      ...opts,
    };
    this.rng = new Rng(this.opts.seed);
  }

  private noisy(carId: string, r: RuleOutput, latencyMs: number): CarDecision {
    const rng = this.rng;
    const flip = rng.chance(this.opts.flipRate);
    const best = flip ? r.alt : r.action;
    const second = flip ? r.action : r.alt;
    // Peak usually 0.85-0.98, lower when the scene is hazardous, with most
    // of the remainder on the runner-up.
    const peak = clamp(0.93 - 0.07 * r.hazard + rng.normal() * 0.06, 0.45, 0.99);
    const runner = (1 - peak) * rng.range(0.5, 0.85);
    let rest = 1 - peak - runner;
    const probs = Object.fromEntries(ACTIONS.map((a) => [a, 0])) as Record<Action, number>;
    probs[best] = peak;
    probs[second] += runner;
    const others = ACTIONS.filter((a) => a !== best && a !== second);
    const w = others.map(() => rng.next());
    const ws = w.reduce((s, x) => s + x, 0) || 1;
    others.forEach((a, i) => {
      probs[a] += (rest * w[i]) / ws;
    });
    rest = 0;
    const yes = (b: boolean) => clamp(b ? 0.92 + rng.normal() * 0.05 : 0.06 + rng.normal() * 0.05, 0.001, 0.999);
    return {
      carId,
      action: best,
      actionProbs: probs,
      actionConfidence: entropyConfidence(probs),
      speedLevel: clamp(r.speedLevel + rng.normal() * 0.2, 0, 3),
      mustStopProb: yes(r.mustStop),
      hazardLevel: clamp(r.hazard + rng.normal() * 0.25, 0, 3),
      rightOfWayProb: r.rightOfWay === undefined ? undefined : yes(r.rightOfWay),
      latencyMs,
      model: "mock-jev",
    };
  }

  async decide(req: DecisionRequest): Promise<CarDecision[]> {
    return (await this.decideWithMeta(req)).decisions;
  }

  async decideWithMeta(req: DecisionRequest): Promise<DecideResult> {
    const latency = this.rng.range(this.opts.minLatencyMs, this.opts.maxLatencyMs);
    const started = Date.now();
    if (this.opts.realDelay) await new Promise((res) => setTimeout(res, latency));
    const measured = this.opts.realDelay ? Date.now() - started : latency;
    const decisions = req.cars.map((c) => this.noisy(c.carId, ruleDecide(c.facts), measured));
    return {
      decisions,
      meta: {
        inputTokens: estimateTokens(buildJevPayload(req)),
        tokensEstimated: true,
        model: "mock-jev",
        requestLatencyMs: measured,
      },
    };
  }
}
