# Per-Object Outlines (Frogmarks UI guide)

Assign a **persistent outline** to any object — its own colour, an optional scrolling pattern, thickness, and glow.
Works on regular meshes **and** rigged (skinned) characters. Outlines **persist across save/reload** (stored on the
mesh), so the panel only needs to read/write the style; Salsa handles drawing, animation keep-alive, and persistence.

This is separate from the **hover/select** outline (that's automatic on pointer hover; see `setHoverOutlineStyle3D`).
This doc is the **user-assigned, always-on** outline.

## Engine API

```ts
sm.setMeshOutline3D(meshId: string, style: Partial<HighlightStyle>): boolean   // assign / update (merges onto current)
sm.clearMeshOutline3D(meshId: string): boolean                                 // remove the outline
sm.getMeshOutline3D(meshId: string): HighlightStyle | null                     // current style, or null if none
```

- All three return `false` / `null` if the mesh id doesn't resolve.
- `setMeshOutline3D` **merges** the partial onto the mesh's current outline (or onto the default if none yet), so you
  can push one field at a time from a control (e.g. just `{ color }` on a colour-picker change).
- The type `HighlightStyle` is exported from the package (`import type { HighlightStyle } from '@zaings/salsa'`).

## The style fields

| Field | Type | Meaning |
|---|---|---|
| `color` | `[r,g,b,a]` 0..1 | **Primary** outline colour (and the flat colour when no pattern). `a` is opacity. |
| `patternColor` | `[r,g,b]` 0..1 | **Secondary** colour — the pattern's second tone. |
| `patternMode` | `number` | `0` flat (solid `color`) · `1` scrolling stripes · `2` dots · `3` checker. |
| `speed` | `number` | Pattern scroll speed. `0` = static. Non-zero animates (Salsa keeps frames flowing automatically). |
| `freq` | `number` | Pattern density (higher = finer/more repeats). ~20 is a good start. |
| `width` | `number` | Outline thickness in **model-space** units (how far the shell expands). ~0.03 is a thin line. |
| `glow` | `number` | Brightness multiplier; `>1` makes the outline **bloom** (if bloom/post is on). `1` = normal. |
| `merge` | `boolean` | Depth behaviour. `false` (default) = **depth-sorted**: an object behind another is behind its outline; in front is in front. `true` = **on-top / merge**: the outline (and its silhouette mask) ignore depth, so it's drawn over everything — two overlapping objects' outlines visually **merge** into one silhouette instead of the nearer occluding the farther. |
| `thicknessPx` | `number` | **Ignored for object outlines** — it's only used by the hover silhouette pass. Leave the default. |

**Defaults** (what you get if you pass `{}`): opaque **black**, `width 0.03`, `patternMode 0` (flat), `freq 20`,
`speed 0`, `glow 1`. So `sm.setMeshOutline3D(id, {})` gives a classic thin black outline; override from there.

### Examples

```ts
// Plain white line
sm.setMeshOutline3D(id, { color: [1,1,1,1], width: 0.03 });

// Red/yellow scrolling stripes, glowing
sm.setMeshOutline3D(id, { color:[1,0,0,1], patternColor:[1,1,0], patternMode:1, speed:1, freq:24, glow:1.6 });

// Thicker checker for a character
sm.setMeshOutline3D(characterId, { color:[0,0,0,1], patternColor:[0.2,0.9,1], patternMode:3, speed:0.5, width:0.05 });

sm.clearMeshOutline3D(id);   // remove
```

## Suggested panel

A small **Outline** section on the selected object's inspector:

```
▾ Outline
  ☐ Enabled                         → checkbox: on = setMeshOutline3D(id, current||{}); off = clearMeshOutline3D(id)
  Color      ■  [rgba picker]        → { color }
  Pattern    [ None ▾ ]              → None=0 / Stripes=1 / Dots=2 / Checker=3  → { patternMode }
  2nd color  ■  [rgb picker]         → { patternColor }   (hide when Pattern = None)
  Width      ●────  0.03             → { width }          (small range, e.g. 0.005–0.2)
  Density    ●────  20               → { freq }           (hide when Pattern = None)
  Scroll     ●────  0                → { speed }          (hide when Pattern = None; 0 = static)
  Glow       ●────  1.0              → { glow }           (0.5–3)
  ☐ Merge (on top)                   → { merge }          (checkbox; off = depth-sorted, on = draw over everything)
```

Wiring notes:
- On any control change, call `sm.setMeshOutline3D(selectedId, { <changed field> })` — it merges, so partial updates are fine.
- Populate the controls from `sm.getMeshOutline3D(selectedId)` on selection; if it returns `null`, show the section
  collapsed / "Enabled" off with default values.
- **No redraw call needed** — the setters schedule the render, and animated outlines (`speed ≠ 0`) keep animating on
  their own even when the pointer is still.
- **No persistence work** — outlines save and reload with the document automatically.

## What Salsa handles for you

- Drawing (inverted-hull stencil ring), the scrolling animation clock, and **keep-alive** (animated outlines don't
  freeze when the mouse stops).
- **Regular meshes and skinned characters** both — the character's outline tracks its animation pose, no rig setup.
- Save/reload round-trip (the style lives on the mesh).

## Caveats

- **Browser-verify (WGSL is runtime-compiled):** confirm an outline appears, a scrolling pattern animates, a
  character's outline hugs its silhouette while it animates (not stuck in bind pose), and unoutlined objects look
  unchanged.
- Outlines draw on **visible** meshes (an outline on a hidden mesh won't show until it's shown).
- `thicknessPx` is a hover-outline field only; don't surface it here.

## Related

- `sm.setHoverOutlineStyle3D(style)` — the automatic hover halo (same `HighlightStyle` shape). See the hover-outline
  behaviour; you may want the two to share a look.
- Future: the same `patternMode` / `freq` / `speed` / two-colour vocabulary is intended to drive UI/dialogue-box
  styling, so a character's outline and their text frame can match.
