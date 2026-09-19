// Canvas 2D renderer in the style of a civil-engineering plan sheet.

import { toMph } from "@jev-city/shared";
import type { Car } from "../sim/car.ts";
import {
  ARM_DIR,
  BOX_HALF,
  CW_FAR,
  CW_NEAR,
  LANE_W,
  LX,
  LY,
  ROAD_HALF,
  SCHOOL_RADIUS,
  SIDEWALK,
  WORLD,
  type Arm,
  type Intersection,
  type Lane,
} from "../sim/city.ts";
import { add, right, scale, type Vec } from "../sim/geometry.ts";
import type { Simulation } from "../sim/sim.ts";
import { streamRng } from "@jev-city/shared";
import { BRAIN_COLOR, C, FONT } from "./theme.ts";

export interface View {
  cx: number;
  cy: number;
  scale: number; // px per meter
}

export interface RenderOptions {
  selectedId: number | null;
  reducedMotion: boolean;
  title: string;
  subtitle: string;
  showTitleBlock: boolean;
  placing?: string | null;
  hover?: Vec | null;
}

interface Building {
  x: number;
  y: number;
  w: number;
  h: number;
  hatch: boolean;
  label?: string;
}

const lerpA = (a: number, b: number, t: number) => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
};

export class CityRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  sim: Simulation;
  view: View;
  private fitScale = 1;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private bg?: HTMLCanvasElement;
  private bgKey = "";
  private buildings: Building[] = [];
  private trees: Vec[] = [];
  private parked: { p: Vec; h: number; color: string }[] = [];

  constructor(canvas: HTMLCanvasElement, sim: Simulation) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.sim = sim;
    this.view = { cx: (WORLD.x0 + WORLD.x1) / 2, cy: (WORLD.y0 + WORLD.y1) / 2, scale: 2.5 };
    this.layout();
  }

  // ------------------------------------------------------------------ view

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    const margin = 26;
    const fit = Math.min((this.w - margin * 2) / (WORLD.x1 - WORLD.x0), (this.h - margin * 2) / (WORLD.y1 - WORLD.y0));
    const wasFit = Math.abs(this.view.scale - this.fitScale) < 1e-6 || this.fitScale === 1;
    this.fitScale = fit;
    if (wasFit) this.resetView();
    this.bgKey = "";
  }

  resetView() {
    this.view = { cx: (WORLD.x0 + WORLD.x1) / 2, cy: (WORLD.y0 + WORLD.y1) / 2, scale: this.fitScale };
    this.bgKey = "";
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const before = this.toWorld(sx, sy);
    this.view.scale = Math.max(this.fitScale * 0.8, Math.min(this.fitScale * 6, this.view.scale * factor));
    const after = this.toWorld(sx, sy);
    this.view.cx += before.x - after.x;
    this.view.cy += before.y - after.y;
    this.bgKey = "";
  }

  pan(dx: number, dy: number) {
    this.view.cx -= dx / this.view.scale;
    this.view.cy -= dy / this.view.scale;
    this.bgKey = "";
  }

  toWorld(sx: number, sy: number): Vec {
    return { x: (sx - this.w / 2) / this.view.scale + this.view.cx, y: (sy - this.h / 2) / this.view.scale + this.view.cy };
  }

  toScreen(p: Vec): Vec {
    return { x: (p.x - this.view.cx) * this.view.scale + this.w / 2, y: (p.y - this.view.cy) * this.view.scale + this.h / 2 };
  }

  private applyWorld(ctx: CanvasRenderingContext2D) {
    const s = this.view.scale * this.dpr;
    ctx.setTransform(s, 0, 0, s, (this.w / 2 - this.view.cx * this.view.scale) * this.dpr, (this.h / 2 - this.view.cy * this.view.scale) * this.dpr);
  }

  /** Pixel size in world units (for hairlines). */
  private get px(): number {
    return 1 / this.view.scale;
  }

  // ------------------------------------------------------------------ static layout

  private layout() {
    const rng = streamRng(this.sim.opts.seed ^ 0x5eed, "decor");
    const edge = ROAD_HALF + SIDEWALK;
    const xs = [WORLD.x0 - 40, 0, LX, WORLD.x1 + 40];
    const ys = [WORLD.y0 - 40, 0, LY, WORLD.y1 + 40];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const bx0 = xs[i] + (i === 0 ? 0 : edge);
        const bx1 = xs[i + 1] - (i === 2 ? 0 : edge);
        const by0 = ys[j] + (j === 0 ? 0 : edge);
        const by1 = ys[j + 1] - (j === 2 ? 0 : edge);
        const isSchool = i === 0 && j === 2;
        const isPark = i === 1 && j === 1;
        if (isPark) {
          // Central park: trees along the paths.
          for (let k = 0; k < 70; k++) {
            this.trees.push({ x: rng.range(bx0 + 8, bx1 - 8), y: rng.range(by0 + 8, by1 - 8) });
          }
          continue;
        }
        if (isSchool) {
          this.buildings.push({ x: bx1 - 50, y: by0 + 5, w: 42, h: 22, hatch: true, label: "SCHOOL" });
          continue;
        }
        // Row houses facing the streets.
        const depth = 14;
        const place = (x0: number, x1: number, y: number, horiz: boolean) => {
          let x = x0;
          while (x < x1 - 10) {
            const w = rng.range(10, 18);
            if (x + w > x1) break;
            const d = rng.range(depth * 0.7, depth);
            if (horiz) this.buildings.push({ x, y: y < 0 ? y - d : y, w, h: d, hatch: rng.chance(0.35) });
            else this.buildings.push({ x: y < 0 ? y - d : y, y: x, w: d, h: w, hatch: rng.chance(0.35) });
            x += w + rng.range(3, 7);
          }
        };
        const inset = 5;
        // Top and bottom edges of the block.
        if (j > 0) place(bx0 + inset, bx1 - inset, by0 + inset, true);
        if (j < 2) {
          const yy = by1 - inset;
          let x = bx0 + inset;
          while (x < bx1 - inset - 10) {
            const w = rng.range(10, 18);
            if (x + w > bx1 - inset) break;
            const d = rng.range(depth * 0.7, depth);
            this.buildings.push({ x, y: yy - d, w, h: d, hatch: rng.chance(0.35) });
            x += w + rng.range(3, 7);
          }
        }
        if (i > 0) {
          let y = by0 + inset + depth + 4;
          while (y < by1 - inset - depth - 12) {
            const hh = rng.range(10, 16);
            const d = rng.range(depth * 0.7, depth);
            this.buildings.push({ x: bx0 + inset, y, w: d, h: hh, hatch: rng.chance(0.35) });
            y += hh + rng.range(3, 7);
          }
        }
        if (i < 2) {
          let y = by0 + inset + depth + 4;
          while (y < by1 - inset - depth - 12) {
            const hh = rng.range(10, 16);
            const d = rng.range(depth * 0.7, depth);
            this.buildings.push({ x: bx1 - inset - d, y, w: d, h: hh, hatch: rng.chance(0.35) });
            y += hh + rng.range(3, 7);
          }
        }
      }
    }
    // Parked cars in the lay-bys.
    const colors = ["#8E9296", "#A7A195", "#7D8A93", "#9C8F86", "#B0AFA8", "#6F7479"];
    for (const lane of this.sim.city.lanes) {
      if (!lane.parking) continue;
      let s = lane.parking.s0;
      while (s < lane.parking.s1) {
        if (rng.chance(0.62)) {
          const p = add(lane.start, scale(lane.heading, s));
          const off = scale(right(lane.heading), LANE_W / 2 + 1.25);
          this.parked.push({ p: add(p, off), h: Math.atan2(lane.heading.y, lane.heading.x), color: rng.pick(colors) });
        }
        s += 6.5;
      }
    }
  }

  // ------------------------------------------------------------------ background

  private drawBackground() {
    const key = `${this.w}x${this.h}@${this.dpr}:${this.view.cx.toFixed(2)},${this.view.cy.toFixed(2)},${this.view.scale.toFixed(4)}`;
    if (key === this.bgKey && this.bg) return;
    this.bgKey = key;
    if (!this.bg) this.bg = document.createElement("canvas");
    this.bg.width = this.canvas.width;
    this.bg.height = this.canvas.height;
    const ctx = this.bg.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.paper;
    ctx.fillRect(0, 0, this.bg.width, this.bg.height);
    this.applyWorld(ctx);
    const px = this.px;

    // Grid: 10 m minor, 50 m major.
    const tl = this.toWorld(0, 0);
    const br = this.toWorld(this.w, this.h);
    ctx.lineWidth = px;
    for (let step of [10, 50]) {
      ctx.strokeStyle = step === 10 ? C.gridMinor : C.gridMajor;
      ctx.beginPath();
      for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
        ctx.moveTo(x, tl.y);
        ctx.lineTo(x, br.y);
      }
      for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) {
        ctx.moveTo(tl.x, y);
        ctx.lineTo(br.x, y);
      }
      ctx.stroke();
      void step;
    }

    // Sidewalk bands (drawn wide, then roads on top).
    const city = this.sim.city;
    const edge = ROAD_HALF + SIDEWALK;
    ctx.fillStyle = C.sidewalk;
    for (const r of city.roads) {
      if (r.axis === "h") ctx.fillRect(WORLD.x0 - 60, r.coord - edge, WORLD.x1 - WORLD.x0 + 120, edge * 2);
      else ctx.fillRect(r.coord - edge, WORLD.y0 - 60, edge * 2, WORLD.y1 - WORLD.y0 + 120);
    }

    // Park and school grounds.
    ctx.fillStyle = C.park;
    ctx.strokeStyle = C.parkLine;
    ctx.lineWidth = px;
    ctx.fillRect(edge, edge, LX - 2 * edge, LY - 2 * edge);
    ctx.strokeRect(edge + 2, edge + 2, LX - 2 * edge - 4, LY - 2 * edge - 4);
    // Park paths.
    ctx.strokeStyle = "#D6D2C0";
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(edge, edge);
    ctx.lineTo(LX - edge, LY - edge);
    ctx.moveTo(LX - edge, edge);
    ctx.lineTo(edge, LY - edge);
    ctx.stroke();
    ctx.fillStyle = C.tree;
    ctx.strokeStyle = "#95A06F";
    ctx.lineWidth = px;
    for (const t of this.trees) {
      ctx.beginPath();
      ctx.arc(t.x, t.y, 2.6, 0, Math.PI * 2);
      ctx.globalAlpha = 0.55;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.stroke();
    }
    // School field (south-west block, below the school building).
    const fx0 = -edge - 58;
    const fy0 = LY + edge + 32;
    const fw = 50;
    const fh = 34;
    ctx.fillStyle = "#E6EAD2";
    ctx.strokeStyle = C.parkLine;
    ctx.fillRect(fx0, fy0, fw, fh);
    ctx.strokeRect(fx0 + 2, fy0 + 2, fw - 4, fh - 4);
    ctx.beginPath();
    ctx.moveTo(fx0 + fw / 2, fy0 + 2);
    ctx.lineTo(fx0 + fw / 2, fy0 + fh - 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(fx0 + fw / 2, fy0 + fh / 2, 5, 0, Math.PI * 2);
    ctx.stroke();

    // Buildings with plan hatching.
    for (const b of this.buildings) {
      ctx.fillStyle = b.label ? "#E6E0CC" : C.building;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      if (b.hatch) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(b.x, b.y, b.w, b.h);
        ctx.clip();
        ctx.strokeStyle = C.hatch;
        ctx.lineWidth = px * 0.9;
        ctx.beginPath();
        for (let d = -b.h; d < b.w; d += 2.2) {
          ctx.moveTo(b.x + d, b.y + b.h);
          ctx.lineTo(b.x + d + b.h, b.y);
        }
        ctx.stroke();
        ctx.restore();
      }
      ctx.strokeStyle = C.buildingLine;
      ctx.lineWidth = px * 1.1;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      if (b.label) {
        this.label(ctx, b.label, b.x + b.w / 2, b.y + b.h / 2, 11, C.ink, "700", 2.5);
      }
    }

    // Roads.
    ctx.fillStyle = C.asphalt;
    for (const r of city.roads) {
      if (r.axis === "h") ctx.fillRect(WORLD.x0 - 60, r.coord - ROAD_HALF, WORLD.x1 - WORLD.x0 + 120, ROAD_HALF * 2);
      else ctx.fillRect(r.coord - ROAD_HALF, WORLD.y0 - 60, ROAD_HALF * 2, WORLD.y1 - WORLD.y0 + 120);
    }
    // Parking lay-bys.
    for (const lane of city.lanes) {
      if (!lane.parking) continue;
      const n = right(lane.heading);
      const a = add(add(lane.start, scale(lane.heading, lane.parking.s0)), scale(n, LANE_W / 2));
      const b = add(add(lane.start, scale(lane.heading, lane.parking.s1)), scale(n, LANE_W / 2 + 2.5));
      ctx.fillStyle = C.asphaltLight;
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.strokeStyle = "rgba(244,243,238,0.7)";
      ctx.lineWidth = 0.12;
      ctx.beginPath();
      for (let s = lane.parking.s0; s <= lane.parking.s1; s += 6.5) {
        const p = add(add(lane.start, scale(lane.heading, s)), scale(n, LANE_W / 2));
        const q = add(p, scale(n, 2.5));
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
    }
    // Intersection corner fillets (curb returns).
    for (const i of city.ints) this.drawBox(ctx, i);
    // Curb lines.
    ctx.strokeStyle = C.curb;
    ctx.lineWidth = px * 1.4;
    for (const r of city.roads) {
      const ints = city.ints.filter((i) => (r.axis === "h" ? i.center.y === r.coord : i.center.x === r.coord));
      const along = ints.map((i) => (r.axis === "h" ? i.center.x : i.center.y)).sort((a, b) => a - b);
      const from = r.axis === "h" ? WORLD.x0 - 60 : WORLD.y0 - 60;
      const to = r.axis === "h" ? WORLD.x1 + 60 : WORLD.y1 + 60;
      const cuts = [from, ...along.flatMap((p) => [p - BOX_HALF, p + BOX_HALF]), to];
      for (let k = 0; k < cuts.length; k += 2) {
        for (const side of [-1, 1]) {
          ctx.beginPath();
          if (r.axis === "h") {
            ctx.moveTo(cuts[k], r.coord + side * ROAD_HALF);
            ctx.lineTo(cuts[k + 1], r.coord + side * ROAD_HALF);
          } else {
            ctx.moveTo(r.coord + side * ROAD_HALF, cuts[k]);
            ctx.lineTo(r.coord + side * ROAD_HALF, cuts[k + 1]);
          }
          ctx.stroke();
        }
      }
    }

    // Lane markings.
    for (const lane of city.lanes) this.drawLaneMarkings(ctx, lane);
    for (const i of city.ints) this.drawCrosswalksAndStops(ctx, i);
    this.drawSchoolZone(ctx);
    this.drawLabels(ctx);

    // Parked cars.
    for (const p of this.parked) {
      ctx.save();
      ctx.translate(p.p.x, p.p.y);
      ctx.rotate(p.h);
      this.roundRect(ctx, -2.2, -0.9, 4.4, 1.8, 0.5);
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.strokeStyle = "rgba(30,35,38,0.45)";
      ctx.lineWidth = px;
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawBox(ctx: CanvasRenderingContext2D, i: Intersection) {
    const c = i.center;
    const r = BOX_HALF - ROAD_HALF;
    ctx.fillStyle = C.asphalt;
    ctx.fillRect(c.x - BOX_HALF, c.y - BOX_HALF, BOX_HALF * 2, BOX_HALF * 2);
    // Corners of the square are sidewalk: a quarter circle of radius r
    // around each box corner forms the curb return.
    for (const [sx, sy] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      const kx = c.x + sx * BOX_HALF;
      const ky = c.y + sy * BOX_HALF;
      const a0 = Math.atan2(0, -sx);
      const a1 = Math.atan2(-sy, 0);
      const ccw = sx !== sy;
      ctx.fillStyle = C.sidewalk;
      ctx.beginPath();
      ctx.moveTo(kx, ky);
      ctx.arc(kx, ky, r, a0, a1, ccw);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = C.curb;
      ctx.lineWidth = this.px * 1.4;
      ctx.beginPath();
      ctx.arc(kx, ky, r, a0, a1, ccw);
      ctx.stroke();
    }
  }

  private drawLaneMarkings(ctx: CanvasRenderingContext2D, lane: Lane) {
    // Double yellow center line: drawn once per road direction pair (use the
    // lane whose heading is E or S), offset to the road center.
    if (lane.headingArm !== "E" && lane.headingArm !== "S") return;
    const n = right(lane.heading);
    const center = scale(n, -LANE_W / 2);
    const a = add(lane.start, center);
    const b = add(lane.end, center);
    ctx.strokeStyle = C.laneYellow;
    ctx.lineWidth = 0.13;
    for (const off of [-0.16, 0.16]) {
      const o = scale(n, off);
      ctx.beginPath();
      ctx.moveTo(a.x + o.x, a.y + o.y);
      ctx.lineTo(b.x + o.x, b.y + o.y);
      ctx.stroke();
    }
  }

  private drawCrosswalksAndStops(ctx: CanvasRenderingContext2D, i: Intersection) {
    // Stop lines.
    for (const arm of ["N", "E", "S", "W"] as Arm[]) {
      const lane = i.inLanes[arm];
      if (!lane || lane.stopLineS === undefined) continue;
      const n = right(lane.heading);
      const p = add(lane.start, scale(lane.heading, lane.stopLineS + 0.25));
      const a = add(p, scale(n, -LANE_W / 2 + 0.2));
      const b = add(p, scale(n, LANE_W / 2 - 0.1));
      ctx.strokeStyle = C.laneWhite;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    // Continental crosswalks.
    for (const cw of Object.values(i.crosswalks)) {
      if (!cw) continue;
      const d = ARM_DIR[cw.arm];
      const across = right(d);
      ctx.fillStyle = C.laneWhite;
      const mid = add(i.center, scale(d, (CW_NEAR + CW_FAR) / 2));
      for (let k = -ROAD_HALF + 0.35; k < ROAD_HALF - 0.2; k += 0.9) {
        const p = add(mid, scale(across, k));
        const len = CW_FAR - CW_NEAR;
        if (Math.abs(d.x) > 0) ctx.fillRect(p.x - len / 2, p.y, len, 0.5);
        else ctx.fillRect(p.x, p.y - len / 2, 0.5, len);
      }
    }
  }

  private drawSchoolZone(ctx: CanvasRenderingContext2D) {
    const c = this.sim.city.byId.get("C")!.center;
    ctx.save();
    ctx.strokeStyle = C.schoolInk;
    ctx.setLineDash([2.2, 1.6]);
    ctx.lineWidth = this.px * 1.3;
    const r = SCHOOL_RADIUS;
    ctx.beginPath();
    ctx.moveTo(c.x - ROAD_HALF - 1.2, c.y - r);
    ctx.lineTo(c.x + ROAD_HALF + 1.2, c.y - r);
    ctx.moveTo(c.x - ROAD_HALF - 1.2, c.y + r);
    ctx.lineTo(c.x + ROAD_HALF + 1.2, c.y + r);
    ctx.moveTo(c.x - r, c.y - ROAD_HALF - 1.2);
    ctx.lineTo(c.x - r, c.y + ROAD_HALF + 1.2);
    ctx.moveTo(c.x + r, c.y - ROAD_HALF - 1.2);
    ctx.lineTo(c.x + r, c.y + ROAD_HALF + 1.2);
    ctx.stroke();
    ctx.restore();
    // "SCHOOL" pavement legend on each approach.
    for (const arm of ["N", "E", "S", "W"] as Arm[]) {
      const lane = this.sim.city.byId.get("C")!.inLanes[arm];
      if (!lane) continue;
      const p = add(lane.start, scale(lane.heading, lane.length - 34));
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.atan2(lane.heading.y, lane.heading.x) + Math.PI / 2);
      ctx.fillStyle = "rgba(244,243,238,0.85)";
      ctx.font = `800 1.6px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("SCHOOL", 0, 0);
      ctx.restore();
    }
  }

  private label(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    pxSize: number,
    color: string,
    weight = "700",
    spacing = 1.5,
    rot = 0,
    align: CanvasTextAlign = "center",
  ) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    const s = this.px;
    ctx.scale(s, s);
    ctx.font = `${weight} ${pxSize}px ${FONT}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${spacing}px`;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  private drawLabels(ctx: CanvasRenderingContext2D) {
    const city = this.sim.city;
    const off = ROAD_HALF + SIDEWALK + 3.2;
    for (const r of city.roads) {
      const txt = `${r.name.toUpperCase()}  ·  ${r.limitMph} MPH`;
      if (r.axis === "h") {
        this.label(ctx, txt, WORLD.x0 + 44, r.coord - off, 10.5, C.ink2, "700", 2);
        this.label(ctx, txt, WORLD.x1 - 44, r.coord + off, 10.5, C.ink2, "700", 2);
      } else {
        this.label(ctx, txt, r.coord - off, WORLD.y0 + 36, 10.5, C.ink2, "700", 2, -Math.PI / 2);
        this.label(ctx, txt, r.coord + off, WORLD.y1 - 36, 10.5, C.ink2, "700", 2, -Math.PI / 2);
      }
    }
    const captions: Record<string, string> = {
      A: "SIGNAL · ARTERIAL",
      B: "ALL-WAY STOP",
      C: "SIGNAL · SCHOOL XING",
      D: "SIGNAL",
    };
    for (const i of city.ints) {
      const p = { x: i.center.x + BOX_HALF + 12, y: i.center.y - BOX_HALF - 12 };
      const rr = 5.2 * this.px * 2.2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
      ctx.fillStyle = C.paper;
      ctx.fill();
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = this.px * 1.5;
      ctx.stroke();
      this.label(ctx, i.id, p.x, p.y + this.px * 0.6, 13, C.ink, "800", 0);
      this.label(ctx, captions[i.id], p.x + rr + 5 * this.px, p.y, 9, C.ink2, "700", 1.4, 0, "left");
    }
  }

  // ------------------------------------------------------------------ dynamic

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  private drawSignals(ctx: CanvasRenderingContext2D) {
    const sim = this.sim;
    const t = sim.time;
    for (const i of sim.city.ints) {
      const sig = sim.signals.get(i.id);
      for (const arm of ["N", "E", "S", "W"] as Arm[]) {
        const lane = i.inLanes[arm];
        if (!lane || lane.stopLineS === undefined) continue;
        const n = right(lane.heading);
        const base = add(lane.start, scale(lane.heading, lane.stopLineS + 0.25));
        const pole = add(base, scale(n, LANE_W / 2 + 1.3));
        const ang = Math.atan2(lane.heading.y, lane.heading.x);
        if (!sig) {
          // Stop sign: red octagon on the right curb.
          ctx.save();
          ctx.translate(pole.x, pole.y);
          const R = 1.25;
          ctx.beginPath();
          for (let k = 0; k < 8; k++) {
            const a = (Math.PI / 8) * (2 * k + 1);
            ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R);
          }
          ctx.closePath();
          ctx.fillStyle = C.stop;
          ctx.fill();
          ctx.strokeStyle = C.white;
          ctx.lineWidth = 0.22;
          ctx.stroke();
          ctx.restore();
          continue;
        }
        const state = sig.lightFor(arm);
        // Colored stop bar for legibility at small scale.
        const flashOn = Math.floor(t * 1.6) % 2 === 0 || this.opts?.reducedMotion;
        const col =
          state === "green" ? C.lampGreen : state === "yellow" ? C.lampYellow : state === "red" ? C.lampRed : flashOn ? C.lampRed : "#6b2b2e";
        const a = add(base, scale(n, -LANE_W / 2 + 0.3));
        const b = add(base, scale(n, LANE_W / 2 - 0.2));
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 0.55;
        ctx.beginPath();
        const back = scale(lane.heading, -0.6);
        ctx.moveTo(a.x + back.x, a.y + back.y);
        ctx.lineTo(b.x + back.x, b.y + back.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
        // Signal head on the corner.
        ctx.save();
        ctx.translate(pole.x, pole.y);
        ctx.rotate(ang + Math.PI / 2);
        this.roundRect(ctx, -0.75, -2.0, 1.5, 4.0, 0.45);
        ctx.fillStyle = C.signalOff;
        ctx.fill();
        const lamps: [string, boolean][] = [
          [C.lampRed, state === "red" || (state === "flashing_red" && !!flashOn)],
          [C.lampYellow, state === "yellow"],
          [C.lampGreen, state === "green"],
        ];
        lamps.forEach(([cc, on], k) => {
          ctx.beginPath();
          ctx.arc(0, -1.25 + k * 1.25, 0.46, 0, Math.PI * 2);
          ctx.fillStyle = on ? cc : "#3b3f44";
          ctx.fill();
          if (on) {
            ctx.globalAlpha = 0.25;
            ctx.beginPath();
            ctx.arc(0, -1.25 + k * 1.25, 1.0, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
          }
        });
        ctx.restore();
      }
    }
  }

  private opts?: RenderOptions;

  private drawCar(ctx: CanvasRenderingContext2D, c: Car, alpha: number, selected: boolean) {
    const x = c.prevPose.x + (c.pose.x - c.prevPose.x) * alpha;
    const y = c.prevPose.y + (c.pose.y - c.prevPose.y) * alpha;
    const h = lerpA(c.prevPose.h, c.pose.h, alpha);
    const px = this.px;
    ctx.save();
    ctx.translate(x, y);

    // Confidence ring (not rotated).
    if (c.kind === "car") {
      const conf = c.decision ? c.decision.actionConfidence : 1;
      const fb = !!c.fallback;
      const R = 3.5;
      ctx.lineWidth = Math.max(0.28, px * 1.6);
      ctx.strokeStyle = "rgba(30,35,38,0.10)";
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = fb ? C.amber : BRAIN_COLOR[c.brain];
      if (fb) ctx.setLineDash([0.9, 0.7]);
      ctx.beginPath();
      ctx.arc(0, 0, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (fb ? 1 : Math.max(0.02, conf)));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (selected) {
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = px * 2;
      ctx.beginPath();
      ctx.arc(0, 0, 5.2, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.rotate(h);
    const L = c.L;
    const W = c.W;
    this.roundRect(ctx, -L / 2, -W / 2, L, W, 0.55);
    let fill = BRAIN_COLOR[c.brain];
    if (c.kind === "ambulance") fill = "#FBFBF8";
    if (c.kind === "stalled") fill = "#8B9096";
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = px * 1.1;
    ctx.strokeStyle = "rgba(20,24,27,0.85)";
    ctx.stroke();
    // Windshield marks the heading.
    ctx.fillStyle = c.kind === "ambulance" ? "#7C8C99" : "rgba(255,255,255,0.72)";
    this.roundRect(ctx, L / 2 - 1.55, -W / 2 + 0.25, 0.7, W - 0.5, 0.2);
    ctx.fill();
    if (c.kind === "ambulance") {
      ctx.fillStyle = C.stop;
      ctx.fillRect(-0.9, -0.25, 1.8, 0.5);
      ctx.fillRect(-0.25, -0.9, 0.5, 1.8);
      const on = this.opts?.reducedMotion ? true : Math.floor(c.blink * 6) % 2 === 0;
      ctx.fillStyle = on ? "#FF2D3A" : "#2E6BFF";
      ctx.fillRect(L / 2 - 2.1, -W / 2, 0.45, W / 2);
      ctx.fillStyle = on ? "#2E6BFF" : "#FF2D3A";
      ctx.fillRect(L / 2 - 2.1, 0, 0.45, W / 2);
    }
    // Brake lights.
    if (c.a < -1 || (c.v < 0.2 && c.kind === "car")) {
      ctx.fillStyle = c.a < -4.5 ? "#FF2A2A" : "#E0303A";
      ctx.fillRect(-L / 2 - 0.05, -W / 2 + 0.2, 0.3, 0.45);
      ctx.fillRect(-L / 2 - 0.05, W / 2 - 0.65, 0.3, 0.45);
    }
    // Hazard lights (stalled).
    if (c.kind === "stalled" && (this.opts?.reducedMotion || Math.floor(c.blink * 2.4) % 2 === 0)) {
      ctx.fillStyle = C.amber;
      for (const [hx, hy] of [
        [L / 2 - 0.2, -W / 2 + 0.1],
        [L / 2 - 0.2, W / 2 - 0.5],
        [-L / 2 - 0.1, -W / 2 + 0.1],
        [-L / 2 - 0.1, W / 2 - 0.5],
      ]) ctx.fillRect(hx, hy, 0.35, 0.4);
    }
    // Safety reflex flash.
    if (c.reflex) {
      ctx.strokeStyle = C.amber;
      ctx.lineWidth = px * 2.2;
      this.roundRect(ctx, -L / 2 - 0.5, -W / 2 - 0.5, L + 1, W + 1, 0.8);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawSelection(ctx: CanvasRenderingContext2D, c: Car) {
    // Leader line to the next stop line with distance callout.
    const st = c.route.nextStop(c.s);
    if (!st || st.s - c.s > 90) return;
    const p = c.route.sample(st.s);
    ctx.save();
    ctx.strokeStyle = C.ink;
    ctx.setLineDash([this.px * 4, this.px * 3]);
    ctx.lineWidth = this.px * 1.2;
    ctx.beginPath();
    ctx.moveTo(c.pose.x, c.pose.y);
    ctx.lineTo(p.p.x, p.p.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(p.p.x, p.p.y, this.px * 3.5, 0, Math.PI * 2);
    ctx.fillStyle = C.ink;
    ctx.fill();
    ctx.restore();
  }

  private drawMarkers(ctx: CanvasRenderingContext2D) {
    const t = this.sim.time;
    for (const m of this.sim.markers) {
      const age = t - m.t;
      if (age > 2.6 || age < 0) continue;
      const k = this.opts?.reducedMotion ? 0.5 : age / 2.6;
      const col = m.kind === "violation" ? C.stop : C.amber;
      ctx.save();
      ctx.globalAlpha = 1 - k * 0.8;
      ctx.strokeStyle = col;
      ctx.lineWidth = this.px * 2.5;
      ctx.beginPath();
      ctx.arc(m.pos.x, m.pos.y, 4 + (this.opts?.reducedMotion ? 2 : k * 7), 0, Math.PI * 2);
      ctx.stroke();
      // Tag.
      const s = this.toScreen(m.pos);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.font = `800 10px ${FONT}`;
      const w = ctx.measureText(m.label).width + 10;
      ctx.fillStyle = col;
      ctx.fillRect(s.x + 12, s.y - 22, w, 15);
      ctx.fillStyle = C.white;
      ctx.textBaseline = "middle";
      ctx.fillText(m.label, s.x + 17, s.y - 14);
      ctx.restore();
      this.applyWorld(ctx);
    }
  }

  /** Extra dynamic layers (pedestrians, events) registered by later code. */
  overlays: ((ctx: CanvasRenderingContext2D, r: CityRenderer, alpha: number) => void)[] = [];

  get pixel(): number {
    return this.px;
  }

  render(alpha: number, opts: RenderOptions) {
    this.opts = opts;
    this.drawBackground();
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.bg!, 0, 0);
    this.applyWorld(ctx);
    // School zone tint when active.
    if (this.sim.schoolActive) {
      const c = this.sim.city.byId.get("C")!.center;
      ctx.save();
      ctx.fillStyle = C.school;
      ctx.globalAlpha = 0.22;
      const r = SCHOOL_RADIUS;
      ctx.fillRect(c.x - ROAD_HALF, c.y - r, ROAD_HALF * 2, r * 2);
      ctx.fillRect(c.x - r, c.y - ROAD_HALF, r * 2, ROAD_HALF * 2);
      ctx.restore();
    }
    this.drawSignals(ctx);
    for (const o of this.overlays) o(ctx, this, alpha);
    const sel = opts.selectedId;
    for (const c of this.sim.cars) this.drawCar(ctx, c, alpha, c.id === sel);
    if (sel !== null) {
      const c = this.sim.carById(sel);
      if (c) this.drawSelection(ctx, c);
    }
    this.drawMarkers(ctx);
    if (opts.showTitleBlock) this.drawChrome(opts);
  }

  private drawChrome(opts: RenderOptions) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // Title block, bottom-right, like a drawing sheet.
    const w = 250;
    const h = 64;
    const x = this.w - w - 14;
    const y = this.h - h - 14;
    ctx.fillStyle = "rgba(243,240,231,0.94)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(x, y + 26);
    ctx.lineTo(x + w, y + 26);
    ctx.stroke();
    ctx.fillStyle = C.ink;
    ctx.font = `800 13px ${FONT}`;
    ctx.textBaseline = "middle";
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "2px";
    ctx.fillText(opts.title, x + 10, y + 14);
    ctx.font = `600 10px ${FONT}`;
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "1px";
    ctx.fillStyle = C.ink2;
    ctx.fillText(opts.subtitle, x + 10, y + 39);
    ctx.fillText(`SHEET 1 OF 1  ·  GRID 10 M`, x + 10, y + 53);
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "0px";

    // North arrow + scale bar, top-left.
    const nx = 34;
    const ny = 40;
    ctx.strokeStyle = C.ink;
    ctx.fillStyle = C.ink;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(nx, ny, 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(nx, ny - 11);
    ctx.lineTo(nx + 5, ny + 7);
    ctx.lineTo(nx, ny + 3);
    ctx.closePath();
    ctx.fill();
    ctx.font = `800 10px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText("N", nx, ny - 22);
    ctx.textAlign = "left";
    const m50 = 50 * this.view.scale;
    const bx = 60;
    const by = ny + 6;
    ctx.fillStyle = C.ink;
    ctx.fillRect(bx, by, m50 / 2, 4);
    ctx.strokeRect(bx, by, m50, 4);
    ctx.font = `600 9px ${FONT}`;
    ctx.fillText("0", bx - 2, by - 7);
    ctx.fillText("25", bx + m50 / 2 - 5, by - 7);
    ctx.fillText("50 M", bx + m50 - 8, by - 7);
    void opts;
  }

  /** Car nearest to a screen point, within 18 px. */
  pick(sx: number, sy: number): Car | null {
    const w = this.toWorld(sx, sy);
    let best: Car | null = null;
    let bd = 18 / this.view.scale;
    for (const c of this.sim.cars) {
      const d = Math.hypot(c.pose.x - w.x, c.pose.y - w.y);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  speedText(c: Car): string {
    return `${toMph(c.v).toFixed(0)} mph`;
  }
}
