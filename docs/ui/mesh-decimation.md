# Mesh Decimation — Frogmarks UI Integration Guide

**Audience:** Frogmarks (Angular host) developers building the mesh/modifier panels.
**Date:** 2026-08-22 · **Engine spec:** [../specs/mesh-decimation.md](../specs/mesh-decimation.md) · **Sibling:** [scene-authoring.md](./scene-authoring.md).

---

## 0. What this is

Procedurally-generated meshes (metaballs, creatures) and boolean-CSG results come out **very dense and uniform** — surface-nets gives one vertex per grid cell regardless of curvature, so a flat flank costs as many triangles as a detailed joint (~12k tris for a creature). That's fine visually but wasteful on **render perf, GPU memory, and save size**.

**Decimation** (QEM edge-collapse) reduces the triangle count while keeping the **same silhouette**, and it's **curvature-adaptive** — flat areas collapse hard, detailed areas keep their density. A creature drops ~12k → ~5k tris with no visible change. Everything below is a method on the `ShapeManager` instance (`sm`) Frogmarks already holds.

---

## 1. Two ways it surfaces

**(A) Lean-by-default on creation** — already automatic; no UI required. Creatures generate pre-decimated (`decimate: 0.4`). The UI only needs to *expose the knob* (§3).

**(B) On-demand "Decimate" on any mesh** — a panel action the user runs on a selected mesh (§2). Ideal for dense metaballs, boolean results, or heavy imports.

---

## 2. The "Decimate" panel action (on-demand)

Put this in the **Modifiers / Mesh-tools panel** (alongside Subdivision/Mirror/Displace), or as a right-click action on a selected mesh.

```ts
// ratio ∈ (0,1] = fraction of triangles to KEEP (0.3 = 30%). Returns true if it simplified anything.
const ok: boolean = sm.simplifyMesh3D(meshId, ratio);
```

**UI shape:**
- A **ratio slider** `0.1 … 1.0` (default `0.3`), label it as "**Keep**: 30%" or "**Reduce to**: 30%".
- A live **before → after triangle count** readout (see §4).
- An **Apply** button → `sm.simplifyMesh3D(selectedId, ratio)`. Optionally show a toast with the achieved reduction.
- Because collapse is fast (a creature decimates in a few ms), you *can* apply live on slider-release for a preview; but note it's **destructive** (each apply decimates the *current* mesh further) — prefer a single Apply, or re-read the tri count and disable Apply once it stops shrinking.

**Undo:** `simplifyMesh3D` is **undoable** — it snapshots the dense geometry onto the standard undo stack. Wire nothing special; the existing `sm.undo3D()` / Ctrl-Z restores the pre-decimation mesh. Redo re-applies.

**⚠ It drops UVs.** The collapse moves vertices, so carrying old UVs would smear a texture. After decimating a **textured** mesh, either:
- re-apply a procedural surface: `sm.applyGroundMaterial3D(id, { surface, … })` (see scene-authoring.md §3), or a flat colour via `sm.scene3d.setMaterial(id, { diffuse })`, or
- re-unwrap: `sm.autoUnwrap3D(id)` then re-paint.
- *(Creatures are exempt — they re-unwrap automatically inside generation, so their per-part atlas is intact. Only the generic `simplifyMesh3D` on an already-textured mesh needs a re-texture.)*

---

## 3. Creature panel — the `decimate` slider

The Creature Creator already builds from `createCreature3D(params, …)`. Add one control:

- A **"Detail / Decimate" slider** `0.15 … 1.0`, default **`0.4`**, wired into the creature params:
  ```ts
  sm.createCreature3D({ species, /* …other params…, */ decimate }, x, y, z, resolution);
  ```
  Lower = leaner (fewer triangles), `1` = full density. Changing it **rebuilds** the creature (same as any other creature param).
- Same for the **Metaball editor**: `sm.createMetaballMesh3D(x, y, z, blobs, resolution, material, decimate)` — an optional slider (default off / full density; suggest `0.4` for heavy blobs).

Persistence is automatic (params-only) — `decimate` is saved in the mesh config and regenerates on load. No save/load work needed.

---

## 4. Reading triangle / vertex counts (for the before→after readout)

```ts
const geom = sm.getMesh3D(meshId)?.geometry;
const triCount  = geom ? geom.indices.length / 3 : 0;
const vertCount = sm.getMesh3D(meshId)?.vertexCount ?? 0;   // = geometry.vertices.length / 12
```
Read the count before `simplifyMesh3D`, apply, then read again to show "12,404 → 4,970 tris (−60%)".

---

## 5. Gotchas / notes

- **Ratio is "keep", not "remove."** `0.3` keeps 30% of triangles. Label accordingly so users aren't surprised.
- **Repeated Apply compounds.** Each call decimates the current mesh; two 0.5 applies ≈ 0.25. Show the live count so it's obvious, or gate Apply.
- **Destructive but undoable.** A params primitive (metaball) becomes a baked `custom` mesh after `simplifyMesh3D` — same as any destructive mesh edit. Undo restores it exactly.
- **Curvature-adaptive by design.** Don't be alarmed that some regions stay dense — that's the point (detail is preserved where curvature is high).
- **Rigged creatures** decimate *before* binding, so their skin/skeleton are built on the lean mesh — nothing extra to do in the UI.

---

## 6. Minimal wiring checklist

1. Modifiers panel: **Decimate** slider (keep-ratio) + tri-count readout + **Apply** → `sm.simplifyMesh3D(id, ratio)`.
2. Creature/Metaball panels: a **`decimate`** slider passed into `createCreature3D` / `createMetaballMesh3D`.
3. After decimating a *textured generic* mesh, prompt/auto re-apply a material (creatures exempt).
4. Undo/Redo: already handled by the global undo stack — no per-action work.
