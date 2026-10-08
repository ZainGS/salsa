/**
 * THE FROZEN DRAW-RANK VARIANT ID (what is left of engine-roadmap step 8 / performance-plan §P21 "shader variants").
 *
 * P21 compiled specialised copies of the mesh uber fragment shader with the instance flags as constants. The shader
 * split (docs/specs/shader-split.md) replaced it, and phase 4 (2026-10-08) deleted the uber shader and the variant
 * pipelines. ONE part stays: the draw rank (Renderer3D._ensureDrawOrder, Renderer3D.rankVariants) still groups meshes
 * by the P21 variant key of their instance flags, and spec §5.2 freezes that rank formula: coplanar decals / kerb paint
 * resolve by draw order, so a rank change would move pixels. This file keeps exactly the inputs of that rank term: the
 * key of a flags value (the value itself when its FEATURE FAMILY is listed, else -1) and the dense ids handed out in
 * first-seen order.
 *
 * WHICH (unchanged from P21): only flag values whose feature family (the flags minus the look modifiers: render
 * style, rim, matte, soft lighting, skin ramp, toon, retro colour) is in VARIANT_FAMILIES get a key.
 */

/** Material flag bits that are LOOK modifiers (not a feature family): render style (2-4), rim (7), matte (25), soft
 *  lighting (28), skin ramp (29), toon shadows (30), retro colour (31). */
export const VARIANT_MODIFIER_MASK = (0x1c | 0x80 | 0x02000000 | 0x10000000 | 0x20000000 | 0x40000000 | 0x80000000) >>> 0;

const PAT = (mode: number): number => (mode & 7) << 9;
const GLASS = 0x4000, GROUND = 0x40000, WIND = 0x80000, FOLIAGE = 0x100000, WATER = 0x200000, NEON = 0x400000, METAL = 0x800000, LEAF = 0x2000;

/** The feature families (flags & ~VARIANT_MODIFIER_MASK) that get a variant key (P21's measured city coverage; kept
 *  verbatim: the draw rank depends on it). */
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

/** The variant key of a flags value: the value itself when its family is listed, else -1 (no rank id). */
export function variantKeyOfFlags(flags: number): number {
  const f = flags >>> 0;
  return VARIANT_FAMILIES.has((f & ~VARIANT_MODIFIER_MASK) >>> 0) ? f : -1;
}

/** Small dense ids for the variant keys in use (the draw rank carries the id, not the 32-bit key). */
export class ShaderVariantIds {
  private readonly _id = new Map<number, number>();
  private readonly _key: number[] = [0];
  /** Ids handed out at most (a safety net; the family list bounds the keys in practice: ~17 per look in the city, and
   *  each look switch adds its own set). Over the cap a key gets id 0. */
  max = 128;
  /** Bumped when a new id is handed out. */
  gen = 0;
  /** The id of `key` (1..max), assigning one; 0 = none (key -1 or the cap reached). */
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
