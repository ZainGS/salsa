/**
 * Skirt / dress LEG-FOLLOW gate (polish-round-3 R6.3) — "walking in a dress makes the legs clip through it".
 *
 * CLIP = how deep the skinned skirt ends up INSIDE the legs. Each leg is two TAPERED capsules (thigh, shin) fitted to the
 * body's own skin (an inset core, so fabric resting on the skin isn't a clip) that move rigidly with their joint; every
 * posed skirt vertex AND triangle centroid (the rasterised face between verts) is tested against them.
 * TEAR = % of skirt triangles stretched > 2× their rest area or folded inside-out (skin-deform-metrics).
 * Poses = every frame of the default locomotion Walk + Run clips (default-locomotion.ts, read-only here) + a wide stride,
 * lunge, stair step, high knee, sit and side step. Weights are exactly what the runtime draws: the static leg-follow
 * weights, steered per pose by skirt-steer.ts (the per-frame character callback does the same).
 *   SKIRT_PRINT=out.txt npx vitest run src/services/managers/skirt-leg-follow.test.ts   → writes the before/after table
 */
import { describe, it, expect } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { bodyFor, skinAll, q, CONFIGS, type AuditConfig } from './clothing-audit-harness';
import { posedJointWorld, measureDeformation, type PoseRotations, type SkinnedMeshData } from './skin-deform-metrics';
import { buildLocomotionClips } from './default-locomotion';
import { generateBottom, clothingPreset, type BottomParams } from './clothing-generator';
import { skirtSteerSignal, steerSkirtWeights, type SkirtSteer } from './skirt-steer';
import { buildHemSwing, applyHemSwing, MAX_LAG, MAX_FLARE } from './skirt-swing';

type Pose = PoseRotations;
type Body = ReturnType<typeof bodyFor>;

/** Every frame of the default Walk / Run clips as a pose (rotation tracks only — the hips translation moves the whole
 *  body and can't change skirt-vs-leg clipping). */
function locomotionPoses(names: string[], localPos: Float32Array): Record<string, Pose> {
    const joints = names.map((name, i) => ({ name, localPosition: [localPos[i * 3], localPos[i * 3 + 1], localPos[i * 3 + 2]] as [number, number, number] }));
    const out: Record<string, Pose> = {};
    // SKIRT_VARY=<id>: the clips with that character's walking personality (gait variation, 2026-10-03).
    for (const clip of buildLocomotionClips(joints, { variation: process.env.SKIRT_VARY || null })) {
        for (let f = clip.startFrame; f < clip.endFrame; f++) {
            const pose: Pose = [];
            for (const t of clip.tracks) {
                if (t.channel !== 'rotation') continue;
                const k = t.keyframes.find((kf) => kf.frame === f);
                if (k) pose.push({ joint: names[t.jointIndex], q: k.value as number[] });
            }
            out[`${clip.name} f${f}`] = pose;
        }
    }
    return out;
}

/** Extra poses a dress has to survive (thigh forward = x−, knee bend = x+, leg L out = z+). */
const EXTRA_POSES: Record<string, Pose> = {
    'rest': [],
    'wide stride': [{ joint: 'upperleg_L', q: q('x', -45) }, { joint: 'lowerleg_L', q: q('x', 20) },
        { joint: 'upperleg_R', q: q('x', 35) }, { joint: 'lowerleg_R', q: q('x', 30) }],
    'lunge': [{ joint: 'upperleg_L', q: q('x', -70) }, { joint: 'lowerleg_L', q: q('x', 75) },
        { joint: 'upperleg_R', q: q('x', 25) }, { joint: 'lowerleg_R', q: q('x', 60) }],
    'stairs step': [{ joint: 'upperleg_L', q: q('x', -60) }, { joint: 'lowerleg_L', q: q('x', 70) }, { joint: 'upperleg_R', q: q('x', 8) }],
    'high knee': [{ joint: 'upperleg_L', q: q('x', -85) }, { joint: 'lowerleg_L', q: q('x', 100) }],
    'sit': [{ joint: 'upperleg_L', q: q('x', -90) }, { joint: 'upperleg_R', q: q('x', -90) },
        { joint: 'lowerleg_L', q: q('x', 90) }, { joint: 'lowerleg_R', q: q('x', 90) }],
    'side step': [{ joint: 'upperleg_L', q: q('z', 25) }, { joint: 'upperleg_R', q: q('z', -10) }],
};

/** The skirts measured: the two presets + a knee-length and an ankle-length dress skirt. */
const base = () => clothingPreset('bottom', 'Skirt') as BottomParams;
const SKIRTS: Record<string, BottomParams> = {
    'Skirt': base(),
    'Mini Skirt': clothingPreset('bottom', 'Mini Skirt') as BottomParams,
    'Knee dress': { ...base(), length: 1.0, flare: 1.5 },
    'Long dress': { ...base(), length: 1.7, flare: 1.7 },
};

/** A leg segment: a TAPERED capsule (radius r0 at pa → r1 at pb) that moves rigidly with joint `a`. */
interface Capsule { a: number; pa: vec3; pb: vec3; r0: number; r1: number; }

/** Penetration depth of p into a tapered capsule (> 0 = inside). */
function capsulePen(p: vec3, c: { pa: vec3; pb: vec3; r0: number; r1: number }): number {
    const ab = vec3.sub(vec3.create(), c.pb, c.pa), ap = vec3.sub(vec3.create(), p, c.pa);
    const t = Math.max(0, Math.min(1, vec3.dot(ap, ab) / Math.max(1e-9, vec3.dot(ab, ab))));
    return (c.r0 + (c.r1 - c.r0) * t) - vec3.distance(p, vec3.scaleAndAdd(vec3.create(), c.pa, ab, t));
}

/** Leg capsules (thigh + shin per side) in BIND space, fitted to the body's own skin: the verts a segment's joint
 *  dominates are split into the bone's two halves and each end's radius = 85% of that half's 25th-percentile distance to
 *  the bone (a core safely inside the skin — the inner thigh is flatter than the outer). The thigh starts 20% down: the
 *  hip joint sits inside the pelvis, under the waistband, where the skirt legitimately wraps it. */
function legCapsules(fit: Body['fit'], body: Body['r']): Capsule[] {
    const V = body.geometry.vertices, ji = body.skinning.jointIndices, jw = body.skinning.jointWeights;
    const out: Capsule[] = [];
    for (const s of ['L', 'R']) {
        const segs: [string, string, number, number][] = [[`upperleg_${s}`, `lowerleg_${s}`, 0.2, 1], [`lowerleg_${s}`, `foot_${s}`, 0, 0.9]];
        for (const [ja, jb, t0, t1] of segs) {
            const A = fit.joints[ja], B = fit.joints[jb];
            if (!A || !B) continue;
            const pa = vec3.lerp(vec3.create(), A.pos as vec3, B.pos as vec3, t0), pb = vec3.lerp(vec3.create(), A.pos as vec3, B.pos as vec3, t1);
            const ab = vec3.sub(vec3.create(), pb, pa), L2 = vec3.dot(ab, ab);
            const lo: number[] = [], hi: number[] = [];
            for (let v = 0; v < V.length / 12; v++) {
                let w = 0; for (let k = 0; k < 4; k++) if (ji[v * 4 + k] === A.idx) w += jw[v * 4 + k];
                if (w < 0.8) continue;
                const p = vec3.fromValues(V[v * 12], V[v * 12 + 1], V[v * 12 + 2]);
                const t = vec3.dot(vec3.sub(vec3.create(), p, pa), ab) / L2;
                if (t < 0 || t > 1) continue;
                (t < 0.5 ? lo : hi).push(-capsulePen(p, { pa, pb, r0: 0, r1: 0 }));   // distance to the bone
            }
            const q25 = (a: number[]) => { a.sort((x, y) => x - y); return a[Math.floor(a.length * 0.25)] ?? A.radius * 0.5; };
            out.push({ a: A.idx, pa, pb, r0: 0.85 * q25(lo), r1: 0.85 * q25(hi) });
        }
    }
    return out;
}

interface Report { clipMm: number; clipPose: string; tearPct: number; tearPose: string; foldPct: number; perPose: Record<string, { clipMm: number; tearPct: number; foldPct: number }>; }

/** Clip + tear of one skirt over a pose set, with the runtime steer applied (unless `steer` is false). */
function measureSkirt(body: Body, cfg: AuditConfig, p: BottomParams, poses: Record<string, Pose>, steer = true, swing?: [number, number, number]): Report {
    const { r, m, fit } = body;
    const g = generateBottom(fit, p);
    if (swing) {   // fit round 2: the hem swing's offset (skirt-swing.ts) at a fixed lag / flare, written into the rest verts
        const V = g.geometry.vertices, hips = fit.joints['hips']!;
        let top = -Infinity, bot = Infinity; for (let i = 1; i < V.length; i += 12) { top = Math.max(top, V[i]); bot = Math.min(bot, V[i]); }
        const d = buildHemSwing(V, [hips.pos[0], top, hips.pos[2]], bot, hips.idx);
        if (d) applyHemSwing(d, swing[0], swing[1], swing[2], V);
    }
    const st = (g as { skirtSteer?: SkirtSteer }).skirtSteer;
    const caps = legCapsules(fit, r);
    const n = g.geometry.vertices.length / 12, I = g.geometry.indices, nt = I.length / 3;
    const rep: Report = { clipMm: 0, clipPose: '', tearPct: 0, tearPose: '', foldPct: 0, perPose: {} };
    for (const [pn, pose] of Object.entries(poses)) {
        const world = posedJointWorld(m, pose);
        const skinOf = (j: number) => mat4.multiply(mat4.create(), world[j], m.inverseBindMatrices.subarray(j * 16, j * 16 + 16) as unknown as mat4);
        let ji: Uint8Array = g.jointIndices, jw: Float32Array = g.jointWeights;
        if (st && steer) {
            const skin = new Float32Array(world.length * 16);
            world.forEach((_, j) => skin.set(skinOf(j), j * 16));
            ji = g.jointIndices.slice(); jw = g.jointWeights.slice();
            steerSkirtWeights(st, skirtSteerSignal(skin, st), ji, jw);
        }
        const posedCaps = caps.map((c) => { const S = skinOf(c.a); return { pa: vec3.transformMat4(vec3.create(), c.pa, S), pb: vec3.transformMat4(vec3.create(), c.pb, S), r0: c.r0, r1: c.r1 }; });
        const { P } = skinAll(m, g.geometry.vertices, ji, jw, pose, cfg.method);
        let clip = 0;
        const v = vec3.create();
        for (let i = 0; i < n + nt; i++) {
            if (i < n) vec3.set(v, P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
            else { const t = (i - n) * 3; for (let k = 0; k < 3; k++) v[k] = (P[I[t] * 3 + k] + P[I[t + 1] * 3 + k] + P[I[t + 2] * 3 + k]) / 3; }
            for (const c of posedCaps) clip = Math.max(clip, capsulePen(v, c) * 1000);
        }
        const gm: SkinnedMeshData = { ...m, vertices: g.geometry.vertices, indices: I, jointIndices: ji, jointWeights: jw };
        const d = measureDeformation(gm, pose, undefined, undefined, cfg.method === 'dualQuat' ? 'dqs' : 'lbs');
        const tear = (100 * (d.stretched + d.folded)) / nt;
        const fold = (100 * d.folded) / nt;
        rep.perPose[pn] = { clipMm: clip, tearPct: tear, foldPct: fold };
        rep.foldPct = Math.max(rep.foldPct, fold);
        if (clip > rep.clipMm) { rep.clipMm = clip; rep.clipPose = pn; }
        if (tear > rep.tearPct) { rep.tearPct = tear; rep.tearPose = pn; }
    }
    return rep;
}

/** Distance from p to the nearest triangle of a mesh (brute force — skirts are a few hundred tris). */
function distToMesh(px: number, py: number, pz: number, V: Float32Array, I: Uint32Array): number {
    let best = Infinity;
    const p = vec3.fromValues(px, py, pz), a = vec3.create(), b = vec3.create(), c = vec3.create();
    for (let t = 0; t < I.length; t += 3) {
        vec3.set(a, V[I[t] * 12], V[I[t] * 12 + 1], V[I[t] * 12 + 2]);
        vec3.set(b, V[I[t + 1] * 12], V[I[t + 1] * 12 + 1], V[I[t + 1] * 12 + 2]);
        vec3.set(c, V[I[t + 2] * 12], V[I[t + 2] * 12 + 1], V[I[t + 2] * 12 + 2]);
        best = Math.min(best, pointTriDist(p, a, b, c));
    }
    return best;
}
function pointTriDist(p: vec3, a: vec3, b: vec3, c: vec3): number {
    const seg = (s0: vec3, s1: vec3) => {
        const d = vec3.sub(vec3.create(), s1, s0), t = Math.max(0, Math.min(1, vec3.dot(vec3.sub(vec3.create(), p, s0), d) / Math.max(1e-12, vec3.dot(d, d))));
        return vec3.distance(p, vec3.scaleAndAdd(vec3.create(), s0, d, t));
    };
    const nrm = vec3.cross(vec3.create(), vec3.sub(vec3.create(), b, a), vec3.sub(vec3.create(), c, a));
    const nl = vec3.length(nrm);
    if (nl > 1e-12) {   // the projection lands inside the triangle → the plane distance
        vec3.scale(nrm, nrm, 1 / nl);
        const dist = vec3.dot(vec3.sub(vec3.create(), p, a), nrm), q0 = vec3.scaleAndAdd(vec3.create(), p, nrm, -dist);
        const inside = [[a, b], [b, c], [c, a]].every(([s0, s1]) =>
            vec3.dot(vec3.cross(vec3.create(), vec3.sub(vec3.create(), s1, s0), vec3.sub(vec3.create(), q0, s0)), nrm) >= -1e-9);
        if (inside) return Math.abs(dist);
    }
    return Math.min(seg(a, b), seg(b, c), seg(c, a));
}

describe('skirt / dress follows the legs without clipping (R6.3)', () => {
    const bodies = CONFIGS.map((cfg) => ({ cfg, body: bodyFor(cfg) }));
    const { m } = bodies[0].body;
    const poses = { ...locomotionPoses(m.jointNames, m.jointLocalPositions), ...EXTRA_POSES };

    it('covers the whole default Walk + Run cycles', () => {
        expect(Object.keys(poses).filter((k) => k.startsWith('Walk') || k.startsWith('Run')).length).toBeGreaterThanOrEqual(30);
    });

    // Limits = measured 2026-09-30 (NEW body, steered) rounded up + a small margin. The old rigid skirt (legFollow 0)
    // measured ~47–53 mm on the same poses (the SKIRT_PRINT table). Long dress: the one residual is the running swing leg
    // (calf folded back under an ankle-length hem at the thighs' crossing) — see docs/ui/character-creator.md.
    // TEAR is the price of following the legs: fabric between a forward and a trailing leg has to stretch (the rigid
    // skirt doesn't stretch — it clips instead; its knee dress still "tears" 18% sitting, where the thighs fold it).
    const CLIP_MM: Record<string, number> = { 'Skirt': 3, 'Mini Skirt': 3, 'Knee dress': 3, 'Long dress': 25 };
    const TEAR_PCT: Record<string, number> = { 'Skirt': 8, 'Mini Skirt': 8, 'Knee dress': 13, 'Long dress': 18 };

    it('no skirt vertex or face sinks into the thigh/shin capsules over walk/run/stride/sit (NEW character)', () => {
        const { cfg, body } = bodies[0];
        const fails: string[] = [];
        for (const [name, p] of Object.entries(SKIRTS)) {
            const rep = measureSkirt(body, cfg, p, poses);
            if (rep.clipMm > CLIP_MM[name]) fails.push(`${name}: clip ${rep.clipMm.toFixed(1)} mm @ ${rep.clipPose} > ${CLIP_MM[name]}`);
            if (rep.tearPct > TEAR_PCT[name]) fails.push(`${name}: tear ${rep.tearPct.toFixed(1)}% @ ${rep.tearPose} > ${TEAR_PCT[name]}`);
            if (rep.perPose['rest'].clipMm > 0.5) fails.push(`${name}: clips at REST (${rep.perPose['rest'].clipMm.toFixed(1)} mm) — the capsule model is off`);
        }
        expect(fails).toEqual([]);
    }, 120_000);

    it('the hem swing (fit round 2) never pushes a skirt into the legs: worst lag in 8 directions + full flare stays in the gate', () => {
        const { cfg, body } = bodies[0];
        const fails: string[] = [];
        for (const name of ['Skirt', 'Knee dress', 'Long dress'] as const) {
            for (let k = 0; k < 8; k++) {
                const a = (k * Math.PI) / 4, L = MAX_LAG * 1.2;
                const rep = measureSkirt(body, cfg, SKIRTS[name], poses, true, [Math.cos(a) * L, Math.sin(a) * L, MAX_FLARE * 1.2]);
                if (rep.clipMm > CLIP_MM[name]) fails.push(`${name} swing ${k}: clip ${rep.clipMm.toFixed(1)} mm @ ${rep.clipPose} > ${CLIP_MM[name]}`);
            }
        }
        expect(fails).toEqual([]);
    }, 240_000);

    it('beats the rigid skirt on both character configs, and the steer never makes it worse', () => {
        for (const { cfg, body } of bodies) {
            for (const [name, p] of Object.entries(SKIRTS)) {
                const legacy = measureSkirt(body, cfg, { ...p, legFollow: 0 }, poses);
                const noSteer = measureSkirt(body, cfg, p, poses, false);
                const now = measureSkirt(body, cfg, p, poses);
                expect(legacy.clipMm, `${cfg.label} ${name}: the rigid skirt should clip`).toBeGreaterThan(40);
                expect(now.clipMm, `${cfg.label} ${name}`).toBeLessThan(legacy.clipMm * 0.7);
                expect(now.clipMm, `${cfg.label} ${name}: steer`).toBeLessThanOrEqual(noSteer.clipMm + 0.5);
            }
        }
    }, 240_000);

    it('keeps the rest shape: every leg-follow skirt vert lies on the old skirt surface; legFollow 0 has no steer', () => {
        const { body } = bodies[0];
        for (const [name, p] of Object.entries(SKIRTS)) {
            const old = generateBottom(body.fit, { ...p, legFollow: 0 });
            const now = generateBottom(body.fit, p);
            expect((old as { skirtSteer?: unknown }).skirtSteer, `${name}: legacy has no steer`).toBeUndefined();
            const V = now.geometry.vertices, n = V.length / 12;
            let worst = 0;
            for (let i = 0; i < n; i++) worst = Math.max(worst, distToMesh(V[i * 12], V[i * 12 + 1], V[i * 12 + 2], old.geometry.vertices, old.geometry.indices));
            expect(worst * 1000, `${name}: max distance from the old rest surface (mm)`).toBeLessThan(2);
        }
    }, 120_000);

    it('steer signal: 0 at symmetric poses (rest / sit), ±1 in a stride', () => {
        const { body } = bodies[0];
        const st = (generateBottom(body.fit, SKIRTS['Knee dress']) as { skirtSteer?: SkirtSteer }).skirtSteer!;
        expect(st).toBeTruthy();
        const sig = (pose: Pose) => {
            const world = posedJointWorld(body.m, pose);
            const skin = new Float32Array(world.length * 16);
            world.forEach((w, j) => skin.set(mat4.multiply(mat4.create(), w, body.m.inverseBindMatrices.subarray(j * 16, j * 16 + 16) as unknown as mat4), j * 16));
            return skirtSteerSignal(skin, st);
        };
        expect(Math.abs(sig([]))).toBeLessThan(1e-6);
        expect(Math.abs(sig(EXTRA_POSES['sit']))).toBeLessThan(1e-3);
        expect(sig(EXTRA_POSES['wide stride'])).toBeGreaterThan(0.99);     // left thigh forward → +1
        expect(sig([{ joint: 'upperleg_R', q: q('x', -40) }])).toBeLessThan(-0.99);
        // Signal 0 writes exactly the static weights generateBottom returned.
        const g = generateBottom(body.fit, SKIRTS['Knee dress']);
        const ji = g.jointIndices.slice(), jw = g.jointWeights.slice();
        steerSkirtWeights(st, 0, ji, jw);
        expect([...jw]).toEqual([...g.jointWeights]);
        expect([...ji]).toEqual([...g.jointIndices]);
    });

    it('report', async () => {
        if (!process.env.SKIRT_PRINT) return;
        const rows: string[] = [];
        for (const { cfg, body } of bodies) for (const [name, p] of Object.entries(SKIRTS)) {
            for (const [label, pp, steer] of ([['rigid (legFollow 0)', { ...p, legFollow: 0 }, false], ['leg-follow, no steer', p, false], ['leg-follow + steer', p, true]] as const)) {
                const rep = measureSkirt(body, cfg, pp as BottomParams, poses, steer);
                const worstOf = (pre: string) => Math.max(...Object.entries(rep.perPose).filter(([k]) => k.startsWith(pre)).map(([, c]) => c.clipMm));
                rows.push(`${cfg.label.padEnd(21)} ${name.padEnd(11)} ${label.padEnd(21)} walk ${worstOf('Walk').toFixed(1).padStart(5)}  run ${worstOf('Run').toFixed(1).padStart(5)}  worst ${rep.clipMm.toFixed(1).padStart(5)} mm @ ${rep.clipPose.padEnd(12)} tear ${rep.tearPct.toFixed(1).padStart(4)}% @ ${rep.tearPose.padEnd(12)} (folded ≤ ${rep.foldPct.toFixed(1)}%)`);
                if (process.env.SKIRT_DETAIL && steer) for (const [pn, c] of Object.entries(rep.perPose)) if (c.clipMm > 0.5 || c.tearPct > 3) rows.push(`      ${pn.padEnd(14)} clip ${c.clipMm.toFixed(1).padStart(5)} mm  tear ${c.tearPct.toFixed(1)}%`);
            }
        }
        (await import('node:fs')).writeFileSync(process.env.SKIRT_PRINT, rows.join('\n') + '\n');
    }, 300_000);
});
