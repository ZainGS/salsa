# Half-Edge Meshes
**Last Updated:** 2026-05-11

---

## Intuition

A face-vertex list tells you *what* a mesh is made of. A half-edge mesh also tells you *how the pieces connect*.

With a face-vertex list you can answer "what vertices make up face 5?" in O(1). But you can't answer "what face is on the other side of this edge?" without scanning every face. For most rendering that's fine. For any editing operation — loop cut, bevel, dissolve, bridge — you need adjacency, constantly. That's the whole reason half-edge meshes exist.

---

## Mental Model

Imagine standing on a face and looking along one of its edges. The edge you're looking along is your half-edge. The guy standing on the neighboring face, looking back at you along the same edge, owns the *twin* half-edge.

Every edge in the mesh is split into two directed half-edges — one per adjacent face. Each half-edge knows four things:

```
half-edge → {
  vertex:  where I'm pointing (destination vertex)
  twin:    the half-edge going the opposite direction on the other face
  next:    the next half-edge around my face (going counterclockwise)
  prev:    the previous half-edge around my face
  face:    which face I belong to
}
```

And each vertex stores one outgoing half-edge — just a starting handle, enough to begin any traversal from that vertex.

That's the whole structure. Five fields per half-edge. Everything else is traversal.

---

## Formal Explanation

For a mesh with V vertices, E edges, F faces:
- You have 2E half-edges (two per edge).
- Each face of n vertices has exactly n half-edges forming a closed loop: `he.next.next...next === he`.
- Boundary edges have `twin = -1` (no neighboring face).
- The face's half-edge ring gives you vertices in winding order: walk `next` until you return to start, collecting `he.vertex` each step.

**Key traversals:**

Walk a face's vertices:
```
he = face.halfEdge
do { collect he.vertex; he = he.next } while (he !== face.halfEdge)
```

Get the source vertex of a half-edge (it stores the destination):
```
source = halfEdges[he.prev].vertex
```

Walk the edge ring (for loop cut):
```
he = startHalfEdge
loop:
  he = he.twin   // cross to neighbor face
  he = he.next   // advance around that face
  // he is now the next half-edge in the edge ring
until he === startHalfEdge
```

Find the two faces sharing an edge:
```
faceA = he.face
faceB = he.twin.face  // -1 if boundary
```

---

## Why It Matters

Every non-trivial edit operation is adjacency. Half-edges make those O(1):

| Operation | What it needs |
|-----------|--------------|
| Loop cut | Walk the edge ring: `twin` → `next` → `twin` → `next`… |
| Edge dissolve | Find the two faces on either side of the edge: `he.face`, `he.twin.face` |
| Bevel | Find neighbors of each endpoint: walk around vertex using `twin.next` |
| Bridge | Fill between two vertex rings — just add new faces, rebuild topology |
| Knife cut | For each face, check each of its edges: collect them via half-edge ring |

None of these are practical without O(1) adjacency. With a face-vertex list, finding "what faces touch vertex V" requires scanning every face. With half-edges, you fan-out from `vertex.halfEdge` using `twin.next` in a tight loop.

---

## Where the Mental Model Breaks

**Boundaries.** The directed-graph mental model assumes every edge has two faces. Real meshes have holes. When `he.twin === -1`, you're on a boundary, and the "walk around the edge ring" traversal breaks — you'll try to dereference halfEdges[-1].

You have to handle boundaries explicitly everywhere. In Salsa's loop cut, the traversal bails out when it hits a boundary half-edge rather than completing the ring. In bevel, both adjacent faces are required — it silently exits if either face is missing.

**Rebuilding is expensive.** The half-edge structure is not incrementally updatable in practice. After any topology change (add a face, split an edge, dissolve an edge) the edgeMap-based twin-linking has to re-run from scratch. Salsa's `_buildTopology(faceLists)` does this: clear everything, rebuild from the raw face-vertex lists. This is fine for interactive editing where operations are discrete, but you couldn't run it in a tight loop.

**The vertex stores an outgoing half-edge, not incoming.** This is the convention Salsa uses. It means `halfEdges[v.halfEdge].prev.vertex` gives you a neighbor of `v` — but which neighbor is arbitrary depending on build order. If you need a specific neighbor (the one opposite a given edge), you have to walk.

---

## Common Confusions

**"Half-edge.vertex is the destination, not the source."**
This trips everyone up once. The half-edge goes *from* `halfEdges[he.prev].vertex` *to* `he.vertex`. Src is in prev, dest is in self.

**"Why is the vertex's halfEdge outgoing?"**
Convention. Outgoing means `he.prev.vertex === v` and `he.vertex === some_neighbor`. It gives you a handle to start fan traversals. Incoming would work equally well, just flipped.

**"Rebuilding topology from face lists loses my half-edge indices."**
It does. After any `_buildTopology()` call, stored half-edge indices are invalid. Salsa's undo system saves the full `toJSON()` snapshot (which serializes face-vertex lists, not half-edge indices) for this reason.

---

## How Salsa Uses It

`src/scene-graph/shapes/edit-mesh.ts` — `EditMesh` stores `vertices: EditVertex[]`, `faces: EditFace[]`, `halfEdges: EditHalfEdge[]`.

`_buildTopology(faceLists)` is the single constructor: clear everything, iterate face lists, push half-edges, then re-link twins via an edgeMap keyed on `"from,to"` string pairs.

`_getFaceVerts(fi)` is the core traversal used everywhere — it walks the half-edge ring and returns vertex indices in winding order.

The topology is rebuilt from scratch after every destructive operation (loop cut, dissolve, bevel, bridge, knife cut). Before the operation, face lists are extracted via `_getAllFaceLists()`, modified, then fed back into `_buildTopology()`.

---

## Related Concepts

- [UV Mapping](uv-mapping.md) — UV seams live on boundary edges; the half-edge structure is what makes "is this edge a seam?" queryable
- [Topology](topology.md) *(future)* — genus, manifoldness, Euler characteristic — the things half-edge meshes help you compute
- [Coordinate Spaces](coordinate-spaces.md) — once you have topology, you need to know *where* vertices live; the two are orthogonal
