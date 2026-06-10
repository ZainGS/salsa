# 22 — Mesh Instancing & Texture Sharing
**Last Updated:** 2026-06-10

How to efficiently render many copies of the same mesh and/or texture without redundant GPU uploads or extra draw calls.

---

## Geometry batching — the `geometryKey`

Every `Mesh3D` exposes a `geometryKey: string` that the renderer uses to group draw calls and share vertex/index buffer uploads.

| Mesh type | Key format | Sharing behaviour |
|---|---|---|
| Primitive (`box`, `sphere`, etc.) | `box:1:1:1`, `sphere:0.5:16:12`, … | Meshes with identical parameters share one GPU upload. Multiple nodes → multiple draw calls, but only one VB/IB on the GPU. |
| Custom / GLTF import | `custom:{id}` | Unique per node. Each mesh has its own vertex buffer. No geometry sharing. |
| ArrayGroup3D instances | `array-src:{sourceId}` | Override set automatically. All instances share the source mesh's VB/IB and are drawn in **one GPU instanced draw call**. |
| Modifier stack active | `modifier:{id}` | Also unique — modifiers bake a different result per mesh. |

The batcher (in `Renderer3D`) groups draw calls only when consecutive sorted meshes share the same `geometryKey`, pipeline config, and texture. Primitives with matching parameters automatically qualify; custom meshes never do.

### Forcing shared geometry on custom meshes

If you know two custom meshes have identical geometry (e.g. two GLTF imports of the same file), you can share their vertex buffer:

```typescript
// After both meshes are loaded:
meshB.setGeometryKeyOverride('array-src:' + meshA.id);
// Now both use meshA's VB/IB; meshB.gpuVertexBuffer is ignored by the renderer.
```

**This is advanced / unsupported in the normal UI.** Only do it when you are certain the geometry is byte-identical.

---

## Texture batching — reference equality

The renderer's texture bind-group cache (`_texBindGroupCache`) is keyed by `mesh.id` but invalidates automatically when the `GPUTexture` reference changes (checked by `===`). The batch-grouping loop breaks on:

```
m.diffuseTexture !== lead.diffuseTexture
```

So two meshes that point to the **same `GPUTexture` object** are never split into separate bind-group slots and are drawn together in the same batch. This is pure reference sharing — zero GPU cost, zero CPU copy.

### Atlas mode (for 2D pattern/stamp textures)

Meshes with a `textureLibraryId` that is registered in the atlas get a different, broader batching path: all atlas meshes share **one** `GPUBindGroup` regardless of which layer they sample. This is the mechanism used for 2D vector fills and is unrelated to 3D diffuse textures.

---

## Patterns for common scenarios

### Scenario A — N primitives, same texture

```
10 × box:1:1:1 meshes
  ✓ shared vertex buffer (same geometryKey)
  ✓ shared GPUTexture (after shareUVTexture3D)
  → renderer issues one setBindGroup + N draw calls (one per transform)
```

To get to one draw call you need `ArrayGroup3D`.

### Scenario B — N custom/GLTF meshes, same texture

```
10 × custom:{id} meshes (e.g. imported enemy.glb)
  ✗ separate vertex buffers (different geometryKey)
  ✓ shared GPUTexture (after shareUVTexture3D)
  → N draw calls, but only 1 GPUTexture on the GPU
```

This is the practical "10 enemies" case. You save texture memory and avoid N redundant uploads, but you still pay N draw calls. Acceptable for tens of meshes; use ArrayGroup3D when you need hundreds.

### Scenario C — GPU instancing with ArrayGroup3D

`ArrayGroup3D` is the correct tool when you want **one draw call** for any number of instances of the same source mesh. The renderer computes instance transforms on the CPU each frame and writes them into a shared instance buffer; the GPU shader applies them without separate draw calls.

Limitation: `ArrayGroup3D` does not currently forward a diffuse texture from the UV paint system. Instances inherit the source mesh's `diffuseTexture` reference automatically, so `shareUVTexture3D` still applies — set it on the source mesh and all instances see it.

---

## UV-paint texture sharing workflow

```typescript
// 1. Paint one mesh in the UV editor
const paintCanvas = sm.ensureUVPaintCanvas3D('enemy-0');  // CPU backing canvas
// ... user draws strokes on paintCanvas via its 2D context ...
sm.commitUVTexture3D('enemy-0');  // upload CPU canvas → new GPUTexture → mesh.diffuseTexture

// 2. Stamp the same GPUTexture onto all other enemies — zero GPU cost
sm.shareUVTexture3D('enemy-0', ['enemy-1', 'enemy-2', ... 'enemy-9']);

// 3. If the user repaints enemy-0 later, propagate again:
// (after more strokes on paintCanvas + commitUVTexture3D)
sm.shareUVTexture3D('enemy-0', ['enemy-1', ... 'enemy-9']);
```

`shareUVTexture3D` sets `tgt.diffuseTexture = src.diffuseTexture` by reference on each target, then calls `scheduleRender`. No upload, no copy. Targets do not need to be in edit mode or have a UV session open.

**Important:** the CPU paint canvas (`_uvPaintCanvases`) is per-mesh and is not shared. Only the final `GPUTexture` is shared. If you call `ensureUVPaintCanvas3D('enemy-1')` you get a fresh blank canvas, not a copy of enemy-0's. Edit enemy-0's canvas and re-commit + re-share to propagate changes.

---

## ShapeManager API quick reference

```typescript
// Texture sharing
sm.ensureUVPaintCanvas3D(meshId, size?)   // get/create CPU paint canvas (default 1024×1024)
sm.commitUVTexture3D(meshId)              // upload canvas → GPUTexture → mesh.diffuseTexture
sm.shareUVTexture3D(sourceMeshId, targetMeshIds: string[])  // copy GPUTexture ref to targets

// ArrayGroup3D (GPU instancing)
// — managed via sm.addArrayGroup3D / sm.setArrayParams3D etc. (see 11-services-managers.md)
```

---

## What the renderer actually does per frame (simplified)

1. Sort visible `Mesh3D` nodes by: transparency → `geometryKey` → texture → pipeline flags.
2. Walk the sorted list; start a new batch whenever any of those keys changes.
3. For each batch: `setPipeline` + `setBindGroup` once, then one `draw` per mesh (or one `drawIndexed` instanced call for `ArrayGroup3D`).
4. Texture bind groups are created lazily and cached by `mesh.id`. The cache entry is invalidated automatically when `mesh.diffuseTexture` reference changes.

The upshot: sharing `GPUTexture` references is free and keeps meshes in the same batch. Sharing geometry (`geometryKey`) reduces upload cost. Combining both (same key + same texture) minimises bind-group switches. `ArrayGroup3D` goes further and collapses N draw calls into 1.
