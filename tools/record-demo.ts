// Records the README demo: drives the real app in headless Chromium at
// 1920x1080 with Jev at the wheel, captures every frame over CDP, then
// encodes docs/media/jev-city-demo.mp4 and short GIFs with ffmpeg.
//
// Needs `pnpm dev` running (with TYPESAFE_API_KEY for the Jev scenes) and
// ffmpeg on the PATH.
//
//   pnpm record:demo
//
// Chromium: set CHROME_PATH, otherwise the newest Playwright-cached build or
// Google Chrome in /Applications is used.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const MEDIA = join(ROOT, "docs", "media");
const FRAMES = join(ROOT, "docs", "media", ".frames");
const URL_BASE = process.env.DEMO_URL ?? "http://localhost:5173";
const W = 1920;
const H = 1080;

function findChrome(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  if (existsSync(cache)) {
    const builds = readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const b of builds) {
      const p = join(cache, b, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
      if (existsSync(p)) return p;
    }
  }
  const app = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(app)) return app;
  throw new Error("No Chromium found: set CHROME_PATH");
}

// Cursor, click ripple and caption overlay, injected before the app loads.
const OVERLAY = `
(() => {
  const css = document.createElement('style');
  css.textContent = \`
    #demo-cursor { position: fixed; left: 0; top: 0; width: 28px; height: 28px; z-index: 99999; pointer-events: none;
      transform: translate(-3px, -2px); filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
    .demo-ripple { position: fixed; z-index: 99998; pointer-events: none; width: 16px; height: 16px; margin: -8px 0 0 -8px;
      border-radius: 50%; border: 3px solid #E89A17; animation: demo-rip .55s ease-out forwards; }
    @keyframes demo-rip { from { transform: scale(.4); opacity: 1 } to { transform: scale(3.2); opacity: 0 } }
    #demo-caption { position: fixed; left: 35%; bottom: 96px; transform: translateX(-50%) translateY(8px); z-index: 99997;
      pointer-events: none; opacity: 0; transition: opacity .3s, transform .3s; background: #1E2326; color: #fff;
      border-radius: 9px; padding: 3px; font-family: Overpass, sans-serif; box-shadow: 0 6px 22px rgba(0,0,0,.28); max-width: 1180px; }
    #demo-caption.show { opacity: .97; transform: translateX(-50%) translateY(0); }
    #demo-caption span { display: block; border: 1.6px solid rgba(255,255,255,.85); border-radius: 7px; padding: 12px 22px 9px;
      font-size: 23px; font-weight: 800; letter-spacing: .01em; white-space: nowrap; }
    #demo-caption b { color: #9fe8bf; font-weight: 900; }
  \`;
  const cursor = document.createElement('div');
  cursor.id = 'demo-cursor';
  cursor.innerHTML = '<svg viewBox="0 0 28 28" width="28" height="28"><path d="M4 2 L4 22 L9.5 17 L13 25.5 L16.5 24 L13 15.8 L20.5 15.8 Z" fill="#fff" stroke="#1E2326" stroke-width="1.8" stroke-linejoin="round"/></svg>';
  const cap = document.createElement('div');
  cap.id = 'demo-caption';
  cap.innerHTML = '<span></span>';
  addEventListener('DOMContentLoaded', () => { document.head.append(css); document.body.append(cursor, cap); });
  addEventListener('mousemove', (e) => { cursor.style.left = e.clientX + 'px'; cursor.style.top = e.clientY + 'px'; }, true);
  addEventListener('mousedown', (e) => {
    const r = document.createElement('div'); r.className = 'demo-ripple';
    r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
    document.body.append(r); setTimeout(() => r.remove(), 700);
  }, true);
  window.__caption = (html) => {
    if (!html) { cap.classList.remove('show'); return; }
    cap.querySelector('span').innerHTML = html; cap.classList.add('show');
  };
})();
`;

// ------------------------------------------------------------------ helpers

let mouse = { x: W * 0.36, y: H * 0.5 };

async function glide(page: Page, x: number, y: number, ms = 700) {
  const from = { ...mouse };
  const steps = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await page.waitForTimeout(16);
  }
  mouse = { x, y };
}

async function clickAt(page: Page, x: number, y: number, ms = 650) {
  await glide(page, x, y, ms);
  await page.waitForTimeout(120);
  await page.mouse.down();
  await page.waitForTimeout(70);
  await page.mouse.up();
}

async function clickEl(page: Page, selector: string, text: string, ms = 700) {
  const box = await page.locator(selector, { hasText: text }).first().boundingBox();
  if (!box) throw new Error(`no element ${selector} "${text}"`);
  await clickAt(page, box.x + box.width / 2, box.y + box.height / 2, ms);
}

async function caption(page: Page, html: string | null) {
  await page.evaluate((h) => (window as unknown as { __caption: (s: string | null) => void }).__caption(h), html);
}

type Pt = { x: number; y: number };

/** Screen position of a world point in pane `i`. */
async function screenOf(page: Page, wx: number, wy: number, pane = 0): Promise<Pt> {
  return page.evaluate(
    ([x, y, i]) => {
      const p = (window as any).app.panes[i];
      const r = p.canvas.getBoundingClientRect();
      const s = p.renderer.toScreen({ x, y });
      return { x: r.left + s.x, y: r.top + s.y };
    },
    [wx, wy, pane] as const,
  );
}

/**
 * Find a Jev-driven car cruising on a mid-block segment with room ahead, and
 * return it with a world point `ahead` meters in front of it on its lane.
 */
async function carOnSegment(page: Page, ahead: number, exclude: number[] = [], lat = 0) {
  return page.evaluate(
    ([ahead, exclude, lat]) => {
      const sim = (window as any).app.panes[0].sim;
      let best: any = null;
      for (const c of sim.cars) {
        if (c.kind !== "car" || (exclude as number[]).includes(c.id) || c.v < 5) continue;
        const r = c.route;
        const p = r.pieces[r.pieceIndexAt(c.s)];
        if (p.kind !== "lane" || !p.lane.fromInt || !p.lane.toInt) continue;
        const local = c.s - p.s0;
        const room = (p.lane.stopLineS ?? p.lane.length) - local;
        if (local < 2 || room < (ahead as number) + 45) continue;
        const score = room + (p.lane.parking ? 40 : 0);
        if (!best || score > best.score) best = { c, p, local, room, score };
      }
      if (!best) return null;
      const l = best.p.lane;
      const s = best.local + (ahead as number);
      const n = { x: -l.heading.y, y: l.heading.x };
      const pt = { x: l.start.x + l.heading.x * s + n.x * (lat as number), y: l.start.y + l.heading.y * s + n.y * (lat as number) };
      return { id: best.c.id as number, point: pt, road: l.road.name as string };
    },
    [ahead, exclude, lat] as const,
  );
}

async function carScreen(page: Page, id: number): Promise<Pt | null> {
  return page.evaluate((id) => {
    const p = (window as any).app.panes[0];
    const c = p.sim.carById(id);
    if (!c) return null;
    const r = p.canvas.getBoundingClientRect();
    const s = p.renderer.toScreen(c.pose);
    return { x: r.left + s.x, y: r.top + s.y };
  }, id);
}

/** Glide to a (moving) car, click it, and make sure the inspector shows it. */
async function selectCar(page: Page, id: number) {
  let p = await carScreen(page, id);
  if (!p) return;
  await glide(page, p.x, p.y, 550);
  p = (await carScreen(page, id)) ?? p;
  await glide(page, p.x, p.y, 120);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.evaluate((id) => {
    const app = (window as any).app;
    app.selected = { pane: 0, carId: id };
    if (app.panel.tab !== "inspector") app.panel.setTab("inspector");
    app.panel.update();
  }, id);
}

/** World point `ahead` meters in front of a car on its current lane (optionally off to the right). */
async function aheadOf(page: Page, id: number, ahead: number, lat = 0): Promise<Pt | null> {
  return page.evaluate(
    ([id, ahead, lat]) => {
      const c = (window as any).app.panes[0].sim.carById(id);
      if (!c) return null;
      const r = c.route;
      const p = r.pieces[r.pieceIndexAt(c.s)];
      if (p.kind !== "lane") return null;
      const l = p.lane;
      const s = Math.min(c.s - p.s0 + (ahead as number), (l.stopLineS ?? l.length) - 12);
      const n = { x: -l.heading.y, y: l.heading.x };
      return { x: l.start.x + l.heading.x * s + n.x * (lat as number), y: l.start.y + l.heading.y * s + n.y * (lat as number) };
    },
    [id, ahead, lat] as const,
  );
}

/** A Jev car 25 to 60 m from intersection `int`, moving. */
async function carNear(page: Page, int: string): Promise<number | null> {
  return page.evaluate((int) => {
    const sim = (window as any).app.panes[0].sim;
    const cs = sim.cars.filter((c: any) => {
      if (c.kind !== "car" || c.brain !== "jev") return false;
      const st = c.route.nextStop(c.s);
      return st && st.int.id === int && st.s - c.s > 18 && st.s - c.s < 60 && c.decision;
    });
    return cs.length ? cs[0].id : null;
  }, int);
}

/** A point on a lane with a clear stretch upstream (for the stalled car). */
async function clearLanePoint(page: Page, laneIds: string[]): Promise<Pt | null> {
  return page.evaluate((ids) => {
    const sim = (window as any).app.panes[0].sim;
    for (const id of ids as string[]) {
      const l = sim.city.lanes.find((x: any) => x.id === id);
      if (!l) continue;
      const occ = sim.occ.get(l.id) ?? [];
      for (let s = (l.stopLineS ?? l.length) * 0.6; s > 40; s -= 4) {
        const blocked = occ.some((o: any) => o.front > s - 55 && o.rear < s + 10);
        if (!blocked) return { x: l.start.x + l.heading.x * s, y: l.start.y + l.heading.y * s };
      }
    }
    return null;
  }, laneIds);
}

// ------------------------------------------------------------------ record

async function main() {
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ["--force-device-scale-factor=1", "--hide-scrollbars"] });
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await context.addInitScript(OVERLAY);
  const page = await context.newPage();
  await page.goto(`${URL_BASE}/?brain=jev&seed=1234`);
  await page.waitForFunction(() => (window as any).app?.health?.ok && (window as any).app.panes.length === 1, null, { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(mouse.x, mouse.y);
  await page.waitForTimeout(1500); // let Jev take over from the warm-up

  const client = await context.newCDPSession(page);
  const frames: { file: string; t: number }[] = [];
  let n = 0;
  client.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp: number } }) => {
    const file = join(FRAMES, `f${String(n++).padStart(6, "0")}.jpg`);
    writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp });
    void client.send("Page.screencastFrameAck", { sessionId: f.sessionId });
  });
  await client.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: W, maxHeight: H, everyNthFrame: 2 });
  const t0 = Date.now() / 1000;
  const chapters: { name: string; at: number }[] = [];
  const chapter = (name: string) => chapters.push({ name, at: Date.now() / 1000 - t0 });
  const wait = (ms: number) => page.waitForTimeout(ms);

  // 1. The city.
  chapter("city");
  await caption(page, "Every car in this city is driven by TypeSafe's <b>Jev</b> model");
  await wait(4200);

  // 2. Inspect a car.
  chapter("inspect");
  await caption(page, "Click a car to see what Jev is told and what it decides");
  const inspectId = (await carNear(page, "A")) ?? (await carNear(page, "D")) ?? (await carNear(page, "C"));
  if (inspectId !== null) await selectCar(page, inspectId);
  await wait(6800);

  // 3. Zoom in on intersection C.
  chapter("zoom");
  await caption(page, "Signals, stop lines, crosswalks and a confidence ring on every car");
  const c = await screenOf(page, 0, 130);
  await glide(page, c.x, c.y, 700);
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, -60);
    await wait(55);
  }
  await wait(3800);
  await page.mouse.dblclick(c.x, c.y);
  await wait(600);

  // 4. School dismissal.
  chapter("school");
  await caption(page, "School dismissal: the zone drops to 20 mph and children gather at C");
  await clickEl(page, "button.ev", "Dismissal");
  await wait(5500);

  // 5. Ball into the road, with the affected car selected, then a close-up.
  chapter("ball");
  await caption(page, "A ball rolls out from between parked cars. Jev slows even after it has gone");
  const ball = await carOnSegment(page, 30, []);
  if (ball) {
    await selectCar(page, ball.id);
    await clickEl(page, "button.ev", "Ball", 550);
    const pt = (await aheadOf(page, ball.id, 30)) ?? ball.point;
    const bp = await screenOf(page, pt.x, pt.y);
    await clickAt(page, bp.x, bp.y, 450);
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, -60);
      await wait(45);
    }
    await wait(5200);
    await page.mouse.dblclick(bp.x, bp.y);
  } else await wait(5000);
  await wait(500);

  // 6. Distracted pedestrian.
  chapter("distracted");
  await caption(page, "A pedestrian at the curb, eyes on a phone. No law says slow down. Jev does anyway");
  const ped = await carOnSegment(page, 32, ball ? [ball.id] : []);
  let pedPt: Pt | null = null;
  if (ped) {
    await selectCar(page, ped.id);
    await clickEl(page, "button.ev", "Distracted ped", 550);
    pedPt = await aheadOf(page, ped.id, 32, 3.6 / 2 + 0.6);
  } else {
    await clickEl(page, "button.ev", "Distracted ped", 550);
  }
  pedPt ??= await page.evaluate(() => {
    const l = (window as any).app.panes[0].sim.city.lanes.find((x: any) => x.id === "OK-E1");
    const n = { x: -l.heading.y, y: l.heading.x };
    return { x: l.start.x + l.heading.x * 80 + n.x * 2.4, y: l.start.y + l.heading.y * 80 + n.y * 2.4 };
  });
  const pp = await screenOf(page, pedPt.x, pedPt.y);
  await clickAt(page, pp.x, pp.y, 450);
  await wait(6500);

  // 7. Officer at A.
  chapter("officer");
  await caption(page, "A police officer overrides the traffic lights at A");
  await clickEl(page, "button.ev", "Officer", 600);
  const a = await screenOf(page, 2, 2);
  await clickAt(page, a.x, a.y, 600);
  await wait(5000);

  // 8. Stalled car.
  chapter("stalled");
  await caption(page, "A stalled car: wait, then go around when the oncoming lane is clear");
  const sp = await clearLanePoint(page, ["MA-S1", "MA-N1", "OK-W1", "EL-W1", "EL-E1", "OK-E1"]);
  if (sp) {
    await clickEl(page, "button.ev", "Stalled car", 600);
    const s = await screenOf(page, sp.x, sp.y);
    await clickAt(page, s.x, s.y, 600);
  }
  await wait(7000);

  // 9. Signal failure at D.
  chapter("signal");
  await caption(page, "Signal failure at D: flashing red, treated as an all-way stop");
  await clickEl(page, "button.ev", "Signal fail", 600);
  await wait(5500);

  // 10. Metrics and log.
  chapter("metrics");
  await caption(page, "Violations are detected from geometry, independent of any brain");
  await clickEl(page, ".tabs button", "METRICS", 700);
  await wait(4200);
  await clickEl(page, ".tabs button", "LOG", 500);
  await wait(3200);

  // 11. Side by side.
  chapter("sbs");
  await caption(page, "Side by side: the rule-based driver on the left, Jev on the right, same seed");
  await clickEl(page, ".seg button", "Side by side", 700);
  await page.waitForFunction(() => (window as any).app.panes.length === 2 && (window as any).app.panes[1].mode === "jev");
  await wait(3500);
  await caption(page, "One click sends the same event into both cities at the same moment");
  await clickEl(page, "button.ev", "Ambulance", 600);
  const amb = await screenOf(page, -45, 1.8, 0);
  await clickAt(page, amb.x, amb.y, 600);
  await wait(2500);
  const ball2 = await page.evaluate(() => {
    const sim = (window as any).app.panes[0].sim;
    const l = sim.city.lanes.find((x: any) => x.id === "OK-E1");
    return l ? { x: l.start.x + l.heading.x * 70, y: l.start.y + l.heading.y * 70 } : null;
  });
  if (ball2) {
    await clickEl(page, "button.ev", "Ball", 600);
    const b2 = await screenOf(page, ball2.x, ball2.y, 0);
    await clickAt(page, b2.x, b2.y, 600);
  }
  await wait(9000);

  // 12. Results.
  chapter("results");
  await caption(page, "Benchmark: 100 scenarios, three runs per brain, calibration and cost");
  await clickEl(page, ".seg button", "Live", 700);
  await page.waitForFunction(() => (window as any).app.panes.length === 1);
  await wait(800);
  await clickEl(page, ".tabs button", "RESULTS", 700);
  await wait(6500);
  await caption(page, null);
  await wait(900);
  chapter("end");

  await client.send("Page.stopScreencast");
  await page.screenshot({ path: join(MEDIA, "results-tab.png") });
  await browser.close();
  console.log(`[record] ${frames.length} frames over ${(Date.now() / 1000 - t0).toFixed(1)} s`);
  console.log(chapters.map((c) => `${c.name.padEnd(11)} ${c.at.toFixed(1)}s`).join("\n"));

  // ------------------------------------------------------------------ encode
  const list = frames
    .map((f, i) => {
      const next = frames[i + 1]?.t ?? f.t + 1 / 30;
      return `file '${f.file}'\nduration ${Math.max(0.001, next - f.t).toFixed(4)}`;
    })
    .join("\n");
  const listFile = join(FRAMES, "list.txt");
  writeFileSync(listFile, list + `\nfile '${frames[frames.length - 1].file}'\n`);
  const mp4 = join(MEDIA, "jev-city-demo.mp4");
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart", mp4],
    { stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error("ffmpeg failed");
  console.log(`[record] wrote ${mp4}`);
  rmSync(FRAMES, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
