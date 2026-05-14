# Polygon Mesh Topology
**Last Updated:** 2026-05-11

---

## Intuition

Geometry is about *where* the vertices are. Topology is about *how* they connect. Two meshes can have completely different geometry — a cube versus a sphere — but identical topology, because both can be continuously deformed into each other without tearing or gluing. A sphere and a cube are the same topological object. A sphere and a donut are not.

The distinction matters for a modeling tool because topology determines what operations are valid. You can loop-cut a cylinder (which has annular topology). You can't loop-cut a triangle fan — there's no continuous edge ring to follow. When an operation fails silently or produces garbage, it's almost always because the topology doesn't match what the algorithm assumes.

---

## Mental Model

Think of a mesh as a rubber sheet. You can stretch it, compress it, and deform it any way you like — but you can't tear it (remove edges or faces), punch holes in it (add holes), or glue parts together (merge unconnected components). Two meshes that can be transformed into each other under these rules are **topologically equivalent**.

The topology of a closed surface is captured by one number: the **genus** (g). A sphere has genus 0 (no holes). A torus (donut) has genus 1 (one hole through it). A double torus (figure-eight pretzel) has genus 2. Adding a handle to a sphere (like a mug's handle) increases the genus by 1.

---

## Formal Explanation

**Euler characteristic:**

For a closed (no boundary), orientable surface:

```
V - E + F = 2 - 2g
```

Where V = vertex count, E = edge count, F = face count, g = genus. This is a topological invariant — it doesn't change under any continuous deformation.

For a sphere (g=0): V - E + F = 2. A cube has 8 - 12 + 6 = 2. ✓
For a torus (g=1): V - E + F = 0. A standard torus mesh with 16×16 grid: 256 - 512 + 256 = 0. ✓

**Manifold meshes:**

A mesh is **2-manifold** (or just manifold) if the neighborhood of every point looks like a disk. Practically:
- Every edge is shared by exactly 1 face (boundary edge) or 2 faces (interior edge). Not 3+.
- Every vertex's one-ring (the faces touching that vertex) forms a disk or a half-disk (no "pinching").

Non-manifold geometry exists and is legal data — the GPU will render it fine — but most mesh algorithms (loop cut, subdivision, UV unwrap, physics) assume manifold meshes and produce wrong results or crash on non-manifold input.

**Windings and normals:**

A face's **winding order** determines which direction the normal points. Counter-clockwise winding (when viewed from outside) is the convention for outward-facing normals (WebGPU backface cull mode `'back'` culls CW-wound faces when viewed from outside).

A consistently wound mesh has all outward-facing normals pointing away from the interior. An inconsistently wound mesh has some faces pointing inward — they'll disappear with backface culling enabled, or light incorrectly.

**Boundary loops:**

An open mesh (not fully closed) has one or more **boundary loops** — closed chains of boundary edges (edges with only one adjacent face). A disk has one boundary loop. A cylinder has two. Identifying and working with boundary loops is the foundation of operations like "fill hole," "bridge loops," and UV seam detection.

---

## Why It Matters

**Mesh algorithms assume manifold geometry.** Loop cut walks the edge ring via `twin → next` traversal. If an edge has 3 faces (non-manifold), there's no unique twin and the traversal breaks — it could go to either adjacent face. Salsa's loop cut bails if it hits a boundary or non-manifold configuration, rather than producing garbage output.

**Winding consistency determines lighting correctness.** A flipped face has its normal pointing inward. With backface culling enabled, it becomes invisible. With culling disabled, it lights correctly on the inside but the face appears "hollow" from outside. This is the most common visual artifact when importing from external tools or after a bad mirror/flip operation.

**UV seams require boundary awareness.** UV islands are separated by seam edges. Seam edges must be boundary edges in the UV unfolding — they're cut open to flatten the surface. Finding seams requires identifying which edges form natural boundaries for unfolding, which requires understanding the mesh's topological structure (loops, one-rings, boundary chains).

**Manifoldness determines physics quality.** PBD cloth simulation and collision detection produce cleaner results on manifold meshes. A non-manifold edge (three faces sharing one edge) creates ambiguous collision normals and can cause cloth particles to tunnel through each other.

---

## Where the Mental Model Breaks

**The rubber-sheet model ignores disconnected components.** A mesh can have two completely separate shells — topologically, that's two surfaces, each with their own genus. The single genus number doesn't capture this. A mesh of a table with four separate legs (five disconnected components) has a different structural character than one watertight shell, even if they have the same V-E+F sum. Salsa doesn't validate or prevent disconnected components; the GPU will render them fine, but operations like "fill hole" or "bridge" may behave unexpectedly if invoked on a disconnected mesh.

**"Manifold" doesn't mean "correct."** A mesh can be perfectly manifold and still have inverted faces (wrong winding), self-intersections (faces that cross through each other in 3D space without sharing any edges), or degenerate geometry (zero-area faces, zero-length edges). Manifoldness is a necessary but not sufficient condition for a "clean" mesh.

**The Euler characteristic is a global property.** It tells you nothing about local geometry. A mesh with V-E+F = 2 is homeomorphic to a sphere *globally* — but locally, it could have very high-valence vertices (a vertex where 20 faces meet), very long and thin triangles, or other quality issues that don't affect the topology but make subdivision, UV unwrapping, and deformation produce poor results.

**Non-manifold edges are common in practice and not always bugs.** An edge shared by three faces can be intentional — think of a T-shaped seam in a box where the interior partition meets the wall. It's non-manifold, but it's what the user wants. Salsa's operations that require manifold geometry bail or warn; they don't refuse to import or display non-manifold meshes.

---

## Common Topology Errors

**Non-manifold edge (T-junction or fan edge):**
An edge shared by 3 or more faces. Usually from a failed boolean, an incomplete bridge, or importing from a CAD tool that allows it. In Salsa's half-edge structure, there's no unique twin for the edge — `_buildTopology` assigns the first twin it finds and ignores the rest.

**Non-manifold vertex (bowtie):**
Two groups of faces touching at a single vertex with no shared edge — like two triangles sharing only their tip. The vertex's one-ring is two disconnected fans, not a disk. UV unwrapping algorithms that walk the one-ring will produce wrong results.

**Flipped face:**
Winding order is opposite to surrounding faces. Invisible with backface culling. Corrected by reversing the vertex order of that face.

**Hole (open boundary where there shouldn't be one):**
A region where faces are missing. Usually from a failed extrude, a deleted face not followed by a fill, or an importer that dropped some faces. Visible as a dark gap in the mesh. Fixable with Salsa's `bridgeEdgeLoops` (if it's a ring-shaped hole) or by manually adding faces.

**T-vertex (hanging vertex):**
A vertex that sits on an edge but isn't connected to it — common in coarse mesh approximations of smooth surfaces. The mesh renders fine but deforms incorrectly and breaks subdivision, which expects every edge midpoint to be a shared vertex.

---

## How Salsa Uses It

`src/scene-graph/shapes/edit-mesh.ts` — `_buildTopology(faceLists)` constructs the half-edge structure from raw face-vertex lists. Manifoldness is implicit: each `from,to` edge pair can only have one half-edge (the edgeMap overwrites duplicates silently). Non-manifold edges end up with incorrect or missing twins.

`insertLoopCut()` — bails if it hits a boundary edge or a twin loop that returns to start prematurely. Loop cut is only valid on a manifold quad strip.

`dissolveEdge()` — checks `twin !== -1` before proceeding; boundary edges can't be dissolved (they'd leave a hole).

`bridgeEdgeLoops()` — trusts the caller to pass genuine open boundary loops. If the loops are not boundary rings (their edges already have two adjacent faces), the bridge creates non-manifold edges silently. The Frogmarks UI should enforce that users select boundary rings before calling bridge.

The modeler targets low-poly stylized meshes, so topology errors are usually immediately visible. A flipped face appears as a dark hole; a non-manifold vertex causes a visible crease in subdivision. The "errors are visible" property is a natural quality-enforcement mechanism for the target use case.

---

## Related Concepts

- [Half-Edge Meshes](half-edge-meshes.md) — the half-edge structure is the data representation of manifold mesh topology; non-manifold meshes break the half-edge invariants
- [UV Mapping](uv-mapping.md) — UV seams are topological cuts that must follow manifold boundary edges; the topology determines where valid seam placements exist
- [Barycentric Coordinates](barycentric-coordinates.md) — barycentric coordinates are defined per triangle; the topology (which triangles exist, how they connect) determines the domain of barycentric computation
