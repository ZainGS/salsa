# Shared Asset Library — the account-global asset spine

**Date:** 2026-09-17 · **Status (audited 2026-10-01): L1–L3 BUILT, L4 partial, L5–L6 not built** — see §8. Code: `src/services/assets/`, `sm.assets` (shape-manager).
**Origin:** the product vision is a *suite of creators in one app* (Illustrator · Character Creator · Animator · Effects
Creator …) surfaced from the Shell, where **an asset authored once in any creator is reusable in every Illustration**.
That only works if assets live **above** the document — at the account/app level — and documents *reference* them.
Today every library is **document-scoped** (the Animation Library lives inside one `.frogmarks`; pose / material /
kitbash libraries the same), so each Illustration is a silo and there is no cross-project reuse. This spec defines the
missing layer: **one account-global asset store that every creator writes into and every Illustration reads from**,
with a reference-and-embed model so documents stay self-contained and portable. It is the linchpin of the "apps in one
app" architecture — the equivalent of **Creative Cloud Libraries** for Salsa.

## 0. The core idea in one paragraph

There are **three tiers** for any asset (a clip, a pose, a material, a character part, a brush, an effect):

1. **Global (account) library** — the durable, cross-document home in OPFS. The Animator saves a walk here once.
2. **Document reference + embedded copy** — an Illustration that *uses* the walk stores a **reference** (`globalId` +
   `version`) AND, on save, an **embedded copy** of the payload inside its `.frogmarks`. The document is thus
   self-contained and portable (opens on another machine with no library), yet still knows it came from a global asset
   (so it can offer "update to the newer version").
3. **Live in-memory per-domain store** — the existing runtime library the engine already keeps for the open document
   (`AnimationLibrary`, pose library, …). Unchanged; it becomes the *document tier*, fed from tiers 1 and 2.

**Reference globally, embed on use** — the sparse-override principle already stated in `creator-modes.md` §6 Phase B,
generalized to all asset kinds. This is deliberately the Creative Cloud Libraries model, not a "link that breaks."

## 1. What already exists to build on (DON'T rebuild)

| Piece | Where | Role |
| --- | --- | --- |
| OPFS storage w/ a JSON registry + per-item blobs, mirroring `DocumentPersistence` conventions | `services/persistence/shell-storage.ts` (`ShellStorage`, `/shell/`+`/carts/`+`/projects/`) | The storage engine to EXTEND with a `/library/` tree — zero renderer/UI coupling already |
| Per-domain libraries with a uniform `serialize()` / `load()` / `clearForDocumentLoad()` shape | `AnimationLibrary` (animation-library.ts), pose library, procedural-material-library, kitbash parts, `TextureLibrary`, brush presets | Become the **document tier** + the per-kind **payload** producers/consumers |
| `.frogmarks` / `.frogcart` package writers (embed blobs, gzip) | `services/persistence/project-package.ts`, `frogcart.ts` | The embed-on-save mechanism; asset payloads ride along like decal/model blobs do today |
| The serialize + `clearForDocumentLoad` orchestration (stale-registry rule) | `services/persistence/document-state-coordinator.ts` | Where per-doc library clear+load already happens; the reference-resolve step slots in here |
| Retarget/apply primitives per domain (e.g. `applyLibraryEntry3D`, brush-preset apply) | domain managers | The **instantiate** half of each adapter — already written |

The store is **not** a new engine — it is a thin, domain-agnostic index + OPFS layer over payloads the domains already
know how to serialize and apply.

## 2. Model

### 2.1 The asset envelope (domain-agnostic)

The global store never understands animation or material internals. It wraps every asset in a common envelope and
delegates the domain-specific body to an adapter:

```ts
type AssetKind = 'anim-clip' | 'pose' | 'material' | 'character-part' | 'brush' | 'effect' | 'texture' | string;

interface AssetRecord<P = unknown> {
  id: string;              // account-stable id (NOT a document node id)
  kind: AssetKind;
  name: string;
  tags: string[];
  version: number;         // bumped on each overwrite-save of the same id
  createdAt: number; updatedAt: number;
  createdBy?: string;      // user id/email, for shared libraries
  thumbnailAssetId?: string; // → a blob in the same store (e.g. the turntable strip frame 0)
  meta: Record<string, unknown>; // domain filter fields surfaced for the panel WITHOUT unpacking the payload
                                  //   (anim-clip: { rigType, jointManifest, durationFrames }; material: { previewColor }…)
  payload: P;              // the domain body — the EXISTING per-domain entry shape, verbatim
}
```

`payload` for `kind:'anim-clip'` is exactly today's `AnimLibraryEntry`; for a material it's the material-library
entry; etc. **No domain type changes** — they become payloads. `meta` is the small, indexable projection the panel
filters/sorts on so listing a 500-asset library never unpacks a payload.

### 2.2 Asset providers (the extension point)

Each domain registers a provider so the store stays open-ended (the Effects Creator plugs in later with zero store
changes):

```ts
interface AssetProvider<P = unknown> {
  kind: AssetKind;
  meta(payload: P): Record<string, unknown>;                 // build the indexable projection
  instantiate(payload: P, target: InstantiateTarget): string | null; // apply into the open doc → new doc-local id
  thumbnail?(payload: P): Promise<Blob | null>;              // optional capture (anim → captureAnimationPreview3D)
  // serialize is trivial: the domain already produces the payload; promote() just wraps it in an envelope.
}
```

`instantiate` is the ONLY hard part and it already exists per domain (`applyLibraryEntry3D` retargets a clip onto a
skeleton; a material provider assigns to a mesh; a brush provider registers the preset). The store calls the provider;
it never touches engine internals.

### 2.3 Scope resolution — reference & embed

- **Promote** (creator → global): `promoteToLibrary(kind, docLocalId | payload, {name,tags}) → AssetRecord`. Writes the
  envelope + payload blob to OPFS, adds the index row. Ids **re-minted** on promote (never a doc node id).
- **Use in a document**: the document stores a **reference** `{ globalId, version }` in its per-domain live store
  (tier 3) AND, on the next save, an **embedded copy** of the payload inside the `.frogmarks` (tier 2). A document that
  never references the global library saves exactly as it does today (empty global refs).
- **Open a document**: for each reference, resolve in this order — (a) if the global library has that `globalId`, use
  it and, when `library.version > embedded.version`, flag an **"update available"** (don't auto-apply — user's call,
  like a linked-asset update); (b) else fall back to the **embedded copy** (portability: another machine with no
  library still opens correctly); (c) else the reference is dangling — surface it, keep the embedded copy if any.
- **Ids never collide across accounts**: importing a shared library (or a `.frogcart` carrying assets) **re-mints** all
  ids, exactly as `importAnimationLibrary3D` already does — the same rule, lifted to the envelope.

### 2.4 What is global vs what stays per-document

- **Global**: the *definitions* — a clip, a pose, a material recipe, a character part, a brush, an effect graph.
- **Per-document (unchanged)**: *instances and their state* — where the character stands, which material is on which
  mesh, the scene graph, keyframes authored in THIS doc. The global library holds reusable building blocks, never the
  scene assembly. (Mirrors Unity: the Project asset database vs. the Scene.)

## 3. Storage (OPFS — extend ShellStorage)

Siblings of the existing `/shell` + `/projects` trees, same read/write conventions:

```
/library/
  index.json              — AssetIndex: AssetRecord MINUS payload (envelope + meta + payloadPath), for instant listing
  assets/{id}.json        — the payload (small kinds: clip tracks, pose, material recipe, brush)
  blobs/{assetId}.bin     — large binary payloads (baked part meshes, textures) + thumbnails, gzipped like models3d
```

- `AssetIndex` is the panel's data source — envelopes + `meta` only, so opening the Library never unpacks payloads.
- Large payloads (kitbash baked meshes, textures) go to `blobs/` and are referenced by path — the index stays small.
- Reuse `ShellStorage`'s OPFS helpers (they already mirror `DocumentPersistence`); this is a third index alongside
  `registry.json`/`projects.json`, not a new persistence stack.
- **Quota**: OPFS is finite. The library needs an LRU/size report + a "manage storage" affordance (the shell already
  tracks project sizes) — payloads with baked geometry are the heavy ones (see `project_perf_persistence` for the
  strip-baked-geometry + gzip rule; reuse it).

## 4. Facade API (`sm.assets.*`)

A single sub-namespace (like `sm.raster` / `sm.scene3d` / `sm.shell`):

```ts
sm.assets.promote(kind, source, { name, tags? }) → Promise<AssetRecord>   // creator → global (source = doc-local id or payload)
sm.assets.list({ kind?, tags?, query? }) → AssetRecord[]                  // envelope+meta only (from index.json)
sm.assets.get(id) → Promise<AssetRecord | null>                          // unpack payload
sm.assets.instantiate(id, target) → string | null                        // apply into the open doc via the provider → doc-local id + a reference
sm.assets.rename(id, name) / sm.assets.remove(id) / sm.assets.retag(id, tags)
sm.assets.thumbnail(id) → Promise<string | null>                         // data URL; captured lazily + cached (anim → turntable strip frame)
sm.assets.export({ kind?, ids? }) → Blob                                 // a .frogpack (shareable library subset)
sm.assets.import(blob, { merge? }) → AssetRecord[]                        // re-mints ids; untrusted (see §7)
sm.assets.registerProvider(provider)                                     // engine-internal; domains self-register at init
sm.assets.documentReferences() → { globalId, version, updateAvailable }[] // for an "update linked assets" panel
```

Domain facades keep their current verbs; **promote/instantiate are thin wrappers** that call `sm.assets.*` with the
domain's provider. E.g. `addClipToLibrary3D` becomes "promote an `anim-clip` to the *document* library" (today's
behavior) plus an optional `{ global: true }` to promote to the account store — one flag, no new mental model.

## 5. How the existing libraries fold in

Each becomes a provider; **no payload rewrite**:

| Kind | Payload (unchanged) | `instantiate` (exists) |
| --- | --- | --- |
| `anim-clip` / `pose` | `AnimLibraryEntry` | `applyLibraryEntry3D(entry, skeletonId)` |
| `material` | procedural-material-library entry | assign material to mesh (`setMeshMaterial`) |
| `character-part` | kitbash part record | kitbash slot-swap apply |
| `brush` | brush-preset JSON | register preset |
| `texture` | `TextureEntry` | bind to a texture slot |
| `effect` (future) | UI-machine / script fragment | merge into the doc's UI machine / script behaviors |

The current **document-scoped** libraries stay as tier 3 (the live store for the open doc). The only new wiring per
domain is: register the provider, and let promote/instantiate optionally target the global store.

## 6. Host UI (Frogmarks — future `docs/ui/shared-asset-library.md`)

- **One shared "Library" surface** reachable from every creator and the shell — a single panel component, filtered by
  `kind` per context (the Animator shows `anim-clip`/`pose`; the Material creator shows `material`; the shell shows
  all). This is the visible payoff of "apps in one app": the same assets, everywhere.
- **Cards** use `meta` for chips (rigType, duration, swatch) and `sm.assets.thumbnail(id)` for the preview (animated
  turntable for clips — the capture already exists). Lazy + cached.
- **Promote** action in each creator ("Save to Library"); **Use/Apply** from the panel (calls `instantiate`).
- **"Linked assets" indicator** on a document: `documentReferences()` drives an "N assets, M updates available" badge
  and an Update action (per the reference-and-embed model).
- **Manage storage**: size report + remove, reusing the shell's storage affordance.

## 7. Security — shared/imported assets are untrusted

- Assets that **originate in this account** are trusted. Assets arriving via `import` or inside a downloaded
  `.frogcart` are **untrusted** and re-minted.
- Most kinds are inert data (clips, materials, textures) — safe. The exception is the **`effect` kind** if it carries a
  **script behavior**: that is executable and MUST obey the staged-sandbox rule from `script-behaviors.md` §3 —
  imported scripts stay **disabled-by-default until the QuickJS/Worker sandbox exists**. The asset library is exactly
  the distribution channel that makes that sandbox necessary, so gate on it here.
- No asset kind may embed a raw file path or URL that the engine auto-fetches (avoid an SSRF/exfil vector); payloads
  are self-contained blobs.

## 8. Build order

1. ✅ **L1 — envelope + store + provider registry (unit) — BUILT 2026-09-17.** `src/services/assets/`: `asset-types.ts`
   (`AssetRecord`/`AssetIndexEntry`/`AssetProvider`/`AssetStorageBackend`/`AssetBundle`), `asset-library.ts`
   (`AssetLibrary`: list/get/promote/instantiate/thumbnail/rename/retag/remove/export/import; ids minted + re-minted on
   import; async methods self-init), `asset-store-memory.ts` (`MemoryAssetBackend`). 7 unit tests incl. provider dispatch.
2. ✅ **L2 — OPFS backend + first provider (`anim-clip`/`pose`) + facade — BUILT 2026-09-17 (browser-verify pending).**
   `asset-store-opfs.ts` (`OpfsAssetBackend`, `/library/index.json`+`assets/{id}.json`, write-mutex, ShellStorage
   conventions); `AnimationLibrary.applyEntry(entry, skel)` + `scene3d.applyLibraryEntryObject3D`; `sm.assets` getter
   registers the anim providers (instantiate = retarget onto `{skeletonId}`; thumbnail deferred to the host's
   captureAnimationPreview3D). NOTE: OPFS + instantiate are GPU/browser paths — unit-tested via L1's mock; the live loop
   is browser-verified. Still TODO in L2: `promote` from a doc-local clip id (resolve id→payload) + a `drive-assets` harness.
3. **L3 — reference + embed:** ✅ **CORE + PROVENANCE PERSISTENCE BUILT 2026-09-17.** Pure `asset-references.ts`
   (`AssetReference`/`EmbeddedAsset`, `resolveReference` matrix [embedded-authoritative; global-newer flags an update,
   never auto-swaps; global-only fallback; dangling], `makeReference`/`makeEmbedded`/`acceptUpdate`; 8 tests). Document
   provenance: `asset-reference-store.ts` (`AssetReferenceStore`, keyed by docLocalId; 5 tests) persists in
   `GlobalScene3DSettings.assetReferences` (rides scene3dJSON like `animationLibrary`, clear-on-load) — wired via an
   `AssetLibrary.setInstantiateHook` that records `{docLocalId, globalId, version, kind, name}` on every instantiate;
   `sm.assetDocumentReferences3D()` resolves each against the live library for the "linked assets / update available"
   panel. NOTE: only the PROVENANCE reference persists today (the anim provider fully instantiates its clip into the
   document, so no embed needed). **TODO:** embed copies for by-reference (non-instantiated) kinds; an "accept update"
   action re-instantiating from the newer global record; promote provenance to document-level when 2D asset kinds land
   (today it rides the 3D scene settings).
4. **L4 — fold in the rest:** material, kitbash part, brush, texture providers (payloads already exist). **[~] 2026-10-01:** anim-clip, pose, creator-preset, character and material providers exist (`shape-manager.ts` `sm.assets`); kitbash part, brush and texture providers remain.
5. **L5 — sharing:** `.frogpack` export/import (re-mint), untrusted gating (§7), storage management UI.
6. **L6 — host docs + the unified Library panel** across creators (the "apps in one app" surfacing).
7. Later: cloud sync (OPFS → account backend), team/shared libraries, `effect` kind once the script sandbox lands.

## 9. Testing plan

- **Unit (pure/GPU-free):** envelope round-trip; index list/filter by kind+tag without unpacking; provider
  registry dispatch; **reference resolution** matrix (global-newer → update flag; global-missing → embedded fallback;
  both-missing → dangling) — this is the load-bearing logic and it's pure.
- **Persistence:** promote → new store → `list` sees it; document with a reference saves an embedded copy; reload with
  the global store present prefers global + flags update; reload with the store WIPED still opens via the embedded copy
  (portability); import re-mints ids (no collision with an existing same-id asset).
- **Harness:** `drive-assets.js` — promote a clip to the global library, open a *second* document, instantiate it onto
  a different character (cross-document reuse — the whole thesis), assert the clip plays.

## 10. Relationship to other systems & open questions

- **`creator-modes.md` §6 Phase B** ("preset library + persistence: shell/OPFS, global, cross-project") is the same
  layer scoped to creator presets — it becomes the `kind:'…-preset'` providers here rather than a parallel store.
- **`shell-ui.md`** stores whole *projects* (`.frogmarks`) and cart slots; this adds a sibling `/library/` for
  *reusable assets*. Same OPFS conventions, different index — do not conflate a project with an asset.
- **Params-as-source thesis holds:** an asset's payload is params/definition, not baked output (except where baking is
  the point, e.g. kitbash meshes — which already strip+gzip per `project_perf_persistence`).
- **Open:** (a) cloud/account sync is out of scope for v1 (OPFS-local first); (b) do materials reference textures as
  *nested* asset refs (a material asset pointing at a texture asset)? — allow it via `payload` carrying child
  `globalId`s, resolved recursively at instantiate; (c) versioning is linear (a counter) in v1 — no branching/history.
```
