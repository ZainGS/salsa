/**
 * P11 (docs/specs/performance-plan.md): the honest per-pass split of a frame's submitted triangles / draw calls, for
 * the perf HUDs (Scene3DManager.getRenderStats3D `drawn`, the city Performance panel).
 *
 * Source: Renderer3D.getFrameStats3D's `pass*` counters (filled in _drawMesh by the pass it records into) plus the
 * skinned main-pass triangles. Shadow maps are throttled and cached, so a frame usually renders none of them; the
 * HUD's `shadow` uses the LAST render of each map (what the GPU draws whenever it refreshes), `shadowThisFrame` the
 * literal per-frame value.
 */

export interface PassFrameCounters {
  passMainDraws: number; passMainTris: number;
  passFarShadowDraws: number; passFarShadowTris: number;
  passCascadeDraws: number; passCascadeTris: number;
  passOutlineDraws: number; passOutlineTris: number;
  passPrepassDraws: number; passPrepassTris: number;
  passPlanarDraws: number; passPlanarTris: number;
  passOtherDraws: number; passOtherTris: number;
  passFarShadowLastDraws: number; passFarShadowLastTris: number;
  passCascadeLastDraws: number; passCascadeLastTris: number;
  skinnedTris: number; skinnedDrawn: number;
  trisVisible: number;
}

export interface PassSplit {
  /** The colour pass: static meshes (opaque + transparent) + the skinned characters. What is on screen. */
  main: number;
  /** Shadow maps: the far map + the near cascades, each at its last refresh. */
  shadow: number;
  /** The other depth / G-buffer passes: outline depth-normal, SSAO / SSR prepass (+ depth peel), planar mirror, overlays. */
  other: number;
  /** main + shadow + other. */
  total: number;
  /** Shadow triangles literally submitted THIS frame (0 on a frame whose maps were cached / throttled). */
  shadowThisFrame: number;
  /** Per pass detail. */
  passes: { main: number; skinned: number; farShadow: number; cascades: number; outline: number; prepass: number; planar: number; overlays: number };
}

export function splitPassStats(f: PassFrameCounters): { tris: PassSplit; draws: PassSplit } {
  const mk = (main: number, skinned: number, far: number, casc: number, farNow: number, cascNow: number,
              outline: number, prepass: number, planar: number, overlays: number): PassSplit => {
    const m = main + skinned, sh = far + casc, o = outline + prepass + planar + overlays;
    return { main: m, shadow: sh, other: o, total: m + sh + o, shadowThisFrame: farNow + cascNow,
      passes: { main, skinned, farShadow: far, cascades: casc, outline, prepass, planar, overlays } };
  };
  return {
    tris: mk(f.passMainTris, f.skinnedTris, f.passFarShadowLastTris, f.passCascadeLastTris, f.passFarShadowTris, f.passCascadeTris,
      f.passOutlineTris, f.passPrepassTris, f.passPlanarTris, f.passOtherTris),
    draws: mk(f.passMainDraws, f.skinnedDrawn, f.passFarShadowLastDraws, f.passCascadeLastDraws, f.passFarShadowDraws, f.passCascadeDraws,
      f.passOutlineDraws, f.passPrepassDraws, f.passPlanarDraws, f.passOtherDraws),
  };
}
