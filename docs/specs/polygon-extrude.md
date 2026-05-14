# Polygon Extrude — Spec
**Status:** ✅ Shipped
**Last Updated:** 2026-05-11

---

## Problem

The EditMesh system ships with box, sphere, and cylinder primitives. Frogmarks users who want stylized characters or illustration props need to sketch arbitrary 2D silhouettes and extrude them into 3D meshes — a "draw shape → get 3D object" workflow. No such path existed before this feature.

---

## Entry Points

Two static constructors on `EditMesh`, plus two ShapeManager convenience methods:

| API | Description |
|-----|-------------|
| `EditMesh.fromPolygon(points, height?)` | Arbitrary n-gon from XZ-plane points |
| `EditMesh.fromCircle(radius, segments, height?)` | Regular n-gon shorthand |
| `sm.addPolygonMesh3D(x, y, z, points, height?, name?)` | Scene creation (polygon) |
| `sm.addCircleMesh3D(x, y, z, radius, segments?, height?, name?)` | Scene creation (circle) |

All four return a `Mesh3D` with `editMesh` pre-attached — the result is immediately editable without calling `enterEditMode3D` first.

---

## Algorithm

### Input

`points: [number, number][]` — 2D coordinates in the **XZ plane** (Y is up). Each tuple is `[x, z]`. Minimum 3 points.

`height: number` — extrusion distance along +Y. Defaults to `1`. Set to `0` for a flat n-gon cap with no sides.

### Winding normalization

Salsa uses CCW winding for outward normals (WebGPU `cullMode: 'back'` culls CW faces).

The signed area test determines input winding:

```
signedArea = Σ (x[i] * z[i+1] - x[i+1] * z[i]) / 2
```

If `signedArea < 0` the input points are CW; the array is reversed so all faces are consistently wound.

### Vertex layout

For a polygon with `n` points and `height > 0`:

```
Bottom ring:  indices 0 … n-1   (y = 0)
Top ring:     indices n … 2n-1  (y = height)
```

For `height = 0`:

```
Single ring:  indices 0 … n-1   (y = 0)
```

### Face list

**Flat (height = 0):**
- One n-gon: `[0, 1, 2, …, n-1]` (single CCW face from above)

**Prism (height > 0):**
- Bottom cap:  `[n-1, n-2, …, 0]` — reversed to produce outward -Y normal
- Top cap:     `[n, n+1, …, 2n-1]` — CCW from above for outward +Y normal
- `n` side quads: `[i, (i+1)%n, n+(i+1)%n, n+i]` for i in 0…n-1

Side quad winding is consistent with bevel edge quads in the same file.

### `fromCircle` convenience

Generates `segments` equally-spaced XZ points on a circle of the given radius, then delegates to `fromPolygon`.

```
theta_i = 2π * i / segments     (for i in 0 … segments-1)
point_i = [radius * cos(theta_i), radius * sin(theta_i)]
```

---

## Scene-creation pattern

`addPolygonMesh3D` and `addCircleMesh3D` in `ShapeManager`:

1. Call `EditMesh.fromPolygon(points, height)` to build the EditMesh.
2. Compile to `MeshGeometry` via `em.compile()`.
3. Create `Mesh3D` at (x, y, z) with `primitive: 'custom'` and the compiled geometry.
4. Set `mesh.editMesh = em` and `mesh.vertexColors = geom.vertexColors ?? null`.
5. Register in scene graph, push undo command, schedule render.

The mesh starts with an EditMesh attached so `enterEditMode3D` immediately enables vertex/face selection without a `makeEditable()` round-trip.

---

## Frogmarks UI Pattern

```typescript
// Draw a leaf-like silhouette and extrude
const leafPoints: [number, number][] = [
  [0, 0], [0.3, 0.5], [0, 1.2], [-0.3, 0.5]
];
const leaf = sm.addPolygonMesh3D(0, 0, 0, leafPoints, 0.1, 'Leaf');

// Draw a rounded gem
const gem = sm.addCircleMesh3D(0, 0, 0, 0.5, 6, 0.4, 'Gem');

// Immediately enter edit mode (no makeEditable needed)
sm.enterEditMode3D(gem.id);
```

---

## Related Docs

- [Modeler Spec](modeler.md) — polygon extrude listed in Phase 2 primitives
- [Mesh Editing UI](../ui/mesh-editing.md) — how to enter edit mode after creation
- [Services / Managers Reference](../reference/11-services-managers.md) — addPolygonMesh3D, addCircleMesh3D API
- [Half-Edge Meshes](../theory/half-edge-meshes.md) — topology invariants that `fromPolygon` must satisfy
