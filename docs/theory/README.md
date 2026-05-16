# Salsa — Graphics & Rendering Theory
**Last Updated:** 2026-05-14

This folder explains the underlying concepts behind Salsa's implementation. The goal is durable understanding — not API documentation, not tutorials, not encyclopedia entries.

Each doc covers one concept from first principles, with emphasis on intuition, mental models, where the standard explanation breaks down, and how Salsa specifically uses or departs from the concept.

---

## Documents

| File | Concept | Why it matters for Salsa |
|------|---------|--------------------------|
| [half-edge-meshes.md](half-edge-meshes.md) | Half-edge mesh topology | The data structure behind EditMesh, loop cut, bevel, bridge, knife cut |
| [coordinate-spaces.md](coordinate-spaces.md) | Object / world / view / clip / screen space | Vertex shaders, screen-space knife cut, ray picking, GP stroke width |
| [uv-mapping.md](uv-mapping.md) | UV coordinates, seams, unwrapping | Mesh painting, GLTF texture import, auto-unwrap |
| [barycentric-coordinates.md](barycentric-coordinates.md) | Triangle interpolation and point testing | Ray-triangle hit, UV lookup at brush position, GP ear-clip fill |
| [scene-graphs.md](scene-graphs.md) | Transform hierarchies, local vs world matrix | Character bone chains, parented cloth/GP, scene serialization |
| [gpu-pipelines.md](gpu-pipelines.md) | Render pipelines, bind groups, state changes | Pipeline pre-baking, vertex color pipeline design, cloth compute |
| [instancing.md](instancing.md) | One draw call for many objects, instance buffers | Mesh batching, particle rendering, vertex color baseVertex edge case |
| [signed-distance-fields.md](signed-distance-fields.md) | Distance-based shape representation | Text rendering, glyph atlas, effect chains (outline/glow/shadow) |
| [depth-buffers.md](depth-buffers.md) | Per-pixel depth testing and occlusion | Opaque/transparent pass ordering, why GP disables depth write |
| [polygon-mesh-topology.md](polygon-mesh-topology.md) | Genus, manifoldness, winding, boundary loops | Why loop cut bails at boundaries, bridge validity, flip normals |
| [euler-rotations.md](euler-rotations.md) | Euler angles, rotation order, decomposition, quaternions | GLB import decomposition (YXZ vs ZYX bug), gizmo local mode, interactive rotation path |
| [texture-restore-bug.md](texture-restore-bug.md) | Three-way failure mode in GLTF texture restore on reload | Name collision → wrong texture; model store degradation → missing buffers; Object.assign clobber → flag cleared |
| [parametric-arrays.md](parametric-arrays.md) | Linked copies via geometry pool key sharing, live edit propagation, bake | How ArrayGroup3D achieves N copies for the GPU cost of one mesh |

---

## Structure of each doc

Every theory doc follows this structure:

1. **Intuition** — One paragraph. What is this thing and why does it exist?
2. **Mental Model** — The informal, holdable picture. Diagrams in words.
3. **Formal Explanation** — Precise definitions and equations, but only after the mental model is established.
4. **Why It Matters** — What operations become possible or practical because of this concept?
5. **Where the Mental Model Breaks** — The seam where the clean mental model stops working. This is usually where the real understanding lives.
6. **Common Confusions** — Specific wrong beliefs that look plausible and are worth preempting.
7. **How Salsa Uses It** — Concrete file/function references. Brief — the reference docs cover the details.
8. **Related Concepts** — Links to other theory docs.
