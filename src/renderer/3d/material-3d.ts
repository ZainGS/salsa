/**
 * Material3D — Per-mesh visual properties for 3D rendering.
 *
 * Maps directly to the MeshInstance uniform in the WGSL shader:
 *   diffuseColor, specularColor, emissiveColor, shininess, flags.
 */

import { RGBA } from '../../types/rgba';

/**
 * Visual render style applied to a mesh in the fragment shader.
 *   'default'  — standard Phong shading (unchanged from before)
 *   'cel'      — toon/cel shading with stepped diffuse bands + hard specular
 *   'sketch'   — procedural crosshatch shading that makes the mesh look pencil-drawn
 *   'ink'      — flat base color with view-space silhouette rim darkening (manga ink look)
 */
export type RenderStyle = 'default' | 'cel' | 'sketch' | 'ink';

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
  /** Whether this mesh has a diffuse texture bound. */
  hasTexture: boolean;
  /** Whether this mesh has a normal map bound (triggers per-pixel Phong lighting). */
  hasNormalMap: boolean;
  /** Visual render style. Defaults to 'default' (standard Phong). */
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
  hasTexture: false,
  hasNormalMap: false,
  renderStyle: 'default',
};

/**
 * Encode material flags for the shader's emissiveColor.a field.
 * bit 0:   hasTexture
 * bit 1:   hasNormalMap (triggers per-pixel Phong)
 * bits 2-3: renderStyle  (0=default, 1=cel, 2=sketch, 3=ink)
 */
export function encodeMaterialFlags(mat: Material3D): number {
  const styleMap: Record<RenderStyle, number> = { default: 0, cel: 1, sketch: 2, ink: 3 };
  let flags = 0;
  if (mat.hasTexture)   flags |= 1;
  if (mat.hasNormalMap) flags |= 2;
  flags |= (styleMap[mat.renderStyle ?? 'default'] & 3) << 2;
  return flags;
}
