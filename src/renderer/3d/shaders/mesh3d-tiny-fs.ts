/**
 * RENDER DEBUG tinyMeshFS (render-debug.ts; mobile-parity RENDER-1): a minimal mesh fragment shader swapped in for
 * EVERY mesh / skinned-mesh fragment pipeline when the switch is on (read when the pipelines are created, so it needs
 * a reload). Same bindings (instance storage at 0, scene uniforms at 1) and the same VS -> FS location contract
 * (gouraud colour 0, flat instance index 2, world normal 4) as the uber shader, so it runs against the real data
 * path with ~15 lines of code instead of ~2,700. The tablet's rainbow tiles appear on any runtime-loaded value in
 * the uber shader; if they are gone with this shader, the uber shader's size / complexity is the trigger.
 */
export const MESH3D_FS_TINY = /* wgsl */ `
struct MeshInstance {
  modelMatrix:    mat4x4<f32>,
  normalMatrix:   mat4x4<f32>,
  diffuseColor:   vec4<f32>,
  specularColor:  vec4<f32>,
  emissive:       vec3<f32>,
  flags:          u32,
  textureIndex:   u32,
  normalMapIndex: u32,
  roughness:      f32,
  metalness:      f32,
  patternColor:   vec4<f32>,
  patternParams:  vec4<f32>,
  uvTransform:    vec4<f32>,
};
@group(0) @binding(0) var<storage, read> u_instances: array<MeshInstance>;

// The leading fields of the real SceneUniforms (a prefix is valid: the bound buffer is larger).
struct SceneUniforms {
  viewProjection: mat4x4<f32>,
  cameraPosition: vec4<f32>,
  ambientColor:   vec4<f32>,
  lightDirection: vec4<f32>,
  lightColor:     vec4<f32>,
};
@group(0) @binding(1) var<uniform> scene: SceneUniforms;

@fragment
fn fs_main(
  @builtin(position)              fragPos:     vec4<f32>,
  @location(2) @interpolate(flat) instanceIdx: u32,
  @location(4)                    worldNormal: vec3<f32>,
) -> @location(0) vec4<f32> {
  let d = u_instances[instanceIdx].diffuseColor;
  let n = worldNormal * inverseSqrt(max(dot(worldNormal, worldNormal), 1e-12));
  let ndl = max(dot(n, normalize(-scene.lightDirection.xyz)), 0.0);
  let light = scene.ambientColor.rgb * scene.ambientColor.a + scene.lightColor.rgb * scene.lightDirection.w * ndl;
  return vec4<f32>(clamp(d.rgb * light, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
`;
