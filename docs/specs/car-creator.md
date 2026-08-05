# Procedural Car Creator — GT-style lofted car bodies + paintable atlas

> **Deliverable of this pass:** this SPEC only. Built later, phased, screenshot-tuned. Save as
> `docs/specs/car-creator.md` (+ backlog line + memory pointer). This is a **foundational generator** at the level of
> the building / hair / clothing generators, and the first Creator asset whose *texture* is the point (a paintable
> body atlas + GARP skins → liveries). Companion: [[creator-modes]] (the Creator-Mode + preset-pool framework),
> [[city-props-garp]] (GARP pools), [[project_uv_paint]] (the UV-paint pipeline this feeds), and the reflection
> discussion below (the "why GT looks cool" answer = a matcap, not real reflections).

## Context — the problem + the target
`src/world/vehicle.ts` (`emitVehicle`) builds the CURRENT cars from a handful of axis-aligned `obox` slabs + flat
`quad4` panels, split by MATERIAL into ~6 accumulators (body/glass/trim/chrome/band/sign → 6 meshes). It's been
tuned hard (low stance, wedge, tapered glasshouse, round `beam` wheels) but it reads BOXY because:
- **Sharp 90° box edges** everywhere — no chamfers. Bevelled edges are ~80% of what makes GT's (equally faceted!)
  cars read as *rounded*.
- **No profile curve** — a box with a box on top, same silhouette every car; no hood dip / cabin crown / tumblehome
  following a real body arc.
- **No reflection** — GT's "cool" is largely a swept-horizon **matcap** on the paint. We have none, so even a good
  mesh looks flat.
- **Material-split meshes** — you can't "paint the whole car"; UV paint hits one material at a time.

**Target:** a small variety of GT-PS1-grade car bodies (sedan/coupe/wedge/hatch/kei/SUV/pickup/classic), each a
**single paintable body mesh + a wheel mesh**, with a **matcap reflection** for the sheen, authored + skinned in a
**Car Creator** mode and instanced (GARP) into the city. It's NOT a curve-capability problem — the engine already
has round primitives (`beam`/`disc`/`prism` = n-sided cylinders) and arbitrary faceted surfaces (`quad4`/`quadUV4`).
The current code just uses boxes.

## Keep the legacy cars
`vehicle.ts` **stays** — it's the city's instanced/merged workhorse (hundreds of parked + traffic cars) and the
fallback while the new system matures. The new generator is a **separate module** (`src/world/car.ts`). The city
keeps using `emitVehicle` until the new cars are GARP-instanced and perf-verified; then it can adopt them per
detail level. No deletion, no forced migration.

## The car CONTRACT (the interface)
Pure function, mirroring the building/hair/clothing generators — **CarSpec in → geometry + metadata out**:
- **Generate** — `buildCar(spec: CarSpec) → { layers: LayoutPreviewLayer[]; meta: CarMeta }`.
- **Customize** — everything is params in the spec (regenerate on change); presets are data.
- **Metadata out** — `CarMeta`: wheel anchors (4), body length/width/height, headlight/taillight/plate anchors (for
  the sim + future GARP light decals), roof-sign anchor (taxi).
- **Detail level** — `spec.detail: 0 | 1 | 2 | …` picks the mesh-complexity tier (below). Same profile, more meshes.

```
CarSpec {
  profile: CarProfile          // sedan | coupe | wedge | hatch | kei | suv | pickup | classic (the silhouette+section preset)
  detail: DetailLevel          // L1 body+tires (painted glass) · L2 +punched glass mesh · L3+ parts
  bodyColor / paint            // base tint (or a GARP skin overrides the whole atlas)
  wheel: { style, sizeM }      // rim design (texture) + diameter
  chamfer: number              // edge-bevel amount (0 = boxy legacy look, up ~0.06 m = soft GT read)
  worldPerMetre                // metres → world units (= 1/cityMetresPerUnit(radius)); Creator authors 1:1 m
  seed
}
```

## The geometry engine — a LOFTED body (this is the de-box)
GT bodies are faceted, not curved — the trick is a **swept cross-section along a silhouette**, with **chamfered
shoulders**. Build the body as a loft:

1. **Silhouette** — a longitudinal polyline of *stations* along the car's length, each giving `topY` (roofline /
   hood / deck height) and `botY` (rocker). Ordered nose → hood → cowl → roof-front → roof-back → deck → tail. The
   station heights *are* the body arc: hood low, cabin crowned, deck dropped, nose/tail tapered.
2. **Cross-section** — at each station, a **half-profile** of points from rocker up to the crown: `[rocker-out,
   sill, belt-out, SHOULDER-CHAMFER (1–2 bevel points), crown-in]`, mirrored across the centreline. The shoulder
   chamfer is what rounds the read; tumblehome = crown-in narrower than belt-out.
3. **Loft** — for N stations emit a ring of section points; stitch adjacent rings with `quad4` (a lofted tube).
   Cap the nose + tail. **Mesh is double-sided by default** (`doubleSided ?? 'double'` in mesh-generators) so quad
   winding is free — build in profile order and don't fight normals.
4. **Chamfer amount** is a param → dials from the current boxy look (0) to a soft GT read.

**Variety = profile presets.** Each `CarProfile` is a `{ silhouette stations, cross-section, wheelbase, cabin
fraction }` data blob. Sedan vs coupe vs wedge vs SUV are just different station heights + section widths + cabin
placement — the same loft code, different data (identical pattern to the building archetypes / hair styles).

The **greenhouse** (cabin) is a second short loft belt→roof (its front/back stations are the raked windshield /
backlight, its section pulled in for tumblehome). At L1 its faces are painted glass; at L2 it becomes frame + inset
glass (below). This replaces the current 5-`quad4` hack — same idea, now part of the profile system.

**Wheels** — one wheel mesh, instanced ×4 at the `CarMeta` anchors: a `beam` cylinder tread + `disc` face caps
(already done in `vehicle.ts`) + a textured rim face. Its own GARP pool / UV region.

## Detail levels (the agreed complexity ladder)
| L | Meshes | Glass | Use | Notes |
|---|---|---|---|---|
| **L0** | legacy `vehicle.ts` (6 material meshes) | flat panels | city workhorse, fallback | kept as-is |
| **L1** | **body + wheels** (2 meshes) | **painted onto the body atlas** (dark window region) | first target; Creator hero car + GARP city instances | GT-authentic: windows/lights/panel-lines all painted on one texture |
| **L2** | body + wheels + **glass** (3 meshes) | **punched out** → separate glass mesh, real transparency + matcap shine | higher-detail hero car | see "punch-out" below |
| **L3+** | + separate **lights / mirrors / spoiler / bodykit / interior / brake discs** | — | showcase / close-up | each a bolt-on mesh; parts become GARP-swappable |

**"Punch-out" is not a boolean subtract.** L2 rebuilds the greenhouse loft as **pillars + header + sill FRAMES**
(body colour) leaving the window openings empty, and fills each opening with a thin **glass mesh** (own material:
transparent + matcap). The body atlas loses its painted-window region there. The *profile* is shared L1↔L2 — only the
cabin build + a glass mesh differ, selected by `spec.detail`. Same for L3 parts (bolt-ons keyed off `CarMeta` anchors).

## The paintable body ATLAS (this is the UV-paint answer)
YES — at L1 you paint **paint-color + windows + headlights + taillights + grille + panel lines onto ONE body
texture**, and the wheels onto one wheel texture. **That is exactly how GT did it** (paletted body atlas; color
change = palette swap; wheels separate; reflection a separate pass). Requirements:
- **One coherent unwrap** for the body loft. Proposed: **symmetric** (left = mirrored right, so painting one side
  paints both) + top run (hood→roof→deck) as one strip + nose/tail patches. Define named atlas **regions** in
  `CarMeta.uvRegions` (`paint`, `glassWindshield`, `glassSide`, `glassRear`, `lightFront`, `lightRear`, `grille`,
  `plate`) so the Creator UI + GARP skins can target them.
- Feeds [[project_uv_paint]] directly: the body is one mesh → `UVPaintController` paints the whole car; persisted via
  `meshTextures`. The wheel is one mesh → paint the rim.
- **GARP** body pool `salsa/car-body` + wheel pool `salsa/car-wheel`: canonical 0..1-UV geometry, placeholder
  skins (a painted livery + a rim), resolver in `shape-manager` (same pattern as clutter/warning). A world swaps in
  stylized liveries → instant fleet variety, `registerGarpPool3D('salsa/car-body', …)`.

## The matcap reflection — the biggest "GT polish" per effort (orthogonal to LOD)
The GT sheen = a **matcap**: sample a small **sky→horizon→ground gradient** texture by the **view-space normal**
(`uv = 0.5 + 0.5 * normalView.xy`), blend over the paint. As the car turns, the bright horizon band sweeps the
panels → reads as reflective. Cheap, static, convincing. Applies to **all detail levels** and the glass mesh.
Integration: a material flag on the body/glass layers (alongside the existing `glass` / `metal` handling in
`material-3d.ts` + the mesh fragment shader). **Build this FIRST — it's a shader + a gradient texture, independent of
the mesh rework, and does more for the look than any extra geometry.** (See the reflection strategy discussion:
matcap = "environment map before environment maps".)

## Creator Mode + city wiring
Standard Creator asset (per [[creator-modes]]): `src/world/car.ts` (DEFAULT_CAR_PARAMS / resolveCarParams / emit /
`buildCar`) + `car-manager.ts` (ProceduralObjectManager subclass) + `creator-registry.ts` line + `_creators.set` in
`shape-manager.ts`. Creator UI exposes profile preset, chamfer, wheel style, colors, detail level, GARP skin picker;
paint via UV-paint. The **city** stays on `emitVehicle` (L0) until L1 is GARP-instanced + perf-checked; then parked +
traffic can spawn L1 GARP instances (one canonical body geo per profile bucket + a transform + a skin, exactly like
the clutter GARP layers) — the **hero car** (Creator, paintable, L2/L3) is separate from the **fleet** (instanced, GARP-skinned).

## Phasing
1. **Matcap** — gradient texture + material flag + FS blend on existing L0 cars. Instant win, validates the look.
2. **Loft engine + one profile (sedan)** at L1 — body+wheels, chamfered, single atlas, matcap. Prove the pipeline.
3. **Profile presets** — coupe/wedge/hatch/kei/SUV/pickup/classic (data only, same loft).
4. **UV-paint + GARP pools** — symmetric unwrap, `uvRegions`, body+wheel pools, resolver, placeholder liveries.
5. **Creator Mode** — car-manager + registry + UI; paintable hero car.
6. **L2 punch-out glass** — frame greenhouse + transparent glass mesh + matcap glass.
7. **City adoption** — GARP-instanced L1 fleet replaces/augments `emitVehicle`; perf pass.
8. **L3+ parts** — lights/mirrors/spoilers/interior as anchored bolt-ons; part-swap GARP.

## Open decisions
- **Glass at L1**: painted-on (GT-authentic, simplest) is the default; real transparency waits for L2. ✅ agreed.
- **City fleet**: keep L0 for the mass fleet initially; L1 GARP instances only once perf is verified (a lofted body
  is heavier than a box — bucket by profile + share canonical geo, don't per-car-unique).
- **Unwrap symmetry**: symmetric (paint both sides at once) unless a livery needs asymmetric numbers/decals — could
  add an `asymmetric` flag later.
