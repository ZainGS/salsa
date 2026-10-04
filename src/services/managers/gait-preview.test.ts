/**
 * GAIT / PLAY-ANIMATION PREVIEW report (visual-polish item 13) — what Play's engine locomotion draws, rendered on the
 * CPU for several dressed bodies, as contact sheets + numbers. Runs only with GAIT_PREVIEW=<dir>:
 *   GAIT_PREVIEW=out npx vitest run src/services/managers/gait-preview.test.ts
 * (GAIT_ONLY=skirt,jacket limits the characters; GAIT_TILE=<px> sets the tile size; GAIT_SHEETS=walk,run limits the sheets;
 * GAIT_VIEW=side|front keeps one view; GAIT_NAKED=1 draws the body only, to read the legs.)
 *
 * It drives the REAL Play chain on a scripted input timeline: CharacterController → LocomotionAnimator + LocomotionLean
 * → composeLocomotionPose / applyLocomotionLean (locomotion-pose.ts, the code Scene3DManager runs per tick) over the
 * runtime default clips (default-locomotion.ts, fitted to the body's arm clearance as Play does), skins the body and its
 * garments (garments drawn RED, the skirt steered per frame with the engine's own follow-through dynamics), and renders
 * idle / walk / run / turn / sneak / jump sheets. report.txt lists foot slide in stance, pelvis bob, arm-to-torso
 * clearance and the jump timeline.
 */
import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import { bodyFor, CONFIGS, skinAll, grid } from './clothing-audit-harness';
import { generateTop, generateBottom, generateShoe, defaultTopParams, defaultBottomParams, defaultShoeParams } from './clothing-generator';
import { buildLocomotionClips, playArmClearance, LOCOMOTION_CLIP, JUMP_VARIANT_CLIPS } from './default-locomotion';
import { relaxedStance } from './pose-authoring';
import { resolveArmClearance, withGarments } from './arm-clearance';
import { posedJointWorld, type PoseRotations, type SkinnedMeshData } from './skin-deform-metrics';
import { renderPosePNG, encodePNG, type View } from './pose-preview';
import { composeLocomotionPose, applyLocomotionLean, applyLocomotionSecondary, secondaryInputFor } from './locomotion-pose';
import { CharacterController, NO_INPUT, PLAY_JUMP_WINDUP, type CharacterInput } from '../../game/character-controller';
import { LocomotionAnimator, LocomotionLean, LocomotionSecondary, seedFromString } from '../../game/locomotion-animator';
import type { LocomotionClips } from '../../game/locomotion';
import type { SkeletonPose } from '../../renderer/3d/skeleton-animator';
import { skirtSteerSignal, steerSkirtWeights, SkirtFollow, type SkirtSteer } from './skirt-steer';

type Q = [number, number, number, number];
interface Char { tag: string; body: Record<string, number>; top: Record<string, unknown>; bottom: Record<string, unknown> }
const CHARS: Char[] = [
    { tag: 'skirt', body: {}, top: { sleeveLength: 0.25 }, bottom: { bottomStyle: 'skirt', length: 0.95, flare: 1.45 } },
    { tag: 'trousers', body: { hipWidth: 1.1 }, top: { sleeveLength: 1 }, bottom: { bottomStyle: 'pants', length: 1.0 } },
    { tag: 'jacket', body: { torsoThick: 1.3 }, top: { sleeveLength: 1, thickness: 0.045, sleeveCap: 0.4, hemHeight: 0.05 }, bottom: { bottomStyle: 'pants', length: 1.05, stack: 0.7, waistWidth: 1.1 } },
    { tag: 'mini', body: { limbThick: 1.2, torsoThick: 1.15 }, top: { sleeveLength: 0 }, bottom: { bottomStyle: 'skirt', length: 0.3, flare: 1.9 } },
];

/** The scripted Play session (60 Hz): [start s, input, gait]. */
type Seg = { t: number; in: Partial<CharacterInput>; running?: boolean; sneaking?: boolean };
const SCRIPT: Seg[] = [
    { t: 0, in: {} },
    { t: 1.2, in: { forward: 1 }, running: false },
    { t: 3.4, in: { forward: 1 }, running: true },
    { t: 5.4, in: {} },
    { t: 6.2, in: { jump: true } },
    { t: 6.55, in: {} },
    { t: 7.6, in: { forward: 1 }, running: true },
    { t: 8.6, in: { forward: -1 }, running: true },     // a 180° pivot at a run
    { t: 9.6, in: {} },
    { t: 10.2, in: { forward: 1 }, sneaking: true },
    { t: 12.0, in: {}, sneaking: false },
    // Jump session (2026-10-03, from 19 s): standing holds + taps, walking, running; then a walk-run-stop.
    ...[0, 1, 2, 3].flatMap((k) => [{ t: 19 + k * 1.2, in: { jump: true } }, { t: 19 + k * 1.2 + (k % 2 ? 0.03 : 0.4), in: {} }]),
    { t: 23.8, in: { forward: 1 }, running: false },
    ...[0, 1, 2, 3].flatMap((k) => [{ t: 24.6 + k * 1.1, in: { forward: 1, jump: true } }, { t: 24.6 + k * 1.1 + (k === 2 ? 0.03 : 0.4), in: { forward: 1 } }]),
    { t: 29.0, in: { forward: 1 }, running: true },
    ...[0, 1, 2, 3].flatMap((k) => [{ t: 29.8 + k * 1.1, in: { forward: 1, jump: true }, running: true }, { t: 29.8 + k * 1.1 + (k === 1 ? 0.03 : 0.4), in: { forward: 1 }, running: true }]),
    { t: 34.4, in: {}, running: false },
    { t: 35.4, in: { forward: 0.45 } },                 // a half-tilted stick: the stroll
    { t: 37.0, in: {} },
    { t: 38.0, in: { forward: 0.65 }, running: true }, // 2026-10-04: 65 % stick at a run ≈ 3.4 m/s, the JOG
    { t: 41.0, in: {}, running: false },
];
const END = 42;
/** The jump-session window per context (for the per-jump report and sheets). */
const JUMPS_AT = { stand: [19, 23.8], walk: [24.6, 29], run: [29.8, 34.4] } as const;
/** Sheets: [name, from s, to s, every n ticks, view]. */
const SIDE: View = { label: 'side', yaw: 90, pitch: 4, cy: 0.95, h: 2.05 };
const FRONT: View = { label: 'front', yaw: 0, pitch: 4, cy: 0.95, h: 2.05 };
const Q34: View = { label: '3/4', yaw: 35, pitch: 8, cy: 0.95, h: 2.05 };
const SHEETS: [string, number, number, number, View[]][] = [
    ['idle', 12.6, 19, 12, [FRONT, { label: 'upper 3/4', yaw: 30, pitch: 6, cy: 1.2, h: 0.9 }]],
    ['walk', 2.4, 3.36, 4, [SIDE, FRONT]],
    ['run', 4.6, 5.32, 2, [SIDE, FRONT]],
    ['stop', 5.38, 6.1, 4, [SIDE, Q34]],
    ['jump', 6.15, 7.1, 2, [SIDE, Q34]],
    ['turn', 8.5, 9.1, 2, [{ label: '3/4', yaw: 50, pitch: 20, cy: 0.95, h: 2.05 }]],
    ['sneak', 10.9, 12.0, 4, [SIDE, FRONT]],
    ['jumps-stand', 19, 23.8, 4, [{ label: 'side', yaw: 90, pitch: 4, cy: 1.3, h: 2.9 }]],
    ['jumps-walk', 24.55, 29, 4, [{ label: 'side', yaw: 90, pitch: 4, cy: 1.3, h: 2.9 }]],
    ['jumps-run', 29.75, 34.4, 4, [{ label: 'side', yaw: 90, pitch: 4, cy: 1.3, h: 2.9 }]],
    ['stroll', 35.9, 37.6, 4, [SIDE, FRONT]],
    ['jog', 39.6, 40.4, 2, [SIDE, FRONT]],
];

function rotY(P: Float32Array, yaw: number, t: [number, number, number] = [0, 0, 0]): Float32Array {
    const c = Math.cos(yaw), s = Math.sin(yaw), out = new Float32Array(P.length);
    for (let i = 0; i < P.length; i += 3) { const x = P[i], z = P[i + 2]; out[i] = c * x + s * z + t[0]; out[i + 1] = P[i + 1] + t[1]; out[i + 2] = -s * x + c * z + t[2]; }
    return out;
}

describe.skipIf(!process.env.GAIT_PREVIEW)('gait preview report', () => {
    it('renders Play locomotion sheets for dressed bodies', async () => {
        const fs = await import('node:fs'), path = await import('node:path'), zlib = await import('node:zlib');
        const dir = process.env.GAIT_PREVIEW!; fs.mkdirSync(dir, { recursive: true });
        const only = process.env.GAIT_ONLY?.split(',');
        const rows: string[] = [];
        for (const ch of CHARS) {
            if (only && !only.includes(ch.tag)) continue;
            const { r, m, fit } = bodyFor(CONFIGS[0], ch.body);
            const topP = { ...defaultTopParams(), ...ch.top } as never, botP = { ...defaultBottomParams(), ...ch.bottom } as never, shoeP = defaultShoeParams();
            const garments = [generateTop(fit, topP), generateBottom(fit, botP, shoeP), generateShoe(fit, shoeP)];
            const steer = (garments[1] as { skirtSteer?: SkirtSteer }).skirtSteer ?? null;
            const gJi = garments.map((g) => Uint8Array.from(g.jointIndices)), gJw = garments.map((g) => Float32Array.from(g.jointWeights));
            // The Play rest pose: the relaxed stance, arms fitted to THIS body (the engine's clearArmsForSkeleton).
            const relaxed = new Map(Object.entries(relaxedStance()).map(([k, v]) => [k, [...v] as Q]));
            const rot = new Map(m.jointNames.map((n) => [n, relaxed.get(n) ?? [0, 0, 0, 1] as Q]));
            const fittedBody = resolveArmClearance(m, new Map(rot), 'dualQuat');
            // Play fits the gait arms on the body + its TOP (sleeves / forearms vs the top's torso panel) — the engine's _playArmClearance.
            const fitted = resolveArmClearance(withGarments(m, [{ vertices: garments[0].geometry.vertices, indices: garments[0].geometry.indices, jointIndices: garments[0].jointIndices, jointWeights: garments[0].jointWeights }]), new Map(rot), 'dualQuat');
            resolveArmClearance(m, rot, 'dualQuat');   // the rest pose: the body-only fit (clearArmsForSkeleton)
            const restPose: SkeletonPose = {
                rotations: m.jointNames.map((n) => [...rot.get(n)!] as Q),
                positions: m.jointNames.map((_, j) => [m.jointLocalPositions[j * 3], m.jointLocalPositions[j * 3 + 1], m.jointLocalPositions[j * 3 + 2]] as [number, number, number]),
                scales: m.jointNames.map(() => [1, 1, 1] as [number, number, number]),
            };
            const joints = m.jointNames.map((name, j) => ({ name, localPosition: [m.jointLocalPositions[j * 3], m.jointLocalPositions[j * 3 + 1], m.jointLocalPositions[j * 3 + 2]] }));
            const clearance = playArmClearance(fitted);
            // As Play's default gait: fitted arms, the walking personality seeded by the character (GAIT_SEED overrides),
            // jump variety, the stroll, and the secondary motion (GAIT_LOOSE = looseness; 0 = the clips exactly).
            const seedId = process.env.GAIT_SEED ?? ch.tag;
            const clips = buildLocomotionClips(joints, { armClearance: clearance, variation: process.env.GAIT_NOVARY ? null : seedId });
            const byName = new Map(clips.map((c) => [c.name, c]));
            const slots: LocomotionClips = { idle: byName.has(LOCOMOTION_CLIP.idle) ? LOCOMOTION_CLIP.idle : '__rest__', walk: 'Walk', run: 'Run', sneak: 'Sneak', crouch: 'Crouch', jump: 'Jump', fall: 'Fall', land: 'Land',
                ...(process.env.GAIT_NOVARIETY ? {} : { jumps: JUMP_VARIANT_CLIPS.filter((n) => byName.has(n)) }), ...(process.env.GAIT_NOSTROLL ? {} : { stroll: 'Stroll' }),
                ...(process.env.GAIT_NOJOG || !byName.has('Jog') ? {} : { jog: 'Jog' }) };
            const clipFor = (n: string) => byName.get(n) ?? (n === '__rest__' ? { id: n, name: n, startFrame: 0, endFrame: 24, fps: 24, tracks: [] } : null);
            const secs = (n: string) => { const c = clipFor(n); return c ? Math.max((c.endFrame - c.startFrame) / Math.max(c.fps, 1), 1 / 60) : 0; };

            const cc = new CharacterController({ cameraMode: 'third', jumpWindup: PLAY_JUMP_WINDUP });
            const anim = new LocomotionAnimator({ jumpSeed: seedFromString(seedId) }), lean = new LocomotionLean(), follow = new SkirtFollow();
            const second = new LocomotionSecondary({ looseness: process.env.GAIT_LOOSE !== undefined ? Number(process.env.GAIT_LOOSE) : 0.5 }, seedFromString(seedId));
            const ac = anim.cfg;
            ac.walkSpeed = cc.walkTopSpeed(); ac.runSpeed = Math.max(cc.cfg.moveSpeed, ac.walkSpeed + 1e-3);
            ac.walkClipSpeed = byName.get('Walk')?.groundSpeed ?? null; ac.runClipSpeed = byName.get('Run')?.groundSpeed ?? null;
            ac.sneakClipSpeed = byName.get('Sneak')?.groundSpeed ?? cc.cfg.sneakSpeed;
            ac.jumpTakeoff = byName.get('Jump')?.takeoffPhase ?? 0;
            ac.strollClipSpeed = byName.get('Stroll')?.groundSpeed ?? null;
            ac.jogClipSpeed = byName.get('Jog')?.groundSpeed ?? null;
            const jumpsPicked: { t: number; clip: string; ctx: string; held: boolean }[] = [];
            let lastJumpCount = 0;
            const dt = 1 / 60;
            const frames: { t: number; body: Float32Array; parts: Float32Array[]; pos: [number, number, number]; facing: number; feet: { L: number[]; R: number[] }; contact: { L: number[][]; R: number[][] }; hipsY: number; state: string; armGap: number; poke: number; phase: number; runMix: number; jogMix: number; thigh: number; handY: number; elbowZ: number; speed: number }[] = [];
            // The foot's CONTACT point (2026-10-03): the lower of the heel and the ball (the rig's rocker points, scaled by
            // its leg length) — a rolling foot's ankle moves while the contact point rolls heel → toe and stays put.
            const legL = Math.hypot(...[1, 2].map((a) => m.jointLocalPositions[m.jointNames.indexOf('lowerleg_L') * 3 + a])) + Math.hypot(...[1, 2].map((a) => m.jointLocalPositions[m.jointNames.indexOf('foot_L') * 3 + a]));
            const kFoot = legL / 0.84, HEEL = [0, -0.07 * kFoot, -0.045 * kFoot], BALL = [0, -0.07 * kFoot, 0.15 * kFoot];
            // Body verts INSIDE the bottom garment at rest (the clothing harness's poke-through measure, per frame).
            const covered: number[] = [];
            {
                const bR = skinAll(m, r.geometry.vertices, m.jointIndices, m.jointWeights, [], 'dualQuat'), gR = skinAll(m, garments[1].geometry.vertices, gJi[1], gJw[1], [], 'dualQuat');
                const near = grid(gR.P);
                for (let b = 0; b < bR.P.length / 3; b++) {
                    const gi = near(bR.P[b * 3], bR.P[b * 3 + 1], bR.P[b * 3 + 2], 0.15); if (gi < 0) continue;
                    const d = (bR.P[b * 3] - gR.P[gi * 3]) * gR.N[gi * 3] + (bR.P[b * 3 + 1] - gR.P[gi * 3 + 1]) * gR.N[gi * 3 + 1] + (bR.P[b * 3 + 2] - gR.P[gi * 3 + 2]) * gR.N[gi * 3 + 2];
                    if (d < 0) covered.push(b);
                }
            }
            const footIdx = { L: m.jointNames.indexOf('foot_L'), R: m.jointNames.indexOf('foot_R') };
            const hipsIdx = m.jointNames.indexOf('hips');
            let jumpLog = '';
            let dbgMax = 0, dbgDiff = 0;
            for (let i = 0; i <= END * 60; i++) {
                const t = i * dt;
                let seg = SCRIPT[0];
                for (const s of SCRIPT) if (t >= s.t) seg = s;
                if (seg.running !== undefined) cc.running = seg.running;
                if (seg.sneaking !== undefined) cc.sneaking = seg.sneaking;
                cc.update(dt, { ...NO_INPUT, ...seg.in });
                const loco = cc.locomotion();
                const layers = anim.update(dt, loco, slots, secs, clipFor);
                const pose = composeLocomotionPose(layers, clipFor, restPose);
                applyLocomotionLean(m.jointNames, pose, lean.update(dt, cc.vel[0], cc.vel[2], cc.facing, cc.cfg.moveSpeed, cc.grounded, cc.turnRemaining()));
                if (second.cfg.looseness > 0) applyLocomotionSecondary(m.jointNames, pose, second.update(dt, secondaryInputFor(anim, lean.accel, cc.grounded)));
                if (anim.jumpCount !== lastJumpCount) { lastJumpCount = anim.jumpCount; jumpsPicked.push({ t, clip: anim.jumpClip ?? '?', ctx: anim.smoothedSpeed > 3 ? 'run' : anim.smoothedSpeed > 0.5 ? 'walk' : 'stand', held: loco.jumpHeld !== false }); }
                else if (jumpsPicked.length && t - jumpsPicked[jumpsPicked.length - 1].t < 0.2 && anim.jumpClip && !jumpsPicked[jumpsPicked.length - 1].clip.endsWith(anim.jumpClip) && !jumpsPicked[jumpsPicked.length - 1].clip.includes('(tap')) { const j = jumpsPicked[jumpsPicked.length - 1]; j.clip = j.clip + ' -> ' + anim.jumpClip + ' (tap re-pick)'; j.held = false; }
                if (t >= 6.15 && t <= 7.1 && i % 3 === 0) jumpLog += `${(t - 6.2).toFixed(2)}s ${anim.state} y=${cc.pos[1].toFixed(2)} ` + (i % 12 === 0 ? '\n   ' : '');
                if (i % 2 !== 0) continue;
                // Skin every 2nd tick (30 fps).
                const mf: SkinnedMeshData = { ...m, jointLocalPositions: Float32Array.from(pose.positions.flat()) };
                const pr: PoseRotations = m.jointNames.map((joint, j) => ({ joint, q: pose.rotations[j] }));
                const world = posedJointWorld(mf, pr);
                const skin = new Float32Array(world.length * 16);
                world.forEach((w, j) => skin.set(mat4.multiply(mat4.create(), w, m.inverseBindMatrices.subarray(j * 16, j * 16 + 16) as unknown as mat4), j * 16));
                if (steer) { const raw = skirtSteerSignal(skin, steer), v = follow.update(raw, 2 * dt); dbgMax = Math.max(dbgMax, Math.abs(raw), 0); dbgDiff = Math.max(dbgDiff, Math.abs(v - raw)); steerSkirtWeights(steer, process.env.GAIT_NOFOLLOW || follow.settled(raw) ? raw : v, gJi[1], gJw[1]); }
                const wantFrame = SHEETS.some(([, a, b]) => t >= a - 1e-6 && t <= b + 1e-6) || (t > 1.6 && t < 5.4) || (t > 23.8 && t < 24.6) || (t > 35.4 && t < 37.6) || (t > 39 && t < 40.6);
                if (!wantFrame) continue;
                const body = skinAll(mf, r.geometry.vertices, m.jointIndices, m.jointWeights, pr, 'dualQuat').P;
                const skinned = garments.map((g, gi) => skinAll(mf, g.geometry.vertices, gJi[gi], gJw[gi], pr, 'dualQuat'));
                const parts = skinned.map((x) => x.P);
                let poke = 0;
                { const gP = skinned[1], near = grid(gP.P);
                  for (const b of covered) { const x = body[b * 3], y = body[b * 3 + 1], z = body[b * 3 + 2]; const gi = near(x, y, z, 0.15); if (gi < 0) continue;
                    if ((x - gP.P[gi * 3]) * gP.N[gi * 3] + (y - gP.P[gi * 3 + 1]) * gP.N[gi * 3 + 1] + (z - gP.P[gi * 3 + 2]) * gP.N[gi * 3 + 2] > 0.003) poke++; } }
                const fw = (j: number) => { const p = rotY(new Float32Array([world[j][12], world[j][13], world[j][14]]), cc.facing, cc.pos); return [p[0], p[1], p[2]]; };
                // Arm gap: the smallest horizontal distance from a forearm (lowerarm → hand midpoint) to the chest centre line.
                const jw = (n: string) => world[m.jointNames.indexOf(n)];
                const gap = Math.min(...(['L', 'R'] as const).map((s) => { const a = jw(`lowerarm_${s}`), b = jw(`hand_${s}`), c = jw('spine'); return Math.hypot((a[12] + b[12]) / 2 - c[12], (a[14] + b[14]) / 2 - c[14]); }));
                const cp = (j: number) => {
                    const M = world[j];
                    const at = (o: number[]) => rotY(new Float32Array([M[0] * o[0] + M[4] * o[1] + M[8] * o[2] + M[12], M[1] * o[0] + M[5] * o[1] + M[9] * o[2] + M[13], M[2] * o[0] + M[6] * o[1] + M[10] * o[2] + M[14]]), cc.facing, cc.pos);
                    const h = at(HEEL), b = at(BALL);
                    return [[h[0], h[1], h[2]], [b[0], b[1], b[2]]];
                };
                // 2026-10-04: knee drive (the most-forward thigh, deg from vertical, body frame), the higher hand vs its
                // shoulder (m) and the elbow furthest behind the chest (m) — the run's energy numbers.
                const thighFwd = Math.max(...(['L', 'R'] as const).map((s) => { const a = jw(`upperleg_${s}`), b = jw(`lowerleg_${s}`); return Math.atan2(b[14] - a[14], a[13] - b[13]) * 180 / Math.PI; }));
                const handY = Math.max(...(['L', 'R'] as const).map((s) => jw(`hand_${s}`)[13] - jw(`shoulder_${s}`)[13]));
                const elbowZ = Math.min(...(['L', 'R'] as const).map((s) => jw(`lowerarm_${s}`)[14] - jw('chest')[14]));
                frames.push({ t, body, parts, pos: [cc.pos[0], cc.pos[1], cc.pos[2]], facing: cc.facing, feet: { L: fw(footIdx.L), R: fw(footIdx.R) }, contact: { L: cp(footIdx.L), R: cp(footIdx.R) }, hipsY: world[hipsIdx][13] + cc.pos[1], state: anim.state, armGap: gap, poke, phase: anim.gaitPhase, runMix: anim.runMix, jogMix: anim.jogMix, thigh: thighFwd, handY, elbowZ, speed: Math.hypot(cc.vel[0], cc.vel[2]) });
            }
            // ── Sheets ──
            const merge = (f: typeof frames[number], root: boolean) => {
                const naked = !!process.env.GAIT_NAKED;   // GAIT_NAKED=1: the body only (to read the legs)
                const all = [f.body, ...(naked ? [] : f.parts)];
                const n = all.reduce((a, p) => a + p.length, 0);
                const P = new Float32Array(n);
                let o = 0; for (const p of all) { P.set(p, o); o += p.length; }
                const idx: number[] = []; const col = new Uint8Array(n);
                const TINT = [[226, 190, 168], [70, 110, 200], [205, 70, 70], [60, 60, 60]];   // skin · top · bottom · shoes
                let base = 0;
                [r.geometry.indices, ...(naked ? [] : garments.map((g) => g.geometry.indices))].forEach((ind, k) => {
                    for (let q = 0; q < ind.length; q++) idx.push(ind[q] + base);
                    const cnt = all[k].length / 3;
                    for (let v = 0; v < cnt; v++) col.set(TINT[k], (base + v) * 3);
                    base += cnt;
                });
                return { P: root ? rotY(P, f.facing, [0, f.pos[1], 0]) : P, idx: Uint32Array.from(idx), col };
            };
            const tile = Number(process.env.GAIT_TILE) || 240;   // GAIT_TILE=<px> renders bigger tiles
            const sheetsOnly = process.env.GAIT_SHEETS?.split(',');
            for (const [name, a, b, every, allViews] of SHEETS) {
                if (sheetsOnly && !sheetsOnly.includes(name)) continue;
                // GAIT_VIEW=side / front: that view only (when the sheet has it).
                const views = allViews.filter((v) => !process.env.GAIT_VIEW || v.label === process.env.GAIT_VIEW).length ? allViews.filter((v) => !process.env.GAIT_VIEW || v.label === process.env.GAIT_VIEW) : allViews;
                const sel = frames.filter((f) => f.t >= a - 1e-6 && f.t <= b + 1e-6).filter((_, k) => k % Math.max(1, every / 2) === 0);
                if (!sel.length) continue;
                const tw = tile * views.length, cols = Math.max(1, Math.floor(1920 / tw));
                const rowsN = Math.ceil(sel.length / cols), W = tw * cols, H = tile * rowsN;
                const out = new Uint8Array(W * H * 3).fill(240);
                sel.forEach((f, k) => {
                    const g = merge(f, true);
                    const rgb = decode(renderPosePNG(g.P, g.idx, new Set(), views, tile, g.col), zlib);
                    const ox = (k % cols) * tw, oy = Math.floor(k / cols) * tile;
                    for (let y = 0; y < tile; y++) out.set(rgb.subarray(y * tw * 3, (y + 1) * tw * 3), ((oy + y) * W + ox) * 3);
                });
                fs.writeFileSync(path.join(dir, `${ch.tag}-${name}.png`), encodePNG(W, H, out));
            }
            // ── The jump VARIANTS side by side (2026-10-03): one row per variant, wind-up → take-off → apex → landing. ──
            if (!sheetsOnly || sheetsOnly.includes('jump-variants')) {
                const PH = [0.1, 0.2, 0.3, 0.42, 0.55, 0.68, 0.82, 1.0];
                const view: View = { label: 'side', yaw: 70, pitch: 6, cy: 1.0, h: 2.3 };
                const names = JUMP_VARIANT_CLIPS.filter((n) => byName.has(n));
                const W = tile * PH.length, H = tile * names.length, out = new Uint8Array(W * H * 3).fill(240);
                names.forEach((n, row) => PH.forEach((ph, col) => {
                    const pose = composeLocomotionPose([{ clip: n, phase: ph, weight: 1 }], clipFor, restPose);
                    const mf: SkinnedMeshData = { ...m, jointLocalPositions: Float32Array.from(pose.positions.flat()) };
                    const pr: PoseRotations = m.jointNames.map((joint, j) => ({ joint, q: pose.rotations[j] }));
                    const body = skinAll(mf, r.geometry.vertices, m.jointIndices, m.jointWeights, pr, 'dualQuat').P;
                    const parts = garments.map((g, gi) => skinAll(mf, g.geometry.vertices, gJi[gi], gJw[gi], pr, 'dualQuat').P);
                    const g = merge({ t: 0, body, parts, pos: [0, 0, 0], facing: 0, feet: { L: [], R: [] }, contact: { L: [[0, 0, 0], [0, 0, 0]], R: [[0, 0, 0], [0, 0, 0]] }, hipsY: 0, state: '', armGap: 0, poke: 0, phase: 0, runMix: 0, jogMix: 0, thigh: 0, handY: 0, elbowZ: 0, speed: 0 }, false);
                    const rgb = decode(renderPosePNG(g.P, g.idx, new Set(), [view], tile, g.col), zlib);
                    for (let y = 0; y < tile; y++) out.set(rgb.subarray(y * tile * 3, (y + 1) * tile * 3), ((row * tile + y) * W + col * tile) * 3);
                }));
                fs.writeFileSync(path.join(dir, `${ch.tag}-jump-variants.png`), encodePNG(W, H, out));
                rows.push(`  jump variants sheet rows: ${names.join(', ')}`);
            }
            // ── Numbers ──
            const seg = (a: number, b: number) => frames.filter((f) => f.t >= a && f.t <= b);
            const slide = (fr: typeof frames, what: 'feet' | 'contact' = 'contact') => {
                // Stance = the point within 1.5 cm (contact points: 0.6 cm) of its lowest height in the segment; slide =
                // its horizontal speed there. 'contact' (2026-10-03) = the heel and the ball, each measured while IT is
                // down (the planted points of a foot rolling heel → toe), time-weighted; 'feet' = the ankle joint (the
                // old measure: the ankle swings forward over a rolling foot, which reads as slide).
                const out: string[] = [];
                for (const s of ['L', 'R'] as const) {
                    const pts = what === 'contact' ? [0, 1].map((k) => fr.map((f) => f.contact[s][k])) : [fr.map((f) => f.feet[s])];
                    const tol = what === 'contact' ? 0.006 : 0.015;
                    const lows = pts.map((P) => Math.min(...P.map((p) => p[1])));
                    let d = 0, tt = 0, down = 0;
                    pts.forEach((P, i) => {
                        for (let k = 1; k < P.length; k++) {
                            const p = P[k - 1], q = P[k];
                            if (p[1] < lows[i] + tol && q[1] < lows[i] + tol) { d += Math.hypot(q[0] - p[0], q[2] - p[2]); tt += fr[k].t - fr[k - 1].t; }
                        }
                    });
                    for (let k = 1; k < fr.length; k++) if (pts.some((P, i) => P[k][1] < lows[i] + tol && P[k - 1][1] < lows[i] + tol)) down += fr[k].t - fr[k - 1].t;
                    out.push(`${s} ${(tt > 0 ? d / tt : 0).toFixed(3)} m/s over ${down.toFixed(2)} s`);
                }
                return out.join(', ');
            };
            // Pelvis height vs GAIT PHASE (0 = left heel strike): 10 bins, cm relative to the segment's mean — the bob's
            // phase (walk: highest at mid-stance, ≈ duty / 2 and + 0.5; run: lowest there, highest mid-flight).
            const bobPhase = (fr: typeof frames) => {
                const bins = Array.from({ length: 10 }, () => [] as number[]);
                for (const f of fr) bins[Math.min(9, Math.floor(f.phase * 10))].push(f.hipsY);
                const mean = fr.reduce((a, f) => a + f.hipsY, 0) / Math.max(1, fr.length);
                return bins.map((b, i) => `${(i / 10).toFixed(1)}:${b.length ? ((b.reduce((a, x) => a + x, 0) / b.length - mean) * 100).toFixed(1) : '-'}`).join(' ');
            };
            // Flight: the fraction of the segment with BOTH contact points > 1 cm above the ground (the segment's lowest).
            const flight = (fr: typeof frames) => {
                const lowOf = (f: typeof frames[number], s: 'L' | 'R') => Math.min(f.contact[s][0][1], f.contact[s][1][1]);
                const low = Math.min(...fr.flatMap((f) => [lowOf(f, 'L'), lowOf(f, 'R')]));
                const air = fr.filter((f) => lowOf(f, 'L') > low + 0.01 && lowOf(f, 'R') > low + 0.01).length;
                const rise = (Math.max(...fr.map((f) => f.hipsY)) - Math.min(...fr.map((f) => f.hipsY))) * 100;
                return `${(100 * air / Math.max(1, fr.length)).toFixed(0)} % of frames airborne (both feet > 1 cm up), pelvis range ${rise.toFixed(1)} cm`;
            };
            const energy = (fr: typeof frames) => {
                const sp = fr.reduce((a, f) => a + f.speed, 0) / Math.max(1, fr.length), jm = fr.reduce((a, f) => a + f.jogMix, 0) / Math.max(1, fr.length);
                return `speed ${sp.toFixed(2)} m/s (jog mix ${jm.toFixed(2)}); knee drive ${Math.max(...fr.map((f) => f.thigh)).toFixed(0)}°; hand max ${(Math.max(...fr.map((f) => f.handY)) * 100).toFixed(1)} cm vs shoulder; elbow back ${(-Math.min(...fr.map((f) => f.elbowZ)) * 100).toFixed(1)} cm behind the chest`;
            };
            const bob = (fr: typeof frames) => { const y = fr.map((f) => f.hipsY); return ((Math.max(...y) - Math.min(...y)) * 100).toFixed(1) + ' cm'; };
            const gap = (fr: typeof frames) => (Math.min(...fr.map((f) => f.armGap)) * 100).toFixed(1) + ' cm';
            rows.push(`── ${ch.tag}: arm clearance fit body L ${fittedBody.L.toFixed(1)}° R ${fittedBody.R.toFixed(1)}° · body+top L ${fitted.L.toFixed(1)}° R ${fitted.R.toFixed(1)}° → gait arm offset ${clearance.toFixed(1)}°`);
            rows.push(`  walk: foot slide ${slide(seg(2.2, 3.36))} (ankle joint: ${slide(seg(2.2, 3.36), 'feet')}); pelvis bob ${bob(seg(2.4, 3.36))}; min forearm–spine ${gap(seg(2.4, 3.36))}`);
            rows.push(`  walk pelvis vs phase (cm): ${bobPhase(seg(2.2, 3.36))}`);
            rows.push(`  run:  foot slide ${slide(seg(4.4, 5.32))} (ankle joint: ${slide(seg(4.4, 5.32), 'feet')}); pelvis bob ${bob(seg(4.6, 5.32))}; min forearm–spine ${gap(seg(4.6, 5.32))}`);
            rows.push(`  run pelvis vs phase (cm):${bobPhase(seg(4.4, 5.32))}; flight: ${flight(seg(4.4, 5.32))}`);
            rows.push(`  run energy: ${energy(seg(4.4, 5.32))}; clip ground speeds walk ${ac.walkClipSpeed?.toFixed(2)} jog ${ac.jogClipSpeed?.toFixed(2)} run ${ac.runClipSpeed?.toFixed(2)} m/s`);
            rows.push(`  steer: ${steer ? steer.vert.length : 0} verts, max |signal| ${dbgMax.toFixed(2)}, max follow lag ${dbgDiff.toFixed(2)}`);
            rows.push(`  sneak: foot slide ${slide(seg(10.9, 12))}`);
            const pk = (fr: typeof frames) => (fr.reduce((a, f) => a + f.poke, 0) / Math.max(1, fr.length)).toFixed(1);
            rows.push(`  bottom poke-through (body verts outside it, mean / frame of ${covered.length} covered): walk ${pk(seg(2.4, 3.36))}, run ${pk(seg(4.6, 5.32))}, sneak ${pk(seg(10.9, 12))}`);
            rows.push(`  jump (t from the press): ${jumpLog}`);
            rows.push(`  walk-in (23.8-24.6 s, no jump): foot slide ${slide(seg(24.0, 24.6))}`);
            rows.push(`  stroll (45 % stick, 35.9-37 s): foot slide ${slide(seg(35.9, 37))}; pelvis bob ${bob(seg(35.9, 37))}; poke-through ${pk(seg(35.9, 37))}`);
            rows.push(`  jog (65 % stick at a run, 39.2-40.4 s): foot slide ${slide(seg(39.2, 40.4))}; flight: ${flight(seg(39.2, 40.4))}; ${energy(seg(39.2, 40.4))}; poke-through ${pk(seg(39.2, 40.4))}`);
            rows.push(`  jump session (${jumpsPicked.length} jumps; seed '${seedId}'): ` + jumpsPicked.map((j) => `${j.t.toFixed(1)}s ${j.ctx}${j.held ? '' : ' TAP'} ${j.clip}`).join(' | '));
            const jpk = (k: keyof typeof JUMPS_AT) => pk(seg(JUMPS_AT[k][0], JUMPS_AT[k][1]));
            rows.push(`  jump poke-through (mean / frame): stand ${jpk('stand')}, walk ${jpk('walk')}, run ${jpk('run')}; max ${Math.max(...seg(19, 34.4).map((f) => f.poke))}`);
        }
        fs.writeFileSync(path.join(dir, 'report.txt'), rows.join('\n'));
        expect(rows.length).toBeGreaterThan(0);
    }, 600_000);
});

function decode(png: Uint8Array, zlib: typeof import('node:zlib')): Uint8Array {
    let o = 8, w = 0, h = 0; const data: Uint8Array[] = [];
    while (o < png.length) {
        const len = (png[o] << 24 | png[o + 1] << 16 | png[o + 2] << 8 | png[o + 3]) >>> 0, type = String.fromCharCode(...png.subarray(o + 4, o + 8));
        if (type === 'IHDR') { w = (png[o + 8] << 24 | png[o + 9] << 16 | png[o + 10] << 8 | png[o + 11]) >>> 0; h = (png[o + 12] << 24 | png[o + 13] << 16 | png[o + 14] << 8 | png[o + 15]) >>> 0; }
        if (type === 'IDAT') data.push(png.subarray(o + 8, o + 8 + len));
        o += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(data));
    const rgb = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) rgb.set(raw.subarray(y * (w * 3 + 1) + 1, (y + 1) * (w * 3 + 1)), y * w * 3);
    return rgb;
}
