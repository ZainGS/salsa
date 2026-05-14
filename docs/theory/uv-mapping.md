# UV Mapping
**Last Updated:** 2026-05-11

---

## Intuition

UV mapping is origami in reverse. You have a 3D surface and you want to paste a flat image onto it. To do that, you unfold the surface into 2D, mark where every point on the surface ends up in the flat layout, and then the GPU samples the image at those 2D positions when shading each pixel.

The "UV" is just the name for the 2D axes on that flat layout (U = horizontal, V = vertical, both in [0, 1]). Using UV instead of XY avoids confusion with the 3D world axes.

---

## Mental Model

Every vertex on a mesh has, in addition to its 3D position, a 2D UV coordinate. The UV coordinate says "when the GPU is shading this vertex, sample the texture at this (u, v) position." For pixels between vertices, the GPU interpolates UVs across the triangle — so a pixel halfway between two vertices samples halfway between their UV positions.

```
Mesh vertex (x, y, z)  +  UV (u, v)  →  GPU samples texture at (u, v)
```

The UV layout (sometimes called the UV map) is a 2D diagram showing how each triangle of the mesh has been unfolded and placed in the [0, 1] square. Good UV layouts minimize stretching (triangles that are the same size in 3D should be roughly the same size in UV space) and minimize wasted space (UV islands packed tightly).

---

## Formal Explanation

**Per-vertex UVs:** The simplest model. Each vertex has one (u, v) pair. A texture sample is computed by barycentric interpolation of the three vertex UVs across the triangle.

**Per-corner UVs (a.k.a. per-loop or per-face-vertex):** One vertex in 3D space can appear in multiple triangles. With per-vertex UVs, that vertex always gets the same UV regardless of which triangle is using it. With per-corner UVs, the vertex can have different UVs depending on which face is referencing it. This is required for UV seams.

**UV seams:** To unfold a closed surface (anything without a boundary — a sphere, a cube, a character torso), you must cut it. Those cuts are seams. Seam edges appear as boundaries in the UV layout: the edge exists once in 3D but is split into two separate edges in UV space. Vertices along a seam have two different UV coordinates — one for each side of the cut — which is only representable with per-corner UVs.

**Texture filtering:** The GPU doesn't just read one texel at a UV coordinate; it filters nearby texels to avoid aliasing. Bilinear filtering reads 4 texels; anisotropic filtering reads more. UV coordinates outside [0, 1] are handled by the wrap mode: repeat tiles the texture, clamp pins to the edge, mirror flips every other tile.

---

## Why It Matters

UV mapping is how surface detail gets onto geometry. Every painted texture, every material — anything that makes a mesh look like something specific rather than a colored blob — is ultimately a UV-to-texture sampling question.

For mesh painting specifically (which is what Salsa's modeler does), UVs define the painting surface. When you drag a brush across the 3D mesh, the engine converts the world-space pointer position to UV coordinates, then paints into the texture at those UVs. The quality of the UV layout directly determines the quality of the painting experience: bad UVs mean brush strokes stretch or disappear at seams.

---

## Where the Mental Model Breaks

**The seam problem.**
The "unfold the surface" mental model suggests that seams are just cuts and everything still works. The problem is what happens to brush dabs that land *near* a seam.

A brush dab is a circle in UV space. If the dab center is 5px from a seam edge, the 5px radius dab is clipped at the seam boundary in UV space — even though the adjacent surface on the other side of the seam is right there in 3D, only millimeters away from the dab center on the actual mesh. The dab doesn't "wrap" across the seam. You see a sharp unpainted line along every seam edge.

The correct fix is to paint both sides of the seam: when a dab would be clipped by a UV boundary, detect which other UV island is adjacent in 3D, transform the dab into that island's UV space, and paint there too. This requires knowing the 3D edge adjacency of UV boundaries — which is exactly what half-edge meshes track. It's non-trivial to implement and Salsa defers it.

**Per-vertex UVs can't represent seams.**
Salsa's `EditMesh` stores `vertex.uv?: [number, number]` — one UV per vertex. This means a vertex on a seam edge can only ever have one UV coordinate. The `autoUnwrap()` algorithm is designed to minimize the impact of this by projecting planar chunks separately (so seams fall along natural silhouettes where they're least visible), but there's no way to represent a true seam split with per-vertex storage. Future UV seam marking and LSCM unwrap would require migrating to per-corner UVs — a significant data model change.

**GLTF meshes already have per-corner UVs.**
When Salsa imports a GLTF file, the importer reads `TEXCOORD_0` as per-vertex data in the raw buffer, but the GLTF format technically stores per-index UVs (the index buffer can point to different UV values for the same vertex in different triangles). Salsa's importer collapses these to per-vertex by taking the first UV seen per vertex — this is fine for most meshes but drops seam information on models that were UV-unwrapped with explicit seams.

---

## Common Confusions

**"UV [0,1] range means the texture maps exactly once."**
Only with clamp wrapping. With repeat wrapping, UV coordinates outside [0,1] tile the texture. UV (2.5, 1.3) samples the texture tiled 2.5 times in U and 1.3 times in V.

**"Texture resolution determines texture quality."**
Only in combination with texel density — how many UV units of the texture are used per world-space unit of surface. A 4K texture with UVs packed into 10% of the [0,1] square has the same effective texel density as a 400px texture using the full square. UV packing determines how efficiently the texture resolution is used.

**"The UV layout has to be inside [0,1]."**
No — [0,1] is just one tile of an infinite tiling. UVs outside that range sample into adjacent tiles (with repeat wrapping). Some workflows deliberately place UV islands outside [0,1] to use a specific tile of a tiling texture. GLTF models sometimes have UVs slightly outside [0,1] due to precision or deliberate use of repeat.

**"Normals and UVs are the same kind of per-vertex data."**
They're stored the same way but have different interpolation semantics. UV interpolation is straightforward bilinear; normal interpolation happens in the vertex shader and the interpolated normal gets normalized before lighting calculations. Normals also have the per-corner problem (sharp edges need different normals per face for the same vertex) even more acutely than UVs.

---

## How Salsa Uses It

`src/scene-graph/shapes/edit-mesh.ts` — `EditVertex.uv?: [number, number]` is the per-vertex UV storage. `autoUnwrap()` fills these by projecting each vertex along its dominant face-normal axis, then normalizing the results to [0,1] with uniform scale. `_toEditMeshData()` outputs `uvs: this.vertices.map(v => v.uv ? [...v.uv] : [0,0])` for the modifier stack and GPU upload.

`src/renderer/raster/brushes/mesh-painter.ts` — uses UVs to convert the world-space brush position to a texel coordinate in the painted texture. The UV is barycentric-interpolated across the hit triangle (from the ray-mesh intersection), then multiplied by the texture resolution.

`src/renderer/3d/renderer-3d.ts` — `_buildTextureAtlas()` manages a texture 2D array where each GLTF-imported mesh gets a layer. UV coordinates in the vertex buffer are remapped from [0,1] mesh-local to [0,1] within that atlas layer — currently they're the same since each layer is the full [0,1] space.

---

## Related Concepts

- [Half-Edge Meshes](half-edge-meshes.md) — seam edges are boundary edges in UV space; the 3D topology (half-edges) is what lets you find which UV island is on the other side of a seam
- [Coordinate Spaces](coordinate-spaces.md) — UV space is another coordinate system; the brush painter transforms world-space hit position → UV space via the inverse of the mesh's UV projection
- Barycentric Coordinates *(future)* — how the GPU interpolates UVs across a triangle; also how the mesh painter finds the UV at an arbitrary hit point
