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

### Characters-only outlines (scene setting, persona-polish E3)

```ts
sm.setCharacterOutlines3D(style: Partial<HighlightStyle> | null): number   // outline every procedural character; null = off
sm.getCharacterOutlines3D(): Partial<HighlightStyle> | null               // the setting, or null when off (default)
```

- This applies the per-object outline to every procedural character: the body, with its clothes and hair drawn as one
  union silhouette. Characters created later get the same outline. Scenery is never touched.
- `style` merges onto the characters default, a thin near-black ink line (`color [0.04, 0.03, 0.05, 1]`,
  `width 0.012`). So `{}` gives the default look.
- `null` clears the outline on every procedural body. The call returns how many characters were updated.
- The setting is saved with the scene settings (`characterOutlines`), and each body also keeps its own outline.
  After setting it, you can still change one character with `setMeshOutline3D`.

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
| `wobble` | `number` | **Line boil** 0..1 — the band's thickness varies along the line by up to ±wobble (hand-drawn look). `0` (default) = even. |
| `boilFps` | `number` | How many times a second the wobble re-draws (8–12 = classic animation boil; `0` = uneven but still). Default 10. |
| `wobbleFreq` | `number` | Wobbles per model unit (default 10). |
| `spriteShape` | `'image' \| 'square' \| 'card'` | **Sprites only** — the outline follows the picture (default), the square, or a solid filled card. See "Sprite outline shape" below. Ignored by every other mesh. |
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

## Stacked outlines (rings) ✅ 2026-09-28

Stack more outlines OUTSIDE the first — e.g. a red outline, then a white ring around it (the sticker / fighting-game
look):

```ts
sm.setMeshOutline3D(id, { color: [1, 0, 0, 1], width: 0.03 });              // the inner outline (as before)
sm.setMeshOutlineRings3D(id, [                                                // rings, inner → outer
  { color: [1, 1, 1, 1], width: 0.02 },                                       //   white ring around the red
  { color: [0, 0, 0, 1], width: 0.01 },                                       //   thin black ring around that
]);
sm.getMeshOutlineRings3D(id);                                                 // → the rings ([] if none)
sm.setMeshOutlineRings3D(id, []);                                             // back to a single outline
```

- Each ring's `width` is **its own** thickness (it's added on top of everything inside it).
- Fields a ring doesn't set (pattern, glow, merge…) come from the main outline, so `{ color, width }` is enough.
- Rings wrap the main outline, so they draw only while it's set. Clearing the outline hides them; re-enabling
  brings them back. They persist with the document. A character gets rings around its one whole silhouette.

**Suggested UI** (under the Outline section): a **Rings** list — each row = colour swatch + opacity + width slider +
✕; a **+ Add ring** button appends `{ color: white, width: 0.02 }`. On any change, send the whole list to
`setMeshOutlineRings3D(selectedId, rows)`; seed the rows from `getMeshOutlineRings3D(selectedId)`.

## Sprite outline shape ✅ 2026-09-29 — **UI requested**

A **Sprite** (a flat picture, often a transparent PNG such as an icon, reaction or sticker) has three outline shapes,
chosen with one style field, `spriteShape`:

| `spriteShape` | Look | Good for |
|---|---|---|
| `'image'` (default) | The outline hugs the **picture's shape**; the see-through parts stay see-through. | Stickers, icons, cut-out characters |
| `'square'` | The outline goes around the **square** sprite; the see-through parts stay see-through. | A framed / boxed look |
| `'card'` | A **solid card**: the see-through parts of the square are filled with the outline's colour, and the rings go around the square. | Persona-style callouts, trading-card frames, comic panels |

```ts
sm.setMeshOutline3D(id, { spriteShape: 'card' });   // or 'image' / 'square'
```

Everything else is unchanged: `setMeshOutline3D` / `setMeshOutlineRings3D`, and colour, pattern, glow, merge, rings
and line boil all work with every shape. It's saved with the document. Other meshes ignore `spriteShape`.

### Please add: an "Outline shape" dropdown for sprites

In the Outline section, **only when the selected object is a sprite**:

```
▾ Outline
  ...
  Shape   [ Follow image ▾ ]         → Follow image = 'image' · Square = 'square' · Solid card = 'card'
                                       → sm.setMeshOutline3D(id, { spriteShape })
```

- **Is it a sprite?** `sm.getMesh3D(id)?.meshPrimitive === 'sprite'`.
- **Current value:** `sm.getMeshOutline3D(id)?.spriteShape ?? 'image'`.
- **With Solid card,** the main outline's **Color** also sets the card's fill colour. You could label it "Card / line
  color" while the shape is Solid card.

### Recipe: Persona-style card

A solid black card with a jagged, hand-cut red border:

```ts
sm.setMeshOutline3D(id, { spriteShape: 'card', color: [0, 0, 0, 1], width: 0.04, wobble: 0.6, boilFps: 5, wobbleFreq: 6 });
sm.setMeshOutlineRings3D(id, [{ color: [0.9, 0.05, 0.1, 1], width: 0.06, wobble: 0.6, boilFps: 5, wobbleFreq: 6 }]);
```

Tilting the sprite a few degrees sells the look.

### Details

- **Follow image** needs an image with at least one see-through pixel. Salsa measures the picture's shape once per
  image, which takes a few ms. The sprite shows the square outline for the first frame or two, then switches.
- A fully opaque image looks the same as **Square**.
- **Follow image** uses the square outline for **sprite-sheet frames** (tiled/offset texture). **Solid card** works
  with them.
- **Limit (Follow image):** all rings together reach at most about **a quarter of the sprite's longer side** outward;
  wider settings are clamped. Square and Solid card have no limit.
- Old style field: `alphaShape: false` (briefly shipped) still means Square. Use `spriteShape` from now on.

## What Salsa handles for you

- Drawing (inverted-hull stencil ring), the scrolling animation clock, and **keep-alive** (animated outlines don't
  freeze when the mouse stops).
- **Regular meshes and skinned characters** both — the character's outline tracks its animation pose, no rig setup.
- Save/reload round-trip (the style lives on the mesh). **Characters:** the outline + rings live on the character's
  BODY — setting them with a garment / the hair / a charm selected redirects to the body (the character is outlined as one
  silhouette, and its parts are rebuilt from params), so they persist across reloads and slider changes.

## Caveats

- **Browser-verify (WGSL is runtime-compiled):** confirm an outline appears, a scrolling pattern animates, a
  character's outline hugs its silhouette while it animates (not stuck in bind pose), and unoutlined objects look
  unchanged.
- Outlines draw on **visible** meshes (an outline on a hidden mesh won't show until it's shown).
- `thicknessPx` is a hover-outline field only; don't surface it here.
- **Sprite outline shapes — browser-verify:** on a transparent-PNG sprite, Follow image hugs the picture, Square
  frames the square, and Solid card fills the see-through parts. Check each while billboarding, with rings and with
  line boil. Every non-sprite outline must look exactly as before.

## Related

- `sm.setHoverOutlineStyle3D(style)` — the automatic hover halo (same `HighlightStyle` shape). See the hover-outline
  behaviour; you may want the two to share a look.
- Future: the same `patternMode` / `freq` / `speed` / two-colour vocabulary is intended to drive UI/dialogue-box
  styling, so a character's outline and their text frame can match.
