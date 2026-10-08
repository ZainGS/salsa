/**
 * The frozen draw-rank variant id (shader-variants.ts: what is left of step 8 / performance-plan §P21 since shader-split
 * phase 4): the variant key derivation, the id registry, and the instance-layout contract the key relies on (the flags
 * are read back from float 43 of the slot = MeshInstance.flags, a u32 lane). (The WGSL specialisation tests went with
 * the uber shader.)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { generateMeshFs } from './shaders/mesh-fs-generate';
import { meshFsAllKey } from './shaders/mesh-fs-key';
import { encodeMaterialFlags, DEFAULT_MATERIAL, type Material3D } from './material-3d';
import { variantKeyOfFlags, ShaderVariantIds, VARIANT_FAMILIES, VARIANT_MODIFIER_MASK } from './shader-variants';

const mat = (p: Partial<Material3D>): Material3D => ({ ...DEFAULT_MATERIAL, ...p } as Material3D);
const variantKeyOfMaterial = (m: Material3D): number => variantKeyOfFlags(encodeMaterialFlags(m));
/** The all-features mesh fragment shaders (textured / untextured x shadow-receiving or not). */
const FS = [true, false].flatMap((tex) => [false, true].map((sh) => generateMeshFs(meshFsAllKey(tex, sh))));

describe('shader variant keys', () => {
  it('a listed feature family keys on the exact flags value, whatever the look modifiers', () => {
    const ground = encodeMaterialFlags(mat({ groundShade: true }));
    expect(variantKeyOfFlags(ground)).toBe(ground);
    const celGround = encodeMaterialFlags(mat({ groundShade: true, renderStyle: 'cel-hd', rimEnabled: true, toonShadow: true, retroColor: true }));
    expect(celGround).not.toBe(ground);
    expect(variantKeyOfFlags(celGround)).toBe(celGround);   // a look switch = a new key, never a shared one
    expect(variantKeyOfMaterial(mat({ patternMode: 'windows', glassEnhance: true }))).toBe(encodeMaterialFlags(mat({ patternMode: 'windows', glassEnhance: true })));
    expect(variantKeyOfMaterial(mat({}))).toBe(encodeMaterialFlags(mat({})));
  });
  it('unlisted families (textured, normal maps, board, triplanar, combos) get no key', () => {
    for (const p of [{ hasTexture: true }, { hasNormalMap: true }, { boardShade: true }, { worldTriplanar: true },
      { groundShade: true, metalShade: true }, { patternMode: 'windows' as const, metalShade: true }, { planarReflector: true }, { garpTex: true, hasTexture: true }]) {
      expect(variantKeyOfMaterial(mat(p))).toBe(-1);
    }
    expect(variantKeyOfFlags(0xffffffff)).toBe(-1);
  });
  it('the family list holds only non-modifier bits and the measured top families', () => {
    for (const f of VARIANT_FAMILIES) expect(f & VARIANT_MODIFIER_MASK).toBe(0);
    for (const p of [{ groundShade: true }, { patternMode: 'grid' as const }, { patternMode: 'windows' as const }, { glassEnhance: true }, { metalShade: true }, {},
      { leafCard: true, windSway: true, foliageShade: true }, { waterShade: true }, { neonShade: true }]) {
      expect(VARIANT_FAMILIES.has((encodeMaterialFlags(mat(p)) & ~VARIANT_MODIFIER_MASK) >>> 0)).toBe(true);
    }
  });
  it('bit 31 (retro colour) keys as an unsigned value', () => {
    const k = variantKeyOfMaterial(mat({ retroColor: true }));
    expect(k).toBeGreaterThan(0x7fffffff);
    expect(k).toBe(encodeMaterialFlags(mat({ retroColor: true })));
  });
});

describe('ShaderVariantIds', () => {
  it('hands out dense ids from 1, 0 for no variant, stable per key, capped', () => {
    const ids = new ShaderVariantIds();
    ids.max = 2;
    expect(ids.idOf(-1)).toBe(0);
    expect(ids.idOf(262144)).toBe(1);
    expect(ids.idOf(3072)).toBe(2);
    expect(ids.idOf(262144)).toBe(1);
    expect(ids.idOf(0)).toBe(0);   // over the cap: no id
    expect(ids.keyOf(2)).toBe(3072);
    expect(ids.size).toBe(2);
    expect(ids.gen).toBe(2);
    expect(ids.keys()).toEqual([262144, 3072]);
  });
});

describe('layout contract: the variant key is the slot\'s flags lane (float 43)', () => {
  it('MeshInstance puts emissive at floats 40-42 and the u32 flags at float 43 in the mesh fragment shaders', () => {
    for (const code of FS) {
      const body = code.match(/struct\s+MeshInstance\s*\{([^}]*)\}/)![1];
      const fields = [...body.matchAll(/(\w+)\s*:\s*([\w<>]+)\s*,/g)].map((m) => [m[1], m[2]]);
      let off = 0;
      const at: Record<string, number> = {};
      const ty: Record<string, string> = {};
      for (const [n, t] of fields) { at[n] = off; ty[n] = t; off += t === 'mat4x4<f32>' ? 16 : t.startsWith('vec4') ? 4 : t.startsWith('vec3') ? 3 : 1; }
      expect(at.emissive).toBe(40);
      expect(at.flags).toBe(43);
      expect(ty.flags).toBe('u32');
    }
  });
  it('the renderer writes the flags at float 43 and reads the key back from the same float', () => {
    const r3 = readFileSync(new URL('./renderer-3d.ts', import.meta.url), 'utf8');
    expect(r3).toMatch(/setUint32\(\(offset \+ 43\) \* 4, encodeMaterialFlags\(/);
    expect(r3).toMatch(/variantKeyOfFlags\(this\._svU32\[\(data\.byteOffset >> 2\) \+ offset \+ 43\]\)/);
  });
});
