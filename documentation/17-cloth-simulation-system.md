# 17 — Cloth Simulation System

This document is a complete, ground-up explanation of how Salsa's cloth simulation works — the physics theory, every GPU compute shader pass, the graph coloring technique that makes parallel execution safe, and the zero-readback rendering pipeline. It is written to be understood by anyone who wants to eventually build this from scratch.

---

## Table of Contents

1. [What the System Does](#1-what-the-system-does)
2. [The Physics Algorithm: Position-Based Dynamics](#2-the-physics-algorithm-position-based-dynamics)
3. [Constraint Types and Why We Need Four of Them](#3-constraint-types-and-why-we-need-four-of-them)
4. [The Parallelism Problem and Graph Coloring](#4-the-parallelism-problem-and-graph-coloring)
5. [GPU Architecture: Four Compute Passes Per Step](#5-gpu-architecture-four-compute-passes-per-step)
6. [Pass 1 — Verlet Integration](#6-pass-1--verlet-integration)
7. [Pass 2 — Constraint Solve (Parallel, Graph-Colored)](#7-pass-2--constraint-solve-parallel-graph-colored)
8. [Pass 3 — Collision Response](#8-pass-3--collision-response)
9. [Pass 4 — GPU Pose Pass (The Zero-Readback Optimization)](#9-pass-4--gpu-pose-pass-the-zero-readback-optimization)
10. [GPU Buffer Architecture](#10-gpu-buffer-architecture)
11. [CPU-Side Pipeline: Geometry Builder](#11-cpu-side-pipeline-geometry-builder)
12. [Live Simulation: The rAF Loop and Rate-Limited Readback](#12-live-simulation-the-raf-loop-and-rate-limited-readback)
13. [Renderer Integration: Vertex Buffer Override](#13-renderer-integration-vertex-buffer-override)
14. [Performance Summary: What Changed and Why It Matters](#14-performance-summary-what-changed-and-why-it-matters)

---

## 1. What the System Does

Salsa can simulate cloth — a rectangular mesh of vertices connected by invisible springs — in real time directly on the GPU. The user sees a 3D fabric draping, hanging, or being pinned into a shape. Every frame, the GPU runs a physics simulation that moves all vertices to satisfy physical constraints: edges should maintain their rest length, the fabric should resist bending, and vertices should not pass through collision objects.

The implementation uses a technique called **Position-Based Dynamics (PBD)** running in **WebGPU compute shaders**. The key insight of this document is that naive PBD on a GPU has a data-race problem, and **graph coloring** is how we solve it.

**Files involved:**

| File | Role |
|------|------|
| [cloth-geometry-builder.ts](../src/renderer/3d/cloth-geometry-builder.ts) | CPU: builds mesh + constraint graph + neighbor buffer |
| [shaders/cloth-shaders.ts](../src/renderer/3d/shaders/cloth-shaders.ts) | WGSL source for all four compute passes |
| [cloth-simulator.ts](../src/renderer/3d/cloth-simulator.ts) | GPU: owns all buffers, encodes passes, manages lifetime |
| [live-cloth-simulation.ts](../src/renderer/3d/live-cloth-simulation.ts) | Drives the rAF loop, rate-limits readbacks, exposes pose buffer |
| [renderer-3d.ts](../src/renderer/3d/renderer-3d.ts) | Uses pose buffer as vertex buffer override in all draw passes |
| [managers/scene3d-manager.ts](../src/services/managers/scene3d-manager.ts) | Wires enable/disable lifecycle, simState persistence |

---

## 2. The Physics Algorithm: Position-Based Dynamics

### Why not forces?

The classical way to simulate cloth is **force-based**: compute spring forces at each vertex, integrate Newton's second law (`F = ma`) to get acceleration, add that to velocity, add velocity to position. This is called **Eulerian integration** and it has a fundamental problem: it is numerically unstable at large time steps. A spring that gets stretched produces a large restoring force, which causes a large acceleration, which overshoots, which causes an even larger force — the simulation explodes.

You can stabilize force-based systems by making the time step tiny (expensive) or by using implicit integrators (very expensive to solve, requires a sparse linear system solve per frame).

### PBD: skip forces, correct positions directly

**Position-Based Dynamics** (Müller et al., 2007) takes a completely different approach. Instead of computing forces and integrating them twice to get position changes, it works directly on positions:

1. Move every vertex forward using inertia (its previous velocity encoded as a position difference).
2. After that tentative move, look at every constraint — an edge that should be length `L` — and if the current distance is wrong, **directly push the two endpoints apart or together** until the constraint is satisfied.
3. Repeat step 2 many times until all constraints are approximately satisfied simultaneously.
4. The new position minus the old position becomes the implicit new velocity for the next frame.

This is called **projecting** constraints. The method is unconditionally stable — you are literally teleporting vertices to valid configurations, so you can never get the exponential blowup that kills force-based methods. The price is accuracy: PBD is not physically accurate in the same way force-based methods are, but it looks convincingly like cloth and is fast enough for real time.

### Verlet integration

The inertia step (step 1 above) uses **Verlet integration**, one of the oldest numerical integration schemes. Instead of storing velocity explicitly, Verlet stores only two positions: the current position `x` and the previous position `x_prev`. Velocity is implicit:

```
velocity ≈ (x - x_prev) / dt
```

To advance one time step, you apply:

```
x_new = x + (x - x_prev) * damping + acceleration * dt²
```

where `acceleration` includes gravity and wind. The damping factor (slightly less than 1.0) multiplies the velocity term, bleeding off energy to keep the simulation stable. After this update, `x_new` becomes the new current position and `x` (the old current) becomes the new previous position.

Verlet has excellent energy conservation properties and is extremely cheap — one addition and one subtraction per vertex, no division. It is the natural choice for cloth PBD.

---

## 3. Constraint Types and Why We Need Four of Them

The cloth mesh is a grid of vertices. Four types of spring constraints connect them, each resisting a different mode of deformation.

### Structural constraints

Connect each vertex to its immediate grid neighbors — left, right, up, down. These are the most important constraints. They prevent the cloth from stretching along its weave directions.

```
  v00 —— v10 —— v20
   |      |      |
  v01 —— v11 —— v21
   |      |      |
  v02 —— v12 —— v22
```
The horizontal and vertical edges in the diagram above are structural constraints.

### Shear constraints

Connect each vertex to its diagonal neighbors — upper-left, upper-right, lower-left, lower-right. Without shear constraints, the fabric can shear freely (imagine a square of fabric turning into a parallelogram with no resistance). Shear constraints make the cloth resist this deformation.

```
  v00 \/ v10
       \/
  v01 /\ v11
```
The diagonals are shear constraints.

### Bend constraints

Connect each vertex to the vertex two steps away in the grid — two columns right or two rows down. These are "skip-step" constraints. Their purpose is not to prevent stretching (the structural constraints already do that) but to prevent **sharp folding**. A cloth with only structural and shear constraints can fold 180 degrees at any edge with no resistance. Bend constraints add stiffness to resist this — the energy required to create a sharp crease comes from violating the bend constraint's rest length.

```
  v00 ——————— v20   (skip-step: 2 apart horizontally)
  
  v00
   |
   |           (skip-step: 2 apart vertically)
   |
  v02
```

Bend constraints are intentionally weaker than structural ones. In the code, each vertex has a `bendStiffness` scalar (0 = floppy, 1 = stiff) that scales how much a bend constraint correction is applied. This lets you paint crease lines onto the cloth.

### Stitch constraints

User-created constraints between arbitrary non-adjacent vertex pairs. When the user "stitches" two points on the cloth together (e.g., to create a pleat or fold), Salsa adds a stitch constraint with the desired rest length. Stitch constraints are solved at full stiffness, like structural ones.

---

## 4. The Parallelism Problem and Graph Coloring

This is the central technical idea of the performance optimization. Understanding it is essential.

### The naive parallel approach fails

Imagine you have 1000 constraints, and you want to solve all of them simultaneously on the GPU — one thread per constraint. Each thread reads positions of two vertices (`a` and `b`), computes a correction, and writes new positions back.

**The problem**: Two constraints might share a vertex. Constraint C1 connects vertices 5 and 10. Constraint C2 connects vertices 7 and 10. Both threads try to write a new position for vertex 10 at the same time. The GPU has no ordering guarantee between threads. One write will overwrite the other. The simulation becomes corrupted.

This is called a **write-race condition** or **data race**: multiple threads writing to the same memory location simultaneously with undefined order.

### The serial solution (what the old code did)

The simplest fix is to not parallelize at all — run a single thread that processes every constraint in order, one at a time. No races. But this throws away all the parallelism of the GPU. On a modern GPU with 4000+ shader cores, you are using exactly 1 of them. This is the bottleneck the old code had.

### Graph coloring — the correct solution

The insight: **two constraints that do not share any vertex can always be solved safely in parallel**, because they write to entirely separate memory locations. We need to partition the constraint set into groups where no two constraints in the same group share a vertex.

This is exactly the **graph coloring problem** from computer science:

- Think of each constraint as a **node** in a graph.
- Draw an **edge** between any two constraints that share a vertex.
- Assign **colors** to constraint nodes such that no two adjacent nodes (constraints sharing a vertex) get the same color.

Constraints with the same color are independent — they share no vertices — and can be dispatched to the GPU simultaneously.

### The coloring algorithm (greedy)

Salsa uses a **greedy graph coloring** algorithm (`colorConstraints` in [cloth-geometry-builder.ts](../src/renderer/3d/cloth-geometry-builder.ts)):

```typescript
function colorConstraints(edges: ConstraintEdge[], vertexCount: number): void {
  // For each vertex, track which colors are "in use" by constraints already colored
  // that touch that vertex.
  const usedColors: Set<number>[] = Array.from({ length: vertexCount }, () => new Set());

  for (const edge of edges) {
    const { a, b } = edge;
    // Find the lowest color number not already used by any neighbor of a or b
    let c = 0;
    while (usedColors[a].has(c) || usedColors[b].has(c)) c++;
    edge.color = c;
    // Mark that color as used by both vertices
    usedColors[a].add(c);
    usedColors[b].add(c);
  }
}
```

The algorithm assigns each constraint the lowest possible color not already taken by any constraint that shares a vertex with it. It processes constraints in order, one at a time, making a locally optimal choice each time.

**How many colors does it need?** For a regular grid, the maximum degree of any constraint node (number of neighboring constraints sharing a vertex) is bounded and small. In practice, a cloth grid needs approximately 2–5 colors per constraint type. The greedy algorithm is not guaranteed to use the minimum number of colors (that is NP-hard), but it is fast and produces a good result.

### Color groups in practice

After coloring, the constraints within each type (structural, shear, bend, stitch) are sorted by color number. All color-0 structural constraints come first, then color-1, etc. The builder computes **color ranges** — pairs of `(start, end)` indices into the global edges array:

```typescript
// Example for a small cloth:
// Structural color 0: edges[0..47]
// Structural color 1: edges[48..95]
// Structural color 2: edges[96..110]
// Shear color 0: edges[111..160]
// ...

structColorRanges = [
  { start: 0,   end: 48  },  // all structural constraints of color 0
  { start: 48,  end: 96  },  // all structural constraints of color 1
  { start: 96,  end: 111 },  // ...
]
```

The simulator then dispatches **one GPU compute pass per color group**. Inside each pass, one thread handles one constraint. Because all constraints in the same group share no vertices, all threads write to distinct memory — no races, no atomics needed.

This gives full GPU parallelism without any synchronization overhead. The number of sequential dispatches equals the number of color groups (typically 8–20 for a normal cloth), not the number of constraints (often thousands).

---

## 5. GPU Architecture: Four Compute Passes Per Step

Each simulation step runs four sequential compute shader dispatches. "Sequential" here means the GPU executes them in order — the output of pass 1 feeds into pass 2, etc. All four passes are encoded into a single `GPUCommandEncoder` and submitted in one `queue.submit()` call, which is the most efficient way to hand work to the GPU.

```
Per step:
  [Integrate] → [Constrain × colorGroups × iterations] → [Collide] → (after all steps) [Pose]

Multiple steps per rAF frame:
  step 1: [Integrate → Constrain × N → Collide]
  step 2: [Integrate → Constrain × N → Collide]
  ...
  step K: [Integrate → Constrain × N → Collide]
  [Pose]   ← one pose pass after all steps
```

The pose pass runs once per rAF frame (not once per physics step) because it writes the vertex buffer used by the renderer. It only needs to run after the last physics step.

---

## 6. Pass 1 — Verlet Integration

**Shader**: `CLOTH_INTEGRATE_SHADER` in [cloth-shaders.ts](../src/renderer/3d/shaders/cloth-shaders.ts)

**Purpose**: Advance every vertex one time step forward using inertia and forces.

**Dispatch**: `ceil(vertexCount / 64)` workgroups, 64 threads each. One thread per vertex.

### Bindings

| Binding | Type | Contents |
|---------|------|----------|
| 0 | `storage read_write` | `positions` — current positions, written as output |
| 1 | `storage read_write` | `prevPositions` — previous positions, updated as side effect |
| 2 | `storage read` | `inverseMass` — 0 = pinned, > 0 = free |
| 3 | `uniform` | `IntegrateParams` struct |
| 4 | `storage read` | `perVertexWind` — extra per-vertex wind acceleration |

### What it does

```wgsl
let pos  = positions[vi].xyz;
let prev = prevPositions[vi].xyz;

// Velocity from position history (Verlet)
let vel = (pos - prev) * params.damping;

// Acceleration: global wind + per-vertex wind zone + gravity (downward)
let accel = vec3(
    params.windX + zoneWind.x,
    params.windY + zoneWind.y - params.gravity,
    params.windZ + zoneWind.z,
);

prevPositions[vi] = vec4(pos, 0);                           // save current as previous
positions[vi]     = vec4(pos + vel + accel * dt * dt, 0);  // new position
```

If `inverseMass[vi]` is 0 (pinned vertex), the thread exits immediately — pinned vertices never move.

The `damping` parameter (typically 0.98–0.99) slightly reduces velocity each frame. Without damping, the cloth would oscillate forever; with damping, it gradually settles.

The `perVertexWind` buffer allows wind zones to apply spatially varying forces. For example, a turbulence zone can apply stronger wind to vertices inside a sphere region. These forces are computed on the CPU once per rAF tick and uploaded to the GPU buffer.

---

## 7. Pass 2 — Constraint Solve (Parallel, Graph-Colored)

**Shader**: `CLOTH_CONSTRAIN_SHADER` in [cloth-shaders.ts](../src/renderer/3d/shaders/cloth-shaders.ts)

**Purpose**: Enforce all constraints — push vertex pairs toward their rest lengths.

**Dispatch**: One dispatch per color group per iteration. `ceil(groupSize / 64)` workgroups, 64 threads each.

### Bindings

| Binding | Type | Contents |
|---------|------|----------|
| 0 | `storage read_write` | `positions` — vertex positions, corrected in place |
| 1 | `storage read` | `inverseMass` — used to split corrections by mass |
| 2 | `storage read` | `constraints` — all constraint edges (a, b, restLength) |
| 3 | `uniform` (dynamic offset) | `ConstrainParams` — which slice of constraints to solve |
| 4 | `storage read` | `bendStiffness` — per-vertex stiffness for bend constraints |

### The constraint projection formula

Given two vertices at positions `pa` and `pb` with a rest length `L`, the current distance is:

```
dist = length(pb - pa)
```

The **correction vector** pushes them toward the correct distance. Each vertex moves half the error in the direction along the edge:

```
correction = (pb - pa) * ((dist - L) / dist) * 0.5
```

The `0.5` comes from splitting the correction equally. But vertices have different masses, and heavier vertices should move less. The correction is split by **inverse-mass weight**:

```
wa = inverseMass[a]
wb = inverseMass[b]
wsum = wa + wb

pa_new = pa + correction * (wa / wsum)
pb_new = pb - correction * (wb / wsum)
```

If both vertices have equal mass, each moves half the correction. If vertex `a` is pinned (inverseMass = 0), then `wa / wsum = 0` and `a` doesn't move at all — the full correction goes to `b`.

### Dynamic-offset uniform buffer

Each color group needs to know which slice of the constraints array to solve — the `groupStart` and `groupEnd` indices. Rather than creating a separate uniform buffer for every color group, Salsa packs all groups into **one large uniform buffer** with one slot per group, each slot padded to 256 bytes (`CON_PARAM_STRIDE`).

The 256-byte stride is a WebGPU hardware requirement: `minUniformBufferOffsetAlignment` is guaranteed to be at most 256 bytes on all WebGPU implementations. All GPU hardware can only switch between uniform buffer regions at 256-byte boundaries.

To tell the GPU which slot to use, Salsa passes a **dynamic offset** when binding the group:

```typescript
// In _encodePasses(), for color group gi:
pass.setBindGroup(0, this.constrainBG, [gi * CON_PARAM_STRIDE]);
```

This makes binding 3 (ConstrainParams) point to byte offset `gi * 256` inside `conColorParamsBuf`. The bind group itself (`constrainBG`) is created once; only the offset changes per dispatch. This is efficient — no buffer recreation, no extra upload.

The shader reads:
```wgsl
let ci = params.groupStart + id.x;  // global constraint index for this thread
if (ci >= params.groupEnd) { return; }  // out-of-bounds guard
let c = constraints[ci];
```

### The stiffness iteration loop

PBD converges better with multiple constraint solve passes per physics step. The `stiffness` parameter (typically 20–40) controls how many times we loop through all color groups per step. More iterations = stiffer cloth that resists stretching more, but each step takes longer. In the GPU encoder:

```typescript
for (let iter = 0; iter < stiffness; iter++) {
  for (let gi = 0; gi < this._colorRanges.length; gi++) {
    const pass = enc.beginComputePass();
    pass.setPipeline(this.constrainPipeline!);
    pass.setBindGroup(0, this.constrainBG!, [gi * CON_PARAM_STRIDE]);
    pass.dispatchWorkgroups(Math.ceil(groupSize / WG));
    pass.end();
  }
}
```

For a cloth with 20 color groups and stiffness=30, this encodes 600 compute passes per step. All are recorded into the command encoder in a tight CPU-side loop and submitted in a single queue.submit() — the GPU sees them as a continuous stream of work.

### Bend stiffness

For constraints in the bend range, the correction is scaled by the average of the two vertices' `bendStiffness` values:

```wgsl
if (ci >= params.bendStart && ci < params.stitchStart) {
    let stiff = (bendStiffness[c.a] + bendStiffness[c.b]) * 0.5;
    correction = correction * stiff;
}
```

A user can "paint" low stiffness onto a strip of vertices to create a soft crease line, or high stiffness to make a region of cloth boardlike. Structural and stitch constraints are always solved at full strength regardless of this map.

---

## 8. Pass 3 — Collision Response

**Shader**: `CLOTH_COLLIDE_SHADER` in [cloth-shaders.ts](../src/renderer/3d/shaders/cloth-shaders.ts)

**Purpose**: Push vertices out of collision objects (ground, sphere, box).

**Dispatch**: `ceil(vertexCount / 64)` workgroups. One thread per vertex.

### Bindings

| Binding | Type | Contents |
|---------|------|----------|
| 0 | `storage read_write` | `positions` — corrected to be outside the collider |
| 1 | `storage read_write` | `prevPositions` — reset when collision occurs |
| 2 | `storage read` | `inverseMass` — pinned vertices skip collision |
| 3 | `uniform` | `CollisionParams` — collider type + dimensions |

### Collision types

**Ground plane (`collisionType == 1`)**: If a vertex's Y position drops below `groundY`, clamp it:
```wgsl
if (pos.y < params.groundY) { pos.y = params.groundY; moved = true; }
```

**Sphere (`collisionType == 2`)**: If the vertex is closer to the sphere center than the radius, push it onto the sphere surface along the radial direction:
```wgsl
let d = pos - center;
if (length(d) < radius) {
    pos = center + normalize(d) * radius;
    moved = true;
}
```

**Box (`collisionType == 3`)**: If the vertex is inside the box AABB, find which face it is closest to and push it outside that face:
```wgsl
if (inside box) {
    // find minimum distance to any face
    // push out through that face
}
```

### Velocity kill on collision

When a vertex is pushed by a collision (the `moved` flag is set), its previous position is also reset to the new position:

```wgsl
if (moved) { prevPositions[vi] = vec4(pos, 0); }
```

This is critical. Remember that velocity in Verlet is `(pos - prevPos)`. If we move `pos` but leave `prevPos` unchanged, the vertex has an implicit velocity pointing back toward the inside of the collider. Next frame, that velocity would push it right back through the surface. By also setting `prevPos = pos`, we zero out the velocity component perpendicular to the collision surface. The vertex is at rest on the surface rather than trying to tunnel through it.

---

## 9. Pass 4 — GPU Pose Pass (The Zero-Readback Optimization)

**Shader**: `CLOTH_POSE_SHADER` in [cloth-shaders.ts](../src/renderer/3d/shaders/cloth-shaders.ts)

**Purpose**: Write final simulated positions **and recomputed normals** directly into the interleaved vertex buffer that the renderer reads from — bypassing the CPU entirely.

This is the most important optimization. Understanding why requires understanding the old pipeline.

### The old pipeline (before this optimization)

Before this change, every frame looked like:

```
GPU physics step(s) → GPU-side positions buffer
    ↓
CPU: queue.submit([encoder with copyBufferToBuffer])
    ↓
CPU: await readbackBuf.mapAsync(GPUMapMode.READ)   ← STALLS CPU until GPU finishes
    ↓
CPU: decompress vec4 → vec3, rebuild full vertex buffer with new normals
    ↓
CPU: device.queue.writeBuffer(vertexBuf, ...)       ← upload back to GPU
    ↓
GPU renders from vertexBuf
```

This is a **GPU → CPU → GPU roundtrip** that happens every single frame. The `mapAsync` call is the killer — it forces the CPU to wait for the GPU to finish the simulation, then the GPU has to wait while the CPU processes data and uploads it back. Two pipeline stalls per frame. At 60fps this adds up to a hard performance ceiling.

### The new pipeline

The pose pass runs entirely on the GPU. The position buffer (output of the physics passes) is read directly, and a separate WGSL shader writes positions and normals into the vertex buffer:

```
GPU physics step(s) → positions buffer (STORAGE)
    ↓ (still on GPU, same command encoder)
GPU pose pass → poseVertexBuf (STORAGE | VERTEX)
    ↓
GPU renders directly from poseVertexBuf (used as vertex buffer override)
```

Zero CPU involvement. Zero stalls. The GPU does physics and rendering as one continuous pipeline.

### The `poseVertexBuf` dual-usage flag

The key WebGPU trick: `poseVertexBuf` is created with **both** `GPUBufferUsage.STORAGE` and `GPUBufferUsage.VERTEX`:

```typescript
this.poseVertexBuf = device.createBuffer({
  size: vertexData.byteLength,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
});
```

`STORAGE` lets compute shaders write to it. `VERTEX` lets render passes read from it as a vertex buffer. WebGPU explicitly permits this dual usage — the same buffer can be bound as a compute storage buffer in one pass and as a vertex buffer in the next render pass, all within the same frame.

### Normal recomputation on the GPU

The vertex buffer stores interleaved data: `[pos.x, pos.y, pos.z, normal.x, normal.y, normal.z, uv.u, uv.v, tan.x, tan.y, tan.z, tan.w]` — 12 floats per vertex. After physics moves the positions, the normals are wrong (the cloth has a new shape). The pose shader recomputes them using **finite differences** across the cloth grid.

The idea: the surface normal at a vertex is perpendicular to the surface. We can approximate the tangent plane at any point by looking at the positions of neighboring vertices:

```
normal = normalize( cross(right - left, up - down) )
```

Where `right`, `left`, `up`, `down` are the positions of the vertex's four grid neighbors. The cross product of any two vectors in the tangent plane gives the normal.

```wgsl
let leftPos  = select(pos, positions[leftIdx].xyz,  n.x >= 0);
let rightPos = select(pos, positions[rightIdx].xyz, n.y >= 0);
let upPos    = select(pos, positions[upIdx].xyz,    n.z >= 0);
let downPos  = select(pos, positions[downIdx].xyz,  n.w >= 0);

var dH = rightPos - leftPos;   // horizontal tangent
var dV = upPos    - downPos;   // vertical tangent
var normal = normalize(cross(dH, dV));
```

The `select(fallback, value, condition)` is the WGSL branchless conditional: if the neighbor index is `-1` (boundary or cutout), the vertex's own position is used as the fallback, making the difference vector zero — which means that edge of the cross product has no contribution, naturally producing the boundary normal.

After computing the normal, the shader ensures it faces the correct hemisphere (the cloth's "up" side — positive Y in the rest pose) by flipping it if needed:

```wgsl
if (dot(normal, vec3f(0, 1, 0)) < 0) { normal = -normal; }
```

### The neighbor buffer

To look up grid neighbors, every vertex needs to know the GPU buffer index of the vertex to its left, right, above, and below. This is precomputed on the CPU during geometry building and uploaded once as a `STORAGE` buffer:

```typescript
// In cloth-geometry-builder.ts
const neighborBuf = new Int32Array(vertexCount * 4).fill(-1);
for (let vi = 0; vi < vertexCount; vi++) {
  const s  = slotFromVertexArr[vi];   // this vertex's position in the fine grid
  const fc = s % fSC;                 // column in fine grid
  const fr = Math.floor(s / fSC);     // row in fine grid
  neighborBuf[vi * 4    ] = fineSlotToVertex.get(fineSlotIdx(fc - 1, fr)) ?? -1; // left
  neighborBuf[vi * 4 + 1] = fineSlotToVertex.get(fineSlotIdx(fc + 1, fr)) ?? -1; // right
  neighborBuf[vi * 4 + 2] = fineSlotToVertex.get(fineSlotIdx(fc, fr - 1)) ?? -1; // up
  neighborBuf[vi * 4 + 3] = fineSlotToVertex.get(fineSlotIdx(fc, fr + 1)) ?? -1; // down
}
```

A value of `-1` means no neighbor in that direction (edge of the cloth, or a hole punched by a corner radius or custom shape). The WGSL shader reads these as `vec4<i32>` and checks `n.x >= 0` before using each neighbor.

### What the pose shader writes

The shader writes only floats 0–5 of each vertex's 12-float record (position and normal). Floats 6–11 (UV coordinates and tangent vector) are static — the cloth's UV mapping and tangent frame do not change during simulation. The shader intentionally leaves those slots untouched.

---

## 10. GPU Buffer Architecture

Here is every GPU buffer the cloth simulator owns, what it contains, and how it is used.

| Buffer | GPU usage flags | Contents | Updated by |
|--------|----------------|----------|------------|
| `positionBuf` | `STORAGE \| COPY_SRC \| COPY_DST` | `vec4f` per vertex (xyz = position) | Integrate shader (write), Constrain shader (read/write), Collide shader (read/write), Pose shader (read) |
| `prevPosBuf` | `STORAGE \| COPY_DST` | `vec4f` per vertex (previous frame position) | Integrate shader (read, then writes current→prev), Collide shader (write when collision resets vel) |
| `invMassBuf` | `STORAGE \| COPY_DST` | `f32` per vertex (0 = pinned) | CPU: `setInverseMass()`, `pinVertices()` |
| `constraintBuf` | `STORAGE` | `{a: u32, b: u32, restLength: f32, _pad: u32}` per constraint | Written once at init, read-only for simulation |
| `bendStiffnessBuf` | `STORAGE \| COPY_DST` | `f32` per vertex | CPU: `setBendStiffness()` |
| `perVertexWindBuf` | `STORAGE \| COPY_DST` | `vec4f` per vertex (xyz = extra wind acceleration) | CPU: wind zone system, updated each tick |
| `neighborBuf` | `STORAGE` | `vec4i` per vertex (left, right, up, down indices; -1 = none) | Written once at init, read-only |
| `intParamsBuf` | `UNIFORM \| COPY_DST` | `IntegrateParams` struct: dt, gravity, damping, windXYZ, vertCount | CPU: each `_encodePasses()` call |
| `conColorParamsBuf` | `UNIFORM \| COPY_DST` | N × 256 bytes, one slot per color group: `{groupStart, groupEnd, bendStart, stitchStart}` | Written once at init |
| `colParamsBuf` | `UNIFORM \| COPY_DST` | `CollisionParams` struct: type, groundY, sphere/box dimensions | CPU: `setCollision()` |
| `poseParamsBuf` | `UNIFORM \| COPY_DST` | `{vertCount: u32}` | Written once at init |
| `poseVertexBuf` | `STORAGE \| VERTEX \| COPY_DST` | 12 floats per vertex (interleaved: pos + normal + uv + tangent) | Pose shader writes pos+normal; initialized from flat geometry |
| `readbackBuf` | `COPY_DST \| MAP_READ` | `vec4f` per vertex (copy of positionBuf) | CPU: rate-limited readback for simState persistence |

### The dynamic offset uniform buffer in detail

`conColorParamsBuf` deserves special attention. It looks like this in memory:

```
Byte 0:   [groupStart_0][groupEnd_0][bendStart][stitchStart]  ← color group 0
           14 bytes of data
           ...242 bytes of padding...
Byte 256: [groupStart_1][groupEnd_1][bendStart][stitchStart]  ← color group 1
           ...
Byte 512: [groupStart_2][groupEnd_2][bendStart][stitchStart]  ← color group 2
```

Each slot is 256 bytes regardless of how much data it holds. When the simulator dispatches color group `gi`, it passes `gi * 256` as the dynamic offset: `pass.setBindGroup(0, constrainBG, [gi * 256])`. The GPU hardware shifts the uniform buffer window to start at that byte offset. The shader sees `params.groupStart` and `params.groupEnd` as if they were the only values in the buffer.

This is more efficient than creating a separate `GPUBuffer` per color group (which would require many small allocations) and more efficient than rewriting the buffer contents before each dispatch (which would require CPU–GPU synchronization).

---

## 11. CPU-Side Pipeline: Geometry Builder

Before any GPU work can happen, the CPU must build the mesh and all the data structures the GPU needs. This happens in [cloth-geometry-builder.ts](../src/renderer/3d/cloth-geometry-builder.ts) and runs synchronously on the main thread.

### The fine grid

The user configures a cloth with `cols × rows` coarse cells. Optionally, a `subdivisions` parameter subdivides each coarse cell into `N × N` fine cells. The simulation runs on the fine mesh (which gives smooth, detailed results), but the user-facing API (pinned vertices, stitch points, bend stiffness map) stays at coarse resolution. The geometry builder handles the translation.

A 4×4 coarse cloth with subdivisions=2 has 8×8 fine cells, 9×9=81 fine vertex slots.

### Active cells and corner radius

Not all cells in the grid need to be active. The user can specify `activeCells: boolean[]` to punch holes in the cloth. The `cornerRadius` parameter automatically deactivates cells near the corners to make the cloth have rounded corners instead of sharp rectangular ones.

### Inverse mass

Each vertex's mass is proportional to the area of cloth it "owns" — the sum of one-third of the area of each triangle it belongs to. More cloth area = more mass = harder to move. Physically this makes sense: a vertex in the middle of a large cloth patch is attached to more fabric and resists acceleration more.

The simulator actually stores **inverse mass** (1/mass) because Newton's law is `a = F/m = F * (1/m)`. Using inverse mass means pinned vertices can be represented as inverseMass=0 (infinite mass) without division-by-zero issues.

### Constraint graph construction

After all fine vertices are identified, the builder constructs edges:

1. **Structural**: All 4 edges of each fine active cell (left-right, top-bottom). Deduplication ensures no edge appears twice.
2. **Shear**: Both diagonals of each active cell.
3. **Bend**: All two-step-apart pairs in the fine grid (horizontal and vertical).
4. **Stitch**: Provided by the user configuration.

Then `colorConstraints()` assigns colors to each type separately, the edges are sorted by color, and `buildColorRanges()` extracts the contiguous runs.

### Neighbor buffer construction

For the pose shader's normal computation, we need to know — for each vertex — the GPU buffer indices of its four grid neighbors. The builder:

1. Builds a reverse map: `fineSlotIndex → denseVertexIndex`.
2. For each vertex, looks up its fine grid column and row, then looks up the dense index of the vertex one step in each direction.
3. Stores -1 if the neighbor doesn't exist (boundary or cutout hole).

---

## 12. Live Simulation: The rAF Loop and Rate-Limited Readback

[live-cloth-simulation.ts](../src/renderer/3d/live-cloth-simulation.ts) manages the running simulation during interactive use (when the user has enabled live physics in the scene).

### The rAF loop

A `requestAnimationFrame` loop fires roughly 60 times per second. Each tick:

1. Call `this._sim.step(0.016, stepsPerFrame)` — this encodes and submits all physics steps + one pose pass in a single `queue.submit()`.
2. Optionally do a rate-limited CPU readback.
3. Schedule the next frame.

`stepsPerFrame` defaults to 3, meaning the simulation advances 3 × 16ms = 48ms of physics time per screen frame. Higher values make the cloth behave more correctly (especially useful for stiffer cloths that would otherwise drift) but take more GPU time.

### Rate-limited readback

The GPU readback (copying positions from GPU to CPU for `simState` persistence) runs only every 8 frames (`READBACK_INTERVAL = 8`):

```typescript
if (!this._pendingReadback && this._frameCount % READBACK_INTERVAL === 0) {
    const gen = this._simGeneration;
    this._pendingReadback = this._sim.readPositions().then(positions => {
        this._pendingReadback = null;
        if (this._simGeneration !== gen) return;  // discard if sim was reset
        // fire onPositionsUpdate callback
    });
}
```

This means `simState.positions` (the CPU-side array used for saving/loading) is updated at ~7.5fps. That is perfectly adequate for persistence — users don't need millisecond-perfect position snapshots. The rendered cloth still updates at 60fps via the pose buffer.

The `_pendingReadback` guard prevents issuing a new readback if one is already in flight. Since `readPositions()` uses `mapAsync`, which must wait for the GPU to finish, overlapping readbacks would cause errors.

### Convergence detection

When the cloth is hanging with no external forces and all constraints are satisfied, it reaches a stable rest pose. The simulation can detect this: if the maximum vertex displacement between two successive readbacks is below `epsilon`, the cloth has converged. At that point, the live sim can pause to save GPU cycles.

### Lifecycle: reset and destroy

When the user changes cloth parameters significantly (grid size, subdivisions), the entire simulation is torn down and rebuilt:

```
reset():
  onPoseBufferChange(null)          ← tell renderer to stop using old pose buffer
  destroy old ClothSimulator        ← GPU buffers freed
  _initSim(new params)              ← new ClothSimulator built
  onPoseBufferChange(newPoseBuffer) ← renderer switches to new pose buffer
```

The callback fires `null` before destroy to prevent the renderer from using a freed buffer, then fires the new buffer after init.

---

## 13. Renderer Integration: Vertex Buffer Override

The renderer ([renderer-3d.ts](../src/renderer/3d/renderer-3d.ts)) normally draws each mesh using `buf.vertex` — the static vertex buffer computed at mesh creation time. For a live cloth mesh, that buffer has stale positions (the rest pose). The simulation's `poseVertexBuf` has the live positions.

### The override map

```typescript
private _vertexBufferOverrides = new Map<string, GPUBuffer>();

setVertexBufferOverride(meshId: string, buf: GPUBuffer | null): void {
    if (buf) {
        this._vertexBufferOverrides.set(meshId, buf);
    } else {
        this._vertexBufferOverrides.delete(meshId);
    }
}
```

### Applied in all draw paths

Every place in the renderer that calls `pass.setVertexBuffer(0, ...)` now checks the map:

```typescript
pass.setVertexBuffer(0, this._vertexBufferOverrides.get(mesh.id) ?? buf.vertex);
```

This applies to:
- **Opaque draw pass** — main forward rendering
- **Transparent draw pass** — alpha-blended meshes
- **Shadow pre-pass** — depth-only render into shadow map
- **Outline depth pre-pass** — depth+normal render for edge detection
- **Highlight pass** — selection/hover outlines

All five paths are updated so the cloth looks correct in shadows, outlines, and selection highlights — not just in the main view.

### Wiring in scene3d-manager

When `enableLiveCloth()` is called:

```typescript
// Set initial override
if (handle.poseBuffer) {
    this.renderer3D.setVertexBufferOverride(meshId, handle.poseBuffer);
}
// Wire lifecycle: renderer3D tracks buffer changes automatically
handle.onPoseBufferChange = (buf) => {
    this.renderer3D.setVertexBufferOverride(meshId, buf);
};
// Rate-limited readback: only update simState, skip the expensive setGeometry
handle.onPositionsUpdate = (positions) => {
    if (handle.poseBuffer) {
        // Pose buffer is live — renderer already has correct vertices.
        // Just persist simState for save/load.
        node.simState.positions      = Array.from(positions);
        node.simState.isSimulated    = true;
        node.simState.simulationMode = mode;
    } else {
        // Fallback: no pose buffer, use CPU upload path
        this.updateClothMeshPose(meshId, positions, mode);
    }
};
```

When `disableLiveCloth()` is called:

```typescript
this.renderer3D.setVertexBufferOverride(meshId, null);  // remove override first
handle.destroy();                                         // then free GPU buffers
```

The order matters: clear the override before destroying the buffer. If you destroy the buffer first, the renderer would try to use a freed `GPUBuffer` for one frame.

---

## 14. Performance Summary: What Changed and Why It Matters

### Before (serial constrain + CPU roundtrip)

| Operation | Where | Cost |
|-----------|-------|------|
| Constraint solve | GPU: 1 thread, all constraints sequentially | O(constraints) GPU cycles, all serial |
| Position readback | GPU→CPU: `mapAsync` stall | Full GPU pipeline drain per frame |
| Normal computation | CPU: rebuild vertex buffer | O(vertices) CPU cycles per frame |
| Vertex upload | CPU→GPU: `writeBuffer` | Full vertex buffer PCIe transfer per frame |

At 60fps with a 32×40 cloth (≈1,600 vertices, ≈4,000 constraints, 30 stiffness iterations):
- Serial constraint solve: 4,000 × 30 = 120,000 constraint evaluations in one GPU thread.
- Readback stall: every frame, the CPU blocks waiting for the GPU.
- Upload: 1,600 vertices × 48 bytes = 76,800 bytes uploaded to GPU every frame.

### After (parallel constrain + GPU pose pass)

| Operation | Where | Cost |
|-----------|-------|------|
| Constraint solve | GPU: parallel across color groups, ~10–20 passes | O(constraints/parallelism) per pass |
| Position readback | CPU: every 8 frames only | Amortized to ~7.5fps |
| Normal computation | GPU: pose shader | O(vertices) GPU cycles, all parallel |
| Vertex upload | None | Zero — pose shader writes directly |

The GPU dispatches all constraints in the same color group in parallel. With 1,600 structural constraints distributed across ~4 color groups of ~400 constraints each, the GPU processes all 400 constraints in one pass (in ~7 workgroups of 64 threads each, running in parallel on GPU cores). The 4 sequential color groups plus the stiffness loop still dominate, but each pass is massively parallel.

The render loop sees:
- **Zero CPU stalls** — the pose buffer is written by the GPU before the render pass starts, within the same command encoder.
- **Zero CPU→GPU upload** — the vertex data never touches the CPU.
- **Correct normals** — recomputed on the GPU after every physics step.

The result is that the simulation bottleneck shifts from "CPU stalled on GPU readback" to "raw GPU compute throughput" — which is exactly what GPUs are built for.

---

## Building This From Scratch: The Key Steps

If you were to implement this system from zero, the critical decisions in order are:

1. **Choose PBD** — it's unconditionally stable and fast to implement. You can prototype it in JavaScript first.
2. **Start with serial Verlet + serial constraint projection** — get the physics working correctly before worrying about GPU.
3. **Move to GPU compute** — port the integrate and constrain passes to WGSL. Test with `@workgroup_size(1)` (serial) first.
4. **Add graph coloring** — implement the greedy coloring algorithm on the CPU, sort edges by color, build color ranges, switch to parallel dispatch with dynamic-offset uniforms.
5. **Add the pose pass** — create the `STORAGE | VERTEX` buffer, write the pose shader, eliminate the readback from the hot path.
6. **Rate-limit readbacks** — keep one readback path for simState persistence but don't let it block rendering.
7. **Wire the renderer** — add the vertex buffer override map, apply it in all draw paths.

The graph coloring step is the hardest conceptual leap. Once you understand that "same color = no shared vertices = safe to parallelize," the rest is straightforward WebGPU API work.
