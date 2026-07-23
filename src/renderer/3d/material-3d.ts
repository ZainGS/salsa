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
export type RenderStyle = 'default' | 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud';

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
  /** When true, the shader discards texels with diffuse-texture alpha < 0.5 (alpha-test cutout — alpha-card
   *  hair). Order-independent (no blending / depth sorting). Requires hasTexture. */
  alphaCutout?: boolean;
  /** When true, add an anisotropic Kajiya-Kay highlight (the lengthwise hair sheen). Intensity = specular
   *  RGB, tightness = shininess. The strand tangent is the mesh tangent (stored hair flow direction). */
  hairSheen?: boolean;
  /** When true, add a Fresnel rim/back-light glow at the silhouette (a render-style-independent modifier;
   *  tinted by the scene light, stronger backlit). The "Enable Rim Light" toggle. */
  rimEnabled?: boolean;
  /** When true, add procedural twinkling micro-glints (the metal "sparkle/glisten" effect). Light-tinted, scintillates
   *  as the camera/light move + twinkles over time. A render-style-independent modifier (PBR styles). */
  sparkleEnabled?: boolean;
  /** Like sparkleEnabled but renders bigger, sparser ANIME ✦ STAR cross-twinkles instead of fine glints. */
  sparkleStar?: boolean;
  /** When true, the fragment cuts each quad into a procedural LEAF silhouette (alpha-test, order-independent) +
   *  a midrib/edge shade — turns a card into a leaf. For foliage `render:'card'`. Needs unit-square UVs per quad. */
  leafCard?: boolean;
  /** When true, this surface is GLASS — gets a stylized fresnel sky-reflection when the global glass-quality toggle
   *  is on (scene.ps1Config2.w). Marks which surfaces are glass; the toggle gates the effect. Enhanced-visuals pass. */
  glassEnhance?: boolean;
  /** Procedural geometric pattern over the albedo (analytic, antialiased in-shader). `diffuse` = primary colour,
   *  `patternColor` = secondary. Render-style-independent (modifies the base colour).
   *  'windows' = hash-LIT window cells (patternSpacing = lit fraction; lit cells also glow per-texel).
   *  'waves' = animated drifting bands over scene time (patternSpacing = scroll speed; bands carry the emissive). */
  patternMode?: 'none' | 'stripes' | 'dots' | 'diamonds' | 'checker' | 'grid' | 'windows' | 'waves';
  /** Pattern secondary colour (primary = `diffuse`). */
  patternColor?: RGBA;
  /** Pattern repeats across UV 0..1. */
  patternFreq?: number;
  /** Pattern rotation (radians) applied to the UV before the pattern. */
  patternAngle?: number;
  /** Stripe width / dot radius / line thickness, 0..1 of a cell. */
  patternScale?: number;
  /** Per-pattern extra (dot gap / second-axis frequency). */
  patternSpacing?: number;
  /** When true, the diffuse texture is composited OVER the base diffuse colour by its alpha
   *  (albedo = mix(diffuse, tex.rgb, tex.a)) instead of multiplying — the decal-over-base mode.
   *  A transparent texel shows the base material; painted strokes sit on top of it. Used by the
   *  packaging dieline (transparent layer over kraft cardboard). Requires hasTexture; the surface
   *  stays opaque (texture alpha never cuts the mesh — unlike alphaCutout). */
  texOverBase?: boolean;
  /** When true, the surface reads as PAPERBOARD (packaging §4.2): a faint paper-fiber grain on the
   *  BASE colour (applied UNDER the texOverBase artwork composite — the grain is the board, not the
   *  ink) + a subtle darkened rim toward the panel's UV-rect borders so panels read as thick board.
   *  ⚠ Rides the pattern instance slots (patternColor/patternParams), so it is MUTUALLY EXCLUSIVE
   *  with patternMode on the same mesh — packaging panels never use patterns. */
  boardShade?: boolean;
  /** boardShade: grain amplitude 0..1 (white coated ≈ 0.06, kraft ≈ 0.16). */
  boardGrain?: number;
  /** boardShade: edge-rim darkening strength 0..1 at the very panel border. */
  boardRimStrength?: number;
  /** boardShade: this panel's axis-aligned bounds in the dieline texture UV — [u0, v0, u1, v1]. */
  boardUVRect?: [number, number, number, number];
  /** boardShade: rim width in dieline-UV units per axis (≈1.6 mm / net mm extent). */
  boardRimUV?: [number, number];
  /** When true (transparent pass), multiply alpha by a soft radial falloff from UV centre — the
   *  packaging stage CONTACT-SHADOW blob (a dark ground quad whose edges fade to nothing). */
  radialFade?: boolean;
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
 * bit 5:    alphaCutout  (discard diffuse-texture alpha < 0.5 — alpha-card hair)
 * bit 6:    hairSheen    (anisotropic Kajiya-Kay highlight along the strands)
 * bit 7:    rimEnabled   (Fresnel rim / back-light silhouette glow)
 * bit 8:    sparkleEnabled (procedural twinkling micro-glints)
 * bits 9-11: patternMode  (0 none · 1 stripes · 2 dots · 3 diamonds · 4 checker · 5 grid · 6 windows · 7 waves)
 * bit 12:   sparkleStar  (anime ✦ star twinkles instead of fine glints)
 * bit 13:   leafCard     (procedural leaf-silhouette alpha cutout on a quad — foliage cards)
 * bit 14:   glassEnhance (stylized fresnel sky-reflection glass — gated by the global glass-quality toggle)
 * bit 15:   texOverBase  (diffuse texture composited OVER the base colour by tex alpha — decal-over-base;
 *                         the packaging dieline-over-kraft blend)
 * bit 16:   boardShade   (paperboard read: base fiber grain + panel-border rim darkening; repurposes the
 *                         pattern instance slots — see Material3D.boardShade)
 * bit 17:   radialFade   (soft radial alpha falloff from UV centre — the packaging contact-shadow blob)
 */
const PATTERN_MAP: Record<NonNullable<Material3D['patternMode']>, number> =
  { none: 0, stripes: 1, dots: 2, diamonds: 3, checker: 4, grid: 5, windows: 6, waves: 7 };

export function encodeMaterialFlags(mat: Material3D): number {
  const styleMap: Record<RenderStyle, number> = { default: 0, cel: 1, sketch: 2, ink: 3, gouraud: 4, 'cel-hd': 5 };
  let flags = 0;
  if (mat.hasTexture)      flags |= 1;
  if (mat.hasNormalMap)    flags |= 2;
  flags |= (styleMap[mat.renderStyle ?? 'default'] & 7) << 2;
  if (mat.alphaCutout)     flags |= 32;
  if (mat.hairSheen)       flags |= 64;
  if (mat.rimEnabled)      flags |= 128;
  if (mat.sparkleEnabled)  flags |= 256;
  flags |= (PATTERN_MAP[mat.patternMode ?? 'none'] & 7) << 9;
  if (mat.sparkleStar)     flags |= 4096;
  if (mat.leafCard)        flags |= 8192;
  if (mat.glassEnhance)    flags |= 16384;
  if (mat.texOverBase)     flags |= 32768;
  if (mat.boardShade)      flags |= 65536;
  if (mat.radialFade)      flags |= 131072;
  return flags;
}
