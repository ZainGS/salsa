import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SSAO_PREPASS_SHADER,
  SSAO_AO_SHADER,
  SSAO_BLUR_SHADER,
  SSAO_DEBUG_SHADER,
} from './shaders/ssao-shaders';
import { DEFAULT_SSAO_CONFIG } from './ssao-pass';

// Contract tests for SSAO (spec docs/specs/ssao.md). Source-scanning, like mesh-instance-layout.test —
// they can't run WebGPU, but they pin the invariants that silently break the effect if violated.
describe('SSAO shaders', () => {
  const all = { SSAO_PREPASS_SHADER, SSAO_AO_SHADER, SSAO_BLUR_SHADER, SSAO_DEBUG_SHADER };

  it('every shader has both entry points and imports without a broken template literal', () => {
    for (const [name, src] of Object.entries(all)) {
      expect(src, name).toContain('@fragment');
      expect(src, name).toContain('fs_main');
      // A stray backtick in a WGSL comment would terminate the template literal → import would throw before
      // we ever get here. Reaching this assertion proves the no-backtick rule held.
      expect(src.length, name).toBeGreaterThan(50);
    }
    // The prepass + fullscreen shaders declare a vertex stage.
    expect(SSAO_PREPASS_SHADER).toContain('@vertex');
    expect(SSAO_AO_SHADER).toContain('@vertex');
  });

  it('the WGSL source file has no backtick inside a comment (template-literal gotcha)', () => {
    // Guard the reference_3d_shaders rule directly on the file text: no // or /* */ comment line may contain a
    // backtick (which would break the enclosing template literal).
    const text = readFileSync(new URL('./shaders/ssao-shaders.ts', import.meta.url), 'utf8');
    const offenders = text.split('\n').filter((l) => l.trimStart().startsWith('//') && l.includes('`'));
    expect(offenders).toEqual([]);
  });

  it('prepass writes world position with .w = 1 (marks a real surface vs cleared background)', () => {
    expect(SSAO_PREPASS_SHADER).toContain('vec4<f32>(worldPos, 1.0)');
  });

  it('AO reconstructs a normal via cross product and scales occlusion by intensity (params.y)', () => {
    expect(SSAO_AO_SHADER).toContain('cross(');
    expect(SSAO_AO_SHADER).toContain('ao.params.y');   // intensity multiply
    expect(SSAO_AO_SHADER).toContain('background');     // early-out comment for .w < 0.5
  });

  it('blur is depth-aware (weights taps by world-space distance from the centre)', () => {
    expect(SSAO_BLUR_SHADER).toContain('distance(cP, nW.xyz)');
  });

  it('is OFF by default → the whole path is a no-op until explicitly enabled', () => {
    expect(DEFAULT_SSAO_CONFIG.enabled).toBe(false);
  });
});
