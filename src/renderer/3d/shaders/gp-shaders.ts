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
  canvasWidth:    f32,            //  4 bytes — target pixel width
  canvasHeight:   f32,            //  4 bytes — target pixel height
  projScaleY:     f32,            //  4 bytes — projection[1][1] (world → NDC scale: 1/tan(fov/2), or 1/orthoHalfHeight)
  minHalfPx:      f32,            //  4 bytes — the thinnest a stroke may get (half-width, pixels)
  _pad0:          f32,
  _pad1:          f32,
};

// Six scalars = 24 bytes, the CPU packing (GP_VERTEX_BYTES). NOT pos: vec3 — a vec3 is 16-byte aligned, which made
// the array stride 32 against the 24-byte CPU records, so every point after the first was read from the wrong place.
struct GpVertex {
  px:       f32,        // world-space position
  py:       f32,
  pz:       f32,
  pressure: f32,        // 0–1 brush pressure (drives local width)
  opacity:  f32,        // 0–1 per-point opacity
  _pad:     f32,
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
  var worldA = vec3<f32>(ptA.px, ptA.py, ptA.pz);
  var worldB = vec3<f32>(ptB.px, ptB.py, ptB.pz);
  if (uStroke.jointIndex >= 0) {
    let m = skinMatrices[u32(uStroke.jointIndex)];
    worldA = (m * vec4<f32>(worldA, 1.0)).xyz;
    worldB = (m * vec4<f32>(worldB, 1.0)).xyz;
  }

  // Project to clip space.
  let clipA = uStroke.viewProjection * vec4<f32>(worldA, 1.0);
  let clipB = uStroke.viewProjection * vec4<f32>(worldB, 1.0);

  // Segment direction in PIXEL space (NDC x and y have different pixel sizes on a non-square target, so the
  // perpendicular must be taken in pixels or diagonal strokes get thinner / thicker). A zero-length segment (two
  // samples at the same spot) keeps a fixed direction instead of normalize(0) = NaN.
  let halfRes = vec2<f32>(uStroke.canvasWidth, uStroke.canvasHeight) * 0.5;
  let ndcA = clipA.xy / clipA.w;
  let ndcB = clipB.xy / clipB.w;
  let dPx  = (ndcB - ndcA) * halfRes;
  let dLen = length(dPx);
  var tang = vec2<f32>(1.0, 0.0);
  if (dLen > 1e-5) { tang = dPx / dLen; }
  let norm = vec2<f32>(-tang.y, tang.x); // perpendicular (pixels)

  // Select the endpoint for this vertex. WGSL select() does NOT accept struct operands, so pick the
  // scalar fields we need (pressure/opacity) individually; clip is a vec4 and selects fine.
  let pressure = select(ptA.pressure, ptB.pressure, step != 0);
  let opacity  = select(ptA.opacity,  ptB.opacity,  step != 0);
  let clip = select(clipA, clipB, step != 0);

  // Half-width: baseWidth is a WORLD-unit half-width (the panel's Width slider) — projected to pixels at this
  // endpoint's depth (perspective: shrinks with distance; ortho: w = 1), never thinner than minHalfPx so a zoomed-out
  // stroke stays visible. (It used to be read as a PIXEL half-width: the default 0.02 drew 0.04 px wide = nothing.)
  let w = max(clip.w, 1e-6);
  let halfPx = max(uStroke.baseWidth * pressure * uStroke.projScaleY * halfRes.y / w, uStroke.minHalfPx);
  let offset = (norm * halfPx / halfRes) * clip.w * select(1.0, -1.0, side != 0);

  var out: VertOut;
  out.pos   = vec4<f32>(clip.xy + offset, clip.z, clip.w);
  out.color = vec4<f32>(uStroke.color.rgb, uStroke.color.a * opacity);
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
  // Three scalars, NOT a vec3: a vec3 is 16-byte aligned, which made the struct 112 bytes against the 96-byte buffer
  // bound to it — a validation error that invalidated the WHOLE frame as soon as a closed / filled stroke existed.
  _pad0:          f32,
  _pad1:          f32,
  _pad2:          f32,
};

@group(0) @binding(0) var<uniform>        uFill:       GpFillUniforms;
// Flat xyz triples (3 f32 per vertex, the CPU packing) — array<vec3<f32>> has a 16-byte stride and misread them.
@group(0) @binding(1) var<storage, read>  triVerts:    array<f32>;
@group(1) @binding(0) var<storage, read>  skinMatrices: array<mat4x4<f32>>;

struct FillOut {
  @builtin(position) pos:   vec4<f32>,
  @location(0)       color: vec4<f32>,
};

@vertex
fn vsMain(@builtin(vertex_index) vi: u32) -> FillOut {
  var worldPos = vec3<f32>(triVerts[vi * 3u], triVerts[vi * 3u + 1u], triVerts[vi * 3u + 2u]);
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

/** Bytes per GpVertex in the GPU point buffer (x, y, z, pressure, opacity, _pad = 6 f32 — the WGSL struct is six scalars). */
export const GP_VERTEX_BYTES = 24;

/** Bytes for GpStrokeUniforms (viewProj 64 + color 16 + baseWidth/jointIndex/w/h 16 + projScaleY/minHalfPx/pad 16 = 112). */
export const GP_STROKE_UNIFORM_BYTES = 112;

/** The thinnest a stroke is drawn (half-width in pixels) however far the camera is. */
export const GP_MIN_HALF_WIDTH_PX = 0.75;

/** Bytes for GpFillUniforms (viewProj 64 + fillColor 16 + jointIndex+pad 16 = 96). */
export const GP_FILL_UNIFORM_BYTES = 96;
