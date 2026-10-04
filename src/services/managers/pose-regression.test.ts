/**
 * Pose & animation REGRESSION GATE (pose & animation audit 2026-09-28). Every preset pose, library pose, default-clip
 * keyframe and ~20 s of the procedural idle must keep the limbs OUT of the body — measured with the engine's own
 * arm-clearance measure on the real generated body, skinned exactly as the GPU does. And the per-body arm fit must
 * clear heavier/broader bodies while leaving the default body exactly as authored.
 * To SEE a failure: POSE_PREVIEW=out npx vitest run src/services/managers/pose-preview.test.ts (renders + report).
 */
import { describe, it, expect } from 'vitest';
import { bodyFor, CONFIGS } from './clothing-audit-harness';
import { BODY_POSES } from './body-generator';
import { buildDefaultPoses, buildDefaultClips } from './default-animations';
import { measureSelfIntersection, sampleDefaultClip, sampleIdlePose } from './pose-preview';
import { resolveArmClearance, skinVerts } from './arm-clearance';
import { rebaseClipRest } from '../../renderer/3d/skeleton-animator';
import { posedJointWorld, type PoseRotations, type SkinnedMeshData } from './skin-deform-metrics';

type Q = [number, number, number, number];
const HEAVY = { torsoThick: 1.35, hipWidth: 1.15, waist: 1.3, limbThick: 1.2, bust: 1.3 };
const BROAD = { shoulderWidth: 1.3, limbThick: 1.25, torsoThick: 1.1 };

function clipCount(m: SkinnedMeshData, verts: Float32Array, pose: PoseRotations): { n: number; hits: Record<string, number> } {
  const restP = skinVerts({ ...m, vertices: verts }, [], 'dualQuat').P;
  const p = skinVerts({ ...m, vertices: verts }, pose, 'dualQuat');
  const r = measureSelfIntersection(m, restP, p.P, p.N);
  return { n: r.verts.size, hits: r.hits };
}
const fitted = (m: SkinnedMeshData, pose: PoseRotations): PoseRotations => {
  const rot = new Map(pose.map((p) => [p.joint, [...p.q] as Q]));
  resolveArmClearance(m, rot, 'dualQuat');
  return [...rot].map(([joint, q]) => ({ joint, q }));
};

describe('pose & animation regression gate', () => {
  const { r, m } = bodyFor(CONFIGS[0]);
  const joints = m.jointNames.map((name) => ({ name }));

  it('every preset + library pose is clean on the default body', () => {
    const bad: string[] = [];
    for (const [name, pose] of Object.entries(BODY_POSES)) {
      const c = clipCount(m, r.geometry.vertices, pose as PoseRotations); if (c.n) bad.push(`preset ${name}: ${JSON.stringify(c.hits)}`);
    }
    for (const p of buildDefaultPoses(joints)) {
      const c = clipCount(m, r.geometry.vertices, p.rotations.map((rr) => ({ joint: m.jointNames[rr.jointIndex], q: rr.rotation })));
      // Hands on Hips rests the hand ON the hip (≤ 2 contact verts); everything else must be fully clear.
      if (c.n > (p.name === 'Hands on Hips' ? 2 : 0)) bad.push(`pose ${p.name}: ${JSON.stringify(c.hits)}`);
    }
    expect(bad).toEqual([]);
  }, 120_000);

  it('every default clip keyframe is clean on the default body', () => {
    const bad: string[] = [];
    for (const c of buildDefaultClips(joints)) {
      const frames = new Set<number>([0, c.endFrame]);
      for (const t of c.tracks) for (const k of t.keyframes) frames.add(k.frame);
      for (const f of frames) {
        const res = clipCount(m, r.geometry.vertices, sampleDefaultClip(m, c.name, f));
        if (res.n) bad.push(`${c.name} f${f}: ${JSON.stringify(res.hits)}`);
      }
    }
    expect(bad).toEqual([]);
  }, 120_000);

  it('the procedural idle stays clean for 20 s — and the arms actually move', () => {
    let clipping = 0, maxTravel = 0;
    const hand = m.jointNames.indexOf('hand_L');
    let v = -1, bw = 0;
    for (let i = 0; i < m.jointWeights.length / 4; i++) for (let k = 0; k < 4; k++) if (m.jointIndices[i * 4 + k] === hand && m.jointWeights[i * 4 + k] > bw) { bw = m.jointWeights[i * 4 + k]; v = i; }
    let first: number[] | null = null;
    for (let t = 0; t <= 20; t += 1) {
      const pose = sampleIdlePose(m, t);
      if (clipCount(m, r.geometry.vertices, pose).n) clipping++;
      const P = skinVerts(m, pose, 'dualQuat').P, at = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
      first ??= at; maxTravel = Math.max(maxTravel, Math.hypot(at[0] - first[0], at[1] - first[1], at[2] - first[2]));
    }
    expect(clipping).toBe(0);
    expect(maxTravel).toBeGreaterThan(0.02);   // the hands drift ≥ 2 cm — not the old dead-still arms
  }, 120_000);

  it('weight shifts keep the FEET PLANTED (every clip frame + pose: feet within 1.5 cm of where they stand)', () => {
    const footAt = (pose: PoseRotations) => {
      const w = posedJointWorld(m, pose);
      return ['foot_L', 'foot_R'].map((n) => { const j = m.jointNames.indexOf(n); return [w[j][12], w[j][13], w[j][14]]; });
    };
    const rest = footAt(BODY_POSES['Relaxed'] as PoseRotations);
    const drift = (pose: PoseRotations) => Math.max(...footAt(pose).map((p, i) => Math.hypot(p[0] - rest[i][0], p[1] - rest[i][1], p[2] - rest[i][2])));
    const bad: string[] = [];
    for (const c of buildDefaultClips(joints)) for (let f = 0; f <= c.endFrame; f += 2) {
      const d = drift(sampleDefaultClip(m, c.name, f)); if (d > 0.015) bad.push(`${c.name} f${f}: ${(d * 100).toFixed(1)} cm`);
    }
    for (const p of buildDefaultPoses(joints)) {
      const d = drift(p.rotations.map((rr) => ({ joint: m.jointNames[rr.jointIndex], q: rr.rotation }))); if (d > 0.015) bad.push(`pose ${p.name}: ${(d * 100).toFixed(1)} cm`);
    }
    expect(bad).toEqual([]);
  }, 120_000);

  it('the arm fit leaves the default body exactly as authored', () => {
    const rot = new Map((BODY_POSES['Relaxed'] as PoseRotations).map((p) => [p.joint, [...p.q] as Q]));
    expect(resolveArmClearance(m, rot, 'dualQuat')).toEqual({ L: 0, R: 0 });
  }, 60_000);

  for (const [label, shape] of [['heavy', HEAVY], ['broad', BROAD]] as const) {
    it(`the arm fit clears a ${label} body: Relaxed + the idle`, () => {
      const b = bodyFor(CONFIGS[0], shape);
      const before = clipCount(b.m, b.r.geometry.vertices, BODY_POSES['Relaxed'] as PoseRotations).n;
      expect(before).toBeGreaterThan(0);                                    // the fixed angles DO clip this body…
      const pose = fitted(b.m, BODY_POSES['Relaxed'] as PoseRotations);
      expect(clipCount(b.m, b.r.geometry.vertices, pose).n).toBe(0);        // …the fitted stance doesn't
      let clipping = 0;
      for (let t = 0; t <= 20; t += 2) if (clipCount(b.m, b.r.geometry.vertices, sampleIdlePose(b.m, t, 1, pose)).n) clipping++;
      expect(clipping).toBe(0);
    }, 180_000);
  }

  it('rebaseClipRest carries a track onto the current pose (exact at the rest keys, fading out far from rest)', () => {
    const rest: Q = [0, 0, 0, 1], up: Q = [0, 0, 0.5, 0.866], mine: Q = [0.1, 0, 0, 0.995];
    const clip = { id: 'c', name: 'x', startFrame: 0, endFrame: 30, fps: 24, tracks: [
      { jointIndex: 2, channel: 'rotation' as const, keyframes: [{ frame: 0, value: [...rest] }, { frame: 10, value: [...up] }, { frame: 30, value: [...rest] }] },
      { jointIndex: 5, channel: 'rotation' as const, keyframes: [{ frame: 0, value: [...rest] }, { frame: 30, value: [...up] }] },
    ] };
    const out = rebaseClipRest(clip, new Map([[2, mine]]));
    const v = out.tracks[0].keyframes.map((k) => k.value);
    for (const [i, want] of [[0, mine], [2, mine]] as const) for (let c = 0; c < 4; c++) expect(v[i][c]).toBeCloseTo(want[c], 6);
    // the middle key is 60° from rest → past the fade → exactly as authored (an overhead arm isn't tipped further)
    for (let c = 0; c < 4; c++) expect(v[1][c]).toBeCloseTo(up[c], 6);
    expect(out.tracks[1]).toBe(clip.tracks[1]);                              // joint not in the base → untouched
    expect(clip.tracks[0].keyframes[0].value).toEqual(rest);                 // pure
  });
});
