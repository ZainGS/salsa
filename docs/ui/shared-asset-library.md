# Shared Asset Library — Frogmarks host integration

The **account-global** library: an asset authored in any creator (Animator, Character Creator, …) is reusable in
**every Illustration**. This is Salsa's equivalent of Creative Cloud Libraries — the spine of the "apps in one app"
suite. Engine spec: [../specs/shared-asset-library.md](../specs/shared-asset-library.md). All APIs on `ShapeManager`
(`sm`), under the **`sm.assets`** sub-namespace.

**Status (2026-09-17):** engine L1 (store + provider registry) + L2 (OPFS backend + the first provider,
`anim-clip`/`pose`) are **built**; the promote convenience is built. The reference/embed *logic* is built + unit-tested;
its `.frogmarks` persistence wiring is **pending** (see §6). The OPFS + apply paths run in the browser (not the unit
harness) — this is the surface to build the panel against and verify live.

## The model in one line

Three tiers: the **global** library (OPFS, cross-document) ← creators promote here; a document **references + embeds**
the assets it uses (so it stays portable); the existing per-document libraries are the live tier. "Reference globally,
embed on use."

## API — `sm.assets.*`

> **Async + init:** the store is OPFS-backed, so the mutating/reading methods are `async`. `list()` is **synchronous**
> and reads an in-memory index — call **`await sm.assets.init()` once** (e.g. when the Library panel first opens)
> before listing. The other methods self-initialize, so `promote`/`get`/`instantiate` are safe to call anytime.

| Method | Use |
| --- | --- |
| `await sm.assets.init()` | Load the index from OPFS. Call once before `list()`. Idempotent. |
| `sm.assets.list({ kind?, tags?, query? }) → AssetIndexEntry[]` | **Sync.** The panel's data source — envelopes + `meta` only (no payload unpack), newest first. `tags` is AND; `query` matches name+tags. |
| `await sm.assets.get(id) → AssetRecord \| null` | Full record incl. payload (rarely needed in the UI — `list` + `meta` usually suffice). |
| `await sm.assets.promote(kind, payload, { name, tags?, createdBy? }) → AssetRecord` | Low-level: add a payload to the library. For animation, prefer the sugar below. |
| `await sm.assets.instantiate(id, target) → docLocalId \| null` | **Apply** a global asset into the open document via its provider. For anim: `target = { skeletonId }` → retargets onto that skeleton, returns the new clip/pose id. |
| `await sm.assets.thumbnail(id) → Blob \| null` | Provider preview blob (anim omits it — see Previews below). |
| `await sm.assets.rename(id, name)` / `sm.assets.retag(id, tags)` / `sm.assets.remove(id)` | Bookkeeping (all async, all persist). |
| `await sm.assets.export({ kind?, tags? }) → AssetBundle` | A shareable subset (serialize to a `.frogpack` file for download). |
| `await sm.assets.import(bundle, { merge? }) → AssetRecord[]` | Import. **Ids are always re-minted** (no cross-account collision). `merge:false` clears first. ⚠ untrusted — see §7 of the spec before enabling for the `effect` kind. |
| `await sm.assets.resolveReference(ref, embedded?) → ResolvedReference` | Load-time resolution (persistence layer; see §6). |

### Promote animation to the global library (the convenience)

```ts
// In the Animator, "Save to Library (global)" on a clip row:
const rec = await sm.promoteClipToGlobal3D(clipId, { name: 'Walk', tags: ['locomotion', 'humanoid'] });
// poses:
const poseRec = await sm.promotePoseToGlobal3D(skeletonId, poseId, { name: 'T-Pose', tags: ['humanoid'] });
// rec.id is the global asset id — store nothing else; the library owns it.
```

These build the entry and promote it in one call, **without** staging it in the per-document animation library.
(The per-document `sm.addClipToLibrary3D` still exists for doc-local reuse — the global one is the cross-Illustration store.)

### Reuse a global asset in the current Illustration

```ts
await sm.assets.init();
const clips = sm.assets.list({ kind: 'anim-clip', tags: ['locomotion'] });
// User picks one and drops it on a character:
const newClipId = await sm.assets.instantiate(clips[0].id, { skeletonId: selectedSkeletonId });
// newClipId is a normal clip on that skeleton now — play it, add it to a locomotion set, etc.
```

`instantiate` retargets by joint name (like `applyLibraryEntry3D`), so a clip authored on one character lands on any
other — losslessly on a shared rig, partially otherwise.

## `AssetIndexEntry` shape (what the panel renders)

```ts
{
  id: string; kind: 'anim-clip' | 'pose' | 'material' | 'brush' | …;
  name: string; tags: string[]; version: number;
  createdAt: number; updatedAt: number; createdBy?: string;
  thumbnailAssetId?: string;
  meta: Record<string, unknown>;   // per-kind card fields — for anim: { animKind, rigType, sourceRig, jointCount, durationFrames }
}
```

Use `meta.rigType` for a filter chip and `meta.jointCount` / `meta.durationFrames` for card detail — no payload fetch needed.

## Previews (animated thumbnails)

The anim provider does **not** self-render a thumbnail (a preview needs a live target skeleton). Capture it in the UI
with the two-step flow from [animation-library.md](./animation-library.md): `instantiate` the asset onto a stand-in
character, then `sm.captureAnimationPreview3D(skeletonId, clipId, { frames, size })` → PNG-data-URL frames to loop in
the card. Cache the frames as the card's thumbnail; do it lazily (on scroll/hover), not for the whole library at once.

## Suggested UI

- **One shared "Library" panel component**, reachable from every creator and the shell, filtered by `kind` per context
  (the Animator shows `anim-clip`/`pose`; a future Material creator shows `material`; the shell shows everything). This
  single reusable panel *is* the visible payoff of the suite.
- **Cards:** name, kind icon, `meta` chips (rigType, duration), tags, and a lazy animated preview.
- **Actions:** per card — **Use / Apply to selected** (`instantiate`), Rename, Retag, Delete. Per creator — **Save to
  Library** (`promoteClipToGlobal3D` etc.). Panel-level — **Export** (`.frogpack` download) / **Import**.
- **Filters:** by `kind` and tags; a search box → `list({ query })`.

## §6 — Reference tracking / "linked assets" (provenance is now persisted)

When you `instantiate` a global asset, the document now **records a provenance link** (`{docLocalId, globalId,
version, kind, name}`) and persists it with the document (in the 3D scene settings, cleared+reloaded on load). Surface
this as a **"Linked assets" panel**:

```ts
const refs = await sm.assetDocumentReferences3D();
// → [{ docLocalId, globalId, name, kind, source: 'global'|'embedded'|'dangling', updateAvailable: boolean }]
// Badge: "3 linked assets · 1 update available". Row action when updateAvailable → (re-instantiate from the newer
// global asset; an engine "accept update" verb is a follow-up — for now re-instantiate the asset id + swap).
```

`updateAvailable` is true when the global library has a newer version than the document referenced; `source:'dangling'`
means the global asset was deleted (the instantiated object still works — it's a normal clip in the doc — it just no
longer tracks a source). Note the instantiated object (e.g. the clip) also saves normally as part of the document, so
everything is portable regardless; the provenance is purely for the update/linked-assets UX.

**Still TODO engine-side:** embedded copies for future by-reference (non-baked) kinds, and a one-call "accept update"
verb. For animation (which fully instantiates), the provenance above is the complete story.

## Procedural creator presets (`preset` kind — built)

Beyond animation, a **`preset`** provider bridges the procedural-creator framework (Foliage, Vending, Bollard, Lamp
Post, … — `sm.creatorTypes3D()`) to the library. A preset asset is `{ typeId, params }`:
```ts
// Save a configured creator (an existing scene object, or raw typeId+params) to the global library:
await sm.promoteCreatorToLibrary3D(nodeId, { name: 'Tall Oak', tags: ['tree'] });   // reads the object's live params
await sm.savePresetToLibrary3D('foliage', params, { name: 'Palm', tags: ['tree'] }); // or from typeId + params
// Reuse in any Illustration — instantiate re-creates the object in the scene:
const nodeId = await sm.assets.instantiate(presetAssetId, { transform: { x: 2, z: -1 } });
```
So a tuned tree/lamp/bollard authored once is reusable everywhere — the same author-once flow as animations.

## Full characters (`character` kind — built)

A whole character (body + hair + clothing + render style) promotes as one asset:
```ts
await sm.promoteCharacterToLibrary3D(bodyMeshId, { name: 'Ranger', tags: ['npc'] });   // exports the preset → library
const newBodyId = await sm.assets.instantiate(characterAssetId, { transform: { x: 3 } }); // regenerates the rigged character
```
Instantiate is **async** here (it regenerates a rigged body), so `await` it.

## Materials (`material` kind — built)

A saved surface-material recipe (a `sm.surfaceMaterials3D()` name + optional overrides like tint/tileMm/weather):
```ts
await sm.saveMaterialToLibrary3D('brick', { tint: [0.7, 0.3, 0.25], weather: 'worn' }, { name: 'Red Brick' });
// Apply to a mesh (materials modify an EXISTING object, so the target is a meshId, not a transform):
await sm.assets.instantiate(materialAssetId, { meshId: selectedMeshId });   // returns the affected meshId
```
Note the different `target` shape — `{ meshId }` (apply-to-existing) vs `{ transform }` (preset/character create a node)
vs `{ skeletonId }` (animation). The panel picks the target from context.

**Live provider kinds:** `anim-clip`, `pose`, `preset`, `character`, `material`.

## Not yet available

- Providers beyond animation + presets (material, kitbash parts, brushes, textures) — coming; the panel should be
  `kind`-generic so they appear automatically.
- The reference/embed persistence wiring (above).
- Cloud/account sync (v1 is OPFS-local — assets live in this browser profile until sync ships).
