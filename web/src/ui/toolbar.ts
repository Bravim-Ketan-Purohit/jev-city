// Event toolbar along the bottom: pick an event, then click a location. In
// side-by-side mode the same event goes into both cities at the same place
// and moment.

import type { App } from "../app.ts";
import { EVENT_INFO, type EventKind } from "../sim/events.ts";
import type { Vec } from "../sim/geometry.ts";
import { layersOf } from "../sim/layers.ts";
import { el } from "./dom.ts";

const ORDER: EventKind[] = ["ball", "ambulance", "officer", "school", "distracted", "stalled", "signal_failure", "yellow", "flagger"];

const HINT: Record<EventKind, string> = {
  ball: "Click a street between intersections",
  ambulance: "Click a street: it drives the whole road",
  officer: "Click near A, C or D",
  school: "",
  distracted: "Click a street next to the sidewalk",
  stalled: "Click a lane between intersections",
  signal_failure: "",
  yellow: "Click near A, C or D while its light is green",
  flagger: "Click a lane between intersections",
};

const SHORT: Record<EventKind, string> = {
  ball: "Ball",
  ambulance: "Ambulance",
  officer: "Officer",
  school: "Dismissal",
  distracted: "Distracted ped",
  stalled: "Stalled car",
  signal_failure: "Signal fail",
  yellow: "Yellow dilemma",
  flagger: "Flagger",
};

// Small sign-shaped icons, 30x30.
const ICON: Record<EventKind, string> = {
  ball: `<svg viewBox="0 0 30 30"><circle cx="15" cy="15" r="9" fill="#F26B21" stroke="#1e2326" stroke-width="1.6"/><path d="M6.5 13 Q15 8 23.5 13" fill="none" stroke="#1e2326" stroke-width="1.4"/><path d="M8 19 Q15 23 22 19" fill="none" stroke="#1e2326" stroke-width="1.4"/></svg>`,
  ambulance: `<svg viewBox="0 0 30 30"><rect x="3" y="8" width="24" height="14" rx="3" fill="#fff" stroke="#1e2326" stroke-width="1.6"/><rect x="12.5" y="10.5" width="5" height="9" fill="#C8102E"/><rect x="10.5" y="12.5" width="9" height="5" fill="#C8102E"/><rect x="7" y="5" width="5" height="3" fill="#2E6BFF"/><rect x="18" y="5" width="5" height="3" fill="#FF2D3A"/></svg>`,
  officer: `<svg viewBox="0 0 30 30"><circle cx="15" cy="15" r="11" fill="#1F4E96" stroke="#1e2326" stroke-width="1.4"/><circle cx="15" cy="11" r="3" fill="#fff"/><path d="M9 22 Q15 14 21 22" fill="#fff"/><path d="M21 13 l4 -4" stroke="#FFD23F" stroke-width="2.4" stroke-linecap="round"/></svg>`,
  school: `<svg viewBox="0 0 30 30"><path d="M15 3 L26 12 L26 27 L4 27 L4 12 Z" fill="#C4E530" stroke="#1e2326" stroke-width="1.6"/><circle cx="11" cy="14" r="2.2" fill="#1e2326"/><circle cx="19" cy="15" r="2" fill="#1e2326"/><path d="M8 24 L11 17 L14 24 M16 24 L19 18 L22 24" stroke="#1e2326" stroke-width="1.6" fill="none"/></svg>`,
  distracted: `<svg viewBox="0 0 30 30"><path d="M15 2 L28 15 L15 28 L2 15 Z" fill="#FFD23F" stroke="#1e2326" stroke-width="1.6"/><circle cx="14" cy="9.5" r="2.2" fill="#1e2326"/><path d="M14 12 L14 19 L11 24 M14 19 L17 24 M14 14 L18 15" stroke="#1e2326" stroke-width="1.7" fill="none"/><rect x="17.5" y="12.5" width="3" height="4" rx="0.6" fill="#6FB7FF" stroke="#1e2326" stroke-width="0.8"/></svg>`,
  stalled: `<svg viewBox="0 0 30 30"><path d="M15 3 L28 26 L2 26 Z" fill="#E89A17" stroke="#1e2326" stroke-width="1.6"/><rect x="9" y="15" width="12" height="7" rx="2" fill="#1e2326"/><circle cx="11" cy="23" r="1.4" fill="#1e2326"/><circle cx="19" cy="23" r="1.4" fill="#1e2326"/></svg>`,
  signal_failure: `<svg viewBox="0 0 30 30"><rect x="9" y="2" width="12" height="26" rx="4" fill="#2A2D31" stroke="#1e2326"/><circle cx="15" cy="8.5" r="3.3" fill="#F0303C"/><circle cx="15" cy="15" r="3.3" fill="#3b3f44"/><circle cx="15" cy="21.5" r="3.3" fill="#3b3f44"/><path d="M4 26 L26 4" stroke="#C8102E" stroke-width="2.4"/></svg>`,
  yellow: `<svg viewBox="0 0 30 30"><rect x="9" y="2" width="12" height="26" rx="4" fill="#2A2D31" stroke="#1e2326"/><circle cx="15" cy="8.5" r="3.3" fill="#3b3f44"/><circle cx="15" cy="15" r="3.3" fill="#FFC53D"/><circle cx="15" cy="21.5" r="3.3" fill="#3b3f44"/></svg>`,
  flagger: `<svg viewBox="0 0 30 30"><path d="M15 2 L28 15 L15 28 L2 15 Z" fill="#F7941D" stroke="#1e2326" stroke-width="1.6"/><circle cx="13" cy="9.5" r="2.1" fill="#1e2326"/><path d="M13 12 L13 19 L10.5 24 M13 19 L15.5 24 M13 14 L18 11" stroke="#1e2326" stroke-width="1.7" fill="none"/><path d="M18 11 L18 7" stroke="#1e2326" stroke-width="1.2"/><rect x="16.5" y="4.5" width="4" height="3" fill="#C8102E"/></svg>`,
};

export class Toolbar {
  private buttons = new Map<EventKind, HTMLButtonElement>();
  private hint!: HTMLElement;

  constructor(
    private root: HTMLElement,
    private app: App,
  ) {}

  render() {
    this.root.innerHTML = "";
    this.buttons.clear();
    this.root.append(el("div", { class: "tb-label", text: "EVENTS" }));
    for (const k of ORDER) {
      const info = EVENT_INFO[k];
      const b = el("button", { class: "ev", title: `${info.label}: expected "${info.expected}"` }) as HTMLButtonElement;
      b.innerHTML = `${ICON[k]}<span>${SHORT[k]}<small>${info.positional ? "click map" : k === "signal_failure" ? "toggle D" : "at C"}</small></span>`;
      b.onclick = () => this.pick(k);
      this.buttons.set(k, b);
      this.root.append(b);
    }
    this.hint = el("div", { class: "hint" });
    this.root.append(this.hint);
    this.update();
  }

  private pick(k: EventKind) {
    const info = EVENT_INFO[k];
    if (!info.positional) {
      this.app.placing = null;
      this.inject(k, null);
    } else {
      this.app.placing = this.app.placing === k ? null : k;
    }
    this.update();
  }

  /** Inject into every pane at the same place and moment. */
  private inject(k: EventKind, at: Vec | null) {
    const msgs: string[] = [];
    let ok = true;
    for (const p of this.app.panes) {
      const L = layersOf(p.sim);
      if (!L) continue;
      const r = L.events.inject(k, at);
      ok &&= r.ok;
      msgs.push(this.app.panes.length > 1 ? `${p.short}: ${r.message}` : r.message);
    }
    this.app.flash(msgs.join("  ·  "), ok ? "" : "warn", 4200);
    return ok;
  }

  place(kind: string, at: Vec) {
    const ok = this.inject(kind as EventKind, at);
    if (ok) this.app.placing = null;
    this.update();
  }

  update() {
    const placing = this.app.placing as EventKind | null;
    for (const [k, b] of this.buttons) {
      b.classList.toggle("on", placing === k);
      const active = this.app.panes.some((p) => layersOf(p.sim)?.events.isActive(k));
      b.classList.toggle("active", active);
    }
    for (const p of this.app.panes) p.canvas.classList.toggle("placing", !!placing);
    if (this.hint) {
      this.hint.textContent = placing
        ? `${EVENT_INFO[placing].label}: ${HINT[placing]} · Esc to cancel`
        : "Scroll to zoom · drag to pan · double-click to fit · click a car to inspect";
    }
  }
}
