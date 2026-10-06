/**
 * SPECIALISED MESH SHADER VARIANTS (engine-roadmap step 8; performance-plan §P21; docs/ui/performance.md §Shader
 * variants).
 *
 * The main mesh fragment shader (shaders/mesh3d-shaders.ts) is one uber-shader that branches on the 32 material flag
 * bits (`MeshInstance.flags`, a u32 lane; material-3d.ts encodeMaterialFlags). Every pixel carries the registers and the
 * code of every feature. A VARIANT is the same shader source with the per-instance flags line replaced by a
 * compile-time constant:
 *
 *   let flags = inst.flags;   ->   const flags = 262144u;
 *
 * so every flag test folds and the shader compiler strips the unused features (and, with Renderer3D.shaderFastPaths
 * on, the P8 slow paths: `p8Fast` becomes `true`). The mechanism WRAPS the existing sources (a text substitution on the
 * exported fragment strings): edits to mesh3d-shaders.ts apply to the variants unchanged.
 *
 * IDENTITY: a variant is used only for a mesh whose instance flags EQUAL its constant (the key is the exact 32-bit
 * value, read back from the instance slot the renderer wrote), so it computes what the uber-shader computes for that
 * mesh. flags2 (normalMatrix column 3 .x) stays dynamic: array copies take it from their source at a group repack only.
 *
 * WHICH: only flag values whose FEATURE FAMILY (the flags minus the look modifiers: render style, rim, matte, soft
 * lighting, skin ramp, toon, retro colour) is in VARIANT_FAMILIES get a variant. That list is the measured pixel
 * coverage (pupdrive/variants/cover2.js: procedural ground, the roof grid / window facade / stripe patterns, glass,
 * painted metal, plain, foliage, water, neon cover 99 % of the city's shaded pixels). A look switch (Cel, ink, PS1 ...)
 * changes the modifier bits, so its variants are new keys (compiled on demand, uber-shader meanwhile).
 *
 * COMPILE: variants compile in the background through the GPUPipelineCache (warm priority VARIANT, after the common
 * set); until one is ready its meshes draw with the uber-shader (never a skipped draw, never a blocking compile).
 */

import { encodeMaterialFlags, type Material3D } from './material-3d';

/** Material flag bits that are LOOK modifiers (not a feature family): render style (2-4), rim (7), matte (25), soft
 *  lighting (28), skin ramp (29), toon shadows (30), retro colour (31). */
export const VARIANT_MODIFIER_MASK = (0x1c | 0x80 | 0x02000000 | 0x10000000 | 0x20000000 | 0x40000000 | 0x80000000) >>> 0;

const PAT = (mode: number): number => (mode & 7) << 9;
const GLASS = 0x4000, GROUND = 0x40000, WIND = 0x80000, FOLIAGE = 0x100000, WATER = 0x200000, NEON = 0x400000, METAL = 0x800000, LEAF = 0x2000;

/** The feature families (flags & ~VARIANT_MODIFIER_MASK) that get a specialised variant, from the coverage profile
 *  (performance-plan §P21 "Coverage"). Untextured only: textured city meshes (GARP props) are ~0.3 % of the pixels. */
export const VARIANT_FAMILIES: ReadonlySet<number> = new Set<number>([
  0,                                   // plain PBR / cel walls, props
  GROUND,                              // procedural ground (roads, pavements, plazas): the largest share
  PAT(5), PAT(6), PAT(6) | GLASS,      // roof grid, window facades (with / without glass enhance)
  PAT(1), PAT(2), PAT(4), PAT(7),      // stripes, dots, checker, waves (crossings, tactile paving, ad screens)
  GLASS,                               // glass (shop fronts, canopies)
  METAL,                               // painted metal (street furniture, vehicles)
  LEAF | WIND | FOLIAGE, WIND | FOLIAGE, WIND,   // tree crowns, bushes, wind-swayed props
  WATER, NEON,
].map((f) => f >>> 0));

/** The variant key of a flags value: the value itself when its family is listed, else -1 (the uber-shader). */
export function variantKeyOfFlags(flags: number): number {
  const f = flags >>> 0;
  return VARIANT_FAMILIES.has((f & ~VARIANT_MODIFIER_MASK) >>> 0) ? f : -1;
}

/** The variant key of a material (encodes its flags; for rank / state-code derivation, not per-frame hot loops). */
export function variantKeyOfMaterial(mat: Material3D): number {
  return variantKeyOfFlags(encodeMaterialFlags(mat));
}

const FLAGS_LINE = /let\s+flags\s*=\s*inst\.flags;/g;
const P8_LINE = /let\s+p8Fast\s*=\s*scene\.cascadeBias\.z\s*>\s*0\.5;/g;

/** The WGSL of a variant: `src` (one of the mesh fragment shaders) with the flags line replaced by the constant, and
 *  (fastPaths) the P8 fast-path switch by `true`. Throws when the flags line is not found exactly once (the source
 *  drifted: fail loud instead of silently compiling an unspecialised copy). */
export function specialiseMeshFragment(src: string, flags: number, fastPaths: boolean): string {
  const n = (src.match(FLAGS_LINE) ?? []).length;
  if (n !== 1) throw new Error(`shader-variants: expected one flags line in the fragment shader, found ${n}`);
  let out = src.replace(FLAGS_LINE, `const flags = ${flags >>> 0}u;   // specialised variant (shader-variants.ts)`);
  if (fastPaths) out = out.replace(P8_LINE, 'let p8Fast = true;   // specialised: Renderer3D.shaderFastPaths on');
  return out;
}

/** Pipeline base of a variant: bit 0 textured, 1 no-cull (double-sided), 2 patterned (full shader), 3 shadow-receiving. */
export const VB_TEXTURED = 1, VB_NOCULL = 2, VB_PATTERNED = 4, VB_SHADOW = 8;

/** Small dense ids for the keys in use (GPU-driven state codes and the draw rank carry the id, not the 32-bit key). */
export class ShaderVariantIds {
  private readonly _id = new Map<number, number>();
  private readonly _key: number[] = [0];
  /** Ids handed out at most (a safety net; the family list bounds the keys in practice: ~17 per look in the city, and
   *  each look switch adds its own set). Over the cap a key keeps the uber-shader. */
  max = 128;
  /** Bumped when a new id is handed out (the draw rank re-ranks so a new variant's meshes form one run). */
  gen = 0;
  /** The id of `key` (1..max), assigning one; 0 = no variant (key -1 or the cap reached). */
  idOf(key: number): number {
    if (key < 0) return 0;
    const id = this._id.get(key);
    if (id !== undefined) return id;
    if (this._key.length > this.max) return 0;
    const n = this._key.length;
    this._key.push(key); this._id.set(key, n); this.gen++;
    return n;
  }
  /** The key of id `id` (> 0). */
  keyOf(id: number): number { return this._key[id] ?? -1; }
  get size(): number { return this._key.length - 1; }
  keys(): number[] { return this._key.slice(1); }
}
