# Case Study: Hover Highlight Invisible on All But First Mesh — WebGPU Storage Buffer Stride Mismatch

**Date:** 2026-05-14  
**Files fixed:** `src/renderer/3d/shaders/highlight-shaders.ts`  
**Fix size:** 8 lines (4 u32 padding fields added to each of 2 WGSL structs)  
**Time to find:** ~2 sessions

---

## The Problem

When hovering over 3D meshes in the scene, only one mesh ever showed the hover highlight outline. The other meshes were hovered correctly (pick3D returned their IDs), the CPU-side highlight pipeline executed correctly for all meshes, but only the mesh that happened to occupy **instance slot 0** ever rendered a visible outline.

Selection highlights (AABB box wireframe) worked correctly for all meshes at all times. The bug was isolated to hover outlines.

---

## Highlight System Architecture

The hover outline uses a two-pipeline stencil technique implemented in `MeshHighlightPass`:

```
Per hover highlight draw (MeshHighlightPass.draw):

  Step 1 — Stencil write (stencilPipeline, ref=1):
    Draw original mesh into stencil buffer only (no color writes).
    stencil=1 is set at every visible pixel of the mesh.

  Step 2 — Outline draw (outlinePipeline, ref=1):
    Draw expanded mesh (vertices pushed along normals by outlineWidth).
    Stencil compare='not-equal' (ref=1) → only draws OUTSIDE the silhouette.
    Result: clean ring outline regardless of mesh shape.

  Step 3 — Stencil clear (stencilPipeline, ref=0):
    Re-draw original mesh with ref=0 to reset stencil for the next slot.
    (Hover and selection are drawn as separate slots in the same pass.)
```

The shaders for both pipelines live in `highlight-shaders.ts` and read mesh transforms from the same storage buffer (`instances: array<MeshInstance>`) used by the main render pipelines.

---

## Instance Buffer Layout

`uploadMeshInstances` in `renderer-3d.ts` fills a shared `GPUBuffer` (the instance storage buffer) with one slot per mesh. Each slot is `MESH_INSTANCE_STRIDE = 192` bytes:

```
Slot layout (renderer-3d.ts, writeSlot):

  floats  0–15  │ modelMatrix   (mat4x4, 64 bytes)
  floats 16–31  │ normalMatrix  (mat4x4, 64 bytes)  ← inverse-transpose for lighting
  floats 32–35  │ diffuseColor  (vec4,   16 bytes)
  floats 36–39  │ specularColor (vec4,   16 bytes)
  floats 40–43  │ emissiveColor (vec4,   16 bytes)  ← .w = encodedMaterialFlags (u32)
  floats 44–45  │ texIndex / normIndex              (2 × u32, 8 bytes)
  floats 46–47  │ (padding)                         (2 × u32, 8 bytes)
                 ─────────────────────────────────────────────────
  Total          192 bytes  =  MESH_INSTANCE_STRIDE
```

The highlight shaders need only `modelMatrix` (for the stencil pass) and `modelMatrix + normal` (for the outline expansion). Everything after `emissiveColor` can be padding from the shader's perspective — but the struct must still be **the right size** so that `instances[iIdx]` indexes into the correct slot.

---

## The Bug: WGSL Struct Stride Mismatch

The `MeshInstance` struct in `highlight-shaders.ts` (used in both `STENCIL_WRITE_SHADER` and `HIGHLIGHT_SHADER`) was:

```wgsl
struct MeshInstance {
  modelMatrix:  mat4x4<f32>,   // 64 bytes
  normalMatrix: mat4x4<f32>,   // 64 bytes
  diffuseColor: vec4<f32>,     // 16 bytes
  specularColor: vec4<f32>,    // 16 bytes
  emissiveColor: vec4<f32>,    // 16 bytes
}
// WGSL-computed struct size: 176 bytes
// Actual MESH_INSTANCE_STRIDE:  192 bytes  ← 16 bytes short
```

In WGSL, `array<MeshInstance>` uses a stride equal to `roundUp(align(MeshInstance), sizeof(MeshInstance))`. The alignment of `MeshInstance` is 16 (from `mat4x4`), and the size is 176 — which is already a multiple of 16. So the WGSL array stride is **176 bytes**.

But the CPU writes slots at **192-byte** intervals. This creates the following misalignment:

```
CPU slot layout (192-byte stride):        WGSL array<MeshInstance> view (176-byte stride):

 Byte   0 ┌──────────────────────────┐     instances[0] starts at byte   0   ✓ correct
           │  slot 0: modelMatrix     │
           │  slot 0: normalMatrix    │
           │  slot 0: colors          │
           │  slot 0: flags/texIdx    │
Byte 192   └──────────────────────────┘
           │  slot 1: modelMatrix     │     instances[1] starts at byte 176   ✗ WRONG
           │  slot 1: normalMatrix    │         reads 16 bytes inside slot 0's padding,
           │  slot 1: colors          │         then 160 bytes of slot 1's fields —
           │  slot 1: flags/texIdx    │         a garbage matrix that places the outline
Byte 384   └──────────────────────────┘         somewhere off-screen or behind the mesh
           │  slot 2: modelMatrix     │     instances[2] starts at byte 352   ✗ WRONG
           ...
```

`instances[0]` always reads a correct `modelMatrix` because it starts at offset 0 regardless of stride. Every other slot reads a garbage matrix.

This is why the hover highlight appeared on exactly one mesh no matter how many meshes were in the scene: whichever mesh happened to occupy slot 0 (assigned by the sorted order in `uploadMeshInstances`) would render correctly, and all others would place the outline at an off-screen or invalid position.

---

## Why Selection Worked But Hover Did Not

Selection highlights use the AABB box wireframe drawn by `GizmoRenderer`, which computes the bounding box from CPU-side mesh data and passes the box corners directly as uniform data — it never reads from the instance storage buffer. That path is entirely unaffected by the stride mismatch.

---

## Diagnosis Process

### Step 1: Confirm the CPU pipeline

Debug logs were added at two points:

**`scene3d-manager.ts` — `enableTransformControls` mousemove handler:**
```typescript
const hit = this.pick3D(px, py, el.width, el.height);
console.log('[hover] pick3D:', hit ? `"${mesh.name}" dist=...` : 'null');
this.setHoveredMesh(hit?.meshId ?? null);
```

**`renderer-3d.ts` — `toEntries` inside `drawMeshes`:**
```typescript
if (!pair) { console.log('[hover] toEntries: no pair for', id); return []; }
if (!alloc) { console.log('[hover] toEntries: no geomAlloc for', id); return []; }
console.log('[hover] toEntries: OK id', id, 'idx', pair.idx);
```

Both meshes logged `toEntries: OK`. The full chain — `pick3D → setHoveredMesh → setHoveredMeshIds → drawMeshes → hoverOnly filter → toEntries → _highlightPass.draw()` — executed correctly for both meshes.

### Step 2: Spot the pattern

Logs from two test hovers:

```
Non-working mesh:  [hover] toEntries: OK id f27f9c41  idx 1
Working mesh:      [hover] toEntries: OK id 830012eb  idx 0
```

The working mesh always had `idx 0`. The non-working mesh always had `idx > 0`.

### Step 3: Trace idx through the GPU path

`idx` is the `instanceIdx` field in `HighlightMeshEntry`, passed as the `firstInstance` argument in `drawIndexed`. The WGSL shader reads `instances[instanceIdx]` from the storage buffer. With a stride mismatch, `instances[1]` → wrong matrix.

### Step 4: Measure the mismatch

- `MESH_INSTANCE_STRIDE` in `renderer-3d.ts`: **192 bytes**
- `sizeof(MeshInstance)` in `highlight-shaders.ts`: **176 bytes** (5 × vec4/mat4 = 5 × 16 or 64 bytes each)
- Delta: **16 bytes** = exactly the `texIndex/normIndex/pad` fields at floats 44–47

---

## The Fix

Add the missing 4-field padding block to `MeshInstance` in both shaders in `highlight-shaders.ts`:

```wgsl
struct MeshInstance {
  modelMatrix:  mat4x4<f32>,
  normalMatrix: mat4x4<f32>,
  diffuseColor: vec4<f32>,
  specularColor: vec4<f32>,
  emissiveColor: vec4<f32>,
  // 16 bytes padding — matches MESH_INSTANCE_STRIDE = 192 (texIndex/normIndex + 2 pad u32)
  _texIndex:  u32,
  _normIndex: u32,
  _pad0:      u32,
  _pad1:      u32,
}
// WGSL-computed struct size: 192 bytes  ✓ matches MESH_INSTANCE_STRIDE
```

The padding fields are never read by either shader — only `modelMatrix` and `normal` are accessed. They exist purely to make the WGSL array stride match the CPU stride.

---

## Debugging Lessons

### 1. GPU struct stride bugs are invisible to the CPU

All CPU-side logic — pick3D, setHoveredMesh, toEntries, drawIndexed parameters — was entirely correct. The bug was only detectable by examining the WGSL struct definition and comparing its byte size against the CPU stride constant. No amount of CPU-side logging could surface it.

### 2. The `idx 0 always works` pattern is the key diagnostic

Any bug in which the first instance of a GPU array works correctly but subsequent instances don't is almost always a stride mismatch. The first element starts at byte 0 regardless of stride; every other element is offset by `N * stride_cpu` (CPU side) vs `N * stride_wgsl` (GPU side), and the two diverge as soon as `stride_cpu ≠ stride_wgsl`.

### 3. Separate-path structs drift when the storage buffer layout grows

The main mesh shaders (`mesh3d-shaders.ts`, `shadow-shaders.ts`) had their `MeshInstance` structs updated when `texIndex`/`normIndex` were added to the storage buffer. The highlight shaders (`highlight-shaders.ts`) were a separate file added later for a different feature, and they defined their own copy of `MeshInstance` with only the fields they needed — not the full layout. When the storage buffer grew, only the main shaders were updated.

**Rule:** Any WGSL struct that indexes a `array<T>` from a shared storage buffer must match the full CPU stride of that buffer, even if the shader only reads a subset of fields. Unused fields must still appear as padding.

### 4. `MESH_INSTANCE_STRIDE` is the single source of truth

`MESH_INSTANCE_STRIDE = 192` is defined in `renderer-3d.ts` (line 87). Every WGSL struct that accesses `instances: array<MeshInstance>` must be 192 bytes. Verify by counting: `sizeof(mat4x4) × 2 + sizeof(vec4) × 3 + sizeof(u32) × 4 = 64+64+16+16+16+16 = 192`.

---

## Related Files

- [src/renderer/3d/shaders/highlight-shaders.ts](../../src/renderer/3d/shaders/highlight-shaders.ts) — `MeshInstance` struct fixed in both `STENCIL_WRITE_SHADER` and `HIGHLIGHT_SHADER`
- [src/renderer/3d/mesh-highlight-pass.ts](../../src/renderer/3d/mesh-highlight-pass.ts) — `MeshHighlightPass.draw()`, three-step stencil technique
- [src/renderer/3d/renderer-3d.ts](../../src/renderer/3d/renderer-3d.ts) — `MESH_INSTANCE_STRIDE = 192` (line 87), `writeSlot` instance layout (~line 1325), `toEntries` hover path (~line 890)
- [src/renderer/3d/pipeline-3d.ts](../../src/renderer/3d/pipeline-3d.ts) — pipeline definitions; `MESH3D_VERTEX_STRIDE` from `FLOATS_PER_VERT`
