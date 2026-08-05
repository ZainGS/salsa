# World Generation Panel — Frogmarks UI Integration

**Last Updated:** 2026-07-03 (engine Phases 1–3 + streetscape/water/districts + **detail pass A–D**: textures / awnings / furniture / night)
**Engine spec:** [world-generation.md](../specs/world-generation.md) · [city-detail.md](../specs/city-detail.md) · **Sibling UI docs:** [3d-scene.md](./3d-scene.md), [array-tool.md](./array-tool.md)

Build a **World** panel that generates a procedural city diorama: pick a **border shape** + **road pattern**, set a **seed**, tweak sliders, and hit **Generate**. Everything is **seeded + deterministic** (same params → same city) and drops into the current 3D scene as a self-contained group.

> **Status:** 🚧 engine first pass live (Phases 1–3) + a **City MODE** (alt+drag orbit + live-edit regen) + a **detail pass** (surface textures, awnings, street furniture, night glow) — you already have a City Tool panel in Frogmarks; wire it to `enterCityMode` / `updateCity` / `exitCityMode` (§3). Also driven from the console via `window.salsaWorld` (below). Phases 5–8 (sky/weather, creatures, NPC sim, audio) are not built.

---

## 0. Prerequisite & shape
The **City Tool is a MODE** (like Edit Mesh / Edit Armature / UV Paint): entering it enables **alt+drag orbit** around the city + a clean focus background, generates a **default city**, and frames the camera. The diorama is a **workspace, not objects**: while the mode is active, clicking/hovering/box-selecting does NOT select or outline the city meshes (any prior selection is cleared on entry; selection comes back when the mode exits). Sliders then **live-update** the city (a fast debounced regen) *without* moving your orbit view. Leaving the mode keeps the city in the scene. World meshes live in the **3D scene graph**; no character is needed (standalone diorama at the origin).

---

## 1. Driving it TODAY (dev console)
Until the panel exists, trigger from the browser console:
```js
salsaWorld.generate({ border: 'circle', pattern: 'radial', seed: 3 })  // all phases
salsaWorld.layout({ border: 'square', pattern: 'grid', seed: 7 })       // Phase 1 only (flat map)
salsaWorld.biome()                                                      // Phase 2 (auto-builds a layout if none)
salsaWorld.streets()                                                    // Phase 3
salsaWorld.enterMode({ border: 'circle', pattern: 'radial' })          // enter City MODE (orbit + default city)
salsaWorld.update({ spokeCount: 10 })                                   // live slider update (no reframe)
salsaWorld.update({ nightMode: true })                                  // e.g. flip on the night glow
salsaWorld.regions()                                                   // list districts → [{id,type,center}]
salsaWorld.region(0)                                                    // focus ONLY district 0; region(null) = whole city
salsaWorld.toggle(2)                                                    // enable/disable district 2 (multi-select — keep the others)
salsaWorld.setRegions([0, 3])                                           // exact enabled set; setRegions(null) = all
salsaWorld.time(0.9)                                                    // set time of day (0 midnight · 0.25 dawn · 0.5 noon · 0.75 dusk)
salsaWorld.cycle(120)                                                   // ▶ animate a full day/night loop (120 s per day); cycle(0) stops
salsaWorld.spin(6)                                                      // ◉ TURNTABLE: slow auto-orbit (6°/s ≈ one lap/min); spin(0) stops
salsaWorld.style('cel')                                                 // restyle the whole city: cel | cel-hd | sketch | ink | gouraud | null(PBR)
salsaWorld.pack('oldtown')                                              // ONE-CALL STYLE PACK: tokyo | oldtown | seaside | noir | toon | retro | cyber | storm | winter
salsaWorld.packs()                                                      // list the pack names (panel dropdown values)
salsaWorld.traffic(true)                                                // ▶ MOVING traffic: cars drive the roads, the train runs, walkers stroll; traffic(false) stops
salsaWorld.tiles(2, 'full')                                             // ▦ TILED world: N×N neighbour cities (r=2 → 5×5); detail 'flat' | 'focus' | 'full'
salsaWorld.untile()                                                     // back to a single diorama city
salsaWorld.detailLod(true)                                              // ◧ zoom-gated fine-detail cull (hide balconies/trim/props when zoomed out); detailLod(true, orthoSize) to tune
salsaWorld.streamFollow(true)                                           // ▤ TILED worlds: stream the tile window to the CAMERA — pan loads ahead / unloads behind, zoom resizes + proxies far tiles. Default OFF
salsaWorld.streamMaxDist(5)                                             // ▤ max render distance in tiles (2–8) + ZOOM-OUT CAP (orthoSize clamped to this × tileSpan); bounds the resident set for huge worlds
salsaWorld.streamWorkers(true)                                          // ▤ Web-Worker off-thread tile generation (default ON) — full tiles generate on other cores, no main-thread stall. streamWorkers(false) to A/B
salsaWorld.streamStats()                                               // ▤ streaming state → { follow, focusTile, window:"load,detail", live, pending, building }
salsaWorld.exitMode()                                                   // leave City mode
salsaWorld.clear()                                                      // remove the world
```
`salsaWorld.manager` is the live `WorldManager` (same as `shapeManager.world`). Try `enterMode()` then `update({...})` a few times to feel the live-edit loop.

---

## 2. The intended panel
```
  ┌──────────────────────────────────────────────┐
  │  World                                         │
  │  Shape   ( ○Circle  ●Square  ○Hexagon  ○Octagon)│  ← border
  │  Pattern ( ○Radial  ●Grid )                    │  ← road model
  │  Seed  [ 1 ]  [🎲 Randomize]                    │
  │  Size  ●────────  (radius)                     │
  │                                                │
  │  ── Roads ──                                   │
  │   Radial:  Arterials ●   Rings ●               │  ← when pattern = radial
  │   Grid:    Columns ●     Rows ●                │  ← when pattern = grid
  │   Street width ●   Plaza size ●                │
  │  ── Lots ──                                    │
  │   Lots per block:  radial ●   cross ●          │
  │  ── Dressing ──                               │
  │   Parks ●        Water ●                       │  ← chances
  │   Junction variety ●   (grid: T + corner junctions)│
  │   Elevation ●          (rolling terrain)       │
  │  ── Detail ──                                  │
  │   ☑Sidewalks ☑Road paint ☑Street lights        │  ← toggles
  │   ☑Traffic lights  ☑Shop signage               │
  │   ☑Awnings  ☑Furniture  ☑Power lines  ☑Cars    │  ← detail pass
  │   ☐Night mode                                  │
  │   Corners ( ○Sharp ○Chamfer ○Round ●Mixed )    │  ← building corner style
  │   Roofs   ( …flat/pointed/parapet/helipad/tower ●Mixed )│
  │                                                │
  │  [ Layout ] [ + Biome ] [ + Streets ]          │  ← build phases
  │  [ Generate All ]            [ Clear ]         │
  └──────────────────────────────────────────────┘
```
**Wiring the tool as a MODE (recommended):**
- **Tool opens** → **resume the existing city, or create one.** Only **one city ever exists** — re-opening the tool goes back to editing it. Call `enterCityMode()` **with no args to RESUME** (re-enters orbit + focus, **no regenerate**); call `enterCityMode(params)` **with params** to build a fresh city. Pattern: `if (shapeManager.world.hasWorld) world.enterCityMode(); else world.enterCityMode(params)`. (Both turn on alt+drag orbit + the focus workspace.)
- **Any slider/toggle changes** → `shapeManager.world.updateCity({ changed })` — **debounce ~150 ms**. It merges onto the current params and regenerates the whole city *without* re-framing, so the user's orbit view is preserved. (A full regen — cheap — so no live-morph needed; changing spokes/border/etc. changes topology anyway.)
- **Randomize** → `updateCity({ seed: (Math.random()*1e9)|0 })` (keeps every other slider — the fashion-collection pattern).
- **Tool closes** → `shapeManager.world.exitCityMode()` (keeps the city; use **Clear** to remove it).
- Show the **Radial** road sliders when `pattern:'radial'`, the **Grid** ones when `pattern:'grid'`.
- The **Layout / +Biome / +Streets** buttons are optional (for building up incrementally or inspecting a single phase); the mode already builds all three.

---

## 3. API (🚧 first pass — `shapeManager.world`)
```ts
// City-Tool MODE (the recommended flow)
shapeManager.world.enterCityMode(params?): WorldGraph;    // params → (re)generate the city; NO args → RESUME the existing one (no regen). Only one city exists.
shapeManager.world.updateCity(params?): WorldGraph;       // live edit: merge + regen, NO reframe (debounce host-side).
                                                          // Picks the CHEAPEST path automatically:
                                                          //  · SELECTIVE — non-topology params rebuild ONLY their own mesh
                                                          //    groups / respawn traffic / re-light, synchronously (near-
                                                          //    instant: awnings, signage, roofStyle, weather, cloudDensity, fog…).
                                                          //  · DRAFT — rapid successive TOPOLOGY changes (a slider DRAG,
                                                          //    <350 ms apart) build a reduced preview synchronously, then a
                                                          //    full build PROMOTES ~450 ms after the drag settles.
                                                          //  · ASYNC — a single settled topology change builds TIME-SLICED
                                                          //    into hidden staging groups while the OLD city stays live +
                                                          //    ticking, then swaps in one frame (no freeze). Superseded
                                                          //    builds abort; mid-drag key changes fold together.
                                                          // salsaWorld.debug().lastRegen shows { ms, kind } for the last call.
shapeManager.world.exitCityMode(): void;                  // leave the mode (city stays)
shapeManager.world.cityMode;                              // boolean — is the mode active
shapeManager.world.params;                                // current full LayoutParams (or null) — seed sliders from this

// Active-region editor — ENABLE/DISABLE districts so only the enabled ones build full 3D (perf + composition while editing).
// Disabled districts drop to the cheap flat map + roads + lights. `null` = all enabled (whole city).
shapeManager.world.regions;                               // RegionSeed[] { id, type, center } — for a region list/picker
shapeManager.world.regionAt(x, z);                        // resolve a ground point → region id (call on a viewport click)
shapeManager.world.toggleRegion(id);                      // flip one district on/off (multi-select; keeps the rest)
shapeManager.world.setRegionEnabled(id, on);              // enable/disable one district explicitly
shapeManager.world.setActiveRegions(ids | null);          // set the EXACT enabled set ([] = none, null = all)
shapeManager.world.activeRegions;                         // number[] of enabled ids, or null (= all)
shapeManager.world.setActiveRegion(id);                   // convenience: focus EXACTLY one district; null = whole city
shapeManager.world.activeRegion;                          // sole focused id, or null (0 or >1 enabled)

// Day / night — LIVE lighting + city lights, no regeneration (safe to animate every frame)
shapeManager.world.setTimeOfDay(t);                       // 0 midnight · 0.25 dawn · 0.5 noon · 0.75 dusk. Sun sweeps +
                                                          // warms at the horizons; sky gradient follows; at night the
                                                          // flat-map dims while signs/screens/lamps/lanterns GLOW and
                                                          // building WINDOWS light up (hash-lit set, drifts over time)
shapeManager.world.playDayCycle(periodSec?);              // ▶ animate a full loop (default 120 s/day); keeps rendering →
                                                          // animated neon screens + water shimmer live
shapeManager.world.stopDayCycle();                        // ⏸ stop (keeps the current time)
shapeManager.world.timeOfDay;                             // current 0..1, or null (untouched editor lighting)
shapeManager.world.setSunAzimuth(radians);                // ★ ROTATE THE SUN's compass bearing. The daily east→west
                                                          // arc is added on top, so this turns the WHOLE arc → cast
                                                          // shadows can reach EVERY side of the city (the old sun was
                                                          // pinned to a wedge → shadows only ever hit ~2 of 4 sides).
                                                          // Live + persisted. Wire a "Sun direction" dial to this.
shapeManager.world.sunAzimuth;                            // current bearing in radians (seed the dial)
shapeManager.world.dayCyclePlaying;                       // boolean
shapeManager.world.setTurntable(degPerSec);               // ◉ TURNTABLE: slowly auto-orbit the city (6 ≈ one lap/min;
                                                          // negative = clockwise; 0 = stop). Manual alt+drag still works
                                                          // while spinning — wire the panel's Spin button to this.
shapeManager.world.turntableSpeed;                        // current °/s (0 = off)
shapeManager.world.setCinematicGrade(on);                 // CINEMATIC GRADE: bloom + colour grade + vignette driven by
                                                          // FOUR time-of-day keyframes (night/dawn/noon/dusk, lerped as
                                                          // the cycle plays — cool bloomy nights, golden dusks; lightning
                                                          // cranks the bloom). Auto-ON in City mode; the host's own post
                                                          // config is captured on enable and RESTORED on disable/exit.
shapeManager.world.setTimeGradeKey(phase, partial);       // tune one keyframe live ('night'|'dawn'|'noon'|'dusk') —
                                                          // wire the panel's bloom/grade knobs through this, per phase
shapeManager.world.timeGradeKeys;                         // the 4 keyframes (seed the panel UI from these)
shapeManager.world.cinematicGrade;                        // boolean
shapeManager.world.setSkyKey(phase, { top?, bottom? });   // ★ AUTHOR THE SKY. Set the zenith (top) + horizon (bottom)
                                                          // colour for one phase ('night'|'dawn'|'noon'|'dusk'); the cycle
                                                          // lerps the four as timeOfDay moves. Partial — omit a colour to
                                                          // keep it. e.g. setSkyKey('dusk', { bottom: [1,0.5,0.2] }).
shapeManager.world.setSkyKeyframes({ dusk: {...}, ... });  // set SEVERAL phases at once (an authored day palette)
shapeManager.world.skyKeys;                               // the 4 sky keyframes { top:[r,g,b], bottom:[r,g,b] } — seed the UI
shapeManager.world.resetSkyKeys();                        // back to the built-in navy-night→lavender-dawn→blue-noon→gold-dusk
shapeManager.world.setOverrideGlobalLighting(on);         // ★ CITY LIGHTING SCOPE. true (default) = the city drives its
                                                          // OWN day/night look (sun/ambient/sky/fog/grade); the host's
                                                          // GLOBAL scene lighting is snapshotted on City-Tool enter and
                                                          // RESTORED on exit (no more permanent stomp). false = the city
                                                          // INHERITS the global scene lighting (skips its day/night). Flips
                                                          // live in the City Tool. Persisted with the city (reopen-safe).
                                                          // → wire a "City Lighting / Override Global" toggle to this.
shapeManager.world.overrideGlobalLighting;                // boolean (seed the toggle from this)
shapeManager.world.setRenderStyle(style | null);          // restyle the whole city live: 'cel'|'cel-hd'|'sketch'|'ink'|'gouraud'|null(PBR).
                                                          // Combine with sm.setRetroPreset('wobble'|'pocket') for the full PS1 pipeline.
shapeManager.world.applyStyle(name);                      // STYLE PACK: one call = whole aesthetic (params + palette + warp +
                                                          // render style + time of day). Data-defined in src/world/styles.ts
                                                          // (CITY_STYLES); names via shapeManager.world.styleNames.
shapeManager.world.styleNames;                            // ['tokyo','oldtown','seaside','noir','toon','retro','cyber','storm','winter'] — dropdown values
shapeManager.world.startTraffic();                        // ▶ MOVING traffic (v1 sim): cars drive the long road runs (left-hand,
                                                          // both directions), the train runs the viaduct (the parked one hides),
                                                          // walkers stroll the sidewalks. Regen-safe; movers ride the terrain.
shapeManager.world.stopTraffic();                         // ⏸ remove the movers (parked train returns on next regen)
shapeManager.world.trafficRunning;                        // boolean
// City mode auto-enables SHADOWS (sized to the diorama; the cycle's moving sun sweeps them) — the city now
// actually RECEIVES them (soft wide-PCF penumbra via sm.setShadowUpdateInterval/setShadowSoftness), and at
// night up to 16 street lamps become REAL POINT LIGHTS (sm.setPointLights3D) pooling warm light on walls,
// cars and walkers. Defaults to a NOON sky on first enter. sm.disableShadows() turns shadows back off.
sm.scene3d.setShadowStrength3D(strength);                 // ★ SHADOW DARKNESS 0..1 (0 = faint, ~0.58 default, 1 = black).
                                                          // Wire a "Shadow Strength" slider to this (separate from Softness).
sm.scene3d.setShadowFollowCamera3D(on);                   // ★ SHADOW BOX FOLLOWS the camera focus (default on), texel-snapped
                                                          // + ZOOM-ADAPTIVE (shrinks when you zoom in → SHARP shadows, grows
                                                          // when you zoom out → whole view covered). → CONSISTENT shadows
                                                          // across a large/panned/tiled city (the old origin-locked box left
                                                          // distant areas shadowless). off = lock at origin. No panel needed —
                                                          // the default is correct; expose only as a debug toggle.
// The day/night cycle also drives DISTANCE FOG (blue-grey day → warm dusk → navy night) for depth/scale.
// Each SEED picks a harmonized CITY PALETTE (terracotta/slate/pastel/brick/mint) for walls/roofs/sidewalks/parks.
// LANDMARKS carry real TEXT name plates (市役所/駅/美術館/病院/神社/…) + the shotengai arches read 商店街 —
// rasterized to small textures in the browser (headless builds show plain plates).

// Lower-level / incremental (also usable outside the mode)
shapeManager.world.generateLayout(params?): WorldGraph;   // Phase 1: graph + flat top-down map (auto-frames)
shapeManager.world.generateBiome(): WorldGraph;           // Phase 2: trees/rocks (builds a layout if none)
shapeManager.world.generateStreets(): WorldGraph;         // Phase 3: buildings + furniture + awnings + signage
shapeManager.world.generateWorld(params?): WorldGraph;    // all phases at once (auto-frames)
shapeManager.world.clear(): void;                         // remove the world from the scene
shapeManager.world.graph;                                 // last WorldGraph (or null) — for inspection
shapeManager.world.hasWorld;                              // boolean
```
`params` is `Partial<LayoutParams>` — any omitted field uses its default. Regenerating **replaces** the previous world (a fresh `generateLayout` clears first). `updateCity` differs from `generateWorld` only in that it **merges onto the current params** and **skips the camera reframe** (so live slider edits don't jump the view).

---

## 3b. Custom sky colours across the day

The sky is the City-mode background **gradient** (a zenith **top** colour → horizon **bottom** colour), recomputed every frame from **four keyframes** — `night` (t 0) · `dawn` (0.25) · `noon` (0.5) · `dusk` (0.75) — lerped as `timeOfDay` moves. It's the same keyframe model as the cinematic grade, so a panel can reuse the same phase-tab layout. The fog colour tracks the horizon automatically.

```ts
// Read to seed the panel (4 phases × top/bottom swatch):
const sky = shapeManager.world.skyKeys;
// → { night:{top:[..],bottom:[..]}, dawn:{...}, noon:{...}, dusk:{...} }

// A colour picker writes one swatch (partial — the other colour is untouched):
shapeManager.world.setSkyKey('dusk', { bottom: [1.0, 0.45, 0.2] });   // fiery horizon at dusk
shapeManager.world.setSkyKey('night', { top: [0.02, 0.02, 0.08], bottom: [0.06, 0.05, 0.14] });

// Or drop in a whole authored palette at once:
shapeManager.world.setSkyKeyframes({
  dawn: { top: [0.28, 0.30, 0.46], bottom: [0.70, 0.55, 0.62] },
  dusk: { top: [0.40, 0.20, 0.32], bottom: [1.0, 0.55, 0.30] },
});

shapeManager.world.resetSkyKeys();   // back to the built-in navy→lavender→blue→gold defaults
```

Suggested panel — a **Sky** row under the day/night controls, with the four phase tabs + two colour swatches each:

```
▸ SKY (across the day) ──────────────  [Reset]
  Phase:  [ Night ] [ Dawn ] [ Noon ] [ Dusk ]
  ── Dusk ──────────────────────────────────
  Zenith (top)   ■ [#6b3d57]
  Horizon (bot)  ■ [#ff8c4d]
  (drag the Time slider to preview the blend between phases)
```

Notes:
- **Persisted with the city** (in the same `lighting` bundle as time-of-day / sun bearing), so an authored sky survives reload. `resetSkyKeys` returns to the defaults.
- **Only takes effect in City mode with `overrideGlobalLighting` on** (the default) — the cycle re-applies the sky every frame there. This is also **why `sm.setSceneBg3D(...)` won't stick in a city**: the cycle overwrites the background each frame. Author the sky here instead (or `resetSkyKeys` + `setOverrideGlobalLighting(false)` to hand the background back to the global scene).
- Dawn and dusk are **independent** keyframes now (the old hardcoded formula made them identical) — set dawn cool and dusk golden for a natural day arc.
- Console: `salsaWorld.skyKey('dusk', { bottom:[1,0.5,0.2] })`, `salsaWorld.skyKeys()`, `salsaWorld.skyReset()`.

---

## 4. `LayoutParams` reference
| Param | Type / range | Default | What it does |
|---|---|---|---|
| `seed` | int | `1` | The whole city derives from this. Change it for a different city; keep it for a reproducible one. |
| `border` | `circle｜square｜hexagon｜octagon` | `square` | Overall silhouette the city is clipped to. |
| `radius` | world units (~3–14) | `10` | Half-size of the diorama (≈ `2×radius` across). Also the tile spacing in a tiled world (one tile spans `2×radius`). |
| `worldMode` | `diorama｜tiled` | `diorama` | `tiled` surrounds the centre city with a grid of neighbour cities (see §6). |
| `tileRadius` | int (0–3) | `1` | **Tiled** — neighbour rings around the centre (1 → 3×3, 2 → 5×5, 3 → 7×7). 0 = centre only. |
| `tileDetail` | `flat｜focus｜full` | `focus` | **Tiled** — how rich each neighbour is: `flat` = map only · `focus` = map + light dressing · `full` = a complete 3D city (heavy — pair with `streamFollow` so far tiles proxy/unload). |
| `borderSides` | int (16–96) | `64` | Circle smoothness (ignored for square/hex/octagon). |
| `pattern` | `radial｜grid` | `grid` | Road model. Radial = Lumiose-style; grid = clean blocks. |
| `spokeCount` | int (3–16) | `8` | **Radial** — main arterials from the plaza. |
| `ringCount` | int (1–8) | `4` | **Radial** — concentric ring roads. |
| `gridCols` / `gridRows` | int (2–14) | `11` / `11` | **Grid** — street columns / rows. |
| `lotsRadial` | int (1–4) | `2` | Lots per block along the radial / row axis. |
| `lotsAngular` | int (1–5) | `3` | Lots per block along the angular / column axis. |
| `streetWidth` | world units (0.06–0.5) | `0.40` | Gap between lots (the visible streets). The curb lines + crosswalks + pole placement all derive from this (the real asphalt width). |
| `arterialWidth` | world units | `0.5` | Main-road width (graph data for later phases). |
| `plazaRadius` | × radius (0.03–0.2) | `0.09` | Central plaza size. |
| `parkChance` | 0..1 | `0.12` | Chance a block becomes a park (green + trees). |
| `waterChance` | 0..1 | `0.06` | Chance a block becomes water (blue). |
| `junctionVariety` | 0..1 | `0.3` | **Grid only** — fraction of junctions that become non-4-way (removes roads → T + corner junctions; adjacent blocks merge). ≈ the resulting non-4-way %. |
| `elevation` | 0..1 | `0.45` | Terrain relief — 0 = flat; higher = rolling hills. Buildings are **rigid** at their anchor height with stone **foundation pads** stepping down the slopes (San-Francisco streets) — crank it without shear. |
| `warp` | 0..1 | `0.35` | **DOMAIN WARP** — 0 = clean ruler-straight grid, 1 = organic old-town: roads gently **curve**, blocks vary, the endless-grid feel dissolves. Render-space only (picking/logic unaffected); traffic follows the curves. |
| `terraces` | bool | `true` | **Grid** — discrete raised terraces (a few blocks step up a level, with retaining walls + stairs to climb; canals get a bare embankment wall, no stairs). |
| `sidewalks` | bool | `true` | Draw a concrete sidewalk band around each block (with paving-slab joints via the grid pattern). |
| `roadPaint` | bool | `true` | Lane lines (dashed centre + solid curb sides, broken at junctions) + zebra crosswalks. |
| `streetLights` | bool | `true` | Arm-lights on the junction corners (plus sparse lamp posts along arterials). |
| `trafficLights` | bool | `true` | Japanese horizontal 3-lamp signals (cross) + stop signs (T-junctions). |
| `signage` | bool | `true` | Shop signage along building frontages — flat over-door signs + projecting blade signs (colored). |
| `landmarks` | bool | `true` | Place significant buildings — **city hall, station, school (with a marked sports yard + flag), museum, hospital, shrine, radio tower, post office, stadium, power plant** — each a distinct silhouette + a game entrance anchor (`graph.landmarks`). The count scales with `radius` (small cities place the first few). |
| `shotengai` | bool | `true` | **Grid** — a pedestrian shopping street through the market district: brick paving, an entry **arch** at each end, **market stalls** + banners (`graph.shotengai`). |
| `cornerStyle` | `sharp｜chamfer｜round｜mixed` | `mixed` | Building street-corner treatment (mixed = seeded blend — the 109 look). |
| `roofStyle` | `flat｜pointed｜parapet｜chamfer｜rounded｜helipad｜tower｜spire｜mansard｜mixed` | `mixed` | Rooftop treatment (mixed = seeded per building, weighted by zone). **pointed** = hipped with eaves overhang + finial; **spire** = drum + tall church-spire + finial (rare skyline accent); **mansard** = steep tiled sides; parapet/flat/mansard get projecting **cornices**. Roof slopes carry the tile pattern. |
| `awnings` | bool | `true` | Ground-floor shop dressing: striped **awnings** + dark **shopfront** glass band + hanging **noren** curtains along shop frontages. |
| `streetFurniture` | bool | `true` | **Vending machines** (glowing) on corners + **manhole** covers on the road. |
| `powerLines` | bool | `true` | Utility **poles + sagging overhead wires** down the arterials (the JP street look). |
| `parkedCars` | bool | `true` | Low-poly **parked cars** along the curbs (seeded, cleared of junctions). |
| `nightMode` | bool | `false` | Static night **build** (bakes boosted emissives). Prefer the live **day/night API** above (`setTimeOfDay` / `playDayCycle`) — it also drives the sun, sky, lit windows and dims the map, with no regen. |
| `streetTrees` | bool | `true` | **Trees + planters** lining the streets (not just parks); ~22% are pink **sakura**. |
| `leafColor` | `[r,g,b]` (0..2) | `[1,1,1]` | **Global leaf tint** — a colour MULTIPLIER over ALL city foliage. `[1,1,1]` = no change; nudge warmer (`[1.1,1,0.9]`) / cooler / autumnal while every tree type keeps its own relative shade. Multiplies any base colour, so it works on sakura pink too. |
| `leafColorVar` | 0..1 | `0.08` | **Per-tree leaf variety** — how much each tree's leaf **lightness** may vary, so the trees aren't one flat green. Deliberately **subtle**: a uniform rgb lighten/darken (no hue shift), and the effective jitter is capped at **±0.18** even at `1.0` — never rainbow. |
| `bicycles` | bool | `true` | Rows of **parked bicycles** on the sidewalk near shops. |
| `lanterns` | bool | `true` | Strung red paper **lanterns** (chōchin) over the shotengai (glow at night). |
| `railway` | bool | `true` | An **elevated railway viaduct** (piers + deck + rails) carrying a **train** across the city. |
| `rooftops` | bool | `true` | Rooftop **water tanks / AC condensers** on flat roofs (the JP rooftop silhouette). |
| `facadeDetail` | bool | `true` | **AC boxes + downpipes** on non-residential building facades; some downtown blocks become **sign-towers** (stacked blade signs). |
| `pedestrians` | bool | `true` | Tiny static **people** on sidewalks, the shotengai (busy) and the plaza — the city reads populated. Moving crowds = a later game-sim tick. |
| `traffic` | bool | `true` | **MOVING traffic** — auto-runs while the City Tool is open: cars drive the roads (left-hand, both directions, **braking for pedestrians and each other**, **head/tail lights** that glow at night), **BUSES** that pull up at stops along their routes, the **train shuttles** end-to-end on the viaduct, walkers stroll with a **step-bounce gait** (some jaywalk) and **stop to chat** (emote bubbles), **canal BOATS** shuttle the waterways, and two **BIRD flocks** circle the skyline on closed loops. Toggle off to freeze. |
| `clouds` | bool | `true` | Drifting procedural **clouds** — seeded puffy formations floating across above the city (part of the live ticker). |
| `cloudDensity` | 0..1 | `0.55` | How many clouds (≈3 sparse … ≈18 overcast). |
| `holograms` | bool | `false` | The whole **CYBER SUITE**: neon **hologram fish** swimming between the buildings, floating **holo billboards** (animated waves shader) above downtown roofs, fast **flying vehicles** over the skyline, chrome **robot pedestrians** (glowing visors, ~28% of walkers — they chat too), and a **MEGATOWER** landmark with a square portal that a glowing **SKY-TRAIN weaves straight through** (multi-segment route on a floating maglev guideway). The `cyber` style pack turns it all on at night. |
| `weather` | `clear｜rain｜snow` | `clear` | **RAIN**: falling streak sheets, a heavy **grey cloud deck**, dimmer/greyer light, closer fog, **wet reflective roads** (lights smear), and **LIGHTNING** (occasional double-strobe flashes). **SNOW**: slow drifting flakes, a pale winter deck, cold light, bright haze + a **frost cast** on roads/roofs. **CLEAR**: drifting **sakura petals**. Packs: `storm` = rainy dusk, `winter` = first snow. |
| `fog` | bool | `true` | The day/night cycle's **distance fog** (horizon-matched haze for depth). Off = no fog. |
| `palette` | `auto｜terracotta｜slate｜pastel｜brick｜mint` | `auto` | The city's **colour grade** (walls/roofs/sidewalks/parks). `auto` = seeded pick. Dropdown values are exported as `CITY_PALETTE_NAMES` from `src/world`. |
| `groundY` | world units | `0` | Height the map sits at. |

---

## 5. Notes
- **Deterministic:** same params ⇒ identical city, byte for byte (mulberry32 seed). Randomize = new seed only.
- **Scale:** default is a ~20-unit diorama — much bigger than a character (~2 units). It auto-frames on generate; orbit/zoom to inspect.
- **What renders:** a **top-down map base** — asphalt roads, **sidewalks** (slab joints), zoned blocks, parks, plaza (tiled) — with **road paint** (curb lines that turn at block corners, crosswalks). **Water** is **canals** (contiguous runs, sunk a terrace step into a **trench** — the road base is cut away over them so you see down to the water, edged by the embankment walls) + **ponds** in parks (flat discs just above the ground, with **railings**), plus **bridges** where cross-streets span a canal. Phases 2–3 add **low-poly 3D**: trees/rocks, then extruded **buildings** with **windows** (shader grid, per-zone rhythm), varied **rooftops**, **shop signage**, plus **traffic lights** / **stop signs** / **street lights** (all curb-placed, off the water). The **detail pass** adds ground-floor **striped awnings + shopfronts + noren**, **utility poles + overhead wires**, **parked cars** (+ buses/trucks), **vending machines**, **benches + bus stops**, **manholes**, **street trees + sakura + planters**, **parked bicycles**, **post boxes / cabinets / cones / guardrails**, road markings (**stop bars, turn arrows, yellow tactile paving**), **rooftop water tanks + AC**, facade **AC boxes + pipes + sign-towers**, strung **paper lanterns** over the shotengai, and an **elevated railway + train**; **`nightMode`** lights the signs/screens/lamps/lanterns/train. **Landmarks** are detailed (windows, plinths, porticos, torii, floodlights, steam). The city splits into **districts** (auto, Voronoi): **downtown** = neon **screens** + denser signage + sign-towers; **residential** = **balconies** (some with **laundry lines**). The **polish pass** adds a **SKYLINE gradient** (heights peak toward downtown — the city reads as a city from afar), **street name plates** at junctions (1ST AVE / OAK ST), striped **sandwich boards** + rear-face **alley clutter** (dumpsters/crates), park centrepieces (**playground / fountain / gazebo**), **lamp light pools** on the pavement, **stars + a moon** at clear night, and **variety blocks** — a crane-topped **construction site**, **parking lots** with painted stalls, a **gas station**.
- **Alive surfaces (in-shader, free):** building facades use the **windows** pattern — real inset window cells with a per-cell **hash-LIT set** that ramps on at dusk (lit cells glow per-texel and the lit set slowly drifts, so a night city feels inhabited). Every window is **INTERIOR-MAPPED**: a raycast fake 3D room behind the glass (parallax back wall / floor / ceiling, hashed depth) — **warm HOMES** (sofa bands, wall hangings, ~35% with a **flickering TV**) vs **cool OFFICES** (cubicle desks with glowing **monitor rows**, shelf-lined side walls, strip-light ceilings), and ~34% of windows are dressed with **blinds or curtains** that occlude the view with light seeping through. Faint behind day glass, glowing with the room's own shading when lit. Patterned surfaces (shingles/brick/paving/stripes) also get **PATTERN RELIEF** (a micro normal perturbation from the procedural mask, so seams groove and tiles catch the sun) plus a subtle world-stable **grain**. Downtown **screens** and the **water** run the **waves** pattern — bands **animate over scene time** and carry the glow. All in-shader on the merged meshes: zero extra geometry, zero per-frame CPU cost.
- **Persistence:** not wired yet — the world is regenerated from params each call (it is *not* saved into the `.frogmarks` document). Per the spec, saving = **seed + sparse overrides**; that lands with a later phase once the shape settles.
- **Perf:** a fully detailed grid city is ~150–200k tris (still fine for a diorama on the GPU). Street trees, parked cars/bikes, power lines and furniture are the heaviest — every feature has a toggle above, and the active-region editor builds only the enabled districts in full 3D. The animated sim is optimized: movers skip the per-frame bounding-box vertex re-scan (`cheapBounds`), the per-frame instance upload takes a **transforms-only fast path** (rewrites just the moved slots — no re-sort/repack of the static city), mover archetypes **share geometry** (every red car = one GPU allocation + batched instanced draws; ~720 mover meshes → ~80 geometries), and city mode **throttles the shadow map to every 3rd frame** (`sm.setShadowUpdateInterval`). Regen is dip-free: the geometry pool is **append-only** (a regen uploads only the NEW geometry, never re-uploads the whole ~12 MB pool), and a settled topology change builds **time-sliced into hidden staging groups** whose geometry is **pre-uploaded** during staging (`warmGeometry`), so the reveal SWAP is a cheap visibility flip (no big upload on any single frame). Removed geometry leaves dead space reclaimed by an occasional compacting rebuild (buffer over-provisioned 2.5×). Diagnose with `salsaWorld.perf()` (poolRebuilds/appends/warms/fastPaths + last-cost ms).

---

## 6. Tiled worlds & streaming

A **tiled** world (`worldMode:'tiled'`) surrounds the centre city with a grid of neighbour cities so the world reads as endless. `tileRadius` sets the rings (1 → 3×3, 2 → 5×5, 3 → 7×7); `tileDetail` sets how rich each neighbour is (`flat` = map only · `focus` = map + light dressing · `full` = a complete 3D city — heavy). The centre tile is always the full, editable city.

Neighbour tiles are **streamed** by a general, content-agnostic engine (`src/services/streaming/`, spec `docs/specs/spatial-streaming.md`) — the same primitive intended to serve non-city content later (products, sims, material microstructure). What the host needs to know:

- **Follow — default OFF.** `streamFollow(true)` makes the resident tile window track the camera: **pan** → tiles load ahead of you and unload behind; **zoom** → the window resizes and (for `tileDetail:'full'` worlds) far tiles demote to cheap flat **proxies**. So resident memory scales to what you're looking at, not the whole world. `streamFollow(false)` snaps back to the origin-centred window — the default, and byte-identical to a plain non-streamed tiled world.
- **What to watch.** `streamStats()` → `{ follow, focusTile, window:"load,detail", live, pending, building }`. As you pan or zoom in, `live` (and `frameStats().meshes`) should **fall** — that's the unload working — and climb back as you zoom out. Nothing changes for existing worlds unless you opt in.
- **Deterministic.** A tile is a pure function of (coords, seed, params); nothing is saved, and an unloaded tile regenerates identically — pan away and back and you get the same city.
- **Phase 4** (per-tile clouds/pedestrians/traffic + unloading the centre city) lands with the street-level view.

### Panel wiring (Frogmarks)

Four controls slot into the City panel. Three are **params** (route through the debounced `updateCity`, exactly like every other slider); the fourth, **Stream to camera**, is a **live scene behaviour, NOT a param** — call `streamFollow()` directly (no regen). Streaming only means anything on a `tiled` world, so gate the last three on the toggle. Drop this into your existing City-panel component and adapt the binding style (ngModel / signals / Material) to match the rest of the panel.

```ts
// ── Tiled world + streaming (add to the City-panel component) ──────────────
tiled = false;
tileRadius = 1;
tileDetail: 'flat' | 'focus' | 'full' = 'focus';
streamFollow = false;
streamInfo = '';                                   // optional live debug readout
private _tileDebounce?: any;
private _statsTimer?: any;
private get world() { return this.shapeManager.world; }   // however you reach it in your DI

ngOnInit(): void {                                  // seed the controls from the current world, if any
  const p = this.world.params;
  if (p) { this.tiled = p.worldMode === 'tiled'; this.tileRadius = p.tileRadius ?? 1; this.tileDetail = p.tileDetail ?? 'focus'; }
}

onTiledToggle(on: boolean): void {
  this.tiled = on;
  this.world.updateCity({ worldMode: on ? 'tiled' : 'diorama' });   // topology change → full regen
  if (!on) this.setStreamFollow(false);             // streaming is meaningless on a single diorama
}
onTileRadius(v: number): void {                     // debounce like the other sliders (a regen)
  this.tileRadius = v;
  clearTimeout(this._tileDebounce);
  this._tileDebounce = setTimeout(() => this.world.updateCity({ tileRadius: this.tileRadius }), 150);
}
onTileDetail(v: 'flat' | 'focus' | 'full'): void {
  this.tileDetail = v;
  this.world.updateCity({ tileDetail: v });
}
setStreamFollow(on: boolean): void {                // LIVE behaviour — call directly, do NOT put in updateCity
  this.streamFollow = on;
  this.world.setStreamFollow(on);                   // NOTE: the class method is setStreamFollow (streamFollow is a console-only alias)
  on ? this._startStats() : this._stopStats();
}
private _startStats(): void {                       // optional: live readout while following
  this._stopStats();
  this._statsTimer = setInterval(() => {
    const s = this.world.getStreamStats();          // NOTE: the class method is getStreamStats (streamStats is a console-only alias)
    this.streamInfo = `focus ${s.focusTile[0]},${s.focusTile[1]} · window ${s.window} · live ${s.live}${s.pending ? ' (+' + s.pending + ')' : ''}`;
  }, 500);
}
private _stopStats(): void { clearInterval(this._statsTimer); this.streamInfo = ''; }
ngOnDestroy(): void { this._stopStats(); clearTimeout(this._tileDebounce); }
```

```html
<!-- ── Tiled world + streaming ─────────────────────────────────────────── -->
<label class="row">
  <input type="checkbox" [checked]="tiled"
         (change)="onTiledToggle($any($event.target).checked)"> Tiled world
</label>

<ng-container *ngIf="tiled">
  <label class="row">Rings
    <input type="range" min="1" max="3" step="1" [value]="tileRadius"
           (input)="onTileRadius(+$any($event.target).value)">
    <span>{{ tileRadius }} ({{ tileRadius * 2 + 1 }}×{{ tileRadius * 2 + 1 }})</span>
  </label>

  <label class="row">Tile detail
    <select [value]="tileDetail" (change)="onTileDetail($any($event.target).value)">
      <option value="flat">Flat map</option>
      <option value="focus">Focus</option>
      <option value="full">Full 3D</option>
    </select>
  </label>

  <label class="row">
    <input type="checkbox" [checked]="streamFollow"
           (change)="setStreamFollow($any($event.target).checked)"> Stream to camera
  </label>
  <div class="hint" *ngIf="streamInfo">{{ streamInfo }}</div>
</ng-container>
```

The one rule to keep straight: **`streamFollow` is not a param** — it never goes through `updateCity` and never regenerates; it just tells the live scene to start/stop tracking the camera. Everything above `tileDetail` is a normal param edit. Default the toggle **off** — it belongs to exploration, not the aerial builder view (see the intro to this section).
