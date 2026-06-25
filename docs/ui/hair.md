# Hair Panel — Frogmarks UI Integration

**Last Updated:** 2026-06-22 (Phase 1 core: live generator + sliders)
**Engine spec:** [hair-generation.md](../specs/hair-generation.md)
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
| | `sideLockWidth` | slider | 0 – 0.5 | 0.18 |
| **Tails** | `tailStyle` | dropdown | `none` \| `twin` \| `pony` \| `pig` | `twin` |
| | `tailHeight` | slider | −0.5 – 0.8 (attach height) | 0.45 |
| | `tailSpread` | slider | 0 – 1 (splay out) | 0.55 |
| | `tailLength` | slider | 0 – 6 | 3.0 |
| | `tailThickness` | slider | 0.1 – 0.8 | 0.4 |
| | `tailTaper` | slider | 0 – 1 (root→tip thinning) | 0.6 |
| | `tailCurl` | slider | 0 – 1 (downward/back curl) | 0.35 |
| | `tailTip` | dropdown | `point` \| `flare` \| `blunt` | `point` |
| **Colour** | `rootColor` | colour | hex string | `#efe7d6` |
| | `tipColor` | colour | hex string | `#7fb0d8` |
| | `gradient` | toggle | bool (off → flat `rootColor`) | true |
| | `tipFade` | slider | 0 – 1 (how far up the tip colour reaches) | 0.45 |
| **Render** | `chunkiness` | slider | 0 – 1 (poly density; low = chunkier) | 0.3 |

The interface (for typing the local object):

```ts
interface HairParams {
  preset?: string;
  capThickness: number; backLength: number; crownRound: number; hairlineFront: number; verticalOffset: number;
  partingStyle: 'fringe' | 'parted' | 'swept'; partingPosition: number; partingWidth: number;
  bangCount: number; bangLength: number; bangCurve: number; bangPointiness: number; bangOffset: number;
  sideLock: boolean; sideLockLength: number; sideLockWidth: number;
  tailStyle: 'none' | 'twin' | 'pony' | 'pig';
  tailHeight: number; tailSpread: number; tailLength: number; tailThickness: number;
  tailTaper: number; tailCurl: number; tailTip: 'point' | 'flare' | 'blunt';
  rootColor: string; tipColor: string; gradient: boolean; tipFade: number;
  chunkiness: number;
}
```

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
