# Creator Suite — Frogmarks host integration

How to build the **"apps in one app"** front-end over the Salsa engine: the Shell launcher, the in-editor app
switcher, the one schema-driven creator panel, and the shared Library panel. Engine spec:
[../specs/creator-suite.md](../specs/creator-suite.md). Asset spine: [shared-asset-library.md](./shared-asset-library.md).
All APIs on `ShapeManager` (`sm`).

**Engine status (2026-09-18):** the whole engine side is built and green — the creator registry + generic
create/live-edit lifecycle, the shared asset library (OPFS), reference/embed provenance, and **five asset providers**
(`anim-clip`, `pose`, `preset`, `character`, `material`). What's left is **all host-side**: the Shell launch path (its
`launchSlot` is still a stub), the switcher, and the panels. This doc is the contract for those.

## 1. Mental model — two layers, apps are modes over shared state

An "app" is not a separate program; it's a **creator mode** over the one shared engine, document, and asset library.
So switching apps = entering/exiting a mode within a session (cheap, flow-preserving), not a program launch. Build two
navigation layers:

- **Shell = the front door** (used at session start): pick a project/Illustration to open, or launch a creator
  standalone. See [shell-ui.md](./shell-ui.md).
- **In-editor app switcher = the everyday driver**: a workspace tab-bar and/or a `Ctrl-K` command palette that enters
  any creator on the fly, authors, saves to the library, and returns — **no Shell round-trip**.

Model it like **Blender workspaces / Affinity Personas**, not Adobe's separate apps. Entering a creator mid-edit is
**non-destructive** (it never mutates the open document — it creates/edits its own object or preview); show a
breadcrumb (`Illustration › Foliage`); a command palette scales past a crowded tab-bar.

## 2. Shell launch (the one real engine+host gap)

`shell-ui.md`'s `launchSlot()` is a Phase-6 stub — it must actually **boot an app** (route/mode switch). Slots:
- **`system` slots** for each creator/app (Illustrator, Characters, Animations, Materials, and each procedural
  creator) — launching one enters that mode in the editor.
- **project slots** (`.frogmarks`) open a document (already modeled in shell-ui.md).

For the suite, a "launch a creator" system slot resolves to "open the editor + enter that creator mode" (§3/§4). The
Shell is used occasionally; most switching happens in-editor.

## 3. The in-editor app switcher

Drive it entirely from the registry — no per-app code:

```ts
const apps = sm.creatorTypes3D();   // [{ typeId, label }] — the 10 procedural creators (foliage, vending, bollard, …)
// Plus the "big" creators wired separately: Characters, Animations, Materials, Illustrations (the composer).
```

- **Tab-bar / palette entry per app.** Selecting a procedural creator app = create (or focus) an object of that type:
  ```ts
  const { id } = sm.createCreator3D(typeId) ?? {};     // defaults filled from the schema; auto-frames
  // then show the schema-driven panel (§4) bound to `id`
  ```
- **Breadcrumb**: `Illustration › <app label>`; exiting returns to the document (the created object stays in the scene
  — the shipped model is *create-in-place + live-edit*, not a throwaway preview).
- **Command palette** (`Ctrl-K`): fuzzy-match `apps` labels → same `createCreator3D` path. Scales to any number of apps.

The big creators use their own entry (they aren't in `creatorTypes3D`): **Characters** →
`sm.createProceduralBody3D(params, x, y, z)`; **Animations/Illustrations** are existing editor surfaces. Wire those as
first-class switcher entries alongside the registry ones.

## 4. The one schema-driven creator panel (serves EVERY creator)

There is no per-creator panel. ONE component reads a creator's schema and renders controls:

```ts
const schema = sm.creatorParamSchema3D(typeId);   // EphemeraParamSchema[]
const params = sm.getCreatorParams3D(objectId) ?? sm.creatorDefaults3D(typeId);
```

Each field: `{ key, label, type, default, min?, max?, step?, options?, group? }`. Render by `type`:

| `type` | Control |
| --- | --- |
| `range` / `number` | slider (+ numeric); use `min`/`max`/`step` |
| `select` | dropdown from `options: [{ value, label }]` |
| `toggle` | checkbox |
| `color` | color swatch (`'#rrggbb'`) |
| `seed` | seed field + a 🎲 randomize button |
| `text` | text input |

Group controls by `field.group` (collapsible sections). On any change, **live-edit in place** (debounced ~16ms):

```ts
sm.setCreatorParams3D(objectId, { [key]: value });   // merges, re-resolves (clamps), regenerates the same node
```

Helpers: `sm.creatorTypeOf3D(id)` / `sm.isCreator3D(id)` (is this selected node an editable creator? → show this
panel), `sm.frameCreator3D(id)`, `sm.removeCreator3D(id)`.

## 5. The shared Library panel (kind-generic — one panel, every provider)

Build ONE panel over `sm.assets.*` (full API in [shared-asset-library.md](./shared-asset-library.md)); filter by
`kind` per context. It shows all five providers automatically and any future ones with no new code.

```ts
await sm.assets.init();                                  // once, before listing
const rows = sm.assets.list({ kind: 'anim-clip', tags, query });   // envelopes + meta, newest first
```

**Save to Library** (per app, use the typed sugar — no need to hand-build payloads):

| App | Promote call |
| --- | --- |
| Animations | `sm.promoteClipToGlobal3D(clipId, {name,tags})` · `sm.promotePoseToGlobal3D(skelId, poseId, …)` |
| Procedural creators | `sm.promoteCreatorToLibrary3D(nodeId, …)` (from a scene object) · `sm.savePresetToLibrary3D(typeId, params, …)` |
| Characters | `sm.promoteCharacterToLibrary3D(bodyMeshId?, …)` |
| Materials | `sm.saveMaterialToLibrary3D(surface, params?, …)` |

**Use / Apply** (`sm.assets.instantiate(id, target)`), where `target` depends on the kind — the panel picks it from context:

| Kind | `target` | Result |
| --- | --- | --- |
| `anim-clip` / `pose` | `{ skeletonId }` | retargets onto that rig → new clip/pose id |
| `preset` / `character` | `{ transform?: {x,y,z,…} }` | creates the object in the scene → new node id (character is **async**) |
| `material` | `{ meshId }` | applies the recipe to that mesh → the mesh id |

**Cards:** name, kind icon, `meta` chips (per kind — anim: rigType/duration; material: surface; preset: creatorType),
tags. **Previews:** animation cards use the turntable capture (instantiate onto a stand-in skeleton →
`sm.captureAnimationPreview3D(...)` → loop the frames); other kinds can show a static capture or a meta swatch.

**Linked assets** (provenance): `await sm.assetDocumentReferences3D()` →
`[{ docLocalId, globalId, name, kind, source, updateAvailable }]`. Badge "N linked · M updates"; a row with
`updateAvailable` offers re-instantiate from the newer version. `source:'dangling'` = the global asset was deleted
(the instantiated object still works).

## 6. Wiring map (UI element → engine call)

| UI | Call |
| --- | --- |
| App switcher list | `sm.creatorTypes3D()` (+ Characters/Animations/Illustrations wired manually) |
| Launch a procedural creator | `sm.createCreator3D(typeId)` → then the schema panel on the returned id |
| Creator panel controls | `sm.creatorParamSchema3D(typeId)` + `sm.setCreatorParams3D(id, patch)` |
| "Is the selected node editable here?" | `sm.creatorTypeOf3D(id)` / `sm.isCreator3D(id)` |
| Library list / filters | `sm.assets.init()` + `sm.assets.list({kind,tags,query})` |
| Save to Library | the per-app promote sugar (§5) |
| Use / Apply | `sm.assets.instantiate(id, target)` (target per §5) |
| Linked-assets badge | `sm.assetDocumentReferences3D()` |
| Shell launch | `shell-ui.md` `launchSlot` (needs building) |

## 7. Build order (host-side, mirrors the engine waves)

1. **Shared Library panel** over `sm.assets.*` (kind-generic) — makes the five existing providers usable; highest value.
2. **Schema-driven creator panel** over `creatorParamSchema3D` + `setCreatorParams3D` — one panel unlocks all 10
   procedural creators at once.
3. **In-editor switcher** (tab-bar / `Ctrl-K`) over `creatorTypes3D` + the create calls.
4. **Shell launch path** (`launchSlot`) — the front door; can trail the in-editor switcher.
5. Fold **Characters / Animations / Materials** into the switcher as first-class entries (their entry calls differ from
   the registry ones — §3/§5).

## 8. What's engine-ready vs. host-pending

- **Ready (call it today):** the registry + `createCreator3D`/`setCreatorParams3D`, all 5 asset providers + promote
  sugar, `sm.assets.*`, `assetDocumentReferences3D`, `captureAnimationPreview3D`.
- **Host-pending (this doc):** the Library panel, the schema-driven creator panel, the switcher, and the Shell
  `launchSlot` boot path. Nothing here needs new engine work to start.
