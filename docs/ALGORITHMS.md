# Algorithms & Techniques in Salsa

**Generated 2026-09-10** by a 4-agent code sweep (2D/raster · 3D rendering · geometry/animation · procedural world/misc). A catalog of every *named, citable* technique in the engine — the kind of thing with a literature name or a documented lineage — with where it lives and what it does here. Line numbers drift; grep the technique name before editing. Sibling docs: `SYSTEMS.md` (what exists, reuse map), `TODO.md`.

**How to read an entry:** **Technique** — `file` — what it does in Salsa + cited source when the code names one.

---

## Part I — 2D Raster & Painting

### Dithering & Halftoning
- **Error-diffusion dithering (Floyd–Steinberg · Atkinson · Jarvis–Judice–Ninke · Stucki · Sierra · Sierra Lite)** — `wasm/src/lib.rs` (kernels drawn as ASCII diagrams), dispatched from `src/renderer/raster/effects/dither-engine.ts` — GPU→CPU→Rust/WASM round-trip because error diffusion is inherently serial.
- **Ordered (Bayer) dithering, procedural matrix** — `dither-engine.ts` — WGSL `bayerThreshold()` recursively builds the 2ⁿ×2ⁿ threshold map from the canonical `[0,2;3,1]` base; no LUT texture. A 4×4 twin lives in the 3D PS1 shader (see Part II).
- **Clustered-dot halftone screening** — `dither-engine.ts` — rotated screen angle + frequency, dot/line/diamond shapes, default 45° like print halftones. SVG variant in `src/services/ephemera/generators/halftone.ts`.
- **Blue-noise threshold map via void-and-cluster (Ulichney)** — `dither-engine.ts` — Fisher–Yates seeding, toroidal Gaussian energy, tightest-cluster→largest-void swaps → 64×64 r8 texture.
- **PCG integer hash** — `dither-engine.ts` — per-pixel deterministic random threshold for white-noise dither (the standard `747796405u/2891336453u` constants).
- **Rec. 601 luma weights (0.299/0.587/0.114)** — `dither-engine.ts` and the highlighter pipeline — mono dithering, duotone splits, saturation math.

### Fill & Region Detection
- **Span-based scanline flood fill** — `src/renderer/raster/scanline-fill.ts` — the one shared kernel for the paint bucket AND the magic wand (deduplicated in audit B4).
- **Hybrid GPU tolerance-mask + CPU scanline fill** — `src/renderer/raster/tools/flood-fill-engine.ts` — GPU computes the per-pixel Chebyshev color-distance mask, CPU does connectivity, GPU writes the fill. ⚠ The header's "Jump Flooding" citation is stale — the real JFA lives in SDF glyph generation (Part I → Text).
- **Gap closing via morphological dilation of walls** — `flood-fill-engine.ts` — iterated 4-connected min-filter passes close lineart leaks (the Clip-Studio "close gap" technique).
- **Reference-layer fill** — `flood-fill-engine.ts` — boundaries from layer A, pixels to layer B (lineart flatting workflow).
- **Even-odd (crossing-number) point-in-polygon rasterization** — `src/renderer/raster/selection/raster-selection-mask.ts` — per-pixel lasso mask in WGSL; feathered SDF rect/ellipse masks + fuzzy-set union/difference (max / clamped subtract) alongside.

### Brush & Stroke
- **Stabilizers: weighted moving average · exponential smoothing (EWMA) · Catmull–Rom fit · pull-string ("lazy brush")** — `src/renderer/raster/brushes/brush-stabilizer.ts` — four selectable smoothing algorithms; pull-string is the Krita/Lazy-Nezumi drag-a-string model.
- **Arc-length dab spacing** — `src/renderer/raster/brushes/brush-engine.ts` — dabs every `spacing×diameter` texels with lerped pressure/tilt (the Photoshop/GIMP stroke model), plus HSB color jitter, polar scatter, tilt-driven rotation.
- **Indirect painting (wet-stroke accumulation, max-alpha)** — `src/renderer/raster/brushes/brush-stamp-pipeline.ts` — dabs accumulate `max(a)` into a stroke layer flattened at stroke end — the Krita/Procreate build-up-vs-opacity model.
- **Porter–Duff source-over (straight alpha)** — `brush-stamp-pipeline.ts`, `raster-compositor.ts`, `raster-transform-engine.ts` — the canonical `outA = srcA + dstA(1−srcA)`.
- **Wet edges via neighborhood min-filter** — `brush-stamp-pipeline.ts` — `a·(1−minNeighborA)` darkens stroke borders (watercolor pooling).
- **Dual brush (tip × texture modulation)** — `brush-stamp-pipeline.ts` — Photoshop Dual Brush: multiply/subtract/min in dab-local or canvas-tiled UVs; paper-grain-modulated alpha ("paint catches on peaks") beside it.
- **Smudge with one-dab-lag color pickup** — `brush-engine.ts` + `samplePixel` — async GPU readback lerped into the brush color.
- **Parametric elliptical tip with hardness falloff** — `src/renderer/raster/brushes/brush-tip.ts` — solid core to `hardness`, quadratic `1−t²` skirt.
- **Nearest-segment-projection strip texturing** — `src/renderer/raster/brushes/stroke-texture-renderer.ts` — software rasterizer in compute: U from signed perpendicular distance, V from arc length (charcoal/crayon ribbons).
- **Smoothed-normal quad expansion** — `src/renderer/caches/geometry-generators/stroke-geometry-generator.ts` (+ staging/stroke caches) — per-point averaged normals from `next−prev` tangents kill joint cracks; the file carries an extended ASCII derivation.
- **Bresenham's line algorithm** — `src/services/drawing/eraser-service.ts` — interpolates eraser sample points between pointer events.

### Vector curves (pen tool, 2026-09-10)
- **Cubic Bézier evaluation + adaptive De Casteljau flattening (chord-deviation flatness test, depth-capped)** — `src/scene-graph/core/bezier.ts` — powers the polygon tool's pen gesture: sampled staged preview, commit-time flattening at ~0.35 screen-px tolerance; the future PathNode tessellator reuses it (`docs/specs/vector-paths.md`).
- **Mirrored-handle pen gesture (click = corner, click-drag = smooth anchor)** — `src/services/drawing/polygon-drawing-service.ts` — the Illustrator/Figma pen-tool input model; in-handle = −out-handle.
- **Ear-clipping polygon triangulation (2D shapes)** — `src/scene-graph/shapes/polygon.ts` — convex-ear clipping with barycentric point-in-triangle tests; shoelace signed-area winding normalization first.

### Procedural Texture / Grain
- **Value noise + fBm + domain warping** — `src/renderer/raster/canvas-grain.ts` — tileable lattice noise (Jenkins 32-bit hash), octave fBm, noise-warped coordinates; drives the paper library (cold-press, hot-press, linen weave, newsprint — "True Grit" look cited).
- **FrameLink displacement fields (wave/shake/ripple/noise/turbulence)** — `src/renderer/raster/core/raster-compositor.ts` — per-layer animated UV displacement with gradient noise + PCG jitter.

### Compositing & Layers
- **W3C/Porter–Duff separable blend modes (12)** — `raster-compositor.ts` — incl. Soft Light per the CSS Compositing spec formula; Hard Light as arg-swapped Overlay.
- **Back-to-front ping-pong layer compositing** — `raster-compositor.ts` — WebGPU storage textures are write-only, so accumulate via ping-pong; clipping masks as `srcA *= dst.a`; paper-as-substrate final pass.
- **Onion skinning** — `src/renderer/animation/onion-skin-renderer.ts` — tinted ghost frames (the red/blue animation convention).
- **Premultiplied surface + un-premultiply on readback** — `src/renderer/core/webgpu-renderer.ts` — kills dark halos on AA edges in exports.
- **Alpha lock** — `brush-stamp-pipeline.ts` — `min(out.a, existing.a)`, Photoshop "lock transparent pixels".

### Selection & Transform
- **Marching ants** — `src/renderer/raster/selection/selection-overlay-renderer.ts` — time-phased dash pattern, black/white alternating.
- **Floating-layer free transform with inverse-mapping bilinear resample** — `raster-selection-engine.ts` / `raster-transform-engine.ts` — lift → preview → commit; destination pixels mapped back through the inverse rotation.

### Text & Effects
- **SDF glyph rendering with `fwidth` antialiasing (Valve/Green)** — `src/renderer/core/managers/pipeline-manager.ts` — smoothstep coverage at threshold 0.5 + outline ring from the same field.
- **Jump Flooding Algorithm (JFA) SDF generation** — `src/scene-graph/shapes/sdf-text/sdf-glyph-compute.ts` — GPU seed-and-flood distance fields for the glyph atlas (the real JFA in the codebase).
- **Separable Gaussian glow, chromatic aberration, dilate-and-subtract outlines, datamosh block glitch, sine UV waves** — `src/renderer/raster/effects/text-effect-engine.ts` — the text-effect stack; outline = set difference of two circular dilations; glitch uses the ubiquitous `fract(sin·43758.5453)` GLSL hash.
- **Texture-array atlas with doubling growth** — `src/renderer/caches/texture-cache/texture-array-atlas.ts` — layer-per-image (not shelf-packed); layer 0 reserved all-white.

### Infrastructure patterns (2D)
- **Snapshot (memento) undo with dedup + time-coalescing** — `src/renderer/raster/core/raster-snapshot-manager.ts` — byte-compare skips no-ops, 40 ms coalesce window, redo truncation.
- **Triple buffering + 256-byte-aligned slot suballocation** — `src/renderer/caches/buffers/strokes-staging-buffer.ts` — per-frame rings for live previews; slot stride 512 for `minStorageBufferOffsetAlignment`.
- **GPU indirect draws (`drawIndexedIndirect`)** — `src/renderer/caches/buffers/indirect-draw-command-buffer.ts` — `firstInstance` doubles as a poor-man's bindless uniform index.
- **Painter's algorithm with O(n) sortedness check** — `webgpu-renderer.ts` — zIndex draw order, re-sort only on violation.
- **AABB viewport culling (separating-axis overlap)** — `src/renderer/util/aabb.ts` — with the NaN-box → "keep, don't cull" guard.
- **Dirty-rectangle texture upload, geometric buffer growth, promise-memoized asset caches, on-demand rAF scheduling with an interactive-lease refcount** — various (`raster-texture-manager.ts`, `gpu-buffer-utils.ts`, `texture-cache.ts`, `webgpu-renderer.ts`).
- **Analytic-AA grid lines via `fwidth`** — `pipeline-manager.ts` — constant screen-width grid at any zoom; dot-grid background in artboard space beside it.

---

## Part II — 3D Rendering

### Reflections
- **Screen-space reflections: screen-space DDA raymarch + projective-correct depth (`Q(s)/k(s)`) + per-step bisection refinement** — `src/renderer/3d/shaders/mesh3d-shaders.ts` (`traceSSR`) — walks the projected ray one G-buffer texel per step; acceptance = front-side depth crossing, 6-iteration binary search pins the hit.
- **Depth peeling (second-layer prepass)** — `src/renderer/3d/shaders/ssao-shaders.ts` — a second geometry pass keeps the second-nearest surface, giving SSR an exact `[front, back]` depth column for volume-membership tests instead of thickness heuristics.
- **Deferred half-resolution SSR resolve** — `mesh3d-shaders.ts` (`SSR_RESOLVE_SHADER`) — one trace per half-res texel into `rgba16float`, bilinearly upsampled in the mesh FS; inline per-fragment trace kept as an escape hatch.
- **CPU-lockstep shader ports** — `src/renderer/3d/ssr-trace.ts`, `planar-reflection.test.ts` — the same algorithms in TypeScript, validated against analytic mirror optics (virtual-image method) before the WGSL twin ships.
- **Planar reflections: Householder reflection matrix (`I − 2nnᵀ`) + Lengyel oblique near-plane clipping (zero-to-one depth adaptation)** — `src/renderer/3d/planar-reflection.ts` — the mirror plane becomes the near plane so hardware clipping removes behind-mirror geometry; mirrored passes flip winding/cull.
- **Screen-space refraction from a previous-frame scene grab** — `mesh3d-shaders.ts` — normal-offset UV into last frame's final image (clear plastic, CD lid).

### Ambient Occlusion
- **SSAO, world-space hemisphere sampling** — `ssao-shaders.ts` — normal-oriented kernel, per-pixel rotation dither, smoothstep range check; **closer-neighbour normal reconstruction** avoids silhouette halos; **depth-aware bilateral blur** (`exp(−dist·4)`); half-res with linear upsample; multiplies **ambient only** (sun is shadow-mapped).

### Lighting / BRDF
- **Cook–Torrance microfacet BRDF: GGX distribution · Smith/Schlick-GGX geometry · Schlick Fresnel · Karis roughness-aware ambient Fresnel** — `mesh3d-shaders.ts` — energy-conserving `kD = (1−F)(1−metal)`.
- **Kajiya–Kay anisotropic strand sheen** — `mesh3d-shaders.ts` — tangent-space `pow(sin(T,H))` band for hair cards.
- **Blinn–Phong / Gouraud vertex lighting** — legacy + PS1 paths (`shadow-shaders.ts`, `skinning-shaders.ts`).
- **Fresnel rim light, wrap/back-lambert foliage transmission, radius-falloff point lights (16/32 packed), ortho-safe constant view vector** — `mesh3d-shaders.ts`.

### Image-Based Lighting
- **Order-2 spherical-harmonic irradiance (Ramamoorthi & Hanrahan 2001, cited)** — `mesh3d-shaders.ts` + CPU projection in `renderer-3d.ts` — 9 coefficients, cosine-lobe `A_l` factors baked CPU-side.
- **Split-sum specular IBL (Karis 2013, cited): GGX-importance-sampled prefiltered cubemap (roughness→mip) + environment-BRDF LUT + Hammersley/van-der-Corput sequence** — `src/renderer/3d/ibl-prefilter.ts`, `ibl-specular-bake.ts`.
- **Procedural sky dome → equirect bake → SH** — `src/renderer/3d/procedural-sky.ts` — ambient is sky-driven; reflection priority chain planar → SSR → prefiltered cube with roughness crossfade.

### Shadows
- **Shadow mapping with tiered PCF (5×5 / 3×3 `textureSampleCompare`)** — `mesh3d-shaders.ts` (`SHADOW_SAMPLE_WGSL`) — penumbra-width multiplier for soft city shadows.
- **Texel-snapped, zoom-adaptive shadow box** — `renderer-3d.ts` — ortho volume centre rounded to the shadow-map texel grid (kills shimmer/crawl); half-extent ∝ orbit distance, bias ∝ texel size. One adaptive box, not cascaded CSM.
- **Wind-displaced depth pass** — `shadow-shaders.ts` — swaying foliage casts swaying shadows; emissive is restored un-shadowed (neon stays lit).

### Post-processing
- **Bloom: soft-knee luminance threshold → 9-tap separable Gaussian (canonical 0.227027… weights) → additive composite** — `post-process-shaders.ts` (Rec. 709 luma). Single-scale, not a Karis mip pyramid.
- **Fused grade + vignette (brightness → pivot contrast → luma-lerp saturation → tint)**, **linear + exponential distance fog**, **fullscreen-triangle idiom**, **UI world-blur (half-res ping-pong Gaussian)**, **transition masks (directional wipe + iris via smoothstep ramps)** — `post-process-shaders.ts`, `pipeline-manager.ts`, `webgpu-renderer.ts`.

### Retro / PS1
- **Affine texture warp (`@interpolate(linear)` UV blend), clip-space vertex snapping, color-depth posterization with 4×4 Bayer dither, UV quantization (texel crawl), low-res render target with nearest upscale** — `mesh3d-shaders.ts` + `src/renderer/3d/lofi-pass.ts` — the PS1 suite; lofi doubles as a dynamic-resolution lever.
- **Alpha-test cutout cards** — `mesh3d-shaders.ts` — order-independent hair/foliage, no sorting.

### Outlines & NPR
- **Depth+normal discontinuity edge pass** — `outline-shaders.ts` — silhouette (depth≥FAR neighbour) OR crease (`dot(N,Nₙ)<0.3`); named "Sobel" in the API but it's an any-of discontinuity test.
- **Stencil-masked inflated-hull highlight** — `highlight-shaders.ts` / `mesh-highlight-pass.ts` — header documents why classic inverted-hull was rejected (filled disc on smooth spheres).
- **Screen-space silhouette band (mask + polar ring scan)** — `silhouette-outline-shaders.ts` — uniform-thickness hover outline, projection-agnostic, with an animated scrolling pattern field (stripes/dots/checker).
- **Cel shading (quantized bands + stepped specular), crosshatch tonal bands, ink two-tone with rim darkening** — `style-shaders.ts`.
- **Zucconi-6 spectral approximation + diffraction-grating iridescence (cited: Alan Zucconi)** — `style-shaders.ts` (`cd_lighting`) + `shell-cartridge.ts` — 8 diffraction orders against the CD track tangent so the rainbow runs radially; 2400 nm grating gap.
- **Hash-jittered sparkle glints + anime 4-point star twinkles** — `mesh3d-shaders.ts`.

### Procedural Surfaces (in-shader materials)
- **Interior mapping (cited as the Cities-Skylines/Spider-Man trick)** — `mesh3d-shaders.ts` — tangent-frame slab raycast into a virtual room per window; hashed room depth/dressing/flickering TV.
- **Height-field normal perturbation (relief)** — `mesh3d-shaders.ts` — central-difference gradients of the procedural masonry/pattern height (uniformity-safe, no `fwidth`), with the documented half-texel-bias and moiré-frequency bug fixes.
- **Analytically antialiased pattern fields, running-bond/stack-bond tilers, Worley (F2−F1) cobbles, value-noise fBm grain, weathering profile masks, sum-of-rotated-sines water with analytic gradient normals, vertex-shader wind with per-instance hashed phase** — `mesh3d-shaders.ts` — the ground/wall/water material suite; CPU mirrors live in `src/world/ground-masks.ts` so scatter and shading agree.
- **Tangent-space normal mapping with Gram–Schmidt TBN** — `mesh3d-shaders.ts`.
- **SDF rounded-rect UI chrome + wireframe fBm terrain** — `src/renderer/shell/shell-renderer.ts` — the Shell dashboard is drawn from distance fields, not geometry.

### Culling, Picking, Camera
- **Gribb & Hartmann frustum-plane extraction (cited) + positive-vertex AABB test** — `src/renderer/3d/frustum-culler.ts` — adapted to WebGPU z∈[0,1].
- **BVH (centroid-median split) + slab ray–AABB + Möller–Trumbore (cited)** — `src/renderer/3d/mesh-bvh.ts` — allocation-free traversal; dual picking strategy (BVH static, AABB-prefiltered scan for cloth-dirty meshes) in `mesh-picker.ts`.
- **Adaptive near plane (near ∝ target distance) + scene-tracking far** — `camera-3d.ts` — depth precision without reversed-Z (see `docs/specs/depth-precision.md`).
- **Spherical orbit camera with exponential damping, screen-constant gizmo scaling, hierarchical instanced-group culling, opaque front-to-back / transparent back-to-front sorting, geometry-keyed instancing runs, uber-shader marker-substitution specialization, vertex-bufferless billboard particles** — `orbit-controller.ts`, `gizmo-renderer.ts`, `renderer-3d.ts`, `mesh3d-shaders.ts`, `particle-shaders.ts`.

### Verified absent (so this doc never over-claims)
No matcap sampling, no reversed-Z, no ACES/Reinhard tone mapping (LDR clamp), no cascaded shadow maps, no bloom mip pyramid / Kawase blur, no jump-flood outlines (the ring-scan above), and 2D MSAA is configured but currently set to 1.

---

## Part III — Geometry, Simulation & Animation

### Mesh Structures & Triangulation
- **Half-edge (DCEL) mesh kernel** — `src/scene-graph/shapes/edit-mesh.ts` — the interactive modeling core (twin/next/prev), topology derived by `_buildTopology`.
- **Ear-clipping triangulation** — three independent implementations: `polygon.ts` (2D shapes), `src/world/util.ts` (city polygons, with dedup/collinear prefilter + fan fallback), `billboard-3d.ts`/`gp-renderer-3d.ts` (extruded cutouts, dominant-plane projection).
- **Newell's method normals, shoelace winding normalization, fan triangulation of n-gons** — `edit-mesh.ts`, `polygon.ts`, `fold-mesh.ts`, `obj-importer.ts`.
- **Lengyel-style UV-gradient tangent generation (Mikktspace-compatible, named)** — `mesh-generators.ts` — per-triangle 2×2 solve, accumulate, Gram–Schmidt, handedness sign.

### Booleans & Simplification
- **BSP-tree CSG (csg.js/three-csg lineage, cited)** — `src/scene-graph/shapes/mesh-boolean.ts` — union/subtract/intersect via plane-splitting; Sutherland–Hodgman-style polygon splitting with epsilon coplanarity.
- **QEM decimation (Garland–Heckbert, cited)** — `src/scene-graph/shapes/mesh-simplify.ts` — symmetric quadrics, optimal contraction from a 3×3 solve, curvature-adaptive.

### Modeling Operations & Modifiers
- **Catmull–Clark subdivision** — `edit-mesh.ts` — face/edge/vertex point rules, all-quad output.
- **Extrude/inset/bevel (edge + vertex)/loop cut (edge-ring walk)/knife/dissolve/bridge/fill-hole/merge-by-distance (spatial-hash weld)** — `edit-mesh.ts` — the Blender-style op set on the half-edge kernel.
- **Value-noise fBm displacement along normals, mirror modifier with weld, solidify shell, array modifier via offset-matrix powers `Dⁱ`** — `edit-mesh.ts`, `modifiers.ts`, `array-group-3d.ts`.
- **Triplanar/smart-project UV unwrap** — `edit-mesh.ts` — dominant-axis projection per averaged normal.

### Implicit Surfaces
- **SDF primitives with polynomial smooth-min blending + Naive Surface Nets extraction (Lysenko lineage, cited)** — `src/scene-graph/shapes/sdf-mesh.ts` — metaball blobs → mesh; gradient normals from central differences; shelf bin-packed UV charts with cylindrical/lat-long projections.

### Skinning, Rigging, IK
- **Linear blend skinning (matrix palette, 4 influences)** — `skinning-shaders.ts` + `skeleton-3d.ts` — `skin = world × inverseBind`.
- **FABRIK IK (named) + pole-vector plane constraint** — `src/renderer/3d/ik-solver.ts` — backward/forward reaching, then shortest-arc quaternions per joint.
- **Bone constraints (look-at, copy-rotation, volume-preserving stretch-to, Euler limits) blended by slerp influence** — `constraint-solver.ts` — documented FK → IK → constraints → springs order.
- **Inverse-distance² auto-skinning, dab weight painting with renormalization, ring-blended garment weights via the VertGrid spatial hash (Teschner primes)** — `scene3d-manager.ts`, `scene3d-weight-paint.ts`, `clothing-generator.ts`, `vert-grid.ts`.
- **Blend shapes / morph targets** — `scene3d-blend-shapes.ts`, `gltf-importer.ts`.

### Animation & Interpolation
- **Quaternion slerp keyframes (Euler→quat→slerp→Euler), NLA strip blending as delta rotations, CSS-style cubic-Bézier easing inverted by Newton–Raphson, Penner easing presets** — `skeleton-animator.ts`, `types/keyframe-3d.ts`, `ui-manager.ts`, `world-manager.ts`.
- **Catmull–Rom splines + rotation-minimizing frames (double-reflection method, Wang et al. 2008, cited)** — `mesh-generators.ts` (ribbons/tubes) — plus the shared parallel-transport + Rodrigues frame in `src/world/curve-frame.ts` used by hair cards, grass blades, petals, branches, ivy.
- **Surface of revolution (lathe) + generalized-cylinder sweeps** — `mesh-generators.ts`.
- **Boundary contour tracing + Douglas–Peucker simplification + separable dilation** — `billboard-3d.ts` — PNG alpha mask → extruded paper-cutout silhouette (the Flipnote/3DS look).

### Physics
- **GPU cloth: Verlet integration + position-based (PBD) distance-constraint projection + greedy graph coloring for parallel Gauss–Seidel (no atomics)** — `cloth-shaders.ts`, `cloth-simulator.ts`, `cloth-geometry-builder.ts` — structural/shear/bend (Provot-style) + user stitches; triangle-area-weighted inverse masses (Matt Fisher §4.1, cited); analytic ground/sphere/box collision; pose pass writes straight into a `VERTEX|STORAGE` buffer (no readback).
- **VRM-style spring bones (cited)** — `spring-bone-solver.ts` — rotation-only damped-spring tips with Verlet inertia, capsule/sphere colliders, root→tip solve.

### Game Runtime
- **Fixed-timestep accumulator loop ("Fix Your Timestep", cited)** — `src/game/game-loop.ts` — with a spiral-of-death cap.
- **Kinematic character controller: wall-slide (tangential projection), step-up detection, third-person occlusion pull-in, frame-rate-independent `1−e^{−rate·dt}` smoothing, pointer-lock mouse look, locomotion clip state machine** — `src/game/`.
- **Uniform XZ-grid broadphase with an oversized-AABB escape list** — `src/game/spatial-grid.ts`.

### Packaging & Print
- **Hinge-tree fold compilation (`T(a)·R(axis,θ)·T(−a)` about arbitrary 3D lines) + frame-conjugation identity for scene-node folding + windowed fold sequencing** — `src/packaging/fold-mesh.ts`, `box-hierarchy.ts` — cascade folding of dieline panel trees; staged phases via piecewise-linear remap.
- **Interval subtraction for cut-set derivation** — `mechanisms.ts` — CUT = panel edges − hinge/slit intervals.
- **Minimal PDF 1.4 writer (hand-emitted xref) + zlib FlateDecode image embedding (fflate) + mm→point conversion** — `src/packaging/print-pdf.ts` — mm-exact page boxes so "print actual size" is 1:1.

---

## Part IV — Procedural World, UI & Data

### Randomness & Hashing
- **Mulberry32 PRNG (named)** — `src/world/util.ts` (`makeRng`) — the seeded RNG all composers draw from; deliberately inlined copies in branch/scatter/ephemera so a part's shape depends only on its own seed.
- **xorshift32** — ephemera generators (`serial-string.ts` et al.).
- **Murmur3-style position hash** — `util.ts` (`hash2`) — *the* primitive making per-cell decisions independent of build order (biome, streets, furniture, signals…).
- **GLSL sine-fract hash mirrored CPU/GPU** — `ground-masks.ts` — one field, two consumers.
- **FNV-1a string hash + Weighted Rendezvous Hashing (HRW)** — `src/world/garp.ts` — prop skins picked by `argmax(w/−ln h)` so adding one skin to a pool doesn't reshuffle the city.
- **Per-tile seed derivation + per-lot RNG streams** — `tiled.ts`, `biome.ts` — idempotent selective regeneration.

### Noise & Fields
- **Shared value noise + 2-octave fBm + domain warping** — `util.ts`, `ground-masks.ts`, `warp.ts` — roads curve via a final vertex-space warp with an approximate inverse for picking; weathering masks (edge/wear/moist/dirt) drive shader albedo AND CPU scatter from the same formulas.
- **Sine-octave water, hash-sampled star dome** — `water.ts`, `sky.ts`.

### City & World Layout
- **Voronoi (nearest-seed) district partition, radial ring+spoke and grid street networks, distance-banded zoning, jittered-ellipse ponds** — `src/world/layout.ts` — blocks are the gaps between inset lots.
- **Shape-grammar-ish building archetypes** — `building.ts`/`building-parts.ts` — typology of stackable part emitters resolved DEFAULT ← preset ← overrides.
- **Street-frontage heuristic, maximal-run road merging for traffic, cheap catenary wires, sag+scallop awnings** — `util.ts`, `traffic.ts`, `furniture.ts`, `awnings.ts`.
- **Height-field draping with baked/smooth/full tiers, coarse-lattice bilinear elevation, street-band-min terrace levels, ramp corridors, tile-LOD seamless tiling** — `elevation.ts`, `drape.ts`, `tiled.ts` — "a terrace step never cuts a road."

### Vegetation & Scatter
- **Poisson-disc blue noise (jittered-grid + spatial-hash rejection) and triangle-area-weighted dart throwing on meshes (Teschner hash)** — `src/world/ground-scatter.ts` — "never a grid"; density modulated by the shared weathering masks + fBm patchiness.
- **Golden-angle phyllotaxis (π(3−√5))** — `blade.ts`, `branch.ts`, `stalk.ts`, `planting.ts`, `runner.ts` — blades in a tuft, branches around a limb, leaves along ivy.
- **Stochastic recursive branching with phototropism (L-system-adjacent), swept-blade primitive with V-fold normals, generalized-cylinder tubes, rounded-box SDF hedges, surface-growth ivy runners with an fBm frontier, golden-angle conifer whorls** — `branch.ts`, `blade.ts`, `stalk.ts`, `runner.ts`, `conifer.ts`, `whorl.ts`.
- **Variant pooling + GPU instancing with per-primitive LOD multipliers + shader-derived wind phase** — `city-foliage.ts`, `ground-scatter.ts`.

### Polygon Utilities (world)
- **Sutherland–Hodgman clipping (named), Cyrus–Beck-style parametric segment clipping, SAT convex intersection (named), miter offsetting with clamp, chamfer + quadratic-Bézier corner rounding, annulus sectors, grid fill for drapables** — `src/world/util.ts`, `building-geom.ts`, `src/renderer/util/geometry.ts`.

### Streaming, LOD & Caching
- **Hysteretic deadband tile snap + LOD show/hide hysteresis** — `stream-manager.ts`, `world-manager.ts` — boundary-thrash killers.
- **Reconcile-diff chunk streaming (nearest-first, time-sliced, proxy-first preview, hold-then-swap tier flips)** — `src/services/streaming/stream-manager.ts`.
- **Byte-capped LRU of retired tiles** — `world-manager.ts` — exploits procedural determinism: a cache hit is a re-upload, not a rebuild.
- **Round-robin worker pools, WeakMap graph-lookup memoization, cached-inverse NDC unprojection keyed on matrix version, cursor-anchored zoom** — `tile-worker-pool.ts`, `util.ts`, `interaction-service.ts`.

### UI & Interaction
- **Pure FSM/statechart runtime (guarded transitions, variable watches, history stack, timer triggers, cascade depth cap)** — `src/ui/ui-state-machine.ts` — effect-list output, host adapter applies.
- **Billboarding with parented billboard bases, Zone.js bypass via the un-patched `addEventListener` symbol, debounce (stroke-end save, microtask layer batching), observer/event-emitter, port-snapping connectors** — `world-manager.ts`, `zoneless-listeners.ts`, services.
- **Agentic tool-use loop with rolling prompt-cache breakpoints** — `src/services/scene-authoring-session.ts` — Anthropic-Messages-shaped, screenshot-as-image feedback.

### Ephemera (SVG generators)
- **Code 128B, EAN-13 (L/G/R parity sets + mod-10), UPC-A encodings** — `barcode-*.ts` — real scannable barcodes.
- **Mollweide projection solved by Newton–Raphson, orthographic globe, halftone screens, Platonic wireframe projection, star polygons, hazard stripes, CRT scanlines, seeded wear overlays, SVG filter injection** — `src/services/ephemera/generators/`.

### Persistence & Data
- **DEFLATE/ZIP via fflate** — `src/services/persistence/project-package.ts` (`.frogmarks`) and `frogcart.ts` (`.frogcart` ZIP envelope, audio registry) — plus zlib streams in the PDF writer.
- **OPFS atomic directory-swap saves, PNG/WebP/AVIF pixel codecs with worker offload + zero-copy transfer, structured-clone-safe pure build pipelines, single-source build-order constants** — `document-persistence.ts`, `pixel-codec.ts`, `centre-build.ts`, `build-order.ts`.
- **RGB↔HSB conversion, curated seeded palettes, data-only style packs** — `utils/color.ts`, `world/palette.ts`, `world/styles.ts`.

---

*Regenerate by re-running the 4-domain agent sweep; keep the "verified absent" list — it's the guard against this doc over-claiming.*
