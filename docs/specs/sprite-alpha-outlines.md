# Alpha-shaped outlines for sprites — plan

**Status:** ✅ BUILT 2026-09-29 (browser-unverified WGSL). The design's first rule was **zero change to the existing
outline path**: the new path lives in its own files and only claims sprites that pass the gate.

**As built:**
- `src/renderer/3d/sprite-outline.ts`:
  - `computeAlphaSDF` (exact Felzenszwalb EDT, signed, padded, r8-encoded);
  - the gate `spriteOutlineEligible`;
  - `spriteLayerOuterWidths` / `spriteLayerAt`;
  - `SpriteSDFCache` (a GPU alpha blit into a 256-texel readable target, readback, EDT, then an r8 texture; a
    WeakMap per texture; `null` = opaque, so the hull is used).
- `sprite-outline-pass.ts`:
  - `SpriteOutlinePass` (its own pipelines, no stencil, depth bias against coplanar z-fight);
  - `packSpriteOutlineParams`.
- `shaders/sprite-outline-shaders.ts`.
- Routing: one gated branch in renderer-3d's persistent-outline loop. The sprite falls back to the hull until its field
  is ready; `hasAnimatedOutline` keeps frames flowing meanwhile.
- `Mesh3D.spriteSize` getter; `HighlightStyle.alphaShape`.
- Tests: `sprite-outline.test.ts` (8) plus the WGSL static check.
- **Three shapes** via `HighlightStyle.spriteShape`:
  - `'image'` (default, the distance field);
  - `'square'` (the hull, untouched);
  - `'card'`: analytic rectangle distance, plus the quad's see-through pixels filled with layer 0, blended by
    (1 − image alpha). It reads the sprite's own texture through its UV transform, so it has no field, no padding
    limit, and works with sprite sheets.

  The gate is `spriteOutlineMode` → `'image' | 'card' | null`. `alphaShape: false` (shipped for a few hours) is still
  read as `'square'`.
- Decisions:
  - padding is 64 texels (a ring can reach ¼ of the longer side), clamped beyond that;
  - tiled/offset UVs (sprite sheets) keep the hull (a later option);
  - `plane` isn't opted in.

## The problem

A Sprite with a transparent PNG (an icon or reaction image) gets a **square** outline: the border of the quad, not the
shape in the image.

**Why:** a per-object outline is an **inflated hull**, in four steps:
1. mark the mesh's own footprint in the stencil;
2. draw the mesh again pushed outward along its (smoothed) normals;
3. keep only what sticks out past the footprint;
4. for stacked rings, repeat with wider pushes.

A sprite is a flat quad whose normals all point out of its plane, so "outward" moves the whole quad toward or away
from the camera. What sticks out is just the quad's edges. The hull never looks at the texture, so the transparent
pixels count as part of the object.

## The approach: an outline from the image's own shape (distance field)

1. **Distance field of the alpha.** Once per texture, compute a small signed-distance field (SDF) from the image's
   alpha channel: for every point, how far it is from the shape's edge.
   - Built on the CPU at ~256² with 8SSEDT or jump-flood: a few ms, done once.
   - Includes **padding** around the image, so an outline can extend past the image's edges even where the shape
     touches them.
   - Cached by texture identity and rebuilt only if the texture changes.
   - Edge = alpha 0.5, so soft anti-aliased edges outline cleanly.
2. **A separate sprite-outline draw.** For a qualifying mesh, the hull is skipped. The renderer instead draws one
   enlarged copy of the sprite quad, grown **in its own plane** by the total outline width, using the same instance
   matrix (so billboarding still works). Its small fragment shader:
   - reads the SDF;
   - discards pixels inside the shape and pixels beyond the outermost ring;
   - otherwise picks the ring by distance: main outline width, then each stacked ring's own width, cumulative;
   - shades it with that layer's existing colour, pattern, glow and opacity;
   - applies **line boil** by nudging the distance thresholds with the same noise and `boilFps`.

   Depth follows the style's `merge` flag, as today. The band lies in the sprite's plane, only where the sprite is
   transparent (the sprite discards those pixels), so there's no z-fighting.
3. **Nothing else changes:**
   - the style data is the existing `HighlightStyle` plus rings;
   - the API is still `setMeshOutline3D` / `setMeshOutlineRings3D`;
   - persistence is the mesh's `outline` / `outlineRings`, with the SDF rebuilt on load;
   - the Frogmarks UI needs no changes.
   Width keeps its meaning (model units), measured in the sprite's plane.

## Keeping existing outlines safe (the gate)

The new path runs **only** when all three hold:
- the mesh primitive is `sprite` (optionally `plane`, as a later opt-in),
- it has a diffuse texture,
- the texture has any transparent pixels (checked while building the SDF).

Everything else takes the current hull path, **byte-for-byte unchanged**: boxes, GLBs, characters (skinned),
opaque-texture sprites, and alpha-cutout hair cards (not sprites). There's also an escape hatch: a style field
`alphaShape: false` forces the old square hull for a sprite.

Regression protection:
- Unit tests: the SDF generator (a circle / L-shape alpha gives the right distances), ring thresholds (cumulative
  widths, the same as `outlineLayers`), and the gate (which meshes get routed).
- The WGSL static check covers the new shader.
- Browser: every mesh and character outline that exists today must look **identical**. Only textured-alpha sprites
  change.

## Edge cases

- **Animated sprites** (frame-link / changing textures): one SDF per distinct texture, cached, so frame swaps just pick
  the cached field.
- **UV tiling / offset** (`uvTransform`): the SDF is sampled through the same transform.
- **Very thin shapes / small icons:** the SDF resolution caps detail. 256² is plenty for icons; maybe 512² for large
  sprites.
- **Outline wider than the padding:** make the padding follow the widest ring (rebuild the SDF if a much wider outline
  is set), or clamp.

## Alternative considered

A **screen-space mask** plus dilation, like the hover outline, works for any shape. It was rejected: thickness would be
in pixels (inconsistent with today's model-space width), it costs a full-screen pass per outlined object, and
depth/merge would behave differently from every other outline.

## Size

Small–medium:
- the SDF generator + cache (~150 lines + tests);
- one pipeline + shader (~120 lines);
- routing in the outline draw (~30 lines).

It's all additive. No existing pipeline, struct or saved format changes.
