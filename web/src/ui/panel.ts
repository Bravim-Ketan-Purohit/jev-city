// Right-hand panel: Inspector, Metrics and Log tabs.

import { ACTIONS, PRICE_PER_MTOK, toMph, type Action, type BrainName } from "@jev-city/shared";
import type { App, Pane } from "../app.ts";
import { VIOLATION_LABEL, type ViolationKind } from "../sim/metrics.ts";
import { BRAIN_COLOR, C } from "../render/theme.ts";
import { el, esc, fmtTime } from "./dom.ts";

type Tab = "inspector" | "metrics" | "log" | "results";

const ACTION_LABEL: Record<Action, string> = {
  proceed: "Proceed",
  slow_down: "Slow down",
  stop_at_line: "Stop at line",
  emergency_stop: "Emergency stop",
  yield: "Yield",
  pull_over: "Pull over",
  other: "Other",
};

const BRAIN_LABEL: Record<BrainName, string> = { rules: "Rules", "mock-jev": "Mock Jev", jev: "Jev" };
const SPEED_TICKS = ["Stopped", "Crawl ~5", "Below limit", "At limit"];
const HAZARD_TICKS = ["None", "Minor", "Significant", "Imminent"];

export class Panel {
  tab: Tab = "inspector";
  private body: HTMLElement;
  private tabs: Record<Tab, HTMLButtonElement>;
  private logFilter: "all" | "violations" | "decisions" | "events" = "all";
  private insp?: InspectorView;
  private lastLogKey = "";

  constructor(
    root: HTMLElement,
    private app: App,
  ) {
    const mk = (t: Tab, label: string) => {
      const b = el("button", { text: label });
      b.onclick = () => this.setTab(t);
      return b;
    };
    this.tabs = {
      inspector: mk("inspector", "INSPECTOR"),
      metrics: mk("metrics", "METRICS"),
      log: mk("log", "LOG"),
      results: mk("results", "RESULTS"),
    };
    this.body = el("div", { class: "tab-body" });
    root.append(el("div", { class: "tabs" }, [this.tabs.inspector, this.tabs.metrics, this.tabs.log, this.tabs.results]), this.body);
    this.setTab("inspector");
  }

  setTab(t: Tab) {
    this.tab = t;
    this.resultsShown = false;
    for (const [k, b] of Object.entries(this.tabs)) b.classList.toggle("on", k === t);
    this.body.innerHTML = "";
    this.insp = undefined;
    this.lastLogKey = "";
    this.update();
  }

  update() {
    if (this.tab === "inspector") this.updateInspector();
    else if (this.tab === "metrics") this.updateMetrics();
    else if (this.tab === "results") this.updateResults();
    else this.updateLog();
    // Violation badge on the log tab.
    const n = this.app.panes.reduce((s, p) => s + p.sim.metrics.violations.length, 0);
    this.tabs.log.innerHTML = `LOG${n ? `<span class="badge num">${n}</span>` : ""}`;
  }

  // ------------------------------------------------------------ inspector

  private updateInspector() {
    const sel = this.app.selectedCar();
    if (!sel) {
      if (this.insp || !this.body.firstChild) {
        this.insp = undefined;
        this.body.innerHTML = `<div class="empty"><span class="big">⌖</span>Click a car to inspect what it perceives<br/>and how its brain decided.</div>`;
      }
      return;
    }
    if (!this.insp || this.insp.carId !== sel.car.id) {
      this.body.innerHTML = "";
      this.insp = new InspectorView(this.body, sel.car.id);
    }
    this.insp.update(sel.pane, this.app);
  }

  // ------------------------------------------------------------ metrics

  private updateMetrics() {
    const panes = this.app.panes;
    const html: string[] = [];
    for (const pane of panes) {
      const sim = pane.sim;
      const m = sim.metrics;
      const now = sim.time;
      const elapsed = Math.max(1, now - m.startedAt);
      const tp = m.throughput(now);
      const total = Object.values(tp).reduce((a, b) => a + b, 0);
      const trips = m.trips;
      const avgTrip = trips.length ? trips.reduce((a, b) => a + b, 0) / trips.length : NaN;
      const cars = sim.cars.filter((c) => c.kind === "car").length;
      const head = panes.length > 1 ? `<div class="sec-h"><span>${esc(pane.title)}</span><span></span></div>` : "";
      const vio = (Object.keys(VIOLATION_LABEL) as ViolationKind[]).map((k) => {
        const n = m.count(k);
        return `<div class="counter ${n ? "bad" : ""}"><div class="v num">${n}</div><div class="k">${VIOLATION_LABEL[k]}</div></div>`;
      });
      const stale = Object.values(m.brains).reduce((s, b) => s + b.stale, 0);
      const low = Object.values(m.brains).reduce((s, b) => s + b.lowConf, 0);
      const apiErr = Object.values(m.brains).reduce((s, b) => s + b.apiErrors, 0);
      html.push(`<div class="sec">${head}
        <div class="sec-h"><span>Flow</span><span class="num">${fmtTime(elapsed)} measured</span></div>
        <div class="grid3">
          <div class="counter"><div class="v num">${cars}</div><div class="k">Cars on map</div></div>
          <div class="counter"><div class="v num">${total.toFixed(0)}</div><div class="k">Exits / min, all</div></div>
          <div class="counter"><div class="v num">${isNaN(avgTrip) ? "–" : avgTrip.toFixed(0) + "s"}</div><div class="k">Avg trip time</div></div>
        </div>
        <canvas class="spark" data-pane="${pane.index}"></canvas>
        <div class="grid3" style="grid-template-columns:repeat(4,1fr);margin-top:6px">
          ${["A", "B", "C", "D"].map((k) => `<div class="counter"><div class="v num">${tp[k].toFixed(0)}</div><div class="k">${k} exits/min</div></div>`).join("")}
        </div>
      </div>
      <div class="sec"><div class="sec-h"><span>Violations (ground truth)</span><span>detected geometrically</span></div>
        <div class="grid3">${vio.join("")}
          <div class="counter ${m.gridlocks.length ? "bad" : ""}"><div class="v num">${m.gridlocks.length}</div><div class="k">Gridlock</div></div>
        </div>
      </div>
      <div class="sec"><div class="sec-h"><span>Safety & fallbacks</span><span>${sim.opts.safety ? "reflex on" : "reflex off"}</span></div>
        <div class="grid3">
          <div class="counter ${m.interventions.length ? "warn" : ""}"><div class="v num">${m.interventions.length}</div><div class="k">Safety interventions</div></div>
          <div class="counter ${stale ? "warn" : ""}"><div class="v num">${stale}</div><div class="k">Stale decisions</div></div>
          <div class="counter ${low ? "warn" : ""}"><div class="v num">${low}</div><div class="k">Low-confidence</div></div>
          <div class="counter ${apiErr ? "bad" : ""}"><div class="v num">${apiErr}</div><div class="k">API errors</div></div>
          <div class="counter"><div class="v num">${m.throttled}</div><div class="k">Throttled ticks</div></div>
          <div class="counter"><div class="v num">${this.app.bucket.perSecond}</div><div class="k">Requests / s (cap ${sim.opts.decision.maxRequestsPerSecond})</div></div>
        </div>
      </div>
      <div class="sec"><div class="sec-h"><span>Per brain</span><span>latency is round trip</span></div>
        <table class="brains"><thead><tr><th>Brain</th><th>Dec.</th><th>p50</th><th>p95</th><th>Stale</th><th>Low</th><th>Safety</th><th>Viol.</th></tr></thead><tbody>
        ${(Object.keys(m.brains) as BrainName[])
          .filter((b) => m.brains[b].requests > 0)
          .map((b) => {
            const s = m.brains[b];
            const l = m.latency(b);
            const f = (x: number) => (isNaN(x) ? "–" : `${x.toFixed(0)}`);
            return `<tr><td><span class="dot" style="background:${BRAIN_COLOR[b]}"></span>${BRAIN_LABEL[b]}</td><td class="num">${s.decisions}</td><td class="num">${f(l.p50)}</td><td class="num">${f(l.p95)}</td><td class="num">${s.stale}</td><td class="num">${s.lowConf}</td><td class="num">${s.interventions}</td><td class="num">${s.violations}</td></tr>`;
          })
          .join("")}
        </tbody></table>
      </div>
      <div class="sec"><div class="sec-h"><span>Requests, tokens, cost</span><span>$${PRICE_PER_MTOK}/M input tokens</span></div>
        ${this.costTable(pane)}
      </div>
      ${this.eventResults(pane)}`);
    }
    this.body.innerHTML = html.join('<div style="height:18px"></div>');
    for (const cv of this.body.querySelectorAll<HTMLCanvasElement>("canvas.spark")) {
      const pane = panes[Number(cv.dataset.pane)];
      if (pane) drawSpark(cv, pane.sim.metrics.sparkline(pane.sim.time));
    }
  }

  private costTable(pane: Pane): string {
    const m = pane.sim.metrics;
    const rows = (Object.keys(m.brains) as BrainName[])
      .filter((b) => b !== "rules" && m.brains[b].requests > 0)
      .map((b) => {
        const s = m.brains[b];
        const cost = (s.inputTokens / 1e6) * PRICE_PER_MTOK;
        const hours = Math.max(1 / 3600, (pane.sim.time - m.startedAt) / 3600);
        const models = [...s.models].join(", ") || "–";
        return `<div class="kv" style="margin-bottom:8px">
          <div><div class="k">${BRAIN_LABEL[b]} requests</div><div class="v num">${s.requests.toLocaleString()}</div></div>
          <div><div class="k">Input tokens${s.tokensEstimated ? " (est.)" : ""}</div><div class="v num">${s.inputTokens.toLocaleString()}</div></div>
          <div><div class="k">Cost so far</div><div class="v num">$${cost.toFixed(4)}</div></div>
          <div><div class="k">Per sim hour</div><div class="v num">$${(cost / hours).toFixed(2)}</div></div>
        </div><div style="font-size:11px;color:${C.ink2};font-weight:700;margin:-2px 0 6px">Model: <span style="font-family:var(--mono)">${esc(models)}</span></div>`;
      });
    return rows.join("") || `<div style="font-size:12px;color:${C.ink3};font-weight:700">Rules make no API calls. Switch to Mock or Jev to see request, token and cost totals.</div>`;
  }

  private eventResults(pane: Pane): string {
    const res = pane.sim.metrics.eventResults;
    if (!res.length) return "";
    const by = new Map<string, { ok: number; n: number }>();
    for (const r of res) {
      const k = `${r.kind}|${r.brain}`;
      const e = by.get(k) ?? { ok: 0, n: 0 };
      e.n++;
      if (r.ok) e.ok++;
      by.set(k, e);
    }
    const rows = [...by.entries()]
      .map(([k, v]) => {
        const [kind, brain] = k.split("|");
        return `<tr><td>${esc(kind)}</td><td><span class="dot" style="background:${BRAIN_COLOR[brain]}"></span>${BRAIN_LABEL[brain as BrainName]}</td><td class="num">${v.ok}/${v.n}</td><td class="num" style="color:${v.ok === v.n ? C.green : C.stop}">${Math.round((100 * v.ok) / v.n)}%</td></tr>`;
      })
      .join("");
    return `<div class="sec"><div class="sec-h"><span>Event response</span><span>expected behavior shown</span></div>
      <table class="brains"><thead><tr><th>Event</th><th style="text-align:left">Brain</th><th>OK</th><th>Rate</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // ------------------------------------------------------------ results

  private results: BenchResults | { error: string } | null = null;
  private resultsShown = false;

  private updateResults() {
    if (this.resultsShown) return;
    this.resultsShown = true;
    this.body.innerHTML = `<div class="empty">Loading benchmark results…</div>`;
    fetch("/api/bench", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        this.results = j;
        if (this.tab === "results") this.renderResults();
      })
      .catch(() => {
        this.results = { error: "The server is not running. Start it with pnpm dev." };
        if (this.tab === "results") this.renderResults();
      });
  }

  private renderResults() {
    const r = this.results;
    if (!r || "error" in r) {
      this.body.innerHTML = `<div class="empty"><span class="big">▦</span>${esc((r as { error?: string })?.error ?? "No results.")}</div>`;
      return;
    }
    const lbl: Record<string, string> = { rules: "Rules", "mock-jev": "Mock Jev", jev: "Jev" };
    const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : "–");
    const bar = (x: number, color: string) =>
      `<div class="bar" style="height:10px"><i style="width:${Math.max(0, Math.min(1, x)) * 100}%;background:${color}"></i></div>`;
    const cats = ["rule", "judgment", "ambiguous"] as const;
    const brains = r.summaries;
    const head = `<div class="review-note">Draft labels: the scenario labels need human review before these numbers are published.</div>
      <div class="sec-h"><span>Benchmark · ${r.scenarioCount} scenarios × ${r.runs} runs</span><span class="num">${esc(r.model)} · ${esc(r.generatedAt.slice(0, 10))}</span></div>`;
    const cards = brains
      .map(
        (b) => `<div class="res-card">
          <div class="res-top"><span class="dot" style="background:${BRAIN_COLOR[b.brain]}"></span><b>${lbl[b.brain]}</b><span class="res-acc num">${pct(b.accuracy)}</span></div>
          <div class="res-sub num">exact ${pct(b.strictAccuracy)} · must_stop Brier ${b.brierMustStop.toFixed(3)} · runs agree ${pct(b.consistency.allRunsAgree)}</div>
          <div class="res-sub num">p50 ${b.brain === "rules" ? "<1" : b.latency.p50.toFixed(0)} ms · p95 ${b.brain === "rules" ? "<1" : b.latency.p95.toFixed(0)} ms${b.brain === "rules" ? "" : ` · ${Math.round(b.tokens.perRequest)} tok/req · $${b.costUsd.toFixed(4)}`}</div>
        </div>`,
      )
      .join("");
    const catRows = cats
      .map(
        (c) => `<div class="res-cat"><div class="res-cat-h">${c.toUpperCase()}</div>${brains
          .map((b) => `<div class="res-row"><span>${lbl[b.brain]}</span>${bar(b.byCategory[c].accuracy, BRAIN_COLOR[b.brain])}<span class="num">${pct(b.byCategory[c].accuracy)}</span></div>`)
          .join("")}</div>`,
      )
      .join("");
    const jev = brains.find((b) => b.brain === "jev") ?? brains.find((b) => b.brain === "mock-jev");
    const calib = jev
      ? `<div class="sec"><div class="sec-h"><span>Calibration · ${lbl[jev.brain]}</span><span>confidence vs accuracy</span></div>
        <table class="brains"><thead><tr><th>Confidence</th><th>n</th><th>Mean conf.</th><th>Accuracy</th><th style="width:38%"></th></tr></thead><tbody>
        ${jev.calibration
          .filter((c) => c.n)
          .map((c) => `<tr><td>${esc(c.bucket)}</td><td class="num">${c.n}</td><td class="num">${c.meanConfidence.toFixed(2)}</td><td class="num">${pct(c.accuracy)}</td><td>${bar(c.accuracy, BRAIN_COLOR[jev.brain])}</td></tr>`)
          .join("")}
        </tbody></table></div>`
      : "";
    this.body.innerHTML = `${head}<div class="sec">${cards}</div>
      <div class="sec"><div class="sec-h"><span>Accuracy by category</span><span>acceptable-set match</span></div>${catRows}</div>
      ${calib}
      <div class="sec" style="font-size:11.5px;color:${C.ink2};font-weight:600;line-height:1.5">Full tables, per-scenario disagreements and method notes: <code>bench/results.md</code>. Rerun with <code>pnpm bench</code>.</div>`;
  }

  // ------------------------------------------------------------ log

  private updateLog() {
    const panes = this.app.panes;
    type Row = { t: number; html: string; sev: string };
    const rows: Row[] = [];
    const tag = (p: Pane) => (panes.length > 1 ? `<b>${esc(p.short)}</b> · ` : "");
    for (const p of panes) {
      if (this.logFilter !== "decisions") {
        for (const e of p.sim.log) {
          if (this.logFilter === "violations" && e.kind !== "violation" && e.kind !== "gridlock") continue;
          if (this.logFilter === "events" && e.kind !== "event" && e.kind !== "intervention" && e.kind !== "fallback") continue;
          rows.push({ t: e.t, html: `${tag(p)}${esc(e.text)}`, sev: e.severity ?? "info" });
        }
      }
      if (this.logFilter === "all" || this.logFilter === "decisions") {
        const recent = p.scheduler.recent.slice(this.logFilter === "all" ? -12 : -150);
        for (const r of recent) {
          const d = r.d;
          const lat = d.latencyMs ? ` · ${d.latencyMs.toFixed(0)} ms` : "";
          rows.push({
            t: r.t,
            html: `<span class="dec">${tag(p)}car ${r.carId} <span style="color:${BRAIN_COLOR[r.brain]};font-weight:800">${BRAIN_LABEL[r.brain]}</span> ${esc(r.zone)} → <b>${d.action}</b> ${(d.actionConfidence * 100).toFixed(0)}% · spd ${d.speedLevel.toFixed(1)} · hz ${d.hazardLevel.toFixed(1)}${lat}</span>`,
            sev: "",
          });
        }
      }
    }
    // Newest first; at equal times, violations and events before decisions.
    const rank = (r: Row) => (r.sev === "bad" ? 0 : r.sev === "warn" ? 1 : r.sev ? 2 : 3);
    rows.sort((a, b) => b.t - a.t || rank(a) - rank(b));
    const key = `${this.logFilter}|${rows.length}|${rows[0]?.t ?? 0}`;
    if (key === this.lastLogKey) return;
    this.lastLogKey = key;
    const filters = (["all", "violations", "decisions", "events"] as const)
      .map((f) => `<button data-f="${f}" class="${f === this.logFilter ? "on" : ""}">${f.toUpperCase()}</button>`)
      .join("");
    this.body.innerHTML = `<div class="filters">${filters}<button data-export="1" style="margin-left:auto">EXPORT JSONL</button></div><div class="log">${rows
      .slice(0, 250)
      .map((r) => `<div class="row ${r.sev}"><div class="t num">${fmtTime(r.t)}</div><div class="x">${r.html}</div></div>`)
      .join("") || `<div class="empty">Nothing logged yet.</div>`}</div>`;
    for (const b of this.body.querySelectorAll<HTMLButtonElement>(".filters button")) {
      b.onclick = () => {
        if (b.dataset.export) return this.app.exportLog();
        this.logFilter = b.dataset.f as typeof this.logFilter;
        this.lastLogKey = "";
        this.updateLog();
      };
    }
  }
}

interface BenchSummary {
  brain: BrainName;
  accuracy: number;
  strictAccuracy: number;
  byCategory: Record<"rule" | "judgment" | "ambiguous", { n: number; accuracy: number; strict: number }>;
  brierMustStop: number;
  calibration: { bucket: string; n: number; meanConfidence: number; accuracy: number }[];
  latency: { p50: number; p95: number };
  tokens: { total: number; perRequest: number; estimated: boolean };
  costUsd: number;
  consistency: { allRunsAgree: number; scenarios: number };
}
interface BenchResults {
  generatedAt: string;
  model: string;
  runs: number;
  scenarioCount: number;
  summaries: BenchSummary[];
}

function drawSpark(cv: HTMLCanvasElement, data: number[]) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  cv.width = w * dpr;
  cv.height = h * dpr;
  const ctx = cv.getContext("2d")!;
  ctx.scale(dpr, dpr);
  const max = Math.max(4, ...data);
  const bw = w / data.length;
  for (let i = 0; i < data.length; i++) {
    const bh = ((h - 14) * data[i]) / max;
    ctx.fillStyle = i === data.length - 1 ? C.green : "#9fb7a8";
    ctx.fillRect(i * bw + 1, h - 12 - bh, bw - 2, bh);
  }
  ctx.fillStyle = C.ink3;
  ctx.font = `700 9px Overpass, sans-serif`;
  ctx.fillText("EXITS PER 10 S, LAST 3 MIN", 0, h - 1);
}

// ------------------------------------------------------------------ inspector view

class InspectorView {
  readonly carId: number;
  private head: HTMLElement;
  private text: HTMLElement;
  private scene: HTMLElement;
  private bars: Record<Action, { lbl: HTMLElement; bar: HTMLElement; val: HTMLElement }>;
  private speedMark: HTMLElement;
  private hazMark: HTMLElement;
  private kv: HTMLElement;
  private barsHead: HTMLElement;

  constructor(root: HTMLElement, carId: number) {
    this.carId = carId;
    this.head = el("div", { class: "car-head" });
    this.text = el("div", { class: "perception" });
    this.scene = el("div", { class: "perception scene" });
    const barsWrap = el("div", { class: "bars" });
    this.bars = {} as InspectorView["bars"];
    for (const a of ACTIONS) {
      const lbl = el("div", { class: "lbl", text: ACTION_LABEL[a] });
      const i = el("i");
      const bar = el("div", { class: "bar" }, [i]);
      const val = el("div", { class: "val num" });
      barsWrap.append(lbl, bar, val);
      this.bars[a] = { lbl, bar: i, val };
    }
    const mkScale = (ticks: string[], cls: string) => {
      const mark = el("div", { class: "mark" });
      const s = el("div", { class: "scale" }, [
        el("div", { class: `track ${cls}` }, [mark]),
        el("div", { class: "ticks" }, ticks.map((t) => el("span", { text: t }))),
      ]);
      return { s, mark };
    };
    const sp = mkScale(SPEED_TICKS, "");
    const hz = mkScale(HAZARD_TICKS, "hazard");
    this.speedMark = sp.mark;
    this.hazMark = hz.mark;
    this.kv = el("div", { class: "kv" });
    this.barsHead = el("div", { class: "sec-h" });
    root.append(
      el("div", { class: "sec" }, [this.head]),
      el("div", { class: "sec" }, [el("div", { class: "sec-h", html: "<span>Perception sent to the brain</span><span>code-computed facts</span>" }), this.text]),
      el("div", { class: "sec" }, [this.barsHead, barsWrap]),
      el("div", { class: "sec" }, [el("div", { class: "sec-h", html: "<span>Speed level</span><span>score 0–3</span>" }), sp.s]),
      el("div", { class: "sec" }, [el("div", { class: "sec-h", html: "<span>Hazard level</span><span>score 0–3</span>" }), hz.s]),
      el("div", { class: "sec" }, [this.kv]),
      el("div", { class: "sec" }, [el("div", { class: "sec-h", html: "<span>Zone scene</span><span>shared context</span>" }), this.scene]),
    );
  }

  update(pane: Pane, app: App) {
    const c = pane.sim.carById(this.carId);
    if (!c) {
      this.head.innerHTML = `<div class="empty">Car ${this.carId} has left the map.</div>`;
      return;
    }
    const d = c.decision;
    const sim = pane.sim;
    const fb = c.fallback;
    const state = fb
      ? `<span class="chip warn">Cautious · ${fb === "stale" ? "stale" : fb === "low_conf" ? "low conf" : fb === "api_error" ? "API error" : "other"}</span>`
      : c.reflex
        ? `<span class="chip warn">Safety reflex</span>`
        : d
          ? `<span class="chip ${d.action === "proceed" ? "ok" : d.action === "emergency_stop" ? "bad" : "blue"}">${ACTION_LABEL[d.action]}</span>`
          : `<span class="chip">Cruising</span>`;
    const zone = c.zoneId ? (c.zoneId.startsWith("seg:") ? c.zoneId.slice(4) : `Intersection ${c.zoneId}`) : "open road";
    this.head.innerHTML = `<div class="car-badge ${c.brain}">${c.label}</div>
      <div class="car-meta"><div class="l1">${BRAIN_LABEL[c.brain].toUpperCase()} · ${Math.round(toMph(c.v))} MPH</div><div class="l2">${esc(zone)}${pane.title && app.panes.length > 1 ? " · " + esc(pane.short) : ""}</div></div>${state}`;
    this.text.textContent = c.perception?.text ?? "Waiting for the first perception (the car asks for decisions within 80 m of an intersection or near an event).";
    this.scene.textContent = c.zoneId ? pane.scheduler.lastScene.get(c.zoneId) ?? "–" : "Not in a decision zone.";
    const top = d?.action;
    this.barsHead.innerHTML = `<span>Action probabilities</span><span class="num">confidence ${d ? (d.actionConfidence * 100).toFixed(0) + "%" : "–"}</span>`;
    for (const a of ACTIONS) {
      const p = d ? d.actionProbs[a] ?? 0 : 0;
      const b = this.bars[a];
      b.bar.style.width = `${(p * 100).toFixed(1)}%`;
      b.bar.className = a === top ? `top ${c.brain}` : "";
      b.lbl.className = a === top ? "lbl top" : "lbl";
      b.val.textContent = d ? `${(p * 100).toFixed(0)}%` : "–";
    }
    this.speedMark.style.left = `${((d?.speedLevel ?? 3) / 3) * 100}%`;
    this.hazMark.style.left = `${((d?.hazardLevel ?? 0) / 3) * 100}%`;
    const age = d ? sim.time - d.issuedAt : NaN;
    const expiry = sim.opts.decision.decisionExpiryS;
    const cls = (x: number, warn: number, bad: number) => (x >= bad ? "bad" : x >= warn ? "warn" : "ok");
    this.kv.innerHTML = `
      <div><div class="k">Latency</div><div class="v num">${d ? d.latencyMs.toFixed(0) : "–"}<small> ms</small></div></div>
      <div><div class="k">Decision age</div><div class="v num ${d ? cls(age, expiry * 0.7, expiry) : ""}">${d ? age.toFixed(2) : "–"}<small> s / ${expiry.toFixed(1)}</small></div></div>
      <div><div class="k">Must stop (noul)</div><div class="v num">${d ? (d.mustStopProb * 100).toFixed(0) + "%" : "–"}</div></div>
      <div><div class="k">Right of way (noul)</div><div class="v num">${d?.rightOfWayProb !== undefined ? (d.rightOfWayProb * 100).toFixed(0) + "%" : "<small>n/a</small>"}</div></div>
      <div style="grid-column: span 2"><div class="k">Model</div><div class="v" style="font-family:var(--mono);font-size:13px">${esc(d?.model ?? "–")}</div></div>`;
  }
}
