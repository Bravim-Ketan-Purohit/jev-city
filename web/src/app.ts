// App shell: top bar, one or two simulation panes, the side panel and the
// event toolbar, driven by a fixed-step loop (30 Hz physics, 60 fps render).

import {
  MockJevBrain,
  PRICE_PER_MTOK,
  RuleBrain,
  type Brain,
  type BrainName,
} from "@jev-city/shared";
import { JevBrain, checkJevHealth, type JevHealth } from "./brains/jev.ts";
import { CityRenderer } from "./render/renderer.ts";
import { installOverlays } from "./render/overlays.ts";
import type { Car } from "./sim/car.ts";
import { DecisionScheduler, TokenBucket } from "./sim/decisions.ts";
import { installLayers } from "./sim/layers.ts";
import { DT, Simulation, type BrainMode } from "./sim/sim.ts";
import { el } from "./ui/dom.ts";
import { Panel } from "./ui/panel.ts";
import { Toolbar } from "./ui/toolbar.ts";

export interface Pane {
  index: number;
  sim: Simulation;
  renderer: CityRenderer;
  scheduler: DecisionScheduler;
  wrap: HTMLElement;
  canvas: HTMLCanvasElement;
  tag: HTMLElement;
  stats: HTMLElement;
  banner: HTMLElement;
  title: string;
  short: string;
  mode: BrainMode;
}

export interface Settings {
  seed: number;
  brainMode: BrainMode;
  batching: "per-zone" | "per-car";
  safety: boolean;
  speed: number;
  paused: boolean;
  view: "live" | "sbs";
  carCount: number;
  warmup: number;
}

const BRAIN_TITLE: Record<BrainMode, string> = {
  rules: "RULES",
  "mock-jev": "MOCK JEV",
  jev: "JEV",
  mixed: "MIXED",
};

function readUrl(): Partial<Settings> {
  const q = new URLSearchParams(location.search);
  const out: Partial<Settings> = {};
  if (q.has("seed")) out.seed = Number(q.get("seed"));
  if (q.has("brain")) out.brainMode = q.get("brain") as BrainMode;
  if (q.has("cars")) out.carCount = Number(q.get("cars"));
  if (q.get("view") === "sbs") out.view = "sbs";
  if (q.has("speed")) out.speed = Number(q.get("speed"));
  return out;
}

export class App {
  panes: Pane[] = [];
  bucket = new TokenBucket(15, 15);
  brains: Record<BrainName, Brain>;
  settings: Settings = {
    seed: 1234,
    brainMode: "mock-jev",
    batching: "per-zone",
    safety: true,
    speed: 1,
    paused: false,
    view: "live",
    carCount: 30,
    warmup: 25,
    ...readUrl(),
  };
  selected: { pane: number; carId: number } | null = null;
  health: JevHealth = { ok: false, hasKey: false };
  reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  placing: string | null = null;

  private root: HTMLElement;
  private stage!: HTMLElement;
  private main!: HTMLElement;
  panel!: Panel;
  toolbar!: Toolbar;
  private top: Record<string, HTMLElement> = {};
  private acc = 0;
  private last = 0;
  private uiTick = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    this.brains = {
      rules: new RuleBrain(),
      "mock-jev": new MockJevBrain({ seed: this.settings.seed }),
      jev: new JevBrain(),
    };
    this.build();
    this.rebuildPanes();
    void this.refreshHealth();
    addEventListener("resize", () => this.resize());
    addEventListener("keydown", (e) => this.onKey(e));
    this.schedule();
  }

  /** rAF normally; `?timer=1` drives frames with a timer (headless browser testing). */
  private readonly timerLoop = new URLSearchParams(location.search).has("timer");
  private schedule() {
    if (this.timerLoop) setTimeout(() => this.frame(performance.now()), 16);
    else requestAnimationFrame((t) => this.frame(t));
  }

  // ------------------------------------------------------------------ health

  async refreshHealth() {
    this.health = await checkJevHealth();
    // Panes built before the health check may need Jev swapped in.
    if (this.health.ok && this.settings.view === "sbs" && this.panes[1]?.mode !== "jev") this.rebuildPanes();
    for (const p of this.panes) {
      p.sim.opts.mixedJevBrain = this.health.ok ? "jev" : "mock-jev";
      if (p.mode === "mixed") p.sim.setBrainMode("mixed");
    }
    this.renderTopbar();
    if (!this.health.ok && (this.settings.brainMode === "jev" || this.settings.view === "sbs")) {
      this.flash("Jev is unavailable: start the server with TYPESAFE_API_KEY in .env. Cars fall back to cautious mode.", "warn", 6000);
    }
  }

  // ------------------------------------------------------------------ DOM

  private build() {
    const topbar = el("header", { class: "topbar" });
    this.main = el("div", { class: "main" });
    this.stage = el("section", { class: "stage" });
    const panelRoot = el("aside", { class: "panel" });
    this.main.append(this.stage, panelRoot);
    const tb = el("footer", { class: "toolbar" });
    this.root.append(topbar, this.main, tb);
    this.top.root = topbar;
    this.panel = new Panel(panelRoot, this);
    this.toolbar = new Toolbar(tb, this);
    this.renderTopbar();
  }

  private seg<T extends string>(
    options: { v: T; label: string; tone?: string; disabled?: boolean; title?: string }[],
    current: T,
    onPick: (v: T) => void,
  ): HTMLElement {
    const wrap = el("div", { class: "seg" });
    for (const o of options) {
      const b = el("button", { text: o.label, "data-tone": o.tone, disabled: o.disabled, title: o.title });
      if (o.v === current) b.classList.add("on");
      b.onclick = () => onPick(o.v);
      wrap.append(b);
    }
    return wrap;
  }

  renderTopbar() {
    const s = this.settings;
    const t = this.top.root;
    t.innerHTML = "";
    const brand = el("div", { class: "brand" }, [
      el("div", { class: "brand-sign" }, [el("span", { text: "JEV CITY" })]),
      el("div", { class: "brand-sub", html: "Traffic judgment<br/>simulator" }),
    ]);
    const jevTitle = this.health.ok ? `Jev (${this.health.model})` : "Needs the server and TYPESAFE_API_KEY";
    const sbsBrains = el("div", { class: "field" }, [
      el("label", { text: "Side by side" }),
      el("div", { class: "seg" }, [
        el("button", { class: "on", "data-tone": "blue", text: "Left: Rules" }),
        el("button", { class: "on", "data-tone": this.health.ok ? "green" : "green2", text: this.health.ok ? "Right: Jev" : "Right: Mock" }),
      ]),
    ]);
    const brain = s.view === "sbs" ? sbsBrains : el("div", { class: "field" }, [
      el("label", { text: "Brain" }),
      this.seg<BrainMode>(
        [
          { v: "rules", label: "Rules", tone: "blue" },
          { v: "mock-jev", label: "Mock", tone: "green2" },
          { v: "jev", label: this.health.ok ? "Jev" : "Jev ⚠", tone: "green", title: jevTitle },
          { v: "mixed", label: "Mixed", tone: "mixed", title: "Half rules, half Jev (Mock if no key)" },
        ],
        s.brainMode,
        (v) => this.setBrain(v),
      ),
    ]);
    const batch = el("div", { class: "field" }, [
      el("label", { text: "Batching" }),
      this.seg(
        [
          { v: "per-zone", label: "Per zone" },
          { v: "per-car", label: "Per car" },
        ],
        s.batching,
        (v) => {
          s.batching = v;
          for (const p of this.panes) p.sim.opts.decision.batching = v;
          this.renderTopbar();
        },
      ),
    ]);
    const safety = el("button", { class: `toggle ${s.safety ? "" : "off"}`, text: s.safety ? "ON" : "OFF", title: "Code-owned safety reflex (TTC < 1.2 s, pedestrians)" });
    safety.onclick = () => {
      s.safety = !s.safety;
      for (const p of this.panes) p.sim.opts.safety = s.safety;
      this.renderTopbar();
      this.flash(s.safety ? "Safety reflex ON: interventions are logged against the brain" : "Safety reflex OFF: raw brain behavior, collisions are counted", s.safety ? "" : "bad");
    };
    const safetyF = el("div", { class: "field" }, [el("label", { text: "Safety" }), safety]);
    const pause = el("button", { class: "icon-btn", text: s.paused ? "▶ Play" : "❚❚ Pause", title: "Space" });
    pause.onclick = () => this.togglePause();
    const step = el("button", { class: "icon-btn", text: "Step", title: "Advance 1/3 s (S)" });
    step.onclick = () => this.stepOnce();
    const speed = this.seg(
      [
        { v: "1", label: "1×" },
        { v: "2", label: "2×" },
        { v: "4", label: "4×" },
      ],
      String(s.speed),
      (v) => this.setSpeed(Number(v)),
    );
    const time = el("div", { class: "field" }, [el("label", { text: "Time" }), el("div", { style: "display:flex;gap:5px" }, [pause, step, speed])]);
    this.top.clock = el("div", { class: "num", text: "--:--:--" });
    this.top.school = el("span", { class: "school-chip", text: "SCHOOL ZONE ACTIVE" });
    const clock = el("div", { class: "field" }, [
      el("div", { class: "clock-sign" }, [el("div", {}, [this.top.clock])]),
      this.top.school,
    ]);
    const seedIn = el("input", { value: String(s.seed), "aria-label": "Seed", inputmode: "numeric" }) as HTMLInputElement;
    const reset = el("button", { class: "icon-btn", text: "↻ Reset", title: "Restart with this seed" });
    reset.onclick = () => {
      const v = Number(seedIn.value);
      if (Number.isFinite(v)) s.seed = Math.floor(v);
      this.rebuildPanes();
    };
    seedIn.onkeydown = (e) => {
      if (e.key === "Enter") reset.click();
    };
    const seed = el("div", { class: "field" }, [el("label", { text: "Seed" }), el("div", { class: "seed" }, [seedIn, reset])]);
    this.top.cost = el("div", { class: "cost num", text: "$0.0000" });
    this.top.costSub = el("div", { class: "cost-sub num", text: "" });
    const cost = el("div", { class: "field" }, [el("label", { text: "Running cost" }), this.top.cost, this.top.costSub]);
    const view = el("div", { class: "field" }, [
      el("label", { text: "View" }),
      this.seg(
        [
          { v: "live", label: "Live" },
          { v: "sbs", label: "Side by side" },
        ],
        s.view,
        (v) => {
          s.view = v;
          this.rebuildPanes();
        },
      ),
    ]);
    t.append(brand, brain, batch, safetyF, time, clock, seed, cost, el("div", { class: "spacer" }), view);
  }

  private updateTopbarLive() {
    const sim = this.panes[0]?.sim;
    if (!sim) return;
    this.top.clock.textContent = sim.clockText();
    this.top.school.classList.toggle("on", sim.schoolActive);
    let tokens = 0;
    let reqs = 0;
    let est = false;
    let hours = 0;
    for (const p of this.panes) {
      for (const b of ["jev", "mock-jev"] as BrainName[]) {
        const st = p.sim.metrics.brains[b];
        tokens += st.inputTokens;
        reqs += st.requests;
        est ||= st.tokensEstimated;
      }
      hours = Math.max(hours, (p.sim.time - p.sim.metrics.startedAt) / 3600);
    }
    const cost = (tokens / 1e6) * PRICE_PER_MTOK;
    this.top.cost.textContent = `$${cost.toFixed(4)}`;
    const perHour = hours > 0.001 ? cost / hours : 0;
    this.top.costSub.textContent = `${reqs.toLocaleString()} req · ${(tokens / 1000).toFixed(1)}k tok${est ? " est" : ""} · $${perHour.toFixed(2)}/sim-hr`;
  }

  // ------------------------------------------------------------------ panes

  private paneModes(): BrainMode[] {
    if (this.settings.view === "sbs") return ["rules", this.health.ok ? "jev" : "mock-jev"];
    return [this.settings.brainMode];
  }

  rebuildPanes() {
    const s = this.settings;
    this.stage.innerHTML = "";
    this.panes = [];
    this.selected = null;
    this.main.classList.toggle("sbs", s.view === "sbs");
    this.stage.classList.toggle("two", s.view === "sbs");
    this.brains["mock-jev"] = new MockJevBrain({ seed: s.seed });
    const modes = this.paneModes();
    modes.forEach((mode, index) => {
      const sim = new Simulation({ seed: s.seed, carCount: s.carCount, safety: s.safety, brainMode: "rules", mixedJevBrain: this.health.ok ? "jev" : "mock-jev" });
      sim.opts.decision.batching = s.batching;
      installLayers(sim, { pedestrians: true });
      const scheduler = new DecisionScheduler(sim, this.brains, this.bucket);
      // Pre-roll with Rules so every pane starts from the same busy city.
      sim.warmup(s.warmup, () => {});
      sim.setBrainMode(mode);
      const canvas = el("canvas");
      const tag = el("div", { class: "pane-tag" });
      const stats = el("div", { class: "pane-stats" });
      const banner = el("div", { class: "banner" });
      const wrap = el("div", { class: "pane" }, [canvas, tag, banner]);
      this.stage.append(wrap);
      const renderer = new CityRenderer(canvas, sim);
      installOverlays(renderer);
      const title = BRAIN_TITLE[mode];
      const pane: Pane = { index, sim, renderer, scheduler, wrap, canvas, tag, stats, banner, title, short: title, mode };
      tag.append(el("div", { class: `plate ${mode}` }, [el("span", { text: title })]), stats);
      this.wireCanvas(pane);
      this.panes.push(pane);
    });
    this.resize();
    this.renderTopbar();
    this.toolbar.render();
    this.panel.update();
  }

  setBrain(mode: BrainMode) {
    this.settings.brainMode = mode;
    if (mode === "jev" && !this.health.ok) {
      this.flash("Jev is unavailable: the server is down or TYPESAFE_API_KEY is missing. Cars will fall back to cautious mode.", "warn", 6000);
    }
    if (this.settings.view === "live") {
      const p = this.panes[0];
      p.sim.opts.mixedJevBrain = this.health.ok ? "jev" : "mock-jev";
      p.sim.setBrainMode(mode);
      p.mode = mode;
      p.title = p.short = BRAIN_TITLE[mode];
      p.tag.querySelector(".plate")!.className = `plate ${mode}`;
      p.tag.querySelector(".plate span")!.textContent = p.title;
    }
    this.renderTopbar();
  }

  private resize() {
    for (const p of this.panes) p.renderer.resize();
  }

  // ------------------------------------------------------------------ input

  private wireCanvas(pane: Pane) {
    const cv = pane.canvas;
    let down: { x: number; y: number; moved: boolean } | null = null;
    cv.addEventListener("mousedown", (e) => {
      down = { x: e.offsetX, y: e.offsetY, moved: false };
    });
    cv.addEventListener("mousemove", (e) => {
      if (!down) return;
      const dx = e.offsetX - down.x;
      const dy = e.offsetY - down.y;
      if (!down.moved && Math.hypot(dx, dy) < 4) return;
      down.moved = true;
      for (const p of this.panes) p.renderer.pan(dx, dy);
      down.x = e.offsetX;
      down.y = e.offsetY;
    });
    addEventListener("mouseup", (e) => {
      if (!down) return;
      const d = down;
      down = null;
      if (d.moved || e.target !== cv) return;
      this.onClick(pane, e.offsetX, e.offsetY);
    });
    cv.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const f = Math.exp(-e.deltaY * 0.0015);
        for (const p of this.panes) p.renderer.zoomAt(e.offsetX, e.offsetY, f);
      },
      { passive: false },
    );
    cv.addEventListener("dblclick", () => {
      for (const p of this.panes) p.renderer.resetView();
    });
  }

  private onClick(pane: Pane, x: number, y: number) {
    if (this.placing) {
      const w = pane.renderer.toWorld(x, y);
      this.toolbar.place(this.placing, w);
      return;
    }
    const c = pane.renderer.pick(x, y);
    this.selected = c ? { pane: pane.index, carId: c.id } : null;
    if (c && this.panel.tab !== "inspector") this.panel.setTab("inspector");
    this.panel.update();
  }

  private onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if (e.key === " ") {
      e.preventDefault();
      this.togglePause();
    } else if (e.key === "s" || e.key === "S") this.stepOnce();
    else if (e.key === "1" || e.key === "2" || e.key === "4") this.setSpeed(Number(e.key)); else if (e.key === "Escape") {
      this.placing = null;
      this.selected = null;
      this.toolbar.render();
      this.panel.update();
    }
  }

  setSpeed(speed: number) {
    this.settings.speed = speed;
    this.renderTopbar();
    const remote = this.panes.some((p) => p.sim.cars.some((c) => c.brain !== "rules"));
    if (speed > 1 && remote) {
      this.flash(
        `At ${speed}× the model's real-time latency uses ${speed}× more of the 1 s decision lifetime: expect stale-decision fallbacks.`,
        "warn",
        5000,
      );
    }
  }

  togglePause() {
    this.settings.paused = !this.settings.paused;
    this.renderTopbar();
  }

  stepOnce() {
    this.settings.paused = true;
    for (let i = 0; i < 10; i++) for (const p of this.panes) p.sim.step(DT);
    this.renderTopbar();
  }

  selectedCar(): { pane: Pane; car: Car } | null {
    if (!this.selected) return null;
    const pane = this.panes[this.selected.pane];
    const car = pane?.sim.carById(this.selected.carId);
    return pane && car ? { pane, car } : null;
  }

  flash(text: string | string[], tone: "" | "warn" | "bad" = "", ms = 3500) {
    this.panes.forEach((p, i) => {
      const msg = Array.isArray(text) ? text[i] ?? text[0] : text;
      p.banner.textContent = msg;
      p.banner.className = `banner show ${tone}`;
      clearTimeout((p.banner as HTMLElement & { _t?: number })._t);
      (p.banner as HTMLElement & { _t?: number })._t = window.setTimeout(() => (p.banner.className = "banner"), ms);
    });
  }

  exportLog() {
    const lines: string[] = [];
    for (const p of this.panes) for (const r of p.sim.decisionLog) lines.push(JSON.stringify({ pane: p.short, seed: p.sim.opts.seed, ...r }));
    const blob = new Blob([lines.join("\n") + "\n"], { type: "application/x-ndjson" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `decisions-seed${this.settings.seed}-${Date.now()}.jsonl` });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** Debug/automation: advance the sim by `seconds` of sim time and redraw. */
  advance(seconds: number) {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) for (const p of this.panes) p.sim.step(DT);
    this.uiTick = 0;
    this.frame(performance.now(), true);
  }

  // ------------------------------------------------------------------ loop

  private frame(ts: number, once = false) {
    const dt = this.last ? Math.min(0.1, (ts - this.last) / 1000) : 0;
    this.last = ts;
    if (!this.settings.paused) this.acc += dt * this.settings.speed;
    let n = 0;
    while (this.acc >= DT && n < 16) {
      for (const p of this.panes) p.sim.step(DT);
      this.acc -= DT;
      n++;
    }
    if (n === 16) this.acc = 0;
    const alpha = this.settings.paused ? 1 : this.acc / DT;
    for (const p of this.panes) {
      if (this.settings.paused) p.scheduler.drain();
      const sel = this.selected && this.selected.pane === p.index ? this.selected.carId : null;
      p.renderer.render(alpha, {
        selectedId: sel,
        reducedMotion: this.reducedMotion,
        title: "JEV CITY · TRAFFIC PLAN",
        subtitle: `SEED ${p.sim.opts.seed}  ·  ${p.title}  ·  ${p.sim.clockText()}`,
        showTitleBlock: true,
        placing: this.placing,
      });
    }
    if (ts - this.uiTick > 120) {
      this.uiTick = ts;
      this.updateTopbarLive();
      this.updatePaneStats();
      this.panel.update();
      this.toolbar.update();
    }
    if (!once) this.schedule();
  }

  private updatePaneStats() {
    for (const p of this.panes) {
      const m = p.sim.metrics;
      const v = m.violations.length;
      const si = m.interventions.length;
      const fb = Object.values(m.brains).reduce((s, b) => s + b.stale + b.lowConf + b.apiErrors, 0);
      const tp = Object.values(m.throughput(p.sim.time)).reduce((a, b) => a + b, 0);
      const er = m.eventResults;
      const eok = er.filter((r) => r.ok).length;
      const events = er.length ? `<div class="${eok < er.length ? "warn" : ""}"><b class="num">${eok}/${er.length}</b>EVENTS OK</div>` : "";
      p.stats.innerHTML = `<div class="${v ? "bad" : ""}"><b class="num">${v}</b>VIOLATIONS</div><div class="${si ? "warn" : ""}"><b class="num">${si}</b>SAFETY</div><div class="${fb ? "warn" : ""}"><b class="num">${fb}</b>FALLBACKS</div>${events}<div><b class="num">${tp.toFixed(0)}</b>EXITS/MIN</div>`;
    }
  }
}
