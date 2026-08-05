import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { OUTLINE_MASK_SHADER, OUTLINE_COMPOSITE_SHADER } from './shaders/silhouette-outline-shaders';

// Contract tests for the screen-space silhouette outline (docs/specs/hover-outline.md). Source-scanning — they
// can't run WebGPU, but they pin the invariants that silently break the effect if violated.
describe('silhouette outline shaders', () => {
  it('both shaders have vertex + fragment entry points and import cleanly', () => {
    for (const [name, src] of Object.entries({ OUTLINE_MASK_SHADER, OUTLINE_COMPOSITE_SHADER })) {
      expect(src, name).toContain('@vertex');
      expect(src, name).toContain('@fragment');
      expect(src.length, name).toBeGreaterThan(50);
    }
  });

  it('no backtick inside a WGSL comment (template-literal gotcha, per reference_3d_shaders)', () => {
    const text = readFileSync(new URL('./shaders/silhouette-outline-shaders.ts', import.meta.url), 'utf8');
    const offenders = text.split('\n').filter((l) => l.trimStart().startsWith('//') && l.includes('`'));
    expect(offenders).toEqual([]);
  });

  it('the composite is projection-agnostic: screen-space (fragCoord/uv), never a reconstructed world point', () => {
    // The whole point vs inverted-hull/expand-normals: it must NOT reconstruct from the camera (that broke SSAO in
    // ortho). It reads the mask by uv + fragCoord only.
    expect(OUTLINE_COMPOSITE_SHADER).toContain('maskTex');
    expect(OUTLINE_COMPOSITE_SHADER).toContain('fragCoord');
    expect(OUTLINE_COMPOSITE_SHADER).not.toContain('cameraPos');
    expect(OUTLINE_COMPOSITE_SHADER).not.toContain('invViewProjection');
  });

  it('the mask writes a solid silhouette (1.0)', () => {
    expect(OUTLINE_MASK_SHADER).toContain('vec4<f32>(1.0)');
  });
});
