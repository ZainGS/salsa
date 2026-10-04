# Persona UI kit (screen-space HUD, menus and transitions)

The UI kit is a set of parametric screen-space pieces for the UI System, in a Persona-inspired style: slanted red,
black and white panels, halftone, kinetic type and stylised transitions. All shapes and wording are original, and the
kit uses system fonts only.

It is item 15 of [visual-polish-next.md](../specs/visual-polish-next.md). The engine reference is in
[ui-system.md](../specs/ui-system.md) §"UI kit".

## What it is

- **Kit widgets** are plain data on a UI layer (`UILayerData.kit`).
  - Each widget has a kind, an anchor (`tl tc tr ml c mr bl bc br`), an x / y offset in **design px**, scale,
    rotation, z, opacity, an optional `visibleInStates` list, an optional intro, a palette override and a `props` bag.
  - The design space is 1920x1080. A widget keeps its place and size at any canvas size: the scale is
    `min(W/1920, H/1080)`.
- **Drawing:** one instanced draw (`src/ui/kit/kit-renderer.ts`) shades every piece analytically. The shader
  supports:
  - signed-distance shapes: convex quads, burst stars, ellipses and radial rays;
  - jagged torn edges;
  - screen-tone patterns: halftone, stripes, gradient dots, cross lines and checker;
  - a fade mask;
  - text from a canvas-rasterised atlas, with fill and outline channels and drop shadows.
- **Crisp at any resolution:** the kit draws on the **final swapchain image after post-processing**
  (`WebGPURenderer.setUIKitOverlayDrawer`).
  - TAAU, resolution scaling, the lo-fi pass, bloom and grading never touch it.
  - Text is rasterised at its exact device size, and slanted text is sheared during rasterisation, so it is not
    resampled.
  - Verified: the HUD is pixel-identical at native resolution and with the 3D scene at 0.5 scale under TAAU.
- **Cost:** the full demo HUD is about 300 quads in one draw call. A new text string uploads only its own atlas
  rectangle.

## Pieces

| Kind | What | Key props |
|---|---|---|
| `panel` | Slanted panel with an offset drop shape, a border and torn edges | `w h skew fill border jag jagWave pattern* drop*` |
| `card` | Tilted card: cut corner, border, inner pattern, emblem, title strip | `w h cornerCut title titleSize font pattern*` |
| `tone` | Screen-tone overlay (full screen or a box) | `full pattern color alpha patternScale patternAngle fade` |
| `heading` | Slanted outlined text with an offset shadow and a slash underline | `text size font slant fill outline outlineW shadow shadowX/Y underline` |
| `ransom` | Cut-out letters: mixed fonts, rotated paper tiles, alternating fill and hollow letters | `text size seed jitter spacing tiles mixFonts outlineLetters` |
| `bar` | HP / SP bar with slanted ends | `label value max valueVar maxVar w h slant fillColor showNumber` |
| `status` | Portrait card (mask / silhouette / star), name, level, HP and SP bars | `name level hp hpMax sp spMax hpVar spVar portrait portraitColor` |
| `date` | Date numerals, weekday tile, time-of-day strip, weather badge | `month day weekday time weather dayVar timeVar weatherVar` |
| `minimap` | Mini-map frame (diamond / square / circle), stylised streets, player arrow, N tile, district label | `size shape label heading headingVar seed` |
| `prompt` | Button prompt: a key cap that fits its label, plus an action strip | `key label style size` |
| `menu` | Staggered menu list with a snapping, wobbling highlight and a cursor | `items size spacing stagger selected selectedVar highlight text selText keyNav cursor wobble` |
| `splash` | Splash text with radial stripes and a burst behind it | `text size textStyle burst spikes burstColor stripes seed` |
| `damage` | Damage number; the crit option adds a burst and a "CRITICAL" tag | `value size crit color` |
| `banner` | Location banner (district change) | `title subtitle w fill stripe` |
| `callout` | Interaction call-out bubble over NPCs and doors | `text key icon tail size` |

- **Colours** take a palette token (`primary`, `ink`, `paper`, `accent`) or a CSS hex. The defaults are red
  `#e3141f`, ink `#0c0b0d`, paper `#f6f2ea` and accent yellow `#ffe23a`. `widget.palette` overrides any token for one
  widget (e.g. a cyan accent).
- **Text props** accept `{variable}` placeholders, e.g. `"HP {hp}"`.
- **Presets:** `sm.listUIKitPresets()` lists 21 single-piece presets, e.g. `panel-torn`, `tone-stripes`, `bar-sp`,
  `splash-assault` and `damage-crit`.

## Animation

- **Intros** (`widget.intro = { type, dir?, delayMs?, durationMs? }`) play whenever a widget becomes visible: on a
  state enter, on show, or on load.
  - `slide`: slides in from a side with an overshoot.
  - `pop`: back-out scale.
  - `punch`: big scale that springs back.
  - `drop`: falls in with bounces.
  - `spin`.
- **Clips:** a `playAnimation` action whose `targetId` is a widget id plays a kit clip. The clip names are `intro`,
  the intro names, `shake`, `wobble` and `pulse`. `stopAnimation` stops it.
- **Menus:** the highlight springs to the new item with an overshoot and a damped wobble. In preview it also sways
  gently, and the cursor bobs.
- **UI time:** a monotonic clock that `freezeWorld` never pauses. The kit keeps requesting frames only while
  something moves. `sm.setUIKitClock(ms)` freezes the clock so you can capture frames.

## Transitions

Use them as `TransitionAnimation.type` on any transition or `goToState`. They are drawn by the kit over everything,
at full resolution.

| Type | Default ms | Look |
|---|---|---|
| `slash` | 700 | Ink band with halftone and red / white leading edges sweeps across, a thin red cut slices the covered screen, then the band sweeps off |
| `shatter` | 950 | A red burst covers the screen, then it breaks into falling, spinning triangle shards |
| `stripeBurst` | 820 | Radial red / black stripes grow from the centre, then a hole with a white ring opens outward |
| `panelSlide` | 650 | Fast slanted streaks; incoming widgets slide in from the left with an overshoot, staggered |
| `zoomPunch` | 460 | White flash and faint rays; incoming widgets punch in |

- **Covering transitions** (`slash`, `shatter`, `stripeBurst`) keep the OLD state's kit widgets on screen until the
  screen is covered (progress 0.5, 0.36 and 0.46). The new state is then revealed.
- `sm.previewUIKitTransition(type)` plays a transition in edit mode too. A preview of `panelSlide` or `zoomPunch`
  replays the entrances of the widgets on screen.
- Kit transitions run only in interactive preview / Player mode, like the scrim transitions. The kit times them
  itself, so they do not depend on the host calling `tickUI`.

## Interaction

- **Widget ids work anywhere a shape id does:**
  - state `shapeVisibility`;
  - `showShape`, `hideShape` and `toggleShape` (runtime overrides that are not saved);
  - `ShapeInteractionProps`: a widget with props is a pointer target and fires click / hover triggers;
  - `playAnimation`.
- **Menu items** are pointer targets with ids `<menuWidgetId>#<slug>`, e.g. `kit-1a2b3c4d#resume`. Use those ids in
  `click` triggers.
  - Hovering an item selects it, and clicking it pulses the menu and clicks the item.
  - Arrow keys, W / S, the d-pad (buttons 12 / 13), Enter / Space and A (button 0) drive the topmost shown menu on
    the active layer when `keyNav` is on.
  - Enter / Space go to the menu only when no authored focus ring is active.
- **`selectedVar`** binds the selection to a number variable, in both directions: the menu writes it, and the
  highlight follows changes made to it elsewhere.

## Demos

- **`sm.insertUIKitDemo('hud')`** creates a new **"Persona HUD"** layer.
  - States: `hud` (initial) and `splash`.
  - Widgets: location banner, date / weather (`timeVar` = `timeOfDay`), two status panels (`hpVar` / `spVar` =
    `hp` / `sp`), mini-map, TALK and MENU prompts, a call-out, and a splash with a crit damage number.
  - Pressing F goes to `splash` with `zoomPunch`. A 1.7 s timer goes back to `hud`.
- **`sm.insertUIKitDemo('pause')`** adds a pause menu. It merges into the active layer when that layer has a `hud`
  state; otherwise it creates a "Pause Menu" layer with a `play` state.
  - The `pause` state is frozen with world blur 0.55.
  - Widgets: halftone screen tone, a red halftone slab with an ink strip, a ransom "PAUSE", the menu
    (RESUME / PARTY / ITEMS / SYSTEM / QUIT, `selectedVar` = `pauseSel`), a card, a money heading, and
    SELECT / CONFIRM / BACK prompts.
  - Escape opens it with `stripeBurst`. Escape or RESUME closes it with `slash`. QUIT emits the custom event `quit`.
- Insert demos while NOT previewing: inserting commits the state machine, which re-enters its initial state.

## API (ShapeManager)

| Call | What |
|---|---|
| `listUIKitPresets()` | `[{ id, label, kind }]` |
| `getUIKitSchema()` | `{ kinds: { [kind]: { label, props: UIKitPropSpec[] } }, transitions, clips, colorTokens, anchors, intros }`. The panel renders generic controls from it. |
| `insertUIKitPreset(id, layerId?)` | Adds a preset. With no UI layer it creates a "UI Kit" layer. Returns the widget. |
| `insertUIKitDemo('hud' \| 'pause')` | `{ layerId, widgetIds }` |
| `addUIKitWidget(kind, layerId?)` / `removeUIKitWidget(id)` | |
| `getUIKitWidgets(layerId?)` / `getUIKitWidget(id)` | Live objects; edit them through `updateUIKitWidget`. |
| `updateUIKitWidget(id, patch)` | Top-level fields; `props` merges key by key. |
| `playUIKitClip(id, clip?)` / `previewUIKitTransition(type, ms?)` | |
| `uiKitMenuMove(delta, menuId?)` / `uiKitMenuActivate(menuId?)` | For host buttons, e.g. Player touch controls. |
| `setUIKitClock(ms \| null)` | Frame-sequence capture |

## Persistence

- The kit is saved inside `uiLayersJSON` with its layer, and it is bundled into `.frogcart` with the rest of the UI
  layer.
- Documents without a kit have no `kit` key and load and save byte-identically (unit-tested).
- Runtime-only state is never saved: visibility overrides, menu selection without a variable, and animations.

## Files

- `src/ui/kit/`:
  - `kit-types.ts`: the data model;
  - `kit-schema.ts`: defaults, the panel schema and colours;
  - `kit-prims.ts`: the prim list and builder;
  - `kit-layout.ts`: per-kind layouts and transitions;
  - `kit-anim.ts`: curves, intros and clips;
  - `kit-runtime.ts`: visibility, menus, transitions and hit-testing;
  - `kit-presets.ts`: presets and demos;
  - `kit-text-atlas.ts`: the canvas text atlas;
  - `kit-renderer.ts`: the WGSL and the pipeline;
  - `kit.test.ts`: 17 tests.
- Wiring:
  - `UIManager`: kit CRUD, demos, effect routing, keys, gamepad, pointer and the overlay hook;
  - `ui-types.ts`: `UILayerData.kit` and the transition types;
  - `WebGPURenderer.setUIKitOverlayDrawer`: drawn after `drawPostOverlays`, skipped in captures;
  - `ShapeManager`: the public API above.

## Known limits

- **Thumbnails and exports leave the kit out.** It is drawn after `lastFrameTex`, the same as the info card.
- **No on-canvas drag.** Position pieces with the panel's anchor and x / y.
- **The mini-map shows stylised streets, not the real city map.**
- **The call-out is screen-anchored.** It does not follow a 3D target yet.
