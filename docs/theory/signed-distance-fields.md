# Signed Distance Fields
**Last Updated:** 2026-05-11

---

## Intuition

A regular bitmap font stores "is this pixel inside the glyph or outside?" — a binary answer. At 32px that looks sharp. Scale it to 200px and the jagged edges reveal the original pixel grid.

A signed distance field (SDF) stores something richer: "how far is this pixel from the nearest edge of the shape?" Positive values mean outside; negative values mean inside; zero means exactly on the edge. With this distance information, you can reconstruct a sharp edge at any scale by thresholding — "color everything with distance < 0 as the glyph." The edge is always smooth because it's defined by a continuous distance function, not a binary pixel boundary.

---

## Mental Model

Picture a mountain range where the shape's boundary is sea level. The SDF is the elevation map:
- Deep underwater (large negative value) — far inside the shape
- Just below sea level (small negative) — just inside the edge
- Sea level (zero) — exactly on the edge
- Just above sea level (small positive) — just outside the edge
- High mountain (large positive) — far outside the shape

Rendering the shape means coloring everything below sea level. The coastline (the threshold at zero) is always sharp because you're cutting a continuous function with a horizontal plane — regardless of how far you've zoomed in.

---

## Formal Explanation

For a shape S and a point P:

```
SDF(P) = min distance from P to the nearest edge of S,
         with sign: negative if P is inside S, positive if outside
```

For rendering, the threshold is: `fragment_color = glyph_color if SDF(P) < threshold else transparent`

In texture form, the SDF is stored in an 8-bit per-channel texture where:
- Value 0.0 (0) = "very far outside" (mapped from a large positive distance)
- Value 0.5 (128) = exactly on the edge (distance = 0)
- Value 1.0 (255) = "very far inside" (mapped from a large negative distance)

The mapping: `stored = clamp(0.5 - distance / spread, 0, 1)` where `spread` is the maximum distance representable in the texture. Threshold 0.5 in stored value corresponds to distance 0.

**Rendering with effects:**

```wgsl
let dist = textureSample(sdfAtlas, sdfSampler, uv).r;

// Smooth anti-aliased edge
let edgeWidth = fwidth(dist);   // screen-space derivative — how fast dist changes per pixel
let alpha = smoothstep(0.5 - edgeWidth, 0.5 + edgeWidth, dist);

// Outline: color at distance 0.5 down to 0.4 (stored values)
let outlineAlpha = smoothstep(0.4 - edgeWidth, 0.4, dist)
                 - smoothstep(0.5, 0.5 + edgeWidth, dist);
```

Effects are just threshold bands in the SDF: outline is the band from `outerEdge` to `innerEdge`, glow is a falloff from `innerEdge` to `innerEdge + glowRadius`.

**Multi-channel SDF (MSDF):**

Single-channel SDF rounds sharp corners — the distance field can't represent the corner exactly because the nearest edge distance is continuous. MSDF (Valve / Chlumsky) stores three separate signed distances in the R, G, B channels, each measuring distance along a different set of edge directions. The shader takes the **median of the three channels** before thresholding. This preserves sharp corners because at a corner, two of the three channels agree on the correct edge while one doesn't — median picks the correct value.

```wgsl
let msd = textureSample(msdfAtlas, sdfSampler, uv).rgb;
let dist = median(msd.r, msd.g, msd.b);  // median of three
let alpha = smoothstep(0.5 - edgeWidth, 0.5 + edgeWidth, dist);
```

---

## Why It Matters

**Resolution independence.** A 64×64 SDF glyph can render crisply at any size from 8px to 800px. A 64×64 bitmap glyph pixelates above ~32px. For a design tool where text can be scaled arbitrarily, SDF is the only practical approach.

**GPU-side effects without extra passes.** Outline, inner shadow, outer glow, and drop shadow are all different threshold ranges in the same SDF texture. No additional render passes or texture sampling needed — just arithmetic on the single distance value. This makes SDF text effect chains (Salsa's text effects system) efficient: each effect modifies the threshold or adds a colored band, all in one fragment shader pass.

**Vector-like quality from a texture.** SDF is a rasterization of a vector shape — you pay the storage cost of a texture but get near-vector quality rendering. The alternative (actual vector rendering on the GPU via Bézier curves) is significantly more complex to implement and has higher per-glyph runtime cost.

---

## Where the Mental Model Breaks

**Thin features disappear.** The SDF can only represent features that are larger than the texel size in distance units. A hairline stroke that's 1 SDF texel wide will have a near-zero maximum negative distance — the glyph's interior barely dips below the threshold before rising back out. At rendering size, the stroke renders as a fuzzy edge or disappears entirely. The fix is generating SDFs at high resolution, but this increases atlas memory.

**Sharp corners are lost in single-channel SDF.** The classic example: a right angle in a glyph (like the corner of a capital L). The distance field near the corner is a circular arc, not a sharp point — because the nearest edge from any point near the corner is the same distance regardless of which edge you measure. This rounds corners. MSDF largely fixes this by using three channels, but MSDF still rounds extremely sharp angles (< ~30°).

**`fwidth` breaks at low resolution.** The anti-aliasing in the fragment shader uses `fwidth(dist)` — the rate of change of the SDF value per screen pixel. At very small render sizes (8px glyph), one screen pixel covers a large area of the SDF, and `fwidth` is large, which over-widens the smoothstep and blurs the glyph. Below a certain size threshold, SDF rendering is blurrier than a well-hinted bitmap font. Salsa's text rendering could switch to a bitmap font at small sizes; currently it uses SDF at all sizes.

**SDF is a rendering representation, not an editing one.** You can't reconstruct the original glyph outlines from the SDF. It's a one-way transform from vector → distance field. Any editing must happen on the vector representation; the SDF is regenerated after each edit.

---

## Common Confusions

**"SDF and MSDF are the same thing."**
Single-channel SDF stores one distance value per texel — simple, slightly blurs corners. MSDF stores three orthogonal distances per texel in RGB, takes the median at render time — preserves sharp corners. MSDF costs 3× the texture storage but is noticeably better for glyphs with hard corners (which is most of them in Latin text).

**"Threshold 0.5 is magic."**
It's not — it's a convention based on how the distance field is normalized into [0,1]. At 0.5, the stored value maps to distance = 0 (the edge). You can shift the threshold to simulate a bold font (threshold < 0.5 widens the shape) or light font (threshold > 0.5 narrows it). Salsa's text effects do exactly this for stroke effects.

**"SDF glyphs need a separate atlas per font size."**
No — that's bitmap fonts. One SDF atlas works at all sizes. The only size-related concern is that at very small sizes (where the glyph pixel count approaches the SDF texel count), quality degrades. Typically one SDF atlas at ~48px render size works well for all sizes from 10px to 500px+.

**"fwidth is the distance field gradient magnitude."**
`fwidth(v)` in WGSL returns `abs(dpdx(v)) + abs(dpdy(v))` — the sum of screen-space partial derivatives of v. For a smooth SDF this approximates the gradient magnitude scaled by screen pixel size. For a SDF with nonuniform distortion (not a true distance field — some SDFs are approximations), `fwidth` can be inaccurate and produce inconsistent edge widths.

---

## How Salsa Uses It

`src/renderer/raster/text/` — SDF glyph atlas generated on the GPU via a compute shader. Each glyph is rasterized and the SDF computed in a compute pass; glyphs are packed into a texture 2D array for the text render pass.

The text effects system (`docs/specs/text-effects.md`) chains effects as SDF threshold bands: fill (inner threshold), outline (outer band), glow (falloff from outer threshold), inner shadow (inner band offset), drop shadow (blurred copy offset in screen space). Each is a parameter adjustment in the fragment shader, not a separate render pass.

Sticky notes and speech balloons use SDF for the balloon shape itself in some render modes — allowing outlines and glows on the balloon boundary without additional geometry.

---

## Related Concepts

- [GPU Pipelines](gpu-pipelines.md) — SDF rendering requires a fragment shader that reads from the SDF atlas texture; the texture binding goes in a bind group; compute-based SDF generation uses a compute pipeline
- [UV Mapping](uv-mapping.md) — SDF atlases are sampled using UV coordinates; glyph UVs map to the atlas region containing each glyph's distance field
- [Barycentric Coordinates](barycentric-coordinates.md) — glyph UV interpolation across the quad mesh uses the same GPU barycentric interpolation as all texture sampling
