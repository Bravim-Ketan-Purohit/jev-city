// Jev adapter: turns a zone DecisionRequest into one TypeSafe System One
// request (state = scene + per-car perceptions, questions = every per-car
// question) and maps the typed answers back into CarDecisions.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { TypeSafeClient, VERSION, type Questions } from "@typesafe-ai/sdk";
import {
  JEV_MODEL,
  buildJevPayload,
  estimateTokens,
  parseJevAnswers,
  type CarDecision,
  type DecisionRequest,
} from "@jev-city/shared";

// The key lives in the repo-root .env and never reaches the browser.
loadEnv({ path: resolve(fileURLToPath(new URL(".", import.meta.url)), "../../.env"), quiet: true });

export const MODEL = process.env.JEV_MODEL?.trim() || JEV_MODEL;
export const SDK_VERSION = VERSION;

export function hasKey(): boolean {
  return !!process.env.TYPESAFE_API_KEY?.trim();
}

let client: TypeSafeClient | null = null;

function getClient(): TypeSafeClient {
  if (!client) {
    client = new TypeSafeClient({
      defaultModel: MODEL,
      // A decision older than ~1 s is useless to a moving car, so keep
      // attempts short and retry at most once (429/5xx/timeouts).
      timeout: 2500,
      retry: { maxRetries: 1, backoffInitialMs: 150, backoffMaxMs: 400, maxRetryAfterMs: 500 },
      logLevel: "warn",
    });
  }
  return client;
}

export interface JevResult {
  decisions: CarDecision[];
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  estimatedTokens: number;
  jevLatencyMs: number;
  requestId?: string;
}

export interface CallOptions {
  timeoutMs?: number;
  maxRetries?: number;
}

export async function callJev(req: DecisionRequest, opts: CallOptions = {}): Promise<JevResult> {
  const payload = buildJevPayload(req);
  const t0 = performance.now();
  const { data, requestId } = await getClient()
    .systemOne(
      {
        state: payload.state,
        // Our question objects follow the HTTP API shape the SDK types describe.
        questions: payload.questions as unknown as Questions,
        model: MODEL,
      },
      {
        ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
        ...(opts.maxRetries !== undefined ? { retry: { maxRetries: opts.maxRetries } } : {}),
      },
    )
    .withResponse();
  const jevLatencyMs = performance.now() - t0;
  const decisions = parseJevAnswers(
    req,
    data.answers as unknown as Parameters<typeof parseJevAnswers>[1],
    jevLatencyMs,
    data.model,
  );
  return {
    decisions,
    model: data.model,
    usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens },
    estimatedTokens: estimateTokens(payload),
    jevLatencyMs,
    requestId,
  };
}
