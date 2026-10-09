import { describe, it, expect } from 'vitest';
import * as mesh3d from './shaders/mesh3d-shaders';
import * as skinning from './shaders/skinning-shaders';
import * as shadow from './shaders/shadow-shaders';

// Audit 2026-10-09 §2 #22: the PS1 Vertex Jitter amount did nothing beyond on/off — every vertex shader snapped with
// gridSize * (1 - jitter) + gridSize * jitter, which is just gridSize. Now Jitter = how far each vertex is pulled
// onto the Snap Grid, and past 1 (the slider goes to 200%) the grid coarsens:
//   clipPos = mix(clipPos, snap(clipPos, gridSize / max(jitter, 1)), min(jitter, 1)). 0 = off, 1 = the old look.

/** Every WGSL string the three shader modules export (the vertex shaders that read ps1Config). */
function sources(): [string, string][] {
  const out: [string, string][] = [];
  for (const [modName, mod] of [['mesh3d', mesh3d], ['skinning', skinning], ['shadow', shadow]] as const) {
    for (const [k, v] of Object.entries(mod)) if (typeof v === 'string') out.push([`${modName}.${k}`, v]);
  }
  return out;
}

/** CPU mirror of the WGSL (snapToGrid + the mix). */
function jitterClip(pos: [number, number, number, number], jitter: number, gridSize: number): [number, number, number, number] {
  if (!(jitter > 0 && gridSize > 0)) return pos;
  const w = pos[3];
  const g = gridSize / Math.max(jitter, 1);
  const sx = Math.round(pos[0] / w * g) / g * w;
  const sy = Math.round(pos[1] / w * g) / g * w;
  const t = Math.min(jitter, 1);
  return [pos[0] + (sx - pos[0]) * t, pos[1] + (sy - pos[1]) * t, pos[2], w];
}

describe('PS1 vertex jitter amount', () => {
  it('no shader keeps the degenerate formula, and every jitter site blends toward the snapped position', () => {
    let sites = 0;
    for (const [name, src] of sources()) {
      expect(src, name).not.toMatch(/gridSize \* \(1\.0 - jitter\) \+ gridSize \* jitter/);
      if (!src.includes('scene.ps1Config.x')) continue;
      const calls = src.match(/clipPos = mix\(clipPos, (vc_)?snapToGrid\(clipPos, gridSize \/ max\(jitter, 1\.0\)\), min\(jitter, 1\.0\)\);/g) ?? [];
      const reads = src.match(/let jitter\s+= scene\.ps1Config\.x;/g) ?? [];
      expect(calls.length, name).toBe(reads.length);
      sites += calls.length;
    }
    // static mesh, vertex-colour mesh, the shadow-variant mesh VS, and the skinned helper + 2 weight-paint VS
    expect(sites).toBeGreaterThanOrEqual(5);
  });

  it('the amount scales the snap: 0 = untouched, 0.5 = half way, 1 = fully on the grid, 2 = a grid half as fine', () => {
    const p: [number, number, number, number] = [0.1234, -0.4567, 0.5, 2];
    const grid = 10;
    const full = jitterClip(p, 1, grid);
    expect(full[0] / full[3]).toBeCloseTo(Math.round(p[0] / p[3] * grid) / grid, 6);
    expect(jitterClip(p, 0, grid)).toEqual(p);
    const half = jitterClip(p, 0.5, grid);
    expect(half[0]).toBeCloseTo((p[0] + full[0]) / 2, 6);
    expect(half[1]).toBeCloseTo((p[1] + full[1]) / 2, 6);
    // different amounts give different positions (the old formula gave the same snap for every amount > 0)
    expect(jitterClip(p, 0.25, grid)[0]).not.toBeCloseTo(jitterClip(p, 0.75, grid)[0], 6);
    // past 100% the grid coarsens: 200% snaps to a grid of gridSize / 2
    const double = jitterClip(p, 2, grid);
    expect(double[0] / double[3]).toBeCloseTo(Math.round(p[0] / p[3] * grid / 2) / (grid / 2), 6);
    expect(double[0]).not.toBeCloseTo(full[0], 6);
  });
});
