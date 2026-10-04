# City quality upgrade — the Persona-grade street (roadmap)

**Status:** 🔨 in progress (started 2026-09-29).
**Source:** a four-part code review of the city generator (terrain/roads, buildings, life/props, look/atmosphere).
**Goal:** Persona-5/4-grade streets — dense, believable Japanese streets with strong graphic lighting.

The review found that the biggest gaps are **lighting and layout, not models**:
- several finished systems (procedural sky + IBL, SSR, SSAO, ink outlines, toon shadows) are never used by the city;
- a few bugs flatten every frame.

Items are tagged `[ ]` todo · `[~]` in progress · `[x]` done · `[-]` dropped (with reason). File refs are where
the problem lives. Effort S/M/L, impact L/M/H.

**Browser verification:** WGSL and visual results can only be confirmed in the browser. Every item needs a look at
the end; see the checklist at the bottom.

---

## L — Lighting correctness + night (world-manager, mesh3d shaders, post)

- [x] **L1** Remove the emissive floor. The catch-all `[/./, 0.45, 0.13]` in `_applyGlow` (world-manager) makes every
  surface self-lit, washing out shadows and turning night into "dimmed day". Set the floor to ~0/0.02 and retune the
  ambient + sun curves (day-night.ts). S/H
- [x] **L2** Shadow ordering. Point lights, ambient and emissive are added before `//__SHADOW_APPLY__`, so moon
  shadows darken lamp pools to 42%. Shadow only the direct sun term. Fade sun shadows below the horizon. S/H
- [x] **L3** Coloured cast shadows. Replace the scalar shadow floor with a colour driven from sky/ambient (blue day,
  violet dusk, indigo night). Tighten city shadow softness 2.4 → ~1.2. S/H
- [x] **L4** Night signs / screens / shop glass go dark. `world:detail-sign`, `detail-screen`, `detail-glass` miss the
  glow regex (`sign-`). Also give building signs and screens the neon shading. S/H
- [x] **L5** Don't cull the lights. Lit layers (signs, screens, lamplights, lamp-pool, detail-sign/screen) are hidden by
  the ortho detail LOD at the default overview. Exempt them, and raise the LOD thresholds. S-M/H
- [x] **L6** Night-window variety:
  - offset each wall face's UV by a hashed integer cell (meshbuild `wallsWin`);
  - give each window cell its own reshuffle phase;
  - pick the lit colour by room type (warm / cool fluorescent / TV blue);
  - jitter the lit fraction per building. S/H
- [x] **L7** Framing: exclude the sky dome and moon from `frameAllMeshes`. Add a hero camera preset for the city
  (perspective, ~40° FOV, ~30° pitch). S/M
- [x] **L8** Sky, grade and fog follow the sun, not the clock. Weight the keys by day/dusk/night; derive fog from the
  sky horizon colour. Fix tiled camera-follow fog overwriting the weather fog. S/M
- [x] **L9** The `ink` style gets no point lights (the lamp loop only runs for styles 0/1/5). Add it. S/M
- [x] **L10** Point lights at lamp-head height (currently 0.2·s ≈ 3 m, heads are at 5–5.5 m); bigger lamp pools placed
  under the head (streets.ts); a specular term on point lights so wet roads streak. S-M/H

## P — The look: packs, palettes, post (styles.ts, palette.ts, post-process, world-manager)

- [x] **P1** Style packs carry a full LOOK: grade keys, sky keys, fog, toon shadows + shadow tint, outlines, bloom,
  SSAO, lamp and neon colours, and environment style. Today they only set layout, render style and time. M/H
- [x] **P2** Palettes gain `neon` / `accent` / `windowLit[]` slots. Add dark high-contrast palettes: **phantom** (P5:
  charcoal/navy, black roofs, red/white accents) and **inaba** (P4: ochre/cream, orange sky). S/H
- [x] **P3** Author the **persona5** pack (Cel HD, ink outlines, red/black grade, violet shadows, night 0.9) and the
  **persona4** pack (warm grade, soft bloom, dusk 0.7). S/H
- [x] **P4** Enable the procedural sky + IBL in city mode, baked per time bucket and throttled. Add a sun disc and a
  moon glow. M/H
- [x] **P5** SSR on roads and water when wet or at night. SSAO sized to the city (ortho-safe). S-M/M-H
- [x] **P6** Multi-level bloom (5–6 level down/up chain) driven by an emissive mask, not a brightness threshold;
  film halation at night. Later (L-effort): an HDR float target + filmic tonemap. M/H
- [x] **P7** Colour grade: shadow and highlight tints (split-tone) plus lift/gamma/gain, so night shadows go indigo
  while neon stays warm. S-M/M-H
- [-] **P8** *(dropped 2026-09-29: a new texture binding across every pipeline is too risky for the gain — covered instead by larger lamp pools (L10) + real head-height point lights (unshadowed).)* Baked lamp and sign light map: one top-down texture of every lamp and sign pool, sampled by world
  position on the ground and lower facades. Unlimited lamps, no per-frame cost; the 16-point-light cap stops showing.
  M/H
- [x] **P9** Height fog + aerial perspective (desaturate with distance). At night, fog picks up lamp and neon colour.
  M/M

## S — Street level: roads, kerbs, stairs, terrain (terraces, preview, roadpaint, elevation, layout, water, drape)

- [x] **S1** Crosswalk and marking scale:
  - zebra depth 0.75 m → 3–4 m (`cwDepth` ≈ 0.23·s);
  - move the stop bar back to match;
  - dashes ~5/5 m, arrows ~5 m. S/H
- [x] **S2** Road paint lies on the road: subdivide strips at the road tessellation step and drop the lift from
  18 cm to ~1.5 cm with a depth bias. S-M/H
- [x] **S3** Kerbs:
  - a vertical kerb face (~15 cm) and a granite top strip;
  - rounded block corners;
  - dropped kerbs at the tactile strips;
  - a gutter strip; the sidewalk raised to kerb height. M/H
  - [x] **S3 tactile tiles** (2026-09-29): the yellow warning paving was one 0.6 m slab per crossing end with the
    world uv (xz·0.5) and `dots` freq 110 / scale 0.5. That made 27 cm "studs" 14 cm across at an arbitrary phase
    against the kerb, and the relief step (0.35 of a cell) was wider than a stud, so every dot got an offset ghost.
    Now `roadpaint.ts` lays real tenji blocks. Each block is a 30 cm tile (`TACTILE_TILE_M`), two deep along the
    kerb, a separate quad with a 6 mm joint where the pavement shows through. Each tile carries a 5 × 5 grid of
    2.5 cm studs (`TACTILE_PATTERN`: freq 10, scale 0.417). The UVs come from `emitGround`'s new per-polygon `uv`
    option (`tactileUv`), in the strip's own frame. The origin is on a strip corner, so tile edges fall on whole stud
    cells. The axes are ±d/±p, picked as close to world +X/+Z as possible, which is the tangent frame the pattern
    relief uses. The stud colour is a touch lighter than the tile. ★ One WGSL line changed: the pattern relief step
    `pEps` is 0.06 of a cell for `dots` (mode 2) and stays 0.35 for the other modes, which removes the ghost twin.
    This also affects the other `dots` users (foliage, clothing polka dots, stall produce): they now get a thin bevel
    instead of an offset ghost. Browser-checked at 0.12 and 0.45 orbit radius. No crossings are made at a junction
    sunk into a canal trench (`street-layout.junctionSunk`). Tests: `city-water-edges.test.ts` §4 (stud pitch
    6 cm, tile edges phase-locked, u only along X and v only along Z).
- [x] **S4** Stairs:
  - ~18 cm risers (~13 steps), solid treads down to the low level;
  - side walls and a landing;
  - run parallel to the wall where the pavement is too short;
  - a 1.1 m handrail, 5 cm thick, posts every ~1.5 m. M/H
- [x] **S5** Retaining walls:
  - orient each quad toward the low side (the normal bug);
  - thickness plus a lighter top slab;
  - drain holes and a base stain;
  - a mesh fence on top instead of one bar. M/H
- [x] **S6** One shared constant for the wall line and the lot/courtyard inset. Clip high-level polygons at the wall,
  so slabs stop overhanging the wall and covering the top stair treads. S/M-H
- [x] **S7** Split road cells exactly along level boundaries, so there's no asphalt wedge at wall feet. M/M
- [x] **S8** Tessellate sidewalk, lot, courtyard and plaza polygons with the road's clipped grid before draping, so
  pavements stop floating or sinking on hills. S-M/H
- [x] **S9** Terrace levels vs removed roads: never remove a road segment between cells of different levels (terrace
  walls currently cut through buildings). S/M
- [x] **S10** Ramps: start at the junction mouth and run mid-block; smoothstep the grade across the width; drape the
  adjacent sidewalk; add a crossing-road test. M/M-H
- [x] **S11** Recompute ground normals after draping/warping (finite difference of the height field), so hills are
  lit. S/M
- [x] **S12** Tiled mode: one world height field (base seed, world coords) so tile borders don't show cliffs. S/M
- [x] **S13** Water edges:
  - recess the pond with a stone ring and bank;
  - raise the canal water with a wet line on the walls;
  - blend the bridge approach and cap the deck ends. S-M/M
  - [x] **S13 bridge ends** (2026-09-29): the deck used to sit at the level-0 street height whatever the banks were.
    Next to a raised bank that left a one-storey cliff, and every pavement had a 15 cm drop onto a flat slab. The new
    `bridge-deck.ts` is the single height rule. Each end lands on its approach: the carriageway on the road's
    terrace level or ramp × step, sampled just past the end, and each footway on the kerb-raised pavement. Between
    banks on different levels the deck ramps linearly, plus a camber that is zero at the ends. `addArchBridge` now
    builds a carriageway, raised footways and kerb faces. The parapets, lamps and piers follow the footway height.
    Duplicate decks (the same crossing emitted by two canals) are deduped. The zebra and dropped kerb at a junction
    sunk into the canal are gone, because they broke the flush footway joint. Tests: `city-water-edges.test.ts` §1
    (the end heights equal `bakedGroundAt` for road and pavement; the emitted mesh ends on it; a forced raised bank
    gives a ramp with no step). Browser-checked on seeds 3, 4 and 13 (one +1-level bank, level-2 banks on seed 13).
- [x] **S14** Road-aware surface coordinates (along/across the road), so gutters, wear lanes and a wet kerb sheen can
  exist. M-L/M-H
- [x] **S15** Apron checkerboard → blended cells. S/L-M

## B — Buildings: make it Japan (layout lots, streets, building, building-parts, awnings, signage, block-manager)

- [x] **B1** A street wall:
  - alleys 3.6 m → 0–0.5 m;
  - a fixed setback in metres on street edges only;
  - random-width frontages (~4–12 m) instead of the 3×2 grid;
  - merge lots for towers / malls / civic. M/H
- [x] **B2** Party walls: mark an edge as street-facing when it's near a road, and pass the frontage mask to
  `buildBuilding`. Shared walls go plain, and AC units, downpipes and the fire escape go on the sides/back. S-M/H
  - [x] **B1/B2 water and wall edges** (2026-09-29): the road along a canal runs down in the trench, and a raised
    terrace's streets sit below its retaining wall, so both used to classify as `'street'`. The building then took
    the 0.34 m street setback and put its door there, with the railing or wall-top fence a hand's width from the
    glass (the konbini on the canal). `classifyLotEdges(…, terrain)` (terrain from `lotTerrain(graph)`) adds two
    kinds, both in `EdgeKind`. `'water'` is canal, pond, water lot or trench road beyond the edge. `'drop'` is a
    street on another terrace level. `lotFootprint` stands `EDGE_WALK_M` = 2 m back from both, a walkable strip in
    front of the railing, capped at 30% of the lot depth. The door preference is `FRONT_RANK` (street > drop > open
    > water > party), used by `pickFront` and by the basic path's `addEntrance`. A water edge only takes the door
    when every other side is a party wall; the door then opens onto the 2 m canal walk. `'drop'` keeps the street
    facade (`Edge.street`). Door visits (world-traffic) skip doors more than half a terrace step above or below the
    pavement, so walkers no longer walk through retaining walls. Tests: `city-water-edges.test.ts` §3.
    Browser-checked on seed 3 (canal-side shop: door on the street, 2 m paved strip to the fence).
- [x] **B3** Shopfronts are dressed twice (awnings/signage run on detailed lots too). Use `buildBuilding` meta for the
  door, front edge and `signSlots`, and skip the glass band on detailed lots. Set `lot.door` on the detailed path, so
  the pedestrian door-visit works. M/H
- [x] **B4** Windows per storey: v spans one storey, with Japanese sash proportions (wide, low, a meeting rail). The
  plinth band shows only where a wall section starts at the ground. Drop forced juliets and keystones. M/H
- [x] **B5** Japanese archetypes, picked by district:
  - zakkyo pencil building (a sign per floor, vertical sign stack, external stair);
  - apāto (open corridor, outside stair, a door + AC per flat);
  - mansion (frosted balcony panels, dividers, AC);
  - konbini, izakaya (red lantern, noren, sliding door).

  Wire the existing machiya and neon-arcade in. Add tile and siding facade modes. M-L/H
- [x] **B6** Shop windows: a lit interior (shelves, posters, bright fluorescent light), most bays lit at dusk; roller
  shutters on some bays at night. M/H
- [~] **B7** *(lettering is procedural kanji/katakana stroke GEOMETRY — src/world/sign-glyphs.ts, 29 glyphs — not a canvas text atlas; atlas needs shape-manager/GARP wiring)* Signs with content: vertical kanji/katakana stacks (a canvas atlas), per-floor tenant signs, rooftop
  billboard frames, menu boards, fed from `signSlots`. M/H
- [x] **B8** Utility clutter on detailed buildings (the detailed path skips the district dressing):
  - AC units with pipe runs, gas/electric meters, conduit, drain pipes, kitchen vents;
  - laundry poles, service wires to the poles. M/H
- [x] **B9** Roofs:
  - chosen by category, including kawara tile on houses;
  - clutter aligned to the front direction, sized from the real footprint;
  - TV aerials, stair boxes, billboard frames, solar water heaters;
  - fix inside-out mansards on small lots. M/M-H
- [x] **B10** Parapets and cornices get their own layer, kept out of the LOD cull (the roofline currently changes
  shape at ~25% zoom). S/M
- [x] **B11** The block default row is Japanese archetypes, not brick townhouses. The shopfront wraps around corners
  (no blank side-street ground floor). S/M

## E — Life: pedestrians, traffic, trees, props (pedestrians, traffic, world-traffic, biome, city-foliage, furniture, signals, crate, vehicle)

- [x] **E1** Pedestrian mannequins, ~10 low-poly archetypes:
  - shoulders, legs, arms, a round head, a hair cap;
  - separate top/bottom colours; uniforms and suits, a few accent colours;
  - bags and umbrellas.

  Walkers face their route, with a vertex-shader leg swing. M/H
- [x] **E2** Pavement bands (kerb furniture/trees band → walking band → frontage band):
  - parked cars on the asphalt;
  - static pedestrians, trees and lamps share one slot reservation (`StreetSlots`);
  - nobody inside cars, trunks or shopfronts. S-M/H
- [x] **E3** Traffic signals: a phase clock per junction axis toggles the lamps. Cars stop at the stop line; walkers
  wait at crossings, forming crowds. S-M/H
- [x] **E4** Cars route over the intersection graph (straight/left/right), so there's no mid-street shrink; they
  despawn only at borders/off-screen. M-L/H
- [x] **E5** Crowd footfall field:
  - denser near the station, shops, junctions and the shotengai; thinner at night;
  - groups of 2–4 facing each other;
  - seated and waiting people at benches, bus stops, vending machines and stalls. S-M/M-H
  - [x] **E5 no one in the water** (2026-09-29): anyone inside a bridge-deck QUAD counted as on land, and was then
    draped with the full elevation. Over a canal cell that is the trench level, so they stood in the water under the
    bridge. Now `staticCrowd` accepts a canal point only when it is on a deck (`deckAt`: within the span and between
    the parapets, less 1.2 cm·s) and stores `deckY`. Roads sunk in the trench carry nobody, and no crowd waits at a
    bridged junction. `buildPedestrians` builds deck people into `world:ped-deck-*` layers with `drape: 'smooth'`
    at `gy + deckY`, the same drape as the deck. Tests: `city-water-edges.test.ts` §2. ⚠ The static crowd did not
    render in the headless harness at all (land people too) during this check, so the deck people are verified by
    test only.
- [x] **E6** Street trees: regular paired rows (gaps only for driveways, doors and bus stops); tree grates and guards;
  real planter foliage instead of the octahedron shrub. S/M-H
- [x] **E7** Tree variety: 5–6 variants and a per-instance tint; a Japanese species mix (zelkova, ginkgo, camphor, sakura
  in parks, pines at shrines); seasons. S/M
  - [x] **E6/E7 leaf upgrade** (2026-09-29): broadleaf city trees (zelkova, ginkgo, camphor, sakura, broadleaf, bush)
    now grow a SPRIG CROWN (`branch.ts` `emitSprigCrown`, `leafStyle: 'sprig'`). The last branch levels sprout fine
    twiglets (2-tri ribbons), and each twiglet is lined with small alpha-cut `leafCard` sprigs (0.10–0.17 m cards,
    about 5 leaves each) whose stems sit on the wood. This replaces ~450 swept 0.5 m blades floating in 1.3 m volumes
    beyond the tips with ~1 500–2 600 cards (about 8–13k leaves) per full-detail variant. Card normals are bent
    toward the crown's outside. Twiglets lean outward so the crown fills past the skeleton, and each species has
    its own spray shape (ginkgo spur shoots, weeping sakura, dense camphor). Wider split angles give zelkova,
    camphor and sakura their shapes. The mid-LOD variants keep a full crown, with more twigs per surviving tip and
    fewer, larger cards. Leaf sway drops to ×0.6/×0.75 so leaves stay on their twigs. Cost: pool 105k→113k tris,
    drawn trees 1.06M→1.21M. Pine and conifer are unchanged.
    - **Superseded 2026-09-29 by CLUMP CROWNS** ([polish-round-3.md](polish-round-3.md) T4): at city viewing
      distance the sprig crown read busy and see-through. The city now uses `leafStyle: 'clump'` (`emitClumpCrown`).
      The sprig style still exists for close-up use.
- [x] **E8** The apron forest uses the real instanced foliage (not the old cones and blobs). S-M/M
- [x] **E9** Props:
  - postbox with slot and dome, cabinet with seams and louvres, slatted bench;
  - bicycles with ring wheels at 0.66 m;
  - place the existing bike racks and bollards;
  - traffic cones only at roadworks. S/M
- [x] **E10** Vending machines against the lot frontage in rows of 2–4 with a bin; mid-block runs too. S/M
- [x] **E11** Overhead wires: 8–12-segment catenaries, 3–6 wires per span, insulators, service drops; poles on ordinary
  streets as well. S-M/M
- [x] **E12** Walker routing: choose a new segment at each junction, cross on the zebra when the signal allows, and ease
  the turn at reversals (no instant 180° flip). M/M
  - [x] **E12 bridges** (2026-09-29): walkers' `_groundY` over a canal used a per-cell arc 18 cm up at level 0. It
    matched neither the deck span nor a raised bank, so walkers (and cars) sank into the deck or dropped at the
    abutments. It now uses `bridgeSurfaceAt` + the smooth field. `route-sim` tests "on bridge" with `deckAt` instead
    of the layout quad and exposes `net.dry`. At a bridged junction the side-street "zebra" detour (which walked out
    over the water beside the deck) is replaced by carrying straight on. Own-street crossings whose path is not dry
    are dropped. Tests: `city-water-edges.test.ts` §2b (every sampled walker point over a canal is on a deck). Cars
    were browser-checked climbing a ramped deck on seed 4.
- [x] **E13** Context clutter: a position-hash seed and road-aligned yaw for crates (currently every stack is
  identical); A-boards, stalls and crates gated by commercial frontage. S/L-M
- [x] **E14** Parked vehicles: buses and trucks only on arterials; cyclists as walkers. `streetWidth` scales with `s`. S/L-M
- [x] **E15** Umbrellas in rain; headlight pools under moving cars at night. S-M/L-M

## U — Frogmarks city panel + UI doc

- [x] **U1** Reorganise the City panel: Presets/Look → Layout → Streets & Buildings → Life → Time & Weather → Advanced
  (collapsed). Group related controls, and keep the rarely-used ones in Advanced.
- [x] **U2** A UI doc for the new city APIs and panel: `docs/ui/city-quality.md`, kept current as items land.

---

## Browser checklist (for the end)

- [ ] The city at day, dusk and night: shadows read, night is moody, lamps light the street, signs and screens glow
  at any zoom.
- [ ] Persona 5 / Persona 4 packs look distinct and graphic.
- [ ] Street level: kerbs, zebras, stairs, retaining walls, no floating paint or pavement on hills.
- [ ] Buildings form a street wall; windows follow storeys; night windows vary; signs have text.
- [ ] People walk in the right direction, nobody inside cars, trees or shops; signals change; cars turn.
- [ ] Performance: city frame time and regen time not worse than before (salsaWorld.frameStats()).
