# Creator Suite — apps-in-one-app over the shared asset spine

**Date:** 2026-09-17 · **Status: SPEC ONLY — architecture/roadmap; individual apps have their own specs.**
**Status (2026-10-04): engine side PARTLY built** (see §6.3 "largely built"): the creator registry + schemas
(`creator-registry.ts`, `sm.creatorTypes3D` / `createCreator3D`, 10 prop types), the asset spine L1–L3 (+ 5 providers;
[shared-asset-library.md](shared-asset-library.md)), and the per-app engines (Character Creator, animation library,
packaging, CD, UI kit). **Not built:** `ShellUIManager.launchSlot` (still throws "Phase 6"), an `sm.creator` enter/exit
facade, the unified Library panel / app switcher (host).
**Origin:** the product vision is a **Shell that launches specialized creators** (Characters, Animations, Materials,
Effects, Items, Worlds, Behaviors, …) that all read and write **one account-global asset library**, so anything
authored in any creator drops into any Illustration. This spec is the *map*: what the apps are, what each authors, what
engine capability already backs it, how they compose, and the order to build them. It sits above the per-app specs and
the [Shared Asset Library](./shared-asset-library.md) (the spine) and [Shell UI](./shell-ui.md) (the launcher).

## 1. The frame — three tiers, not one flat list

The organizing principle: **an app authors one asset *kind* that flows through the library into the composer.** That
sorts everything into three tiers:

1. **Authoring apps** — each produces a reusable `AssetKind` (Characters→character, Animations→anim-clip/pose,
   Materials→material, Effects→effect, Items→prop, Palettes→palette, Audio→audio, …). Each = a **creator mode** + an
   **`AssetProvider`** registered on the library.
2. **The composer** — *Illustrations* (the existing 2D+3D editor) and any Scene/World surface. It **consumes** the
   library and assembles assets into a deliverable. It is NOT a peer authoring app; it's where assets land.
3. **The runtime/logic layer** — *Behaviors* + Play mode. What turns a composed scene into a **game** (the "walking-sim
   ceiling" breaker). Authors `effect`-adjacent logic assets (state machines / scripts) but its home is Play.

Everything a creator makes is an asset; the Shell is the app switcher; the library is the shared memory.

## 2. The app catalog

Readiness: **Built** (engine capability shipped) · **Partial** (primitives exist, no unified creator/app) · **New**
(substantial new build). "App" ≠ "generator": many existing procedural generators fold in as *sub-tools*.

| App | Authors (`AssetKind`) | Engine systems backing it | Readiness | Notes |
| --- | --- | --- | --- | --- |
| **Characters** | `character` (+ `character-part`) | character creator, kitbash, procedural body/clothing/hair/charms, armature | **Built** | Ship as a registered provider; the creator UI exists (character-creator.md) |
| **Animations** | `anim-clip`, `pose` | armature, animation library + retarget, NLA, blend trees/overlays, turntable preview | **Built** | First provider already wired (shared-asset-library.md L2). Char↔object interaction = attach item to a hand joint + animate (charms/GP already joint-anchor) |
| **Materials** | `material` | surface-recipe catalog (`setSurfaceMaterial3D`), PBR material, procedural patterns, env/IBL | **Partial** | Recipes + apply exist; needs an authoring UI + a considered `material` payload (recipe, not a fold-in) |
| **Palettes** | `palette` | (data only — color swatches) | **New (small)** | Cheap, high-leverage (Adobe Libraries' most-used kind); composes with every other app. Named in creator-modes.md Phase C |
| **Effects** | `effect` | particle system, post-processing (bloom/grade/vignette), procedural patterns, LiveText screens, spring/idle | **Partial** | Composes existing primitives into a reusable effect. ★ `effect` is the one kind that can carry executable logic → gated behind the script sandbox (shared-asset-library.md §7) |
| **Behaviors** | `behavior` (state machine / script) | UI state machine (built), triggers, Play mode, script-behaviors (specced) | **Partial** | The game-maker. Highest-value NEW authoring work; depends on script-behaviors.md landing |
| **Items** | `prop` | mesh primitives, kitbash, mesh-editing, procedural patterns/materials | **New** | A general small-prop modeler — the connective tissue of scenes. Bigger build than the asset-kind folds |
| **Worlds** | `environment` / scene-dressing | world generation, city-detail, procedural ground, environment/sky/IBL, foliage/building/vehicle/vending generators | **Built (fragmented)** | HUGE existing capability with no unified app. Fold the many generators in as sub-tools |
| **Illustrations** *(composer)* | — (consumes) | the existing 2D vector + raster + 3D-scene editor | **Built** | Reclassify as the composer, not a sibling app |
| **UI / HUD** | `ui-layer` | UI system (menus/transitions/forms/sound), `.frogcart` | **Built (engine); editor pending** | Surfaces once games are in play; Frogmarks editor = UI-System Ph5 |
| **Products** *(group)* | print/commerce outputs | CD jewel-case designer, package/box creator, print-PDF | **Built** | End-products, not reusable assets — group as a category, don't scatter |
| **Audio** | `audio` | UI-sound playback + `.frogcart` audio bundling | **Partial (library, not authoring)** | v1 = import/tag/assign a sound library, NOT a synth/DAW |

## 3. Grouping principle — don't ship 20 tiles

The failure mode is a launcher full of half-finished apps. Two rules:
- **Generators fold under apps.** Building / Foliage / Vehicle / Vending / Car creators are **sub-tools of Worlds**, not
  top-level apps. Cups / swords / shovels are **Items**, not separate apps.
- **Group end-products.** CD + Package + print live under **Products**.

Target set: **~8 authoring apps** (Characters, Animations, Materials, Effects, Items, Worlds, Behaviors, + Palettes/Audio
as lightweight library kinds), **Illustrations** as the composer, **Products** as a group, **UI/HUD** when games arrive.

## 4. Cross-cutting architecture (how an app is defined)

Every authoring app is the same three things, so adding one is cheap once the framework exists:
1. **A creator mode** — `sm.creator.enter(kind, params?)` / `update` / `savePreset` / `exit` over a generator registry
   (`{schema, defaults, build, previewScene}`), from [creator-modes.md](./creator-modes.md) §Phase A. ONE schema-driven
   Frogmarks panel serves every creator.
2. **An `AssetProvider`** registered on the [Shared Asset Library](./shared-asset-library.md) — `meta`/`instantiate`
   (+ optional `thumbnail`), so its output is promotable + reusable everywhere.
3. **A Shell slot** — the launcher entry ([shell-ui.md](./shell-ui.md)); the shared **kind-generic Library panel** shows
   its assets automatically (no per-app panel work).

This is the payoff of the frame: apps are uniform (creator mode + provider + slot), so the suite scales by *adding
providers*, not by forking editors. One engine, many front doors.

## 5. Build order (by readiness × value)

- **Wave 0 — the spine + the launcher (PREREQUISITES, §6 below).** Nothing else is real until these land.
- **Wave 1 — prove the suite with what's built:** register providers for **Characters** + **Animations** (done) +
  **Materials** + **Palettes**; ship the shared Library panel + Shell slots. This makes "author once, reuse everywhere"
  visible with near-zero new engine work.
- **Wave 2 — enable games:** **Behaviors** (state machine + script-behaviors) + **Effects**. This is where the suite
  stops being a scene-dresser and becomes a game-maker.
- **Wave 3 — the bigger new surfaces:** **Items** (prop modeler), **Worlds** (unify the generators), **Audio** library,
  **UI/HUD** editor, **Products** grouping.

## 6. Prerequisites — what must land before Wave 1

1. **Shared Asset Library L3 (reference + embed persistence).** The spine currently stores + instantiates, but a
   document doesn't yet remember which global assets it uses (the reference/embed wiring is specced + unit-tested, not
   persisted — shared-asset-library.md §6). Without it, "author once, reuse + update everywhere" has no memory. **The
   #1 prerequisite.**
2. **Shell launch path.** [shell-ui.md](./shell-ui.md) is Phases 1–3 (storage/state/slot grid); `launchSlot()` is a
   Phase-6 **stub**. The Shell must actually *boot an app* (route/mode switch) for "apps in one app" to exist.
3. **The generic creator-mode framework — ★ LARGELY BUILT (verified 2026-09-18).** `creator-registry.ts` (unified
   `CreatorParamSchema` + 10 creators as data) + `ProceduralObjectManager` (generic create/live-edit/persist) +
   `sm.creatorTypes3D/creatorParamSchema3D/createProceduralObject3D` already exist. The remaining bits are NOT an
   extraction: `savePreset → sm.assets.promote` (bridge to the library), folding the bespoke big creators
   (Character/Package) into it, and the switcher UX. See §7.
4. **The kind-generic Library panel (Frogmarks).** One panel component driven by `sm.assets.list({kind})` +
   `meta`, so every provider appears automatically (shared-asset-library.md §Suggested UI).
5. **Frogmarks wiring of the recent engine batch** — Characters/Animations/Play-mode/etc. UI docs are handed off but
   not all wired; the apps build directly on them.

## 7. Building the creator-mode framework — non-destructive extraction (Strangler Fig)

Prerequisite #3 (the generic `sm.creator.*` framework) must be built **without risking the shipping Illustrations
editor**, which hosts the existing creators (Character, Building, Foliage, Vending, Package) on bespoke, load-bearing
paths. So the framework is **added beside** the existing creators, never a rewrite-in-place. The enabling fact: the
extraction is the *lifecycle + panel* wrapper — the procedural functions (`buildBuilding`/`buildFoliage`/body builders)
already exist and are reused verbatim as each registry entry's `build`. The framework wraps what works; it doesn't
reimplement it. Phases (expand → migrate → contract):

- **★ CORRECTION 2026-09-18: most of this framework ALREADY EXISTS.** A code audit found the generic creator framework
  is largely built — `services/managers/creator-registry.ts` (a unified `CreatorParamSchema` = the ephemera schema,
  reused *deliberately* to avoid a second convention; a registry of 10 creators as data — vending/foliage/bollard/…),
  `services/managers/procedural-object-manager.ts` (`ProceduralObjectManager` base — `createFromParams`, `setParams`
  [merge + re-resolve + regenerate IN PLACE], `resolveParams` defaults+clamp, params-only-marker persistence + restore),
  and the `sm.*` facade (`creatorTypes3D` / `creatorParamSchema3D` / `creatorDefaults3D` / `createProceduralObject3D`).
  So "extract the framework" is NOT the work. (A brief duplicate `src/services/creator/` built this session was DELETED
  on discovering this — never ship a second schema convention.)
- **The shipped model is create-in-place, not focus-preview.** A creator makes its object directly in the scene and
  `setParams` live-edits it. That's a valid, simpler lifecycle than §8's "enter a focus preview → save → exit" — treat
  §8's mode/preview as UI sugar the switcher can add, NOT a new engine lifecycle.
- **What ACTUALLY remains for the suite** (the real Phase A/B work): (1) **`savePreset → Shared Asset Library`** — the
  existing creators emit scene objects but don't promote their params as reusable `preset` assets; this is the missing
  bridge to the library (a `preset` provider whose `instantiate` = `createProceduralObject3D(typeId, params)`).
  (2) **Fold the bespoke big creators** into the asset treatment: ✅ **Character DONE 2026-09-18** (a `character`
  asset = the `exportCharacter3D` preset; async provider regenerates the rigged body on instantiate); **Package** still
  bespoke. (3) The **app-switcher UX** (Frogmarks) over `creatorTypes3D` + `createCreator3D`.
  Providers now live: `anim-clip` / `pose` / `preset` / `character` / `material`. (`AssetProvider.instantiate` was
  generalized to allow async for the character case; target shapes vary by kind — `{skeletonId}` anim, `{transform}`
  preset/character create-a-node, `{meshId}` material apply-to-existing.)
- **Phase B — New apps on the framework first.** Materials / Effects / Palettes go straight onto `sm.creator.*` — they
  have no legacy path to break, so they're the safest validation of the framework AND where the suite starts paying off.
- **Phase C — Migrate existing creators one at a time, behind verification.** Move a creator (e.g. Building) onto the
  framework only after B proves it, one per change, each gated by: unit tests green + the creator driven in the browser
  + an Illustrations regression pass (open doc, use still-bespoke creators, save/load). A bad migration reverts just
  that one creator.
- **Phase D — Contract (delete bespoke code) last, and only when earned.** A creator's old code is removed only after
  its new path is verified in the app. Some may never migrate (Package Creator is deeply wired — staying bespoke is
  fine). Cleanup is the reward, not the risk.

Net: non-destructive is *faster* to a working suite — Phase B ships user-visible new apps before a single existing
creator is touched.

## 8. App navigation — Shell launcher + in-editor mode switcher

Because an authoring app **is a creator mode** over the one shared document + asset library (not a separate program),
switching apps is entering/exiting a mode within a session — cheap and flow-preserving. Two layers, both wanted:

- **Shell = the front door (session start).** Pick a project/Illustration to open, or launch a creator standalone. Used
  when entering the workspace, not for every switch. (shell-ui.md — needs the `launchSlot` path, prerequisite #2.)
- **In-editor mode switcher = the everyday driver.** A persistent switcher (a workspace tab-bar and/or a `Ctrl-K`
  command palette) that calls `sm.creator.enter(kind)` to drop into any creator on the fly — author, save to the
  library, return to your work — with **no Shell round-trip**. This is the big time-saver, and the creator-mode
  framework (§7) makes it nearly free: each app is already an enter/exit mode; the switcher is just UI over it.

Model to follow: **Blender workspaces / Affinity Personas** (one app, switch authoring lenses over shared data), NOT
Adobe's separate-apps-with-shared-Libraries (heavier, users feel the app-switch friction). Rules: entering a creator
mid-edit is **non-destructive** (the creator gets its own focus preview; your document is untouched — the framework's
"one preview instance in the focus workspace" gives this); show a breadcrumb (`Illustration › Material Creator`) so
where-you-are is obvious; a command palette scales to many apps without a crowded tab bar. The Shared Asset Library is
what makes on-the-fly switching worthwhile — author a material in a quick detour, and it's immediately usable back in
the document.

**Two app categories, both covered by the two layers:** some apps author things tied to the *current scene* (drop a
prop, dress the open character) — these clearly want the in-editor switcher; others author *standalone* library assets
with no dependence on the open document (a material swatch, a reusable character) — these work equally well launched
from the Shell or as an in-editor detour. So the split is natural: **Shell = "start something fresh" (used
occasionally); the in-editor switcher = "I need this for what I'm doing right now" (used constantly).** The fast path
is also the architecturally natural one — apps are modes over shared state, so on-the-fly *is* the default.

## 9. Open questions / deferred

- **Account identity + storage scope.** v1 library is OPFS-local (per browser profile). Cross-device/team libraries need
  an account backend + sync — deferred, but the `createdBy` field + re-mint-on-import are already in place for it.
- **Where does the 3D Scene live?** Today it's a layer inside Illustrations. Worlds-as-an-app may want its own surface;
  decide whether Worlds is a mode of the composer or a distinct app (leaning: distinct, given the scale of world-gen).
- **Interaction animation** (character↔object) — attach-to-joint exists; a first-class "interaction" authoring flow
  (grip points, IK targets on props) is an Animations-app follow-up, not v1.
- **`behavior`/`effect` sharing safety** — executable kinds stay disabled-on-import until the QuickJS/Worker sandbox
  from [script-behaviors.md](./script-behaviors.md) §3 ships.
