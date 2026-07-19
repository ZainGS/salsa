# Hair Panel — Frogmarks UI Integration

**Last Updated:** 2026-06-22 (Phase 1 core) · 2026-06-26 (**card mode** — §3c) · 2026-06-28 (**Length/Curl/Layering** = Phase A + `capLayers`/`sideLockCount`/`tailStartTaper`)
**Engine spec:** [hair-generation.md](../specs/hair-generation.md) · [hair-styles.md](../specs/hair-styles.md) (the phased style system)
**Sibling UI docs:** [character-creator.md](./character-creator.md) (body + eyes), [kitbash.md](./kitbash.md) (part swap), [uv-editor.md](./uv-editor.md).

Build a **Hair** panel under *Edit Character* that generates **chunky low-poly hair** from presets + sliders — same shape as the Body and Eyes panels. Every control writes into one `HairParams` object and calls `setHairParams3D` for a **live** update on the 3D head.

> **Status legend:** ✅ live now · 🔶 engine pending (don't wire yet). Live sliders, **persistence**, and **save-as-part** are ✅ (2026-06-23); **named presets** are the one 🔶 piece left.

---

## 0. Prerequisite

Hair attaches to a **rigged body's head joint**, so the character must already have a **procedural body** (from the Body panel). No body / no head joint → `setHairParams3D` is a no-op. (Show the Hair panel only once a body exists.)

---

## 1. The flow

```
Edit Character ▸ Hair
   ┌─────────────────────────────────────────────┐
   │  Style:  [ Twintails ▾ ]   (🔶 preset list)   │
   │                                               │
   │  Cap        ▸  thickness ● back-length ●  …    │
   │  Bangs      ▸  count ● length ● parting [▾] …  │
   │  Side locks ▸  ☑  length ● width ●             │
   │  Tails      ▸  style [twin ▾] length ● curl ●  │
   │  Colour     ▸  root [■]  tip [■]  ☑ gradient    │
   │                                               │
   │  [ Remove hair ]            [ Save as part ✅ ] │
   └─────────────────────────────────────────────┘
```

1. On open → seed a local `HairParams` from `getDefaultHairParams3D()` (the Twintails reference) and apply it once.
2. Every control edits that object → `setHairParams3D(bodyMeshId, params)` (live; debounce ~30–60 ms like the Body sliders).
3. **Remove hair** → `removeHair3D(bodyMeshId)`.

---

## 2. API (✅ live now)

```ts
const params = shapeManager.getDefaultHairParams3D();   // HairParams — the Twintails preset
shapeManager.setHairParams3D(bodyMeshId, params);       // build/update hair, live (call on each change)
const cur = shapeManager.getHairParams3D(bodyMeshId);   // current params, or null if no hair
shapeManager.removeHair3D(bodyMeshId);                  // remove the hair
```

✅ **Now available (wire these):**
```ts
bakeHairToPart3D(bodyMeshId, name): string | null;   // → GLB + kitbash hair slot ("Save as part"); GLB persists
```
Hair now **persists** with the document (survives save/reload — params regenerate the mesh), and **Save as part** is live. Wire the button to `bakeHairToPart3D`.

🔶 **Still pending (don't wire yet):**
```ts
getHairPresetNames3D(): string[];           // ['Twintails','Ponytail','Pigtails','Bob','Long']
getHairPreset3D(name): HairParams;          // a named preset to load into the sliders
```
For now the **Style** dropdown can be a single "Twintails" entry (seeded by `getDefaultHairParams3D`); the rest fill in when named presets land.

---

## 3. `HairParams` → controls

Exact field names + types the engine reads. All are required on the object (start from `getDefaultHairParams3D()` and mutate). Numeric *lengths* are **factors of the head radius** (scale-independent), so the suggested ranges are unitless.

| Group | Field | Control | Range / options | Default |
|---|---|---|---|---|
| **Cap** | `verticalOffset` | slider | −0.6 – 0.8 (**move whole hair up/down** — raise it off the eyes) | 0.2 |
| | `capThickness` | slider | 0 – 0.4 | 0.14 |
| | `backLength` | slider | 0 – 4   (0 ≈ bob, 3–4 ≈ long) | 0.5 |
| | `crownRound` | slider | 0 – 0.5 (pouf/volume) | 0.12 |
| | `hairlineFront` | slider | 0 – 0.6 (forehead hairline height) | 0.42 |
| **Bangs** | `partingStyle` | dropdown | `fringe` \| `parted` \| `swept` | `parted` |
| | `partingPosition` | slider | −1 – 1 (gap centre) | 0 |
| | `partingWidth` | slider | 0 – 0.5 | 0.18 |
| | `bangCount` | slider (int) | 0 – 12 (**even** → two symmetric clusters of N/2; **odd** → one spread) | 6 |
| | `bangLength` | slider | 0 – 2.5 | 1.15 |
| | `bangCurve` | slider | 0 – 1 (forward bend) | 0.5 |
| | `bangPointiness` | slider | 0 – 1 (blunt → sharp) | 0.8 |
| | `bangOffset` | slider | −0.8 – 0.8 (**move just the bangs up/down**) | 0 |
| **Side locks** | `sideLock` | toggle | bool | true |
| | `sideLockLength` | slider | 0 – 3 | 1.8 |
| | `sideLockWidth` | slider | 0 – 0.5 (width of ONE lock) | 0.18 |
| | `sideLockCount` | slider (int) | 1 – 6 (**# of locks per side** — density, independent of width) | 1 |
| **Tails** | `tailStyle` | dropdown | `none` \| `twin` \| `pony` \| `pig` | `twin` |
| | `tailHeight` | slider | −0.5 – 0.8 (attach height) | 0.45 |
| | `tailSpread` | slider | 0 – 1 (splay out) | 0.55 |
| | `tailLength` | slider | 0 – 6 | 3.0 |
| | `tailThickness` | slider | 0.1 – 0.8 | 0.4 |
| | `tailTaper` | slider | 0 – 1 (**END** taper — thin the tip) | 0.6 |
| | `tailStartTaper` | slider | 0 – 1 (**START** taper — thin the root; 0 = full root, 1 = pointed) | 0 |
| | `tailCurl` | slider | 0 – 1 (downward/back curl) | 0.35 |
| | `tailTip` | dropdown | `point` \| `flare` \| `blunt` | `point` |
| **Colour** | `rootColor` | colour | hex string | `#efe7d6` |
| | `tipColor` | colour | hex string | `#7fb0d8` |
| | `gradient` | toggle | bool (off → flat `rootColor`) | true |
| | `tipFade` | slider | 0 – 1 (how far up the tip colour reaches) | 0.45 |
| **Render** | `chunkiness` | slider | 0 – 1 (poly density; low = chunkier) | 0.3 |
| | `sheen` | slider | 0 – 1 (anisotropic lengthwise hair highlight; 0 = off — works under **any** render style) | 0.4 |
| **Card mode** | `hairMode` | segmented | `chunky` \| `cards` (alpha-card tails — see §3c) | `chunky` |
| | `cardWidth` | slider | **0.6 – 3.0** (× tail thickness — *not* an absolute width; clamped ≥ 0.6) | 1.7 |
| | `cardsPerClump` | slider (int) | 1 – 6 (crossed ribbons per tail) | 3 |
| | `cardSegments` | slider (int) | 4 – 16 (length subdivisions) | 10 |
| | `strandDensity` | slider (int) | **2 – 12** (strand *count* across a card; rounded, min 2) | 5 |
| | `alphaCutoff` | slider | 0 – 1 (strand solidity; lower = wispier tips) | 0.5 |
| | `cardifyCap` | toggle | bool — also drape card shells over the cap ((B)/realism); else solid cap helmet | false |
| | `cardDetail` | slider | 0 – 1 (more cards + per-card jitter — the "thousands of strands" breakup) | 0.5 |
| | `volume` | slider | 0 – 1 (card-mode cap **thickness / puff**; note: **Cap Thickness is inert in card mode** — Volume is the cap thickness there) | 0.3 |
| | `capLayers` | slider (int) | 1 – 6 (**stacked, phase-shifted cap-card layers** — more = fuller/denser cap; card mode) | 3 |
| **Length / Curl** (Phase A) | `scalpLength` | slider | 0 – 1.4 (**hair HANGS past the hairline** — 0 = cap only · ~0.45 bob · ~1.3 long) | **0** |
| | `lengthFront` / `lengthSide` / `lengthBack` | sliders | 0 – 1.2 (per-region length; **front kept short** under the bangs) | 0.3 / 0.8 / 1 |
| | `scalpBluntness` | slider | 0 (wispy/tapered hem) – 1 (blunt bob hem) | 0.5 |
| | `curlType` | dropdown | `none` \| `wave` \| `spiral` | `none` |
| | `curlAmount` | slider | 0 – 1 (curl amplitude) | 0.3 |
| | `curlFreq` | slider | 0.5 – 8 (oscillations along the strand) | 3 |
| | `curlPhaseJitter` | slider | 0 – 1 (per-strand phase offset so strands don't sync) | 1 |
| | `layering` | slider | 0 – 1 (vary the hang length — wolf cut / shag) | 0.3 |
| | `chop` | slider | 0 – 1 (choppy / randomized ends) | 0.3 |

The interface (for typing the local object):

```ts
interface HairParams {
  preset?: string;
  capThickness: number; backLength: number; crownRound: number; hairlineFront: number; verticalOffset: number;
  partingStyle: 'fringe' | 'parted' | 'swept'; partingPosition: number; partingWidth: number;
  bangCount: number; bangLength: number; bangCurve: number; bangPointiness: number; bangOffset: number;
  sideLock: boolean; sideLockLength: number; sideLockWidth: number; sideLockCount: number;
  tailStyle: 'none' | 'twin' | 'pony' | 'pig';
  tailHeight: number; tailSpread: number; tailLength: number; tailThickness: number;
  tailTaper: number; tailStartTaper: number; tailCurl: number; tailTip: 'point' | 'flare' | 'blunt';
  rootColor: string; tipColor: string; gradient: boolean; tipFade: number;
  chunkiness: number;
  hairMode: 'chunky' | 'cards';
  cardWidth: number; cardsPerClump: number; cardSegments: number; strandDensity: number; alphaCutoff: number;
  cardifyCap: boolean; sheen: number; cardDetail: number; volume: number; capLayers: number;
  // Phase A — length + curl + layering (hangs scalp hair past the hairline → bob / long / hime / curly / wolf)
  scalpLength: number; lengthFront: number; lengthSide: number; lengthBack: number; scalpBluntness: number;
  curlType: 'none' | 'wave' | 'spiral'; curlAmount: number; curlFreq: number; curlPhaseJitter: number;
  layering: number; chop: number;
}
```

> **Length / Curl / Layering (Phase A) — recipes.** All are `?? default`-guarded and **`scalpLength: 0` = no change** (existing characters unaffected). Set via `setHairParams3D` (no preset picker yet): **Bob** = `scalpLength 0.45, scalpBluntness 1, lengthFront 0.4` · **Long Straight** = `scalpLength 1.3, scalpBluntness 0.3` · **Hime** = Long + `sideLock` on · **Wolf/Shag** = `scalpLength 0.7, layering 0.8, chop 0.7` · **Curly** = `curlType 'spiral', curlAmount 0.6, curlFreq 5` · **Wavy** = `curlType 'wave', curlAmount 0.4, curlFreq 2.5`. Group them as **Length** (scalpLength + front/side/back + bluntness), **Curl** (type + amount/freq/jitter), and **Layering** (layering + chop). Cards read best for length; works in chunky too. *(Geometry still being tuned from screenshots.)*

### 3c. Card mode (alpha-card hair) — ✅ steps 1–5 (2026-06-26)

`hairMode: 'cards'` switches the **tails** from solid tubes to **crossed alpha-textured ribbons** (the Elden-Ring/FF lean — see [hair-generation.md §14](../specs/hair-generation.md)). It's a **geometry + alpha-test** change, so it works under **any render style** (Cel *or* PBR — independent of the render-style dropdown). Roots + cap stay solid; the tips break into wispy strands.

- **Segmented toggle** `Chunky / Cards` (default `chunky`). Show the 5 card sliders only when `cards`.
- ⚠️ **Two ranges are easy to get wrong** (the engine clamps/rounds outside them → a wrong range = a *dead* slider):
  - `cardWidth` is a **multiplier of the tail thickness**, clamped ≥ 0.6 → range **0.6 – 3.0** (default 1.7), **not** 0.02–0.25.
  - `strandDensity` is a **strand count**, rounded with min 2 → range **2 – 12** (default 5), **not** 0–1.
- Most visible knobs: **`cardWidth`**, **`cardsPerClump`**, **`alphaCutoff`**.
- **Automatic:** card tails skin to the same **spring-bone chains** (still swing), and `hairMode` + the card params **persist** with the document like the rest.
- **`cardifyCap` ✅ (step 6):** off (default) = solid cap helmet + card tails (the anime/Genshin look). On = also drape **card shells over the cap** — kept over the *solid base*, so any strand gap reveals hair, never scalp — for the layered ER/realism look. No extra sliders: the shells reuse the strand texture + lane counts derive from `chunkiness`. Just a **"Cardify Cap" checkbox** in the card-mode controls.
- Bangs + side-locks already render as cards (they're flat ribbons) and sample the strand texture → soft wispy tips. If they read too sparse, a `solidBangs` flag is the planned escape hatch.

---

## 4. Wiring sketch

```ts
// on panel open (body already exists):
let params = shapeManager.getHairParams3D(bodyMeshId) ?? shapeManager.getDefaultHairParams3D();
shapeManager.setHairParams3D(bodyMeshId, params);     // apply current/initial

// on any control change (debounced ~40ms):
params = { ...params, [field]: value };
shapeManager.setHairParams3D(bodyMeshId, params);

// remove button:
shapeManager.removeHair3D(bodyMeshId);
```

- **Live preview is the real mesh** (regenerated each call — it's low-poly and cheap, no ghost needed). It poses with the head automatically.
- **Colour** is a root→tip gradient: `rootColor` at the scalp, `tipColor` at the ends (`tipFade` sets how far up the tip colour reaches; `gradient:false` → flat `rootColor`).
- **Dropdowns must also call `setHairParams3D`** on change (not just the sliders), and must send the **enum value**, not the display label. The engine now lower-cases enum inputs (`'Twin'` → `'twin'`, `'Parted'` → `'parted'`, …) so a capitalized label is accepted — but if a dropdown still does nothing, its change handler isn't firing the update.

---

## 4b. Fit & motion (automatic — no UI)

- **Shrink-wrap conform/drape** ✅ (2026-06-24) — on every `setHairParams3D` the hair is fitted to the body: the **cap conforms to the real (sculpted) head** (no more poking through the jaw/occiput) and the **tails drape over the shoulders/back** instead of clipping through. Fully automatic; no controls. (The cap is built at the head's own 24-gon resolution so nothing pokes between faces.)
- **Dynamic tails (spring bones)** ✅ (2026-06-25) — each tail is skinned to a **spring-bone chain**, so it **swings with inertia + gravity and collides off the body** when you pose/animate or move the character, then settles. Created automatically (with default head/chest/hips colliders); nothing to wire here. To **tune the swing** (stiffness / drag / gravity / thickness) or see/author the chains, use the **Spring Bones** API in `docs/ui/armature.md` — the hair tails appear there as light-blue bone chains.

## 5. Caveats (Phase 1)

- **Persistence** ✅ (2026-06-23) — hair is saved with the document (and `.frogmarks` export) and regenerates from params on reload. No extra save wiring needed.
- **Save-as-part** ✅ (2026-06-23) — `bakeHairToPart3D` (→ kitbash hair slot) is live and its GLB persists; wire the button.
- **No named presets yet** — `getHairPresetNames3D` / `getHairPreset3D` are pending; seed from `getDefaultHairParams3D()` for now.
- **First-cut geometry** — sizes/placement are being tuned against live screenshots; field ranges above may shift slightly.
