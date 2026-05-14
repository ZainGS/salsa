# Frogmarks — 3D Render Styles
**Last Updated:** 2026-05-07  

> **Status: COMPLETE** — Engine implementation done. Frogmarks UI is responsible for exposing the render style selector per-mesh.

## What was built

Every 3D mesh now has a `renderStyle` property that changes how its fragment shader computes lighting. Four styles are available:

| Style | Description | Best for |
|---|---|---|
| `'default'` | Standard Phong/Gouraud shading | General 3D rendering, PS1 mode |
| `'cel'` | Stepped diffuse bands + hard specular (toon/anime look) | Character illustration, anime |
| `'sketch'` | Procedural crosshatch shading (pencil-drawn look) | Concept art, hand-drawn feel |
| `'ink'` | Flat color + view-space rim darkening (manga look) | Comic books, ink illustration |

Render style is **per-mesh** — different meshes in the same scene can use different styles.

---

## API

```typescript
// Set style
shapeManager.setRenderStyle3D(meshId, 'cel');
shapeManager.setRenderStyle3D(meshId, 'sketch');
shapeManager.setRenderStyle3D(meshId, 'ink');
shapeManager.setRenderStyle3D(meshId, 'default');  // reset

// Get current style
const style = shapeManager.getRenderStyle3D(meshId);  // returns 'default' | 'cel' | 'sketch' | 'ink' | null

// Set on a mesh directly (if you have the Mesh3D reference)
mesh.material.renderStyle = 'cel';
mesh.gpuDirty = true;
```

Changing style takes effect on the next rendered frame — no pipeline rebuild, no GPU stall. The flag is packed into the existing `encodeMaterialFlags` uniform.

---

## UI: Style picker in mesh properties panel

Add a style selector row to the mesh inspector panel (below material color controls):

```
Render Style: [ Default ▾ ]
               Default
               Cel / Toon
               Sketch
               Ink / Manga
```

Or use icon buttons if you have space:

```
[ ◈ Default ] [ ≡ Sketch ] [ ◎ Cel ] [ ◆ Ink ]
```

On change:
```typescript
onStyleChange(meshId: string, style: string): void {
  this.shapeManager.setRenderStyle3D(meshId, style as any);
}
```

---

## Style behavior details

### Cel (`'cel'`)
- Diffuse light is quantized into **3 hard bands**: fully shadowed / mid-tone / fully lit
- Specular is a single hard cutoff (step at 0.97 of the highlight peak) — no soft falloff
- Works best with saturated diffuse colors and a strong directional light
- Combine with the PS1 vertex jitter for an extra retro feel

### Sketch (`'sketch'`)
- Ignores diffuse color mostly — output is **paper + ink**
- Paper: off-white tinted very slightly by the mesh's diffuse color
- Ink lines: three crosshatch layers at different angles, activated progressively in shadows
- At full light: blank paper. At mid-shadow: light hatching. Deep shadow: dense crosshatch
- If the mesh has a texture: the texture is blended softly with the sketch output (50%)
- Works best on meshes with large flat faces (characters, props) rather than very curved geometry

### Ink (`'ink'`)
- Two-tone: lit surface at full diffuse color, shadow at 25% brightness
- The silhouette rim (edges where the surface faces away from the camera) darkens sharply
- Gives the classic manga/comic "ink wash" look without needing a separate outline pass
- Works extremely well combined with the 2D brush strokes on top in Frogmarks — the 3D mesh looks hand-inked

---

## Combining styles with PS1 mode

Render styles are independent of PS1 aesthetic config:
- `cel` + PS1 vertex jitter = wobbly cartoon (great TikTok aesthetic)
- `sketch` + high colorDepth quantization = sketchy + limited palette
- `ink` + low snapGridSize = flat ink with PS1 grid warping

Set PS1 config via `shapeManager.setPS1Config3D({ vertexJitter: 0.8, ... })` as before.

---

## Ink outline pass — IMPLEMENTED ✓

Screen-space Sobel edge detection on the depth buffer. Draws silhouette lines around all 3D meshes at once (scene-level, not per-mesh).

```typescript
// Enable (black outline, default sensitivity)
shapeManager.enableOutlines3D();

// Enable with custom colour + threshold
shapeManager.enableOutlines3D([0, 0, 0, 0.9], 0.0003);

// Adjust after the fact
shapeManager.setOutlineColor3D(0.05, 0.02, 0.1, 1);   // dark purple
shapeManager.setOutlineThreshold3D(0.0002);             // thicker lines

shapeManager.disableOutlines3D();
```

The outline pass is independent of per-mesh render style — you can layer them:
- `ink` style + outline = bold manga look
- `cel` style + no outline = flat toon (fill only)
- `sketch` style + outline = pencil sketch with dark border

Files: `src/renderer/3d/outline-pass.ts`, `src/renderer/3d/shaders/outline-shaders.ts`

See `docs/reference/15-3d-rendering-system.md` → "Screen-Space Ink Outline Pass" for architecture details.
