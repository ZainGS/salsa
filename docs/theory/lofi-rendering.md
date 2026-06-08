# Theory: Lo-Fi / Retro Rendering

**Covers:** Ordered (Bayer) dithering, nearest-neighbor upscaling, UV quantization, gouraud shading, and why the PS1 look emerges from these techniques.

---

## Nearest-Neighbor Upscaling (Lo-Res Buffer)

The most visible part of the PS1 aesthetic is pixelation. Salsa achieves this by rendering the 3D pass to a small off-screen texture (e.g. 320×240) and blitting it to the full canvas with a nearest-neighbor sampler.

```
3D geometry → lo-res render target (320×240)
                         ↓ blit (nearest-neighbor sampler)
              full canvas (e.g. 1920×1080)
```

A nearest-neighbor sampler chooses the texel whose center is closest to the sample point with no interpolation between neighbors. Each lo-res texel maps to a rectangular block of full-res pixels, producing the hard-edged pixel blocks characteristic of low-polygon 3D games.

**Why not just scale the canvas?** Scaling the canvas would also downscale the 2D layers (line art, text, UI). The lo-res buffer isolates pixelation to the 3D geometry only; vector lines and raster paint remain crisp at full canvas resolution.

**Outline stagger is emergent.** Silhouette edges in a low-polygon mesh appear jagged and "stairstepped" after nearest-neighbor upscaling — not because of any special outline code, but because a slanted edge rasterized at 320 pixels wide produces much coarser stair steps than one rasterized at 1920 pixels wide. No special logic is needed.

---

## Bayer Ordered Dithering

Color quantization (reducing to N color steps) introduces harsh banding — large smooth gradients snap to discrete values. Dithering diffuses these bands into a noise pattern that the eye integrates as smoother tone.

**Ordered dithering** uses a fixed threshold matrix rather than error diffusion, making it predictable, spatially local, and GPU-friendly (no state between pixels).

### Bayer 4×4 Matrix

The 4×4 Bayer matrix is the standard for ordered dithering:

```
 0   8   2  10
12   4  14   6
 3  11   1   9
15   7  13   5
```

Normalized to [0, 1] by dividing by 16, each entry is a threshold for one pixel in the repeating 4×4 tile. The matrix is constructed to spread threshold values maximally across the tile — adjacent pixels in the same row never have similar thresholds.

### Dithering Before Quantization

The correct ordering is: **add threshold → quantize → display**. This is called pre-dithering or error prevention:

```
quantized = floor(color × depth + threshold) / depth
```

Where `threshold = bayer4[px.y % 4][px.x % 4] × ditherStrength`.

If you quantize first and dither after, you shift already-quantized values, potentially creating colors outside the palette. Pre-dithering ensures the final value is always a valid quantization step.

**ditherStrength** scales the threshold amplitude. At `0` there is no dithering (pure banding). At `1` the full Bayer range `[0, 1/depth]` is applied — maximum noise. Values around `0.4–0.5` produce authentic PS1 dithering without being visually overwhelming.

### Why the Bayer Pattern Looks "PS1"

PS1 hardware used ordered dithering for exactly the same reason — it's stateless and fast on fixed-function hardware. The repeating 4×4 tile pattern became a visual signature of that era.

---

## UV Quantization

PS1 had 8-bit fixed-point UV coordinates. Instead of a float like `0.312`, it stored something like `floor(0.312 × 256) / 256 = 0.3125`. This quantization caused texture coordinates to jump in discrete steps as polygons moved, producing the "texture swimming" artifact.

Salsa replicates this in the fragment shader before the texture sample:

```wgsl
var sampUv = uv;
if (uvQSteps > 0.5) {
    sampUv = floor(uv * uvQSteps) / uvQSteps;
}
let color = textureSample(diffuseTexture, diffuseSampler, sampUv);
```

With `uvQuantizeSteps = 64`, a UV of `0.312` snaps to `floor(0.312 × 64) / 64 = 19/64 ≈ 0.297`. The effect is subtle on static meshes but visible on animated or perspective-projected geometry where UVs change continuously — the texture appears to "slide" in steps.

**Interaction with UV warping (affineStrength):** Affine texture mapping already distorts UVs by removing the perspective-correct divide. UV quantization adds a second distortion on top. Together they closely recreate the PS1 texture artifact.

---

## Gouraud Shading

Per-pixel PBR lighting (Cook-Torrance BRDF) is anachronistic for a PS1 aesthetic — real PS1 hardware computed lighting per-vertex, not per-pixel.

Gouraud shading computes `ambient + diffuse` at each vertex in the vertex shader and interpolates the result across the triangle. The fragment shader receives the interpolated color and uses it directly:

```wgsl
// Vertex shader computes:
let diffuse = max(dot(worldNormal, normalize(lightDir)), 0.0);
out.color = vec4(ambientColor + lightColor * diffuse, 1.0);

// Fragment shader with renderStyle == 4 (gouraud):
lit = gouraudColor.rgb;   // skip PBR entirely
```

**Why per-vertex?** PS1 had no fragment shaders at all — the rasterizer interpolated vertex colors using a fixed-function pipeline. Gouraud shading in Salsa matches this by doing all lighting math at the vertex stage and bypassing per-pixel calculations.

**Visual effect:** On low-polygon meshes, Gouraud produces the characteristic "flat-shaded with soft gradient" look — faces with few vertices show banding where the interpolated light value changes abruptly across long edges. This is most visible on large flat polygons near a point light.

**Combining with lo-fi preset:** Using `renderStyle = 'gouraud'` alongside `setRetroPreset3D('wobble')` (which enables vertex jitter, dithering, UV quantization, and lo-res buffer) gives the most authentic wobble look. Gouraud shading is a per-mesh material property; the lo-fi preset is a scene-global renderer config. They are independent and composable.

---

## Vertex Snapping (vertexJitter)

PS1 processed 3D vertices in a 16-bit fixed-point coordinate space. Vertices snapped to integer grid positions in screen space, causing polygon edges to wobble as the mesh moved or rotated. This is the most immediately recognizable PS1 artifact.

Salsa approximates this in the vertex shader by quantizing clip-space X/Y to a grid before output:

```wgsl
let grid = ps1Config.snapGridSize;
let snapped = floor(clipPos.xy / clipPos.w * grid + 0.5) / grid * clipPos.w;
pos.xy = mix(clipPos.xy, snapped, ps1Config.vertexJitter);
```

`vertexJitter` blends between the original position and the snapped position. At `0` there is no snapping; at `1` it is fully snapped; values above `1` overshoot the grid.

**Why multiply/divide by w?** The quantization needs to happen in NDC space (after perspective divide). Multiplying by `w` before output re-encodes NDC quantization in clip space, which is what the GPU consumes.

---

## Rendering Pipeline Summary

With all PS1 effects active, the per-frame pipeline is:

```
1. CPU: upload vertexJitter, snapGridSize, affineStrength, colorDepth
        upload ditherStrength (ps1Config2.x), uvQuantizeSteps (ps1Config2.y)
   
2. GPU vertex shader (per vertex):
   a. Compute world position, normal, UV as normal
   b. Snap clip-space XY to grid (vertex jitter)
   c. Compute gouraud color (if renderStyle == 4)
   d. Optionally perturb UV.w for affine mapping

3. GPU fragment shader (per pixel):
   a. UV quantization: floor(uv * uvQSteps) / uvQSteps
   b. Texture sample at quantized UV
   c. Select lighting: gouraud color OR PBR
   d. Bayer threshold lookup from fragPos.xy % 4
   e. Pre-dithered quantization: floor(color * depth + threshold) / depth
   f. Fog blend

4. LoFiPass blit:
   - Nearest-neighbor sample of lo-res 3D texture
   - Alpha-composite over main pass background
   - 2D layers (raster, GP) drawn at full resolution afterward
```

Each step independently contributes to the aesthetic and can be toggled independently via `PS1Config`.
