// Dynamic overlays: pedestrians, event props (ball, officer, flagger, cones)
// and plan-style callouts for active events.

import { LANE_W, ROAD_HALF, type Arm } from "../sim/city.ts";
import { EVENT_INFO, type SimEvent } from "../sim/events.ts";
import { add, right, scale, type Vec } from "../sim/geometry.ts";
import { layersOf } from "../sim/layers.ts";
import type { CityRenderer } from "./renderer.ts";
import { C, FONT } from "./theme.ts";

type Ctx = CanvasRenderingContext2D;

function laneAt(e: SimEvent, ds: number, lat: number): Vec {
  const l = e.lane!;
  return add(add(l.start, scale(l.heading, e.s! + ds)), scale(right(l.heading), lat));
}

export function installOverlays(r: CityRenderer): void {
  r.overlays.push((ctx, rr) => drawEventsUnder(ctx, rr));
  r.overlays.push((ctx, rr) => drawPeds(ctx, rr));
  r.postOverlays.push((ctx, rr) => drawCallouts(ctx, rr));
}

function drawPeds(ctx: Ctx, r: CityRenderer) {
  const L = layersOf(r.sim);
  if (!L) return;
  const px = r.pixel;
  const now = r.sim.time;
  for (const p of L.peds.peds) {
    if (now < p.born) continue;
    const rad = p.kind === "child" ? Math.max(0.33, 2.7 * px) : Math.max(0.42, 3.2 * px);
    let pos = p.pos;
    if (p.stepping > 0) pos = add(pos, { x: p.stepping * 0.8, y: 0 });
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, rad, 0, Math.PI * 2);
    ctx.fillStyle = p.kind === "child" ? C.school : p.kind === "distracted" ? C.amber : C.ink;
    ctx.fill();
    ctx.lineWidth = Math.max(0.1, 1.1 * px);
    ctx.strokeStyle = p.kind === "adult" ? C.white : C.ink;
    ctx.stroke();
    // Facing tick.
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    ctx.lineTo(pos.x + p.facing.x * rad * 1.7, pos.y + p.facing.y * rad * 1.7);
    ctx.strokeStyle = p.kind === "adult" ? C.ink : C.ink;
    ctx.lineWidth = Math.max(0.1, 1.3 * px);
    ctx.stroke();
    if (p.phone) {
      // Phone glow in front of the face.
      const g = add(pos, scale(p.facing, rad * 1.6));
      ctx.fillStyle = "#6FB7FF";
      ctx.globalAlpha = 0.9;
      ctx.fillRect(g.x - rad * 0.35, g.y - rad * 0.35, rad * 0.7, rad * 0.7);
      ctx.globalAlpha = 1;
    }
    if (p.kind === "child" && p.stepping > 0.4) {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, rad * 2.2, 0, Math.PI * 2);
      ctx.strokeStyle = C.amber;
      ctx.lineWidth = Math.max(0.1, 1.4 * px);
      ctx.stroke();
    }
  }
}

function drawEventsUnder(ctx: Ctx, r: CityRenderer) {
  const L = layersOf(r.sim);
  if (!L) return;
  const px = r.pixel;
  const now = r.sim.time;
  for (const e of L.events.active) {
    switch (e.kind) {
      case "ball": {
        const b = e.ball!;
        if (b.gone) break;
        const rad = Math.max(0.3, 3.2 * px);
        ctx.beginPath();
        ctx.arc(b.p.x, b.p.y, rad, 0, Math.PI * 2);
        ctx.fillStyle = "#F26B21";
        ctx.fill();
        ctx.strokeStyle = C.ink;
        ctx.lineWidth = 1.1 * px;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(b.p.x - rad, b.p.y);
        ctx.quadraticCurveTo(b.p.x, b.p.y - rad * 0.6, b.p.x + rad, b.p.y);
        ctx.stroke();
        break;
      }
      case "officer": {
        const int = e.int!;
        const goNow = now >= e.officer!.goFrom;
        // Hold bars on held approaches, go chevrons on waved approaches.
        for (const arm of ["N", "E", "S", "W"] as Arm[]) {
          const lane = int.inLanes[arm];
          if (!lane || lane.stopLineS === undefined) continue;
          const stop = !goNow || e.officer!.stopArms.includes(arm);
          const n = right(lane.heading);
          const p = add(lane.start, scale(lane.heading, lane.stopLineS - 1.6));
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(Math.atan2(lane.heading.y, lane.heading.x));
          if (stop) {
            ctx.fillStyle = C.stop;
            ctx.fillRect(-0.4, -LANE_W / 2 + 0.3, 0.8, LANE_W - 0.6);
          } else {
            ctx.strokeStyle = C.lampGreen;
            ctx.lineWidth = 0.45;
            for (const k of [0, 1.4]) {
              ctx.beginPath();
              ctx.moveTo(-1 - k, -1.1);
              ctx.lineTo(0 - k, 0);
              ctx.lineTo(-1 - k, 1.1);
              ctx.stroke();
            }
          }
          ctx.restore();
          void n;
        }
        // Officer figure in the middle of the box.
        const c = int.center;
        const rad = Math.max(0.5, 4 * px);
        ctx.beginPath();
        ctx.arc(c.x, c.y, rad, 0, Math.PI * 2);
        ctx.fillStyle = C.blue;
        ctx.fill();
        ctx.lineWidth = 1.5 * px;
        ctx.strokeStyle = C.white;
        ctx.stroke();
        ctx.fillStyle = "#FFD23F";
        ctx.beginPath();
        ctx.arc(c.x, c.y, rad * 0.35, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case "flagger": {
        const cmd = L.events.flaggerCommand(e);
        // Cones upstream along the lane edge.
        for (let k = 0; k < 5; k++) {
          const q = laneAt(e, -6 - k * 3.2, LANE_W / 2 - 0.2);
          ctx.beginPath();
          ctx.moveTo(q.x, q.y - 0.55);
          ctx.lineTo(q.x + 0.5, q.y + 0.4);
          ctx.lineTo(q.x - 0.5, q.y + 0.4);
          ctx.closePath();
          ctx.fillStyle = "#F26B21";
          ctx.fill();
        }
        const p = e.pos;
        const rad = Math.max(0.45, 3.4 * px);
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.fillStyle = "#F26B21";
        ctx.fill();
        ctx.strokeStyle = C.ink;
        ctx.lineWidth = 1.2 * px;
        ctx.stroke();
        // Paddle sign (screen-sized).
        const s = r.toScreen(add(p, scale(right(e.lane!.heading), 2.2)));
        ctx.save();
        ctx.setTransform(r.dprValue, 0, 0, r.dprValue, 0, 0);
        const R = 11;
        if (cmd === "stop") {
          ctx.beginPath();
          for (let k = 0; k < 8; k++) {
            const a = (Math.PI / 8) * (2 * k + 1);
            ctx.lineTo(s.x + Math.cos(a) * R, s.y + Math.sin(a) * R);
          }
          ctx.closePath();
          ctx.fillStyle = C.stop;
        } else {
          ctx.beginPath();
          ctx.moveTo(s.x, s.y - R);
          ctx.lineTo(s.x + R, s.y);
          ctx.lineTo(s.x, s.y + R);
          ctx.lineTo(s.x - R, s.y);
          ctx.closePath();
          ctx.fillStyle = "#F7941D";
        }
        ctx.fill();
        ctx.strokeStyle = C.white;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = cmd === "stop" ? C.white : C.ink;
        ctx.font = `900 6.5px ${FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(cmd === "stop" ? "STOP" : "SLOW", s.x, s.y + 0.5);
        ctx.restore();
        r.reapplyWorld(ctx);
        break;
      }
      case "yellow": {
        const car = e.carId !== undefined ? r.sim.carById(e.carId) : undefined;
        if (!car) break;
        ctx.save();
        ctx.setLineDash([0.8, 0.6]);
        ctx.strokeStyle = C.amber;
        ctx.lineWidth = Math.max(0.3, 2 * px);
        ctx.beginPath();
        ctx.arc(car.pose.x, car.pose.y, 6.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        break;
      }
      default:
        break;
    }
  }
}

/** Plan-sheet callouts (circle, leader line, label) for each active event. */
function drawCallouts(ctx: Ctx, r: CityRenderer) {
  const L = layersOf(r.sim);
  if (!L) return;
  const now = r.sim.time;
  const placed: Vec[] = [];
  for (const e of L.events.active) {
    let anchor: Vec | undefined = e.pos;
    if (e.kind === "ambulance" || e.kind === "stalled" || e.kind === "yellow") {
      const car = e.carId !== undefined ? r.sim.carById(e.carId) : undefined;
      anchor = car ? { x: car.pose.x, y: car.pose.y } : e.kind === "yellow" ? e.int?.center : undefined;
    }
    if (e.kind === "distracted") {
      const p = L.peds.peds.find((q) => q.id === e.pedId);
      anchor = p?.pos;
    }
    if (e.kind === "school") anchor = add(e.int!.center, { x: -ROAD_HALF - 8, y: ROAD_HALF + 10 });
    if (!anchor) continue;
    const s = r.toScreen(anchor);
    let label = EVENT_INFO[e.kind].label.toUpperCase();
    if (e.kind === "flagger") label += ` · ${L.events.flaggerCommand(e).toUpperCase()}`;
    if (e.kind === "officer" || e.kind === "signal_failure") label += ` · ${e.int!.id}`;
    const left = Math.max(0, e.until - now);
    const sub = e.kind === "ambulance" ? "siren on" : `${left.toFixed(0)} s left`;
    // Offset the tag up-right; nudge to avoid overlapping earlier tags.
    let tx = s.x + 26;
    let ty = s.y - 34;
    for (const q of placed) if (Math.abs(q.x - tx) < 150 && Math.abs(q.y - ty) < 26) ty -= 28;
    placed.push({ x: tx, y: ty });
    ctx.save();
    ctx.setTransform(r.dprValue, 0, 0, r.dprValue, 0, 0);
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.x + 4, s.y - 4);
    ctx.lineTo(tx, ty + 9);
    ctx.stroke();
    ctx.font = `900 10.5px ${FONT}`;
    (ctx as Ctx & { letterSpacing?: string }).letterSpacing = "0.8px";
    const w1 = ctx.measureText(label).width;
    ctx.font = `700 9.5px ${FONT}`;
    const w2 = ctx.measureText(sub).width;
    const w = Math.max(w1, w2) + 14;
    ctx.fillStyle = C.amber;
    ctx.fillRect(tx, ty - 6, w, 30);
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 1.3;
    ctx.strokeRect(tx + 0.5, ty - 5.5, w, 30);
    ctx.fillStyle = C.ink;
    ctx.textBaseline = "middle";
    ctx.font = `900 10.5px ${FONT}`;
    ctx.fillText(label, tx + 7, ty + 3.5);
    ctx.font = `700 9.5px ${FONT}`;
    (ctx as Ctx & { letterSpacing?: string }).letterSpacing = "0.3px";
    ctx.fillText(sub, tx + 7, ty + 16);
    ctx.restore();
  }
  r.reapplyWorld(ctx);
}
