# HTML-in-Canvas 3D: Rendering HTML as a GPU Texture on 3D Meshes

## Overview

This feature lets you render any HTML content as a GPU texture and apply it to 3D meshes
(planes, ribbons, boxes, spheres, etc.).  A ribbon mesh generator follows a 3D spline path
using a Rotation-Minimizing Frame so text wraps around curves without twisting.  A `'scroll'`
Frame Link animation type drives per-frame UV scrolling for moving banners.

**Zero external dependencies.** The HTML rendering uses only the browser's native APIs.

---

## The Technique: "HTML in Canvas" (Native)

This is **not** the `html2canvas` library.  The native technique works by:

1. **Wrapping HTML in an SVG `<foreignObject>`** — SVG is the only image format the browser
   allows to embed arbitrary HTML in a 2D canvas.

2. **Blob URL + `<img>`** — Serialise the SVG to a `Blob`, create an `ObjectURL`, and load it
   into an `<img>` element.  The browser renders the full HTML layout at that point.

3. **`ctx.drawImage(img, 0, 0)`** — Copy the rendered image onto a 2D `<canvas>`.

4. **`createImageBitmap(canvas)` → `copyExternalImageToTexture`** — Upload the canvas pixels
   to a `GPUTexture` on the WebGPU device queue.

The browser's own rendering engine does the layout work, so you get:
- Full CSS (Flexbox, Grid, gradients, box shadows, transforms)
- System fonts and web-safe fonts
- Emoji and Unicode text
- RTL/vertical writing modes
- Arbitrary HTML structure (tables, lists, nested divs)

### Limitations

| Limitation | Why | Workaround |
|---|---|---|
| External images inside HTML won't load | The SVG blob is cross-origin | Inline images as base64 data URIs |
| `@font-face` with remote URL won't load | Same cross-origin restriction | Use system fonts or embed font as base64 |
| Strict CSP blocking `blob:` src | Browser security policy | Relax `img-src blob:` in CSP headers |
| Content is static (not live DOM) | Pixels are captured once per `update()` call | Call `updateHtmlTexture3D()` each time content changes |

---

## Files

| File | Purpose |
|---|---|
| `src/renderer/3d/html-texture-3d.ts` | `HtmlTexture3D` class — manages the SVG→canvas→GPUTexture pipeline |
| `src/types/ribbon-3d.ts` | `RibbonControlPoint`, `RibbonData` types |
| `src/renderer/3d/mesh-generators.ts` | `generateRibbon()`, `RibbonConfig` added |
| `src/types/keyframe-3d.ts` | `'scroll'` type added to `FrameLinkAnimation3DType`; `evalFrameLink3D` returns `uvOffset` |
| `src/services/managers/scene3d-manager.ts` | `addRibbon3D`, `setHtmlTexture3D`, `updateHtmlTexture3D`, scroll handling |
| `src/services/shape-manager.ts` | Public proxy methods for all of the above |

---

## Ribbon Mesh: Algorithm Details

### Catmull-Rom Spline

A Catmull-Rom spline is a *interpolating* spline — it passes exactly through every control
point.  Given four points P₀–P₃, the curve at parameter *t* ∈ [0,1] is:

```
P(t) = 0.5 × (
    (2·P₁)
  + (−P₀ + P₂)·t
  + (2·P₀ − 5·P₁ + 4·P₂ − P₃)·t²
  + (−P₀ + 3·P₁ − 3·P₂ + P₃)·t³
)
```

For a ribbon with N control points there are N−1 segments.  Each segment is sampled at
`segments` intervals (default 16), giving `(N−1)×segments + 1` total samples.  The
first/last control points are clamped (duplicated) so the spline begins and ends on the
first and last points.

The tangent (first derivative) is computed analytically at each sample — this is used to
orient the ribbon frame.

### Rotation-Minimizing Frame (Wang et al. 2008)

A naive Frenet-Serret frame has a well-known problem: it **rotates** whenever the curve
curves, and it is undefined at inflection points (where curvature = 0).

The **double-reflection** method (Bishop 1975, Wang et al. 2008) propagates a frame with
*minimum rotation* along the spline:

```
For each consecutive pair of samples i → i+1:
  v₁ = P[i+1] − P[i]          (chord vector)
  rL = reflect(T[i], v₁)       (reflect tangent over chord midplane)
  rN = reflect(N[i], v₁)       (reflect normal over chord midplane)
  v₂ = T[i+1] − rL             (second reflection axis)
  N[i+1] = reflect(rN, v₂)     (double-reflection gives minimal twist)
  B[i+1] = cross(T[i+1], N[i+1])
```

**Result**: the ribbon lies flat along the path with no unexpected twisting, even on helical
or looping paths.

### Ribbon Geometry

Each sample point generates four vertices (to support double-sided rendering without shader
changes):

| Vertex | Position | Normal | UV.v |
|---|---|---|---|
| Front-left | P + N·halfWidth | +B | 0 |
| Front-right | P − N·halfWidth | +B | 1 |
| Back-left | P + N·halfWidth | −B | 0 |
| Back-right | P − N·halfWidth | −B | 1 |

- **T** = spline tangent (used as mesh tangent for normal mapping)
- **N** = RMF frame normal (the ribbon's "up" direction)
- **B** = cross(T, N) = face normal (the ribbon surface faces this direction)
- **UV.u** = arc-length / total-length + uvScrollOffset (0 at start, 1 at end)

The texture tiles along the path from start to finish.  A `uvScrollOffset` shifts all U
values, which is what the scroll animation adjusts each frame.

---

## Frame Link Animation: `'scroll'`

The `'scroll'` type drives continuous UV scrolling on ribbon (or any textured) meshes.

```
uvOffset.u = (frame / framesPerCycle) × amplitude
```

- `axis: 'x'` → scroll U (along the path on a ribbon)
- `axis: 'y'` → scroll V (across the width)
- `axis: 'z'` → scroll both U and V together
- `amplitude` = total UV units scrolled per `framesPerCycle` frames

Each frame, `applyMeshKeyframesAtFrame` detects the `'scroll'` type, looks up the ribbon
data for the mesh, and calls `generateRibbon` with the updated `uvScrollOffset` before
calling `mesh.setGeometry`.  The geometry is re-uploaded to the GPU once per animation
frame — acceptable for typical ribbon segment counts (≤ 512 vertices).

---

## API Reference

### `HtmlTexture3D` (low-level)

```ts
import { HtmlTexture3D } from 'src/renderer/3d/html-texture-3d';

const ht = new HtmlTexture3D(device, 512, 128);
const tex = await ht.update('<div style="color:white;font-size:48px">Hello</div>');
mesh.diffuseTexture = tex;
mesh.material.hasTexture = true;

// Change content (reuses same GPUTexture object if size unchanged)
await ht.update('<div style="color:lime;font-size:48px">Updated!</div>');

ht.destroy(); // release GPU memory
```

### Via ShapeManager

```ts
// ── Plain Plane with HTML texture ───────────────────────────────────
const plane = shapeManager.createPlane3D(0, 0, 0, 2, 0.5);
await shapeManager.setHtmlTexture3D(plane.id, `
  <div style="
    font: bold 72px 'Arial Black', sans-serif;
    color: white;
    text-align: center;
    line-height: 128px;
    background: linear-gradient(135deg, #1a1a2e, #e94560);
  ">SALSA ENGINE</div>
`, 512, 128);

// Update content live
await shapeManager.updateHtmlTexture3D(plane.id, `
  <div style="font:bold 72px sans-serif;color:#0af;line-height:128px;text-align:center">
    FRAME ${currentFrame}
  </div>
`);

// ── Ribbon banner that curves through space ──────────────────────────
const ribbon = shapeManager.addRibbon3D(0, 0, 0,
  [
    { x: -2.0, y:  0.0, z:  0.0 },
    { x: -0.5, y:  0.4, z: -0.3 },
    { x:  0.5, y:  0.4, z:  0.3 },
    { x:  2.0, y:  0.0, z:  0.0 },
  ],
  0.35,  // width = 0.35 world units
  24,    // high-quality curve
);

await shapeManager.setHtmlTexture3D(ribbon.id, `
  <div style="
    font: bold 56px Impact, sans-serif;
    color: #fff;
    letter-spacing: 0.15em;
    white-space: nowrap;
    padding: 12px 24px;
    background: rgba(0,0,0,0.6);
  ">★ HELLO WORLD ★ HELLO WORLD ★ HELLO WORLD ★</div>
`, 1024, 80);

// Attach Frame Link scroll animation
shapeManager.setFrameLinkAnimation3D(ribbon.id, {
  enabled: true,
  type: 'scroll',
  axis: 'x',          // scroll along U (the path direction)
  amplitude: 1.0,     // scroll 1 full UV unit per framesPerCycle frames
  framesPerCycle: 60, // one full scroll every 60 frames (at 60 fps = 1 second)
  phase: 0,
});

// Make the animation drive the ribbon (attach to timeline)
shapeManager.attachKeyframesToTimeline3D();

// ── Curved title above a character ──────────────────────────────────
const arc = shapeManager.addRibbon3D(cx, cy + 1.5, cz,
  [
    { x: -0.8, y: 0.0,  z: 0 },
    { x: -0.3, y: 0.25, z: 0 },
    { x:  0.3, y: 0.25, z: 0 },
    { x:  0.8, y: 0.0,  z: 0 },
  ],
  0.3,
  20,
);
await shapeManager.setHtmlTexture3D(arc.id, `
  <div style="
    font: italic bold 48px Georgia, serif;
    color: #ffd700;
    text-shadow: 0 2px 4px rgba(0,0,0,0.8);
    text-align: center;
    padding: 8px;
  ">Frogsworth</div>
`, 384, 64);
```

---

## Design Notes

### Why not add a UV-offset uniform to the mesh shader?

Adding a per-instance `uvOffset` uniform to the WGSL mesh shader would avoid the geometry
rebuild on each scroll frame.  The current approach (regenerating ribbon vertices) was
chosen because:

1. **No shader changes** — keeps the mesh pipeline stable and avoids a new uniform layout
   in all bind groups.
2. **Ribbon segment counts are small** — a 4-segment ribbon at 16 subdivisions = 68 quads =
   408 vertices.  JavaScript computation is sub-millisecond; the GPU upload is ~40 KB.
3. **Correctness** — UV baking into vertices means the ribbon correctly handles arc-length
   parameterization at no extra cost.

If you need UV scrolling on **non-ribbon** meshes (planes, boxes) without geometry rebuild,
add a `uvOffset: [number, number]` field to `Material3D` / `MeshInstance` uniform and
update the WGSL sampler call.

### Why SVG `<foreignObject>` instead of `OffscreenCanvas`?

`OffscreenCanvas` only gives you a 2D context.  There is no native DOM layout on an
`OffscreenCanvas` — you'd have to reimplement CSS layout in JavaScript.  The SVG
`<foreignObject>` technique hands layout to the browser's actual HTML renderer, which
supports the full CSS spec.

### Browser Support

| Browser | Status |
|---|---|
| Chrome / Edge 89+ | ✅ Full support |
| Firefox 79+ | ✅ Full support |
| Safari 15.4+ | ✅ Full support |
| WebView (Android) | ✅ Generally supported |

The technique has been in all major browsers since 2021.
