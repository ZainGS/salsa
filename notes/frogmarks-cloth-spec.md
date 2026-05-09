# Cloth / Banner Maker — Salsa + Frogmarks Spec

## Overview

The Cloth Maker is a modal tool that lets users build a 2D triangulated mesh, apply GPU-computed cloth physics (hang or drape), optionally solidify it into a volume, then finalize it into the 3D scene as a `ClothMesh3D` node. Designed for: triangle string banners, tapestries, draped blankets, flags, ribbons, tent fabric.

**Answering the thickness question up front:** Yes. A simulated cloth surface can be solidified into a true 3D solid by extruding each vertex along its normal by a `thickness` value, connecting the inner and outer shells with wall quads along the perimeter. For a blanket with rounded corners: the grid boundary itself can carry a corner-radius setting that replaces sharp grid corners with a circular arc of vertices — those arc verts simulate and solidify exactly like any other vertex, giving you smooth rounded cloth edges naturally.

---

## User Flow (End to End)

```
Frogmarks → [New 3D Object] → [Cloth / Banner]
     ↓
ClothBuilderModal opens (full-screen or large panel)
     ↓
  ┌──────────────────────────────────────────────┐
  │  BUILDER VIEW                                │
  │  ┌────────────────────┐  ┌────────────────┐  │
  │  │  Cloth canvas      │  │  Right panel   │  │
  │  │  (orthographic)    │  │  - Grid props  │  │
  │  │  Grid of quads     │  │  - Physics     │  │
  │  │  Click = add cell  │  │  - Solidify    │  │
  │  │  Red dots = pins   │  │  - Presets     │  │
  │  └────────────────────┘  └────────────────┘  │
  │  [Tools: Build | Pin | Erase]                │
  │  [Simulate: Hang | Drape]   [Create]         │
  └──────────────────────────────────────────────┘
     ↓ Create
ClothMesh3D added to 3D scene layer, modal closes
```

---

## Salsa Engine

### 1. `ClothMesh3D` Node (`src/scene-graph/shapes/cloth-mesh-3d.ts`)

Extends `Mesh3D`. Stores the cloth's build state so it can be re-edited after creation.

```typescript
export interface ClothGridConfig {
  cols: number;            // number of quad columns
  rows: number;            // number of quad rows
  cellSize: number;        // world-unit spacing between verts (e.g. 0.1)
  cornerRadius: number;    // 0 = sharp corners, >0 = arc verts at corners (in cells)
  activeCells: boolean[];  // flat [row * cols + col], which quads exist
  pinnedVertices: number[]; // vertex indices that are fixed in simulation
}

export interface ClothPhysicsConfig {
  gravity: number;         // m/s² downward (default 9.8)
  damping: number;         // velocity retention per step (0.98)
  stiffness: number;       // constraint solve iterations (20–60)
  thickness: number;       // 0 = surface only, >0 = solidify (world units)
  solidifyRounded: boolean; // smooth the solidified wall boundary
  /** Optional wind force vector (world units/s²). Applied each integrate step. */
  wind?: { x: number; y: number; z: number };
}

export interface ClothSimState {
  positions: Float32Array;    // current vertex positions (x,y,z per vert)
  isSimulated: boolean;       // true = positions are post-simulation
  simulationMode: 'hang' | 'drape' | 'none';
}

export class ClothMesh3D extends Mesh3D {
  readonly clothConfig: ClothGridConfig;
  readonly physicsConfig: ClothPhysicsConfig;
  readonly simState: ClothSimState;
  // geometry (vertices/indices) in Mesh3D is the BAKED result
}
```

**Serialization:** `clothConfig`, `physicsConfig`, `simState.simulationMode`, and `simState.isSimulated` go into `scene3d.json`. The baked `geometry` (positions, normals, indices) goes into the existing `Mesh3D` geometry slot. Re-editing restores `ClothGridConfig` and re-runs the simulation.

---

### 2. Cloth Geometry Builder (`src/renderer/3d/cloth-geometry-builder.ts`)

Pure CPU code that converts a `ClothGridConfig` into geometry buffers. Called at build time and whenever the grid changes.

```
buildClothGeometry(config: ClothGridConfig): {
  vertices: Float32Array,   // pos(3) + normal(3) + uv(2) + tangent(4) per vert
  indices: Uint32Array,
  constraintGraph: ConstraintGraph,
  vertexCount: number,
  /** Triangle-area-weighted inverse masses per vertex (Matt Fisher §4.1).
   *  inverseMass[v] = 1 / sum(area_of_incident_triangle / 3).
   *  Pinned vertices receive inverseMass = 0 (treated as infinite mass).
   *  This gives lighter corners and heavier interior fabric — physically correct
   *  and prevents the stiff-boundary oscillation you get with uniform mass. */
  inverseMass: Float32Array,
  /** Flat XZ world positions (x,y,z) for each vertex — used to seed the simulator. */
  flatPositions: Float32Array,
}
```

**Vertex layout:**

For a `cols × rows` grid of quads, vertices sit at integer `(col, row)` positions on a flat XZ plane. Only vertices that belong to at least one active cell are generated. Vertex index is computed from the active set (dense packing). UVs are `(col/cols, row/rows)`.

**Corner radius:**

When `cornerRadius > 0`, corner cells are replaced with arc vertices. For each corner:
- Remove the corner vertex
- Insert `arcSegments` (4–8) vertices tracing a quarter-circle arc at `radius = cornerRadius * cellSize`
- Connect arc verts to adjacent edge verts with fan triangles
- Corner radius is computed at build time; no special casing at simulation time

**Constraint graph:**

Three constraint types extracted from active cells:

| Type | Connects | Enforces |
|---|---|---|
| Structural | Adjacent verts (horizontal/vertical edges) | Rest length |
| Shear | Diagonal verts within a quad | Resist diagonal stretch |
| Bend | Verts two steps apart across shared edge | Resist sharp creasing |

Stored as flat `Uint32Array` of `[a, b, restLength_f32_bits]` pairs, grouped by type (structural first, then shear, then bend). This ordering enables the GPU constraint solver to process each group in parallel without conflicts.

**Graph coloring for GPU parallel solving:**

Within each constraint type, constraints that share a vertex would race on GPU. Precompute a greedy graph coloring (CPU, one-shot at build time): assign each constraint a color such that no two same-color constraints share a vertex. Store constraints sorted by color within each type. The compute shader then processes one color at a time, all in parallel.

---

### 3. Cloth Simulator (`src/renderer/3d/cloth-simulator.ts`)

GPU compute pipeline. Three passes per simulation tick.

#### Buffers

| Buffer | Format | Size |
|---|---|---|
| `positionBuf` | `vec4f` (w=unused) | `vertCount × 16` |
| `prevPositionBuf` | `vec4f` | `vertCount × 16` |
| `pinnedBuf` | `f32` (0=free, 1=pinned) | `vertCount × 4` |
| `constraintBuf` | `u32, u32, f32` | `constraintCount × 12` |
| `constraintColorOffsets` | `u32` | colors × 4 (start index per color-group) |
| `paramsBuf` | uniform | gravity, damping, dt, iteration count |

#### Pass 1 — Verlet Integration

```wgsl
@compute @workgroup_size(64)
fn integrate(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= vertCount || pinned[i] > 0.5) { return; }
  let pos  = positions[i].xyz;
  let prev = prevPositions[i].xyz;
  let vel  = (pos - prev) * params.damping;
  prevPositions[i] = vec4(pos, 0.0);
  positions[i]     = vec4(pos + vel + params.gravity * params.dt * params.dt, 0.0);
}
```

#### Pass 2 — Constraint Solve (iterated N times)

One dispatch per color group per iteration. Each thread handles one constraint:

```wgsl
@compute @workgroup_size(64)
fn solveConstraints(@builtin(global_invocation_id) id: vec3<u32>) {
  let ci = colorOffset + id.x;
  let a  = constraints[ci].a;
  let b  = constraints[ci].b;
  let rest = constraints[ci].restLength;
  
  var pa = positions[a].xyz;
  var pb = positions[b].xyz;
  let diff = pb - pa;
  let dist = length(diff);
  if (dist < 0.0001) { return; }
  
  let correction = diff * ((dist - rest) / dist * 0.5);
  let wa = 1.0 - pinned[a];  // inverseMass: 0 if pinned
  let wb = 1.0 - pinned[b];
  let wsum = wa + wb;
  if (wsum < 0.0001) { return; }
  
  positions[a] = vec4(pa + correction * (wa / wsum), 0.0);
  positions[b] = vec4(pb - correction * (wb / wsum), 0.0);
}
```

Run structural → shear → (optional) bend, each as separate dispatches per color group, repeated `stiffness` times total.

#### Pass 3 — Collision

For "Drape" mode, collide against a user-specified proxy shape.

Supported proxies (analytic, no mesh needed):
- **Ground plane** `y = 0`
- **Sphere** `(center, radius)` — push vert out of sphere
- **Box** `(min, max)` — push vert to nearest face (signed distance)

```wgsl
fn resolveCollision(pos: vec3f) -> vec3f {
  // Ground plane
  if (pos.y < groundY) { return vec3(pos.x, groundY, pos.z); }
  // Sphere
  let d = pos - sphereCenter;
  if (length(d) < sphereRadius) { return sphereCenter + normalize(d) * sphereRadius; }
  return pos;
}
```

The collision proxy is set by Frogmarks as part of `DrapeConfig` and is uploaded once to the params uniform.

#### Convergence Detection

After each full iteration sweep, copy one value from `positionBuf` to a small readback buffer. Compare with previous frame. When total movement per vertex falls below `1e-4 world units`, stop iterating. The "simulate to steady state" loop for the "Create" button runs synchronously until convergence (capped at 5000 steps).

---

### 4. Primitive Picking Pass (Builder Only)

Separate render pass inside the cloth builder viewport. **Not** the scene-level `MeshPicker`.

Each quad cell renders as 2 triangles with a unique cell ID encoded as color: `r = (id >> 16) & 0xFF, g = (id >> 8) & 0xFF, b = id & 0xFF`. Uses `@builtin(primitive_index)` mapped back to cell index.

On pointer move:
1. Render cell-ID pass to an offscreen `r8g8b8a8` texture
2. `copyTextureToBuffer` at `(mouseX, mouseY)` → 1×1 region
3. Async readback decodes cell ID → highlight that cell in the next frame

On click (Build mode): add the hovered cell to `activeCells`. On click (Erase mode): remove it.

On click (Pin mode): picking renders vertex dots as oversized quads with vertex IDs; click toggles `pinnedVertices`.

The picking texture is rendered at full canvas resolution but only 1 pixel is read back per frame. Performance is negligible.

---

### 5. Cloth Solidifier (`src/renderer/3d/cloth-solidifier.ts`)

Converts a simulated cloth surface into a closed volumetric mesh. Called when `physicsConfig.thickness > 0`.

```
solidifyCloth(
  outerVerts: Float32Array,  // simulated positions
  indices: Uint32Array,
  normals: Float32Array,
  thickness: number,
): { vertices: Float32Array, indices: Uint32Array }
```

**Algorithm:**

1. **Find boundary edges** — edges referenced by only one triangle. These form the perimeter of the cloth.
2. **Generate inner shell** — duplicate all vertices, offset each by `−normal × thickness`. Reverse winding on inner triangles.
3. **Generate wall quads** — for each boundary edge `(a, b)`:
   - Outer verts: `a, b`
   - Inner verts: `a', b'` (corresponding inner shell verts)
   - Emit two triangles: `(a, b, b')` and `(a, b', a')`
4. **Merge and output** — outer shell + inner shell + walls = closed solid.

**Rounded wall edges:**

When `solidifyRounded = true`, the wall verts along the boundary are smoothed with a half-cylinder profile instead of a flat wall. Each boundary edge gets a row of intermediate verts tracing a 180° arc of radius `thickness/2`. This gives the "rounded blanket edge" look without affecting the cloth simulation at all — it's purely a post-process on the geometry.

**Solidification limits (shell-extrusion correctness):**

Shell extrusion is reliable when `thickness < ~3% of min(clothWidth, clothHeight)`. Beyond this ratio, inward normals on tightly-folded regions can cross each other, creating self-intersecting inner-shell geometry. For typical use cases (3cm blanket on a 2m bed = 1.5%) this is never a concern. If the user sets a very large thickness relative to cloth size, ClothSolidifier should warn and clamp.

For thick decorative cloth (quilted patterns, stuffed cushions with `thickness > 10%` of cloth dimension), the correct approach is marching cubes on a signed-distance field — this is a V3 path that handles any thickness without self-intersection artifacts.

**Corner radius interaction:**

If `cornerRadius > 0` in the grid config, the cloth boundary already has curved arcs at the corners. The solidifier sees these as normal boundary edges — no special handling needed. The round corners on the cloth naturally become round corners on the solid.

---

### 6. ShapeManager API

New public methods on `ShapeManager`:

```typescript
// Called by Frogmarks to build initial geometry from a grid config
buildClothGeometry(config: ClothGridConfig): ClothGeometryResult;

// Run simulation to steady state (async, resolves when converged or maxSteps hit)
simulateCloth(
  geometry: ClothGeometryResult,
  physics: ClothPhysicsConfig,
  mode: 'hang' | 'drape',
  drapeProxy?: DrapeProxy,
  maxSteps?: number,
): Promise<Float32Array>;  // resolved vertex positions

// Finalize: solidify if thickness > 0, bake into ClothMesh3D, add to scene
createClothMesh(
  config: ClothGridConfig,
  physics: ClothPhysicsConfig,
  simulatedPositions: Float32Array,
  name?: string,
): ClothMesh3D;

// Re-edit: extract config from existing ClothMesh3D back into builder
getClothConfig(meshId: string): { grid: ClothGridConfig; physics: ClothPhysicsConfig } | null;
```

---

## Frogmarks UI

### Entry Points

- **3D scene layer panel** → `[+ New]` → `Cloth / Banner`
- **Top menu** → `Insert → Cloth`
- **Keyboard shortcut** (TBD)

Both open the `ClothBuilderModal`.

---

### ClothBuilderModal Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  [←  Cancel]           Cloth Builder           [Create →]       │
├──────────────────────────────┬──────────────────────────────────┤
│                              │  GRID                            │
│                              │  Cols  [ 8 ]  Rows  [ 10 ]       │
│                              │  Cell  [0.10 m]                  │
│   CLOTH CANVAS               │  Corner radius  [ 0 cells ]      │
│   (WebGPU, orthographic)     │                                  │
│                              │  ─────────────────────────────   │
│   ┌── grid of quads ──┐      │  PHYSICS                         │
│   │  •─•─•─•─•─•─•─• │      │  Gravity   [ 9.8  ] m/s²         │
│   │  │╲│╲│╲│╲│╲│╲│╲│ │      │  Damping   [ 0.98 ]              │
│   │  •─•─•─•─•─•─•─• │      │  Stiffness [ 30   ] iterations   │
│   │  │╲│╲│╲│╲│╲│╲│╲│ │      │                                  │
│   │  •─•─•─•─•─•─•─• │      │  SOLIDIFY                        │
│   └────────────────────┘     │  Thickness  [ 0.00 ] m           │
│                              │  ☑ Round wall edges              │
│                              │                                  │
│ [Build] [Pin] [Erase]        │  ─────────────────────────────   │
│                              │  SIMULATE                        │
│ [Hang ▶] [Drape ▶] [Reset]  │  Drape proxy:                    │
│                              │  ○ None  ● Sphere  ○ Box         │
│                              │  Radius  [ 0.5 ] m               │
└──────────────────────────────┴──────────────────────────────────┘
```

---

### Builder Canvas Interactions

#### Build Mode (default)
- **Hover** over empty adjacent cell slot → highlight slot in light teal
- **Click** hovered slot → fill cell (adds to `activeCells`)
- A "slot" is only hovered if it's adjacent to an existing cell (no floating islands)
- Grid expands automatically if the user builds to the edge

#### Erase Mode
- **Hover** over existing cell → highlight in red
- **Click** → remove cell (only if removing it won't disconnect the mesh — warn if it would)

#### Pin Mode
- Vertex dots (red = pinned, white = free) appear on all vertices
- **Click** a dot → toggle pin state
- **Drag** across dots → batch toggle

#### Simulation Preview
- `[Hang ▶]` — pins the top row automatically (or uses user-defined pins), runs simulation, shows draped result in the canvas. Button changes to `[Hang ■]` while running.
- `[Drape ▶]` — clears all pins, drops cloth over the configured proxy shape. Gravity pulls cloth down until it settles.
- `[Reset]` — restores flat grid, clears simulation state
- During preview, the canvas shows the simulated cloth in 3D with a subtle orbit-drag gesture for inspection
- Build/Erase/Pin tools are disabled during preview (must Reset first)

#### Grid Props (right panel)
- `Cols / Rows` — changing these rebuilds the grid from scratch (confirmation dialog if pins or cells have been customized)
- `Cell size` — world-unit spacing; affects physics scale
- `Corner radius` — integer (0–4 cells). At `radius = 2`: the two corner cells in each corner are replaced with a 4-vertex arc. Preview updates live.

---

### Simulation Preview States

| State | Canvas shows | Right panel |
|---|---|---|
| Editing | Flat grid, top-view | All controls editable |
| Simulating | Animated cloth, 3D | Spinner on button, controls locked |
| Preview | Settled cloth, orbit-draggable | "Reset" to go back |
| Solidify preview | Thick mesh, orbit-draggable | Thickness slider live |

---

### Hang Preset Details

When user clicks `[Hang ▶]`:
1. If user has set custom pins → use those
2. If no pins set → automatically pin the entire top row
3. Drop cloth under gravity until converged
4. Show result

This covers the "triangle string banner" case: user builds a triangular pennant shape, no pins set, Hang auto-pins the top edge → pennant hangs naturally.

---

### Drape Preset Details

When user clicks `[Drape ▶]`:
1. All pins cleared for simulation (user-set pins from Build ignored)
2. Cloth starts in flat position above the proxy shape
3. Gravity + collision runs until settled
4. Show result

Proxy options:
- **None** — cloth falls to ground plane (good for a dropped tablecloth look)
- **Sphere** — radius configurable (good for draped fabric over a round object)
- **Box** — width/height/depth configurable (good for blanket over a bed, furniture)

For the **blanket on a bed** specifically:
- Set proxy to Box, size it to match the bed dimensions
- Set corner radius on the grid to 1–2 cells for soft corners
- Run Drape → cloth settles over the box edges
- Set Thickness to 0.03m (3cm), enable Round wall edges
- Click Create → you get a solid blanket mesh with rounded soft edges draped naturally over the bed shape

---

### Create Flow

1. User clicks `[Create]`
2. If not simulated: run default Hang sim silently (fast, capped at 2000 steps)
3. Solidify if `thickness > 0`
4. `shapeManager.createClothMesh(config, physics, positions)` → returns `ClothMesh3D`
5. Modal closes, new mesh is selected in the 3D scene layer
6. A "Re-edit" button appears in the 3D mesh inspector panel that reopens the builder with the saved `ClothGridConfig`

---

### Re-edit Flow

User selects a `ClothMesh3D` in the scene → inspector shows:

```
┌────────────────────────────┐
│  ClothMesh3D               │
│  Name: [Blanket]           │
│  Material: [...]           │
│  ─────────────────────────  │
│  Cloth: 8×10 grid, 2cm     │
│  Mode: Drape (Box proxy)   │
│  [✏ Re-edit cloth...]      │
└────────────────────────────┘
```

Clicking "Re-edit cloth" reopens the builder pre-loaded with the saved grid config and physics, with the previously simulated result shown. User can change pins, add cells, adjust thickness, re-simulate, then hit Create again to update the node in-place.

---

## Thickness / Solidification — Full Detail

To answer the core question: **yes, the cloth-to-solid pipeline makes a proper closed mesh** that can be placed in the scene as a 3D object — not just a 2D surface.

### What you get:

```
Cloth surface (post-sim)    →  Solidify   →  Closed mesh
    ↑ outer face                              ↑ outer face (same)
                                              ↓ inner face (offset by thickness, flipped)
                                              ← wall faces (perimeter edge loop)
```

### Blanket on a bed — step by step:

| Step | Action | Result |
|---|---|---|
| 1 | Grid: 12×8, cornerRadius=2 | Rectangular cloth with rounded corners |
| 2 | Drape, Box proxy = bed size | Cloth drapes over mattress edges naturally |
| 3 | Thickness = 0.03 m | 3cm solid blanket |
| 4 | Round wall edges ✓ | Wall profile is a half-cylinder (soft piping look) |
| 5 | Create | `ClothMesh3D` added to scene |

The rounded corners come from two sources working together:
- `cornerRadius` removes the sharp grid corner and adds arc verts → the outer shape is a proper rounded rectangle
- `solidifyRounded` gives the wall edge a half-cylinder profile instead of a flat slab → looks like a fabric hem

---

## Implementation Phases

### Phase 1 — Builder + Flat Export (no physics)

Deliverables:
- `ClothMesh3D` node type + serialization
- `ClothGeometryBuilder` (vertex/index/constraint generation)
- Builder viewport canvas (WebGPU orthographic, cloth grid rendered)
- Primitive picking for cell hover/click
- Build / Erase / Pin mode interactions
- Corner radius support
- `createClothMesh` API (exports flat cloth as `ClothMesh3D`, no simulation)
- Frogmarks builder modal, all UI controls (physics/sim controls visible but disabled)

**Usable for:** flat banners, tapestries, pennant shapes with no physics.

---

### Phase 2 — GPU Physics + Simulation Previews

Deliverables:
- `ClothSimulator`: Verlet integration + constraint solving compute shaders
- Graph coloring precompute (CPU, at build time)
- Collision: ground plane + sphere + box
- Hang / Drape preset configs
- Convergence detection
- Simulate-to-steady-state for Create button
- Frogmarks: Hang/Drape buttons, drape proxy config, simulation state in canvas

**Usable for:** hanging banners, draped fabric, all physics use cases.

---

### Phase 3 — Solidification + Re-edit

Deliverables:
- `ClothSolidifier`: outer/inner shells + wall generation + rounded wall profile
- Thickness slider live-updating geometry
- Re-edit flow (inspector button → builder pre-loaded)
- Material / texture mapping on solidified cloth

**Usable for:** blankets, thick fabric, cushions, any 3D solid cloth shape.

---

## Key Technical Decisions

| Decision | Choice | Reason |
|---|---|---|
| Physics integration | Verlet (not PBD) | Simpler to implement; cloth needs velocity history anyway |
| Constraint parallelism | Graph coloring | Eliminates GPU write races without atomic ops |
| Picking in builder | Primitive ID texture readback | O(1) regardless of mesh size; exact; matches WebGPU idioms |
| Picking in scene | Existing CPU `MeshPicker` | Already works correctly; cloth finalizes to static mesh |
| Solid mesh closed-ness | Boundary edge walk | Works for any arbitrary cell pattern |
| Corner rounding | Arc verts at build time | Participates in physics naturally; no post-process artifacts |
| Bend constraints | Phase 2, optional | Adds quality but not needed for banner/blanket use cases |
| Collision in sim | Analytic proxies only | Full mesh-mesh collision is out of scope; proxies cover all target use cases |
| Vertex mass | Triangle-area-weighted (Matt Fisher §4.1) | Uniform mass causes stiff-boundary oscillation; area weighting is physically correct |
| Shell solidification | Shell extrusion (O(n), thin cloth) | Valid for thickness < 3% of cloth dimension; marching-cubes SDF is V3 path for thick cloth |
| Smooth rendering | V2: Loop subdivision | Phase 1–2 use raw triangle mesh; Loop subdivision in V2 gives smooth shading without extra sim verts |
| Wind | Optional `ClothPhysicsConfig.wind` vector | Applied as constant acceleration each integrate step; no turbulence model for now |
