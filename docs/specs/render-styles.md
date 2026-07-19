# Frogmarks — 3D Render Styles
**Last Updated:** 2026-05-07  

> **Status: COMPLETE** — Engine implementation done. Frogmarks UI is responsible for exposing the render style selector per-mesh.
> **Update 2026-06-26:** added the **Cel-HD** style (flat diffuse + smooth glossy specular) and a **rim-light** modifier (see §Modifiers).

## What was built

Every 3D mesh now has a `renderStyle` property that changes how its fragment shader computes lighting. Four styles are available:

| Style | Description | Best for |
|---|---|---|
| `'default'` | Standard Phong/Gouraud shading | General 3D rendering, PS1 mode |
| `'cel'` | Stepped diffuse bands + hard specular (toon/anime look) | Character illustration, anime |
| `'cel-hd'` | Cel's flat stepped diffuse + a **smooth** Blinn-Phong specular (glossy highlight) | Polished stylised characters — skin sheen, "HD anime" |
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

### Cel-HD (`'cel-hd'`)
- **Same flat 3-band diffuse as Cel** (the anime look is preserved) — but the **specular is a smooth Blinn-Phong highlight** (`pow(N·H, shininess)`) instead of Cel's hard on/off blob, only on the lit side.
- That soft glossy band on a curved surface (an arm, a cheek) is what reads as "HD" — flat shading + a polished highlight, the hybrid most stylised-but-clean characters use.
- Cel is untouched — this is a separate, opt-in style. Pair with the **rim-light** modifier below for the full mood-board look.
- `shininess` (material) controls the highlight tightness; `specular` rgb its colour/intensity.

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

## Modifiers (layer on ANY render style)

These are **material flags** that add *on top* of whatever `renderStyle` is set — independent toggles, not styles (all packed into `encodeMaterialFlags`). So you can do Cel-HD + rim, Cel + rim, PBR + rim, etc.

| Modifier | Flag | Effect |
|---|---|---|
| **Rim light** | `material.rimEnabled` | Fresnel **silhouette back-light glow**, tinted by the scene light, stronger when backlit — the "HD anime" edge light. |
| **Hair sheen** | `material.hairSheen` | Anisotropic Kajiya-Kay highlight **along** the strands (the lengthwise hair shine). See hair-generation.md §15a. |
| **Alpha cutout** | `material.alphaCutout` | Discards diffuse-texture alpha < 0.5 (alpha-card hair). Order-independent. See hair-generation.md §14. |

### Rim light
- A **Fresnel edge** term — bright where the surface faces away from the camera (the silhouette) — tinted by `scene.lightColor`, and **light-aware** (stronger where the key light doesn't hit, i.e. backlit). It layers *after* the style's lighting, so it works on Cel, Cel-HD, PBR, anything.
- **Per-character toggle:** `sm.setCharacterRimLight3D(bodyMeshId, on)` sets `rimEnabled` on the body skin + all attached parts (face / hair / clothing). **UI: an "Enable Rim Light" checkbox** on the character.
- v1 uses a fixed power/strength + the scene light's **colour** (so a coloured light → a coloured rim — matches the "Color Light" reference). A per-scene rim colour/strength is an easy follow-up (a `SceneUniforms` add) if independent control is wanted.
- Distinct from the **ink outline pass** (a screen-space dark border): rim is an *inner* light glow at grazing angles, the outline is a flat edge line. They compose.

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
