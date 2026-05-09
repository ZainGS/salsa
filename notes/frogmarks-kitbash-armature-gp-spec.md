# Frogmarks — Kitbashing, Armatures & Grease Pencil

**Date:** 2026-05-08  
**Status:** Planned — not yet started  
**Goal:** Three interlocking post-MVP systems that together make Frogmarks the definitive tool for stylized 2D+3D illustration with animatable characters. Build in order: Armatures → Kitbashing → Grease Pencil.

---

## Why these three together

| System | What it adds |
|--------|-------------|
| **Armatures** | Bones + vertex skinning — the prerequisite engine for everything else |
| **Kitbashing** | Pre-rigged character parts (hair/clothing/accessories) that assemble on the shared skeleton — the creative workflow |
| **Grease Pencil** | 2D strokes drawn in 3D world space, bone-parented, keyframe-animated — the 2D+3D signature feature |

Grease Pencil without armatures is just floating strokes. Kitbashing without armatures is static assembly. Armatures without kitbashing means users must supply their own rigged models. All three together make a character pipeline that illustrators can actually use.

---

## What already exists (the foundation)

| Piece | File | Relevance |
|-------|------|-----------|
| `Mesh3D` scene node | `src/scene-graph/shapes/mesh-3d.ts` | Base class for `SkinnedMesh3D` |
| `MeshGroup3D` | `src/scene-graph/shapes/mesh-group-3d.ts` | Pattern for multi-mesh scene nodes |
| GLTF importer | `src/renderer/3d/gltf-importer.ts` | Must be extended to read `skins`, `JOINTS_0`, `WEIGHTS_0` |
| `AnimationPlayer3D` | `src/renderer/3d/animation-player-3d.ts` | Must be extended with per-joint tracks |
| `Mesh3DKeyframeTracks` | `src/types/keyframe-3d.ts` | Pattern for new `SkeletonKeyframeTracks` |
| `Pipeline3D` | `src/renderer/3d/pipeline-3d.ts` | Must add skinned-mesh pipeline variant |
| `Renderer3D.drawMeshes()` | `src/renderer/3d/renderer-3d.ts` | Must dispatch skinned meshes to the skinning pipeline |
| `GizmoRenderer` | `src/renderer/3d/gizmo-renderer.ts` | Must be extended to draw bones |
| `MeshPicker` | `src/renderer/3d/mesh-picker.ts` | Must be extended to ray-test individual bones |
| Ribbon mesh + shader | `src/renderer/3d/`, `shaders/` | GPU quad-strip pattern reused by Grease Pencil |
| `ShapeManager` public API | `src/services/shape-manager.ts` | All new features surface here |
| `Scene3DManager` | `src/services/managers/scene3d-manager.ts` | Owns the new registries |
| TextureLibrary | `src/services/texture-library.ts` | Kitbash part thumbnails stored here |
| Project package | `src/services/persistence/project-package.ts` | Must serialize skeleton + GP data |

---

## System 1 — Armatures (Skeletal Animation Engine)

### Concepts

A **skeleton** is a tree of **joints** (also called bones). Each joint has a local transform (position, rotation, scale) relative to its parent. The skeleton drives a **skinned mesh**: each vertex is pulled toward up to 4 joints, weighted by a float per joint. The final vertex position is:

```
skinnedPos = Σ (weight[i] * jointMatrix[i] * inverseBindMatrix[i] * bindPos)
```

Where `jointMatrix[i]` = world transform of joint i this frame, and `inverseBindMatrix[i]` = inverse of joint i's world transform in the bind (rest) pose. This is the standard GLTF skinning equation.

### New data types — `src/types/armature-3d.ts`

```typescript
// A single joint in the hierarchy
export interface Joint3D {
    index:              number;              // position in the flat joint array
    name:               string;             // e.g. 'spine', 'left_hand'
    parentIndex:        number;             // -1 for root
    children:           number[];           // child joint indices
    localPosition:      [number, number, number];   // relative to parent
    localRotation:      [number, number, number, number];  // quaternion xyzw
    localScale:         [number, number, number];   // default [1,1,1]

    // Computed each frame — do not serialize
    worldMatrix:        Float32Array;       // mat4, 16 floats
    inverseBindMatrix:  Float32Array;       // mat4, 16 floats — set once at bind time
}

// A full skeleton
export interface SkeletonData {
    joints:     Joint3D[];          // flat array, root at index 0
    name:       string;
}

// Per-frame pose (one entry per joint)
export type SkeletonPose = {
    positions:  Float32Array;   // joints.length * 3
    rotations:  Float32Array;   // joints.length * 4 (quaternions)
    scales:     Float32Array;   // joints.length * 3
};

// Keyframe track for skeleton animation
export interface SkeletonKeyframeTrack {
    jointIndex: number;
    channel:    'position' | 'rotation' | 'scale';
    times:      number[];       // seconds
    values:     number[][];     // [x,y,z] or [x,y,z,w] per keyframe
    interpolation: 'step' | 'linear' | 'cubic';
}

// One animation clip (e.g. 'idle', 'walk', 'wave')
export interface SkeletonAnimClip {
    name:       string;
    duration:   number;         // seconds
    tracks:     SkeletonKeyframeTrack[];
}
```

### New scene node — `src/scene-graph/shapes/skeleton-3d.ts`

```typescript
import { Node } from '../base/node';
import type { SkeletonData, SkeletonPose, SkeletonAnimClip } from '../../types/armature-3d';

export class Skeleton3D extends Node {
    readonly skeletonData:  SkeletonData;
    readonly clips:         Map<string, SkeletonAnimClip> = new Map();

    // Flat mat4 array uploaded to GPU each frame (joints.length * 16 floats)
    // skinMatrix[i] = worldMatrix[i] * inverseBindMatrix[i]
    readonly skinMatrices:  Float32Array;
    gpuDirty = true;

    constructor(data: SkeletonData) { ... }

    // Compute worldMatrix for every joint from current pose
    computeWorldMatrices(): void { ... }

    // Apply a pose (from animation player or direct manipulation)
    applyPose(pose: SkeletonPose): void { ... }

    // Get the world matrix for a named joint (for attachment points)
    getJointWorldMatrix(name: string): Float32Array | null { ... }

    toJSON(): object { ... }
    getType(): string { return 'Skeleton3D'; }
}
```

### New scene node — `src/scene-graph/shapes/skinned-mesh-3d.ts`

Extends `Mesh3D`. Adds:
- `skeletonId: string` — references the sibling `Skeleton3D` node
- `jointIndices: Uint8Array` — 4 indices per vertex (vertices * 4)
- `jointWeights: Float32Array` — 4 weights per vertex (vertices * 4)

The GPU vertex buffer for skinned meshes uses a **different stride** (92 bytes vs 48):

```
position:     vec3f   (12 bytes)
normal:       vec3f   (12 bytes)
uv:           vec2f   (8 bytes)
tangent:      vec4f   (16 bytes)
jointIndices: u8x4    (4 bytes — packed as u32)
jointWeights: vec4f   (16 bytes)  ← +24 bytes vs standard mesh
pad:          u32     (4 bytes — alignment)
= 72 bytes per skinned vertex
```

Use a separate pipeline (never mix the skinned pipeline with the standard pipeline) so the existing mesh stride of 48 bytes is untouched.

### Skinning WGSL shader — `src/renderer/3d/shaders/skinning-shaders.ts`

Key additions to the vertex shader:

```wgsl
// New input locations (on top of standard mesh layout)
@location(4) jointIndices: vec4u,
@location(5) jointWeights: vec4f,

// New bind group 3: skin matrices storage buffer
@group(3) @binding(0) var<storage, read> skinMatrices: array<mat4x4f>;

// In the vertex shader body, before applying model matrix:
let skin =
    jointWeights.x * skinMatrices[jointIndices.x] +
    jointWeights.y * skinMatrices[jointIndices.y] +
    jointWeights.z * skinMatrices[jointIndices.z] +
    jointWeights.w * skinMatrices[jointIndices.w];

let skinnedPos    = skin * vec4f(position, 1.0);
let skinnedNormal = normalize((skin * vec4f(normal, 0.0)).xyz);
// Then continue with the standard model/view/projection transform
```

The `skinMatrices` buffer is a `GPUBuffer` of `joints.length * 64 bytes` (one mat4 per joint), updated each frame from `Skeleton3D.skinMatrices`.

### Pipeline changes — `src/renderer/3d/pipeline-3d.ts`

Add `createSkinnedMeshPipeline()` that clones the standard mesh pipeline but:
- Uses the 72-byte vertex stride
- Adds `@group(3)` binding layout for the skin matrices storage buffer
- Uses the skinning vertex shader

`Renderer3D` dispatches `SkinnedMesh3D` instances to this pipeline instead of the standard one.

### GLTF importer extension — `src/renderer/3d/gltf-importer.ts`

Extend the existing importer to read:
- `gltf.skins[]` — each skin has `joints[]` (node indices) and `inverseBindMatrices` (accessor ref)
- `JOINTS_0` attribute accessor → `Uint8Array` or `Uint16Array` (4 indices per vertex)
- `WEIGHTS_0` attribute accessor → `Float32Array` (4 weights per vertex)

Output: instead of a plain `Mesh3D`, return a `SkinnedMesh3D` + `Skeleton3D` pair when a skin is present.

### Animation extension — `src/renderer/3d/animation-player-3d.ts`

Add `playSkeletonClip(skeleton: Skeleton3D, clipName: string)` that drives the skeleton's joint transforms each tick, same pattern as the existing mesh keyframe interpolation. The player already has a tick loop — extend it to handle `SkeletonKeyframeTrack` entries.

### Bone gizmo — `src/renderer/3d/gizmo-renderer.ts`

Add `drawSkeleton(skeleton: Skeleton3D, selectedJointIndex: number)`:
- Draw each bone as a thin wireframe octahedron pointing from parent joint to child joint
- Selected joint: brighter color, rotation gizmo rings
- Use the existing gizmo line draw pass (no new pipeline needed — same depth-ignore overlay)

### API surface (ShapeManager)

```typescript
// Import a rigged GLTF/GLB — returns { skeletonId, meshIds[] }
sm.importSkinnedGltf3D(buffer: ArrayBuffer, x?, y?, z?)

// Get all skeletons in scene
sm.getSkeletons3D(): { id: string; name: string; jointCount: number }[]

// Pose a joint directly (for manual posing)
sm.setJointRotation3D(skeletonId: string, jointName: string, qx, qy, qz, qw)
sm.setJointPosition3D(skeletonId: string, jointName: string, x, y, z)

// Play a named animation clip on a skeleton
sm.playSkeletonClip3D(skeletonId: string, clipName: string, loop?: boolean)
sm.stopSkeletonClip3D(skeletonId: string)

// Get clip names bundled in the skeleton
sm.getSkeletonClips3D(skeletonId: string): string[]
```

---

## System 2 — Kitbashing & Character Assembly

### The canonical character skeleton

All Frogmarks-native character parts are rigged to one shared skeleton spec. The joint names below are the contract — every part must use exactly these names for the joints it influences:

```
root
└── hips
    ├── spine
    │   └── chest
    │       ├── neck
    │       │   └── head
    │       │       ├── eye_left
    │       │       └── eye_right
    │       ├── shoulder_left
    │       │   └── upper_arm_left
    │       │       └── lower_arm_left
    │       │           └── hand_left
    │       └── shoulder_right
    │           └── upper_arm_right
    │               └── lower_arm_right
    │                   └── hand_right
    ├── upper_leg_left
    │   └── lower_leg_left
    │       └── foot_left
    └── upper_leg_right
        └── lower_leg_right
            └── foot_right
```

**26 joints total.** This is intentionally humanoid and minimal — enough for fluid character animation without the complexity of finger bones (those can be added in a later pass if needed).

Attachment-point joints (not skin-driven, just transform parents for accessories):
- `attach_hat` — child of `head`, offset above crown
- `attach_back` — child of `chest`, offset behind spine (cape, wings, backpack)
- `attach_hand_left`, `attach_hand_right` — child of respective hand joints (held items)

### New types — `src/types/kitbash-3d.ts`

```typescript
export type CharacterSlot =
    | 'base_body'       // must be present — full body skinned mesh
    | 'hair'
    | 'face_overlay'    // eyebrows, face markings, face accessories
    | 'top'             // shirt/jacket/torso clothing
    | 'bottom'          // pants/skirt/legs clothing
    | 'shoes'
    | 'accessory_head'  // hats, helmets, ears
    | 'accessory_back'  // wings, capes, backpacks
    | 'accessory_left'  // held item left hand
    | 'accessory_right' // held item right hand
    | 'overlay'         // additional mesh drawn on top (glasses, jewelry, etc.)

export interface KitbashPartMeta {
    id:         string;         // UUID, stable across updates
    slot:       CharacterSlot;
    name:       string;         // display name, e.g. 'Wavy Bob'
    thumbnail:  string;         // TextureLibrary ID (small preview image)
    glbUrl:     string;         // URL or bundled asset path to the GLB
    tags:       string[];       // e.g. ['feminine', 'fantasy', 'short']
    styleSet:   string;         // e.g. 'frogmarks-v1' — for version control
}

export interface CharacterDefinition {
    id:         string;
    name:       string;
    slots:      Partial<Record<CharacterSlot, string>>;  // slot → part ID
    // Base body color tints (applied as emissive/diffuse override per slot)
    skinTone?:  { r: number; g: number; b: number };
    hairColor?: { r: number; g: number; b: number };
}
```

### New service — `src/services/managers/kitbash-library.ts`

```typescript
export class KitbashLibrary {
    private _parts: Map<string, KitbashPartMeta> = new Map();
    private _bySlot: Map<CharacterSlot, KitbashPartMeta[]> = new Map();

    // Load a manifest JSON from a URL or bundled import
    async loadManifest(url: string): Promise<void> { ... }

    getPartsBySlot(slot: CharacterSlot): KitbashPartMeta[] { ... }
    getPart(id: string): KitbashPartMeta | null { ... }
    getAllSlots(): CharacterSlot[] { ... }
}
```

The manifest JSON format:

```json
{
  "version": "1",
  "styleSet": "frogmarks-v1",
  "parts": [
    {
      "id": "hair-wavy-bob-001",
      "slot": "hair",
      "name": "Wavy Bob",
      "thumbnail": "thumbnails/hair-wavy-bob-001.webp",
      "glbUrl": "parts/hair-wavy-bob-001.glb",
      "tags": ["short", "wavy"],
      "styleSet": "frogmarks-v1"
    }
  ]
}
```

### New service — `src/services/managers/character-assembler.ts`

```typescript
export class CharacterAssembler {
    constructor(
        private library: KitbashLibrary,
        private gltfImporter: GltfImporter,
        private scene3d: Scene3DManager,
    ) {}

    // Build a CharacterNode3D in the scene from a CharacterDefinition.
    // Loads each required GLB, extracts the skinned mesh, attaches to shared skeleton.
    async assemble(def: CharacterDefinition, x: number, y: number, z: number): Promise<CharacterNode3D> {
        // 1. Load and instantiate the base_body GLB (contains the canonical skeleton)
        // 2. For each other slot in def.slots, load that part's GLB
        // 3. Extract the SkinnedMesh3D from each loaded GLB, discard its local skeleton
        // 4. Remap joint indices in each mesh to the canonical skeleton's indices (by joint name)
        // 5. Attach all SkinnedMesh3D nodes under the same CharacterNode3D + shared Skeleton3D
        // 6. Apply color tints if set in the definition
    }

    // Swap one slot on a live character (hair change, clothing swap, etc.)
    async swapSlot(characterId: string, slot: CharacterSlot, partId: string): Promise<void> {
        // 1. Remove current mesh for that slot
        // 2. Load new part GLB
        // 3. Remap joints, attach to existing skeleton
    }
}
```

### New scene node — `src/scene-graph/shapes/character-node-3d.ts`

A container node that groups the skeleton + all part meshes:

```typescript
export class CharacterNode3D extends Node {
    definition:     CharacterDefinition;
    skeleton:       Skeleton3D;
    partMeshes:     Map<CharacterSlot, SkinnedMesh3D | null>;

    getType(): string { return 'CharacterNode3D'; }
    toJSON(): object { ... }     // serializes definition + skeleton pose
}
```

### ShapeManager API

```typescript
// One-time library load (call during app init)
await sm.loadKitbashLibrary3D(manifestUrl: string)

// Query available parts
sm.getKitbashParts3D(slot: CharacterSlot): KitbashPartMeta[]

// Create a character from a definition (async — loads GLBs)
const id = await sm.createCharacter3D(def: CharacterDefinition, x?, y?, z?)

// Live slot swap on an existing character (async)
await sm.swapCharacterSlot3D(charId: string, slot: CharacterSlot, partId: string)

// Apply a color tint to a slot
sm.setCharacterSlotColor3D(charId: string, slot: CharacterSlot, r: number, g: number, b: number)

// Get the current definition (for UI state restore)
sm.getCharacterDefinition3D(charId: string): CharacterDefinition | null

// Skeleton access (for posing/animation — passes through to Skeleton3D)
sm.setJointRotation3D(charId: string, jointName: string, qx, qy, qz, qw)
sm.playSkeletonClip3D(charId: string, clipName: string, loop?: boolean)
sm.stopSkeletonClip3D(charId: string)
sm.getSkeletonClips3D(charId: string): string[]

// Delete
sm.removeCharacter3D(charId: string)
```

### Joint index remapping — the critical detail

Each part GLB is authored against the canonical skeleton by joint **name**. But when a GLB is loaded, its `JOINTS_0` values are indices into *that file's* local joint array, which may be in a different order than the canonical array.

Before uploading to the GPU, `CharacterAssembler` must remap:

```typescript
// Build a remap table: partLocalIndex → canonicalIndex
const remap = new Uint8Array(partJoints.length);
for (let i = 0; i < partJoints.length; i++) {
    const canonIdx = canonicalSkeleton.joints.findIndex(j => j.name === partJoints[i].name);
    remap[i] = canonIdx === -1 ? 0 : canonIdx;  // fallback to root if name not found
}

// Apply remap to JOINTS_0 buffer
for (let v = 0; v < vertexCount; v++) {
    for (let k = 0; k < 4; k++) {
        partJointIndices[v * 4 + k] = remap[partJointIndices[v * 4 + k]];
    }
}
```

This is the most failure-prone step — part authors must use exact joint names from the canonical spec.

### Asset production guidelines (for the art team / future contributors)

- All parts must export from a tool (Blender recommended) with the canonical skeleton as the armature
- Unused joints can be weighted to 0 — they do not need to be removed
- Textures: 512×512 or 256×256, style-consistent with Frogmarks low-poly aesthetic
- GLB only (not GLTF + bin) — single file per part
- `styleSet: "frogmarks-v1"` tag on all initial parts — allows style versioning later
- Parts that rigid-attach (hats, held items) use the designated `attach_*` joints with weight = 1.0

---

## System 3 — Grease Pencil

### What it is

Grease Pencil strokes are **2D lines drawn in 3D world space**. Each stroke is a polyline with 3D point positions, pressure, opacity, and color. They render as thick GPU quad strips (the same approach as Ribbon3D but driven by freehand stroke data). They can be:
- Parented to a bone joint (so the stroke moves when the character animates)
- Keyframe-animated (draw different strokes at different frames)
- Filled (closed strokes get a flat-shaded fill region)

This is the signature feature that makes Frogmarks's 2D+3D overlap meaningful for character illustration — an artist can draw a character's expression, clothing detail, or cel-shading line in 3D space and have it stay glued to the mesh.

### New types — `src/types/grease-pencil-3d.ts`

```typescript
export interface GpPoint {
    x: number;          // world-space position
    y: number;
    z: number;
    pressure:   number; // 0–1, drives local width multiplier
    opacity:    number; // 0–1
}

export interface GpStroke3D {
    id:             string;
    points:         GpPoint[];
    color:          { r: number; g: number; b: number; a: number };
    fillColor?:     { r: number; g: number; b: number; a: number }; // null = no fill
    baseWidth:      number;         // world units
    parentJoint?:   string;         // joint name from Skeleton3D — transforms all points
    closed:         boolean;        // if true, first + last point are connected
}

export interface GpLayer3D {
    id:         string;
    name:       string;
    strokes:    GpStroke3D[];
    visible:    boolean;
    opacity:    number;
    // Keyframe animation: at frame N, replace strokes with this list
    keyframes:  Map<number, GpStroke3D[]>;
}

export interface GpObject3DData {
    id:     string;
    name:   string;
    layers: GpLayer3D[];
    // Which character/skeleton this GP object is associated with (optional)
    characterId?: string;
}
```

### New scene node — `src/scene-graph/shapes/gp-object-3d.ts`

```typescript
export class GpObject3D extends Node {
    layers:     GpLayer3D[];
    characterId?: string;

    getType(): string { return 'GpObject3D'; }
    toJSON(): object { ... }

    // Get strokes active at a given frame (respects keyframe overrides)
    getActiveStrokes(frame: number): GpStroke3D[] { ... }
}
```

### Rendering — `src/renderer/3d/gp-renderer-3d.ts`

New class, follows the same pre-render-callback pattern as particles.

**Quad strip expansion (GPU side):**
Each stroke segment `(p[i] → p[i+1])` becomes two triangles. The vertex shader receives the two endpoint positions and computes the screen-space perpendicular for expansion:

```
For segment (A, B):
    screenA = project(A), screenB = project(B)
    tangent = normalize(screenB - screenA)
    normal  = vec2(-tangent.y, tangent.x)   // perpendicular in screen space
    halfW   = baseWidth * (pressureA + pressureB) / 2 / canvasHeight

    v0 = screenA + normal * halfW * pressureA   (top-left)
    v1 = screenA - normal * halfW * pressureA   (bottom-left)
    v2 = screenB + normal * halfW * pressureB   (top-right)
    v3 = screenB - normal * halfW * pressureB   (bottom-right)
```

The expansion happens in the vertex shader (not CPU) for performance. CPU uploads one compact buffer per draw call: `[x,y,z,pressure,opacity]` per point.

**Fill rendering:**
For closed strokes: project all points to screen space, run ear-clipping (same algorithm as `Polygon.earClipTriangulate()`), draw as a flat-shaded triangle list in a separate draw call before the stroke outline.

**Bone parenting:**
If `stroke.parentJoint` is set, the GPU vertex shader reads the joint's world matrix from the skeleton's `skinMatrices` buffer and transforms each stroke point before screen projection. This means the stroke tracks the bone with zero CPU work per frame.

### Shaders — `src/renderer/3d/shaders/gp-shaders.ts`

New file. Two shader pairs:

1. **Stroke shader** — vertex: takes `[x,y,z,pressure,opacity]` point data + segment index, expands to quad strip in screen space. Fragment: solid color * opacity * pressure fade.
2. **Fill shader** — vertex: standard 3D point → clip space. Fragment: flat fill color.

Both shaders bind `@group(0)` for scene uniforms (VP matrix) and optionally `@group(1)` for skeleton skin matrices when a parentJoint is set.

### Drawing tool interaction

A new tool mode added to the Frogmarks interaction layer:

```typescript
// ShapeManager API for GP
sm.beginGpStroke3D(gpObjectId: string, layerId: string, color, width, parentJoint?)
sm.addGpPoint3D(gpObjectId: string, layerId: string, x, y, z, pressure, opacity)
sm.endGpStroke3D(gpObjectId: string, layerId: string): string  // returns strokeId

// Eraser
sm.eraseGpStrokes3D(gpObjectId: string, layerId: string, worldPos, radius: number)

// Object management
sm.createGpObject3D(characterId?: string): string   // returns gpObjectId
sm.removeGpObject3D(gpObjectId: string)
sm.addGpLayer3D(gpObjectId: string, name: string): string
sm.removeGpLayer3D(gpObjectId: string, layerId: string)

// Keyframe animation
sm.setGpKeyframe3D(gpObjectId: string, layerId: string, frame: number)
sm.clearGpKeyframe3D(gpObjectId: string, layerId: string, frame: number)
```

**Stroke placement in 3D:** When drawing on a character, the tool needs to place strokes at the right depth. Two modes:
- **Surface snap** — ray-cast against the character mesh, place stroke at hit depth (uses `MeshPicker`)
- **Plane** — stroke lives on a fixed world-space plane (the illustration plane for 2D-style work)

---

## Architecture diagram

```
Scene Graph
│
├── CharacterNode3D  "Hero"
│     ├── Skeleton3D  ←── skinMatrices[] uploaded to GPU each frame
│     │     ├── Joint[hips] ←── driven by SkeletonKeyframeTrack or manual pose
│     │     └── ... (26 joints)
│     ├── SkinnedMesh3D  (base_body)  ←── joint remapped, draws via skinning pipeline
│     ├── SkinnedMesh3D  (hair: wavy-bob)
│     ├── SkinnedMesh3D  (top: jacket)
│     └── SkinnedMesh3D  (shoes: sneakers)
│
├── GpObject3D  "Hero outlines"
│     └── GpLayer3D "outlines"
│           ├── GpStroke3D  parentJoint="chest"  ← follows chest bone
│           └── GpStroke3D  parentJoint="head"   ← follows head bone
│
└── (existing Mesh3D, ParticleEmitter3D, etc. unchanged)

Renderer3D.draw() order:
  1. drawMeshes()        — standard + skinned (two pipelines, one pass)
  2. drawParticles()     — unchanged
  3. drawGpFills()       — new: fill regions for closed GP strokes
  4. drawGpStrokes()     — new: quad-strip outlines
  5. (bloom composite, outline composite — unchanged)
```

---

## Phased implementation order

### Phase A — Armature Engine (4–6 weeks)

No kitbashing or GP until this is done. Prerequisite for everything.

| Step | What | Key files |
|------|------|-----------|
| A1 | `src/types/armature-3d.ts` — all types | New file |
| A2 | `Skeleton3D` scene node with `computeWorldMatrices()` | New file |
| A3 | `SkinnedMesh3D` scene node — holds joint/weight buffers | New file |
| A4 | 72-byte skinned vertex format, GPU upload in `Renderer3D` | `pipeline-3d.ts`, `renderer-3d.ts` |
| A5 | Skinning WGSL vertex shader | `shaders/skinning-shaders.ts` (new) |
| A6 | `createSkinnedMeshPipeline()` in `Pipeline3D` | `pipeline-3d.ts` |
| A7 | `Renderer3D.drawSkinnedMeshes()` — uploads `skinMatrices` each frame, dispatches | `renderer-3d.ts` |
| A8 | GLTF importer extension — read skins, JOINTS_0, WEIGHTS_0 | `gltf-importer.ts` |
| A9 | `SkeletonKeyframeTrack` type + `AnimationPlayer3D` extension | `animation-player-3d.ts`, `keyframe-3d.ts` |
| A10 | Bone gizmo drawing in `GizmoRenderer` | `gizmo-renderer.ts` |
| A11 | Joint selection via `MeshPicker` extension | `mesh-picker.ts` |
| A12 | ShapeManager API: `importSkinnedGltf3D`, `setJointRotation3D`, `playSkeletonClip3D` | `shape-manager.ts` |
| A13 | Serialization: `recreateNode` case for `Skeleton3D` + `SkinnedMesh3D` + `CharacterNode3D` | `shape-manager.ts` |

**Validation test:** Import a rigged GLTF humanoid (Mixamo free asset), call `playSkeletonClip3D`, see it animate in the scene.

---

### Phase B — Kitbashing Library (2–3 weeks engine + ongoing content)

| Step | What | Key files |
|------|------|-----------|
| B1 | `src/types/kitbash-3d.ts` — types | New file |
| B2 | `KitbashLibrary` service — manifest load, part catalog | `src/services/managers/kitbash-library.ts` |
| B3 | `CharacterNode3D` scene node | New file |
| B4 | `CharacterAssembler` — joint remapping, GLB loading, multi-mesh attach | `src/services/managers/character-assembler.ts` |
| B5 | ShapeManager API: `loadKitbashLibrary3D`, `createCharacter3D`, `swapCharacterSlot3D`, etc. | `shape-manager.ts` |
| B6 | Serialization: `CharacterNode3D.toJSON()` + `recreateNode` case | `shape-manager.ts` |
| B7 | **Initial asset pack** — 1 base body + 3 hair + 3 tops + 2 bottoms + 2 shoes | Art production |
| B8 | Frogmarks character creator UI (see UI spec section below) | Frogmarks (Angular) |

**Validation test:** Open character creator panel, select wavy hair + jacket + sneakers, click "Add to Scene", see assembled animated character.

---

### Phase C — Grease Pencil (3–4 weeks)

| Step | What | Key files |
|------|------|-----------|
| C1 | `src/types/grease-pencil-3d.ts` — types | New file |
| C2 | `GpObject3D` scene node | New file |
| C3 | `GpRenderer3D` — CPU point buffer, quad-strip expand shader | `src/renderer/3d/gp-renderer-3d.ts` |
| C4 | GP stroke shader + fill shader | `shaders/gp-shaders.ts` (new) |
| C5 | Fill triangulation (reuse `Polygon.earClipTriangulate`) | `gp-renderer-3d.ts` |
| C6 | Bone parenting in shader (reads skeleton skinMatrices buffer) | `gp-shaders.ts` |
| C7 | ShapeManager API: `createGpObject3D`, `beginGpStroke3D`, `addGpPoint3D`, `endGpStroke3D`, `eraseGpStrokes3D` | `shape-manager.ts` |
| C8 | Surface snap: ray-cast to character mesh for stroke placement depth | `mesh-picker.ts` extension |
| C9 | Keyframe animation: `setGpKeyframe3D`, `clearGpKeyframe3D` | `shape-manager.ts`, `GpObject3D` |
| C10 | Serialization: `GpObject3D.toJSON()` + `recreateNode` case | `shape-manager.ts` |
| C11 | Frogmarks GP drawing tool UI | Frogmarks (Angular) |

**Validation test:** Draw strokes on a character with `parentJoint="chest"`, play the walk animation, see strokes move with the chest bone.

---

## Frogmarks UI (what to build in Angular — high level)

These are the Frogmarks-side panels. Full detail in separate UI spec files when ready.

### Character Creator Panel

```
┌──────────────────────────────────────────┐
│  Characters                    [+ New]   │
│  ─────────────────────────────────────── │
│  ● Hero        [Edit]  [Pose]  [×]       │
│  ● Sidekick    [Edit]  [Pose]  [×]       │
│                                          │
│  [─ Creator ──────────────────────────] │
│  Slot tabs: [Base] [Hair] [Top] [Bottom] │
│             [Shoes] [Head] [Back] [Hand] │
│                                          │
│  Thumbnail grid (4 columns):             │
│  [img] [img] [img] [img]                 │
│  [img] [img] [img] [img]                 │
│                                          │
│  Skin tone  [● ● ● ● ●]                 │
│  Hair color [color swatch]               │
│                                          │
│  [Add to Scene]                          │
└──────────────────────────────────────────┘
```

### Pose Editor (Frogmarks panel, separate from creator)

- Click a bone in the viewport → selected joint highlighted in a joint list
- Rotation sliders (X/Y/Z Euler) for the selected joint
- Pose can be saved as a named preset
- Animation clips shown as playback controls (play/stop/loop, timeline scrub)

### Grease Pencil Tool

- Toolbar button enters GP mode
- Active GP object selector (or creates a new one)
- Layer list (same pattern as raster layers)
- Color + width controls
- Brush pressure toggle
- Surface snap toggle
- Eraser mode
- Keyframe dot on timeline for GP layer

---

## Design questions that need answers before building

These are the decisions that will significantly shape the implementation. Resolve them before writing Phase A code.

| Question | Options | Recommendation |
|----------|---------|----------------|
| **Skinned vertex stride** — keep 72 bytes in a separate pipeline, or extend main pipeline to 72? | Separate pipeline (backward compat) vs single unified pipeline (simpler dispatch) | Separate — avoids breaking all existing mesh geometry |
| **Skeleton joint limit** — max joints per skeleton? | 26 (canonical only), 64, 128 | 64 — enough for future face/finger bones without exceeding typical GPU uniform limits |
| **Skinning on GPU vs CPU** | GPU vertex shader (standard) vs CPU skinning uploaded as baked positions | GPU — standard approach, uses existing storage buffer pattern from particles |
| **GP stroke screen-space vs world-space width** | Screen-space (always same pixel size) vs world-space (shrinks with distance) | Screen-space for a 2D-illustration feel; offer world-space as a toggle |
| **GP fill quality** — ear-clipping CPU projection vs GPU path rendering | Ear-clipping (already exists) vs more complex GPU approach | Ear-clipping first — add GPU path rendering in a future pass if needed |
| **Kitbash content hosting** — bundled in app vs CDN | Bundled (always available, larger bundle) vs CDN (smaller initial load, requires network) | CDN with a small "starter pack" bundled — load on demand |
| **Character color tinting** — per-slot diffuse override vs texture-based palette swap | Diffuse override (simple, coarse) vs palette swap shader (precise, complex) | Diffuse override for MVP, palette swap later |

---

## Scope boundaries — what NOT to build in this phase

- **Finger/facial bones** — the 26-joint skeleton covers the body; facial animation and finger posing are a separate phase
- **Inverse kinematics (IK)** — forward kinematics only for MVP; IK chains (foot planting, reach targets) added later
- **Morph targets / shape keys** — facial expressions driven by blend shapes, not covered here
- **Physics simulation on bones** — cloth/physics already exists on separate meshes; bone physics (hair jiggles, cape simulation driven by bones) is a future pass
- **Particle attachment to bones** — a particle emitter parented to a hand joint follows the rig; this is a one-line addition to `ParticleEmitter3D.tick()` after armatures exist
- **User-uploaded kitbash parts** — the initial library is curated/official only; user imports are a separate moderation/validation problem
- **GP vector editing** — no bezier handle editing of strokes; freehand draw + erase only for now
