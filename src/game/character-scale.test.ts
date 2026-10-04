/**
 * character-scale.test.ts — character SCALE (2026-10-04): the feet-anchored uniform scale, the gizmo constraint, the
 * Play capsule + camera framing following the avatar's size, and the scale surviving a save (toJSON → the loader).
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
const _g = globalThis as { self?: unknown; crypto?: unknown };
_g.self ??= globalThis;
_g.crypto ??= webcrypto;
(_g.self as { crypto?: unknown }).crypto ??= webcrypto;
import {
  feetAnchoredY, scaleFactorForHeight, clampCharacterScale, avatarCollisionScale, constrainCharacterScale,
  isCharacterPart, geometryMinY, type ScalableNode,
} from './character-scale';
import { avatarCameraFraming } from './third-person-camera';
import { DEFAULT_CHARACTER } from './character-controller';
import { SkinnedMesh3D } from '../scene-graph/shapes/skinned-mesh-3d';
import type { InteractionService } from '../services/interaction-service';

const node = (o: Partial<ScalableNode> = {}): ScalableNode => ({ x: 0, y: 0, z: 0, scaleX: 1, scaleY: 1, scaleZ: 1, ...o });
const snap = (n: ScalableNode) => ({ x: n.x, y: n.y, z: n.z, sx: n.scaleX, sy: n.scaleY, sz: n.scaleZ });
/** World Y of the soles of an upright node whose rest geometry's lowest point is `lo` (mesh space). */
const soles = (n: ScalableNode, lo: number) => n.y + n.scaleY * lo;

describe('feet-anchored scale', () => {
  it('keeps the soles at the same world height for any scale change (origin at the hips, feet below it)', () => {
    const lo = -0.4585;                     // the default body: soles 0.46 below its origin
    for (const [s0, s1] of [[1, 2], [1, 0.5], [0.054, 0.108], [2, 0.01]] as const) {
      const y0 = 1.3, y1 = feetAnchoredY(y0, s0, s1, lo);
      expect(y1 + s1 * lo).toBeCloseTo(y0 + s0 * lo, 12);
    }
  });
  it('scaleFactorForHeight / clamp', () => {
    expect(scaleFactorForHeight(2.0905, 1.7)).toBeCloseTo(0.8132, 4);
    expect(scaleFactorForHeight(0, 1.7)).toBe(1);
    expect(clampCharacterScale(-1)).toBeNull();
    expect(clampCharacterScale(NaN)).toBeNull();
    expect(clampCharacterScale(1e-6)).toBe(0.01);
    expect(clampCharacterScale(1e9)).toBe(1000);
  });
  it('geometryMinY reads the lowest Y of a strided buffer', () => {
    const v = new Float32Array(24); v[1] = 0.5; v[13] = -0.25;
    expect(geometryMinY(v, 12)).toBeCloseTo(-0.25, 6);
    expect(geometryMinY(new Float32Array(0), 12)).toBeNull();
  });
});

describe('gizmo scale constraint (constrainCharacterScale)', () => {
  const lo = -0.4585;
  it('a body becomes UNIFORM (the axis that moved most wins) and scales from its FEET', () => {
    const n = node({ isProceduralBody: true, transformViaSkeleton: true, y: 0.2 });
    const init = snap(n);
    n.scaleY = 2;                           // a Y-axis gizmo drag
    expect(constrainCharacterScale(n, init, lo)).toBe(true);
    expect([n.scaleX, n.scaleY, n.scaleZ]).toEqual([2, 2, 2]);
    expect(soles(n, lo)).toBeCloseTo(0.2 + lo, 12);
    n.scaleX = 0.5; n.scaleY = 0.9; n.scaleZ = 1;   // a corner drag pulled X hardest
    constrainCharacterScale(n, init, lo, { corner: true });
    expect([n.scaleX, n.scaleY, n.scaleZ]).toEqual([0.5, 0.5, 0.5]);
    expect(n.x).toBe(0); expect(n.z).toBe(0);
    expect(soles(n, lo)).toBeCloseTo(0.2 + lo, 12);
  });
  it('a formation (multi-selection) scale keeps the spread X / Z the controller computed', () => {
    const n = node({ isProceduralBody: true, x: 3, z: -1 });
    const init = snap(n);
    n.scaleX = n.scaleY = n.scaleZ = 1.5; n.x = 4.5; n.z = -1.5;
    constrainCharacterScale(n, init, lo);
    expect(n.x).toBe(4.5); expect(n.z).toBe(-1.5);
    expect(soles(n, lo)).toBeCloseTo(lo, 12);
  });
  it('a part riding the skeleton keeps its transform; other meshes are untouched', () => {
    const hair = node({ isHair: true, transformViaSkeleton: true });
    expect(isCharacterPart(hair)).toBe(true);
    const init = snap(hair);
    hair.scaleX = 3; hair.y = 1;
    constrainCharacterScale(hair, init, null);
    expect(snap(hair)).toEqual(init);
    const box = node();
    const i2 = snap(box); box.scaleY = 2;
    expect(constrainCharacterScale(box, i2, null)).toBe(false);
    expect(box.scaleY).toBe(2);              // a plain mesh keeps its non-uniform scale
  });
});

describe('Play follows the avatar size (capsule + camera framing)', () => {
  it('the capsule scales with the measured height; a 1.7 m avatar gets exactly the metre defaults', () => {
    const d = DEFAULT_CHARACTER;
    expect(avatarCollisionScale(1.7, d)).toEqual({ radius: d.radius, stepHeight: d.stepHeight });
    for (const k of [0.5, 2, 1 / 15]) {
      const c = avatarCollisionScale(1.7 * k, d);
      expect(c.radius).toBeCloseTo(d.radius * k, 12);
      expect(c.stepHeight).toBeCloseTo(d.stepHeight * k, 12);
    }
    expect(avatarCollisionScale(0, d)).toEqual({ radius: d.radius, stepHeight: d.stepHeight });
  });
  it('the camera framing reads the SCALED height (pivot, distance, min distance all × k)', () => {
    const base = avatarCameraFraming(2.0905, 2.0905 * 0.9, DEFAULT_CHARACTER);
    for (const k of [0.5, 2]) {
      const H = 2.0905 * k, f = avatarCameraFraming(H, H * 0.9, DEFAULT_CHARACTER);
      expect(f.thirdPersonDistance).toBeCloseTo(base.thirdPersonDistance * k, 9);
      expect(f.thirdPersonHeight).toBeCloseTo(base.thirdPersonHeight * k, 9);
      expect(f.cameraMinDistance).toBeCloseTo(base.cameraMinDistance * k, 9);
      expect(f.cameraShoulderOffset).toBeCloseTo(base.cameraShoulderOffset * k, 9);
    }
  });
});

describe('persistence: the character scale is an ordinary node scale', () => {
  it('toJSON carries the scale + feet-anchored Y, and a body rebuilt the loader way stands where it stood', () => {
    const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;
    const verts = new Float32Array(3 * 12);
    verts[1] = -0.4585; verts[13] = 1.632; verts[25] = 0.9;
    const geometry = { vertices: verts, indices: new Uint32Array([0, 1, 2]), format: '12float' as const };
    const body = new SkinnedMesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry });
    body.isProceduralBody = true; body.transformViaSkeleton = true;
    const lo = geometryMinY(verts, 12)!;
    const s1 = 2, y1 = feetAnchoredY(body.y, body.scaleY, s1, lo);
    body.setScale3D(s1, s1, s1); body.setPosition3D(0, y1, 0);
    const state = body.toJSON() as { y: number; scaleX: number; scaleY: number; scaleZ: number; isProceduralBody?: boolean; transformViaSkeleton?: boolean };
    expect([state.scaleX, state.scaleY, state.scaleZ]).toEqual([2, 2, 2]);
    expect(state.isProceduralBody).toBe(true);
    expect(state.transformViaSkeleton).toBe(true);
    // Scene3DManager's SkinnedMesh3D restore: constructor at x/y/z, then setScale3D(state.scale*).
    const back = new SkinnedMesh3D(isvc, 0, state.y, 0, { primitive: 'custom', geometry });
    back.setScale3D(state.scaleX, state.scaleY, state.scaleZ);
    const c = back.obbCorners!;
    expect(Math.min(...c.map((p) => p[1]))).toBeCloseTo(-0.4585, 5);   // soles where they were at scale 1
    expect(Math.max(...c.map((p) => p[1])) - Math.min(...c.map((p) => p[1]))).toBeCloseTo(2 * (1.632 + 0.4585), 5);
  });
});
