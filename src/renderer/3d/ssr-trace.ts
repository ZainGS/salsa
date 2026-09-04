/**
 * SSR trace — CPU REFERENCE of the WGSL `traceSSR`/`ssrTestT` in mesh3d-shaders.ts (PBR_IBL_WGSL block).
 * Docs: docs/specs/environment-and-reflections.md (P2).
 *
 * The GPU trace is not headlessly testable, and iterating on it blind produced a chain of artifacts (staggered
 * copies, echoes, screen-door stripes, vanished reflections). This module is the SAME algorithm in plain TypeScript,
 * validated by ssr-trace.test.ts against synthetic scenes with ANALYTIC mirror optics (the virtual-image method), so
 * the logic is proven before it ships in WGSL. ⚠ KEEP THE TWO IN LOCKSTEP: any change here must be mirrored in
 * `ssrTestT`/`traceSSR` in mesh3d-shaders.ts and vice versa.
 *
 * Algorithm (same as the shader):
 *  - Bias the ray origin off the surface along N (half a stride) so the reflector's own half-res world-pos texels
 *    can't self-hit at the start.
 *  - March in fixed world-space steps. At each step, project the ray point, load the (half-res) world-position
 *    buffer at that pixel, and test DEPTH-ONLY: the ray point must sit just behind the surface seen at that pixel,
 *    measured along the camera-forward axis in world units (Euclidean distance would fold the buffer's lateral
 *    texel quantization into the test → per-texel pass/fail oscillation = screen-door stripes).
 *  - The acceptance window adapts to the march: effThickness = max(thickness, stride·1.5·|dot(dir, fwd)|), so a ray
 *    marching fast THROUGH the depth axis can't step clean over a thin object (skip-through = banded/split copies).
 *  - Reject hits lying essentially IN the start fragment's tangent plane (|dot(hit − startPos, N)| below a small
 *    epsilon): a planar reflector geometrically cannot see its own plane, so in-plane "hits" are quantization
 *    self-hits — the feedback-echo source. The epsilon is TINY (quarter stride) and measured from the UNBIASED
 *    start position, so genuinely near-coplanar targets (an object floating just off the mirror's extended plane)
 *    still reflect. (An earlier version used thickness/2 from the biased origin — that swallowed real targets.)
 *  - On the first accepted sample, bisect within that single stride to pin the crossing (kills stride banding).
 */

export type Vec3 = readonly [number, number, number];
export type Mat4 = Float32Array | number[];   // column-major, gl-matrix layout

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const len3 = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const norm3 = (a: Vec3): Vec3 => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const smoothstep01 = (t: number): number => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };

/** clip = M · (p, 1) for a column-major mat4. */
export function transformPoint4(m: Mat4, p: Vec3): [number, number, number, number] {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15],
  ];
}

/** Project a world point: uv (0..1, y down — same mapping as the shader), ndcZ, clipW. `visible` = in front + on screen. */
export function projectPoint(viewProj: Mat4, p: Vec3): { uv: [number, number]; ndcZ: number; clipW: number; visible: boolean } {
  const c = transformPoint4(viewProj, p);
  if (c[3] <= 0) return { uv: [0, 0], ndcZ: 0, clipW: c[3], visible: false };
  const ndcX = c[0] / c[3], ndcY = c[1] / c[3], ndcZ = c[2] / c[3];
  const uv: [number, number] = [ndcX * 0.5 + 0.5, ndcY * -0.5 + 0.5];
  const visible = uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1;
  return { uv, ndcZ, clipW: c[3], visible };
}

/** Camera-forward axis (unit, pointing away from the camera), extracted from the view-projection matrix exactly like
 *  the shader: perspective encodes it in the w-row (clip.w = view depth); ortho's w-row is zero → use the z-row. */
export function cameraForwardFromVP(viewProj: Mat4): Vec3 {
  const wvec: Vec3 = [viewProj[3], viewProj[7], viewProj[11]];
  const zvec: Vec3 = [viewProj[2], viewProj[6], viewProj[10]];
  return len3(wvec) > 1e-4 ? norm3(wvec) : norm3(zvec);
}

/** The scene as SSR sees it: a half-res world-position buffer. `sample(px, py)` returns the nearest surface's world
 *  position at that texel (what the prepass wrote), or null for background. */
export interface SSRWorldPosBuffer {
  width: number;
  height: number;
  sample(px: number, py: number): Vec3 | null;
}

export interface SSRTraceParams {
  maxSteps: number;
  stride: number;
  thickness: number;
}

export interface SSRTraceResult {
  hit: boolean;
  /** Screen UV the reflection samples its colour from (only when hit). */
  uv?: [number, number];
  /** Ray parameter of the refined hit (only when hit). */
  t?: number;
  /** REACH FADE 0..1 (only when hit): 1 for hits well inside the marched range, easing to 0 for hits in the last 25%
   *  of it. Without this, the reach limit (budget truncation or world maxDist) cuts reflections with a hard seam —
   *  a diagonal hit→cubemap boundary that reads as a clipping bug (and moves with zoom, since the budget is measured
   *  in screen texels). Fading late hits turns the seam into a gradient — reflections fade with distance. */
  reachFade?: number;
}

/** One probe along the SCREEN-SPACE line at param s ∈ [0,1] — mirrors the WGSL `ssrProbeS`.
 *  uv is linear in s (screen-space parameterization); the ray's world point is recovered projective-correctly via
 *  Q(s)/k(s) with Q = worldPos/w and k = 1/w interpolated linearly (the standard perspective-correct trick).
 *  Returns the ray's depth at s, plus the surface (if any, off-plane-validated) at that texel with its depth. */
function probeS(
  s: number, uv0: [number, number], uv1: [number, number], k0: number, k1: number, Q0: Vec3, Q1: Vec3,
  startPos: Vec3, N: Vec3, fwd: Vec3, buf: SSRWorldPosBuffer, minOffPlane: number,
): { uv: [number, number]; rayDepth: number; surfValid: boolean; surfDepth: number } {
  const uv: [number, number] = [uv0[0] + (uv1[0] - uv0[0]) * s, uv0[1] + (uv1[1] - uv0[1]) * s];
  const k = k0 + (k1 - k0) * s;
  const rayP: Vec3 = [
    (Q0[0] + (Q1[0] - Q0[0]) * s) / k,
    (Q0[1] + (Q1[1] - Q0[1]) * s) / k,
    (Q0[2] + (Q1[2] - Q0[2]) * s) / k,
  ];
  const rayDepth = dot3(fwd, rayP);
  if (uv[0] < 0 || uv[0] > 1 || uv[1] < 0 || uv[1] > 1) return { uv, rayDepth, surfValid: false, surfDepth: 0 };
  const px = Math.min(buf.width - 1, Math.max(0, Math.floor(uv[0] * buf.width)));
  const py = Math.min(buf.height - 1, Math.max(0, Math.floor(uv[1] * buf.height)));
  const sw = buf.sample(px, py);
  if (!sw) return { uv, rayDepth, surfValid: false, surfDepth: 0 };
  const offPlane = Math.abs(dot3(sub3(sw, startPos), N));   // reflector's own plane → self-hit, not a surface
  if (offPlane <= minOffPlane) return { uv, rayDepth, surfValid: false, surfDepth: 0 };
  return { uv, rayDepth, surfValid: true, surfDepth: dot3(fwd, sw) };
}

/** The full trace — mirrors WGSL `traceSSR`. SCREEN-SPACE DDA: the reflection ray is projected once, and the march
 *  walks its projected line ~one buffer texel per step with projective-correct depth. A fixed WORLD stride sampled
 *  a steeply-receding surface (e.g. a cube's top face seen at grazing reflection angles) with uneven screen spacing —
 *  acceptance flickered per fragment → striped reflections. Per-texel screen traversal tests every texel along the
 *  reflection exactly once: no phase, no stripes, and thin/grazing surfaces can't be stepped over.
 *  `startPos` = the reflective fragment's world position (unbiased), `N` its normal, `dir` the reflection vector. */
export function traceSSRRef(
  startPos: Vec3, N: Vec3, dir: Vec3, viewProj: Mat4, buf: SSRWorldPosBuffer, params: SSRTraceParams,
): SSRTraceResult {
  const stride = Math.max(params.stride, 0.001);
  const origin = add3(startPos, scale3(N, stride * 0.5));   // lift off the surface (self-hit guard)
  const fwd = cameraForwardFromVP(viewProj);
  const minOffPlane = stride * 0.25;
  const maxDist = params.maxSteps * stride;                 // world reach (same semantics as the old world march)

  // Clip the world segment so the far end stays in front of the camera (clip.w is linear along the world ray).
  let end = add3(origin, scale3(dir, maxDist));
  const c0 = transformPoint4(viewProj, origin);
  if (c0[3] <= 1e-4) return { hit: false };
  let c1 = transformPoint4(viewProj, end);
  if (c1[3] <= 1e-4) {
    const f = (c0[3] - 1e-3) / (c0[3] - c1[3]);
    end = add3(origin, scale3(dir, maxDist * f));
    c1 = transformPoint4(viewProj, end);
  }

  const uv0: [number, number] = [(c0[0] / c0[3]) * 0.5 + 0.5, (c0[1] / c0[3]) * -0.5 + 0.5];
  const uv1: [number, number] = [(c1[0] / c1[3]) * 0.5 + 0.5, (c1[1] / c1[3]) * -0.5 + 0.5];

  // Clip the s-range to the screen rect (uv is linear in s) — march only the visible portion of the line.
  let s0 = 0, s1 = 1;
  for (let axis = 0; axis < 2; axis++) {
    const a = uv0[axis], d = uv1[axis] - a;
    if (Math.abs(d) < 1e-9) {
      if (a < 0 || a > 1) return { hit: false };
    } else {
      let lo = (0 - a) / d, hi = (1 - a) / d;
      if (lo > hi) { const tmp = lo; lo = hi; hi = tmp; }
      s0 = Math.max(s0, lo); s1 = Math.min(s1, hi);
    }
  }
  if (s0 >= s1) return { hit: false };

  // STRICTLY ~1 buffer texel per step. The budget caps the REACH (how far the march goes), never the density:
  // stretching maxSteps across a long line made steps span several texels with huge perspective depth ranges — the
  // range test degenerated into a fat box and accepted any off-plane surface along the way (long smeared ghosts).
  const du = (uv1[0] - uv0[0]) * (s1 - s0) * buf.width;
  const dv = (uv1[1] - uv0[1]) * (s1 - s0) * buf.height;
  const pixLen = Math.hypot(du, dv);
  const marchTexels = Math.min(pixLen, params.maxSteps);
  const sEnd = s0 + (s1 - s0) * (marchTexels / Math.max(pixLen, 1e-6));
  const numSteps = Math.max(1, Math.ceil(marchTexels));

  // Projective-correct interpolation attributes.
  const k0 = 1 / c0[3], k1 = 1 / c1[3];
  const Q0 = scale3(origin, k0), Q1 = scale3(end, k1);

  // FRONT-SIDE-CROSSING acceptance. The world-pos buffer stores only CAMERA-FACING surfaces (nearest per pixel),
  // and the crossing DIRECTION of f = rayDepth − surfDepth carries the facing information we don't store:
  //  · front→behind (f: − → +) = the ray pushes INTO the surface from the camera side → a legitimate hit.
  //  · behind→front (f: + → −) = the ray EXITS through the surface's BACK — a face no real reflection can see
  //    (e.g. a floor ray rising up through the cube's TOP face, or a wall-mirror ray exiting an object's volume).
  //    Accepting those painted the "taller than the object" ghosts + stripes; they are rejected outright, so the
  //    impossible cases (true wall mirrors) cleanly fall back to the cubemap instead of painting garbage.
  // No depth window / thickness pad is needed: a genuine crossing is exact, and the bisection pins it.
  let prev = probeS(s0, uv0, uv1, k0, k1, Q0, Q1, startPos, N, fwd, buf, minOffPlane);
  let sPrev = s0;
  for (let i = 1; i <= numSteps; i++) {
    const s = s0 + ((sEnd - s0) * i) / numSteps;
    const cur = probeS(s, uv0, uv1, k0, k1, Q0, Q1, startPos, N, fwd, buf, minOffPlane);
    if (cur.surfValid) {
      const fA = prev.rayDepth - (prev.surfValid ? prev.surfDepth : cur.surfDepth);
      const fB = cur.rayDepth - cur.surfDepth;
      if (fA <= 0 && fB > 0) {
        // Bisect to the exact front-side crossing within this step.
        let lo = sPrev, hi = s, huv = cur.uv;
        for (let k = 0; k < 6; k++) {
          const ms = 0.5 * (lo + hi);
          const m = probeS(ms, uv0, uv1, k0, k1, Q0, Q1, startPos, N, fwd, buf, minOffPlane);
          const fm = m.surfValid ? m.rayDepth - m.surfDepth : fA;
          if (fm > 0) { hi = ms; huv = m.uv; } else { lo = ms; }
        }
        // Reach fade: hits in the last 25% of the marched range ease out (see SSRTraceResult.reachFade).
        const frac = (hi - s0) / Math.max(sEnd - s0, 1e-9);
        const reachFade = 1 - smoothstep01((frac - 0.75) / 0.25);
        return { hit: true, uv: huv, t: hi, reachFade };
      }
    }
    prev = cur;
    sPrev = s;
  }
  return { hit: false };
}
