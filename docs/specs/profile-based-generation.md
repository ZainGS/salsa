# Profile-Based Generation — Revolve / Loft / Parametric (spec)

**Date:** 2026-08-18 · **Status:** cylinder-taper SHIPPED; revolve/loft/parametric planned, not built · **Companion:** `mesh-boolean-and-displacement.md`, `car-creator.md` (LOFT).

## Motivation

A user asked the AI to turn a cube into a spiky star; it produced **stepped extrusions** (each spike a stack of shrinking box extrudes) because incremental extrude is the only additive shaping tool exposed. The insight: there should be a *formula/profile-driven* way to make an exact smooth taper instead of stacking discrete steps — the same leap as going from a Riemann sum (rectangles) to the integral (the exact curve).

**The unifying principle:** decouple a shape's mathematical DEFINITION (a smooth profile / function) from its TESSELLATION (how finely it's sampled). Stepped extrude bakes coarse steps into the topology; a profile defines the shape exactly and tessellates at any resolution.

The engine's own primitives already work this way — `generateCylinder(radiusTop, radiusBottom, …)` (`mesh-generators.ts:269`) is a **surface of revolution** (a trapezoid profile spun around Y). What's missing is a *general* profile family the AI can drive.

The techniques form a hierarchy, weakest → most general: **tapered-revolve ⊂ loft ⊂ parametric/SDF.**

---

## ✅ SHIPPED: cylinder taper (the cheap win)

`generateCylinder` already supported `radiusTop`/`radiusBottom` and `Mesh3DConfig.radiusTop` was already plumbed (`mesh-3d.ts:533`) — it just wasn't exposed. Now wired end-to-end:
- `ShapeManager.createCylinder3D(..., radiusTop?)` — `radius` = bottom, `radiusTop` = top (0 = cone, <radius = truncated cone/taper, omitted = straight).
- `SceneAuthoringAPI.addCylinder({radiusTop})` + `addCone({radiusTop?})` convenience.
- Tools `addCylinder` (radiusTop) + `addCone`; dispatch + tests.

This gives the AI **exact smooth cones / tapered spikes** immediately (a thin tall cone = a clean spike), no stepped extrudes. It's the degenerate case of revolve (a straight profile line).

---

## Feature 1 — Revolve / lathe (surface of revolution). **[M] — ✅ SHIPPED 2026-08-18**

**Built:** `generateRevolve(profile, radialSegments, capEnds)` (`mesh-generators.ts`, +6 unit tests) — per-point outward normals from the profile slope, CCW-outward winding matching the other generators, axis-fan end caps when radius>0. New `'revolve'` primitive: `Mesh3DConfig.profile` + build case + geometryKey hash (`mesh-3d.ts`) → **params-only persistence** (profile rides in config, regenerates on load). `ShapeManager.createRevolve3D` → `SceneAuthoringAPI.addRevolve({profile, segments})` → tool `addRevolve` + dispatch. System-prompt: "round/varying-radius shapes use addRevolve/addCone, not stacked extrudes." Original design below.



Define a 2D profile (a polyline of `[radius, height]` points, i.e. the silhouette) and spin it around the Y axis → a smooth solid. Vases, bottles, columns, chess pieces, lamp-post finials, smooth spikes, goblets, domes.

### Design
- New generator `generateRevolve(profile: [number,number][], segments: number, closed?: boolean): MeshGeometry` in `mesh-generators.ts` — for each of `segments` angular steps, place the profile's `[r,y]` points rotated to that angle; stitch adjacent rings into quads; cap ends if the profile doesn't reach the axis. Compute normals from the profile slope + angle.
- `Mesh3DConfig.primitive = 'revolve'` with `config.profile` + `config.radialSegments`; `mesh-3d.ts` builds via `generateRevolve`. Persist the profile in the config (params-only, regenerates on load — matches the engine thesis).
- `ShapeManager.createRevolve3D(x,y,z, profile, radialSegments?, material?)`.
- `SceneAuthoringAPI.addRevolve({profile, radialSegments})`; tool `addRevolve` (profile = array of [radius,height] pairs).

### Params → schema
| param | type | notes |
|---|---|---|
| `profile` | `[radius, height][]` | the silhouette, bottom→top; radius 0 = on-axis (a point/cap) |
| `radialSegments` | number (default 24) | angular resolution |
| `closed` | bool | close the profile loop (torus-like) |

### Why it's the right next step
Covers the entire class of rotationally-symmetric objects the AI currently fakes with extrudes. A profile is tiny for a model to emit (a handful of `[r,y]` points) and reads as an exact curve.

---

## Feature 2 — Loft / sweep (profiles along a path). **[L] — ✅ TUBE FORM SHIPPED 2026-08-18**

**Built (the tube/sweep form — the common, AI-friendly case):** `generateTube(path, radii, radialSegments, capEnds)` (`mesh-generators.ts`, +5 tests) — sweeps a circular cross-section of per-point `radii` along a `[x,y,z]` `path`, using **rotation-minimizing (parallel-transport) frames** so a curving path doesn't twist. New `'tube'` primitive (`Mesh3DConfig.path`+`radii` + build case + geometryKey → params-only persist). `ShapeManager.createTube3D` → `SceneAuthoringAPI.addTube({path, radii, segments})` → tool `addTube` + dispatch. Covers horns/tentacles/branches/pipes/cables. The general profile-per-section loft (arbitrary varying cross-sections) is the remaining part below; the tube form handles the overwhelmingly common "sweep a circle along a curve" case. ★ Browser-verify the face-winding on caps + curved paths. Original design below.



More general than revolve: a sequence of cross-section profiles positioned along a *path* (spine), skinned between consecutive sections. The path can curve; sections can change shape/size. Horns (shrinking circles along a curve), car bodies, tentacles, pipes, organic-ish tapers. Revolve is the special case where the path is a circle and the section is a point.

### Design
- `generateLoft(sections: {profile:[number,number][], transform:Mat}[], closed?: boolean)` — skin between ordered sections (equal vertex counts) into quad strips; cap ends. Or the simpler common form `generateTube(path: Vec3[], radiusFn: (t)=>number, radialSegments)` = circles of `radiusFn(t)` swept along `path`.
- `Mesh3DConfig.primitive = 'loft'` + config (sections or path+radii). `createLoft3D` / `SceneAuthoringAPI.addLoft` / tool.

### Params → schema
`sections: [{profile, at:[x,y,z], scale?, rotate?}]` OR the tube form `{ path:[x,y,z][], radii:number[], radialSegments }`.

### Note
The car-creator spec (`car-creator.md`) already names LOFT for de-boxing car bodies — this generator is the shared engine for both the AI API and the car creator.

---

## Feature 3 — Parametric surface `p(u,v)` (fully general smooth). **[M]**

The literal "y = f(x)" generalized: sample a function over a `u×v` grid → vertices, stitch into quads. `radius = f(height)` for a profile, or a full `p(u,v)` for saddles/waves/shells. This is the most flexible smooth surface, but exposing an arbitrary function to an AI safely means a **curated set of named profile functions** (linear, quadratic, sine, super-ellipse, bezier-from-control-points) rather than eval of raw strings.

### Design
- `generateParametric(fn, uSegs, vSegs)` internal; the AI-facing tool takes a **named profile** + coefficients (e.g. `{ kind:'superellipse', n:2.5 }`) or **bezier control points**, never raw code (no `eval`). Bezier control points are the sweet spot: expressive, safe, tiny to emit.

---

## Feature 4 — SDF / metaballs + marching cubes (organic). **[L, separate track]**

The answer for organic blobby forms (the "realistic dog" that box-modeling can't do): define shapes as signed distance fields, smooth-union them (a union of capsules IS a limbed body), polygonize with marching cubes. Heaviest lift; belongs with the **procedural creature generator** direction, not this profile family. Noted here for completeness of the hierarchy.

---

## Sequencing

1. **Cylinder taper — DONE.** Immediate smooth cones/spikes.
2. **Revolve — do next [M].** Biggest ROI: covers all symmetric objects with a tiny profile input; self-contained pure generator + config + verb + tool + tests; params-only persistence.
3. **Loft [L].** Shared with the car creator; unlocks curved/varying-section forms.
4. **Parametric (bezier profiles) [M].** Smooth arbitrary silhouettes safely (no eval).
5. **SDF/metaballs [L].** Separate organic track (creature generator).

## Definition of done (per generator)
- Pure `generate*` in `mesh-generators.ts`, CPU-only, unit-tested (vertex/normal sanity, tessellation scales with segments, degenerate profiles don't crash).
- `Mesh3DConfig` field + `mesh-3d.ts` build case; **profile persisted in config** so it regenerates on load (params-only thesis) — verify a save→reload round-trip.
- `create*3D` facade + `SceneAuthoringAPI` verb + `sceneAuthoringTools()` def + dispatch (sync-guard green).
- System-prompt recipe: "for smooth tapered/symmetric forms use addRevolve/addCone, NOT stacked extrudes."
- tsc + vitest + build green; verify tool names in `dist/main.es.js`; browser-verify the visual + a reload.

## Not doing (yet)
Raw-function `eval` (unsafe); NURBS (overkill vs bezier); the SDF track (its own spec with the creature generator).
