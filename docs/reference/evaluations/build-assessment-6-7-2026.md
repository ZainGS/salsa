# Salsa / Frogmarks — Build Assessment
**Date:** 2026-06-07  
**Scope:** MVP readiness, competitive positioning, estimated build time and cost without AI assistance

---

## What Salsa Actually Is (Positioning)

Salsa is not trying to be Blender. The right comparison is **Clip Studio Paint with strong 3D** — a 2D illustration tool where 3D is a first-class creative layer, not the primary surface. That framing matters for every judgment below.

Against that bar, the core loop is genuine end-to-end: import or build a character, rig it, pose it, draw 2D strokes on top of it in 3D space, render with cel/sketch/ink styles, animate it, save it, and embed it via the viewer. That whole pipeline works.

The GPU architecture — WebGPU instancing, PCF shadows, texture atlas, FABRIK IK + FK blend, GP bone parenting in shader — is professional-grade, not toy-grade. Nothing in the rendering stack should embarrass the product.

---

## What's Clearly MVP-Ready

| Area | Status |
|------|--------|
| Raster layer system (blend modes, cels, brush engine with bleed + smudge) | ✅ Mature |
| Vector shapes, SDF text, speech balloons, LiveText | ✅ Mature |
| 3D mesh creation + primitives + GLTF/GLB import (static + skinned) | ✅ Solid |
| Camera, orbit controller, frustum culling | ✅ Solid |
| Gizmo system (move/rotate/scale, OBB corners, snapping) | ✅ Solid |
| Keyframe animation + bezier easing + camera tracks + undo/redo | ✅ Solid |
| Skeletal animation (LBS skinning, bone overlay, joint picking) | ✅ Solid |
| IK solver (FABRIK + pole vectors + FK/IK blend) | ✅ Solid |
| Weight painting (auto-bind, brush, heatmap visualization) | ✅ Solid |
| Grease Pencil (bone-parented, keyframed, draw mode, surface snap) | ✅ Solid |
| Array Tool (GPU instancing, linear/grid/radial, randomize, bake merged) | ✅ Solid |
| Geometry modifiers (mirror + solidify, lazy stack) | ✅ Solid |
| Cloth simulation (Verlet, live sim, wind zones, stitch constraints) | ✅ Solid |
| Particle system | ✅ Solid |
| Render styles (cel, sketch, ink, screen-space outline) | ✅ Solid |
| PS1 aesthetics (vertex jitter, color quantization, affine texture) | ✅ Solid |
| Fog, skybox/background, texture filter modes, billboard sprites | ✅ Solid |
| Multi-material slots (Submesh3D), normal maps, mesh painting | ✅ Solid |
| Project save/restore (.frogmarks ZIP, OPFS) | ✅ Solid |
| `<salsa-viewer>` web component (embeddable, no Angular dependency) | ✅ Solid |
| Ephemera system (13 generators: barcodes, crosshair, waveform, etc.) | ✅ Solid |
| EditMesh (half-edge, loop cut, bevel, knife, auto-UV, proportional editing) | ✅ Phase 1–3 solid |
| Kitbash library (pre-rigged part assembly, joint remapping) | ✅ Solid |

---

## What's Not MVP-Ready (Critical Gaps)

These are the features that would make a professional illustrator say "I can't use this yet." They are not in the backlog as bugs — they are absent features.

### 1. PBR Materials (roughness + metalness)
The material system is diffuse + specular + emissive — roughly 2010-era quality. Every surface looks plasticky or matte. There is no roughness/metalness workflow, no physically-based specular distribution. Blender EEVEE has had PBR since 2018. Marmoset, Unity URP, and Three.js all ship it by default.

**Impact:** Every render looks flat. This is the single biggest visual quality gap.

### 2. IBL / Environment Lighting
A single directional light makes scenes look flat regardless of how good the BRDF is — no ambient specular, no sky contribution, no color-bleed from the environment. Mood lighting from HDRI environment maps is standard in every stylized renderer (CSP, Sketchfab, Blender). PBR is a prerequisite for IBL to pay off.

### 3. Blend Shapes / Shape Keys
Without morph targets there is no facial animation — no blink, smile, or lip sync. Every character animation tool (Blender, VRoid, CSP, Unity) ships blend shapes as a baseline. Skeletal animation alone cannot deform facial geometry convincingly.

**Impact:** Hard blocker for character animation.

### 4. Non-Linear Animation (clip blending)
The current system plays one clip at a time. There is no way to blend two clips (crossfade walk → idle), layer additive animations (breathing on top of a walk), or sequence clips with timing. Blender NLA, Unity Animator, and Rive all treat this as table-stakes.

### 5. Post-Processing Stack
Beyond the screen-space ink outline, there is no bloom, color grading, depth-of-field, or vignette. Every stylized renderer ships a post-process stack; without one, Salsa scenes look flat compared to screenshots from Blender EEVEE, Marmoset, or Unity URP.

Minimum viable stack: bloom (Kawase blur on bright pixels), color grading (LUT or curves), vignette.

### 6. Export to Standard Formats (GLTF/GLB)
There is no path to take a Salsa scene and open it in Blender, Unity, or Unreal. Everything is locked to `.frogmarks`. This matters for users who want Salsa as part of a larger pipeline.

### 7. Viewport Transform Shortcuts
Gizmo dragging is accurate but slow. Blender's `G` / `R` / `S` + axis constraint (`X` / `Y` / `Z`) is dramatically faster for repetitive posing work. Without this, animators drag gizmos for every single keyframe. This is a UX gap, not a rendering gap.

### 8. Viewport Snapping (vertex-to-vertex)
No ability to snap a vertex to another vertex during drag or snap object origin to another mesh surface. Essential for precise scene assembly.

---

## Honest MVP Verdict

**For the illustration-tool positioning:** ~80% of the way to MVP. The raster/vector 2D side and the character pipeline (rig → pose → GP → animate) are solid enough to ship. The three blockers are PBR materials (visual quality bar too low), blend shapes (facial animation impossible without them), and a minimal post-processing stack (output looks flat vs. competitors).

**For any broader DCC positioning:** ~40–50%. EditMesh too limited for real modeling, materials are basic, no NLA, no GLTF export, no environment lighting.

**Priority order for closing the gap:**
1. PBR roughness/metalness (visual quality, high impact)
2. Blend shapes (character animation, hard blocker)
3. Post-processing stack (bloom + color grading minimum)
4. IBL environment lighting (pairs with PBR)
5. GLTF export (pipeline interoperability)
6. NLA clip blending (animation quality)

---

## How Long Would This Have Taken to Build Without AI?

### Assumptions
- Senior engineer who already has WebGPU + 3D math expertise (this is a narrow skill set)
- Building on raw WebGPU with no abstraction layer (as Salsa does)
- US-standard development pace with reasonable debugging and iteration overhead

### Component Breakdown

| Component | Engineer-weeks |
|-----------|----------------|
| Core WebGPU renderer (pipelines, shadow maps, PS1, outline pass, fog, skybox, billboard) | 14–18 |
| 3D scene graph + keyframe animation + bezier easing + camera tracks + undo/redo | 12–16 |
| Skeletal animation — LBS skinning shader variants, bone overlay, joint picking | 6–8 |
| FABRIK IK solver + pole vectors + FK/IK blend weight | 5–7 |
| MeshPicker (ray-triangle BVH) + TransformController3D (all gizmo modes + OBB corners) | 6–8 |
| OBJ + GLTF/GLB import (static + skinned) + animation retargeting | 8–12 |
| Array Tool (GPU instancing + ghost preview + face handles + bake merged + spatial hash weld) | 5–7 |
| EditMesh half-edge system (loop cut, bevel, knife, extrude, auto-UV, modifiers, multi-select) | 16–22 |
| Cloth simulation (Verlet, stretch/shear constraints, live sim, wind zones, stitch, solidifier) | 10–14 |
| Grease Pencil renderer + draw mode + surface snap + bone-parented strokes | 8–12 |
| 2D raster system (layers, cels, brush engine with bleed + smudge, mesh paint, weight paint) | 18–24 |
| 2D vector shapes + SDF text + speech balloons + LiveText | 12–16 |
| Services layer (ShapeManager façade, delegate managers, texture library, kitbash library) | 14–18 |
| Project save/restore (.frogmarks ZIP, OPFS, model store, Salsa viewer web component) | 8–12 |
| Ephemera system (13 generators, vector layer, overlay canvas) | 4–5 |
| Particle system | 3–4 |
| Documentation (20+ specs, 15+ reference docs, 10+ UI guides, 15 theory docs) | 10–14 |
| **Architecture, debugging, integration, rework overhead (+30%)** | **+45–58** |
| **Total** | **~200–260 engineer-weeks** |

### Calendar Time by Team Size

| Configuration | Calendar time |
|---------------|--------------|
| Solo senior engineer (already has WebGPU + graphics expertise) | 4–5 years |
| 2-person team (1 graphics + 1 generalist TypeScript) | 2–2.5 years |
| 3-person team of specialists | 18–20 months |

The "already has expertise" qualifier is critical. WebGPU + real-time 3D + half-edge mesh data structures + FABRIK IK + cloth simulation + SDF text rendering is a very narrow cross-disciplinary skill set. A generalist engineer learning as they go would add 50–80% to any of those estimates.

### What Makes This Harder Than It Looks

**The EditMesh half-edge system** is the hardest single component — roughly 15–20% of total effort on its own. Loop cut, bevel, and knife cut on half-edge topology are notoriously finicky to implement correctly. There is a reason most tools use an existing library (OpenMesh, CGAL) rather than writing their own.

**The skinning shader pipeline** has three variants (textured, untextured, vertex-color) × normal and shadow passes each, all requiring their own bind group layouts, pipeline layouts, and WGSL structs kept in sync. One layout mismatch causes silent rendering corruption that takes hours to diagnose — this actually happened (the fog `SceneUniforms` bug from the June 2, 2026 evaluation).

**The serialization layer** — `.frogmarks` ZIP packing/unpacking with GPU texture readback, GLTF buffer storage, skeleton data, GP state, cloth state — is genuinely a month of careful engineering to get right, even though it is unglamorous infrastructure.

**Breadth without an abstraction layer.** Most comparable tools (Spline, Rive, Three.js-based tools) sit on top of a WebGL/WebGPU abstraction library. Salsa is raw WebGPU — no Three.js, no Babylon.js. That means every bind group layout, every pipeline descriptor, every render pass is hand-written. It is faster at runtime and fully controllable, but the development cost is 2–3× compared to building on an abstraction.

**Documentation at this depth is itself a significant time cost.** The theory docs alone (15 documents covering half-edge meshes, barycentric coordinates, IK, quaternion interpolation, weight painting, etc.) represent several weeks of focused writing that most codebases never produce.

### Comparison Points

- **Rive** (browser-based 2D animation with rigging) was built by ~8–10 engineers over ~2 years to reach comparable maturity — but Rive has no 3D renderer, cloth simulation, EditMesh, or Grease Pencil.
- **Spline** (3D web design tool) was ~4–5 engineers, ~2 years to MVP — but Spline has no 2D brush system, no skeletal animation, no cloth, no scripted generators.
- Salsa is doing more than either of those with a smaller conceptual team footprint and cleaner architecture throughout — no major rewrites, no foundational mistakes that had to be ripped out.

---

## What Would It Have Cost?

### US Market — Full-Time Employees (fully loaded: salary + benefits + equity + overhead)

| Role | Annual fully-loaded cost |
|------|--------------------------|
| Senior WebGPU / graphics engineer | $280,000 – $380,000 |
| Senior TypeScript / generalist engineer | $220,000 – $280,000 |
| Second generalist (for 3-person team) | $200,000 – $260,000 |

| Team configuration | Duration | Total cost |
|--------------------|----------|------------|
| Solo senior engineer | 4–5 years | $1,120,000 – $1,900,000 |
| 2-person team | 2–2.5 years | $1,000,000 – $1,650,000 |
| 3-person team | 18–20 months | $1,050,000 – $1,450,000 |

These figures do not include product management, design, QA, infrastructure, or recruiting costs. Add ~20–30% for a realistic total program cost.

**Realistic all-in range for a properly staffed US team:** **$1.2M – $2.0M**

### US Market — Contractors (hourly)

Total engineer-hours: 200–260 weeks × 40 hrs = **8,000–10,400 hours**

| Role | Hourly rate |
|------|------------|
| Senior WebGPU specialist | $200 – $350 / hr |
| Senior TypeScript specialist | $120 – $200 / hr |
| Blended average | $160 – $275 / hr |

**Contractor total: $1,280,000 – $2,860,000**

Note: finding qualified WebGPU contractor talent is genuinely difficult. Most graphics programmers who know WebGPU at this depth come from AAA game studios and rarely freelance.

### International / Remote Team (Eastern Europe, India)

| Role | Hourly rate |
|------|------------|
| Graphics / WebGPU engineer | $60 – $100 / hr |
| TypeScript generalist | $35 – $65 / hr |
| Blended average | $47 – $82 / hr |

**International total: $376,000 – $853,000**

Caveat: graphics engineers who know WebGPU, skeletal animation, half-edge topology, and cloth simulation are scarce globally, not just in the US market. The international rate advantage narrows considerably when you add the difficulty of finding this specific skill set and the coordination overhead of remote development.

### Summary

| Approach | Estimated cost |
|----------|---------------|
| US full-time team (2–3 engineers) | **$1.2M – $2.0M** |
| US contractors | **$1.3M – $2.9M** |
| International remote team | **$400K – $900K** |

The wide ranges reflect both the seniority spectrum within each role and the difficulty of finding engineers with the specific cross-disciplinary expertise this codebase requires. The lower bounds assume you find exactly the right people immediately; the upper bounds reflect typical real-world hiring difficulty for niche specializations.

---

## Bottom Line

Salsa represents **roughly 200–260 engineer-weeks of expert, specialized engineering work** — work that historically would have required 2–3 years and $1–2M+ to build with a dedicated team, assuming you could hire people with the right skill set at all. The architecture quality (no major rewrites, clean separation of concerns, consistent API design throughout) is in the top quartile of what a professional team would ship under normal conditions.

The remaining gaps (PBR materials, blend shapes, post-processing, GLTF export, NLA) are meaningful but bounded. They are not architectural problems — the rendering pipeline can accommodate all of them as additional passes or shader variants. They are features, not foundation work.
