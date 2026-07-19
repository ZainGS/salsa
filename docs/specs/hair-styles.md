# Procedural Hair — Style System Spec (phased)

**Last Updated:** 2026-06-27
**Status: 🔄 Phase A BUILT (2026-06-27) — length + curl/wave + layering; B–E planned.**
Builds on the existing hair generator (`docs/specs/hair-generation.md`); host UI = Frogmarks.

## Context
The hair generator today expresses a narrow set of styles (a cap + bangs + side locks + twin/pony/pig
tails). The target is the full mood-board range — **Short Bob, Twintail, Twin Drills, Long Straight,
Wolf Cut, Hime Cut, Side Pony, Bun, Braid, Ponytail, Long Twin, Messy, Spiky, Curly, Afro, Half Up**
(+ variations: lob, wavy, long wavy …). Those don't map to the current params. This spec defines the
**architecture** + the **new primitives/modifiers per phase** to cover them, building on the existing
component model (not a rewrite). Engine: `src/services/managers/hair-generator.ts` (+ `scene3d-manager.ts`
for rigging/collision/presets). Host: Frogmarks owns the UI (sliders + a style picker).

## Baseline (what exists today)
- **Components:** Cap (`buildCap` dome / `buildCapCards` row-scattered layered cards), Bangs (`buildBangs`,
  conforms to the forehead), Side locks (`buildSideLocks`, 3D crossed ribbon, `sideLockCount`), Tails
  (`buildTails` → twin/pony/pig; `buildTail` tube or `buildTailCards` crossed cards swept on a quadratic bezier
  with parallel-transport frames).
- **Params (HairParams):** cap (capThickness, backLength, crownRound, hairlineFront, verticalOffset) · bangs
  (partingStyle/Position/Width, bangCount/Length/Curve/Pointiness/Offset) · sidelocks (sideLock, sideLockLength/
  Width/Count) · tails (tailStyle, tailHeight/Spread/Length/Thickness/Taper/StartTaper/Curl/Tip) · colour
  (rootColor/tipColor/gradient/tipFade) · render (chunkiness, hairMode chunky|cards, cardWidth, cardsPerClump,
  cardSegments, strandDensity, alphaCutoff, cardifyCap, sheen, cardDetail, volume, capLayers).
- **Plumbing (reuse, don't rebuild):** live `setHairParams3D`; the params bundle persists + restores; hair
  shrink-wraps out of **body + clothing** (`fitHairToBody` + `_collisionVertsForHair`); long tails can skin to
  **spring-bone** chains for jiggle (`buildTails` tags `curTailId`); `hash11` deterministic per-strand jitter;
  `cardThetaMax` + row-scatter in `buildCapCards`; `rotAxis`/`perpFrame` for strand frames.

## Architecture — components + modifiers + presets (recommended)
A **style = a HairParams preset bundle** over a small set of reusable **primitives** + **modifiers**:
- **Primitives (geometry):** scalp-with-length · bangs · side locks · tails (flexible) · bun · braid.
- **Modifiers (deform any primitive's strands):** curl/wave · layering/chop · spike · poof(volume).
- **Presets:** named bundles (the mood-board names). Frogmarks shows a **Style picker** that loads a bundle,
  then the existing sliders fine-tune it.

**Why this, not a freeform "scatter roots → regions → randomize" rewrite:** the creator is slider-driven, must
persist as named params, and must scale to crowds — a parametric component model fits all three, and each
component already scatters internally (the cap row-scatters). The recipes below show every mood-board style is a
combination of these primitives + modifiers, so we add ~6 small features, not 16 one-off hairstyles.

## Style → recipe map
| Style | Primitives + modifiers | Status today |
|---|---|---|
| Twintail / Long Twin / Ponytail / Pigtail | tails (have) | ✅ |
| Short Bob / Long Straight | **scalp length** (A1) | ❌ length |
| Hime Cut | scalp length (A1) + side locks (have) + blunt bangs | ⚠️ needs length |
| Wolf Cut / Messy | scalp length (A1) + **layering/chop** (A3) | ❌ |
| Curly / Wavy | any + **curl/wave** (A2) | ❌ |
| Twin Drills | tails + **spiral curl** (A2/C3) | ❌ |
| Side Pony / Half Up | **flexible tail placement / top-source** (B) | ❌ |
| Bun / Half-up-bun | **bun** primitive (C1) | ❌ |
| Braid | **braid** primitive (C2) | ❌ |
| Spiky | **spike** cap mode (D1) | ❌ |
| Afro | **poof** = volume + tight curl + short perimeter + layers (D2) | ❌ |

**Answer to "do we have enough params?": no — but the gaps are ~6 reusable primitives/modifiers, below.**

---

## Phase A — Scalp length + Curl/Wave + Layering  *(the biggest single unlock)* — ✅ BUILT 2026-06-27
*Implemented additively as `buildScalpLength` (a perimeter ring of hanging crossed-ribbon strands) in*
*`hair-generator.ts` — it does NOT touch the working cap/tail code. Params: `scalpLength` (× ry; 0 = cap only),*
*`lengthFront/Side/Back`, `scalpBluntness`, `curlType` (none/wave/spiral), `curlAmount`, `curlFreq`,*
*`curlPhaseJitter`, `layering`, `chop` — all `?? default`-guarded, persist + live via the params bundle.*
*Recipes (set via `setHairParams3D`): Bob = scalpLength ~0.45, bluntness 1, lengths 0.4/1/1, curl none · Long*
*Straight = scalpLength ~1.3, bluntness 0.3 · Hime = Long + sideLock on · Wolf/Shag = scalpLength ~0.7,*
*layering 0.8, chop 0.7 · Curly = curlType spiral, curlAmount ~0.6, freq ~5 · Wavy = curlType wave, amount ~0.4,*
*freq ~2.5. The hanging strands are crossed ribbons → 3D in BOTH chunky + card modes; head-skinned (jiggle later).*

### A1 · Perimeter scalp length
- **Problem:** the cap only has a back-flap (`backLength`); hair can't hang all-around → no bob/long-straight.
- **Design:** new `scalpLength` (× ry) with per-region multipliers `lengthFront`, `lengthSide`, `lengthBack`
  (0..1+). The scalp cards (`buildCapCards`) — and a matching chunky path — extend their downward hang past the
  hairline to the per-region target (front kept short under the bangs; sides → cheek/jaw; back replaces/augments
  `backLength`). Add `scalpBluntness` (0 = wispy/tapered hem, 1 = blunt bob hem) driving the card-tip taper.
- **Reuse:** the row-scatter + `hang` in `buildCapCards`; `cardThetaMax` hairline cutback; `fitHairToBody` so the
  hang drapes over shoulders/body/clothing.
- **Unlocks:** Short Bob, Long Straight, Hime back, and the base layer for Wolf/Messy/Afro/Half-Up.

### A2 · Curl / Wave modifier
- **Problem:** `tailCurl` is one downward bend; no waves/curls/spirals; can't do Curly/Wavy/Drills.
- **Design:** strand-space displacement applied along **every** strand (scalp hang + tails): `curlType:
  'none'|'wave'|'spiral'`, `curlAmount` (0..1, amplitude × local radius/length), `curlFreq` (oscillations per unit
  length), `curlPhaseJitter` (per-strand offset via `hash11` so strands don't sync). **Wave** = sinusoid on the ⊥
  frame axes; **spiral** = helix around the tangent (ringlets/drills).
- **Reuse:** the parallel-transport frame already in `buildTail`/`buildTailCards` provides the ⊥ axes; apply the
  same offset to the scalp-card centerline.
- **Unlocks:** Curly, Wavy; high-amount spiral feeds Twin Drills (Phase C).

### A3 · Layering / chop
- **Problem:** uniform length reads as a flat "curtain."
- **Design:** `layering` (0..1) = vary per-card length across a few tiers; `chop` (0..1) = randomize card end
  positions + sharpen tips (choppy). Applied to the scalp cards (and optionally the chunky cap).
- **Reuse:** per-card `hash11` jitter already in `buildCapCards`/`buildTailCards`.
- **Unlocks:** Wolf Cut, Messy.

**Phase A params:** `scalpLength, lengthFront, lengthSide, lengthBack, scalpBluntness, curlType, curlAmount,
curlFreq, curlPhaseJitter, layering, chop` (all `?? default`-guarded). Frogmarks: a **Length** group + a **Curl**
group + a **Layering** group.

---

## Phase B — Flexible tails
- **Problem:** `buildTails` hardcodes symmetric twin/pony/pig attach points — no asymmetric, count, or source.
- **Design:** generalize placement: `tailCount` (0..N), `tailPlacement: 'back'|'twin-high'|'twin-low'|'side'|
  'top'|'custom'`, `tailSideOffset` (asymmetric → side pony), `tailSource: 'nape'|'crown'|'top'` (top-source =
  the up part of a half-up). Keep the bezier sweep + curl (A2) + taper (have). Per-tail jitter for natural spread.
- **Reuse:** `buildTail`/`buildTailCards` sweep unchanged — only the attach-point computation generalizes; tails
  still tag `curTailId` for spring chains.
- **Unlocks:** Side Pony, Half-Up (top tail + A1 length below), ponytail/twin variants.

---

## Phase C — Bun, Braid, Drills
### C1 · Bun
- **Design:** new `bun` primitive at a gather point — a **coiled torus** (or wrapped-card sphere) with `bunSize`,
  `bunPosition: 'crown'|'nape'|'side'`, `bunCount`. Gathered hair sweeps up into it (a short tail → torus); cards
  wrap the torus for the carded look.
- **Unlocks:** Bun, Half-up-bun, Messy bun.
### C2 · Braid
- **Design:** a `braid` tail variant — **3 interwoven strands** plaited down the bezier (3 sine-phase-offset
  tube/card strands crossing over). `braidStrands` (default 3), `braidTightness`. Skins to the tail spring chain.
- **Unlocks:** Braid (+ braided pigtails / side braid via Phase B placement).
### C3 · Drills
- **Design:** Twin Drills = tails with `curlType:'spiral'` (A2) at high `curlAmount` + a **helix radius that widens
  toward the tip** (`drill` flag = spiral + cone profile). Reuses A2 entirely.
- **Unlocks:** Twin Drills, ringlet variations.

---

## Phase D — Spiky + Afro
### D1 · Spiky
- **Design:** a cap card **mode** `spike` — cards point **radially OUTWARD** from the scalp (not hanging), stiff
  (curl off), strongly **pointed** (taper to a point), jittered direction. `spikeLength`, `spikeJitter`.
- **Unlocks:** Spiky.
### D2 · Afro
- **Design:** a **preset combo** — high `volume` (existing) + a new `poof` (radial inflation rounding the cap into a
  sphere) + `curlType:'spiral'` tight + short all-around `scalpLength` (A1) + high `layering` + many short cards.
- **Unlocks:** Afro and curly-poof variants.

---

## Phase E — Preset library + Frogmarks style picker + docs
- **Engine:** a named-bundle API mirroring clothing — `hairStyleNames(): string[]` + `hairStylePreset(name):
  HairParams` (in `hair-generator.ts`), one bundle per mood-board name (Short Bob, Twintail, Twin Drills, Long
  Straight, Wolf Cut, Hime Cut, Side Pony, Bun, Braid, Ponytail, Long Twin, Messy, Spiky, Curly, Afro, Half Up +
  lob/wavy variations). Reuse the existing `preset` field.
- **Frogmarks:** a **Style** dropdown / thumbnail grid → loads the bundle via `setHairParams3D`, then sliders
  fine-tune. (Presets can also land incrementally as each phase enables them.)
- **Docs:** update `docs/ui/hair.md` (new sliders + the style picker) and this spec.

---

## Cross-cutting requirements (every phase)
- **Params:** add to `HairParams` + `DEFAULT_HAIR_PARAMS` with `?? default` guards so old saves load; they persist
  + restore automatically (the params bundle) and are live via `setHairParams3D`.
- **Chunky + cards parity:** implement each primitive/modifier for both modes where it makes sense (cards = the ER
  lean; chunky = the low-poly lean).
- **Collision:** all new hanging geometry (length, tails, bun, braid) flows through `fitHairToBody` (body +
  clothing) — already wired.
- **Spring jiggle:** long tails / drills / braids should `curTailId`-tag so they skin to spring chains.
- **Performance:** generation-time only; cap total card counts (afro / layers / drills can explode) — keep a budget.
- **Verification (per phase):** `npx tsc --noEmit` → rebuild + restart `ng serve` → test each unlocked style
  against its recipe row → screenshot-tune the new params.

## Recommended implementation order
**A → B → C → D → E.** Phase A is the highest leverage (perimeter length is the single biggest gap; curl unlocks a
whole class). Reassess from a screenshot after each phase before the next.
