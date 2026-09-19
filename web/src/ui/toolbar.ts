// Event toolbar along the bottom (judgment events arrive in M4).

import type { App } from "../app.ts";
import type { Vec } from "../sim/geometry.ts";
import { el } from "./dom.ts";

export class Toolbar {
  constructor(
    private root: HTMLElement,
    private app: App,
  ) {}

  render() {
    this.root.innerHTML = "";
    this.root.append(
      el("div", { class: "hint", text: "Scroll to zoom · drag to pan · double-click to fit · click a car to inspect · Space pause · S step" }),
    );
    void this.app;
  }

  update() {}

  place(kind: string, at: Vec) {
    void kind;
    void at;
  }
}
