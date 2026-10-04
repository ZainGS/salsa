/**
 * shadowReachesView — the shadow-pass caster cull added with spatial chunking (polish-round-3 Round 5).
 * A caster is dropped only when its box, swept along the sun down to the scene floor, misses the camera frustum.
 */
import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import { FrustumCuller, shadowReachesView } from './frustum-culler';

/** A WebGPU-style (z 0..1) perspective camera at the origin looking down -Z, 60° FOV, near 0.1 far 100. */
function camera(): FrustumCuller {
  const proj = mat4.perspectiveZO(mat4.create(), Math.PI / 3, 1, 0.1, 100);
  const view = mat4.lookAt(mat4.create(), [0, 1, 0], [0, 1, -10], [0, 1, 0]);
  return FrustumCuller.fromViewProjection(mat4.multiply(mat4.create(), proj, view));
}
const n = (v: number[]): number[] => { const l = Math.hypot(...v); return v.map((x) => x / l); };

describe('shadowReachesView', () => {
  const view = camera();
  it('keeps every caster that is itself in view (superset of the camera-culled list)', () => {
    expect(shadowReachesView(view, n([0, -1, 0]), 0, -1, 0, -11, 1, 3, -9)).toBe(true);
  });
  it('keeps an off-screen caster whose shadow is thrown INTO the view', () => {
    // A tall block behind-right of the view; low sun travelling toward -Z (into the view) → the shadow lands in front.
    const box = [8, 0, -12, 10, 20, -10] as const;
    expect(view.testAABB(...box)).toBe(false);                        // the caster itself is off-screen …
    expect(shadowReachesView(view, n([-0.6, -0.5, -0.2]), 0, ...box)).toBe(true);   // … its shadow is not
  });
  it('drops an off-screen caster whose shadow falls away from the view', () => {
    const box = [8, 0, -12, 10, 20, -10] as const;
    expect(shadowReachesView(view, n([0.6, -0.5, 0.2]), 0, ...box)).toBe(false);
    expect(shadowReachesView(view, n([0, -1, 0]), 0, 20, 0, 5, 22, 2, 7)).toBe(false);   // behind the camera, noon sun
  });
  it('is conservative when it cannot bound the shadow (sun at the horizon, unknown floor)', () => {
    expect(shadowReachesView(view, n([1, -0.01, 0]), 0, 20, 0, 5, 22, 2, 7)).toBe(true);
    expect(shadowReachesView(view, n([0, -1, 0]), NaN, 20, 0, 5, 22, 2, 7)).toBe(true);
  });
});
