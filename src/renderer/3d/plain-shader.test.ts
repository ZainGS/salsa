import { describe, it, expect } from 'vitest';
import {
  MESH3D_FRAGMENT_SHADER,
  MESH3D_FRAGMENT_SHADER_PLAIN,
  MESH3D_FRAGMENT_SHADER_UNTEXTURED,
  MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN,
  MESH3D_FRAGMENT_SHADER_SHADOW_MODERN,
  MESH3D_FRAGMENT_SHADER_PLAIN_SHADOW_MODERN,
  MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN_SHADOW_MODERN,
} from './shaders/mesh3d-shaders';

// §3.1 uber-shader specialization: the PLAIN fragment variant compiles the unconditional (fwidth-forced)
// patternMask x3 / windowsPattern / gr_uvMetres block OUT and substitutes cheap defaults. A mesh with no
// pattern/window/ground/shade/normal-map is routed to it (Renderer3D._usesPatterns) and renders identically.
// These source-scan contracts pin the strip so the win can't silently regress (the module also throws at import
// if any //__PATTERN_BLOCK__ / //__SHADOW_* marker drifts — so building these exports at all is a check).
const CALL = 'patternMask(uv, patMode';   // the actual call in the pattern block (not the `fn patternMask(` def)

describe('§3.1 plain (pattern-stripped) fragment variant', () => {
  it('the FULL shaders keep the unconditional pattern/window/ground calls', () => {
    for (const fs of [MESH3D_FRAGMENT_SHADER, MESH3D_FRAGMENT_SHADER_UNTEXTURED]) {
      expect(fs).toContain(CALL);
      expect(fs).toContain('windowsPattern(uv, inst.patternParams');
      expect(fs).toContain('gr_uvMetres(uv, worldPos)');
    }
  });

  it('the PLAIN shaders STRIP those calls but still define the downstream vars', () => {
    for (const fs of [MESH3D_FRAGMENT_SHADER_PLAIN, MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN, MESH3D_FRAGMENT_SHADER_PLAIN_SHADOW_MODERN, MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN_SHADOW_MODERN]) {
      expect(fs).not.toContain(CALL);                                   // no patternMask call
      expect(fs).not.toContain('windowsPattern(uv, inst.patternParams'); // no windowsPattern call
      expect(fs).not.toContain('gr_uvMetres(uv, worldPos)');            // no gr_uvMetres call
      // ...but the vars the rest of the FS reads must still exist (else it wouldn't compile):
      expect(fs).toContain('var patBase = inst.diffuseColor.rgb;');
      expect(fs).toMatch(/let\s+winWL\s*=\s*vec4<f32>\(0\.0/);
      expect(fs).toMatch(/let\s+gUvM\s*=\s*vec2<f32>\(0\.0/);
      expect(fs).toContain('let patMaskR = 0.0;');
    }
  });

  it('no //__PATTERN_BLOCK__ marker survives in any built shader (all substitutions ran)', () => {
    for (const fs of [MESH3D_FRAGMENT_SHADER, MESH3D_FRAGMENT_SHADER_PLAIN, MESH3D_FRAGMENT_SHADER_UNTEXTURED, MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN, MESH3D_FRAGMENT_SHADER_SHADOW_MODERN, MESH3D_FRAGMENT_SHADER_PLAIN_SHADOW_MODERN]) {
      expect(fs).not.toContain('//__PATTERN_BLOCK__');
    }
  });

  it('plain is genuinely smaller than full, and the shadow-plain variant still receives shadows', () => {
    expect(MESH3D_FRAGMENT_SHADER_PLAIN.length).toBeLessThan(MESH3D_FRAGMENT_SHADER.length);
    expect(MESH3D_FRAGMENT_SHADER_PLAIN_SHADOW_MODERN).toContain('sampleShadow');   // shadow apply survived the strip
  });
});
