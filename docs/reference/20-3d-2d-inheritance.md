# 3D Nodes in the 2D Scene Graph
**Last Updated:** 2026-05-15

---

## The Inheritance Chain

All nodes — 2D and 3D — descend from the same base class:

```
Node
  └── Shape                    ← 2D transform, fill/stroke, bounding box, hit-test
        ├── Mesh3D             ← 3D mesh (geometry, material, GPU draw)
        ├── ParticleEmitter3D  ← 3D particle system
        ├── Skeleton3D         ← 3D armature
        └── Group              ← 2D container with children + bounding box
              ├── Section      ← 2D labeled region
              └── MeshGroup3D  ← 3D mesh group (collapses in outliner)
                    └── ArrayGroup3D  ← parametric repeat array
```

`Mesh3D` extends `Shape` (not `Group`) because it is a leaf node — it owns geometry, not children.  
`MeshGroup3D` extends `Group` because it is a container — it has children and participates in the scene-graph hierarchy.

---

## What This Means in Practice

### The Purple Selection Box

When an `ArrayGroup3D` or `MeshGroup3D` is selected, the **2D renderer draws a selection bounding box** (the purple rectangle visible in the viewport). This happens because both classes inherit from `Group`, which has `calculateBoundingBox()` and participates in the 2D selection pass.

The bounding box is computed in 2D screen coordinates from the group's `width`/`height` fields and its `x`/`y` position. For 3D groups, these fields reflect the 2D projection of the children's extents and generally aren't meaningful — but the bounding box renders regardless.

**This is expected behavior.** The 2D selection box co-exists with the 3D gizmos. The 2D box is drawn by the vector renderer; the 3D gizmos (axis shafts, spheres) are drawn by the gizmo renderer in the 3D overlay pass.

If the purple box is visually distracting when a 3D group is selected, the fix is to make `Group.calculateBoundingBox()` or `toJSON()` check for 3D group subclasses and skip the 2D bounding box draw — but this hasn't been necessary yet.

### Scene Graph Position vs. 3D Position

`Shape.x` / `Shape.y` are the 2D canvas position. `Mesh3D` overrides `x`, `y`, `z` with its 3D world position (z is separate). The 2D scene graph ignores z. 3D rendering uses the full `(x, y, z)` triple.

For a `Mesh3D` placed at `(200, 300, -50)`:
- The 2D hit-test and 2D selection box use `(200, 300)`.
- The 3D renderer uses `(200, 300, -50)` for the world-space transform.

This coupling is intentional: it lets the 2D scene graph handle transform history (undo/redo, parenting, ordering) while the 3D renderer handles the visual output. All three dimensions are persisted via `toJSON()` / `recreateNode()`.

### Serialization Split

3D nodes serialize themselves as 2D scene-graph nodes AND as separate 3D mesh states:

| Path | What it stores | Used by |
|------|---------------|---------|
| `sceneGraphJSON` (2D) | `Node` hierarchy, IDs, names, x/y/z positions, group membership | `setSceneGraphJSON` → `recreateNode` |
| `scene3dJSON` (3D) | Per-mesh geometry, materials, keyframe tracks, GLB buffers | `restoreScene3DNodes` → `scene3d.restoreMeshState` |

On load, the 2D pass runs first (restores groups with their IDs), then the 3D pass runs (restores mesh geometry and re-parents meshes into their groups).

`ArrayGroup3D` specifically:
- **2D save** (`toJSON`): stores `sourceId`, `arrayParams`, and child copy nodes.
- **3D save** (`_buildMeshState`): stores each copy's geometry individually via `getAllMeshes()`.
- **On load**: `recreateNode` creates the `ArrayGroup3D` shell with copies as children, then `restoreDocumentState` re-applies `geometryKeyOverride` on all copies and the source so the geometry pool sharing is restored.

### Why Not Separate 3D and 2D Types?

The unified base class means:
- Undo/redo, clipboard, layer ordering, parenting, and visibility all work on 3D nodes without any 3D-specific code in those systems.
- The scene graph is the single source of truth for what exists. 3D rendering is just a renderer that reads from it.
- Adding a 3D node to a layer, locking it, or nesting it inside a group "just works" because `Node` handles all of that.

The downside is that 3D nodes carry 2D fields (`fillColor`, `strokeColor`, `width`, `height`) that are meaningless for them, and the 2D renderer may draw artifacts (like the selection bounding box) for 3D groups. These are cosmetic issues that can be addressed individually without changing the inheritance structure.

---

## Audit Checklist

If something looks wrong with 3D group selection or serialization, check:

1. **Purple bounding box on wrong node** — `Group.calculateBoundingBox()` is called by the 2D renderer for any selected `Shape`. For 3D groups, `width`/`height` may be `1` (default) or miscalculated. No bug unless it's intercepting clicks.

2. **`recreateNode` missing a case** — If a new 3D node type doesn't have a `case` in `recreateNode`, it falls to `default: new Node()` and loses all its data on save/load. Every concrete 3D class needs its own case.

3. **Geometry not sharing after load** — `geometryKeyOverride` is not persisted by `Mesh3D.toJSON()`. It must be re-applied after restore. `ArrayGroup3D` restoration does this in the `restoreDocumentState` fixup loop.

4. **`getMesh()` returns null for groups** — `getMesh(id)` checks `instanceof Mesh3D`. `ArrayGroup3D` and `MeshGroup3D` are NOT `Mesh3D` — they are `Group` subclasses. Use `getMeshGroup(id)` or direct `instanceof` checks for groups.
