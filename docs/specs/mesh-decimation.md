# Mesh Decimation (QEM) — lean topology for procedural / dense meshes (spec)

**Date:** 2026-08-22 · **Status:** building · **Companions:** `sdf-creature-generator.md`, `mesh-boolean-and-displacement.md`.

## Why

Surface-nets / marching-cubes output (metaballs, creatures) has **uniform topology** — one vertex per straddling grid cell, regardless of curvature. A flat flank costs as many triangles as a detailed joint (~12k tris for a res-56 creature). That's not a procedural-gen limitation; it's a *uniform-grid extraction* limitation. Cost is **render perf + memory + save size**, not appearance. Boolean-CSG results and some imports have the same problem.

The industry fix is **generate dense → decimate**: a QEM (quadric error metric) edge-collapse pass that reduces triangles while preserving the silhouette, and is **curvature-adaptive** — flat areas collapse hard, curved areas keep density. ~12k → ~2–3k tris with almost no visible change.

## Key design decision: decimate the CLOSED mesh, THEN unwrap/rig

The three "hard" problems the user asked about dissolve if we order operations right:

- **UV seams** — don't decimate a seamed/unwrapped mesh (would smear textures across seams). Instead decimate the **raw closed manifold** (positions only, no UVs), then run the existing per-blob atlas unwrap on the *simplified* mesh. No seam-aware collapse needed.
- **Rig** — decimate before `bindMeshToSkeleton`. The creature skeleton comes from the **blobs**, not the mesh topology, so it's unchanged; only skin weights recompute against the new verts.
- **Normals** — recompute from the SDF field gradient at the (new) vertex positions after decimation → clean smooth normals for free.

So the creature pipeline becomes: **sample field → surface nets → [decimate] → recompute normals → per-blob unwrap → [bind rig]**.

## Part A — the QEM core (`src/scene-graph/shapes/mesh-simplify.ts`, pure/testable)

`simplifyMesh(positions: V3[], tris: [i,i,i][], targetRatio): { positions, tris }`
- Garland–Heckbert QEM edge-collapse. `targetRatio` ∈ (0,1] = fraction of **triangles** to keep (0.25 = keep a quarter).
- Per-vertex quadric = Σ face-plane quadrics. Per-edge collapse cost = quadric error at the optimal contraction point (solve the 3×3; fall back to midpoint/endpoints if singular). Min-heap of edges; collapse cheapest first.
- **Guards:** (1) only collapse **interior manifold edges** (shared by exactly 2 faces); **lock boundary** vertices (edges with 1 face) so open meshes keep their border. (2) **flip guard** — skip a collapse that would flip any incident face normal (prevents spikes/inversions). (3) skip collapses that degenerate/duplicate a face.
- Lazy heap: per-vertex `stamp`; an edge entry tagged with its endpoints' stamps at push; on pop, discard if an endpoint is dead or a stamp changed (a fresh entry was pushed). On collapse, bump the merged vertex's stamp and re-push its incident edges.
- Stops when face count ≤ `targetRatio × original` (or no legal collapse remains).

`simplifyGeometry(geom: MeshGeometry, targetRatio): MeshGeometry` — wrapper for the generic path: decimate positions, **recompute normals** by area-weighted face averaging, carry each surviving vertex's original UV (approximate — fine for unseamed meshes; seamed meshes should re-unwrap after). Returns a `'12float'` geometry (tangents via `computeTangents`, or `setGeometry`).

## Part B — SDF / creature integration

- Refactor the per-blob unwrap out of `generateSdfMesh` into `unwrapPerBlobAtlas(positions, tris, normals, blobs)` → 8-float geometry (no behaviour change).
- `generateSdfMesh(blobs, resolution, decimate?)` — when `decimate` ∈ (0,1): after surface nets, `simplifyMesh` the closed triangle soup, recompute gradient normals, then unwrap. Params-only persistence carries `decimate` in the config → regenerates on load.
- `createCreature3D({ decimate })` + `createMetaballMesh3D(..., decimate?)` — expose it. Default: **`decimate: 0.4`** for creatures (lean by default — the user's ask), `undefined` (off) for raw metaballs unless asked. Rigged creatures decimate before bind.

## Part C — generic op + exposure + UNDO

- `ShapeManager.simplifyMesh3D(meshId, targetRatio)` — decimate any mesh's geometry in place. **Destructive but UNDOABLE**: snapshot the previous `MeshGeometry` into the undo stack before replacing, so **Ctrl-Z restores the dense mesh**. If the mesh was a params primitive, it becomes `custom` (baked) after simplify — same as other destructive edits.
- Re-unwrap: for a metaball/creature source we re-run the per-blob unwrap; for a generic mesh the caller can follow with `autoUnwrap3D` if UVs matter. (v1 carries approximate UVs.)
- **AI tool** `simplifyMesh` (`SceneAuthoringAPI.simplifyMesh(id, ratio)`) + `decimate` param on `addCreature` / `addMetaballs`. System-prompt note: "dense organic meshes (metaballs/creatures) can be made lean with simplifyMesh(id, 0.3) or the decimate param — cheaper to render, same look."
- Frogmarks UI: a "Decimate" slider (ratio) + Apply button, in the modifiers/mesh panel; wired to `simplifyMesh3D`. Undo via the existing stack.

## Tests
- QEM: a subdivided plane / box → decimate to 0.3 → tri count ≈ 30%, bounds preserved (silhouette), no flipped faces (all face normals keep sign vs. a reference), deterministic.
- Creature: `createCreature3D({decimate:0.4})` → far fewer tris than un-decimated, still a valid 12-float geometry, still rigs.
- Undo: `simplifyMesh3D` then undo → original vertex count restored.

## Not doing (v1)
- Adaptive octree dual-contouring (much larger; decimation covers the need).
- Attribute-aware QEM (UV/normal quadrics) — we re-unwrap/recompute instead.
- Quad remeshing / isotropic remesh (hero-asset territory).
