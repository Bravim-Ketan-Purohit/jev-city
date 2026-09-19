import type { Action } from "./brain.ts";

export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const a = [...values].sort((x, y) => x - y);
  const idx = (p / 100) * (a.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : NaN;
}

/**
 * Confidence from a distribution: 1 minus normalized entropy. One-hot gives
 * 1, uniform gives 0. Used only where the brain has no confidence of its own
 * (RuleBrain, MockJevBrain); Jev reports its own.
 */
export function entropyConfidence(probs: Record<string, number>): number {
  const ps = Object.values(probs).filter((p) => p > 0);
  const n = Object.keys(probs).length;
  if (n <= 1) return 1;
  const h = -ps.reduce((s, p) => s + p * Math.log(p), 0);
  return Math.max(0, Math.min(1, 1 - h / Math.log(n)));
}

export function argmax(probs: Record<Action, number>): Action {
  let best: Action = "other";
  let bp = -1;
  for (const [k, v] of Object.entries(probs) as [Action, number][]) {
    if (v > bp) {
      bp = v;
      best = k;
    }
  }
  return best;
}
