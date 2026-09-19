// Node proxy that holds the TypeSafe key and calls Jev. The browser POSTs
// zone decision batches to /api/decide (via the Vite dev proxy).

import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { APIError, APIConnectionError, RateLimitError } from "@typesafe-ai/sdk";
import { DEFAULT_DECISION_CONFIG, type DecisionRequest } from "@jev-city/shared";
import { MODEL, SDK_VERSION, callJev, hasKey } from "./jev.ts";

const PORT = Number(process.env.SERVER_PORT ?? 8787);
const LOG_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../logs");

/**
 * Global limiter: at most 15 requests in any one-second window, which leaves
 * headroom under 1,200 per minute.
 */
class Limiter {
  private sent: number[] = [];
  constructor(private rate: number) {}
  /** Wait up to `maxWaitMs` for a slot. */
  async acquire(maxWaitMs: number): Promise<boolean> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const now = Date.now();
      while (this.sent.length && this.sent[0] <= now - 1000) this.sent.shift();
      if (this.sent.length < this.rate) {
        this.sent.push(now);
        return true;
      }
      if (now >= deadline) return false;
      await new Promise((r) => setTimeout(r, Math.max(5, this.sent[0] + 1000 - now)));
    }
  }
}

const limiter = new Limiter(DEFAULT_DECISION_CONFIG.maxRequestsPerSecond);
const stats = { requests: 0, errors: 0, limited: 0, inputTokens: 0, models: new Set<string>() };

async function logLine(obj: object) {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    await appendFile(resolve(LOG_DIR, `jev-${day}.jsonl`), JSON.stringify(obj) + "\n");
  } catch {
    /* logging must never break a decision */
  }
}

const app = new Hono();

app.get("/api/health", (c) =>
  c.json({
    hasKey: hasKey(),
    model: MODEL,
    sdk: SDK_VERSION,
    stats: { ...stats, models: [...stats.models] },
  }),
);

app.post("/api/decide", async (c) => {
  if (!hasKey()) return c.json({ error: "TYPESAFE_API_KEY is not set in .env" }, 503);
  let req: DecisionRequest;
  try {
    req = await c.req.json<DecisionRequest>();
    if (!req?.cars?.length) throw new Error("no cars");
  } catch (e) {
    return c.json({ error: `bad request: ${String(e)}` }, 400);
  }
  if (!(await limiter.acquire(250))) {
    stats.limited++;
    return c.json({ error: "rate limited by proxy (15 req/s)" }, 429);
  }
  stats.requests++;
  try {
    const r = await callJev(req);
    stats.inputTokens += r.usage.inputTokens;
    stats.models.add(r.model);
    console.log(
      `[jev] ${new Date().toISOString().slice(11, 23)} zone=${req.zoneId} cars=${req.cars.length} ${r.jevLatencyMs.toFixed(0)}ms model=${r.model} in=${r.usage.inputTokens}`,
    );
    void logLine({
      t: new Date().toISOString(),
      zone: req.zoneId,
      simTime: req.simTime,
      cars: req.cars.length,
      model: r.model,
      requestId: r.requestId,
      latencyMs: Math.round(r.jevLatencyMs),
      inputTokens: r.usage.inputTokens,
      decisions: r.decisions.map((d) => ({ car: d.carId, action: d.action, conf: +d.actionConfidence.toFixed(3) })),
    });
    return c.json({
      decisions: r.decisions,
      model: r.model,
      usage: r.usage,
      estimatedTokens: r.estimatedTokens,
      jevLatencyMs: r.jevLatencyMs,
    });
  } catch (e) {
    stats.errors++;
    let status = 502;
    let msg = e instanceof Error ? e.message : String(e);
    if (e instanceof RateLimitError) status = 429;
    else if (e instanceof APIError) msg = `TypeSafe ${e.status}: ${msg}`;
    else if (e instanceof APIConnectionError) msg = `connection: ${msg}`;
    console.warn(`[jev] error zone=${req.zoneId}: ${msg}`);
    void logLine({ t: new Date().toISOString(), zone: req.zoneId, error: msg });
    return c.json({ error: msg.slice(0, 300) }, status as 429 | 502);
  }
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(
    `[server] Jev proxy on http://localhost:${info.port}  model=${MODEL}  sdk=${SDK_VERSION}  key=${hasKey() ? "present" : "MISSING (set TYPESAFE_API_KEY in .env)"}`,
  );
});
