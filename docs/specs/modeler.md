# Frogmarks Modeler — Stylized 3D Character Creation
**Last Updated:** 2026-05-10  

**Date:** 2026-05-10  
**Status:**
- **Phase 1 — Mesh Painting: ✅ Complete**
- **Phase 2 — EditMesh + Basic Modeling: ✅ Complete (2026-05-10)**
- **Phase 3 — Full Half-Edge + Advanced Topology: ✅ Complete (2026-05-10)**

**Goal:** A web-native stylized modeling system that lets users create low-poly characters from scratch inside Frogmarks — without leaving the app, without touching Blender, and without the complexity of a professional DCC tool.

---

## The Vision

> "Make a cute character and paint it" — fast, playful, web-native.

Frogmarks Modeler is **not** Blender. The target is closer to:

- **Dreams PS4** — immediate, playful, forgiving
- **Blockbench** — low-poly focused, web-native
- **Gravity Sketch** — gestural and expressive
- **Animal Crossing / Miis** — stylized simplicity

The moment a user feels like they are *managing technical mesh data*, we have failed. They should feel like they are sculpting a toy.

**The aesthetic this serves:**
- PS1 / N64 low-poly
- Nintendo-style stylization
- Anime characters
- Stylized indie game assets
- Cartridge world inhabitants

**What we are NOT building:**
- Blender feature parity
- PBR material graphs
- Geometry nodes
- CAD precision
- Sculpt remeshing
- Advanced retopology tools
- Multi-res sculpting

---

## Architecture — The Two-Mesh Principle

This is the core architectural decision. It must never be violated.

```
┌─────────────────────────────────────────────────────────────┐
│  EditMesh  (CPU-side authoring structure)                   │
│                                                             │
│  vertices: Vec3[]          ← editable positions             │
│  faces: Face[]             ← polygon connectivity           │
│  edges: HalfEdge[]         ← adjacency, loops, neighbors    │
│  uvs: Vec2[]               ← per-vertex UV coords           │
│  vertexColors: Vec4[]      ← per-vertex RGBA paint          │
│                                                             │
│  Supports: extrude, loop cut, knife, bevel,                │
│  proportional editing, inset, weld, subdivide              │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  Modifier Stack  (non-destructive, ordered list)            │
│                                                             │
│  [MirrorModifier, SubdivisionModifier, ...]                │
│                                                             │
│  Each modifier receives the current mesh state and         │
│  returns a new evaluated mesh. The base EditMesh is        │
│  NEVER mutated by modifiers — only by destructive ops      │
│  (extrude, knife, loop cut, delete face).                  │
└────────────────────┬────────────────────────────────────────┘
                     │ compile() — walks modifier stack
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  MeshGeometry  (GPU-ready flat buffers)                     │
│                                                             │
│  vertices: Float32Array    ← pos + normal + uv packed       │
│  indices: Uint32Array      ← triangle list                  │
│                                                             │
│  Already exists. Renderer never changes.                   │
└─────────────────────────────────────────────────────────────┘
```

**Why two representations:**
- GPUs want flat, contiguous, cache-friendly triangle lists
- Modeling tools need adjacency, loops, and connectivity
- A half-edge graph is great for editing, terrible for the GPU
- This pattern is how Blender, Maya, and all serious engines work internally

**The rule:** `EditMesh` is for authoring. `MeshGeometry` is the compiled output. The renderer only ever sees `MeshGeometry`. No topology awareness leaks into the render pipeline.

---

## Modifier Stack — Non-Destructive Operations

This is one of the most important architectural decisions. Blender's power comes largely from the fact that modifiers like Mirror and Subdivision are *virtual* — they don't change the base mesh until explicitly applied ("baked").

### The mental model

```
                You edit THIS                What renders
                    ↓                             ↓
Base EditMesh ──→ Mirror ──→ Subdivision ──→ MeshGeometry
(left half of        (generates    (smooths the
 character)           right half)   combined result)
```

The user moves a vertex on the left half. The right half mirrors automatically. The subdivision rounds both. All from editing only ~50% of the geometry.

### Interface

```typescript
interface Modifier {
  type: string;
  enabled: boolean;
  apply(mesh: EditMeshData): EditMeshData;  // pure function — no mutation
}

interface EditMeshData {
  vertices: Array<{ x: number; y: number; z: number; color: [number,number,number,number] }>;
  faces: Array<{ verts: number[] }>;
  uvs: Array<[number, number]>;
}

class EditMesh {
  // Base topology — only modified by destructive ops (extrude, knife, etc.)
  vertices: EditVertex[];
  faces: EditFace[];
  halfEdges: EditHalfEdge[];

  // Non-destructive modifier stack
  modifiers: Modifier[] = [];

  compile(): MeshGeometry {
    let data = this._toEditMeshData();           // snapshot base mesh
    for (const mod of this.modifiers) {
      if (mod.enabled) data = mod.apply(data);   // each modifier is a pure transform
    }
    return buildGpuMesh(data);                   // triangulate + pack float arrays
  }

  // Bake modifier at index — makes it permanent, removes from stack
  applyModifier(index: number): void {
    const data = this._toEditMeshData();
    const baked = this.modifiers[index].apply(data);
    this._fromEditMeshData(baked);               // write back into base mesh
    this.modifiers.splice(index, 1);
  }
}
```

### Modifier priority table

| Modifier | Priority | What it does |
|----------|----------|-------------|
| **MirrorModifier** | 🔴 Extremely High | Model one half; mirror is virtual. `clipping: true` welds center verts, preventing pulling apart. |
| **SubdivisionModifier** | 🟠 High | Smooth low-poly base with Catmull-Clark. Toggle off to edit blocky cage, on to preview smooth result. |
| **ArrayModifier** | 🟡 Medium | Duplicate geometry N times offset — great for buildings, fences, chains |
| **SolidifyModifier** | 🟡 Medium | Add thickness to a flat mesh — useful for clothing panels, hair cards |
| **BevelModifier** | 🟡 Medium | Round all edges by a fixed amount — softer stylized looks |
| **ArmatureModifier** | 🟢 Exists | Already implemented via `SkinnedMesh3D` — conceptually the same pattern |

### MirrorModifier — detailed spec

This is the most important modifier. Users almost always want it when modeling characters.

```typescript
class MirrorModifier implements Modifier {
  type = 'mirror';
  enabled = true;
  axis: 'x' | 'y' | 'z' = 'x';
  mergeThreshold = 0.001;  // weld verts within this distance of mirror plane
  clipping = true;          // prevents dragging center verts past mirror plane

  apply(mesh: EditMeshData): EditMeshData {
    const mirroredVerts = mesh.vertices.map(v => ({
      ...v,
      x: this.axis === 'x' ? -v.x : v.x,
      y: this.axis === 'y' ? -v.y : v.y,
      z: this.axis === 'z' ? -v.z : v.z,
    }));

    const offset = mesh.vertices.length;
    const mirroredFaces = mesh.faces.map(f => ({
      // Reverse winding order on mirrored side (flip normals)
      verts: [...f.verts].reverse().map(i => i + offset),
    }));

    const combined = {
      vertices: [...mesh.vertices, ...mirroredVerts],
      faces: [...mesh.faces, ...mirroredFaces],
      uvs: [...mesh.uvs, ...mesh.uvs],
    };

    // Weld vertices on the mirror plane
    if (this.mergeThreshold > 0) {
      return weldVertices(combined, this.mergeThreshold, this.axis);
    }
    return combined;
  }
}
```

### SubdivisionModifier — simplified Catmull-Clark

```typescript
class SubdivisionModifier implements Modifier {
  type = 'subdivision';
  enabled = true;
  iterations = 1;   // 1 = smooth, 2 = very smooth, 3+ = rarely needed

  apply(mesh: EditMeshData): EditMeshData {
    let result = mesh;
    for (let i = 0; i < this.iterations; i++) {
      result = catmullClarkSubdivide(result);
    }
    return result;
  }
}
```

### What "Apply Modifier" means

When the user clicks "Apply" on the Mirror modifier:
1. `editMesh.applyModifier(index)` is called
2. The mirrored geometry is baked into `editMesh.vertices` and `editMesh.faces`
3. The modifier is removed from the stack
4. The mesh now has real topology on both sides (editable as normal vertices)
5. This is **destructive** — push to `UndoManager3D` first

### Non-destructive vs. destructive — the distinction

| Operation | Type | Stored where |
|-----------|------|-------------|
| Move vertex | Destructive (mutates base mesh) | Undoable via `UndoManager3D` |
| Extrude face | Destructive | Undoable |
| Loop cut | Destructive | Undoable |
| Mirror modifier | Non-destructive | Lives in modifier stack, free to toggle/remove |
| Subdivision modifier | Non-destructive | Lives in modifier stack |
| Apply modifier | Destructive (bakes stack entry) | Undoable |

---

## Half-Edge Mesh Structure

The half-edge mesh is the data structure that enables modeling tools. It is the authoring layer only.

### Why "half-edge"?

Each undirected edge `A—B` becomes two directed half-edges:

```
A ──────→ B        (half-edge h1, belongs to face on left)
B ──────→ A        (half-edge h2, h1.twin = h2, belongs to face on right)
```

Each half-edge stores:

```typescript
interface HalfEdge {
  vertex: number;          // index of the vertex this edge POINTS TO
  twin: number;            // index of the opposite half-edge
  next: number;            // next half-edge around the same face
  prev: number;            // previous half-edge around the same face
  face: number;            // face this half-edge borders (-1 = boundary)
  uv: number;              // UV coordinate index at this half-edge's vertex
}

interface EditFace {
  halfEdge: number;        // any half-edge that borders this face
  vertexCount: number;     // 3 = triangle, 4 = quad
}

interface EditVertex {
  position: [number, number, number];
  halfEdge: number;        // any outgoing half-edge from this vertex
  color: [number, number, number, number]; // vertex color
}
```

### What adjacency queries become possible

| Query | Use case |
|-------|----------|
| "What faces share edge AB?" | Bevel, loop cut, extrude, normals |
| "What edges form a loop?" | Loop cut, edge select, subdivision |
| "What faces surround vertex V?" | Proportional editing, smooth normals |
| "Is this edge a boundary?" | UV seam detection, extrude |
| "What is the neighboring face across this edge?" | Subdivision, bevels |

Without half-edge, all of these require a full mesh scan. With half-edge, they are O(k) where k = valence.

### When half-edge is needed vs. not

| Operation | Needs half-edge? |
|-----------|-----------------|
| Mesh painting (raycast → UV → paint texture) | ❌ No |
| Vertex drag | ❌ No (just move a position) |
| Face extrude (simple) | ⚠️ Partial (need face's edges) |
| Mirror modifier | ❌ No |
| Proportional editing | ❌ No (just distance-weighted drag) |
| Loop cut | ✅ Yes |
| Knife tool | ✅ Yes |
| Bevel | ✅ Yes |
| Subdivision | ✅ Yes |
| Edge dissolve | ✅ Yes |

**Implication:** Phases 1 and 2 (painting + basic editing) can use a simpler adjacency structure. Full half-edge becomes necessary in Phase 3 (loop cut, knife, bevel).

---

## Coloring Strategy

This matters enormously for how complex UV tooling needs to be.

### Option 1 — Vertex Colors (default, Phase 2)

Each vertex stores an RGBA color. GPU interpolates between vertices. No UV unwrap required.

```
Face painted → all 3 vertex colors set → flat shading → looks great
```

**Best for:** PS1/N64 aesthetic, flat-shaded characters, color-blocked stylized art  
**Limitations:** Can't do fine details, logos, anime eyes on face geometry  
**Complexity:** Almost zero — vertex colors already fit in the existing instance buffer

### Option 2 — UV-Mapped Textures (Phase 1 for imports, Phase 3 for native models)

Mesh has UV coordinates. A per-mesh `GPUTexture` stores hand-painted detail.

**Best for:** Anime characters, clothing graphics, face details, decals  
**Limitations:** Requires UV unwrap  
**Complexity:** High for UV editing, moderate for painting (raycast → barycentric → texel)

### Option 3 — Auto-Unwrap (Phase 3)

Engine automatically generates UV islands (angle-based or smart project). User never touches seams.

**Best for:** Beginner-friendly texture painting on native Salsa models  
**Complexity:** Moderate (LSCM or angle-based unwrap algorithm, ~400 lines)

### Recommended progression:

```
Phase 1: UV painting on imported GLTF meshes (UVs already exist)
Phase 2: Vertex colors on native EditMesh models
Phase 3: Auto-unwrap for native models → UV texture painting
Phase 4: Manual UV seam editing (advanced users only)
```

---

## Implementation Plan

### Phase 1 — Mesh Painting on Imported Models ✅ Complete
**Shipped:** 2026-05-10  
**No new architecture required — builds entirely on existing systems**

The most immediately magical feature. Users import a GLTF character from Blender, then paint on it directly inside Frogmarks. No UV tooling needed because GLTF models already have UVs.

#### Shipped implementation

| File | Change |
|------|--------|
| `src/renderer/3d/mesh-picker.ts` | `PickResult` extended with `baryU`/`baryV`. Both BVH and linear scan paths return barycentric coords. `rayTriangleUV()` helper replaces `rayTriangle()`. |
| `src/scene-graph/shapes/mesh-3d.ts` | Added `paintTexture: GPUTexture \| null`, `paintBuffer: Uint8Array \| null`, `paintTexSize: number`. |
| `src/services/managers/mesh-paint-manager.ts` | New manager: CPU brush stamp → dirty-rect GPU upload, full-buffer undo/redo (max 20 snapshots). |
| `src/services/managers/index.ts` | Barrel export for `MeshPaintManager`. |
| `src/services/shape-manager.ts` | `shapeManager.meshPaint` delegate + full public API (enter/exit, paintDab, endStroke, brush controls, undo/redo). |

**Public API (via ShapeManager):**
```typescript
shapeManager.enterMeshPaintMode(meshId, texSize?)   // allocates 1024×1024 paint texture, sets as diffuse
shapeManager.exitMeshPaintMode()
shapeManager.paintMeshDab(hit: PickResult)           // stamp one dab at hit UV
shapeManager.endMeshPaintStroke()                    // push undo snapshot
shapeManager.setMeshPaintBrushColor(r, g, b, a?)
shapeManager.setMeshPaintBrushRadius(px)
shapeManager.setMeshPaintBrushHardness(h)            // 0=feathered, 1=hard
shapeManager.undoMeshPaint() / redoMeshPaint()
shapeManager.canUndoMeshPaint / canRedoMeshPaint
```

#### What existed already:
- `MeshPicker` — Möller–Trumbore ray-triangle intersection, returns hit world position
- `BrushStampPipeline` — stamps brush shapes to a GPU texture
- `TextureLibrary` — manages GPU textures, handles upload

#### Original spec (what needed to be added):

**1. Barycentric coordinates from `MeshPicker`**

`MeshPicker.pick()` currently returns `{ position, meshId }`. Extend it to return:

```typescript
interface MeshHitResult {
  position: [number, number, number];   // world-space hit
  meshId: string;
  triangleIndex: number;                // which triangle was hit
  barycentricU: number;                 // weight for vertex 1
  barycentricV: number;                 // weight for vertex 2
  // barycentricW = 1 - u - v (weight for vertex 0)
}
```

The Möller–Trumbore algorithm already computes `u` and `v` internally — just expose them.

**2. Per-mesh paint texture**

`Mesh3D` gets an optional `paintTexture?: GPUTexture` field with a matching CPU-side `Uint8Array paintBuffer`.

- Default size: 1024×1024 (configurable)
- Initialized as transparent on enter-paint-mode
- Written by brush stamps, uploaded back to GPU after each stroke

**3. UV interpolation**

Given a hit triangle and barycentric coords:

```typescript
// Pseudocode — actual vertices from mesh.geometry float array
const uv0 = getVertexUV(mesh, triangleIndex * 3 + 0);
const uv1 = getVertexUV(mesh, triangleIndex * 3 + 1);
const uv2 = getVertexUV(mesh, triangleIndex * 3 + 2);

const w = 1 - baryU - baryV;
const hitUV = [
  w * uv0[0] + baryU * uv1[0] + baryV * uv2[0],
  w * uv0[1] + baryU * uv1[1] + baryV * uv2[1],
];

// Convert UV [0,1] → texel [0, texSize-1]
const texX = Math.round(hitUV[0] * TEX_SIZE);
const texY = Math.round((1 - hitUV[1]) * TEX_SIZE); // flip Y (UV origin = bottom-left)
```

**4. Brush stamp into paint buffer**

On pointer move in paint mode, for each new dab position:
- Raycast against selected mesh
- Compute hit UV → texel coord
- Stamp brush shape (Gaussian falloff circle) into `paintBuffer` at that texel
- Call `device.queue.writeTexture()` for the dirty rect

**5. ShapeManager API**

```typescript
// Enter/exit paint mode — limits raycasting to the selected mesh
shapeManager.enterMeshPaintMode(meshId: string): boolean
shapeManager.exitMeshPaintMode(): void
shapeManager.isMeshPaintMode(): boolean

// Brush controls (reuse existing brush settings where possible)
shapeManager.setMeshPaintColor(r: number, g: number, b: number, a: number): void
shapeManager.setMeshPaintBrushSize(radius: number): void
shapeManager.setMeshPaintOpacity(opacity: number): void

// Texture capture/restore
shapeManager.getMeshPaintTextureAsBlob(meshId: string): Promise<Blob>
shapeManager.setMeshPaintTextureFromBlob(meshId: string, blob: Blob): Promise<void>

// Undo (full texture snapshots, capped at N)
shapeManager.undoMeshPaint(): boolean
shapeManager.redoMeshPaint(): boolean
```

#### What NOT to implement yet:
- Painting across UV seams (hard, defer)
- Symmetry painting (defer)
- Mipmap updates (just upload full texture for now)
- Painting on skinned/animated meshes (defer)

---

### Phase 2 — EditMesh + Basic Modeling ✅ Complete (2026-05-10)
**New architecture: EditMesh CPU struct + vertex colors**

Users can create characters from scratch using Salsa's built-in primitive shapes (box, sphere, cylinder) and basic edit operations. Vertex colors replace UV textures for this phase.

#### Shipped implementation

| File | Change |
|------|--------|
| `src/scene-graph/shapes/edit-mesh.ts` | **NEW** — `EditVertex`, `EditFace`, `EditHalfEdge`, `EditMeshData`, `Modifier` interface, `MirrorModifier`, `SubdivisionModifier` (Catmull-Clark), `EditMesh` class with primitive constructors + half-edge topology builder + all destructive ops + `compile()` → `MeshGeometry` |
| `src/scene-graph/shapes/mesh-3d.ts` | Added `editMesh: EditMesh \| null` field + `syncFromEditMesh()` method |
| `src/services/managers/mesh-edit-manager.ts` | **NEW** — selection state, undo-backed destructive ops, modifier stack management |
| `src/services/managers/index.ts` | Barrel export for `MeshEditManager` |
| `src/services/managers/scene3d-manager.ts` | Added `pushCommand3D()` to expose undo manager to external managers |
| `src/services/shape-manager.ts` | Full Phase 2 public API (see below) |

**Vertex colors:** stored in `EditVertex.color [r,g,b,a]`, compiled into `MeshGeometry.vertexColors: Float32Array` (4 floats per vertex). The renderer uses vertex colors when present via the dedicated vertex-color pipeline (two-slot VB, Gouraud with per-vertex color). See [reference/15-3d-rendering-system.md — Vertex Color Pipeline](../reference/15-3d-rendering-system.md).

**Modifier note:** `MirrorModifier` welding operates on plane proximity (`mergeThreshold = 0.001`). `SubdivisionModifier` uses simplified Catmull-Clark that works correctly on pure-quad meshes (which is what `fromBox` produces). Mixed tri/quad meshes subdivide with some boundary artifacts — acceptable for Phase 2.

#### New file: `src/scene-graph/shapes/edit-mesh.ts`

```typescript
export interface EditVertex {
  x: number; y: number; z: number;
  color: [number, number, number, number]; // vertex color RGBA
  halfEdge: number;  // index of one outgoing half-edge
}

export interface EditFace {
  halfEdge: number;  // index of one bordering half-edge
}

export interface EditHalfEdge {
  vertex: number;    // destination vertex
  twin: number;      // opposite half-edge
  next: number;      // next half-edge in this face's loop
  prev: number;      // previous half-edge in this face's loop
  face: number;      // face this belongs to (-1 = boundary)
}

export class EditMesh {
  vertices: EditVertex[] = [];
  faces: EditFace[] = [];
  halfEdges: EditHalfEdge[] = [];

  // Non-destructive modifier stack — evaluated in order during compile()
  modifiers: Modifier[] = [];

  // Compiles base mesh + modifier stack → GPU-ready MeshGeometry
  compile(): MeshGeometry {
    let data = this._toEditMeshData();
    for (const mod of this.modifiers) {
      if (mod.enabled) data = mod.apply(data);
    }
    return buildGpuMesh(data);
  }

  // Bake modifier at index — permanent, removes from stack
  applyModifier(index: number): void { ... }

  // Primitive constructors
  static fromBox(w: number, h: number, d: number): EditMesh { ... }
  static fromSphere(radius: number, segments: number): EditMesh { ... }
  static fromCylinder(radius: number, height: number, segments: number): EditMesh { ... }
  static fromPolygon(points: [number, number][], height?: number): EditMesh { ... }
  static fromCircle(radius: number, segments: number, height?: number): EditMesh { ... }

  // Destructive operations (Phase 2) — mutate base mesh, push to UndoManager3D
  moveVertex(vIdx: number, dx: number, dy: number, dz: number): void
  extrudeFace(fIdx: number, distance: number): number[]  // returns new face indices
  insetFace(fIdx: number, amount: number): number        // returns new inner face index
  deleteFace(fIdx: number): void
  weldVertices(v1: number, v2: number): void

  // Phase 3 destructive ops (half-edge traversal required)
  loopCut(halfEdgeIdx: number, t: number): void
  bevelEdge(halfEdgeIdx: number, amount: number): void
}
```

#### `Mesh3D` extension

```typescript
// Mesh3D gets an optional editMesh field
editMesh?: EditMesh;

// When present, syncFromEditMesh() is called after each operation
syncFromEditMesh(): void {
  if (!this.editMesh) return;
  this.geometry = this.editMesh.compile();
  this.gpuDirty = true;
}
```

#### Phase 2 operations (no full half-edge needed):

| Operation | Type | Implementation sketch |
|-----------|------|-----------------------|
| **Mirror modifier** | Non-destructive | `MirrorModifier` in stack — base mesh untouched, virtual mirror in `compile()` |
| **Subdivision modifier** | Non-destructive | `SubdivisionModifier` in stack — toggle off for cage editing, on for preview |
| **Vertex drag** | Destructive | Update `editMesh.vertices[i].position`, call `syncFromEditMesh()` |
| **Proportional editing** | Destructive | On drag, weight neighboring vertex moves by `exp(-d²/radius²)` |
| **Face select + drag** | Destructive | Move all face vertices together |
| **Face extrude** | Destructive | Copy face vertices, offset along face normal, create side quads, stitch edges |
| **Inset** | Destructive | Shrink face inward along its plane, creating a border ring |
| **Vertex colors** | Destructive | `editMesh.vertices[i].color = [r, g, b, a]` → packed into vertex buffer |
| **Scale/rotate selection** | Destructive | Transform vertex positions in selection around pivot |
| **Apply modifier** | Destructive (bakes non-dest) | `editMesh.applyModifier(i)` — bakes evaluated result into base mesh |

#### ShapeManager API (Phase 2)

```typescript
// Enter/exit edit mode for a mesh
shapeManager.enterMeshEditMode(meshId: string): boolean
shapeManager.exitMeshEditMode(meshId: string): void

// Convert a Salsa primitive to an editable EditMesh
shapeManager.makeEditable(meshId: string): boolean

// Selection
shapeManager.selectVertex3D(meshId: string, vertexIdx: number, addToSelection?: boolean): void
shapeManager.selectFace3D(meshId: string, faceIdx: number, addToSelection?: boolean): void
shapeManager.clearMeshSelection3D(meshId: string): void

// Core operations
shapeManager.extrudeFace3D(meshId: string, faceIdx: number, distance: number): boolean
shapeManager.insetFace3D(meshId: string, faceIdx: number, amount: number): boolean
shapeManager.deleteFace3D(meshId: string, faceIdx: number): boolean
shapeManager.weldVertices3D(meshId: string, v1: number, v2: number): boolean

// Modifier stack (non-destructive)
shapeManager.addMirrorModifier3D(meshId: string, axis: 'x' | 'y' | 'z', clipping?: boolean): number  // returns modifier index
shapeManager.addSubdivisionModifier3D(meshId: string, iterations: number): number
shapeManager.setModifierEnabled3D(meshId: string, index: number, enabled: boolean): void
shapeManager.removeModifier3D(meshId: string, index: number): void
shapeManager.applyModifier3D(meshId: string, index: number): boolean   // bake → destructive, undoable
shapeManager.getModifiers3D(meshId: string): Array<{ type: string; enabled: boolean; [key: string]: any }>

// Vertex colors
shapeManager.paintVertexColor3D(meshId: string, vertexIdx: number, r: number, g: number, b: number, a: number): void
shapeManager.paintFaceColor3D(meshId: string, faceIdx: number, r: number, g: number, b: number, a: number): void

// Undo (all edit operations push to UndoManager3D)
// Uses existing sm.undo3D() / sm.redo3D()
```

---

### Phase 3 — Full Half-Edge + Advanced Tools
**Target:** 6–10 weeks after Phase 2  
**Full half-edge structure, loop cut, knife, bevel, auto-UV**

At this point `EditMesh` gets a proper half-edge implementation. The CPU authoring struct gains full adjacency awareness.

#### Shipped (2026-05-10):

| Tool | Status | File |
|------|--------|------|
| **Loop cut** | ✅ Shipped | `edit-mesh.ts → EditMesh.loopCut()` |
| **Edge dissolve** | ✅ Shipped | `edit-mesh.ts → EditMesh.dissolveEdge()` |
| **Edge selection** | ✅ Shipped | `mesh-edit-manager.ts → selectEdge()` |
| **Bevel edge** | ✅ Shipped | `edit-mesh.ts → EditMesh.bevelEdge()` |
| **Auto UV unwrap** | ✅ Shipped | `edit-mesh.ts → EditMesh.autoUnwrap()` |
| **Knife tool** | ✅ Shipped | `edit-mesh.ts → EditMesh.knifeCut()` |

Public API: `sm.loopCut3D(meshId, halfEdgeIdx, t?)`, `sm.dissolveEdge3D(meshId, halfEdgeIdx)`, `sm.selectEdge3D(meshId, halfEdgeIdx)`, `sm.bevelEdge3D(meshId, halfEdgeIdx, amount)`, `sm.autoUnwrap3D(meshId)`, `sm.knifeCut3D(meshId, x0, y0, x1, y1, cw, ch)`.
UI guide: `docs/ui/mesh-editing.md`.

#### Operations unlocked by half-edge:

| Tool | What it does | Status |
|------|-------------|--------|
| **Loop cut** | Insert an edge ring across a band of quads — follows edge loop through twin/next chain | ✅ Shipped |
| **Edge dissolve** | Remove an edge and merge its two faces | ✅ Shipped |
| **Knife tool** | Intersect a screen-space line with the mesh surface — requires finding all triangles the line crosses and inserting new edges | ✅ Shipped |
| **Bevel** | Widen an edge into a face strip — requires knowing what faces share the edge | ✅ Shipped |
| **Subdivision** | Catmull-Clark or Loop subdivision — requires full connectivity graph | ✅ Available as non-destructive modifier |
| **Bridge** | Connect two open loops with new geometry — requires boundary traversal | ✅ Shipped |

#### UV Tooling (Phase 3):

1. **Auto-unwrap** — Smart-project (box/triplanar) UV generation. **✅ Shipped** — `sm.autoUnwrap3D(meshId)`. Each vertex projected along its dominant face-normal axis, normalised to [0,1].
2. **Smart project** — Project UVs from dominant face normals, reasonable for blocky shapes.
3. **Manual seam marking** (advanced) — Mark edges as UV seams, run LSCM unwrap.

---

### Phase 4 — Advanced Stylized DCC (Long-term)
**No timeline — grow based on user need**

- Subdivision modifier (Catmull-Clark) as a non-destructive stack layer
- Weight painting for armature-driven deformation of native EditMesh models
- Grease Pencil strokes parented to EditMesh surface
- Collaborative mesh editing (multiple users editing the same EditMesh live)
- Simple retopology tools
- Normal map baking from high-res to low-res

---

## Priority Queue — What to Build and When

### Right now (this sprint):

1. **Mesh painting on GLTF imports** (Phase 1)
   - Extend `MeshPicker` to return barycentric coords + triangle index
   - Add `paintTexture` + `paintBuffer` to `Mesh3D`
   - Wire pointer events in paint mode: raycast → UV → stamp → `writeTexture`
   - `enterMeshPaintMode` / `exitMeshPaintMode` on `ShapeManager`
   - Texture undo stack (snapshot-based, cap at 20)

### Next (after Phase 1 is working and feels good):

2. **EditMesh structure** — implement the `EditMesh` class with `compile()`, primitive constructors (`fromBox`, `fromSphere`, `fromCylinder`), and connect to `Mesh3D.editMesh`
3. **Vertex drag + mirror modifier** — the two highest-impact operations for character shaping
4. **Proportional editing** — makes drag feel buttery and professional
5. **Vertex colors** — instant painting without UV complexity; default workflow for native models
6. **Face extrude + inset** — unlocks most stylized character shapes

### After basic modeling works:

7. **Face color painting** — click a face, pick color → sets all 3 vertex colors (feels like "painting" without UVs)
8. **Auto-UV unwrap** — needed once users want to paint fine details on native models
9. **UV painting on native models** — Phase 1 system applied to auto-unwrapped native meshes
10. **Full half-edge + loop cut** — the complexity spike, deferred until the simpler operations prove the workflow

### Much later:

11. Knife tool
12. Bevel
13. Manual UV seam editing
14. Subdivision modifier
15. Weight painting on native models

---

## Key Files — Where Things Will Live

| File | Role |
|------|------|
| `src/scene-graph/shapes/edit-mesh.ts` | **NEW** — EditMesh + HalfEdge structures, compile() |
| `src/scene-graph/shapes/mesh-3d.ts` | Add `editMesh?: EditMesh`, `paintTexture?: GPUTexture`, `paintBuffer?: Uint8Array`, `syncFromEditMesh()` |
| `src/renderer/3d/mesh-picker.ts` | Extend to return `triangleIndex`, `barycentricU`, `barycentricV` |
| `src/services/managers/mesh-paint-manager.ts` | **NEW** — paint mode state, undo stack, brush stamps |
| `src/services/managers/mesh-edit-manager.ts` | **NEW** — selection state, edit operations, wires to UndoManager3D |
| `src/services/shape-manager.ts` | New public API methods (enterMeshPaintMode, enterMeshEditMode, etc.) |
| `src/renderer/3d/renderer-3d.ts` | Render vertex colors when present (pack into instance buffer or vertex buffer) |

---

## What Makes This Different from Blender

| Blender | Frogmarks Modeler |
|---------|-------------------|
| All modeling complexity exposed | Simplified subset, stylized focus |
| Manual UV seam marking required | Auto-unwrap by default; seams optional |
| Vertex colors are secondary | Vertex colors are the default paint workflow |
| Export-then-import for web | Live in-browser, publish instantly |
| Solo tool | Collaborative — multiple users editing |
| PBR-first workflow | Flat/cel/PS1 stylization first |
| User manages technical data | Feels like sculpting a toy |

The moat is not modeling feature count. The moat is: **hybrid 2D+3D, web-native, collaborative, instant-publish, stylized character creation**. Modeling is one tool in that vision, not the whole vision.

---

## Open Questions (for design, not engine)

1. **How does the user enter "edit mode"?** Double-click a mesh? A dedicated toolbar button? Inline with a mode ring like Blender (Object/Edit/Sculpt)?
2. **How does vertex selection feel on touch?** Lasso select? Tap to select? Box select?
3. **Does face paint mode and vertex edit mode coexist, or switch?** (Recommendation: switch — keeps UI clear)
4. **What happens to armature deformation on EditMesh models?** (Probably: edit mode disables deformation temporarily; exit edit → reapply armature)
5. **How is the mirror modifier presented?** A button in the toolbar? A gizmo indicator showing the mirror plane?
