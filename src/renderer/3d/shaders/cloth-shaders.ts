/**
 * WGSL compute shaders for cloth simulation.
 *
 * Four passes per simulation step:
 *
 *  1. INTEGRATE  — Verlet integration: v = (pos - prev) * damping, pos += v + (gravity + wind)*dt²
 *                  Binding 4: perVertexWind — per-vertex additional acceleration (from wind zones)
 *  2. CONSTRAIN  — Parallel constraint solve: one thread per constraint in a graph-color group.
 *                  Dispatched once per color group per iteration (no two same-color edges share a vertex).
 *                  Binding 3: uniform with dynamic offset — groupStart/groupEnd selects the color slice.
 *                  Binding 4: bendStiffness — per-vertex scalar [0–1]; scales bend constraint corrections.
 *                  Stitch constraints (ci >= stitchStart) are solved at full stiffness (like structural).
 *  3. COLLIDE    — Analytic collision: ground plane | sphere | box
 *  4. POSE       — Writes simulated positions + recomputed normals directly into the VERTEX | STORAGE
 *                  vertex buffer, eliminating the GPU→CPU→GPU readback roundtrip for live rendering.
 *                  Normals are computed from grid neighbors (left/right/up/down finite differences).
 *
 * Buffer layout:
 *   binding 0 — positions:      array<vec4f>   (xyz = pos, w unused)
 *   binding 1 — prevPositions:  array<vec4f>
 *   binding 2 — inverseMass:    array<f32>     (0 = pinned/infinite mass)
 *   binding 3 — params (uniform, type varies per shader)
 *   binding 4 — per-shader extra buffer (integrate: perVertexWind; constrain: bendStiffness)
 */

// ── 1. Verlet integration ────────────────────────────────────────────────────

export const CLOTH_INTEGRATE_SHADER = /* wgsl */`

struct IntegrateParams {
  dt         : f32,  // time-step (seconds)
  gravity    : f32,  // downward acceleration magnitude (m/s²)
  damping    : f32,  // velocity retention factor per step (0–1)
  windX      : f32,  // global wind acceleration X (world units / s²)
  windY      : f32,  // global wind acceleration Y
  windZ      : f32,  // global wind acceleration Z
  vertCount  : u32,  // number of vertices
  _pad       : f32,
};

@group(0) @binding(0) var<storage, read_write> positions     : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> prevPositions : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read>       inverseMass   : array<f32>;
@group(0) @binding(3) var<uniform>             params        : IntegrateParams;
@group(0) @binding(4) var<storage, read>       perVertexWind : array<vec4<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let vi = id.x;
  if (vi >= params.vertCount) { return; }
  if (inverseMass[vi] < 0.0001f) { return; }   // pinned — no movement

  let pos  = positions[vi].xyz;
  let prev = prevPositions[vi].xyz;

  // Verlet: velocity from position history, damped
  let vel = (pos - prev) * params.damping;

  // Global wind + per-vertex wind zone contribution
  let zoneWind = perVertexWind[vi].xyz;
  let accel = vec3<f32>(
    params.windX + zoneWind.x,
    params.windY + zoneWind.y - params.gravity,
    params.windZ + zoneWind.z,
  );

  prevPositions[vi] = vec4<f32>(pos, 0.0);
  positions[vi]     = vec4<f32>(pos + vel + accel * (params.dt * params.dt), 0.0);
}
`;

// ── 2. Constraint solve (parallel, graph-colored) ────────────────────────────
// One thread per constraint within a single color group.
// Dispatched as (ceil(groupSize/64), 1, 1) once per color group per iteration.
// Constraints in the same color group share no vertices, so all threads write
// to distinct memory locations — no atomics or barriers needed.
// The simulator loops over iterations × color groups in JS, encoding one
// compute pass per (iteration, color group) pair.

export const CLOTH_CONSTRAIN_SHADER = /* wgsl */`

struct ConstrainParams {
  groupStart  : u32,   // first constraint index in this color group
  groupEnd    : u32,   // one past the last constraint index
  bendStart   : u32,   // global index where bend constraints begin
  stitchStart : u32,   // global index where stitch constraints begin
};

struct Constraint {
  a          : u32,
  b          : u32,
  restLength : f32,
  _pad       : u32,
};

@group(0) @binding(0) var<storage, read_write> positions     : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read>       inverseMass   : array<f32>;
@group(0) @binding(2) var<storage, read>       constraints   : array<Constraint>;
@group(0) @binding(3) var<uniform>             params        : ConstrainParams;
@group(0) @binding(4) var<storage, read>       bendStiffness : array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let ci = params.groupStart + id.x;
  if (ci >= params.groupEnd) { return; }

  let c  = constraints[ci];
  let pa = positions[c.a].xyz;
  let pb = positions[c.b].xyz;
  let diff = pb - pa;
  let dist = length(diff);
  if (dist < 0.0001f) { return; }

  // Position correction split by inverse-mass weight
  var correction = diff * ((dist - c.restLength) / dist * 0.5f);

  // Bend constraints only: scale by per-vertex stiffness map.
  // Structural, shear, and stitch always solve at full strength.
  if (ci >= params.bendStart && ci < params.stitchStart) {
    let stiff = (bendStiffness[c.a] + bendStiffness[c.b]) * 0.5f;
    correction = correction * stiff;
  }

  let wa   = inverseMass[c.a];
  let wb   = inverseMass[c.b];
  let wsum = wa + wb;
  if (wsum < 0.0001f) { return; }

  positions[c.a] = vec4<f32>(pa + correction * (wa / wsum), 0.0);
  positions[c.b] = vec4<f32>(pb - correction * (wb / wsum), 0.0);
}
`;

// ── 3. Collision ─────────────────────────────────────────────────────────────

export const CLOTH_COLLIDE_SHADER = /* wgsl */`

// collisionType: 0 = none, 1 = ground, 2 = sphere, 3 = box
struct CollisionParams {
  collisionType : u32,
  vertCount     : u32,
  groundY       : f32,
  sphereRadius  : f32,
  sphereCX      : f32,
  sphereCY      : f32,
  sphereCZ      : f32,
  _pad0         : f32,
  boxMinX       : f32,
  boxMinY       : f32,
  boxMinZ       : f32,
  _pad1         : f32,
  boxMaxX       : f32,
  boxMaxY       : f32,
  boxMaxZ       : f32,
  _pad2         : f32,
};

@group(0) @binding(0) var<storage, read_write> positions    : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> prevPositions: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read>       inverseMass  : array<f32>;
@group(0) @binding(3) var<uniform>             params       : CollisionParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let vi = id.x;
  if (vi >= params.vertCount) { return; }
  if (inverseMass[vi] < 0.0001f) { return; }   // pinned — skip collision

  var pos = positions[vi].xyz;
  var moved = false;

  if (params.collisionType == 1u) {
    // Ground plane: keep y >= groundY
    if (pos.y < params.groundY) {
      pos.y = params.groundY;
      moved = true;
    }

  } else if (params.collisionType == 2u) {
    // Sphere: push outside
    let center = vec3<f32>(params.sphereCX, params.sphereCY, params.sphereCZ);
    let d    = pos - center;
    let dist = length(d);
    if (dist < params.sphereRadius && dist > 0.0001f) {
      pos   = center + normalize(d) * params.sphereRadius;
      moved = true;
    }

  } else if (params.collisionType == 3u) {
    // Box: push outside nearest face
    let bmin = vec3<f32>(params.boxMinX, params.boxMinY, params.boxMinZ);
    let bmax = vec3<f32>(params.boxMaxX, params.boxMaxY, params.boxMaxZ);
    if (all(pos >= bmin) && all(pos <= bmax)) {
      let dToMin = pos - bmin;
      let dToMax = bmax - pos;
      let d6     = min(dToMin, dToMax);
      let minVal = min(d6.x, min(d6.y, d6.z));
      if (d6.x == minVal) {
        pos.x = select(bmin.x, bmax.x, pos.x > (bmin.x + bmax.x) * 0.5f);
      } else if (d6.y == minVal) {
        pos.y = select(bmin.y, bmax.y, pos.y > (bmin.y + bmax.y) * 0.5f);
      } else {
        pos.z = select(bmin.z, bmax.z, pos.z > (bmin.z + bmax.z) * 0.5f);
      }
      moved = true;
    }
  }

  positions[vi] = vec4<f32>(pos, 0.0);
  // Kill velocity component toward the constraint surface by resetting prevPos
  if (moved) { prevPositions[vi] = vec4<f32>(pos, 0.0); }
}
`;

// ── 4. Pose update ───────────────────────────────────────────────────────────
// Writes simulated positions and recomputed normals into the interleaved vertex
// buffer (12 f32 per vertex: pos.xyz | normal.xyz | uv.xy | tangent.xyzw).
// UV and tangent components are static — this shader only touches indices 0–5.
//
// Normals are derived from finite differences across the cloth grid:
//   normal = normalize(cross(rightPos - leftPos, upPos - downPos))
// where up = smaller fine-row index (smaller Z), down = larger fine-row index.
// When a neighbor is absent (-1), the vertex's own position is used as fallback,
// yielding a one-sided derivative at boundaries. This naturally produces the
// correct (0,1,0) normal for the flat rest pose.

export const CLOTH_POSE_SHADER = /* wgsl */`

struct PoseParams {
  vertCount : u32,
};

@group(0) @binding(0) var<storage, read>       positions  : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> vertexBuf  : array<f32>;   // 12 floats per vertex
@group(0) @binding(2) var<storage, read>       neighbors  : array<vec4<i32>>;  // left/right/up/down
@group(0) @binding(3) var<uniform>             params     : PoseParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let vi = id.x;
  if (vi >= params.vertCount) { return; }

  let base = vi * 12u;
  let pos  = positions[vi].xyz;

  // Write position (floats 0–2)
  vertexBuf[base     ] = pos.x;
  vertexBuf[base + 1u] = pos.y;
  vertexBuf[base + 2u] = pos.z;

  // Neighbor indices (safe i32 → u32: clamp negatives to 0 before cast)
  let n        = neighbors[vi];
  let leftIdx  = u32(max(0i, n.x));
  let rightIdx = u32(max(0i, n.y));
  let upIdx    = u32(max(0i, n.z));
  let downIdx  = u32(max(0i, n.w));

  // Use own position as fallback when neighbor absent (one-sided derivative at boundary)
  let leftPos  = select(pos, positions[leftIdx].xyz,  n.x >= 0i);
  let rightPos = select(pos, positions[rightIdx].xyz, n.y >= 0i);
  let upPos    = select(pos, positions[upIdx].xyz,    n.z >= 0i);
  let downPos  = select(pos, positions[downIdx].xyz,  n.w >= 0i);

  var dH = rightPos - leftPos;
  var dV = upPos    - downPos;
  // Guard against fully-isolated vertices (no neighbors in a direction)
  if (length(dH) < 0.0001f) { dH = vec3f(1.0, 0.0,  0.0); }
  if (length(dV) < 0.0001f) { dV = vec3f(0.0, 0.0, -1.0); }

  var normal = normalize(cross(dH, dV));
  // Ensure normal is on the same hemisphere as the flat rest pose (+Y)
  if (dot(normal, vec3f(0.0, 1.0, 0.0)) < 0.0f) { normal = -normal; }

  // Write normal (floats 3–5)
  vertexBuf[base + 3u] = normal.x;
  vertexBuf[base + 4u] = normal.y;
  vertexBuf[base + 5u] = normal.z;
  // Floats 6–11 (UV + tangent) are static — do not write them.
}
`;
