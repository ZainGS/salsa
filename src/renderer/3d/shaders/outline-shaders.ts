/**
 * WGSL shaders for the screen-space ink outline pass.
 *
 * Three-stage pipeline:
 *  1. Depth+Normal pre-pass — render meshes into an offscreen depth texture (depth32float)
 *     AND a packed world-normal texture (rgba8unorm), driven by Renderer3D.
 *  2. Sobel pass — detect edges from BOTH silhouette boundary (depth→FAR) AND
 *     hard-crease discontinuity (normal dot < CREASE_DOT) → rgba8unorm edge mask.
 *  3. Composite pass — blend edge mask into the main render pass via fullscreen quad.
 */

// ── Outline depth+normal pre-pass shader ─────────────────────────────────────

/**
 * Combined depth+normal vertex/fragment shader.
 * Vertex: transforms position+normal into clip space.
 * Fragment: packs world normal into rgba8unorm color target.
 * Depth is written automatically by the GPU from the clip-space position.
 */
export const OUTLINE_DEPTH_NORMAL_SHADER = /* wgsl */`

struct MeshInstance {
  modelMatrix:  mat4x4<f32>,
  normalMatrix: mat4x4<f32>,
  diffuseColor: vec4<f32>,
  specularColor: vec4<f32>,
  emissiveColor: vec4<f32>,
}
struct SceneUniforms {
  viewProjection: mat4x4<f32>,
}

@group(0) @binding(0) var<storage, read> instances: array<MeshInstance>;
@group(0) @binding(1) var<uniform>       scene: SceneUniforms;

struct VertOut {
  @builtin(position) pos:         vec4<f32>,
  @location(0)       worldNormal: vec3<f32>,
}

@vertex fn vs(
  @location(0) pos:    vec3<f32>,
  @location(1) normal: vec3<f32>,
  @builtin(instance_index) iIdx: u32,
) -> VertOut {
  let worldPos  = instances[iIdx].modelMatrix  * vec4<f32>(pos,    1.0);
  let worldNorm = instances[iIdx].normalMatrix * vec4<f32>(normal, 0.0);
  return VertOut(
    scene.viewProjection * worldPos,
    normalize(worldNorm.xyz),
  );
}

@fragment fn fs(in: VertOut) -> @location(0) vec4<f32> {
  // Pack world normal from [-1,1] to [0,1] for rgba8unorm storage.
  return vec4<f32>(normalize(in.worldNormal) * 0.5 + 0.5, 1.0);
}

`;

// ── Edge detection shader ─────────────────────────────────────────────────────

/**
 * Detects outline pixels from two independent criteria:
 *
 *   (a) Silhouette edge — the pixel is on a mesh (depth < FAR) and at least
 *       one neighbor within `width` pixels is background (depth >= FAR).
 *
 *   (b) Hard-crease edge — both the pixel and a neighbor are on the mesh, but
 *       their world normals diverge by more than ~60° (dot < CREASE_DOT).
 *       This draws outlines along cube edges, cylinder cap rings, etc.
 *
 * Bind group 0:
 *   binding 0 = texture_depth_2d  (depth pre-pass output)
 *   binding 1 = uniform OutlineParams
 *   binding 2 = texture_2d<f32>   (packed normal, rgba8unorm pre-pass output)
 */
export const OUTLINE_SOBEL_SHADER = /* wgsl */`

struct OutlineParams {
  color: vec4<f32>,
  width: f32,   // outline half-width in physical pixels
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var depthTex:  texture_depth_2d;
@group(0) @binding(1) var<uniform>   params: OutlineParams;
@group(0) @binding(2) var normalTex: texture_2d<f32>;

struct VertOut {
  @builtin(position) pos: vec4<f32>,
}

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VertOut {
  var positions = array<vec2<f32>, 3>(
    vec2(-1.0, -1.0),
    vec2( 3.0, -1.0),
    vec2(-1.0,  3.0),
  );
  return VertOut(vec4<f32>(positions[vi], 0.0, 1.0));
}

fn loadDepth(coord: vec2<i32>) -> f32 {
  let sz = vec2<i32>(textureDimensions(depthTex));
  let c  = clamp(coord, vec2<i32>(0), sz - vec2<i32>(1));
  return textureLoad(depthTex, c, 0);
}

fn loadNormal(coord: vec2<i32>) -> vec3<f32> {
  let sz  = vec2<i32>(textureDimensions(normalTex));
  let c   = clamp(coord, vec2<i32>(0), sz - vec2<i32>(1));
  let enc = textureLoad(normalTex, c, 0).rgb;
  return enc * 2.0 - 1.0; // unpack [0,1] → [-1,1]
}

const FAR: f32        = 0.9999;
const CREASE_DOT: f32 = 0.3; // normals differing by >~72 degrees → hard edge

@fragment fn fs(in: VertOut) -> @location(0) vec4<f32> {
  let c = vec2<i32>(floor(in.pos.xy));

  // Skip background pixels
  if (loadDepth(c) >= FAR) { return vec4<f32>(0.0); }

  let centerNormal = loadNormal(c);
  let r = i32(params.width);
  var isEdge = false;

  for (var dy: i32 = -r; dy <= r; dy = dy + 1) {
    for (var dx: i32 = -r; dx <= r; dx = dx + 1) {
      if (dx == 0 && dy == 0) { continue; }
      let nc = c + vec2<i32>(dx, dy);
      let nd = loadDepth(nc);
      if (nd >= FAR) {
        // Silhouette: neighbor is background
        isEdge = true;
      } else if (dot(centerNormal, loadNormal(nc)) < CREASE_DOT) {
        // Hard crease: neighbor is mesh but normal diverges sharply
        isEdge = true;
      }
    }
  }

  let alpha = select(0.0, params.color.a, isEdge);
  return vec4<f32>(params.color.rgb * alpha, alpha);
}

`;

// ── Composite shader ──────────────────────────────────────────────────────────

/**
 * Blends the edge mask over the current render pass via a fullscreen triangle.
 * Edge texture is pre-multiplied-alpha RGBA — use (ONE, ONE_MINUS_SRC_ALPHA) blend.
 * Bind group 0: binding 0 = texture_2d<f32>  (Sobel edge mask)
 */
export const OUTLINE_COMPOSITE_SHADER = /* wgsl */`

@group(0) @binding(0) var edgeTex: texture_2d<f32>;

struct VertOut {
  @builtin(position) pos: vec4<f32>,
}

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VertOut {
  var positions = array<vec2<f32>, 3>(
    vec2(-1.0, -1.0),
    vec2( 3.0, -1.0),
    vec2(-1.0,  3.0),
  );
  return VertOut(vec4<f32>(positions[vi], 0.0, 1.0));
}

@fragment fn fs(in: VertOut) -> @location(0) vec4<f32> {
  return textureLoad(edgeTex, vec2<i32>(floor(in.pos.xy)), 0);
}

`;
