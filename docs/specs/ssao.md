# SSAO — Screen-Space Ambient Occlusion

**Status:** 📋 spec (2026-07-30) → building v1. Realises [city-visual-upgrade.md](./city-visual-upgrade.md) §2A
("SSAO, flagged future"). **Companion:** memory `project_lighting_shadows` (shadows/lighting scope), `project_audit_2026_07`
(uber-shader cost caveat).

## Why
AO darkens creases, contact points, and cavities — the cues that make dense detail read as *placed in the world* rather
than floating. It's the highest-leverage remaining city-polish item: window trim, rooftop clutter (tanks/AC/pipes),
awnings, and every scattered prop currently lack contact grounding. It compounds with the camera-following shadows
(Fix C): the shadow map handles *direct-sun* occlusion at building scale; AO fills the *small-scale, indirect* occlusion
the 2048-texel map can't resolve. Screen-space (not baked) is mandatory here — the city regenerates and streams
constantly, so per-asset baked AO fights the model; SSAO is view-space and covers all detail at any LOD for free.

## The one non-negotiable correctness rule
**AO multiplies the AMBIENT term only, never the full lit result.** AO approximates occlusion of *indirect* light;
the direct sun is already occluded by the shadow map. Multiplying the composite double-darkens creases the shadow map
already handles. In this renderer the ambient term exists **only inside the mesh (uber) shader** — the `PostProcessPass`
sees fully-composited color and cannot separate ambient from direct without an MRT ambient buffer (which we're avoiding).

**Therefore AO is applied *in the mesh fragment shader*, not composited in post.** Concretely, the single injection is at
[mesh3d-shaders.ts](../../src/renderer/3d/shaders/mesh3d-shaders.ts) `lit = directLight + ambient + emissiveRGB` →
`lit = directLight + ambient * ao + emissiveRGB` (main PBR FS ~L1749; the skinned FS has the twin site ~L2331). This
choice also **automatically satisfies the ordering requirement** (raised in review): AO lands in the color pass, which is
strictly *before* bloom and tonemapping — so darkened creases never emit bloom (no "glowing shadows"). No post-stack
reordering needed; bloom/grade/vignette stay exactly as they are.

## Architecture — passes (per frame, only when SSAO on)
Because AO is sampled in the color pass, it must be ready *before* it. That means a depth prepass:

1. **Depth prepass** → `_aoDepthTex` (`r32float`, full-res). Renders the merged scene geometry with a position-only VS
   and a minimal FS that writes **linear view-space Z** (not clip depth — linear Z reconstructs view positions cleanly).
   Reuses the shadow pass's geometry-iteration shape (a second cheap pass; the FS is trivial vs the uber-shader).
   *Side benefit:* this is also an early-Z source — a later optimization can switch the main pass to `depthCompare:'equal'`
   to cut uber-shader overdraw, partially paying back the prepass cost (noted, not in v1).
2. **AO pass** → `_aoRawTex` (`r8unorm`). Fullscreen. From `_aoDepthTex`: reconstruct view position per pixel, reconstruct
   the normal (see below), sample a hemisphere kernel (rotated per-pixel by a hashed angle), accumulate occlusion with a
   range check, write AO ∈ [0,1]. `radius`, `intensity`, `bias`, `power` are uniforms.
3. **Bilateral blur** → `_aoBlurTex` (`r8unorm`). Fullscreen (or separable H/V). **Depth-aware** (below).
4. **Main color pass** samples `_aoBlurTex` at the fragment's screen-UV and multiplies `ambient`. When SSAO is off the
   binding points at a **1×1 white texture** (AO=1 → exact no-op), same pattern as the GARP blank layer.
5. **Post** (`PostProcessPass`) unchanged, runs after — AO is already baked into `ambient`, so bloom sees correct color.

### The four review requirements, as first-class design
1. **Improved normal reconstruction — mandatory.** Naive `dpdx/dpdy` on reconstructed view positions produces bright
   halos (visible outlines) at depth discontinuities (building silhouettes). Instead: sample depth at **±1 texel in x and
   y**, and for each axis pick the neighbor **closer in depth** to center before forming the tangent, then
   `normal = normalize(cross(dpdxBest, dpdyBest))`. A few extra taps; the difference between clean edges and outlined
   buildings.
2. **Depth-aware everywhere near/far surfaces meet.** The blur weights each tap by `exp(-|Δdepth|·k)` (or a hard depth
   threshold) so AO from a near surface can't bleed onto a far one. When v1.1 drops the AO compute to **half-res**, the
   **upsample is likewise depth-aware** (weight the 4 half-res taps by depth similarity to the full-res fragment's own
   view-Z) — same failure mode, same guard.
3. **Debug view — required to verify.** `setSSAODebug3D(on)` renders `_aoBlurTex` straight to the swapchain (a fullscreen
   blit). Composited into ambient, a *wrong* AO term just reads as "slightly dimmer" and looks fine — the raw buffer is the
   only way to tell correct occlusion from broken. This ships in v1, not as an afterthought.
4. **Ordering pinned.** AO is applied in the color pass (step 4), before all of `PostProcessPass`. Documented in the mesh
   shader at the injection site and here so nobody later "moves AO into post" and reintroduces glowing shadows.

## Formats & bindings
- `_aoDepthTex` `r32float`, `_aoRawTex`/`_aoBlurTex` `r8unorm`. All `RENDER_ATTACHMENT | TEXTURE_BINDING`.
- Mesh scene bind group (`@group(0)`) gains **AO texture + sampler** bindings alongside the shadow map (scene-level, not
  per-material `@group(1)`). Off → 1×1 white. A `ssaoParams` field (enabled flag + intensity) rides the existing scene
  uniform block (spare floats) so the shader gates cheaply.
- New pipelines: depth-prepass (position VS + viewZ FS), AO (fullscreen), blur (fullscreen). New shader module
  `shaders/ssao-shaders.ts` (⚠ **no backticks in WGSL comments** — template-literal gotcha, per `reference_3d_shaders`).

## Host API (on `ShapeManager` → `scene3d` → `Renderer3D`)
```ts
sm.scene3d.setSSAO3D(on, { radius?, intensity?, bias?, power?, resolutionScale?, samples? }): void  // radius world units, intensity 0..2
sm.scene3d.ssao3D: { enabled, radius, intensity, bias, power, resolutionScale, samples }            // seed a panel
sm.scene3d.setSSAODebug3D(on): void                                               // raw-AO buffer to screen
```
- **Gating:** auto-**off** for cel/PS1/sketch/ink render styles (stylized looks want flat or hand-authored shading, not
  physical AO) and a **quality tier** (`quality: 'off'|'half'|'full'`) with **auto-off/half for tiled `full` worlds**
  (SSAO is screen-res-bound; tiled full-view is where cost bites — city-visual-upgrade.md §Performance).
- **City-lighting scope:** AO belongs to the same scope as the day/night lighting (Fix A+B). `worldParams.lighting` gains
  `ssao` so it persists with the city and is captured/restored with the rest of the lighting on City-Tool enter/exit.

## Performance & quality knobs (BUILT — half-res + configurable samples)
SSAO measured ~60→40 fps at full res on the city. The cost is: a full geometry **prepass** (re-renders every opaque
mesh into an rgba32float world-pos G-buffer), full-res AO (16 samples/px), and a full-res depth-aware blur. Two knobs
address it, exposed on `SSAOConfig` (persisted + UI, so they ride the existing AO settings):
- **`resolutionScale`** (default **0.5**): the prepass + AO + blur run at this fraction of canvas res. Half-res = ~4×
  cheaper (¼ the fragments/bandwidth/blur) and the AO is low-frequency, so the mesh shader's **linear** AO sampler
  upsamples it near-invisibly. `1.0` = full res for high-end. This is THE knob users on different hardware want — it's
  a genuine quality↔perf tradeoff, so it lives in config/UI (not hardcoded).
- **`samples`** (default **8**, clamped 4..64): hemisphere sample count per pixel. Passed to the AO shader via the free
  `cameraPos.w` uniform slot (no buffer resize); the shader's `KN` reads it. The blur hides the fewer-sample noise.
- **Implementation:** `ensureTextures` sizes all four SSAO targets at `resolutionScale × canvas` and re-allocates on a
  scale change; the AO texel uniform uses the scaled buffer dims; the mesh FS samples the (possibly half-res) AO buffer
  by normalized UV with the already-linear `_ssaoAOSampler`, so upsampling is free.

**Radius is the real perf dial (why):** the AO takes a *fixed* sample count; `radius` only changes *where* each tap
lands on screen. Small radius → all taps hit nearby texels (texture-cache hits, free). Big radius → taps scatter across
the screen → every tap is a cache-miss DRAM read → the pass goes memory-bandwidth-bound and fps falls off a cliff. So
the cure is (a) fewer bytes per tap and (b) keeping the gather cache-coherent regardless of radius.

**BUILT (2026-08-03) — linear-depth reformulation + HiZ mip chain (the two fixes above):**
- **(a) Drop the world-pos G-buffer → linear depth.** The prepass now writes **linear camera distance** to an
  **`r32float`** buffer (4 bytes/texel) instead of world position to `rgba32float` (16 bytes) — **4× less bandwidth per
  scattered tap.** World position is reconstructed in the AO shader from `distance + inverse-view-projection ray`
  (`world = cameraPos + rayDir·distance`; exact, since it's *true* distance). Background = a negative sentinel (clear to
  −1). The only added uniform is `invViewProjection`. (This does NOT remove the ~700 prepass draws — that's impossible
  while AO runs at **half res** and the main depth is full-res + produced *inside* the pass that needs AO. The draws stay,
  now depth-only-ish; the win is bandwidth + the radius cliff, which is what actually hurt.)
- **(b) HiZ min-distance mip chain.** A small mip pyramid (≤5 levels) is built on the linear-depth buffer, each level the
  **min** (nearest occluder) of its 2×2 children. Far AO taps read a **coarser mip** (`mip = log2(screen-spread)`) so the
  gather stays cache-coherent **at any radius** — raising radius no longer falls off the cliff. Reads use `textureLoad`
  (integer texel + explicit LOD), so no sampler/filtering concerns.
- Blur is now depth-aware on the linear distance directly (`exp(-|Δdist|·k)`), also via `textureLoad`.
- Files: `ssao-shaders.ts` (prepass linear-dist, `SSAO_DOWNSAMPLE_SHADER`, AO reconstruct+mip-select, blur), `ssao-pass.ts`
  (r32float+mips, downsample pipeline/passes, 192-byte AO uniform, `linDepthMip0View`), `pipeline-3d.ts` (prepass target
  `r32float`), `renderer-3d.ts` (negative-clear + `mat4.invert` invVP). **Browser debug-view verify pending** (WGSL only
  validates in-browser). Known approximation: a min-depth pyramid can slightly *over*-occlude far samples; the world-space
  range-check + blur soften it. If far AO looks haloed, switch the pyramid to a min/max pair (v2).

## Perf
- v1 **full-res** for correctness-first verification; **v1.1 half-res** compute + blur + depth-aware upsample is the perf
  win (¼ the AO/blur fragments). Half-res is an optimization *on top of* a verified-correct full-res term.
- Depth prepass is the main added cost (one extra geometry pass); trivial FS, and an early-Z payback path exists.
- Throttle-friendly: AO only matters when the ambient term is visible; it runs every frame (unlike the throttled shadow
  map) but is cheap fullscreen work at half-res. Counters via the existing `salsaWorld.perf()` shape.

## Phasing
- **v1 (this pass):** depth prepass + full-res AO + improved normal reconstruction + depth-aware blur + in-shader ambient
  multiply + debug view + host API + PBR-only gating. Correctness + verifiability first.
- **v1.1:** half-res compute/blur + depth-aware upsample; quality tier + tiled-world auto-off; persistence in the lighting
  scope.
- **v2 (only if v1 edges look mushy):** MRT view-space normals out of the forward pass (sharper than reconstruction),
  accepting the bandwidth/uber-shader cost. GTAO/HBAO is a further step, not planned.

## Test plan
- **Contract tests** (source-scanning, the established pattern): `ssao-shaders.ts` has no backticks in WGSL; the mesh
  scene bind-group layout and the WGSL `@group(0)` bindings agree on the AO binding index (mirrors the mesh-instance-layout
  test); `setSSAO3D` off leaves the term an exact no-op (white texture bound).
- **Browser verification (the real check):** toggle `setSSAODebug3D(true)` → the raw AO buffer must show clean creases with
  **no bright halos around building silhouettes** (normal reconstruction) and **no near-surface bleed onto far surfaces**
  (depth-aware blur). Then off-debug: creases/contact points grounded, sun shadows unchanged (not double-darkened), no
  bloom on darkened creases. Verify cel/PS1 styles are unaffected (AO gated off).
```
