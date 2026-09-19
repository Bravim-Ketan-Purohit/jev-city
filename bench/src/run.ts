// Headless benchmark: every scenario through each brain (one request per
// scenario, all questions), three runs each. Writes results.json and
// results.md next to scenarios.json.
//
//   pnpm bench                      # rules, mock-jev, and jev if a key is set
//   pnpm bench -- --brains rules,jev --runs 3 --limit 20

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MockJevBrain,
  PRICE_PER_MTOK,
  RuleBrain,
  buildJevPayload,
  estimateTokens,
  percentile,
  type Action,
  type BrainName,
  type CarDecision,
  type DecisionRequest,
  type Scenario,
  type ScenarioCategory,
  type ScenarioFile,
} from "@jev-city/shared";
import { MODEL, SDK_VERSION, callJev, hasKey } from "@jev-city/server/jev";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "..");

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const runs = Number(arg("runs", "3"));
/**
 * Batching experiment: with --pack N (Jev only), N scenarios share one
 * request, as cars in a zone do. Every scenario's own scene is folded into its
 * car text in both --pack 1 and --pack N, so the two differ only in batching.
 */
const pack = Number(arg("pack", "0"));
const limit = Number(arg("limit", "0"));
const requested = arg("brains", "rules,mock-jev,jev").split(",") as BrainName[];
const brains = requested.filter((b) => b !== "jev" || hasKey());
if (requested.includes("jev") && !hasKey()) console.warn("[bench] TYPESAFE_API_KEY not set: skipping the Jev run");

const file = JSON.parse(readFileSync(resolve(ROOT, "scenarios.json"), "utf8")) as ScenarioFile;
const scenarios = limit ? file.scenarios.slice(0, limit) : file.scenarios;

interface Rec {
  brain: BrainName;
  run: number;
  id: string;
  category: ScenarioCategory;
  expected: Action;
  acceptable: Action[];
  mustStopLabel: boolean;
  action: Action;
  confidence: number;
  probs: Record<Action, number>;
  mustStopProb: number;
  speedLevel: number;
  hazardLevel: number;
  rightOfWayProb?: number;
  latencyMs: number;
  inputTokens: number;
  tokensEstimated: boolean;
  model: string;
  ok: boolean;
  strict: boolean;
  error?: string;
}

function request(s: Scenario): DecisionRequest {
  return { zoneId: `bench:${s.id}`, sceneText: s.sceneText, cars: [s.perception], simTime: 0 };
}

// Sliding-window limiter shared by the Jev run: at most 15 requests per second.
const sent: number[] = [];
async function slot() {
  for (;;) {
    const now = Date.now();
    while (sent.length && sent[0] <= now - 1000) sent.shift();
    if (sent.length < 15) {
      sent.push(now);
      return;
    }
    await new Promise((r) => setTimeout(r, sent[0] + 1001 - now));
  }
}

type Runner = (s: Scenario) => Promise<{ d: CarDecision; latencyMs: number; inputTokens: number; estimated: boolean; model: string }>;

function runnerFor(b: BrainName, seed: number): Runner {
  if (b === "rules") {
    const rb = new RuleBrain();
    return async (s) => {
      const t0 = performance.now();
      const [d] = rb.decideSync(request(s));
      return { d, latencyMs: performance.now() - t0, inputTokens: 0, estimated: false, model: "rules" };
    };
  }
  if (b === "mock-jev") {
    const mb = new MockJevBrain({ seed, realDelay: false });
    return async (s) => {
      const r = await mb.decideWithMeta(request(s));
      return { d: r.decisions[0], latencyMs: r.meta.requestLatencyMs, inputTokens: r.meta.inputTokens, estimated: true, model: "mock-jev" };
    };
  }
  return async (s) => {
    await slot();
    const r = await callJev(request(s), { timeoutMs: 10000, maxRetries: 2 });
    return { d: r.decisions[0], latencyMs: r.jevLatencyMs, inputTokens: r.usage.inputTokens, estimated: false, model: r.model };
  };
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

const records: Rec[] = [];
const started = new Date();

if (pack > 0) {
  if (!hasKey()) throw new Error("--pack needs TYPESAFE_API_KEY");
  const packed = (chunk: Scenario[], offset: number): DecisionRequest => ({
    zoneId: `bench:pack${pack}`,
    sceneText: "Several separate road situations. Each car's entry describes its own intersection or road segment first, then the car.",
    cars: chunk.map((s, k) => {
      const id = String(100 + offset + k);
      const text = s.perception.text.replace(/^Car \d+\./, `Car ${id}.`);
      return { carId: id, facts: s.perception.facts, text: `${s.sceneText}\n${text}` };
    }),
    simTime: 0,
  });
  const chunks: { req: DecisionRequest; items: Scenario[] }[] = [];
  for (let i = 0; i < scenarios.length; i += pack) {
    const items = scenarios.slice(i, i + pack);
    chunks.push({ req: packed(items, i), items });
  }
  for (let run = 1; run <= runs; run++) {
    await pool(chunks, 8, async ({ req, items }) => {
      await slot();
      const r = await callJev(req, { timeoutMs: 15000, maxRetries: 2 });
      r.decisions.forEach((d, k) => {
        const s = items[k];
        records.push({
          brain: "jev", run, id: s.id, category: s.category, expected: s.expectedAction, acceptable: s.acceptableActions,
          mustStopLabel: s.expectedMustStop, action: d.action, confidence: d.actionConfidence, probs: d.actionProbs,
          mustStopProb: d.mustStopProb, speedLevel: d.speedLevel, hazardLevel: d.hazardLevel, rightOfWayProb: d.rightOfWayProb,
          latencyMs: r.jevLatencyMs, inputTokens: r.usage.inputTokens / items.length, tokensEstimated: false, model: r.model,
          ok: s.acceptableActions.includes(d.action), strict: d.action === s.expectedAction,
        });
      });
    });
    console.log(`[bench] jev --pack ${pack} run ${run}/${runs} done`);
  }
  const acc = (xs: Rec[]) => xs.filter((r) => r.ok).length / Math.max(1, xs.length);
  const cats = ["rule", "judgment", "ambiguous"] as const;
  const line = `pack ${pack}: accuracy ${(acc(records) * 100).toFixed(1)}% (${cats.map((c) => `${c} ${(acc(records.filter((r) => r.category === c)) * 100).toFixed(1)}%`).join(", ")}), exact ${((records.filter((r) => r.strict).length / records.length) * 100).toFixed(1)}%, mean confidence ${(records.reduce((a, r) => a + r.confidence, 0) / records.length).toFixed(3)}, p50 latency ${percentile(records.map((r) => r.latencyMs), 50).toFixed(0)} ms per request, ${Math.round(records.reduce((a, r) => a + r.inputTokens, 0) / records.length)} tokens per car`;
  writeFileSync(resolve(ROOT, `results-pack${pack}.json`), JSON.stringify({ pack, runs, generatedAt: started.toISOString(), summary: line, records }, null, 2) + "\n");
  console.log(`[bench] ${line}`);
  process.exit(0);
}

for (const b of brains) {
  for (let run = 1; run <= runs; run++) {
    const runner = runnerFor(b, 1000 + run);
    const t0 = Date.now();
    await pool(scenarios, b === "jev" ? 8 : 16, async (s) => {
      try {
        const r = await runner(s);
        const d = r.d;
        records.push({
          brain: b,
          run,
          id: s.id,
          category: s.category,
          expected: s.expectedAction,
          acceptable: s.acceptableActions,
          mustStopLabel: s.expectedMustStop,
          action: d.action,
          confidence: d.actionConfidence,
          probs: d.actionProbs,
          mustStopProb: d.mustStopProb,
          speedLevel: d.speedLevel,
          hazardLevel: d.hazardLevel,
          rightOfWayProb: d.rightOfWayProb,
          latencyMs: r.latencyMs,
          inputTokens: r.inputTokens,
          tokensEstimated: r.estimated,
          model: r.model,
          ok: s.acceptableActions.includes(d.action),
          strict: d.action === s.expectedAction,
        });
      } catch (e) {
        records.push({
          brain: b,
          run,
          id: s.id,
          category: s.category,
          expected: s.expectedAction,
          acceptable: s.acceptableActions,
          mustStopLabel: s.expectedMustStop,
          action: "other",
          confidence: 0,
          probs: {} as Record<Action, number>,
          mustStopProb: 0.5,
          speedLevel: 0,
          hazardLevel: 0,
          latencyMs: 0,
          inputTokens: 0,
          tokensEstimated: false,
          model: "error",
          ok: false,
          strict: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });
    console.log(`[bench] ${b} run ${run}/${runs}: ${scenarios.length} scenarios in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
}

// ------------------------------------------------------------------ aggregate

const CATS: ScenarioCategory[] = ["rule", "judgment", "ambiguous"];
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "–");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "–");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

interface Summary {
  brain: BrainName;
  n: number;
  errors: number;
  accuracy: number;
  strictAccuracy: number;
  byCategory: Record<ScenarioCategory, { n: number; accuracy: number; strict: number }>;
  brierMustStop: number;
  calibration: { bucket: string; n: number; meanConfidence: number; accuracy: number }[];
  latency: { p50: number; p95: number };
  tokens: { total: number; perRequest: number; estimated: boolean };
  costUsd: number;
  consistency: { allRunsAgree: number; scenarios: number };
  models: string[];
}

function summarize(b: BrainName): Summary {
  const rs = records.filter((r) => r.brain === b);
  const good = rs.filter((r) => !r.error);
  const byCategory = Object.fromEntries(
    CATS.map((c) => {
      const x = good.filter((r) => r.category === c);
      return [c, { n: x.length, accuracy: mean(x.map((r) => +r.ok)), strict: mean(x.map((r) => +r.strict)) }];
    }),
  ) as Summary["byCategory"];
  const buckets: [number, number, string][] = [
    [0, 0.5, "< 0.5"],
    [0.5, 0.6, "0.5–0.6"],
    [0.6, 0.7, "0.6–0.7"],
    [0.7, 0.8, "0.7–0.8"],
    [0.8, 0.9, "0.8–0.9"],
    [0.9, 1.0001, "0.9–1.0"],
  ];
  const calibration = buckets.map(([lo, hi, label]) => {
    const x = good.filter((r) => r.confidence >= lo && r.confidence < hi);
    return { bucket: label, n: x.length, meanConfidence: mean(x.map((r) => r.confidence)), accuracy: mean(x.map((r) => +r.ok)) };
  });
  const byScenario = new Map<string, Action[]>();
  for (const r of good) byScenario.set(r.id, [...(byScenario.get(r.id) ?? []), r.action]);
  const agree = [...byScenario.values()].filter((a) => a.length === runs && a.every((x) => x === a[0])).length;
  const tokens = good.reduce((s, r) => s + r.inputTokens, 0);
  return {
    brain: b,
    n: rs.length,
    errors: rs.length - good.length,
    accuracy: mean(good.map((r) => +r.ok)),
    strictAccuracy: mean(good.map((r) => +r.strict)),
    byCategory,
    brierMustStop: mean(good.map((r) => (r.mustStopProb - (r.mustStopLabel ? 1 : 0)) ** 2)),
    calibration,
    latency: { p50: percentile(good.map((r) => r.latencyMs), 50), p95: percentile(good.map((r) => r.latencyMs), 95) },
    tokens: { total: tokens, perRequest: good.length ? tokens / good.length : 0, estimated: good.some((r) => r.tokensEstimated) },
    costUsd: (tokens / 1e6) * PRICE_PER_MTOK,
    consistency: { allRunsAgree: byScenario.size ? agree / byScenario.size : NaN, scenarios: byScenario.size },
    models: [...new Set(good.map((r) => r.model))],
  };
}

const summaries = brains.map(summarize);
const jevTokensPerReq = summaries.find((s) => s.brain === "jev")?.tokens.perRequest;

// Scenario-level view: majority action per brain.
function majority(b: BrainName, id: string): Action | undefined {
  const acts = records.filter((r) => r.brain === b && r.id === id && !r.error).map((r) => r.action);
  if (!acts.length) return undefined;
  const c = new Map<Action, number>();
  for (const a of acts) c.set(a, (c.get(a) ?? 0) + 1);
  return [...c.entries()].sort((x, y) => y[1] - x[1])[0][0];
}

const out = {
  generatedAt: started.toISOString(),
  reviewStatus: file._review,
  model: MODEL,
  sdk: SDK_VERSION,
  runs,
  scenarioCount: scenarios.length,
  pricePerMTok: PRICE_PER_MTOK,
  summaries,
  records,
};
writeFileSync(resolve(ROOT, "results.json"), JSON.stringify(out, null, 2) + "\n");

// ------------------------------------------------------------------ markdown

const L: string[] = [];
const label: Record<BrainName, string> = { rules: "Rules", "mock-jev": "Mock Jev", jev: "Jev" };
L.push("# Jev City benchmark results", "");
L.push("> **Draft labels: needs human review.** Every expected action, acceptable set and must_stop label in `bench/scenarios.json` was drafted with the code. They are the ground truth for the numbers below, so review them by hand before publishing anything from this file.", "");
L.push(
  `Generated ${started.toISOString().replace("T", " ").slice(0, 16)} UTC · ${scenarios.length} scenarios (${CATS.map((c) => `${scenarios.filter((s) => s.category === c).length} ${c}`).join(", ")}) · ${runs} runs per brain · Jev model pinned to \`${MODEL}\` (SDK ${SDK_VERSION}) · $${PRICE_PER_MTOK} per million input tokens.`,
  "",
);
if (!brains.includes("jev")) L.push("_Jev was not run: set `TYPESAFE_API_KEY` in `.env` and rerun `pnpm bench`._", "");

L.push("## Summary", "");
L.push("| Brain | Accuracy (acceptable set) | Exact match | Rule | Judgment | Ambiguous | must_stop Brier | p50 latency | p95 latency | Runs agree | Tokens / request | Cost, all runs |");
L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const s of summaries) {
  L.push(
    `| ${label[s.brain]} | ${pct(s.accuracy)} | ${pct(s.strictAccuracy)} | ${pct(s.byCategory.rule.accuracy)} | ${pct(s.byCategory.judgment.accuracy)} | ${pct(s.byCategory.ambiguous.accuracy)} | ${f2(s.brierMustStop)} | ${s.latency.p50.toFixed(s.brain === "rules" ? 3 : 0)} ms | ${s.latency.p95.toFixed(s.brain === "rules" ? 3 : 0)} ms | ${pct(s.consistency.allRunsAgree)} | ${s.brain === "rules" ? "–" : `${Math.round(s.tokens.perRequest)}${s.tokens.estimated ? " (est.)" : ""}`} | ${s.brain === "rules" ? "–" : `$${s.costUsd.toFixed(4)}`} |`,
  );
}
L.push("");
L.push("Accuracy counts an answer as correct when the chosen action is in the scenario's acceptable set; exact match requires the single expected action. Mock Jev latency is sampled (70–500 ms) rather than waited for, and its tokens are a characters ÷ 4 estimate; Jev latency is measured around each API call and its tokens come from the response's `usage`.", "");
if (summaries.some((s) => s.errors)) L.push(`Errors: ${summaries.map((s) => `${label[s.brain]} ${s.errors}`).join(", ")} (counted as wrong).`, "");

L.push("## Accuracy by category", "");
L.push("| Category | Scenarios | " + summaries.map((s) => label[s.brain]).join(" | ") + " |");
L.push("| --- | --- | " + summaries.map(() => "---").join(" | ") + " |");
for (const c of CATS) {
  L.push(`| ${c} | ${scenarios.filter((s) => s.category === c).length} | ` + summaries.map((s) => `${pct(s.byCategory[c].accuracy)} (exact ${pct(s.byCategory[c].strict)})`).join(" | ") + " |");
}
L.push("");

L.push("## Calibration", "");
L.push("Action confidence bucketed against observed accuracy (acceptable set). A well-calibrated brain has accuracy close to its mean confidence in each bucket. Rules always report 1.0, so only the top bucket is populated for it.", "");
for (const s of summaries.filter((x) => x.brain !== "rules")) {
  L.push(`**${label[s.brain]}**`, "");
  L.push("| Confidence | Decisions | Mean confidence | Observed accuracy |", "| --- | --- | --- | --- |");
  for (const b of s.calibration) L.push(`| ${b.bucket} | ${b.n} | ${b.n ? f2(b.meanConfidence) : "–"} | ${b.n ? pct(b.accuracy) : "–"} |`);
  L.push("");
}

L.push("## must_stop", "");
L.push("Brier score of the `must_stop` probability against the label (0 is perfect, 0.25 is a coin flip at 0.5).", "");
L.push("| Brain | Brier | " + CATS.map((c) => `Brier, ${c}`).join(" | ") + " |", "| --- | --- | " + CATS.map(() => "---").join(" | ") + " |");
for (const s of summaries) {
  const cat = CATS.map((c) => {
    const x = records.filter((r) => r.brain === s.brain && r.category === c && !r.error);
    return f2(mean(x.map((r) => (r.mustStopProb - (r.mustStopLabel ? 1 : 0)) ** 2)));
  });
  L.push(`| ${label[s.brain]} | ${f2(s.brierMustStop)} | ${cat.join(" | ")} |`);
}
L.push("");

L.push("## Latency and cost", "");
L.push("| Brain | p50 | p95 | Requests | Input tokens | Cost | Model(s) |", "| --- | --- | --- | --- | --- | --- | --- |");
for (const s of summaries)
  L.push(`| ${label[s.brain]} | ${s.latency.p50.toFixed(s.brain === "rules" ? 3 : 0)} ms | ${s.latency.p95.toFixed(s.brain === "rules" ? 3 : 0)} ms | ${s.n} | ${s.tokens.total.toLocaleString()}${s.tokens.estimated ? " (est.)" : ""} | $${s.costUsd.toFixed(4)} | ${s.models.join(", ")} |`);
L.push("");
if (jevTokensPerReq) {
  L.push(
    `Benchmark requests carry one car and average ${Math.round(jevTokensPerReq)} input tokens. Live zone requests carry every car in the zone; the live Metrics panel reports measured tokens and cost per simulated hour.`,
    "",
  );
}

L.push("## Consistency across runs", "");
L.push(`Share of scenarios where all ${runs} runs chose the same action.`, "");
L.push("| Brain | All runs agree |", "| --- | --- |");
for (const s of summaries) L.push(`| ${label[s.brain]} | ${pct(s.consistency.allRunsAgree)} of ${s.consistency.scenarios} |`);
L.push("");

L.push("## Where the brains differ", "");
L.push("Majority action per brain for scenarios where at least one brain chose an action outside the acceptable set.", "");
L.push("| ID | Scenario | Expected (acceptable) | " + summaries.map((s) => label[s.brain]).join(" | ") + " |");
L.push("| --- | --- | --- | " + summaries.map(() => "---").join(" | ") + " |");
for (const s of scenarios) {
  const maj = summaries.map((x) => majority(x.brain, s.id));
  if (maj.every((a) => a && s.acceptableActions.includes(a))) continue;
  const cell = (a?: Action) => (a ? (s.acceptableActions.includes(a) ? a : `**${a}** ✗`) : "–");
  L.push(`| ${s.id} | ${s.title} | ${s.expectedAction} (${s.acceptableActions.join(", ")}) | ${maj.map(cell).join(" | ")} |`);
}
L.push("");
L.push("## Method", "");
L.push(
  "- Each scenario is one request: the zone scene plus the car's perception as state, and the car's questions (`action` Choice with an explicit `other`, `speed` and `hazard` Scores, `must_stop` Noul, and `right_of_way` Noul where it applies). The same question builders drive the live simulation.",
  "- The perception text is rendered from structured facts by the same serializer the live simulation uses; all distances, times, stopping feasibility and arrival order are computed in code and stated in words.",
  "- RuleBrain reads only the structured facts, never the free text, so judgment events that only appear in text (a ball that has already left the lane, a distracted pedestrian) are invisible to it by design.",
  "- Mock Jev wraps RuleBrain with noisy probabilities, 70–500 ms sampled latency and a 5% second-best pick; it is a plumbing check, not a model.",
  "- Caveat on fairness: the scenario labels and RuleBrain were drafted together. RuleBrain's `must_stop` logic implements the same label convention (see the top of `bench/src/build-scenarios.ts`), so its Brier score is low by construction, and its rule-category accuracy reflects shared assumptions. Independent label review is the main way to remove that bias.",
  "",
);
writeFileSync(resolve(ROOT, "results.md"), L.join("\n"));
console.log(`[bench] wrote results.json and results.md (${records.length} decisions)`);
for (const s of summaries)
  console.log(`  ${label[s.brain].padEnd(9)} acc ${pct(s.accuracy)} (rule ${pct(s.byCategory.rule.accuracy)}, judgment ${pct(s.byCategory.judgment.accuracy)}, ambiguous ${pct(s.byCategory.ambiguous.accuracy)}) brier ${f2(s.brierMustStop)} p50 ${s.latency.p50.toFixed(1)}ms agree ${pct(s.consistency.allRunsAgree)} cost $${s.costUsd.toFixed(4)}`);
