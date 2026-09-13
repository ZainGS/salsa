/**
 * src/scene-graph/core/bezier.ts
 *
 * Pure cubic-Bézier helpers for the pen tool (docs/specs/vector-paths.md). P0 uses these to sample the staged
 * curve preview and to FLATTEN curved segments into polygon points at commit; the P1 PathNode tessellator will
 * reuse them verbatim. No engine imports — unit-testable.
 *
 * Flattening is adaptive De Casteljau subdivision: a segment is "flat enough" when both control points sit
 * within `tol` of the P0→P3 chord (the standard flatness test); otherwise split at t = 0.5 and recurse. Depth
 * is capped so pathological inputs (NaN, gigantic handles) terminate.
 */

export interface Pt { x: number; y: number }

/** Evaluate the cubic at t (De Casteljau-equivalent Bernstein form). */
export function cubicPoint(p0: Pt, c1: Pt, c2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p3.y,
  };
}

/** Max distance of the control points from the P0→P3 chord (flatness metric). Falls back to raw control
 *  offsets when the chord is degenerate (P0 ≈ P3 with bowed handles — a loop segment). */
function controlDeviation(p0: Pt, c1: Pt, c2: Pt, p3: Pt): number {
  const dx = p3.x - p0.x, dy = p3.y - p0.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) {
    return Math.max(Math.hypot(c1.x - p0.x, c1.y - p0.y), Math.hypot(c2.x - p0.x, c2.y - p0.y));
  }
  const d1 = Math.abs((c1.x - p0.x) * dy - (c1.y - p0.y) * dx) / len;
  const d2 = Math.abs((c2.x - p0.x) * dy - (c2.y - p0.y) * dx) / len;
  return Math.max(d1, d2);
}

const MAX_DEPTH = 16;

function subdivide(p0: Pt, c1: Pt, c2: Pt, p3: Pt, tol: number, depth: number, out: Pt[]): void {
  if (depth >= MAX_DEPTH || !(controlDeviation(p0, c1, c2, p3) > tol)) {   // !(>) also catches NaN → terminate
    out.push(p3);
    return;
  }
  // De Casteljau split at t = 0.5.
  const m01 = { x: (p0.x + c1.x) / 2, y: (p0.y + c1.y) / 2 };
  const m12 = { x: (c1.x + c2.x) / 2, y: (c1.y + c2.y) / 2 };
  const m23 = { x: (c2.x + p3.x) / 2, y: (c2.y + p3.y) / 2 };
  const m012 = { x: (m01.x + m12.x) / 2, y: (m01.y + m12.y) / 2 };
  const m123 = { x: (m12.x + m23.x) / 2, y: (m12.y + m23.y) / 2 };
  const mid = { x: (m012.x + m123.x) / 2, y: (m012.y + m123.y) / 2 };
  subdivide(p0, m01, m012, mid, tol, depth + 1, out);
  subdivide(mid, m123, m23, p3, tol, depth + 1, out);
}

/** Flatten one cubic into a polyline. Returns the sampled points EXCLUDING p0 and INCLUDING p3, so segments
 *  chain without duplicate joints. `tol` is the max chord deviation (world units — pass screenPx ÷ zoom). */
export function flattenCubic(p0: Pt, c1: Pt, c2: Pt, p3: Pt, tol: number): Pt[] {
  const out: Pt[] = [];
  subdivide(p0, c1, c2, p3, Math.max(tol, 1e-9), 0, out);
  return out;
}

/** Fixed-step samples of one cubic (the staged PREVIEW path — uniform segments, cheap + stable per frame).
 *  Returns n+1 points INCLUDING both endpoints. */
export function sampleCubic(p0: Pt, c1: Pt, c2: Pt, p3: Pt, n: number): Pt[] {
  const out: Pt[] = [p0];
  for (let i = 1; i < n; i++) out.push(cubicPoint(p0, c1, c2, p3, i / n));
  out.push(p3);
  return out;
}

/** Pen-tool edge → control points: `aOut` is A's out-handle, `bOut` is B's out-handle (B's IN-handle is the
 *  MIRROR, −bOut, per the drag gesture). Null handles collapse the control onto its anchor (straight side). */
export function penEdgeControls(a: Pt, aOut: Pt | null, b: Pt, bOut: Pt | null): { c1: Pt; c2: Pt; curved: boolean } {
  const c1 = aOut ? { x: a.x + aOut.x, y: a.y + aOut.y } : a;
  const c2 = bOut ? { x: b.x - bOut.x, y: b.y - bOut.y } : b;
  return { c1, c2, curved: !!(aOut || bOut) };
}

/** De Casteljau split of one cubic at parameter t — EXACT: the two halves reproduce the original curve
 *  (the node editor's insert-anchor uses this so inserting a point never changes the shape). */
export function splitCubic(p0: Pt, c1: Pt, c2: Pt, p3: Pt, t: number):
  { left: [Pt, Pt, Pt, Pt]; right: [Pt, Pt, Pt, Pt] } {
  const L = (a: Pt, b: Pt): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const q0 = L(p0, c1), q1 = L(c1, c2), q2 = L(c2, p3);
  const r0 = L(q0, q1), r1 = L(q1, q2);
  const mid = L(r0, r1);
  return { left: [p0, q0, r0, mid], right: [mid, r1, q2, p3] };
}

/** Nearest parameter t on one cubic to a query point (coarse scan + local refinement — plenty for picking). */
export function nearestTOnCubic(p0: Pt, c1: Pt, c2: Pt, p3: Pt, q: Pt): { t: number; dist: number } {
  let bestT = 0, bestD = Infinity;
  const probe = (t: number) => {
    const p = cubicPoint(p0, c1, c2, p3, t);
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < bestD) { bestD = d; bestT = t; }
  };
  for (let i = 0; i <= 32; i++) probe(i / 32);
  for (let step = 1 / 64; step > 1e-4; step /= 2) { probe(bestT - step); probe(bestT + step); }
  return { t: Math.max(0, Math.min(1, bestT)), dist: bestD };
}
