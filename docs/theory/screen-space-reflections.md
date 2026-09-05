# Screen-Space Reflections
**Last Updated:** 2026-09-04

How SSR works, the exact algorithm Salsa ships, and — most valuably — the boundaries of the technique, each one learned the hard way during a multi-day debugging campaign whose artifacts are now locked behind regression tests.

---

## Intuition

A reflective surface shows "what's over there." Ray tracing answers that by intersecting rays against scene geometry — expensive. SSR's bargain: the frame *already contains* a picture of the scene (the rendered image) and a record of where every pixel's surface sits (a depth or position buffer). So reflect the view ray off the surface, march it through that *screen-space* record, and where the ray meets a recorded surface, reuse that pixel's color as the reflection.

The bargain's fine print is the whole subject: **the buffers only contain what the camera saw, from where the camera saw it.** Every SSR artifact and limitation traces back to that sentence.

---

## Mental Model

Think of the screen as a **relief map**: at each pixel, the buffer stores how far away the surface is (Salsa stores full world positions). The reflection ray is a wire bent off the reflective surface, flying over this relief. The trace slides along the wire, comparing the wire's height (depth) against the relief below it. Where the wire dips *into* the relief — a **crossing** — the reflection shows that pixel's color.

Three properties follow immediately:

1. **You can only hit what's on the map.** Off-screen content, occluded content, and the *far sides of objects* were never recorded. No trace, however correct, can reflect them.
2. **The map has one layer.** One surface per pixel — the nearest. Behind it, the map knows nothing.
3. **The comparison happens per pixel, in depth.** So the sampling pattern (which pixels get tested, and how depth is interpolated between them) decides the artifact profile.

---

## Formal Explanation — Salsa's trace, decision by decision

The shipped trace (`traceSSR` in `mesh3d-shaders.ts`, CPU twin in `ssr-trace.ts`) is a **screen-space DDA** with these components, each one the survivor of a failed alternative:

**Screen-space DDA, ~1 texel per step (not world-space marching).** Project the reflection ray's segment once, clip it to the screen (Liang-Barsky in the screen-linear parameter), then walk the projected line about one buffer texel per step. World-space stepping projects to *uneven* screen spacing — dense here, sparse there — so acceptance flickers with sub-stride phase and paints banded, staggered copies of small objects. Per-texel traversal tests every texel exactly once: nothing to alias.

**Projective-correct depth along the line.** Interpolate `Q = worldPos/w` and `k = 1/w` linearly in the screen parameter; the ray's world point at any sample is `Q/k`. This is the same trick as perspective-correct texture mapping, and it degrades cleanly to ortho (where `w ≡ 1`).

**The budget caps *reach*, never density.** With a fixed step budget and a long projected line, the tempting move is stretching the budget across the whole line — but multi-texel steps sweep huge depth ranges near the perspective-compressed end and acceptance degenerates into a fat box (long smeared ghosts). Salsa instead truncates: the march covers at most `ssrMaxSteps` texels at ~1 texel each. Reflections have finite reach; beyond it, the cubemap fallback takes over.

**Depth-only comparison (never Euclidean distance).** The world-pos buffer is half-res: the stored surface point can sit laterally up to a texel away from the ray's exact footprint. A Euclidean `|rayPoint − surfacePoint|` test folds that lateral quantization into the result and oscillates per texel (screen-door stripes). Comparing *depth at this pixel* — `dot(fwd, rayPoint − surfacePoint)` along the camera axis — is immune to lateral error by construction. The camera axis comes from the view-projection matrix itself (perspective: the w-row; ortho: the z-row).

**Front-side crossings only — the facing rule.** The buffer stores only camera-facing surfaces, and stores no normals. But the *crossing direction* of `f = rayDepth − surfDepth` recovers the facing: `f: − → +` means the ray pushed into the surface from the camera side (a legitimate hit); `f: + → −` means the ray **exited through the surface's back** — a face no real reflection could show. Accepting back-exits painted reflections *taller than the object* (a floor ray rising up through a cube's top face) and wall-mirror volume-exit ghosts. Rejecting them makes impossible cases fail *cleanly* (cubemap fallback) instead of wrongly.

**Bisection refinement.** On acceptance, six bisection steps inside the single step that found the crossing pin it exactly — sharp reflections without global searching (a *global* crossing search, tried early, fired at object/mirror boundaries and spawned ghost copies; refinement must stay local to a validated hit).

**Self-hit guards.** The ray origin is lifted off the surface by half a stride along the normal, and any hit lying essentially *in the start fragment's own plane* is rejected (a planar reflector cannot see its own plane; such "hits" are quantization self-hits). Without this, the reflector samples *its own previous-frame pixels* — which already contain its rendered reflection — and each frame re-paints the reflection at an offset: a **feedback echo**, a trail of progressively fainter copies. The epsilon must be tiny and measured from the unbiased start; an early too-fat version swallowed legitimate reflections of near-coplanar objects.

**The depth-peel back layer — the backface-fill's exactness.** A wall mirror must show the backs of objects: rays entering an object's volume from the mirror side. With only the front depth layer, "is this ray inside the object?" is unanswerable — a tangent skimmer 0.1 behind a sphere and a ray clipping 0.1 *through* its edge are locally identical, so every heuristic guard (silhouette-ring coverage, screen-space dwell, passage depth) failed a view angle or object scale; the families form a continuum. A second prepass keeping the **second-nearest** surface (discard fragments at-or-in-front of the front layer, then depth-test 'less' — *not* "farthest", which grabs the wall behind an object and readmits trails) makes membership exact: `front ≤ rayDepth ≤ back` per texel. Trails become geometrically impossible for closed meshes; exit pierces are validated by checking membership just behind the crossing (kills texel-boundary fakes); texels with no second layer (open geometry) fall back to a thickness shell with a strong feather. Lesson: when a discriminator keeps failing in *different* ways per iteration, the missing ingredient is usually **data**, not a cleverer function of the data you have.

**The temporal contract.** SSR samples the *previous frame's* color (the current frame doesn't exist yet). On a render-on-demand loop this has a trap: the last frame of an interaction freezes on screen showing a reflection of the *second-to-last* (mid-motion) frame — recursively containing earlier frames — a ghost trail that persists at rest because nothing renders again. Salsa schedules exactly **one settle frame** after any SSR frame (self-limiting: the settle frame doesn't reschedule), so the grab converges the moment interaction stops.

---

## Why It Matters

SSR is the cheapest way to make floors, wet streets, and glossy surfaces reflect the *actual scene* — one prepass plus a per-fragment march, reusing buffers that already exist (Salsa: the SSAO world-position prepass and the glass-refraction color grab). It composites *over* image-based lighting: ray hits show scene color; misses fall back to the prefiltered sky cubemap. That hybrid — SSR where data exists, IBL where it doesn't — is the standard production structure.

---

## Where the Mental Model Breaks

These are the technique's *boundaries* — no trace correctness moves them.

**Back faces don't exist.** A wall mirror facing the camera must show the sides of objects *facing the mirror* — i.e. facing away from the camera. Those surfaces were never rasterized into any buffer; their colors don't exist anywhere. Salsa ships the standard mitigation — the **backface-fill** ("object thickness") approximation: when no front-side crossing exists, the first *back-exit* crossing stands in, painting the object's **front-face colors** at the silhouette position (exact for thin objects, increasingly wrong for thick ones), deliberately faded and blurred so it reads as soft presence. It is **fallback-only** (a real hit always wins) and **direction-gated** (arms only when the reflected ray heads back toward the camera) — the gate is what keeps this from resurrecting the "taller than the object" back-exit ghosts on glancing floor rays, which are the *same mechanism* pointed at the wrong geometry. The fill approximates shading it cannot know; a *pixel-exact* mirror needs a planar reflection: render the scene again from the camera reflected across the mirror plane — that render sees back faces natively (see `planar-reflection.ts`; the sampling contract `project(VP·M, P) = project(VP, F)` makes the second render line up with the main view pixel-for-pixel).

**Content is camera-view content.** Even a *working* floor reflection shows objects' camera-facing sides, not the undersides a real mirror would show. For rough/glossy floors nobody notices; for sharp mirrors it reads wrong. Same fix: planar.

**View geometry sets difficulty.** A floor-reflected ray's depth motion is `cos(2φ)` for camera elevation φ: strong at ground-level game angles, weak at high angles. Weak depth motion isn't fatal — the *surface's own* depth gradient still provides discrimination for front-side crossings — but it shrinks margins against buffer quantization; artifacts concentrate at steep, view-aligned configurations. (An interim fix faded SSR by view angle; the front-side-crossing rule made it unnecessary and it was removed — fading by angle threw away reflections that the facing rule renders correctly.)

**One frame late, finite reach, half resolution.** Reflections lag one frame (invisible in motion, handled at rest by the settle frame), stop at the reach cap, and inherit the world-pos buffer's half resolution (slight edge jaggies).

---

## Common Confusions

**"The reflection moves the same way as the object — that must be a bug."**
Only motion *perpendicular* to the reflecting plane flips in a mirror; motion *parallel* to the plane tracks the same direction. And SSR's positions are provably standard mirror optics (Salsa's tests assert hits land at the analytic virtual-image position). What *looked* like reversed motion during debugging was ghost copies confusing the read.

**"More thickness/steps will fix the artifact."**
Almost never. Every major artifact in Salsa's campaign was structural — wrong comparison space, wrong step domain, wrong facing semantics, feedback through time — and tuning either hid one symptom or amplified another (tightening thickness *worsened* the Euclidean-distance stripes). Identify the mechanism first.

**"SSR is broken; engines wouldn't ship this."**
Shipped SSR lives inside guardrails: perspective cameras at gameplay angles, hierarchical full-res traces, temporal denoising, and *aggressive fallback* where data runs out. The technique is genuinely narrow; production quality comes from staying inside its lane and failing gracefully outside it.

**"Persisted quality settings are harmless."**
Saving the ray-march tuning into documents meant every improvement to the defaults was silently overridden on reload — old documents kept reproducing fixed bugs. Engine-owned tuning should not round-trip through user documents; Salsa's restore now keeps only intent (on/off, intensity, cutoff) and always applies current engine tuning.

---

## How Salsa Uses It

`src/renderer/3d/ssr-trace.ts` — the CPU reference implementation, param-for-param with the WGSL. **All SSR changes go here first**: `ssr-trace.test.ts` validates against analytic mirror optics (virtual-image construction) over synthetic scenes rasterized into a half-res world-pos buffer — hit positions, zero-ghost sweeps, grazing coverage, footprint non-inflation, wall-mirror clean fallback — then the logic is ported to `traceSSR`/`ssrProbeS` in `mesh3d-shaders.ts` (kept in lockstep; both files say so).

Inputs reused from existing machinery: the SSAO world-position prepass (`ssao-pass.ts`, runs when SSR *or* SSAO is on; the AO computation stays SSAO-only) and the previous-frame color grab (`webgpu-renderer.ts`, originally for glass refraction — also where the SSR settle frame is scheduled). Group-0 binding 10 carries the world-pos buffer; the prepass itself binds a dummy there (it *writes* the real one — no read/write aliasing). SSR params live in the IBL uniform; host API `setSSR3D`/`getReflections3D`; enabled off by default, degenerate cases fall back to the prefiltered sky cubemap from the environment system.

The campaign that produced all of this: staggered copies (world-stride banding + feedback echo), screen-door stripes (Euclidean thickness), vanished reflections (over-aggressive plane rejection), extruded/inset smears (adaptive-window blowup on view-aligned rays), even-longer smears (budget stretching), too-tall striped columns (back-exit hits) — each mechanism identified, fixed at the root, and pinned by a named regression test. The meta-lesson is the method: **when GPU code can't be observed, build a CPU twin and prove it against analytic ground truth** — screenshot-roundtrip debugging does not converge.

---

## Related Concepts

- [Environment Lighting & Reflections](environment-lighting-and-reflections.md) — the cubemap/IBL system SSR composites over; the fallback everywhere SSR runs out of data
- [Depth Buffers](depth-buffers.md) — the single-layer "relief map" SSR marches against, and why one-surface-per-pixel is the core constraint
- [GPU Data Layout & the Struct Contract](gpu-data-layout-and-the-struct-contract.md) — the IBL uniform block the SSR params ride in
- [Coordinate Spaces](coordinate-spaces.md) — the projective-correct interpolation (`worldPos/w`, `1/w`) is the same math as perspective-correct attribute interpolation
