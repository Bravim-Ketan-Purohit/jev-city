// 2D vector helpers and sampled polylines. World units are meters; x grows
// east, y grows south (canvas convention).

export interface Vec {
  x: number;
  y: number;
}

export const vec = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a: Vec): Vec => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
/** Right-hand normal in screen coordinates (y down). */
export const right = (d: Vec): Vec => ({ x: -d.y, y: d.x });
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

export interface PathSample {
  p: Vec;
  t: Vec; // unit tangent
}

/** A polyline with cumulative arc length for constant-time-ish lookups. */
export class Path {
  readonly pts: Vec[];
  readonly cum: number[];
  readonly length: number;

  constructor(pts: Vec[]) {
    this.pts = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + dist(pts[i - 1], pts[i]));
    this.length = this.cum[this.cum.length - 1];
  }

  private seg(s: number): number {
    const c = this.cum;
    if (s <= 0) return 0;
    if (s >= this.length) return c.length - 2;
    let lo = 0;
    let hi = c.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  sample(s: number): PathSample {
    const i = this.seg(s);
    const a = this.pts[i];
    const b = this.pts[i + 1];
    const segLen = this.cum[i + 1] - this.cum[i] || 1;
    const t = norm(sub(b, a));
    const u = (s - this.cum[i]) / segLen;
    // Extrapolate linearly beyond either end.
    return { p: { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }, t };
  }
}

/** Cubic Bezier sampled into points (inclusive of both ends). */
export function bezier(p0: Vec, p1: Vec, p2: Vec, p3: Vec, n: number): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    out.push({
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    });
  }
  return out;
}

/** Oriented box overlap (separating axis test) for car bodies. */
export interface OBB {
  c: Vec;
  h: Vec; // unit heading
  hl: number; // half length
  hw: number; // half width
}

export function obbOverlap(a: OBB, b: OBB): boolean {
  const axes = [a.h, right(a.h), b.h, right(b.h)];
  const d = sub(b.c, a.c);
  for (const ax of axes) {
    const ra = a.hl * Math.abs(dot(a.h, ax)) + a.hw * Math.abs(dot(right(a.h), ax));
    const rb = b.hl * Math.abs(dot(b.h, ax)) + b.hw * Math.abs(dot(right(b.h), ax));
    if (Math.abs(dot(d, ax)) > ra + rb) return false;
  }
  return true;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const inRect = (p: Vec, r: Rect, pad = 0): boolean =>
  p.x >= r.x0 - pad && p.x <= r.x1 + pad && p.y >= r.y0 - pad && p.y <= r.y1 + pad;
