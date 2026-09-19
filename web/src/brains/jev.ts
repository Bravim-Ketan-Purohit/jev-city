// JevBrain: POSTs the zone's decision request to the server proxy, which
// calls Jev with @typesafe-ai/sdk and returns typed CarDecisions.

import type { Brain, CarDecision, DecideResult, DecisionRequest } from "@jev-city/shared";

export interface JevHealth {
  ok: boolean;
  hasKey: boolean;
  model?: string;
  error?: string;
}

export async function checkJevHealth(): Promise<JevHealth> {
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    if (!r.ok) return { ok: false, hasKey: false, error: `HTTP ${r.status}` };
    const j = (await r.json()) as JevHealth;
    return { ...j, ok: j.hasKey };
  } catch (e) {
    return { ok: false, hasKey: false, error: String(e) };
  }
}

interface DecideResponse {
  decisions: CarDecision[];
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
  estimatedTokens: number;
  jevLatencyMs: number;
}

export class JevBrain implements Brain {
  readonly name = "jev" as const;

  async decide(req: DecisionRequest): Promise<CarDecision[]> {
    return (await this.decideWithMeta(req)).decisions;
  }

  async decideWithMeta(req: DecisionRequest): Promise<DecideResult> {
    const t0 = performance.now();
    const res = await fetch("/api/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    const latency = performance.now() - t0;
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg += `: ${j.error}`;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    const data = (await res.json()) as DecideResponse;
    return {
      decisions: data.decisions.map((d) => ({ ...d, latencyMs: latency })),
      meta: {
        inputTokens: data.usage?.inputTokens ?? data.estimatedTokens,
        tokensEstimated: !data.usage,
        model: data.model,
        requestLatencyMs: latency,
      },
    };
  }
}
