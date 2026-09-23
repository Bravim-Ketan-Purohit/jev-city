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

// Small links to the author, in the corner and out of the way.
const LINKS: { href: string; label: string; icon: string }[] = [
  {
    href: "https://x.com/BravimKP",
    label: "X",
    icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
  },
  {
    href: "https://www.linkedin.com/in/bravim-purohit/",
    label: "LinkedIn",
    icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.55V9h3.57zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z"/></svg>`,
  },
  {
    href: "https://github.com/Bravim-Ketan-Purohit",
    label: "GitHub",
    icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.4-5.25 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5z"/></svg>`,
  },
  {
    href: "https://bravimpurohit.website",
    label: "bravimpurohit.website",
    icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5a10.5 10.5 0 1 0 0 21 10.5 10.5 0 0 0 0-21zm7.1 6.9h-2.86a15.6 15.6 0 0 0-1.5-4.02A8.54 8.54 0 0 1 19.1 8.4zM12 3.6c.79 0 1.9 1.69 2.5 4.8h-5c.6-3.11 1.71-4.8 2.5-4.8zM3.6 12c0-.62.07-1.22.2-1.8h3.3a19 19 0 0 0 0 3.6h-3.3c-.13-.58-.2-1.18-.2-1.8zm.5 3.6h2.85c.33 1.5.83 2.85 1.5 4.02A8.54 8.54 0 0 1 4.1 15.6zm2.85-7.2H4.1a8.54 8.54 0 0 1 4.35-4.02 15.6 15.6 0 0 0-1.5 4.02zM12 20.4c-.79 0-1.9-1.69-2.5-4.8h5c-.6 3.11-1.71 4.8-2.5 4.8zm2.8-6.9H9.2a17 17 0 0 1 0-3h5.6a17 17 0 0 1 0 3zm.75 6.12c.67-1.17 1.17-2.52 1.5-4.02h2.85a8.54 8.54 0 0 1-4.35 4.02zm1.79-6.12a19 19 0 0 0 0-3.6h3.3a8.5 8.5 0 0 1 0 3.6z"/></svg>`,
  },
];

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
    const social = el("div", { class: "social" });
    for (const l of LINKS) {
      const a = el("a", { href: l.href, target: "_blank", rel: "noopener noreferrer me", title: l.label, "aria-label": l.label, html: l.icon });
      social.append(a);
    }
    this.root.append(this.hint, social);
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
      msgs.push(r.message);
    }
    this.app.flash(msgs, ok ? "" : "warn", 4200);
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
