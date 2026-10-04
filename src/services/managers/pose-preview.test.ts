/**
 * Pose / animation PREVIEW report — renders every preset pose + default clip keyframes to PNGs and lists limb
 * self-intersections. Runs only with POSE_PREVIEW=<dir>:
 *   POSE_PREVIEW=out npx vitest run src/services/managers/pose-preview.test.ts
 */
import { describe, it, expect } from 'vitest';
import { bodyFor, CONFIGS } from './clothing-audit-harness';
import { BODY_POSES } from './body-generator';
import { buildDefaultPoses, buildDefaultClips } from './default-animations';
import { previewPose, sampleDefaultClip, renderFramesPNG } from './pose-preview';
import type { PoseRotations } from './skin-deform-metrics';
import { skinAll } from './clothing-audit-harness';
import { sampleIdlePose } from './pose-preview';
import { resolveArmClearance } from './arm-clearance';
import { buildIdleVariantClips } from './default-idle-variants';
import { playArmClearance } from './default-locomotion';
import { relaxedStance } from './pose-authoring';
import { sampleClipPose } from '../../renderer/3d/skeleton-animator';

describe.skipIf(!process.env.POSE_PREVIEW)('pose preview report', () => {
  it('renders presets + clip frames', async () => {
    const fs = await import('node:fs'), path = await import('node:path');
    const dir = process.env.POSE_PREVIEW!; fs.mkdirSync(dir, { recursive: true });
    const only = process.env.POSE_ONLY;
    const { r, m } = bodyFor(CONFIGS[0], process.env.POSE_BODY ? JSON.parse(process.env.POSE_BODY) : {});   // e.g. POSE_BODY='{"torsoThick":1.35}'
    const rows: string[] = [];
    const doOne = (label: string, pose: PoseRotations) => {
      if (only && !label.toLowerCase().includes(only.toLowerCase())) return;
      const { inter, png } = previewPose(m, r.geometry.vertices, pose);
      fs.writeFileSync(path.join(dir, label.replace(/[^a-z0-9]+/gi, '_') + '.png'), png);
      rows.push(`${label.padEnd(34)} ${inter.verts.size ? `CLIP ${inter.verts.size} verts, ${inter.maxMm.toFixed(0)} mm  ${JSON.stringify(inter.hits)}` : 'clean'}`);
    };
    // What the ENGINE shows: presets + non-adaptive library poses go through the arm-clearance fit for this body.
    const fit = (pose: PoseRotations): PoseRotations => {
      const rot = new Map(pose.map((p) => [p.joint, [...p.q] as [number, number, number, number]]));
      resolveArmClearance(m, rot, 'dualQuat');
      return [...rot].map(([joint, q]) => ({ joint, q }));
    };
    for (const [name, pose] of Object.entries(BODY_POSES)) doOne(`body-pose ${name}`, fit(pose as PoseRotations));
    const joints = m.jointNames.map((name) => ({ name }));
    for (const p of buildDefaultPoses(joints)) {
      const pose = p.rotations.map((rr) => ({ joint: m.jointNames[rr.jointIndex], q: rr.rotation }));
      doOne(`lib-pose ${p.name}${p.adaptive ? ' (adaptive: engine blends by girth — not previewed)' : ''}`, p.adaptive ? pose : fit(pose));
    }
    const relaxedFit = fit(BODY_POSES['Relaxed'] as PoseRotations);
    for (const c of buildDefaultClips(joints)) {
      const frames = new Set<number>([0, c.endFrame]);
      for (const t of c.tracks) for (const k of t.keyframes) frames.add(k.frame);
      for (const f of [...frames].sort((a, b) => a - b)) doOne(`clip ${c.name} f${f}`, sampleDefaultClip(m, c.name, f, relaxedFit));
    }
    // The Play IDLE VARIANTS (default-idle-variants.ts, 2026-10-04) as Play builds them: fitted to this body's arm
    // clearance, every 0.5 s of each one-shot (they carry every joint, so the bind only fills joints they lack).
    {
      const rigJoints = m.jointNames.map((name, j) => ({ name, localPosition: [m.jointLocalPositions[j * 3], m.jointLocalPositions[j * 3 + 1], m.jointLocalPositions[j * 3 + 2]] }));
      const rel = new Map(Object.entries(relaxedStance()));
      const clr = playArmClearance(resolveArmClearance(m, new Map(m.jointNames.map((n) => [n, [...(rel.get(n) ?? [0, 0, 0, 1])] as [number, number, number, number]])), 'dualQuat'));
      const bind = {
        rotations: m.jointNames.map((nm) => [...(rel.get(nm) ?? [0, 0, 0, 1])] as [number, number, number, number]),
        positions: m.jointNames.map((_, j) => [m.jointLocalPositions[j * 3], m.jointLocalPositions[j * 3 + 1], m.jointLocalPositions[j * 3 + 2]] as [number, number, number]),
        scales: m.jointNames.map(() => [1, 1, 1] as [number, number, number]),
      };
      for (const c of buildIdleVariantClips(rigJoints, { armClearance: clr, glasses: true })) {
        for (let f = 0; f <= c.endFrame; f += 15) {
          const s = sampleClipPose(c, bind, f);
          doOne(`idlevar ${c.name} f${f}`, m.jointNames.map((joint, j) => ({ joint, q: s.rotations[j] as [number, number, number, number] })));
        }
      }
    }
    // The procedural IDLE (the engine's own applyIdle) over 20 s: clipping at every sample + how far the hands move.
    const handIdx = (name: string) => {
      let best = -1, bw = 0;
      for (let v = 0; v < m.jointWeights.length / 4; v++) for (let k = 0; k < 4; k++) {
        if (m.jointNames[m.jointIndices[v * 4 + k]] === name && m.jointWeights[v * 4 + k] > bw) { bw = m.jointWeights[v * 4 + k]; best = v; }
      }
      return best;
    };
    const hands = { L: handIdx('hand_L'), R: handIdx('hand_R') };
    const box = { L: [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity], R: [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity] };
    let idleClip = 0;
    for (let t = 0; t <= 20; t += 0.5) {
      const pose = sampleIdlePose(m, t, 1, relaxedFit);
      const p = skinAll(m, r.geometry.vertices, m.jointIndices, m.jointWeights, pose, 'dualQuat');
      for (const side of ['L', 'R'] as const) for (let a = 0; a < 3; a++) {
        const v = hands[side];
        box[side][a * 2] = Math.min(box[side][a * 2], p.P[v * 3 + a]); box[side][a * 2 + 1] = Math.max(box[side][a * 2 + 1], p.P[v * 3 + a]);
      }
      const before = rows.length;
      doOne(`idle t=${t.toFixed(1)}s`, pose);
      if (rows.length > before && !rows[rows.length - 1].endsWith('clean')) idleClip++;
    }
    const span = (b: number[]) => `x ${((b[1] - b[0]) * 100).toFixed(1)} · y ${((b[3] - b[2]) * 100).toFixed(1)} · z ${((b[5] - b[4]) * 100).toFixed(1)} cm`;
    rows.push(`IDLE: ${idleClip} clipping samples; hand travel L ${span(box.L)} | R ${span(box.R)}`);
    // Contact sheets: POSE_SHEET=clipName (or 'idle') → one image of the motion, every POSE_SHEET_STEP frames.
    if (process.env.POSE_SHEET) {
      const step = Number(process.env.POSE_SHEET_STEP ?? 4), name = process.env.POSE_SHEET;
      const clip = buildDefaultClips(joints).find((c) => c.name === name);
      const frames: Float32Array[] = [];
      const end = clip ? clip.endFrame : 240;
      for (let f = 0; f <= end; f += step) {
        const pose = clip ? sampleDefaultClip(m, name, f, relaxedFit) : sampleIdlePose(m, f / 24, 1, relaxedFit);
        frames.push(skinAll(m, r.geometry.vertices, m.jointIndices, m.jointWeights, pose, 'dualQuat').P);
      }
      const view = process.env.POSE_SHEET_VIEW ? JSON.parse(process.env.POSE_SHEET_VIEW) : undefined;
      fs.writeFileSync(path.join(dir, `sheet_${name.replace(/[^a-z0-9]+/gi, '_')}.png`), renderFramesPNG(frames, m.indices, view));
    }
    fs.writeFileSync(path.join(dir, 'report.txt'), rows.join('\n'));
    expect(rows.length).toBeGreaterThan(0);
  }, 300_000);
});
