# Vending Creator — Frogmarks UI Integration

Host-facing contract for the **Vending Creator** (Add / Edit a standalone vending machine), following the
[Foliage Creator](foliage-creator.md) / [Building Creator](building-creator.md) pattern: **Salsa owns the
generator + scene lifecycle + persistence; Frogmarks owns the panels/buttons.** Spec:
[../specs/creator-modes.md](../specs/creator-modes.md) §5 · [../specs/city-props-garp.md](../specs/city-props-garp.md).

> **★ Vending is the reference creator for a GENERIC system.** You do NOT hand-write a vending panel, and you
> do NOT need vending-specific methods. There is ONE schema-driven panel and ONE `typeId`-dispatched API that
> serves every registered creator. Registered today: **`vending` · `foliage` · `bike-rack` · `bollard`**
> (call `creatorTypes3D()` for the live list — new ones appear automatically). This doc uses vending as the
> worked example; the same calls with any other `typeId` drive that creator. See **§ The generic API** and
> **§ Schema-driven panel** below. (Typed convenience aliases like `createVending3D` also exist, but you
> rarely need them.)

## The generic API (drive ANY creator by typeId)
```ts
sm.creatorTypes3D()                       // [{ typeId:'vending', label:'Vending Machine' }, { typeId:'foliage', … }]
const id = sm.createCreator3D('vending').id;          // spawn (defaults filled from the schema); auto-frames
sm.creatorParamSchema3D('vending')        // → render the panel (see below)
sm.setCreatorParams3D(id, { productCols: 3 })         // any control change
sm.creatorTypeOf3D(id)                    // 'vending' | 'foliage' | null  (also the selection gate)
sm.getCreatorParams3D(id) / removeCreator3D(id) / frameCreator3D(id)
```
Registering a new creator (a new generator + its `*Manager` + a schema entry) makes it appear in
`creatorTypes3D()` and work through these calls with **zero** new host code — that is the whole point.

## The flow (what the host builds)
Generic, works for any `typeId`:
1. **Add ▸ Vending Machine** (menu from `creatorTypes3D()`) → `createCreator3D('vending')` → a machine appears
   + a new outliner item; select it (returned `id`). Auto-frames the camera on it.
2. **Select** (outliner click / returned id). Gate the toolbar on `isCreator3D(selectedId)` (or
   `creatorTypeOf3D` to pick the right panel) → show **Edit**.
3. **Edit** → render the panel from `creatorParamSchema3D(typeId)`; every change calls
   `setCreatorParams3D(id, {changed})` → regenerates in place (same id, selection + placement kept).

Selection / gizmo / outliner are automatic (thin-wrapper container, moved/rotated/scaled as a unit; gizmo
moves persist into the save marker). Persistence is automatic — see § Persistence.

## Schema-driven panel (the generic mechanism)
The panel is data, not code:

```ts
const schema   = sm.creatorParamSchema3D('vending');   // CreatorParamSchema[]
const defaults = sm.creatorDefaults3D('vending');      // Record<string, unknown> — initial slider values
```

Render one control per schema field, grouped by `field.group`. `CreatorParamSchema` is the **same shape the
2D ephemera generators use** (`EphemeraParamSchema`), so if you already render those, reuse that component:

| Field | Meaning |
|---|---|
| `key` | the param name to send back in `setVendingParams3D(id, { [key]: value })` |
| `label` | control label |
| `type` | `'range'` (slider) · `'select'` (dropdown, uses `options`) · `'seed'` (number + 🎲) · (`'number'`/`'toggle'`/`'color'`/`'text'` for future creators) |
| `default` | initial value (already baked into `creatorDefaults3D`) |
| `min` / `max` / `step` | range bounds (present for `range`) — **these are the real generator bounds**, so a slider can't offer a value the generator would clamp away |
| `options` | `{ value, label }[]` for `select` (the brand list comes through here) |
| `group` | section header (`'Brand'` · `'Dimensions'` · `'Display'` · `'Seed'`) |

On any control change: `sm.setVendingParams3D(id, { [key]: value })`. That's the whole edit loop — no
per-param handlers, no vending-specific UI.

> Adding a new creator later (e.g. a lamp post) means registering its schema in `creator-registry.ts`; the
> same panel component renders it with zero new UI code. That is the point of the registry.

## API surface (on `ShapeManager`)
| Method | Purpose |
|---|---|
| `creatorTypes3D() → { typeId, label }[]` | List the registered creators (for an "Add ▸" menu). |
| `creatorParamSchema3D(typeId) → CreatorParamSchema[]` | The panel definition. Pass `'vending'`. |
| `creatorDefaults3D(typeId) → Record<string, unknown>` | Initial params for a new object. |
| `createVending3D(params?, transform?) → { id, meta }` | Add + place. Auto-frames. `params` = the schema values. |
| `setVendingParams3D(id, partial) → boolean` | Live-edit, regenerate in place. Merge-style. |
| `getVendingParams3D(id) → VendingParams \| null` | Re-seed the panel from an existing machine. |
| `isVending3D(id) → boolean` | Gate the "Edit" affordance on the selection. |
| `listVending3D() → { id, name, brand }[]` | Host outliner / picker. |
| `vendingBrandNames3D() → string[]` | Brand labels (also available via the schema's `brand` options). |
| `setVendingTransform3D(id, {x,y,z,rx,ry,rz}) → boolean` | Move/rotate (usually the gizmo does this for you). |
| `setVendingScale3D(id, unitsPerMetre) → boolean` | Display scale (e.g. `0.1` = 1 unit : 10 m). Regenerate-free. |
| `frameVending3D(id) → boolean` | Re-frame the camera on a machine. |
| `removeVending3D(id) → boolean` | Delete. |

## `VendingParams` (the panel model)
Resolved as **defaults ← explicit overrides**, clamped to the ranges the schema advertises. All dimensions
are **real metres** — a machine is sized like a real object, and the city places it at physically-correct
scale.

| Param | Type | Range | Meaning |
|---|---|---|---|
| `brand` | index | 0…(brands−1) | cabinet colour + lit-window tone (`vendingBrandNames3D()` for labels) |
| `heightM` | m | 0.6–2.6 | cabinet height |
| `widthM` | m | 0.4–1.4 | cabinet width |
| `depthM` | m | 0.3–1.0 | cabinet depth |
| `productCols` | int | 1–4 | product grid columns behind the glass |
| `productRows` | int | 1–4 | product grid rows |
| `glow` | × | 0–2 | lit-window emissive multiplier (1 = default) |
| `seed` | int | — | product-colour + jitter stream |

Defaults reproduce a standard jido-hanbaiki (0.84 × 1.8 × 0.6 m). `meta` from `createVending3D` is
`{ height, footprint }` (metres) for placement/overlap.

## Persistence
Automatic and params-only (a tiny `worldParams.kind: 'vending'` marker, like buildings/foliage). **No extra
host call is needed** on load beyond the shared `restoreProceduralFromSave3D()` you already call after a
document loads — it regenerates city + buildings + blocks + foliage + **vending** + packaging together. Gizmo
moves and scale changes are mirrored into the marker automatically.

## The focus STAGE (optional, recommended)
A creator object can be edited in place with the normal camera, OR put on a dedicated **focus stage** — the
Package-Creator experience: the rest of the scene is hidden, the object is squared to camera, the background
becomes a neutral studio gradient with clean lighting, and the camera frames + orbits it with a soft drift-in.

```ts
const { id } = sm.createCreator3D('vending')!;   // spawn
sm.enterCreatorStage3D(id);                       // isolate + studio bg + frame/orbit
// … user edits via the schema panel (setCreatorParams3D) …
sm.exitCreatorStage3D();                          // restore scene, bg, lighting, camera
```

| Method | Purpose |
|---|---|
| `enterCreatorStage3D(nodeId) → boolean` | Enter the focus stage on a creator object. Idempotent (exits a prior stage first). `false` if the id is unknown. |
| `exitCreatorStage3D()` | Leave the stage; restores isolation, rotation, background, lighting and camera exactly. |
| `creatorStageActive → boolean` · `creatorStageNodeId → string \| null` | Stage state (for toolbar gating). |

Recommended flow: **Add** → `createCreator3D(typeId)` then `enterCreatorStage3D(id)`; **Done/Close** →
`exitCreatorStage3D()`. Alt+drag orbits; the view gizmo is shown automatically. Everything the stage changes
is captured and restored on exit — entering/leaving is non-destructive. (The stage is built on the same scene
primitives as the Package Creator but on its own state; the two don't interfere.)

> **Not-yet on the stage:** surface *painting* inside the creator stage (the packaging stage arms paint; the
> creator stage doesn't yet — it's add/orbit/edit only). That arrives with the GARP/texture work.
- **No textures / GARP yet.** Product colours and fascia are solid for now; pooled texture *skins* (a Coke vs
  Pocari machine) are the GARP phase (city-props-garp.md §2) — the fascia and products are already the
  intended texture slots.
- **Dev harness:** `salsaVend.add({ brand: 1 })` / `salsaVend.set(id, { productCols: 3 })` / `salsaVend.list()`
  in the browser console, for trying it before the panel exists.
