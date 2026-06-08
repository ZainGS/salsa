/**
 * Material3D — Per-mesh visual properties for 3D rendering.
 *
 * Maps directly to the MeshInstance uniform in the WGSL shader:
 *   diffuseColor, specularColor, emissiveColor, shininess, flags.
 */

import { RGBA } from '../../types/rgba';

/**
 * Visual render style applied to a mesh in the fragment shader.
 *   'default'  — Cook-Torrance PBR (standard)
 *   'cel'      — toon/cel shading with stepped diffuse bands + hard specular
 *   'sketch'   — procedural crosshatch shading that makes the mesh look pencil-drawn
 *   'ink'      — flat base color with view-space silhouette rim darkening (manga ink look)
 *   'gouraud'  — per-vertex ambient+diffuse lighting (no per-pixel PBR); authentic PS1 look
 */
export type RenderStyle = 'default' | 'cel' | 'sketch' | 'ink' | 'gouraud';

export interface Material3D {
  /** Base color (multiplied with lighting result). */
  diffuse: RGBA;
  /** Specular highlight color. Alpha channel = shininess exponent. */
  specular: RGBA;
  /** Self-illumination color. Not affected by lighting. */
  emissive: RGBA;
  /** Specular exponent (1–256). Higher = tighter highlights. */
  shininess: number;
  /** Opacity (0–1). <1 = transparent pass. */
  opacity: number;
  /** PBR roughness (0 = mirror, 1 = fully rough). Used by Cook-Torrance BRDF. */
  roughness: number;
  /** PBR metalness (0 = dielectric, 1 = metallic). Controls Fresnel F0 and diffuse weight. */
  metalness: number;
  /** Whether this mesh has a diffuse texture bound. */
  hasTexture: boolean;
  /** Whether this mesh has a normal map bound (triggers per-pixel lighting). */
  hasNormalMap: boolean;
  /** Visual render style. Defaults to 'default' (PBR). */
  renderStyle: RenderStyle;
  /** When true, use a no-cull pipeline so both faces are always rendered. */
  doubleSided?: boolean;
}

export const DEFAULT_MATERIAL: Material3D = {
  diffuse: { r: 0.8, g: 0.8, b: 0.8, a: 1 },
  specular: { r: 0.3, g: 0.3, b: 0.3, a: 1 },
  emissive: { r: 0, g: 0, b: 0, a: 0 },
  shininess: 16,
  opacity: 1,
  roughness: 0.5,
  metalness: 0.0,
  hasTexture: false,
  hasNormalMap: false,
  renderStyle: 'default',
};

/**
 * Encode material flags for the shader's emissiveColor.a field.
 * bit 0:    hasTexture
 * bit 1:    hasNormalMap (triggers per-pixel normal mapping)
 * bits 2-4: renderStyle  (0=default PBR, 1=cel, 2=sketch, 3=ink, 4=gouraud)
 */
export function encodeMaterialFlags(mat: Material3D): number {
  const styleMap: Record<RenderStyle, number> = { default: 0, cel: 1, sketch: 2, ink: 3, gouraud: 4 };
  let flags = 0;
  if (mat.hasTexture)   flags |= 1;
  if (mat.hasNormalMap) flags |= 2;
  flags |= (styleMap[mat.renderStyle ?? 'default'] & 7) << 2;
  return flags;
}
