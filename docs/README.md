# Salsa — Project Documentation
**Last Updated:** 2026-05-10

All written context for the Salsa engine and Frogmarks integration lives here.

| Folder | What's inside | Who reads it |
|--------|--------------|--------------|
| [`reference/`](reference/) | Engine internals manual (numbered 00–19) | Anyone understanding how Salsa works |
| [`specs/`](specs/) | Feature implementation plans with ✅/🔄/📋 status | Engine contributors |
| [`ui/`](ui/) | Frogmarks UI integration guides | Frogmarks Angular developers |
| [`migrations/`](migrations/) | API change guides for breaking changes | Frogmarks developers upgrading |
| [`theory/`](theory/) | Graphics & rendering concepts — intuition-first, transferable beyond Salsa | Engine contributors building deep understanding |
| [`case-studies/`](case-studies/) | Post-mortems on hard bugs — symptom → diagnosis → fix + lessons | Anyone debugging similar issues |

---

---

## `specs/` — Engine Implementation Specs

What Salsa is building or has built. These are engine-level design documents covering architecture, data structures, and implementation plans. They track completion status (📋 Not Started / 🔄 In Progress / ✅ Complete) at the top.

| File | Feature | Status |
|------|---------|--------|
| [array-tool.md](specs/array-tool.md) | Array/Repeat tool — linear, grid, radial | ✅ Phases 1–3 Complete |
| [modeler.md](specs/modeler.md) | Frogmarks Modeler — mesh painting, EditMesh, half-edge topology | Phase 1–2–3 ✅ |
| [kitbash-armature-grease-pencil.md](specs/kitbash-armature-grease-pencil.md) | Kitbashing, armature rig, grease pencil | Phase A–B–C ✅ |
| [salsa-viewer.md](specs/salsa-viewer.md) | `<salsa-viewer>` web component + CDN embed | ✅ Complete |
| [brush-engine-roadmap.md](specs/brush-engine-roadmap.md) | Realistic brush engine (dual brush, color jitter, smudge, bleed) | ✅ Complete |
| [cloth-simulation.md](specs/cloth-simulation.md) | PBD cloth simulation V1 | ✅ Complete |
| [cloth-simulation-v2.md](specs/cloth-simulation-v2.md) | Cloth V2 — live preview, wind animation (proposed) | ✅ Complete |
| [gltf-import.md](specs/gltf-import.md) | OBJ + GLTF/GLB import pipeline | ✅ Complete |
| [render-styles.md](specs/render-styles.md) | Cel / sketch / ink render styles per mesh | ✅ Complete |
| [html-canvas-3d.md](specs/html-canvas-3d.md) | HTML-in-Canvas 3D texture + ribbon mesh | ✅ Complete |
| [3d-illustration-mode.md](specs/3d-illustration-mode.md) | Fixed-camera illustration mode | ✅ Complete |
| [project-package.md](specs/project-package.md) | `.frogmarks` ZIP format | ✅ Complete |
| [frame-link-animation.md](specs/frame-link-animation.md) | Frame link animation system | ✅ Complete |
| [layer-folders-3d-divider.md](specs/layer-folders-3d-divider.md) | Layer folders + 3D scene divider | ✅ Complete |
| [text-effects.md](specs/text-effects.md) | SDF text effect chains | ✅ Complete |
| [hair-styles.md](specs/hair-styles.md) | Procedural hair style system — bob / bun / braid / spiky / afro / curly / drills etc. via reusable primitives + modifiers + presets (phased A–E) | 🔶 Planned |
| [depth-precision.md](specs/depth-precision.md) | Perspective z-fighting — adaptive near plane (Phase 1) + reversed-Z on depth32float (Phase 2, `DepthConvention` module) | ✅ Phase 1 Built |
| [creator-modes.md](specs/creator-modes.md) | The platform spec — Creator Modes for every generator (Tree/Door/Vehicle/Building… like the Character Creator), the generator contract + param schemas, preset POOLS feeding the city compiler, full generator catalog | 📋 Spec |
| [shoe-generation.md](specs/shoe-generation.md) | Procedural footwear — sneaker / flat / boot / heel, fit to the foot joint, as a third clothing slot (`'shoes'`) | ✅ Phase 1 Built |
| [wardrobe-expansion.md](specs/wardrobe-expansion.md) | Roadmap — charms/accessories engine, draw→geometry (zippers/embroidery), garment upgrades (taper/cutouts/layering), draped garments (scarf/cloak/hijab) | 📋 Phased (1A taper Built) |
| [packaging-templates.md](specs/packaging-templates.md) | Packaging roadmap — 7 structural MECHANISMS → box catalog (tuck-end/mailer/sleeve/rigid…), print-PDF manufacturing export (cut/crease spot layers), studio-stage polish pass, inserts/modifiers; booth-planner explicitly deferred | 📋 Spec |

---

## `ui/` — Frogmarks UI Integration Guides

How the Frogmarks Angular app should wire UI panels and controls to Salsa APIs. Each file describes panel layouts, event wiring, keyboard shortcuts, and code samples — everything a Frogmarks developer needs to implement the UI side of a feature.

| File | Feature area |
|------|-------------|
| [mesh-editing.md](ui/mesh-editing.md) | Edit Mode: vertex/face selection, extrude/inset/delete/weld, vertex colors, modifier stack |
| [mesh-painting.md](ui/mesh-painting.md) | Mesh paint mode panel, pointer event routing, undo |
| [kitbash.md](ui/kitbash.md) | Character creator panel, part grid, slot wiring, color tints, posing |
| [grease-pencil.md](ui/grease-pencil.md) | GP drawing tool: objects, layers, strokes, bone parenting, keyframes |
| [may2026-handoff.md](ui/may2026-handoff.md) | May 2026 handoff: brush bleed/smudge, `<salsa-viewer>`, keyframe undo |
| [3d-phase4.md](ui/3d-phase4.md) | Shadows, 3D undo/redo, frustum culling, animation sync, arrowheads, raster text, connectors |
| [3d-scene.md](ui/3d-scene.md) | 3D scene panel, mesh list, transform, material, texture slots |
| [animation.md](ui/animation.md) | Timeline, frame controls, playback |
| [brush.md](ui/brush.md) | Brush preset picker, dynamics, stabilization |
| [raster.md](ui/raster.md) | Raster paint panel, layer controls |
| [raster-move-tool.md](ui/raster-move-tool.md) | Raster pixel move/grab tool |
| [cloth.md](ui/cloth.md) | Cloth simulation controls |
| [cloth-handoff.md](ui/cloth-handoff.md) | Cloth feature handoff doc |
| [compositor-layers.md](ui/compositor-layers.md) | Layer blend modes, opacity, clipping masks |
| [selection-tools.md](ui/selection-tools.md) | Rect/ellipse/lasso select, move/scale/rotate |
| [selection-persistence.md](ui/selection-persistence.md) | Saving/restoring selection state |
| [dither.md](ui/dither.md) | Dither effect controls (global + per-layer) |
| [particle.md](ui/particle.md) | Particle emitter controls |
| [html3d.md](ui/html3d.md) | HTML-in-Canvas 3D texture panel |
| [ribbon3d.md](ui/ribbon3d.md) | 3D ribbon mesh controls |
| [livetext.md](ui/livetext.md) | LiveText + speech bubble effects |
| [speech-balloon.md](ui/speech-balloon.md) | Speech balloon tool wiring |
| [text-and-speech-bubble.md](ui/text-and-speech-bubble.md) | Text + speech bubble architecture overview |
| [balloon-panel.md](ui/balloon-panel.md) | Balloon panel layout spec |
| [tools.md](ui/tools.md) | Tool toolbar and tool switching |
| [polygon.md](ui/polygon.md) | Polygon and preset shape tools |
| [document-size.md](ui/document-size.md) | Artboard size, new illustration dialog |
| [medium-effort.md](ui/medium-effort.md) | Medium-effort UI work (grid snap, multi-material) |
| [quick-wins.md](ui/quick-wins.md) | Quick-win UI items (duplication, easing curves) |
| [onboarding.md](ui/onboarding.md) | Claude Code + Frogmarks developer onboarding |
| [array-tool.md](ui/array-tool.md) | Repeat panel, count/spacing controls, gizmo, Edit Source, Bake |

---

## `migrations/` — API Change Guides

Short guides for Frogmarks developers when a Salsa API breaks or changes naming conventions.

| File | What changed |
|------|-------------|
| [shapemanager.md](migrations/shapemanager.md) | Legacy ShapeManager calls → delegate managers |
| [arrowhead-styles.md](migrations/arrowhead-styles.md) | Arrowhead style enum changes |

---

## `case-studies/` — Bug Post-Mortems

Deep dives on hard bugs: what the symptom was, how it was diagnosed, what the root cause turned out to be, and what lessons apply to future work.

| File | Bug |
|------|-----|
| [gltf-multimesh-exploded-parts.md](case-studies/gltf-multimesh-exploded-parts.md) | Multi-mesh GLB import: parts rendered at wrong scales (async override of correct import scales) |
| [webgpu-instance-stride-mismatch.md](case-studies/webgpu-instance-stride-mismatch.md) | Hover highlight invisible on all but first mesh (WGSL struct stride < CPU MESH_INSTANCE_STRIDE) |

---

## Key reference docs

- [reference/00-architecture-overview.md](reference/00-architecture-overview.md) — start here for a full system map
- [reference/11-services-managers.md](reference/11-services-managers.md) — ShapeManager and all delegate manager APIs
- [reference/15-3d-rendering-system.md](reference/15-3d-rendering-system.md) — 3D renderer, MeshPicker, mesh painting
