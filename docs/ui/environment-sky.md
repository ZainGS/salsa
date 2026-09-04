# Environment & Sky — host UI guide

**For:** Frogmarks (the host). **Engine:** Salsa. **Spec:** `docs/specs/environment-and-reflections.md` · **Theory:** `docs/theory/environment-lighting-and-reflections.md`.

This is the sky / atmosphere / reflections surface: one-tap **sky presets** that drive lighting *and* reflections coherently, plus the crisp specular reflections they now produce. All of it is **opt-in** — a scene looks exactly as before until the host applies a sky.

---

## What it does (in one line)

Applying a sky preset sets the **sky dome**, aims + tints the **key light**, bakes the sky into **diffuse ambient** (SH) *and* a **prefiltered specular cubemap** (crisp, roughness-graded reflections) — so shadows, ambient, and what metal/water/glass reflect all come from the same sky.

---

## Host API (`shapeManager.*` unless noted)

| Method | Description |
|---|---|
| `applySkyPreset3D(name, intensity?)` | **One-tap atmosphere.** Sets the sky, aims/tints the key light, bakes diffuse **and** specular IBL. `name` ∈ `listSkyPresets3D()`. |
| `listSkyPresets3D()` | Preset keys for a picker: `noon`, `goldenHour`, `sunset`, `overcast`, `night`, `studio`. |
| `applyProceduralSkyIBL(intensity?)` | Re-bake the **current** sky into IBL without changing any params (e.g. after nudging the sun). |
| `setSky3D(partial, intensity?)` | Patch individual sky params (`zenith`, `horizon`, `ground`, `sunColor`, `sunSizeDeg`, `sunHalo`, `gradientBias`, `intensity`) and re-bake. |
| `getSky3D()` | The current sky params (for initialising sliders/swatches). |
| `resetSky3D()` | **Clear / undo.** Restores the scene's pre-preset sun/ambient/IBL (a *true* undo — the city keeps its own lighting) and turns off the sky-driven reflections. Falls back to engine defaults if no preset was applied. |
| `environment3D` | The environment state owner (`.state.sun / .ambient / .fog / .sky`). Read for a full atmosphere panel. |

### Balancing diffuse ambient vs. reflections (independent controls)

Diffuse sky-ambient and specular reflections are **separately dialable** — you can have strong ambient with subtle reflections, or turn reflections off while keeping the sky ambient.

| Method | Description |
|---|---|
| `setIBLSpecularIntensity3D(v)` | Reflection strength `0..1` (`0` = no cubemap reflections, ambient unaffected; `1` = full). **No re-bake** — cheap, good for a live slider. |
| `setIBLDiffuseIntensity3D(v)` | Sky-ambient strength, independent of reflections. |
| `getIBLIntensities3D()` | `{ diffuse, specular }` — initialise two sliders. |
| `clearSpecularIBL3D()` | Turn off crisp reflections while **keeping** the diffuse sky ambient. |
| `bakeSpecularOnlyIBL()` | Re-bake just the reflection cube from the current sky (diffuse SH untouched). |

Both intensities **persist** with the scene. Where to surface them: a scene-wide **Reflections** slider in the Global/Atmosphere panel is the natural home (`setIBLSpecularIntensity3D`).

### Screen-space reflections (SSR)

Cubemap reflections (from the sky) show the *sky*; **SSR** makes reflective surfaces also reflect the actual **scene**. It composites *over* the sky cubemap (hit → scene, miss → sky), so it degrades cleanly.

**What SSR is FOR (important — set user expectations):** **floors and glancing reflective surfaces** — a cube/character mirrored in a reflective floor, wet-street looks, glossy tabletops. Works in perspective *and* ortho/isometric.
**What SSR will NOT do (by design):** **wall mirrors.** A face-on mirror must show the *backs* of objects in front of it — surfaces the camera never rendered, so the data simply doesn't exist. Wall-mirror-style reflectors show only the sky/cubemap (clean, no artifacts). True mirrors are the upcoming **planar reflections** feature. Also: reflections show objects' *camera-facing* sides (a floor can't show an object's underside), lag one frame (invisible in practice — the engine self-settles when interaction stops), have finite reach (they **fade out smoothly** near the reach limit rather than cutting — the visible reach shrinks as you zoom in, since the budget is measured in screen pixels), and fade at screen edges. All standard SSR behaviour; scenes needing longer reach can raise `ssrMaxSteps` via `setSSR3D`.

| Method | Description |
|---|---|
| `setSSR3D({ ssr: true })` | Toggle SSR. Optional artistic knobs: `ssrIntensity` (0..1 over the cubemap), `ssrMaxRoughness` (surfaces rougher than this skip SSR). |
| `getReflections3D()` | Current reflection config — init the panel from this. |
| `setSSRDebug3D(on)` | Diagnostic view: reflective fragments show their ray-hit UV as red/green. |

Natural home: a **Reflections** subsection in the Global/Environment panel — an SSR on/off toggle plus an intensity slider. Persists with the scene — but note: **only the intent persists** (`ssr`, `ssrIntensity`, `ssrMaxRoughness`, `cubemapRes`); the ray-march tuning (`ssrMaxSteps`/`ssrStride`/`ssrThickness`) is engine-owned and always uses current engine defaults on reload (don't build UI for those three — they exist for debugging only).

**Notes / gotchas:**
- **Only shows on reflective surfaces** — metallic (metalness ↑) + low-roughness, or smooth dielectrics (roughness below the cutoff) for the wet-floor look. Matte scenes look unchanged.
- **Cost is opt-in:** enabling SSR runs a world-position prepass (plus one extra settle frame after interactions). Off by default → zero cost, no visual change.
- Rougher surfaces blend from sharp scene reflection toward the soft cubemap automatically.

### Per-object matte override

For a specific object that should **ignore sky reflections entirely** (a powder-coated/matte metal), regardless of the scene-wide setting:

| Method | Description |
|---|---|
| `setMeshNoEnvReflection3D(meshId, on)` | `on=true` → this mesh skips environment-specular reflections (matte); `false` → normal. Persists with the mesh material. |

Natural home: a **"Matte (no reflections)"** checkbox on the **material panel** (per-mesh). Note this only changes metallic surfaces — dielectrics (skin/cloth/plastic) already receive no environment specular, and `roughness → 1` already blurs a metal's reflection nearly flat, so reach for this only when you need a *hard* off on a metal.

Existing lighting/fog methods (`setDirectionalLight3D`, `setLightAngles3D`, `setAmbientLight3D`, `setFog3D`, `setEnvironmentMap3D`) still work and now feed the same `environment3D` owner — see [3d-scene.md](./3d-scene.md).

### The presets

| Key | Look | Sun |
|---|---|---|
| `noon` | clear blue, bright | high, white |
| `goldenHour` | amber horizon, warm | low (12°), warm |
| `sunset` | orange/red, purple zenith | very low (3°), red |
| `overcast` | flat desaturated grey | high, weak |
| `night` | dark blue dome | cool dim "moon" |
| `studio` | neutral bright softbox | soft, product-look |

---

## Where to surface it

A **Sky** section in the **Global** tab (scene-level, shown when the 3D Scene layer is active — not per-mesh). A row of preset buttons (label each, keep the active one highlighted) plus a **Clear** button wired to `resetSky3D()`.

```
▸ SKY ────────────────────────────
  [Clear Noon] [Golden Hour] [Sunset]
  [Overcast]  [Clear Night] [Studio]
  [ ✕ Clear ]
```

A fuller "Atmosphere" panel can later expose `getSky3D()`/`setSky3D()` param sliders (zenith/horizon/ground swatches, sun size/halo, intensity) for custom skies.

---

## What changed for reflections (2026-09-02)

Before, reflections were **soft** — metals reflected a low-frequency spherical-harmonic blob. Applying a sky now also bakes a **prefiltered specular cubemap**, so reflective surfaces show **crisp, roughness-graded reflections**: a polished floor mirrors the sky sharply, a brushed-metal one softly, from the same environment. This is automatic — `applySkyPreset3D` / `applyProceduralSkyIBL` produce it; nothing extra to call. Rougher materials read blurrier; `metalness`/`roughness` on a material drive how much and how sharp (see [3d-scene.md](./3d-scene.md) §Material).

---

## Behaviour notes / gotchas

- **Opt-in, no default change.** Until the host calls a sky method, scenes render exactly as before (the specular cube is off, a dummy is bound, and the LUT bake is deferred — zero cost).
- **The 3D Scene layer must be active** for the 3D view to be live (the standing free3D/scene gotcha — see [free-camera-and-targets.md](./free-camera-and-targets.md)). Apply presets with that layer selected.
- **Persists.** The sky params, the SH-diffuse look, and a flag to re-bake the specular cube all save with the scene and restore on reload — including editable params, so the preset stays adjustable after a reload.
- **Clear is a true undo.** `resetSky3D()` snapshots the scene's lighting the first time a preset is applied and restores exactly that, so it works on both a bare character scene and the city (which loads its own lighting). It also turns the sky-driven reflections back off.
- **Sun coupling.** Presets place the sun (low + warm for golden hour/sunset), which moves both the shadows and the bright spot in reflections together. If the host has its own sun/time-of-day control, calling `applyProceduralSkyIBL()` after moving the sun re-bakes reflections to match.
- **Cost.** The bake is CPU-side and **event-driven** (only on a sky/sun change), not per frame — a small one-time cost per apply, not an ongoing frame tax.
