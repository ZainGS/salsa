# SDF Metaballs + Procedural Creature Generator — Spec (NOT built)

**Date:** 2026-08-19 · **Status:** planned, not started · **Companions:** `profile-based-generation.md`, `mesh-boolean-and-displacement.md`, `project_character_variety.md`.

## Why

Every AI cube-test that asked for a **realistic organic form** (a dog, an animal, a creature) failed — because the only additive tools were box-modeling (extrude/inset/bevel) and parametric surfaces (revolve/tube). Those are exact for hard-surface and rotationally-symmetric shapes, but **you cannot box-model a convincing quadruped by dragging indexed vertices blind**, and a revolve/tube can't branch into limbs. The result is always a lumpy mess.

The correct technique for **organic, blobby, branching** forms is **signed distance fields (SDF) + smooth blending + polygonization**:

- A body is a **union of capsules and ellipsoids** (torso, neck, legs, head, tail) that **smoothly fuse** where they meet — a dog is ~12 capsules blended together.
- Normals come from the SDF **gradient** → smooth automatically (no shading artifacts).
- The capsule skeleton **doubles as a bone rig** → a generated creature can be **rigged and animated for free**.

This is the north-star answer to "make me a dog": not sculpting, but **composing smooth primitives**. It's a new engine capability (no marching-cubes / SDF code exists today) and the natural parallel to the existing humanoid `body-generator.ts`.

---

## The technique (background)

1. **SDF primitives** — a function `f(p) → signed distance` to a shape's surface (negative inside). Cheap closed forms:
   - Sphere: `length(p - c) - r`
   - Capsule (line segment a→b, radius r): `distToSegment(p, a, b) - r` — the workhorse for limbs/body.
   - Ellipsoid, rounded box, torus, cone — standard SDF formulas (iquilezles.org catalogue).
2. **Smooth combine** — blend two fields so surfaces fuse organically:
   - Smooth-union `smin(a,b,k)` (polynomial): `h = clamp(0.5 + 0.5*(b-a)/k, 0,1); return mix(b,a,h) - k*h*(1-h)`. `k` = blend radius (how much they melt together).
   - Smooth-subtract / smooth-intersect analogues (for eye sockets, mouth cavities).
3. **Polygonize** the combined field into a triangle mesh. Two options:
   - **Naive Surface Nets** (recommended v1): one vertex per grid cell that straddles the surface, positioned at the estimated crossing; quad faces between adjacent cells. ~120 lines, **smooth** output ideal for blobs, no 256-case table.
   - **Marching Cubes**: the classic; sharper, but a big lookup table and more triangles. Overkill for smooth organic forms.
4. **Normals** from the SDF gradient via central differences: `n = normalize([f(p+εx)-f(p-εx), …])`. Smooth and exact — a key advantage over box-modeled organics.

---

## Architecture / layering

Four layers, each shippable independently, each on the **established rails** (kernel → ShapeManager `*3D` → `SceneAuthoringAPI` verb → tool → params-only persistence):

```
Layer 1  SDF kernel          sdf-mesh.ts: primitives + smin + surface-nets → MeshGeometry (pure, CPU, unit-testable)
Layer 2  Metaball authoring  addMetaballs(blobs[])   — place/blend blobs directly (AI + UI)
Layer 3  Creature generator  createCreature(params)  — parametric quadruped/biped → capsule spec → Layer 1
Layer 4  Auto-rig            the capsule skeleton IS a bone rig → skeleton + bind → animatable creature
```

---

## Phase 1 — SDF kernel + metaball authoring **[L] — ✅ SHIPPED 2026-08-19**

**Built:** `src/scene-graph/shapes/sdf-mesh.ts` (pure, +5 unit tests) — SDF primitives (sphere/capsule/ellipsoid/box/torus), polynomial `smin` smooth-union + smooth-subtract, `evalField`, AABB bounds, **naive surface nets** (Lysenko cube-edge tables) + gradient normals → indexed 8-float `MeshGeometry`. Tests verify: sphere→unit shell, two blended spheres FUSE (neck of verts across the gap), capsule elongates, normals unit, deterministic, res-capped 8..96. New `'metaball'` primitive (`Mesh3DConfig.blobs`+`resolution` + build case + geometryKey → **params-only persist**). `ShapeManager.createMetaballMesh3D` → `SceneAuthoringAPI.addMetaballs({blobs, resolution})` → tool + dispatch. System-prompt: "organic/creatures/slime = addMetaballs (capsules+spheres, blend 0.2-0.4)." ★ browser-verify surface winding + a reload. **NEXT: Phase 2 creature generator.** Original design below.



### Kernel (`src/scene-graph/shapes/sdf-mesh.ts`, pure)
- Types: `SdfBlob = { shape: 'sphere'|'capsule'|'ellipsoid'|'box'|'torus'; a:[x,y,z]; b?:[x,y,z]; radius:number; radii?:[x,y,z]; op?:'union'|'subtract'; blend?:number }`.
- `evalField(blobs, p) → number` — combine all blobs with smin (per-blob `blend` k; `subtract` blobs cut cavities).
- `generateSdfMesh(blobs, resolution, bounds?) → MeshGeometry` — compute a bounding box (union of blob bounds + blend padding), sample the field on a `resolution³` grid, **naive surface nets** → vertices (at cell crossings) + quad→tri faces, **gradient normals**. Output 8-float geometry (pos+normal+uv0); `computeTangents` fills the rest.
- **Perf caps:** default `resolution` ~48, hard-cap ~96 (O(N³) evals × blobs — a creature at 48³ × 15 blobs ≈ 1.6M evals, fine one-shot). Cheap AABB early-out per blob so distant cells skip most blobs. Note in the spec: high-res should offload to a Worker (Phase 1b) — reuse the tiled-world worker pattern.

### Wiring
- New primitive `'metaball'`: `Mesh3DConfig.blobs` + `resolution` → build case calls `generateSdfMesh` → **params-only persistence** (the blob list rides in config, regenerates on load; register nothing extra — same pattern as `revolve`/`tube`).
- `ShapeManager.createMetaballMesh3D(x,y,z, blobs, resolution?, material?)`.
- `SceneAuthoringAPI.addMetaballs({ blobs, resolution })` + tool `addMetaballs`.
- System-prompt: "for ORGANIC blobby/branching forms (creatures, cloud, coral, slime) use addMetaballs — a list of spheres/capsules that smoothly fuse; capsules for limbs/body."

### Tests
- Kernel: a single sphere blob → a roughly-spherical closed mesh (vertex distances ≈ r); two overlapping spheres with `blend>0` → a fused peanut (a neck of vertices between them, no gap); normals unit length; deterministic; empty blob list → empty mesh; resolution scales vertex count.

---

## Phase 2 — Procedural Creature Generator **[L] — ✅ SHIPPED 2026-08-19** (the "dog")

**Built:** `src/services/managers/creature-generator.ts` (pure, +6 tests) — `buildCreatureBlobs(params): SdfBlob[]` composes a quadruped/biped: torso capsule + 4 (or 2) leg capsules + paws + neck capsule + head ellipsoid + snout + ears + a 2-segment curled tail, all `blend`-fused; feet at y≈0. **Species presets** (dog/cat/horse/lizard/generic) merged over defaults; every param overridable. `ShapeManager.createCreature3D(params,x,y,z,res)` → `createMetaballMesh3D`. `SceneAuthoringAPI.addCreature({species,…})` + `creatureSpecies()` + tools. System-prompt: "an animal → addCreature({species})." Tests verify limb/ear counts, feet-on-ground, species proportions differ. **NEXT: Phase 3 auto-rig** (the capsule skeleton → bones → animatable). Original design below.



A parametric composer that emits an `SdfBlob[]` and calls Phase 1. Parallels `body-generator.ts` but for quadrupeds/organic.

### Params (→ schema)
| group | params |
|---|---|
| body | `bodyLength`, `bodyRadius`, `bodyTaper`, `chestRadius`, `hipRadius` |
| head/neck | `neckLength`, `neckRadius`, `headSize`, `snoutLength`, `snoutRadius`, `earSize`, `earCount` |
| legs | `legCount` (4/2), `legLength`, `legRadius`, `pawRadius`, `stance` (spread) |
| tail | `tailLength`, `tailRadius`, `tailCurl` |
| global | `blend` (overall smoothness), `resolution`, `seed`, `species` preset |

### Composition
- Body = a capsule (or 2–3 chained capsules with varying radius for chest/belly/hip) along +Z.
- 4 legs = capsules from hip/shoulder points down to paw points (paws = small spheres). `legCount:2` → biped.
- Neck = capsule from chest to head; head = ellipsoid; snout = tapered capsule; ears = small ellipsoids/flaps.
- Tail = a chain of shrinking capsules (curved by `tailCurl`).
- All smooth-unioned with `blend` → one continuous creature.
- **Species presets** (dog/cat/horse/lizard/generic) = curated param sets + `seed`-driven variety (reuse the character-variety randomizer idea).

### Wiring
- `ShapeManager.createCreature3D(params, x,y,z)` → builds blobs → `createMetaballMesh3D`.
- `SceneAuthoringAPI.addCreature({ species, ...params })` + tool `addCreature` (+ a `creatureSpecies()` list + param schema, mirroring the prop/creator pattern so the UI/AI drive a form).

---

## Phase 3 — Auto-rig the creature **[M] — ✅ SHIPPED 2026-08-19** (rigged, animatable)

**Built:** `buildCreatureSkeleton(params): CreatureJoint[]` (shares an `anatomy()` helper with `buildCreatureBlobs` so mesh + rig can't drift) — pelvis→spine→chest→neck→head, a 2-bone chain per leg (front→chest / back→pelvis), a 2-bone tail. `createCreature3D({rigged:true})` builds the skeleton (`createEmptySkeleton3D`+`addBone3D`, root carries the x/y/z offset, children parent-relative so world positions align with the mesh verts) and `bindMeshToSkeleton3D` — which upgrades the Mesh3D→SkinnedMesh3D (same id) so `getSkeletonForMesh(id)` finds it → poseBone/createClip/playClip all work. +4 skeleton tests (bone counts, valid parent order, front/back parenting, feet-at-y≈0). System-prompt + tool `rigged` flag. ★ browser-verify the deformation (bind is GPU-skinned). NOTE: rigged creatures persist as BAKED geometry (bind drops the blobs config) — unrigged stay params-only. **NEXT: Phase 4 detail/variety.** Original design below.



The capsule skeleton IS a bone hierarchy — so the generator can also emit a matching rig:
- Root at the hip → spine capsule joints → neck → head; hip → each leg chain (upper/lower/paw); tail chain.
- Build via existing `createEmptySkeleton3D` → `addBone3D` (the capsule endpoints are the joints) → `bindMeshToSkeleton3D` (proximity skinning already exists).
- Result: `createCreature3D({ rigged: true })` returns `{ meshId, skeletonId }` — a creature that can immediately be posed (`poseBone`/`setIKTarget`) and animated (`createClip`/`recordPose`/`playClip`) with the rigging tools that already shipped. **This is the payoff:** a rigged dog that can walk/sit/wag, from params.

---

## Phase 4 — Detail + variety **[M] — ✅ SHIPPED 2026-08-19** — ★ SDF CREATURE TRACK COMPLETE

**Built** (+3 tests): (1) **`seed`** — deterministic ±13% proportion jitter in `anatomy()` (so mesh + skeleton stay in sync); same seed = same individual, different seed = a different one. (2) **`roughness`** — `createCreature3D` applies `addDisplaceModifier3D` (skin/scale/fur relief), before rigging so the bake feeds the bind. (3) **`eyes`** (default on) — `creatureEyes(params)` gives two symmetric head positions; `createCreature3D` places them as small dark separate spheres (a fused metaball body can't carry a 2nd material). Tool params + system-prompt. NOTE: eyes are separate meshes that don't follow a posed skeleton (v1). **All 4 phases done — the "make me a (rigged, varied, textured, eyed) dog" pipeline is complete.** Original design below.


- **Surface texture:** run the shipped `addDisplaceModifier` on the result for skin/scale/fur-bump relief; or fur cards (reuse the hair-card system) for mammals.
- **Eyes/features:** reuse the eye-decal / procedural-eye system on the head; smooth-subtract eye sockets / mouth in the SDF.
- **Variety:** seeded param jitter + species collections (parallels `character-variety.md`).

---

## Perf & risk
- **O(resolution³ × blobs)** — the real cost. Mitigate: per-blob AABB early-out, a conservative default resolution (48), a hard cap (96), and a `log()` when clamped (no silent truncation). **Phase 1b:** move `generateSdfMesh` to a Worker for high-res / live-slider editing — the field eval + surface nets are pure and cloneable, so this reuses the existing tile-worker pattern cleanly.
- **Blend tuning:** too-high `blend` melts limbs into a blob; too-low leaves seams. Ship sensible per-species defaults.
- **Surface nets caveat:** produces quads/degenerate tris on thin features; triangulate + `mergeByDistance` on output. Thin legs may need a minimum radius.
- **Not** the tool for hard-surface — keep the guidance: metaballs = organic; revolve/tube/box-edit = mechanical.

## Sequencing & effort
1. **Phase 1 kernel + addMetaballs [L]** — the foundation; immediately lets the AI/UI place blended blobs (slimes, clouds, coral, simple creatures). Highest ROI.
2. **Phase 2 creature generator [L]** — the "dog"; the flagship parametric composer.
3. **Phase 3 auto-rig [M]** — turns it into an *animatable* creature (reuses shipped rig tools). The real magic.
4. **Phase 4 detail/variety [M]** — polish; reuses displace/hair/eyes/variety.
5. **Phase 1b Worker offload** — when high-res or live editing is needed.

## Definition of done (per phase)
- Pure kernel, CPU, unit-tested (field/blend/normals/determinism; no NaN on degenerate blobs).
- New `'metaball'` primitive + config → **params-only persist**; verify a save→reload round-trip.
- `create*3D` facade + `SceneAuthoringAPI` verb + `sceneAuthoringTools()` def + dispatch (sync-guard green) + system-prompt recipe.
- tsc + vitest + build green; tool names in `dist/main.es.js`; **browser-verify** the surface (winding, blend look) + a reload.
- Phase 3: the returned skeleton poses + a recorded clip plays on the generated mesh.

## Not doing (yet)
- Dual contouring / sharp-feature preservation (surface nets is enough for organic).
- GPU marching cubes (CPU one-shot + Worker is sufficient at these resolutions).
- Full anatomical accuracy / muscle systems — this is stylized-organic, not a ZBrush.
