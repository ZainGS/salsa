# 19 — Armature & Skeletal Animation System
**Last Updated:** 2026-05-09  

Salsa's armature engine adds Linear Blend Skinning (LBS) to the 3D pipeline: import rigged GLTF characters, drive them with animation clips, pose joints manually, and display an interactive bone overlay in the editor.

**Status: Complete (Phase A — implemented May 2026)**

**Root files:**
- `src/types/armature-3d.ts` — data types
- `src/scene-graph/shapes/skeleton-3d.ts` — `Skeleton3D` scene node
- `src/scene-graph/shapes/skinned-mesh-3d.ts` — `SkinnedMesh3D` scene node
- `src/renderer/3d/shaders/skinning-shaders.ts` — WGSL LBS vertex shaders
- `src/renderer/3d/pipeline-3d.ts` — skinned GPU pipelines
- `src/renderer/3d/renderer-3d.ts` — `drawSkinnedMeshes()`
- `src/renderer/3d/gltf-importer.ts` — `parseSkinnedGLB` / `parseSkinnedGLTF`
- `src/renderer/3d/skeleton-animator.ts` — `applySkeletonClipAtFrame()`
- `src/renderer/3d/gizmo-renderer.ts` — `drawBoneOverlay`, `hitTestJoint`
- `src/services/managers/scene3d-manager.ts` — orchestration
- `src/services/shape-manager.ts` — public API

---

## Architecture Overview

```
SkinnedMesh3D (scene node)
    ├─ geometry: MeshGeometry       ← standard vertices (unused for GPU draw)
    ├─ jointIndices: Uint8Array     ← 4 per vertex, indices into skeleton.data.joints[]
    ├─ jointWeights: Float32Array   ← 4 per vertex, must sum to 1.0
    ├─ skeletonId: string | null    ← UUID reference (for serialization)
    └─ skeleton: Skeleton3D | null  ← runtime reference (set after load/link)

Skeleton3D (scene node — extends Node, NOT Shape)
    ├─ id: string                   ← UUID, restored from JSON
    ├─ data: SkeletonData           ← { name, joints: Joint3D[] }
    ├─ skinMatrices: Float32Array   ← joints.length × 16 floats (flat skin matrices)
    └─ matricesDirty: boolean       ← set by computeWorldMatrices(), cleared by renderer

Joint3D (data only, no scene node)
    ├─ index, name, parentIndex (-1 = root), children[]
    ├─ localPosition, localRotation (quat xyzw), localScale
    ├─ worldMatrix: Float32Array    ← recomputed each frame
    └─ inverseBindMatrix: Float32Array  ← constant, from GLTF
```

---

## Data Types

**File:** `src/types/armature-3d.ts`

```typescript
interface Joint3D {
  index:             number;
  name:              string;
  parentIndex:       number;                           // -1 for root
  children:          number[];
  localPosition:     [number, number, number];
  localRotation:     [number, number, number, number]; // quaternion xyzw
  localScale:        [number, number, number];
  worldMatrix:       Float32Array;                     // 16 floats
  inverseBindMatrix: Float32Array;                     // 16 floats
}

interface SkeletonData {
  name:   string;
  joints: Joint3D[];
}

interface JointKeyframe {
  frame: number;
  value: number[];   // vec3 for translation/scale; vec4 quat for rotation
}

interface SkeletonKeyframeTrack {
  jointIndex: number;
  channel:    'translation' | 'rotation' | 'scale';
  keyframes:  JointKeyframe[];
}

interface SkeletonAnimClip {
  name:       string;
  startFrame: number;
  endFrame:   number;
  fps:        number;
  tracks:     SkeletonKeyframeTrack[];
}
```

---

## Skeleton3D Node

**File:** `src/scene-graph/shapes/skeleton-3d.ts`

`Skeleton3D` is a `Node` subclass (no geometry, no material). It owns the joint hierarchy and the flat `skinMatrices` array consumed by the GPU.

### `computeWorldMatrices()`

Called after any joint pose change. Traverses joints in parent-first order (guaranteed by the joint array ordering produced by the GLTF importer):

```
for each joint j:
  local = fromRotationTranslationScale(j.localRotation, j.localPosition, j.localScale)
  if j.parentIndex < 0:
    j.worldMatrix = local
  else:
    j.worldMatrix = joints[j.parentIndex].worldMatrix × local
  skinMatrices[j.index*16 .. +16] = j.worldMatrix × j.inverseBindMatrix
matricesDirty = true
```

The renderer checks `matricesDirty` and uploads `skinMatrices` to a `STORAGE` GPU buffer each frame when true.

### Pose Methods

```typescript
skel.setJointRotation(jointIndex, [x, y, z, w])   // sets localRotation + computeWorldMatrices()
skel.setJointPosition(jointIndex, [x, y, z])       // sets localPosition + computeWorldMatrices()
```

### Serialization

`Skeleton3D.toJSON()` stores:
- `type: 'Skeleton3D'`
- `id` — UUID
- `skeletonData.name` — name string
- `skeletonData.joints[]` — full joint data including `inverseBindMatrix` as `Array.from()`

`Skeleton3D.fromJSON(data)` static method reconstructs from saved JSON. Restores `id` so `skeletonId` references on `SkinnedMesh3D` resolve correctly after load.

---

## SkinnedMesh3D Node

**File:** `src/scene-graph/shapes/skinned-mesh-3d.ts`

Extends `Mesh3D`. Carries two additional arrays that define how each vertex blends between joints:

```typescript
class SkinnedMesh3D extends Mesh3D {
  skeletonId:   string | null;        // UUID of driving Skeleton3D (for serialization)
  skeleton:     Skeleton3D | null;    // runtime reference
  jointIndices: Uint8Array;           // 4 per vertex — joint indices
  jointWeights: Float32Array;         // 4 per vertex — blend weights (sum = 1.0)
  skinDirty:    boolean;              // true when GPU VB needs rebuild
  get isSkinned(): true               // discriminator
}
```

`SkinnedMesh3D` **bypasses the shared geometry pool** — it has its own per-mesh VB (72-byte stride) and IB managed in `Renderer3D._skinnedVBs` / `_skinnedIBs`.

### Serialization

`toJSON()` stores `jointIndicesB64` and `jointWeightsB64` as base64 strings (via `toBase64()` helper). This keeps the arrays compact in JSON without needing a binary sidecar file.

Helper functions exported from the module:
```typescript
toBase64(buffer: ArrayBuffer): string
fromBase64ToUint8(b64: string): Uint8Array
fromBase64ToFloat32(b64: string): Float32Array
```

---

## GLTF Skinned Import

**File:** `src/renderer/3d/gltf-importer.ts`

### Entry Points

```typescript
parseSkinnedGLB(buffer: ArrayBuffer): Promise<GltfSkinnedResult[]>
parseSkinnedGLTF(json: string, baseDir?: string): Promise<GltfSkinnedResult[]>
```

`GltfSkinnedResult` extends `GltfMeshResult` with a `skinning: GltfSkinningData` field:

```typescript
interface GltfSkinningData {
  jointIndices:       Uint8Array;      // 4 per vertex (JOINTS_0 accessor)
  jointWeights:       Float32Array;    // 4 per vertex (WEIGHTS_0 accessor)
  inverseBindMatrices: Float32Array;   // joints.length × 16
  jointNames:         string[];
  skinName:           string;
  jointParents:       Int16Array;      // -1 for root
  jointLocalPositions:  number[][];    // [x,y,z] per joint
  jointLocalRotations:  number[][];    // [x,y,z,w] quat per joint
  jointLocalScales:     number[][];    // [x,y,z] per joint
}
```

### What the importer reads from GLTF

- `skins[].joints[]` — joint node indices
- `skins[].inverseBindMatrices` — accessor index → Float32Array of 16-float matrices
- `JOINTS_0` — VEC4 UNSIGNED_BYTE accessor (4 joint indices per vertex)
- `WEIGHTS_0` — VEC4 FLOAT accessor (4 weights per vertex)
- Node TRS — local position/rotation/scale for each joint from the GLTF node graph
- Parent-child relationships — built by scanning `nodes[].children` for joints listed in the skin

### Scene3DManager Integration

`scene3d.importSkinnedGltfFile(file)` and `importSkinnedGltfBuffer(x, y, z, buffer)` call `parseSkinnedGLB`, then `_createSkinnedMeshesFromGltf`:

1. Build `Joint3D[]` from the `GltfSkinningData` (parentIndex from `jointParents`, worldMatrix initialized, inverseBindMatrix from accessor)
2. Create `Skeleton3D(skeletonData)` — auto-calls `computeWorldMatrices()`
3. Create `SkinnedMesh3D` — set `skeleton`, `skeletonId`, `jointIndices`, `jointWeights`
4. Add both to `sceneGraph.root`
5. Return `{ skeletonIds: [skel.id], meshIds: [mesh.id] }`

---

## GPU Draw Path

**File:** `src/renderer/3d/renderer-3d.ts`

`WebGPURenderer.draw3DMeshes()` splits meshes by type before passing to Renderer3D:

```typescript
const regular = allMeshes.filter(m => !(m instanceof SkinnedMesh3D));
const skinned  = allMeshes.filter(m =>   m instanceof SkinnedMesh3D);
if (regular.length > 0) renderer3D.drawMeshes(pass, regular, ...);
if (skinned.length  > 0) renderer3D.drawSkinnedMeshes(pass, skinned, ...);
```

`drawSkinnedMeshes` maintains:
- `_skinnedVBs: Map<string, GPUBuffer>` — per-mesh 72-byte vertex buffers
- `_skinnedIBs: Map<string, GPUBuffer>` — per-mesh index buffers
- `_skinMatBufs: Map<string, GPUBuffer>` — per-mesh STORAGE skin-matrix buffers
- `_skinBGs: Map<string, GPUBindGroup>` — per-mesh skin bind groups
- `_skinnedInstBuf: GPUBuffer` — small instance buffer (one slot per skinned mesh)

Buffers are created lazily and resized on geometry or joint count changes. `skinDirty = true` on the mesh triggers VB rebuild; `matricesDirty = true` on the skeleton triggers skin matrix re-upload.

### Vertex Buffer Layout (72 bytes)

| Float offset | Byte offset | Content |
|-------------|------------|---------|
| 0–2 | 0–11 | position (vec3) |
| 3–5 | 12–23 | normal (vec3) |
| 6–7 | 24–31 | uv (vec2) |
| 8–11 | 32–47 | tangent (vec4) |
| — | 48–51 | jointIndices (uint8×4) |
| 13–16 | 52–67 | jointWeights (float32×4) |
| — | 68–71 | padding |

---

## Skeleton Animator

**File:** `src/renderer/3d/skeleton-animator.ts`

GPU-free module. Can be called from scene manager, callbacks, or tests.

```typescript
applySkeletonClipAtFrame(clip: SkeletonAnimClip, skeleton: Skeleton3D, frame: number): void
```

For each track: sample surrounding keyframes → interpolate:
- `'rotation'` → `quat.slerp`
- `'translation'` / `'scale'` → linear lerp

Calls `skeleton.computeWorldMatrices()` at the end. The renderer picks up `matricesDirty = true` automatically on the next frame.

---

## Bone Overlay Gizmo

**File:** `src/renderer/3d/gizmo-renderer.ts`

### `drawBoneOverlay(pass, skeleton, camera, hoveredJoint, selectedJoint)`

Renders the skeleton visualization on top of all geometry (depthCompare: 'always'):

1. **Bone sticks** — for each joint with a parent, `addBoneDiamond()` creates a 6-vertex diamond prism along the parent→child world vector. Waist at 12% of bone length, width 10%.
2. **Joint spheres** — UV sphere (4 lat, 6 lon) at each joint world position. Colored by state (see doc 15 for colors).

Joint radius = `computeGizmoScale(camera, skeletonCenter) × 0.07` — always consistent screen size.

Uses dedicated GPU buffers: `_boneVertBuf` (8192 verts), `_boneIdxBuf` (32768 indices), `_boneUniBuf`. Model matrix = identity (all geometry in world space).

### `hitTestJoint(rayOrigin, rayDir, skeleton, camera): number | null`

Sphere ray-test against every joint. Hit radius = visual radius × 1.8.

Returns joint index of the nearest hit, or `null`.

---

## Bone Overlay Lifecycle in Scene3DManager

1. User selects a mesh → `setSelected3DIds(ids)` calls `_syncBoneOverlay(ids)`.
2. If exactly one `SkinnedMesh3D` is selected and has a `skeleton`:
   - `_boneOverlaySkeletonId = mesh.skeleton.id`
   - `renderer3D.setBoneOverlaySkeleton(mesh.skeleton)`
3. `mousemove` → `hitTestJoint` → `renderer3D.setHoveredJoint(idx)` → render.
4. `mousedown` → if hovered joint ≠ null → `_selectedJointIndex = idx` → `renderer3D.setSelectedJoint(idx)`.
5. Deselecting or selecting a non-skinned mesh → `_syncBoneOverlay(new Set())` → clears overlay.

---

## Serialization Flow

### Save

In `snapshotDocument()` (OPFS) and `packProject()` (.frogmarks):

```typescript
const nodes     = scene3d.getAllMeshes().map(m => _buildMeshState(m));
const skeletons = scene3d.getAllSkeletons().map(s => s.toJSON());
scene3dJSON = JSON.stringify({ nodes, skeletons });
```

Old saves used a flat `[...]` array — detected and handled in restore.

### Restore

```typescript
const parsed    = JSON.parse(scene3dJSON);
const nodes     = Array.isArray(parsed) ? parsed      : (parsed.nodes     ?? []);
const skeletons = Array.isArray(parsed) ? []           : (parsed.skeletons ?? []);

// 1. Restore skeletons first (so IDs exist for re-link)
for (const s of skeletons) scene3d.restoreSkeletonState(s);

// 2. Restore meshes (SkinnedMesh3D branch in restoreMeshState re-parses GLB, restores base64 skin data)
for (const state of nodes) await scene3d.restoreMeshState(state, glbBuffer);

// 3. Wire SkinnedMesh3D.skeleton references
scene3d.relinkSkinnedMeshSkeletons();
```

The `SkinnedMesh3D` restore branch in `restoreMeshState`:
1. Calls `parseSkinnedGLB(buffer)` to get geometry
2. Creates `SkinnedMesh3D` directly (not via `importSkinnedGltfBuffer` — avoids creating a second skeleton)
3. Restores `jointIndices`/`jointWeights` from saved base64 (falls back to parsed GLB data)
4. Restores saved mesh ID so the `skeletonId` reference resolves correctly

---

## What's Next

All three phases are complete:

- **Phase A — Armatures**: ✅ Complete (this document)
- **Phase B — Kitbashing**: ✅ Complete — `KitbashLibrary`, `CharacterAssembler`, joint index remapping to canonical shared skeleton. Spec: `docs/specs/kitbash-armature-grease-pencil.md`.
- **Phase C — Grease Pencil**: ✅ Complete — 2D strokes in 3D world space, bone-parented and keyframe-animated, GPU quad-strip renderer. Spec: `docs/specs/kitbash-armature-grease-pencil.md`.
