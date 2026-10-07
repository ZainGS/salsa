/**
 * Step 8 specialised shader variants (shader-variants.ts; performance-plan §P21): the variant key derivation, the WGSL
 * specialisation of every mesh fragment shader, the id registry, and the instance-layout contract the key relies on
 * (the flags are read back from float 43 of the slot = MeshInstance.flags, a u32 lane).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as mesh3d from './shaders/mesh3d-shaders';
import { encodeMaterialFlags, DEFAULT_MATERIAL, type Material3D } from './material-3d';
import {
  variantKeyOfFlags, variantKeyOfMaterial, specialiseMeshFragment, ShaderVariantIds, VARIANT_FAMILIES, VARIANT_MODIFIER_MASK,
} from './shader-variants';

const mat = (p: Partial<Material3D>): Material3D => ({ ...DEFAULT_MATERIAL, ...p } as Material3D);
const FS_EXPORTS = [
  'MESH3D_FRAGMENT_SHADER', 'MESH3D_FRAGMENT_SHADER_PLAIN', 'MESH3D_FRAGMENT_SHADER_UNTEXTURED', 'MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN',
  'MESH3D_FRAGMENT_SHADER_SHADOW_MODERN', 'MESH3D_FRAGMENT_SHADER_PLAIN_SHADOW_MODERN',
  'MESH3D_FRAGMENT_SHADER_UNTEXTURED_SHADOW_MODERN', 'MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN_SHADOW_MODERN',
] as const;
const src = (k: typeof FS_EXPORTS[number]): string => (mesh3d as unknown as Record<string, string>)[k];

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
  it('unlisted families (textured, normal maps, board, triplanar, combos) stay on the uber-shader', () => {
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

describe('specialiseMeshFragment', () => {
  it('replaces the per-instance flags line of every mesh fragment shader with the constant, once', () => {
    for (const k of FS_EXPORTS) {
      const s = src(k);
      const v = specialiseMeshFragment(s, 262144, false);
      expect(v).toContain('const flags = 262144u;');
      expect(v).not.toMatch(/let\s+flags\s*=\s*inst\.flags;/);
      expect(v.length - s.length).toBeLessThan(200);   // a line substitution, nothing else
      expect(v).toContain('fn fs_main(');
    }
  });
  it('fast paths on: p8Fast becomes the constant true (both pattern blocks)', () => {
    for (const k of FS_EXPORTS) {
      const v = specialiseMeshFragment(src(k), 3072, true);
      expect(v).not.toMatch(/let\s+p8Fast\s*=\s*scene\.cascadeBias\.z/);
      expect(v).toContain('let p8Fast = true;');
      expect(specialiseMeshFragment(src(k), 3072, false)).toMatch(/let\s+p8Fast\s*=\s*scene\.cascadeBias\.z\s*>\s*0\.5;/);
    }
  });
  it('writes unsigned constants (bit 31)', () => {
    expect(specialiseMeshFragment(src('MESH3D_FRAGMENT_SHADER_UNTEXTURED'), 0x80000000 | 262144, true)).toContain(`const flags = ${(0x80000000 | 262144) >>> 0}u;`);
  });
  it('fails loud when the flags line drifted (no silent unspecialised copy)', () => {
    expect(() => specialiseMeshFragment('fn fs_main() { let f = 1u; }', 0, true)).toThrow(/flags line/);
    const twice = src('MESH3D_FRAGMENT_SHADER_UNTEXTURED') + '\nfn x() { let flags = inst.flags; }';
    expect(() => specialiseMeshFragment(twice, 0, true)).toThrow(/found 2/);
  });
  it('no backticks in the substituted lines (WGSL comments)', () => {
    const v = specialiseMeshFragment(src('MESH3D_FRAGMENT_SHADER'), 0, true);
    expect(v.includes('`')).toBe(false);
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
    expect(ids.idOf(0)).toBe(0);   // over the cap: the uber-shader
    expect(ids.keyOf(2)).toBe(3072);
    expect(ids.size).toBe(2);
    expect(ids.gen).toBe(2);
    expect(ids.keys()).toEqual([262144, 3072]);
  });
});

describe('layout contract: the variant key is the slot\'s flags lane (float 43)', () => {
  it('MeshInstance puts emissive at floats 40-42 and the u32 flags at float 43 in the mesh fragment shaders', () => {
    for (const k of FS_EXPORTS) {
      const body = src(k).match(/struct\s+MeshInstance\s*\{([^}]*)\}/)![1];
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
