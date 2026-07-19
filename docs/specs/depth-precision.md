# Depth Precision — Adaptive Near Plane + Reversed-Z

**Status:** ✅ Phase 1 Built (2026-07-08 — `Camera3D.autoNear`, enabled on the scene + viewer cameras) · 📋 Phase 2 Planned
**Motivation:** z-fighting is rare in orthographic mode but common in perspective mode. This spec explains why, and plans the two standard fixes.
**Related:** the roof-cap coplanar fix (2026-07-08, `streets.ts` — geometric separation), the flat-map per-layer `y` offsets.

---

## 1. The problem, with our numbers

The depth buffer is `depth24plus` (24-bit) and the main `Camera3D` defaults are **`near = 0.01`, `far = 100`** ([camera-3d.ts](../../src/renderer/3d/camera-3d.ts) §constructor).

| Projection | Depth mapping | Step size at z = 20 (city orbit distance) |
|---|---|---|
| Orthographic | **linear** in view z | (far−near)/2²⁴ ≈ **6×10⁻⁶ units — uniform at every distance** |
| Perspective | **hyperbolic** (∝ 1/z) | ≈ z²/near · 2⁻²⁴ ≈ **2.4×10⁻³ units — 400× coarser** |

Perspective (`perspectiveZO`) spends ~half of all 16.7M depth values between `near` and `2·near` (0.01 → 0.02 units — where nothing ever is), and the world-space size of one depth step grows ~**z²/near**. At typical orbit distances one step is *larger* than the geometric anti-fight offsets we use (~0.0018·s), so surfaces we deliberately separated can still quantize into the same bucket and shimmer. Ortho never has this problem — only *exactly* coplanar surfaces fight there.

Two levers, and they compose:
- **Near plane** controls the precision *budget* (linear: 50× bigger near = 50× finer steps everywhere).
- **Reversed-Z** controls the precision *distribution* (float32 exponent spacing cancels the 1/z curve → near-uniform precision at any near value).

**Can we do both? Yes — and ideally we do.** They are independent and multiplicative. **Should we?** Phase 1 immediately (one file, zero risk); Phase 2 when perspective becomes a primary view — the street-level walk mode is exactly the case (near hands + far skyline in one frame) where only reversed-Z holds up. Once Phase 2 lands, Phase 1's adaptive near can relax back toward a small constant (reversed float-Z is robust even at near = 0.001), but keeping it costs nothing.

---

## 2. Current state (audited 2026-07-08)

- **Camera:** `Camera3D` already uses `perspectiveZO`/`orthoZO` (WebGPU [0,1] clip-z) with `mat4.perspective/ortho` fallbacks. Defaults `near 0.01 / far 100`. Main scene cameras are constructed with defaults in [webgpu-renderer.ts](../../src/renderer/core/webgpu-renderer.ts) (`new Camera3D({position, target})` ×2) and [salsa-viewer-core.ts](../../src/viewer/salsa-viewer-core.ts); `cloth-preview-renderer` uses `near 0.01 / far 1000` (ortho — fine).
- **Depth-stencil format:** `depth24plus-stencil8` is the **shared attachment** across **15 files** (2D raster pipelines, 3D scene, gizmos, overlays, passes). The texture is owned by `interaction-service` and referenced by `webgpu-renderer`.
- **Stencil is genuinely used in the 3D chain:** `mesh-highlight-pass` (hover/selection outline) writes+tests stencil in the same pass as a depth test — so depth and stencil cannot be split into separate attachments there.
- **Depth compares in 3D:** `'less'` (pipeline-3d ×3, outline-pass depth pre-pass, renderer-3d transparent pass, shell), `'less-equal'` (gizmo occluded pass, gp-renderer, mesh-highlight ×2, ghost-preview variant), `'greater'` (**mesh-edit-overlay REAR stippled edges — a semantic depth test**), `'always'` (gizmos/overlays/2D — unaffected).
- **Depth clears:** `depthClearValue: 1.0` in lofi-pass, webgpu-renderer, cloth-preview, renderer-3d ×2, shell ×4.
- **Shader depth READS:** `outline-shaders.ts` samples the depth pre-pass (`texture_depth_2d`) for edge detection — thresholds/deltas are in raw depth units. `shadow-shaders.ts` uses its **own light-space projection + shadow map** (`textureSampleCompare`) — fully independent of the main camera convention.
- **Shell/UI cameras** (`shell-cartridge` `near 0.1 / far 100`, tight scenes) — no observed issues; out of scope.

---

## 3. Phase 1 — Adaptive near plane  *(quick win: 1 file + 1 call site, ship first)*

**Idea:** `near` should scale with how far the camera is from its subject. Nothing renderable is ever closer than a small fraction of the orbit distance.

**Design:**
- `Camera3D` gains `autoNear` (default **off** — opt-in, zero behavior change elsewhere):
  `near = clamp(distance(position, target) × 0.02, 0.02, 0.5)`, recomputed in `getProjectionMatrix()` when view or projection is dirty (distance already available from `_position`/`_target`).
- Precision improvement at the default city orbit (distance ≈ 20 → near 0.4): **40×** finer steps — one step at z=20 drops from 0.0024 to ~0.00006 units, comfortably under every geometric offset in the world module.
- **Enable it for the 3D scene camera** (both `new Camera3D` sites in `webgpu-renderer.ts` + the viewer). City mode, character orbit, armature — all are orbit-style cameras where the subject *is* the target, so the heuristic is safe.
- **Clipping guard:** min clamp 0.02 keeps extreme close-ups (face zoom in the character creator, orbit min radius) intact; 0.02 × 50-unit far range still yields ~50× better distribution than today at typical distances.
- **Far plane:** leave at 100 (far barely affects precision; the orbit max radius is 50). Optionally `far = max(100, orbitRadius × 4)` if giant dioramas ever clip — independent knob.

**Verification:** headless — assert projection matrix `near` tracks camera distance; visual — perspective orbit of a `storm`/`cyber` city (dense coplanar-ish detail: signage on walls, awnings, road paint) at min/mid/max zoom, confirm no shimmer and no near-clipping at closest zoom in the character creator.

**Risk:** near-zero. One class, opt-in flag, no pipeline/format/shader changes.

---

## 4. Phase 2 — Reversed-Z  *(structural: format + compares + clears + 2 shader semantics)*

**Idea:** map near→1, far→0 and store depth in **float32**. Float's exponent spacing mirrors the 1/z hyperbola, so precision becomes near-uniform across the whole range — the industry-standard fix, and WebGPU's [0,1] clip-z makes it clean (no OpenGL remap hack).

### 4.1 Projection (camera-3d.ts)
- Reversed projections are the ZO functions **with near/far swapped**: `perspectiveZO(m, fov, aspect, far, near)` and `orthoZO(l, r, b, t, far, near)` map near→1/far→0. Gate behind a single module-level constant:
  ```ts
  export const REVERSED_Z = true;   // one switch for the whole engine (bisect/rollback lever)
  ```
- Both modes flip together — ortho gains nothing (linear either way) but MUST follow the same convention because 2D/3D share the attachment and overlays compare against scene depth.

### 4.2 Depth-stencil format — the real constraint
- Reversed-Z only pays off on a **float** buffer; `depth24plus` (unorm) reversed ≈ unchanged. Target format: **`depth32float-stencil8`** (stencil is required — see mesh-highlight-pass).
- `depth32float-stencil8` is an **optional WebGPU feature** (`device.features`): request it at device creation (`webgpu-renderer` init). Support is effectively universal on desktop (D3D12/Metal/Vulkan) but NOT guaranteed (some Android GL-backed adapters).
- **Fallback:** feature absent → `REVERSED_Z = false` at runtime, keep `depth24plus-stencil8` + standard-Z + Phase 1 (which alone already fixes the observed cases). This means every consumer must read the convention from ONE place, not hardcode it.
- Mechanical change: the format string appears in **15 files** — introduce a shared constant instead of 15 edits ever again:
  ```ts
  // renderer/core/depth-convention.ts (NEW — the single source of truth)
  export const DEPTH_FORMAT: GPUTextureFormat;         // 'depth32float-stencil8' | 'depth24plus-stencil8'
  export const DEPTH_CLEAR: number;                    // 0.0 | 1.0
  export const CMP_NEARER: GPUCompareFunction;         // 'greater' | 'less'
  export const CMP_NEARER_EQ: GPUCompareFunction;      // 'greater-equal' | 'less-equal'
  export const CMP_FARTHER: GPUCompareFunction;        // 'less' | 'greater'  (rear-edge stipple)
  ```
  All 15 files import from here; the values are set once from the negotiated feature + `REVERSED_Z`.

### 4.3 Pipeline sweep (mechanical, guided by §2 inventory)
- `'less'` → `CMP_NEARER`, `'less-equal'` → `CMP_NEARER_EQ`, mesh-edit-overlay's rear-edge `'greater'` → `CMP_FARTHER`, `'always'` untouched.
- `depthClearValue: 1.0` → `DEPTH_CLEAR` (7 sites).
- **Depth bias:** any `depthBias`/slope-scale (shadow-adjacent, outline pre-pass) flips sign under reversed-Z — audit `depthBias` usages during implementation.

### 4.4 Shader semantics (the only two thinking parts)
- **outline-shaders.ts** (depth pre-pass edge detection): raw-depth deltas invert direction and the non-linearity flips end-to-end. If it linearizes: standard `lin = n·f / (f − d·(f−n))` becomes reversed `lin = n·f / (n + d·(f−n))`. If it thresholds raw deltas: re-tune the threshold (likely improves — reversed float depth is better conditioned exactly where outlines sample).
- **lofi-pass / ghost-preview / any pass comparing against scene depth**: compares come from the convention constants; verify the PS1 downscale path clears with `DEPTH_CLEAR`.
- **shadow-shaders.ts: explicitly OUT OF SCOPE** — the shadow map has its own light-space ortho projection and depth texture; it stays standard-Z. Mixing conventions across *separate* render targets is fine and keeps the diff small.
- **WGSL reminder:** no backticks in comments (template literal).

### 4.5 Interaction/picking audit
`interaction-service` owns the depth texture; if GPU picking or the vertex-snap depth pick reads/compares depth values (the snap viz uses front-most depth picking), those reads follow the same convention constants. Audit `depthTextureView` consumers before flipping.

### 4.6 Verification
- **Stress scene:** two quads separated by 0.002·s at distances 5/20/50, perspective camera — flickers today, must be rock-solid after; plus a coplanar pair (must still fight — sanity that the test detects fighting).
- **Visual QA checklist (each in perspective + ortho):** hover/selection outline (stencil pass), rear stippled edges in Edit Mesh (`CMP_FARTHER`), ghost x-ray preview, ink/sketch outlines (depth-read pass), PS1 lofi mode, shadows (unchanged), gizmos + snap viz draw-on-top, fog (view-space distance — should be unaffected), city day/night cycle.
- Headless: projection matrix spot-checks (near→1, far→0 for both modes), convention constants consistent with the negotiated format.

**Risk:** medium — wide but shallow. The two real hazards are the optional feature fallback path and the outline-pass depth reads; everything else is mechanical via the convention module. `REVERSED_Z=false` restores today's behavior exactly (rollback lever).

---

## 5. Recommended order

1. **Phase 1 now** — fixes the reported class of flicker for the city/creator at zero risk.
2. **Keep using geometric separation** (~0.002·s offsets) for intentionally-layered surfaces — cheap, works in every mode, and documents intent in the geometry.
3. **Phase 2 alongside the street-level walk mode** (its close-near + far-skyline frames are the forcing function), or earlier if perspective flicker keeps appearing in normal use.
4. After Phase 2, optionally relax Phase 1's clamp floor (reversed float-Z tolerates tiny near) — but there's no need to.
