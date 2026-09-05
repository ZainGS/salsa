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
  /** DEPTH-PEEL back layer (optional): the SECOND-nearest surface at that texel — for closed meshes, the inside of
   *  their far side. Null where fewer than two fragments exist (open/thin geometry, background). Produced on GPU by
   *  a second prepass that discards fragments at-or-in-front of the front layer. */
  sampleBack?(px: number, py: number): Vec3 | null;
}

export interface SSRTraceParams {
  maxSteps: number;
  stride: number;
  /** Near-exit band for the backface-fill (world units). ENGINE-OWNED small constant — widening it admits rays
   *  passing BEHIND objects within the band, which paint at ray-offset positions (elongated smears, not feathering). */
  thickness: number;
  /** Backface-fill EDGE FEATHER radius in half-res texels (0 = hard edge). Screen-space COVERAGE feather: each fill
   *  probes a ring in the world-pos buffer and fades by the fraction of neighbours that are on-object — a true
   *  silhouette feather with no elongation (unlike widening the depth band). */
  edgeFeather?: number;
  /** SILHOUETTE-SOLIDIFY strength 0..1 (0 = off). Fill holes come from BACK-LAYER DROPOUT: texels whose second
   *  peel layer is missing (grazing/subpixel exit faces) reject volume membership, leaving holes and serration
   *  inside otherwise-solid fill silhouettes. When on, a missing back layer is BORROWED from the immediate
   *  neighbour texels (local continuity), and fills admitted on borrowed evidence paint at this strength.
   *  (v1 was a depth-proximity "shadow" band — it smeared along rays, the trail-family geometry; membership
   *  keyed on borrowed columns keeps the EXACT silhouette instead.) Artist slider (persisted intent). */
  fallbackShadow?: number;
  /** DEPTH-PEELED backface-fill: candidates require PROVEN volume membership (front ≤ rayDepth ≤ back, from the
   *  buffer's `sampleBack` second layer) instead of the near-exit heuristic band. Kills the trail/skimmer family
   *  exactly — a ray behind an object is provably OUTSIDE its depth column — at every view angle and object scale
   *  (the three heuristic guards each failed one of those axes). Texels with NO back layer (open/thin geometry)
   *  fall back to the old thickness shell WITH the squared depth feather, so planes keep a soft fill.
   *  false/absent = single-layer heuristic (the engine escape hatch — setSSRDepthPeeling3D(false)). */
  depthPeel?: boolean;
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
  /** True when this is a BACKFACE-FILL hit (the "object thickness" approximation): no front-side crossing existed,
   *  so the first BACK-EXIT crossing (the ray leaving through a camera-facing surface) is used as a stand-in for the
   *  never-rendered mirror-facing side — the reflection shows the object's front-face colours at approximately the
   *  right place (exact for thin objects) instead of a hole. Painted faded + blurred by the shader. */
  backfill?: boolean;
  /** True when this fill was admitted on BORROWED back-layer evidence (dropout hole-filling — see
   *  fallbackShadow). Painted at fallbackShadow strength. */
  shadow?: boolean;
  /** Fill-strength gate 0..1 (only when backfill): rises as the reflected ray heads back TOWARD the camera —
   *  precisely the geometry where a reflection shows backsides (wall mirrors, steep look-down floors). Rays heading
   *  away from the camera (glancing floors) keep the gate closed, so the back-exit ghost family (the
   *  "taller-than-the-object" artifact) cannot return there. */
  backfillFade?: number;
}

/** One probe along the SCREEN-SPACE line at param s ∈ [0,1] — mirrors the WGSL `ssrProbeS`.
 *  uv is linear in s (screen-space parameterization); the ray's world point is recovered projective-correctly via
 *  Q(s)/k(s) with Q = worldPos/w and k = 1/w interpolated linearly (the standard perspective-correct trick).
 *  Returns the ray's depth at s, plus the surface (if any, off-plane-validated) at that texel with its depth. */
function probeS(
  s: number, uv0: [number, number], uv1: [number, number], k0: number, k1: number, Q0: Vec3, Q1: Vec3,
  startPos: Vec3, N: Vec3, fwd: Vec3, buf: SSRWorldPosBuffer, minOffPlane: number, borrow = false,
): { uv: [number, number]; rayDepth: number; surfValid: boolean; surfDepth: number; backDepth: number; backBorrowed: boolean; rayP: Vec3; surfPos: Vec3 | null } {
  const uv: [number, number] = [uv0[0] + (uv1[0] - uv0[0]) * s, uv0[1] + (uv1[1] - uv0[1]) * s];
  const k = k0 + (k1 - k0) * s;
  const rayP: Vec3 = [
    (Q0[0] + (Q1[0] - Q0[0]) * s) / k,
    (Q0[1] + (Q1[1] - Q0[1]) * s) / k,
    (Q0[2] + (Q1[2] - Q0[2]) * s) / k,
  ];
  const rayDepth = dot3(fwd, rayP);
  if (uv[0] < 0 || uv[0] > 1 || uv[1] < 0 || uv[1] > 1) return { uv, rayDepth, surfValid: false, surfDepth: 0, backDepth: -Infinity, backBorrowed: false, rayP, surfPos: null };
  const px = Math.min(buf.width - 1, Math.max(0, Math.floor(uv[0] * buf.width)));
  const py = Math.min(buf.height - 1, Math.max(0, Math.floor(uv[1] * buf.height)));
  const sw = buf.sample(px, py);
  if (!sw) return { uv, rayDepth, surfValid: false, surfDepth: 0, backDepth: -Infinity, backBorrowed: false, rayP, surfPos: null };
  const offPlane = Math.abs(dot3(sub3(sw, startPos), N));   // reflector's own plane → self-hit, not a surface
  if (offPlane <= minOffPlane) return { uv, rayDepth, surfValid: false, surfDepth: 0, backDepth: -Infinity, backBorrowed: false, rayP, surfPos: null };
  // rayP + surfPos are returned for the primary path's OVER-PASS validation (Euclidean check at the crossing).
  // Depth-peel back layer: −Infinity = no second surface at this texel (open geometry / peel disabled).
  // The REFLECTOR'S OWN PLANE is rejected as a back layer too: at silhouette-edge texels an object's true exit
  // fragment can be missing (a nearly edge-on face rasterizes to nothing at half-res), leaving the scene BEHIND
  // as the second layer — a degenerate [object-front → reflector] depth column that admits deep rays and paints
  // thin straight LINES of false fills across the mirror. A mirror cannot be an object's back face.
  const bw = buf.sampleBack?.(px, py) ?? null;
  const backOk = bw && Math.abs(dot3(sub3(bw, startPos), N)) > minOffPlane;
  let backDepth = backOk ? dot3(fwd, bw!) : -Infinity;
  let backBorrowed = false;
  // BACK-LAYER BORROWING (fallbackShadow > 0): a missing second layer at an ON-OBJECT texel is dropout (a
  // grazing/subpixel exit face) — borrow the shallowest valid neighbour back (local continuity). Fills admitted
  // on borrowed evidence are flagged and painted at fallbackShadow strength. Only on-object texels reach here,
  // so the extra taps cost nothing on background.
  if (borrow && backDepth === -Infinity && buf.sampleBack) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nb = buf.sampleBack(
        Math.min(buf.width - 1, Math.max(0, px + dx)),
        Math.min(buf.height - 1, Math.max(0, py + dy)),
      );
      if (!nb || Math.abs(dot3(sub3(nb, startPos), N)) <= minOffPlane) continue;
      const nd = dot3(fwd, nb);
      if (backDepth === -Infinity || nd < backDepth) { backDepth = nd; backBorrowed = true; }
    }
  }
  return { uv, rayDepth, surfValid: true, surfDepth: dot3(fwd, sw), backDepth, backBorrowed, rayP, surfPos: sw };
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
  // BACKFACE-FILL gate: the fill only arms when the reflected ray heads back TOWARD the camera (see
  // SSRTraceResult.backfillFade). toCam ≈ 1 for wall mirrors facing the viewer, ≤ 0 for glancing floor rays.
  const toCam = -dot3(dir, fwd);
  const peel = !!params.depthPeel;
  // Direction gate: blocks the back-exit ghost family on rays heading AWAY from the camera (glancing floors).
  // PEEL mode arms almost immediately — volume-membership proof does the legitimacy work, and the conservative
  // ramp (0.15..0.45) translucent-washed ENTIRE fills at 30-45° mirror views: ungated primary hits kept the rims
  // bright while the gated interior washed out = the "hollow at angles" look. The single-layer heuristic keeps
  // the conservative ramp (without membership proof the gate is its main defence).
  const backGate = peel ? smoothstep01((toCam - 0.02) / 0.1) : smoothstep01((toCam - 0.15) / 0.3);
  // Back-layer slack: tolerates the peel buffer's half-res depth quantization WITHOUT re-creating a depth band —
  // a generous slack re-admits thin-object skimmers, the very trail family the peel exists to kill. The BASE is
  // tight; each march step widens it by the LOCAL back-depth gradient (see epsB in the loop): on steeply-receding
  // back surfaces (sphere limbs, oblique views) the per-texel depth change dwarfs the base slack and a fixed
  // tolerance makes membership flicker per texel (hatched/serrated fills). Capped so an object-boundary JUMP in
  // the back layer can't blow the test open.
  const epsB0 = stride * 0.25;
  const T = Math.max(params.thickness, 1e-4);
  const borrow = (params.fallbackShadow ?? 0) > 0;
  let cand: { uv: [number, number]; s: number; fB: number; shell: boolean; borrowed: boolean } | null = null;
  let candLocked = false;   // candidate stops upgrading once its surface region ends (or an exact exit was found)

  let prev = probeS(s0, uv0, uv1, k0, k1, Q0, Q1, startPos, N, fwd, buf, minOffPlane, borrow);
  let sPrev = s0;
  for (let i = 1; i <= numSteps; i++) {
    const s = s0 + ((sEnd - s0) * i) / numSteps;
    const cur = probeS(s, uv0, uv1, k0, k1, Q0, Q1, startPos, N, fwd, buf, minOffPlane, borrow);
    if (cur.surfValid) {
      const fA = prev.rayDepth - (prev.surfValid ? prev.surfDepth : cur.surfDepth);
      const fB = cur.rayDepth - cur.surfDepth;
      if (fA <= 0 && fB > 0) {
        // Bisect to the exact front-side crossing within this step (track the behind-side probe for validation).
        let lo = sPrev, hi = s, huv = cur.uv, mBehind = cur;
        for (let k = 0; k < 6; k++) {
          const ms = 0.5 * (lo + hi);
          const m = probeS(ms, uv0, uv1, k0, k1, Q0, Q1, startPos, N, fwd, buf, minOffPlane, borrow);
          const fm = m.surfValid ? m.rayDepth - m.surfDepth : fA;
          if (fm > 0) { hi = ms; huv = m.uv; mBehind = m; } else { lo = ms; }
        }
        // OVER-PASS VALIDATION (Euclidean, slope-aware): a depth-crossing only proves the ray entered this
        // texel's depth COLUMN, not that it touched the surface — a shallow away-heading floor ray passing
        // OVER an object crosses its column inside the silhouette too (debug-confirmed: the long "stretched
        // column" ghosts trailing floor reflections were all primary hits). A genuine hit's ray point
        // coincides with the stored surface point to within texel quantization; an over-passer is offset by
        // the object's own scale. The radius scales with the surface's LOCAL world-per-texel, so steeply
        // receding surfaces (grazing cube tops) stay accepted. (Rule 3 bans Euclidean as the MARCH acceptance
        // test — per-texel flicker; this is a post-hoc validation of a single crossing, radius >> one texel.)
        const hitProbe = probeS(hi, uv0, uv1, k0, k1, Q0, Q1, startPos, N, fwd, buf, minOffPlane, borrow);
        const surfStep = prev.surfPos && cur.surfPos ? len3(sub3(cur.surfPos, prev.surfPos)) : 0;
        const allow = Math.max(3 * surfStep, 2 * stride);
        const euclidOK = !!hitProbe.surfPos && len3(sub3(hitProbe.rayP, hitProbe.surfPos)) <= allow;
        // COLUMN-ENTRY validation (the Euclidean check's complement): the slope-scaled radius above is exactly
        // as loose as the surface is steep — a STEEP texel (sphere limb) accepts over-passers by Euclid alone
        // (the sphere-over-cube-top column regression). But steep silhouette texels have near-ZERO depth columns:
        // a genuine entrant sits inside [front, back] just past the crossing; a skimmer is already beyond the
        // back. Conversely, over-passers above FLAT deep columns (cube tops) pass membership but fail Euclid.
        // Each ghost family fails one check; a real hit passes both.
        const pSlope = cur.backDepth !== -Infinity && prev.backDepth !== -Infinity
          ? Math.abs(cur.backDepth - prev.backDepth) : 0;
        const entryBack = mBehind.backDepth === -Infinity ? mBehind.surfDepth + T : mBehind.backDepth;
        const epsP = Math.max(epsB0, Math.min(pSlope * 0.75, stride * 2, Math.max(0, (entryBack - mBehind.surfDepth) * 0.5)));
        const memberOK = mBehind.surfValid && mBehind.rayDepth <= entryBack + epsP;
        if (euclidOK && memberOK) {
          // Reach fade: hits in the last 25% of the marched range ease out (see SSRTraceResult.reachFade).
          const frac = (hi - s0) / Math.max(sEnd - s0, 1e-9);
          const reachFade = 1 - smoothstep01((frac - 0.75) / 0.25);
          return { hit: true, uv: huv, t: hi, reachFade };
        }
        // Over-passer: not a hit — keep marching (the ray may genuinely strike something farther along).
      }
      if (backGate > 0 && !candLocked) {
        if (peel) {
          // DEPTH-PEELED backface-fill: a candidate needs PROVEN volume membership — front ≤ rayDepth ≤ back(+eps).
          // Texels with no back layer (open/thin geometry) substitute a thickness shell (marked `shell` → the
          // squared depth feather still applies to them; proven members paint full strength).
          const slope = cur.backDepth !== -Infinity && prev.backDepth !== -Infinity
            ? Math.abs(cur.backDepth - prev.backDepth) : 0;
          // Slope widening is CLAMPED to half the local column depth: near an object's silhouette the column
          // shrinks to zero while the back-layer gradient SPIKES — an uncapped widening there admitted rays
          // passing just OUTSIDE the object (under-object pass-bys from an elevated camera = tall curtain smears
          // hanging off wall-mirror fills). Widening beyond the column's own scale is never evidence.
          const epsFor = (front: number, back: number): number =>
            Math.max(epsB0, Math.min(slope * 0.75, stride * 2, Math.max(0, (back - front) * 0.5)));
          if (fA > 0 && fB <= 0) {
            // The ray pierced the front surface from behind. Bisect to the exact exit, then VALIDATE the pierce with
            // the last BEHIND-side probe: a genuine pierce is inside the volume just before the crossing; a texel-
            // boundary fake (ray behind object A while the next texel shows nearer object B) is beyond A's back
            // there. This also accepts one-step full pierces of thin volumes (prev sample beyond the back).
            let lo = sPrev, hi = s, huv = cur.uv, mLo = prev;
            for (let k = 0; k < 6; k++) {
              const ms = 0.5 * (lo + hi);
              const m = probeS(ms, uv0, uv1, k0, k1, Q0, Q1, startPos, N, fwd, buf, minOffPlane, borrow);
              const fm = m.surfValid ? m.rayDepth - m.surfDepth : fA;
              if (fm > 0) { lo = ms; mLo = m; } else { hi = ms; huv = m.uv; }
            }
            const loBack = mLo.backDepth === -Infinity ? mLo.surfDepth + T : mLo.backDepth;
            const genuine = mLo.surfValid && mLo.rayDepth - mLo.surfDepth > 0 && mLo.rayDepth <= loBack + epsFor(mLo.surfDepth, loBack);
            if (genuine) { cand = { uv: huv, s: hi, fB: 0, shell: false, borrowed: mLo.backBorrowed }; candLocked = true; }
          } else if (fB > 0) {
            const shell = cur.backDepth === -Infinity;
            const effBack = shell ? cur.surfDepth + T : cur.backDepth;
            if (cur.rayDepth <= effBack + epsFor(cur.surfDepth, effBack) && (!cand || fB < cand.fB)) {
              cand = { uv: cur.uv, s, fB, shell, borrowed: cur.backBorrowed };   // in-volume sample (covers exits via camera-invisible faces)
            }
          }
        } else if (fA > 0 && fB <= params.thickness) {
          // SINGLE-LAYER heuristic (escape hatch): BACK-EXIT (ray leaving through a camera-facing surface) OR
          // NEAR-EXIT (within `thickness` behind it). The candidate UPGRADES while the ray keeps approaching the
          // surface (fB shrinking) and locks at an exact exit — otherwise the band's outer edge would claim the fill
          // with a weak feather even though a full-strength exit comes a few samples later. The near-exit path
          // soft-fills grazing silhouettes (sphere limbs) where the exact sign flip flickers with half-res
          // quantization — at the cost of the tangent-skimmer TRAIL family the depth feather can only dim.
          if (fB <= 0) {
            let lo = sPrev, hi = s, huv = cur.uv;
            for (let k = 0; k < 6; k++) {
              const ms = 0.5 * (lo + hi);
              const m = probeS(ms, uv0, uv1, k0, k1, Q0, Q1, startPos, N, fwd, buf, minOffPlane, borrow);
              const fm = m.surfValid ? m.rayDepth - m.surfDepth : fA;
              if (fm > 0) { lo = ms; } else { hi = ms; huv = m.uv; }
            }
            cand = { uv: huv, s: hi, fB: 0, shell: true, borrowed: false };
            candLocked = true;
          } else if (!cand || fB < cand.fB) {
            cand = { uv: cur.uv, s, fB, shell: true, borrowed: false };   // near-exit: sample as-is; fB drives the depth feather below
          }
        }
      }
    } else if (cand && !candLocked) {
      candLocked = true;                 // left the candidate's surface region — no closer approach is coming
    }
    prev = cur;
    sPrev = s;
  }
  if (cand) {
    const frac = (cand.s - s0) / Math.max(sEnd - s0, 1e-9);
    const reachFade = 1 - smoothstep01((frac - 0.75) / 0.25);
    // Depth feather (SQUARED), SHELL candidates only: without a back layer, trails and shallow volume passages are
    // a continuum no scalar separates (three guard designs each failed a case) — the feather dims the band's outer
    // edge. PROVEN volume members (depth-peel, shell=false) paint full strength: their legitimacy is exact.
    let depthFeather = 1;
    if (cand.shell) {
      const df = 1 - smoothstep01(Math.max(cand.fB, 0) / T);
      depthFeather = df * df;
    }
    // SCREEN-SPACE COVERAGE feather (the Edge-Feather slider): probe a ring around the fill uv in the world-pos
    // buffer; alpha follows the fraction of neighbours that are on-object. Interior = solid, silhouette = smooth
    // falloff across the ring radius. Mirrors the WGSL.
    let coverage = 1;
    const r = params.edgeFeather ?? 0;
    if (r > 0) {
      let on = 0;
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        const tu = cand.uv[0] + (r * Math.cos(a)) / buf.width;
        const tv = cand.uv[1] + (r * Math.sin(a)) / buf.height;
        if (tu < 0 || tu > 1 || tv < 0 || tv > 1) continue;
        const sw = buf.sample(
          Math.min(buf.width - 1, Math.max(0, Math.floor(tu * buf.width))),
          Math.min(buf.height - 1, Math.max(0, Math.floor(tv * buf.height))),
        );
        if (sw && Math.abs(dot3(sub3(sw, startPos), N)) > minOffPlane) on++;
      }
      coverage = smoothstep01((on / 8 - 0.35) / 0.6);   // slider-driven edge feather
    }
    // Borrowed-evidence fills paint at fallbackShadow strength (the artist's solidify slider).
    const borrowScale = cand.borrowed ? Math.max(0, Math.min(1, params.fallbackShadow ?? 0)) : 1;
    return { hit: true, uv: cand.uv, t: cand.s, reachFade, backfill: true, shadow: cand.borrowed || undefined, backfillFade: backGate * depthFeather * coverage * borrowScale };
  }
  return { hit: false };
}
