# GLTF 2.0 / GLB Export — Spec

**Status:** Completed June 2026  
**Files:** `src/renderer/3d/gltf-exporter.ts`, `src/services/managers/scene3d-manager.ts`, `src/services/shape-manager.ts`

---

## Goal

Export Salsa's 3D scene (meshes, skeletons, animation clips, blend shapes) to a self-contained GLB binary blob compatible with Blender, Unity, Unreal Engine, three.js, and any other GLTF 2.0 consumer.

---

## Scope

**Exported:**
- All `Mesh3D` nodes — position, normal, uv, tangent, vertex color, indices
- All `SkinnedMesh3D` nodes — above + joint indices (JOINTS_0) + joint weights (WEIGHTS_0)
- All `Skeleton3D` nodes — joint hierarchy (TRS nodes), inverse bind matrices (skin)
- All `SkeletonAnimClip` entries on each skeleton — rotation, translation, scale channels at LINEAR interpolation
- Blend shapes / morph targets — position + normal deltas, initial weights, target names

**Not exported:**
- Raster / 2D layers
- Grease Pencil (GP) objects
- Particle emitters
- Post-processing settings
- NLA track state (only the underlying `SkeletonAnimClip` keyframes are exported)
- Texture image data (mesh material colors export as `baseColorFactor`; GPU-side textures are not readback)

---

## API

```ts
// shape-manager public API:
const result = sm.exportSceneGltf3D();

// result fields:
result.blob           // Blob (type: 'model/gltf-binary') — ready for download
result.meshCount      // number of exported meshes
result.skeletonCount  // number of exported skins
result.animationCount // number of exported animation clips
result.vertexCount    // total vertex count across all meshes
```

**Trigger a download in Frogmarks:**
```ts
const result = sm.exportSceneGltf3D();
const url = URL.createObjectURL(result.blob);
const a = document.createElement('a');
a.href = url;
a.download = 'scene.glb';
a.click();
URL.revokeObjectURL(url);
```

---

## GLTF JSON Structure

```json
{
  "asset": { "version": "2.0", "generator": "Salsa" },
  "scene": 0,
  "scenes": [{ "name": "Scene", "nodes": [...rootNodeIndices] }],
  "nodes": [...jointNodes, ...meshNodes],
  "meshes": [...],
  "materials": [...pbrMaterials],
  "skins": [...skeletonSkins],
  "animations": [...animationClips],
  "accessors": [...],
  "bufferViews": [...],
  "buffers": [{ "byteLength": N }]
}
```

---

## Binary Buffer Layout

All binary data is accumulated into a single `buffer[0]`. Each typed array is 4-byte aligned before writing. Layout (order of insertion):

```
[skeleton 0 inverseBindMatrices: MAT4×N floats]
[skeleton 1 inverseBindMatrices: ...]
[mesh 0: POSITION VEC3 floats]
[mesh 0: NORMAL VEC3 floats]
[mesh 0: TEXCOORD_0 VEC2 floats]
[mesh 0: TANGENT VEC4 floats]
[mesh 0: COLOR_0 VEC4 floats]           ← if vertexColors present
[mesh 0: JOINTS_0 VEC4 ubytes]          ← if SkinnedMesh3D
[mesh 0: WEIGHTS_0 VEC4 floats]         ← if SkinnedMesh3D
[mesh 0: blend shape 0 POSITION delta]  ← if blend shapes
[mesh 0: blend shape 0 NORMAL delta]
[mesh 0: indices (SCALAR uint16 or uint32)]
[mesh 1: ...]
[animation 0 track 0: TIME scalars]
[animation 0 track 0: OUTPUT VEC3 or VEC4]
...
```

**Index type selection:** Uint16 when `vertexCount ≤ 65535`, Uint32 otherwise. Saves ~50% of index buffer for typical meshes.

---

## Mesh Node Transform

Mesh nodes use a `matrix` field (column-major `Float32Array` from `mesh._localMatrix`). Since all 3D meshes are direct children of the scene root (identity transform), `_localMatrix` equals the world matrix.

---

## Skeleton → Skin Mapping

Each `Skeleton3D` produces:
1. **N GLTF nodes** (one per joint) with TRS from `joint.localPosition/Rotation/Scale`
2. One `skin` with:
   - `joints[]` — ordered list of node indices
   - `skeleton` — index of the root joint node
   - `inverseBindMatrices` — accessor into the binary buffer
3. The root joint node is added to `scenes[0].nodes`

`SkinnedMesh3D` nodes reference the corresponding skin via `node.skin`.

---

## Material Export

Salsa `Material3D` → GLTF PBR `pbrMetallicRoughness`:

| Salsa field | GLTF field |
|-------------|-----------|
| `diffuse` {r,g,b} + `opacity` | `baseColorFactor` [r,g,b,a] |
| `metalness` | `metallicFactor` |
| `roughness` | `roughnessFactor` |
| `emissive` {r,g,b} | `emissiveFactor` [r,g,b] |
| `doubleSided` | `doubleSided` |
| `opacity < 1` | `alphaMode: 'BLEND'` |

Render style (`cel`/`sketch`/`ink`) is not representable in GLTF — materials export as standard PBR.

---

## Animation Export

Each `SkeletonAnimClip` → one GLTF `animation`:
- One `sampler` pair (time + output) per keyframe track
- Time is `keyframe.frame / clip.fps` (seconds)
- Interpolation is always `LINEAR`
- Rotation output is VEC4 (quaternion XYZW)
- Translation / scale output is VEC3

`IKKeyframeTrack` data is not exported (IK is a runtime solve, not a joint-space channel).

---

## GLB Container

```
[12 bytes: GLB header]
  magic = 0x46546C67 ('glTF')
  version = 2
  totalLength = 12 + 8 + jsonChunkLen + 8 + binChunkLen

[8 + N bytes: JSON chunk]
  chunkLength = N (padded to 4 bytes with 0x20 spaces)
  chunkType   = 0x4E4F534A ('JSON')
  data        = UTF-8 JSON

[8 + M bytes: BIN chunk]  ← omitted when M = 0
  chunkLength = M (padded to 4 bytes with 0x00 zeros)
  chunkType   = 0x004E4942 ('BIN\0')
  data        = binary buffer
```

---

## Known Limitations

- **No texture image export** — GPU-side textures (`diffuseTexture`, normal maps) are not read back from the GPU. Material color data exports as `baseColorFactor` only.
- **No camera export** — Salsa's `Camera3D` is not represented in the GLTF scene graph.
- **No IK in animations** — only keyframed FK channels are exported; IK-solved poses are not baked.
- **NLA tracks not exported as separate clips** — the underlying `SkeletonAnimClip` keyframes are exported; NLA blend state is not.
- **Coordinate system** — GLTF uses right-handed Y-up; Salsa uses the same convention. No coordinate transform is applied.
- **Non-PBR render styles** — cel/sketch/ink export as standard PBR materials; appearance will differ in external tools.
