/**
 * LEAF CARDS (material bit 13) — the colour pass and the shadow DEPTH pass cut the SAME silhouette, and the CLUMP
 * card variant is keyed on the UV range branch.ts writes (polish-round-3 T4). WGSL only compiles in a browser, so
 * these pin the wiring: one shared WGSL block, the depth pass has a discard-only fragment stage, and the u-range
 * marker agrees on both sides of the CPU/GPU boundary.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LEAF_CARD_WGSL } from './shaders/mesh3d-shaders';
import { generateMeshFs } from './shaders/mesh-fs-generate';
import { MF, meshFsAllKey, type MeshFsKey } from './shaders/mesh-fs-key';
import { SHADOW_VERTEX_SHADER } from './shaders/shadow-shaders';
import { CLUMP_CARD_U0 } from '../../world/branch';

describe('leaf-card silhouettes — colour pass and shadow pass agree', () => {
  it('one shared WGSL block defines both silhouettes and the u-range switch', () => {
    expect(LEAF_CARD_WGSL).toMatch(/fn leafCluster\(/);
    expect(LEAF_CARD_WGSL).toMatch(/fn leafClump\(/);
    expect(LEAF_CARD_WGSL).toMatch(/fn leafCardCoverage\(/);
    // The CLUMP marker: branch.ts writes u in [CLUMP_CARD_U0, CLUMP_CARD_U0 + 1]; the shader tests u > 1.5, subtracts 2.
    expect(CLUMP_CARD_U0).toBe(2);
    expect(LEAF_CARD_WGSL).toMatch(/uv\.x > 1\.5/);
    expect(LEAF_CARD_WGSL).toMatch(/uv\.x - 2\.0/);
  });

  it('the colour FS (plain + shadow-receiving) cuts cards through leafCardCoverage', () => {
    const leafKey = (shadow: boolean): MeshFsKey => ({ ...meshFsAllKey(false, shadow, false, false), styles: 1, feat: MF.LEAF | MF.FOLIAGE | MF.ENV_SPEC, pat: 0, gm: 0 });
    for (const src of [generateMeshFs(meshFsAllKey(false, false)), generateMeshFs(meshFsAllKey(false, true)), generateMeshFs(leafKey(false)), generateMeshFs(leafKey(true))]) {
      expect(src).toMatch(/leafCardCoverage\(uv\)/);
      expect(src.match(/fn leafLobe\(/g)?.length).toBe(1);
    }
  });

  it('the shadow DEPTH pass discards outside the silhouette for bit-13 meshes only', () => {
    expect(SHADOW_VERTEX_SHADER).toMatch(/@fragment\s+fn fs_shadow\(/);
    expect(SHADOW_VERTEX_SHADER).toMatch(/flags & 8192u/);
    expect(SHADOW_VERTEX_SHADER).toMatch(/leafCardCoverage\(in\.uv\) < 0\.5\) \{ discard; \}/);
    expect(SHADOW_VERTEX_SHADER.match(/fn leafLobe\(/g)?.length).toBe(1);
    // …and the pipeline actually binds that fragment stage (it used to be `fragment: undefined`, depth-only).
    const pipe = readFileSync(fileURLToPath(new URL('./pipeline-3d.ts', import.meta.url)), 'utf8');
    expect(pipe).toMatch(/entryPoint: 'fs_shadow', targets: \[\]/);
  });
});
