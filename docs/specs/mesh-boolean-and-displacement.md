# Mesh Booleans + Displacement/Noise Modifier — Spec (NOT built)

**Date:** 2026-08-18 · **Status:** planned, not started · **Companion:** the mesh-editing exposure that shipped 2026-08-18 (see `[[project_scene_authoring_mcp]]` / `docs/specs/architecture-review-and-worklist-2026-08-17.md`).

## Why

A Claude cube-authoring test surfaced 10 "missing" mesh capabilities; **7 already exist** in the `edit-mesh.ts` half-edge kernel and are now exposed to the AI via `SceneAuthoringAPI` + `sceneAuthoringTools()`. Exactly **two are genuinely missing**, and this spec covers both:

1. **Boolean CSG** — union / subtract / intersect between two meshes. Unlocks "cut facets into the gem", "hollow it out", "punch windows into the hull". The single biggest gap for hard-surface authoring.
2. **Displacement / noise modifier** — push vertices along their normals by a noise field. Unlocks surface roughness, terrain-like relief, organic lumpiness — cheap detail without hand-moving vertices.

Both should land on the **same three rails the existing mesh ops use**, so the AI gets them for free:
`EditMesh kernel op → MeshEditManager → ShapeManager *3D delegator → SceneAuthoringAPI verb → sceneAuthoringTools() def + dispatch → system-prompt recipe`.

---

## Where these plug into the existing architecture

Confirmed entry points (from the 2026-08-18 capability sweep):

- **Kernel:** `src/scene-graph/shapes/edit-mesh.ts`
  - Element types: `EditVertex` (`:39`), `EditFace` (`:46`), `EditHalfEdge` (`:51`).
  - `Modifier` interface (`:69`); the ONLY two impls today are `MirrorModifier` (`:78`) and `SubdivisionModifier` (`:124`).
  - `compile()` (`:166`) → flat Float32 geometry; `applyModifier(index)` (`:181`) bakes a stack modifier destructively.
  - `toJSON`/`fromJSON` (`:1647` / `:1668`) — **`fromJSON` only rehydrates `mirror` + `subdivision`** (`:1703-1712`). Any new modifier MUST be added here or it won't survive save/reload.
  - Custom-mesh entry: `_editMeshFromGeometry(mesh)` (`mesh-edit-manager.ts:772`) already builds an `EditMesh` from a raw triangle soup — the natural way to turn a CSG triangle result back into an editable mesh.
  - Queries usable for both features: `getFaceNormal` / `getFaceCenter` / `getFaceVertices` (`:1447-1461`).
- **Manager:** `src/services/managers/mesh-edit-manager.ts` (public `sm.meshEdit`). Every op follows: snapshot `editMesh.toJSON()` → mutate → `mesh.syncFromEditMesh()` → push undo command (Command3D stack).
- **Facade delegators:** `ShapeManager` `*3D` methods — modifiers cluster at `shape-manager.ts:7540-7560` (`addMirrorModifier3D`, `addSubdivisionModifier3D`, `applyModifier3D`). New delegators go beside them.
- **AI surface:** `src/services/scene-authoring-api.ts` (mesh-editing section) + `src/services/scene-authoring-tools.ts` (defs + dispatch) + `DEFAULT_AUTHORING_SYSTEM` in `src/services/scene-authoring-session.ts`.

**Reuse existing noise — do not add a new noise lib.** `src/world/` already has hashing + value-noise + domain warp (`hash2`, `makeHeightField`, `makeDomainWarpInto` — imported in `world-manager.ts:15`). The displacement modifier should reuse that path (extract a small pure `noise3(x,y,z,seed)` helper if one isn't already isolable) so world-gen and mesh-displace share one noise definition.

---

## Feature 1 — Displacement / Noise modifier (the cheap one; do FIRST) — ✅ SHIPPED 2026-08-18

**Built:** `DisplaceModifier` in `edit-mesh.ts` (self-contained 3D value noise `_valueNoise3` + fBm octaves — no cross-layer dep on world-gen noise), in the modifier stack next to Mirror/Subdivision. Per-vertex normals computed from the flat `EditMeshData` faces (Newell). Params: strength/frequency/seed/octaves/direction ('normal'|x|y|z). Registered in `fromJSON` (:1703-1712) + `toJSON` → params-only persist. `MeshEditManager.addDisplaceModifier` → `ShapeManager.addDisplaceModifier3D` → `SceneAuthoringAPI.addDisplaceModifier` → tool + dispatch. System-prompt: "roughness/relief = addSubdivisionModifier THEN addDisplaceModifier." +5 unit tests (identity at strength 0, axis-lock, determinism, toJSON round-trip). **Booleans remain the one open gap.** Original design below.



### Design
A new **`DisplaceModifier implements Modifier`** in `edit-mesh.ts`, slotting into the existing stack next to Mirror/Subdivision. Non-destructive until baked (`applyModifier3D`), and **composes with Subdivision** — subdivide first for vertex density, then displace for fine relief.

`apply(mesh: EditMeshData): EditMeshData` pushes each vertex:
```
p' = p + dir(p) * noise(p * frequency + phase, seed) * strength
```
- `dir(p)` = per-vertex normal (default) OR a fixed axis (`'x'|'y'|'z'|'normal'`). Normals come from averaging incident face normals over the flat `EditMeshData` (no half-edge adjacency in the modifier data format — compute face normals from `verts`, accumulate per vertex, normalize).
- `noise` = the shared value/simplex noise (see reuse note). Support at least value noise; simplex is nicer if the shared helper offers it.

### Params (→ tool JSON-Schema)
| param | type | default | notes |
|---|---|---|---|
| `strength` | number | 0.1 | displacement amount (object-space units) |
| `frequency` | number | 1.0 | noise scale (higher = finer bumps) |
| `direction` | `'normal'\|'x'\|'y'\|'z'` | `'normal'` | push axis |
| `seed` | number | 0 | reproducible |
| `octaves` | number | 1 | optional fBm layering (nice-to-have) |

### Wiring
- Kernel: `DisplaceModifier` class + register its `type: 'displace'` in `fromJSON` (`:1703-1712`) and in `toJSON` serialization (mirror the mirror/subdiv pattern exactly).
- Manager: `MeshEditManager.addDisplaceModifier(meshId, params)` → returns stack index (copy `addSubdivisionModifier` `mesh-edit-manager.ts:705`).
- Facade: `ShapeManager.addDisplaceModifier3D(meshId, params)` beside `:7545`.
- API: `SceneAuthoringAPI.addDisplaceModifier(id, params)`.
- Tool: `addDisplaceModifier` def + dispatch case; add to the MESH-EDIT recipe in the system prompt ("surface roughness/relief = addSubdivisionModifier then addDisplaceModifier then applyModifier").

### Tests
- Kernel unit test (CPU-pure, no GPU): displacing a plane with strength 0 is identity; strength>0 moves every vertex along its normal; same seed → identical output (determinism); `toJSON`→`fromJSON` round-trips the modifier.
- Dispatch test: `addDisplaceModifier` routes `id` + params (mirror the existing mesh dispatch tests).

### Effort / risk
**S–M, low risk.** Additive, isolated to the modifier stack, no topology surgery, CPU-pure, fully unit-testable. The only real work is reusing the noise helper cleanly and computing per-vertex normals in the flat data format.

---

## Feature 2 — Boolean CSG (union / subtract / intersect) — ✅ SHIPPED 2026-08-18

**Built:** self-contained BSP-tree CSG kernel `src/scene-graph/shapes/mesh-boolean.ts` (`booleanMesh(trisA, trisB, op)` — csg.js lineage, pure, triangle-soup in→out, flat-shaded; +5 unit tests verifying union/subtract/intersect volume bounds + disjoint-empty). Orchestrated on `ShapeManager.booleanMesh3D(idA, idB, op, opts?)` — extracts both meshes' WORLD-space triangles (`_meshWorldTris3D`), runs CSG, builds an 8-float `MeshGeometry` (flat normals), creates it via `createCustomMesh3D` at origin (world-baked coords), consumes operands unless `keepOperands`. 40k-tri cap guards a pathological hang. `SceneAuthoringAPI.booleanMesh` → tool + dispatch; system-prompt: "subtract cuts idB out of idA (holes/hollows/notches), union merges, intersect keeps overlap." v1 limits (documented): closed/manifold inputs, flat-shaded triangulated result (mergeByDistance to clean), operand-A material. ★ browser-verify appearance + coplanar edge cases. Original design below.



### Nature of the problem
A boolean is **not a modifier** (modifiers are single-mesh stack ops). It is a **two-operand op that produces a new mesh**, so it lives as a `ShapeManager` verb, not on the modifier stack. CSG is also numerically fragile (coplanar faces, near-degenerate triangles, non-manifold input) — the spec commits to a pragmatic v1 with documented limits rather than a bulletproof arrangement engine.

### v1 approach: BSP-tree CSG on triangle soup
The classic, self-contained algorithm (csg.js / three-csg lineage), no external deps:
1. Take both meshes' triangles **in a common space** — transform operand B into operand A's local space (or both into world space) using their node world matrices.
2. Build a BSP tree per operand; clip each tree against the other per the operation:
   - **union** = A outside B + B outside A (+ shared coplanar handled once).
   - **subtract** = A outside B + (B inside A, flipped).
   - **intersect** = A inside B + B inside A.
3. Collect the resulting triangle set → build a new `EditMesh` via `_editMeshFromGeometry` (`mesh-edit-manager.ts:772`) so the result is immediately editable.

**Result topology is triangulated** (no clean quads) — acceptable for v1; the AI can `mergeByDistance` / subdivide afterward. Document this.

### Operand + result handling
`booleanMesh3D(idA, idB, op, opts?)`:
- `op`: `'union' | 'subtract' | 'intersect'`.
- `opts.keepOperands` (default false): delete A and B, or keep them hidden.
- Returns the new mesh's id (or null on failure).
- Materials: v1 takes operand A's material for the whole result (per-face material carry-over is a v2 nicety).

### Robustness contract (document loudly)
- Inputs should be **closed, manifold** meshes. Open/self-intersecting meshes may produce holes.
- Coplanar-face handling is the fragile part — use an epsilon and prefer A on ties.
- No guarantee on heavily degenerate/duplicate geometry; recommend `mergeByDistance3D` on operands first.
- Large meshes: BSP is O(n log n)-ish but can blow up on pathological inputs — cap/guard triangle count, `debugLog` if exceeded (no silent truncation).

### Wiring
- New module: `src/scene-graph/shapes/mesh-boolean.ts` (pure: triangles-in → triangles-out; no GPU/DOM, unit-testable). Keep the BSP kernel self-contained here, NOT inside `edit-mesh.ts` (different concern, keeps the kernel lean).
- Manager: `MeshEditManager.booleanMesh(idA, idB, op, opts)` — gathers both meshes' world-space triangles, calls the kernel, builds the result `EditMesh`, creates the new node, pushes ONE undo command.
- Facade: `ShapeManager.booleanMesh3D(idA, idB, op, opts?)`.
- API: `SceneAuthoringAPI.booleanMesh(idA, idB, op, opts?)`.
- Tool: `booleanMesh` def + dispatch; add to system prompt ("cut facets / hollow / punch holes = booleanMesh(a, b, 'subtract'); merge solids = 'union'").

### Tests
- Kernel unit tests (CPU-pure): cube ∪ offset-cube volume/vertex sanity; cube − smaller-cube leaves a hole/cavity (face count increases, a cavity exists); cube ∩ offset-cube = the overlap box; two disjoint cubes union = both preserved; determinism.
- Dispatch test: `booleanMesh` routes idA/idB/op/opts.
- Note: exact vertex counts are algorithm-dependent — assert invariants (bounds, closedness, cavity presence), not brittle counts.

### Effort / risk
**L, medium-high risk.** The BSP CSG itself is well-trodden but the coplanar/epsilon edge cases are where bugs live; budget for a robustness pass. Self-contained and unit-testable, which contains the risk. Consider a follow-up "v2" for per-face material carry-over and quad-preserving output.

---

## Sequencing & scope

1. **Displacement modifier first** — small, low-risk, immediate AI value, proves the "new modifier" path end-to-end (kernel + fromJSON + manager + facade + API + tool + prompt + tests).
2. **Boolean CSG second** — larger, needs its own robustness pass; ship v1 (triangulated result, operand-A material, manifold-input contract) then iterate.

Neither is required for anything currently shipping — the existing 7 mesh capabilities already give the AI extrude/inset/bevel/loop-cut/subdivision/vertex-edit/env-map. These two just close the gap to full hard-surface + organic authoring.

## Definition of done (per feature)
- Kernel op CPU-pure + unit-tested; `toJSON`/`fromJSON` round-trip (displace) survives save/reload.
- `*3D` facade delegator + `SceneAuthoringAPI` verb + `sceneAuthoringTools()` def + dispatch case (sync-guard test still green).
- `DEFAULT_AUTHORING_SYSTEM` recipe updated.
- `npx tsc --noEmit` + full vitest green; `npm run build`; verify the new tool names land in `dist/main.es.js`.
- Browser-verify the visual result (both are geometry ops — unit tests cover math, not appearance).
