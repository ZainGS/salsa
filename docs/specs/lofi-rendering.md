# Lo-Fi 3D Rendering — PS1 / 3DS Aesthetic Spec

**Status:** Not yet started  
**Goal:** Optional, non-destructive aesthetic layer that lets Frogmarks scenes replicate the look of PS1 and 3DS games in the browser.

All new settings are opt-in. The existing renderer, PS1Config, and all previously shipped features remain the default. Nothing in this spec requires changing existing behavior.

---

## What Already Exists (Foundation)

These are already in `PS1Config` / `ShapeManager` and form the base of the aesthetic:

| Feature | API | Notes |
|---------|-----|-------|
| Vertex jitter / grid snap | `vertexJitter`, `snapGridSize` | The characteristic PS1 wobble |
| Affine texture warping | `affineWarp` | Non-perspective-correct UV interpolation |
| Color depth reduction | `colorDepth` | Posterization / palette emulation |
| Nearest-neighbor sampling | `setTextureFilterMode3D('nearest')` | Hard pixel edges on textures |
| Draw-distance fog | `setFog3D` | Aggressive near/far fog hides pop-in |
| Cel render style | material `renderStyle: 'cel'` | Flat-ish shading approximation |

These are already wired and working. The new spec builds on top of them.

---

## New Features

### 1. Low-Resolution Render Buffer

**Impact: High. This is the most important missing piece.**

The entire scene (mesh pass + GP pass + post-processing) renders to a small offscreen color target at a reduced resolution, then a final blit upscales to the swapchain using nearest-neighbor magnification. The result: all geometry edges, outlines, and textures are rasterized at low resolution, giving the characteristic pixelated staircase look on diagonals. Outline staggering is emergent from this — no special outline logic needed.

Without this, vertex jitter and affine warp look "broken" at full resolution. With it, they look intentional.

```typescript
sm.setPS1Config({
  // New field:
  renderResolution: [320, 240],   // explicit target resolution
  // OR:
  renderScale: 0.25,              // scale factor relative to canvas (320 on 1280-wide canvas)
});
```

`renderResolution` takes precedence over `renderScale` when both are set. When neither is set (default), renders at full canvas resolution as today.

**Implementation sketch:**
- `Renderer3D` creates an optional `GPUTexture` (`rgba8unorm`, dimensions = `renderResolution`)
- All passes that currently target the swapchain texture (or the main HDR buffer) target this texture instead
- A final fullscreen blit pass samples it with a `GPUSampler` using `magFilter: 'nearest'`, `minFilter: 'nearest'`
- Post-processing (bloom etc.) runs at the low resolution before the blit — this is correct behavior (bloom on blocky pixels, not on the upscaled result)

**PS1 reference values:** `[320, 240]` (standard), `[640, 240]` (hi-res mode used in some games)  
**3DS reference values:** `[400, 240]` (top screen), `[320, 240]` (bottom screen); `[256, 192]` for GBA-DS era

---

### 2. Gouraud Shading Mode

**Impact: High. Makes lighting feel authentically PS1.**

Per-vertex lighting: ambient + directional light is evaluated at each vertex in the vertex shader. The interpolated result is output as a `vec4` varying and multiplied by the texture in the fragment shader. No per-pixel lighting calculations.

```typescript
// Per-mesh, on the material:
mesh.material.renderStyle = 'gouraud';   // new RenderStyle variant

// Or globally via preset (sets all meshes):
sm.setRetroPreset('wobble');
```

The fragment shader for `gouraud` style is trivial:
```wgsl
// fragment:
return textureSample(diffuseTex, samp, in.uv) * in.gouraudColor;
```

Where `in.gouraudColor` is computed in the vertex shader:
```wgsl
// vertex:
let NdotL = max(dot(worldNormal, -lightDir), 0.0);
let diffuse = lightColor * NdotL * lightIntensity;
let ambient = ambientColor * ambientIntensity;
out.gouraudColor = vec4(diffuse + ambient, 1.0);
```

This produces the characteristic smooth color gradient across faces with no specular, no rim light, no PBR. Curved surfaces get a smooth sheen; flat surfaces get a uniform shade. Exactly what you see on PS1 character meshes.

**Note:** The existing `cel`, `sketch`, `ink` render styles are unaffected. `gouraud` is a new addition to the `RenderStyle` union.

---

### 3. In-Shader Dithering

**Impact: Medium. Authentic PS1 dithering; pairs with low color depth.**

PS1 applied a Bayer dithering pattern in hardware to smooth color transitions within the 5-bit-per-channel framebuffer. When `colorDepth` is low, dithering hides banding artifacts. At full color depth it has no visible effect.

```typescript
sm.setPS1Config({
  dither: true,
  ditherStrength: 0.5,     // 0–1; how aggressively to apply the pattern
  ditherPattern: 'bayer4', // 'bayer4' | 'bayer8' | 'noise'
});
```

**Implementation:** Fragment shader addition. A 4×4 or 8×8 Bayer matrix is baked as a constant array in WGSL. The threshold value at `screen_pos % matrixSize` is added to the color before the `colorDepth` quantization step. No new textures or passes needed — a few lines in the existing fragment shader.

```wgsl
// WGSL (bayer4, inlined constant):
const bayer4 = array<f32, 16>(
  0.0/16.0,  8.0/16.0,  2.0/16.0, 10.0/16.0,
 12.0/16.0,  4.0/16.0, 14.0/16.0,  6.0/16.0,
  3.0/16.0, 11.0/16.0,  1.0/16.0,  9.0/16.0,
 15.0/16.0,  7.0/16.0, 13.0/16.0,  5.0/16.0
);
let px = vec2<u32>(in.position.xy) % 4u;
let threshold = bayer4[px.y * 4u + px.x] * ditherStrength;
color = floor(color * colorSteps + threshold) / colorSteps;
```

---

### 4. UV Quantization

**Impact: Low-Medium. Adds texture crawl to complement vertex jitter.**

PS1 UV coordinates were stored as fixed-point integers, effectively quantizing them to the texture's own pixel grid. This causes textures to "jump" between pixels rather than smoothly interpolating — especially visible on slowly-moving or rotating objects. Pairs with `affineWarp` for maximum authenticity.

```typescript
sm.setPS1Config({
  uvQuantize: true,
  uvQuantizeSteps: 64,   // texture grid size to snap to; default = texture width
});
```

**Implementation:** One line in the fragment shader before the texture sample:
```wgsl
let snappedUv = floor(uv * uvQuantizeSteps) / uvQuantizeSteps;
color = textureSample(diffuseTex, samp, snappedUv);
```

---

### 5. CRT Scanline Filter

**Impact: Medium. Popular for PS1 nostalgia; optional polish.**

A post-process pass that darkens alternating horizontal scanlines and optionally adds subtle barrel distortion. Runs after all other post-processing as the final step before the nearest-neighbor blit.

```typescript
sm.setPS1Config({
  crtScanlines: true,
  crtScanlinesIntensity: 0.25,    // 0–1; how dark the dark lines are
  crtBarrelDistortion: 0.05,      // 0–0.2; subtle screen curvature
  crtScanlineSpacing: 2,          // pixels per scanline (1 = every other line, 2 = every 3rd, etc.)
});
```

**Implementation:** A final fullscreen pass that runs between the scene render and the swapchain blit. Fragment shader:
```wgsl
// Barrel distortion (optional):
let centered = in.uv * 2.0 - 1.0;
let r2 = dot(centered, centered);
let distorted = centered * (1.0 + barrel * r2);
let finalUv = (distorted + 1.0) * 0.5;

// Scanlines:
let line = u32(in.position.y) % (scanlineSpacing + 1u);
let scanlineFactor = select(1.0, 1.0 - scanlinesIntensity, line == 0u);

return textureSample(sceneTex, samp, finalUv) * vec4(scanlineFactor);
```

When `crtBarrelDistortion = 0` and `crtScanlinesIntensity = 0`, the pass is a no-op and can be skipped entirely.

---

## Preset Helpers

Convenience methods that configure all relevant settings at once. Individual `setPS1Config` calls still work for fine-tuning.

```typescript
// Apply the Wobble preset (all settings):
sm.setRetroPreset('wobble');

// Apply the Pocket preset:
sm.setRetroPreset('pocket');

// Reset to default (disables all retro effects):
sm.setRetroPreset('off');
```

### Wobble Preset Values

```typescript
// What setRetroPreset('wobble') applies:
sm.setPS1Config({
  vertexJitter:         0.8,
  snapGridSize:         160,
  affineWarp:           0.6,
  colorDepth:           32,
  renderResolution:     [320, 240],
  dither:               true,
  ditherStrength:       0.45,
  ditherPattern:        'bayer4',
  uvQuantize:           true,
  uvQuantizeSteps:      64,
  crtScanlines:         false,    // off by default; user opts in
  crtScanlinesIntensity: 0.25,
  crtBarrelDistortion:  0.0,
});
sm.setTextureFilterMode3D('nearest');
sm.setFog3D({ mode: 'linear', color: [0.0, 0.0, 0.0], near: 8, far: 20 });
// Does NOT set renderStyle — Frogmarks should set 'gouraud' per-mesh
```

### Pocket Preset Values

```typescript
// What setRetroPreset('pocket') applies:
sm.setPS1Config({
  vertexJitter:         0,        // 3DS had stable floating-point vertices
  snapGridSize:         512,      // minimal snapping
  affineWarp:           0,        // 3DS was perspective-correct
  colorDepth:           256,      // near-full color
  renderResolution:     [400, 240],
  dither:               false,
  uvQuantize:           false,
  crtScanlines:         false,
});
sm.setTextureFilterMode3D('nearest');
sm.setFog3D({ mode: 'linear', color: [0.85, 0.9, 1.0], near: 12, far: 30 });
```

The 3DS look is mostly achieved by: low-res buffer + nearest sampling + cel/gouraud render style + bright ambient + low-poly meshes. Less wobble than PS1, more like "clean lo-fi."

---

## Full Extended PS1Config Shape

```typescript
interface PS1Config {
  // Existing:
  vertexJitter: number;           // 0–2, vertex snap wobble intensity
  snapGridSize: number;           // 64–512, integer grid resolution
  colorDepth: number;             // 8–256, color quantization steps
  affineWarp: number;             // 0–1, non-perspective UV warp

  // New:
  renderResolution?: [number, number];  // explicit [w, h] target; null = full canvas
  renderScale?: number;                 // 0.1–1.0 scale of canvas; ignored when renderResolution set
  dither?: boolean;                     // enable Bayer dithering (default false)
  ditherStrength?: number;              // 0–1 (default 0.5)
  ditherPattern?: 'bayer4' | 'bayer8' | 'noise'; // (default 'bayer4')
  uvQuantize?: boolean;                 // snap UVs to texel grid (default false)
  uvQuantizeSteps?: number;             // grid resolution (default 64)
  crtScanlines?: boolean;               // horizontal scanline darkening (default false)
  crtScanlinesIntensity?: number;       // 0–1 (default 0.25)
  crtScanlineSpacing?: number;          // pixels between dark lines (default 1)
  crtBarrelDistortion?: number;         // 0–0.2 screen curvature (default 0)
}
```

`setPS1Config` continues to accept partial updates (patch semantics), same as today.

---

## Render Style Addition: `'gouraud'`

```typescript
type RenderStyle = 'default' | 'cel' | 'sketch' | 'ink' | 'gouraud';
//                                                          ^^^ NEW
```

Set per-mesh on the material:
```typescript
mesh.material.renderStyle = 'gouraud';
sm.scene3d.updateMeshMaterial(mesh.id, mesh.material);
```

`'gouraud'` uses per-vertex lighting (vertex shader computes ambient + NdotL diffuse, outputs as a varying color). The fragment shader multiplies the interpolated lighting by the texture sample. No specular, no rim, no PBR. Skinned meshes and static meshes both get the variant.

---

## Frogmarks Panel Guidance

Suggested "Lo-Fi / Retro" collapsible section in the 3D panel:

```
▸ RETRO STYLE ─────────────────────────────
  Preset   [Off ▾] / [PS1 ▾] / [3DS ▾]

  ── Resolution ──────────────────────────
  [320 × 240]  or  Scale [25%]

  ── Geometry ────────────────────────────
  Vertex Wobble  [0.8  ════●═══]
  Snap Grid      [160  ══●═════]
  Affine Warp    [0.6  ═══●════]

  ── Color ───────────────────────────────
  Depth          [32   ●═══════]
  [✓] Dithering  Strength [0.45 ══●════]

  ── Shading ─────────────────────────────
  Style   [Gouraud ▾]   (applies to all meshes)

  ── Post ────────────────────────────────
  [✓] Scanlines   Intensity [0.25]
  Barrel          [0.0  ●═══════]
```

The preset dropdown should call `sm.setRetroPreset('wobble' | 'pocket' | 'off')` then refresh all panel controls from current config. Individual sliders call `sm.setPS1Config({ field: value })`.

---

## Implementation Order (Recommended)

| Step | Work | Effort | Impact |
|------|------|--------|--------|
| 1 | Low-res render buffer + nearest blit | ~1 session | Highest — unlocks outline stagger, all geometry pixelation |
| 2 | `gouraud` render style variant | ~0.5 session | High — authentic PS1 lighting feel |
| 3 | In-shader dithering | ~0.5 session | Medium — best paired with low colorDepth |
| 4 | UV quantization | ~0.25 session | Low-medium — tiny shader change, visible effect on textured meshes |
| 5 | CRT scanline filter | ~0.5 session | Optional polish |
| 6 | Preset helpers + Frogmarks panel | ~0.5 session | UX |

Total: ~3.5 sessions. Steps 1–2 alone get you 80% of the aesthetic.

---

## What These Settings Will NOT Affect

- The 2D/raster layer pipeline is unaffected
- The GP (grease pencil) renderer is unaffected
- Existing `cel`/`sketch`/`ink` render styles are unaffected
- All existing ShapeManager APIs remain identical
- Any scene not using `setRetroPreset` or the new PS1Config fields renders exactly as before

---

## Known Non-Goals

- **Z-fighting simulation** — PS1 lacked a full Z-buffer; some games had polygon sorting artifacts. Salsa uses a proper depth buffer and this will not be changed. The jitter already creates visual noise that reads similarly.
- **Binary alpha** (`alphaTest` cutout transparency) — PS1 frequently used hard-edge transparency (no alpha blending). This is a useful future addition but not in this spec.
- **Pre-baked vertex lighting** — some PS1 games baked all lighting into vertex colors at export time (no real-time lights at all). Salsa's weight-paint + vertex color pipeline can approximate this already if Frogmarks paints lighting manually; no new API needed.
- **Stereoscopic 3DS rendering** — out of scope for web.
