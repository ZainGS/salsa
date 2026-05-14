/**
 * Grease Pencil shaders — stroke quad-strip + fill triangle.
 *
 * Stroke pipeline:
 *   - One draw call per stroke: drawIndexed(6 * (pointCount-1)) or
 *     draw(6 * (pointCount-1), 1) with no IB.
 *   - vertex_index: 0–5 within one segment quad (2 triangles CCW).
 *   - Points are in a storage buffer (GpVertex × pointCount).
 *   - If stroke.parentJoint >= 0, the vertex shader multiplies each point
 *     by skinMatrices[jointIndex] before projection.
 *
 * Fill pipeline:
 *   - One draw call per closed stroke: drawArrays(triangleCount * 3).
 *   - Triangles are ear-clip pre-computed by GpRenderer3D on the CPU and
 *     uploaded as a flat vec3f array.
 *
 * Bind groups:
 *   Group 0, binding 0: GpStrokeUniforms (uniform buffer)
 *   Group 0, binding 1: GpVertex storage buffer
 *   Group 1, binding 0: skinMatrices storage buffer (optional; null BGL for non-skinned)
 */

// ── Stroke shader ─────────────────────────────────────────────────────────

export const GP_STROKE_VERTEX = /* wgsl */ `

struct GpStrokeUniforms {
  viewProjection: mat4x4<f32>,    // 64 bytes
  color:          vec4<f32>,      // 16 bytes — rgba, a includes layer opacity
  baseWidth:      f32,            //  4 bytes — world-unit half-width
  jointIndex:     i32,            //  4 bytes — <0 means no bone parenting
  canvasWidth:    f32,            //  4 bytes — canvas pixel width (for NDC→pixel width)
  canvasHeight:   f32,            //  4 bytes — canvas pixel height
};

struct GpVertex {
  pos:      vec3<f32>,  // world-space position
  pressure: f32,        // 0–1 brush pressure (drives local width)
  opacity:  f32,        // 0–1 per-point opacity
  _pad:     f32,        // alignment
};

@group(0) @binding(0) var<uniform>         uStroke:     GpStrokeUniforms;
@group(0) @binding(1) var<storage, read>   points:      array<GpVertex>;
@group(1) @binding(0) var<storage, read>   skinMatrices: array<mat4x4<f32>>;

struct VertOut {
  @builtin(position) pos:   vec4<f32>,
  @location(0)       color: vec4<f32>,   // stroke color × point opacity
  @location(1)       uv:    vec2<f32>,   // (along, across) — for future AA/rounding
};

// 6 vertices per segment (2 CCW triangles forming a quad):
//  0-top-A, 1-top-B, 2-bot-A,   3-bot-A, 4-top-B, 5-bot-B
const SIDE = array<i32, 6>( 0, 0, 1, 1, 0, 1 );   // 0=top, 1=bottom
const STEP = array<i32, 6>( 0, 1, 0, 0, 1, 1 );   // 0=point A, 1=point B

@vertex
fn vsMain(
  @builtin(vertex_index)   vi: u32,
  @builtin(instance_index) seg: u32,
) -> VertOut {
  let side = SIDE[vi];
  let step = STEP[vi];
  let ptA  = points[seg];
  let ptB  = points[seg + 1u];

  // Bone-parent transform.
  var worldA = ptA.pos;
  var worldB = ptB.pos;
  if (uStroke.jointIndex >= 0) {
    let m = skinMatrices[u32(uStroke.jointIndex)];
    worldA = (m * vec4<f32>(worldA, 1.0)).xyz;
    worldB = (m * vec4<f32>(worldB, 1.0)).xyz;
  }

  // Project to clip space.
  let clipA = uStroke.viewProjection * vec4<f32>(worldA, 1.0);
  let clipB = uStroke.viewProjection * vec4<f32>(worldB, 1.0);

  // NDC tangent & screen-space normal (for constant pixel width).
  let ndcA = clipA.xy / clipA.w;
  let ndcB = clipB.xy / clipB.w;
  var tang = normalize(ndcB - ndcA);
  let norm = vec2<f32>(-tang.y, tang.x); // perpendicular

  // Select the endpoint for this vertex.
  let pt   = select(ptA, ptB, step != 0);
  let clip = select(clipA, clipB, step != 0);

  // Half-width in NDC: baseWidth × pressure converted from world → screen fraction.
  // Approximate: use x NDC scale = 1/tan(fov/2) at z=1; here we use a simpler
  // canvas-based scale so width is consistent regardless of FOV.
  let halfW = uStroke.baseWidth * pt.pressure * 2.0 / uStroke.canvasHeight;
  let offset = norm * halfW * clip.w * select(1.0, -1.0, side != 0);

  var out: VertOut;
  out.pos   = vec4<f32>(clip.xy + offset, clip.z, clip.w);
  out.color = vec4<f32>(uStroke.color.rgb, uStroke.color.a * pt.opacity);
  out.uv    = vec2<f32>(f32(step), select(-1.0, 1.0, side == 0));
  return out;
}
`;

export const GP_STROKE_FRAGMENT = /* wgsl */ `

struct VertOut {
  @builtin(position) pos:   vec4<f32>,
  @location(0)       color: vec4<f32>,
  @location(1)       uv:    vec2<f32>,
};

@fragment
fn fsMain(in: VertOut) -> @location(0) vec4<f32> {
  return in.color;
}
`;

// ── Fill shader ───────────────────────────────────────────────────────────

export const GP_FILL_VERTEX = /* wgsl */ `

struct GpFillUniforms {
  viewProjection: mat4x4<f32>,
  fillColor:      vec4<f32>,
  jointIndex:     i32,
  _pad:           vec3<f32>,
};

@group(0) @binding(0) var<uniform>        uFill:       GpFillUniforms;
@group(0) @binding(1) var<storage, read>  triVerts:    array<vec3<f32>>;
@group(1) @binding(0) var<storage, read>  skinMatrices: array<mat4x4<f32>>;

struct FillOut {
  @builtin(position) pos:   vec4<f32>,
  @location(0)       color: vec4<f32>,
};

@vertex
fn vsMain(@builtin(vertex_index) vi: u32) -> FillOut {
  var worldPos = triVerts[vi];
  if (uFill.jointIndex >= 0) {
    let m = skinMatrices[u32(uFill.jointIndex)];
    worldPos = (m * vec4<f32>(worldPos, 1.0)).xyz;
  }
  var out: FillOut;
  out.pos   = uFill.viewProjection * vec4<f32>(worldPos, 1.0);
  out.color = uFill.fillColor;
  return out;
}
`;

export const GP_FILL_FRAGMENT = /* wgsl */ `

struct FillOut {
  @builtin(position) pos:   vec4<f32>,
  @location(0)       color: vec4<f32>,
};

@fragment
fn fsMain(in: FillOut) -> @location(0) vec4<f32> {
  return in.color;
}
`;

// ── Buffer layout constants ───────────────────────────────────────────────

/** Bytes per GpVertex in the GPU point buffer (pos vec3 + pressure + opacity + _pad = 6 f32). */
export const GP_VERTEX_BYTES = 24;

/** Bytes for GpStrokeUniforms (viewProj 64 + color 16 + baseWidth/jointIndex/w/h 16 = 96). */
export const GP_STROKE_UNIFORM_BYTES = 96;

/** Bytes for GpFillUniforms (viewProj 64 + fillColor 16 + jointIndex+pad 16 = 96). */
export const GP_FILL_UNIFORM_BYTES = 96;
