/**
 * src/packaging/packaging-material.test.ts — the panel-material blend mechanism behind the
 * transparent-by-default dieline: `texOverBase` (Material3D bit 15). The mesh3d fragment shader
 * composites the diffuse texture OVER the base colour by texture alpha when this bit is set
 * (albedo = mix(kraft, tex.rgb, tex.a)), so an EMPTY transparent dieline layer renders as plain
 * kraft cardboard (not black) and strokes read as painted directly on it. These tests pin the
 * flag encoding — the shader decodes the exact same bit (flags & 32768u).
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_MATERIAL, encodeMaterialFlags, type Material3D } from '../renderer/3d/material-3d';

const TEX_OVER_BASE_BIT = 32768; // bit 15 — must match the WGSL decode in mesh3d-shaders.ts

describe('packaging panel material — texOverBase (dieline-over-kraft blend)', () => {
  it('encodes texOverBase as bit 15 (32768) alongside hasTexture', () => {
    const mat: Material3D = { ...DEFAULT_MATERIAL, hasTexture: true, texOverBase: true };
    const flags = encodeMaterialFlags(mat);
    expect(flags & TEX_OVER_BASE_BIT).toBe(TEX_OVER_BASE_BIT);
    expect(flags & 1).toBe(1);                       // hasTexture still bit 0
  });

  it('is off by default and does not collide with any other flag bit', () => {
    expect(encodeMaterialFlags({ ...DEFAULT_MATERIAL }) & TEX_OVER_BASE_BIT).toBe(0);
    // Every OTHER boolean/style/pattern flag maxed out must never set bit 15.
    const everythingElse: Material3D = {
      ...DEFAULT_MATERIAL,
      hasTexture: true, hasNormalMap: true, renderStyle: 'cel-hd',
      alphaCutout: true, hairSheen: true, rimEnabled: true, sparkleEnabled: true,
      sparkleStar: true, leafCard: true, glassEnhance: true, patternMode: 'waves',
    };
    expect(encodeMaterialFlags(everythingElse) & TEX_OVER_BASE_BIT).toBe(0);
    // And texOverBase on top preserves all of those bits (pure OR, no overwrite).
    const withBlend = encodeMaterialFlags({ ...everythingElse, texOverBase: true });
    expect(withBlend).toBe(encodeMaterialFlags(everythingElse) | TEX_OVER_BASE_BIT);
  });
});
