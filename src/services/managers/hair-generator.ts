/**
 * hair-generator.ts — procedural chunky low-poly hair.
 *
 * The "no-modeling" hair path: HairParams → a low-poly mesh (cap + bangs + side locks + tails),
 * built in the head's local frame. The caller skins it 100% to the head joint (follows poses, like
 * the eye decal) and shades it with a root→tip gradient texture sampled by `uv.v` (0 = root/scalp,
 * 1 = tip — the reference's blue tips). See docs/specs/hair-generation.md.
 *
 * Lengths are expressed as FACTORS of the head radius so a style scales with head size.
 * Geometry conventions match body-generator.ts (12-float interleave, CCW-outward, smooth normals).
 */

import type { MeshGeometry } from '../../renderer/3d/mesh-generators';

type V3 = [number, number, number];

/** Head frame the hair is built around (centre + half-extents, in body-local space). */
export interface HeadFrame { cx: number; cy: number; cz: number; rx: number; ry: number; rz: number; }

export interface HairParams {
    preset?: string;

    // ── Cap (factors × head radius) ──
    capThickness: number;   // outward offset from the scalp
    backLength: number;     // how far the back flap hangs (× ry)
    crownRound: number;     // extra crown height/pouf (× ry)
    hairlineFront: number;  // forehead hairline height (× ry above centre) — where bangs root
    verticalOffset: number; // shift the WHOLE hairstyle up(+) / down(−), × ry (raise it off the eyes)

    // ── Bangs ──
    partingStyle: 'fringe' | 'parted' | 'swept';
    partingPosition: number; // −1..1 (gap centre across the forehead)
    partingWidth: number;    // gap width (× rx)
    bangCount: number;
    bangLength: number;      // × ry
    bangCurve: number;       // forward bend (0..1)
    bangPointiness: number;  // 0 = blunt, 1 = sharp point
    bangOffset: number;      // shift just the bangs up(+)/down(−), × ry (independent of the cap)

    // ── Side locks ──
    sideLock: boolean;
    sideLockLength: number;  // × ry
    sideLockWidth: number;   // × rx

    // ── Tails ──
    tailStyle: 'none' | 'twin' | 'pony' | 'pig';
    tailHeight: number;      // attach height (× ry from centre; + = up)
    tailSpread: number;      // how far out they splay (0..1)
    tailLength: number;      // × ry
    tailThickness: number;   // root radius (× rx)
    tailTaper: number;       // root→tip thinning (0..1)
    tailCurl: number;        // downward/back curl (0..1)
    tailTip: 'point' | 'flare' | 'blunt';

    // ── Colour (the caller bakes these into the gradient texture) ──
    rootColor: string;
    tipColor: string;
    gradient: boolean;
    tipFade: number;         // 0..1 — how far up the tip colour reaches

    // ── Render ──
    chunkiness: number;      // 0..1 poly density (low = chunkier)
}

/** Default = the reference-girl Twintails (cream → blue tips). */
export const DEFAULT_HAIR_PARAMS: HairParams = {
    preset: 'Twintails',
    capThickness: 0.14, backLength: 0.5, crownRound: 0.12, hairlineFront: 0.42, verticalOffset: 0.2,
    partingStyle: 'parted', partingPosition: 0, partingWidth: 0.18,
    bangCount: 6, bangLength: 1.15, bangCurve: 0.5, bangPointiness: 0.8, bangOffset: 0,
    sideLock: true, sideLockLength: 1.8, sideLockWidth: 0.18,
    tailStyle: 'twin', tailHeight: 0.45, tailSpread: 0.55, tailLength: 3.0,
    tailThickness: 0.4, tailTaper: 0.6, tailCurl: 0.35, tailTip: 'point',
    rootColor: '#efe7d6', tipColor: '#7fb0d8', gradient: true, tipFade: 0.45,
    chunkiness: 0.3,
};

// ── vec3 helpers ──
const sub = (a: V3, b: V3): V3 => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const add = (a: V3, b: V3): V3 => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
const scl = (a: V3, s: number): V3 => [a[0]*s, a[1]*s, a[2]*s];
const cross = (a: V3, b: V3): V3 => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a: V3, b: V3): number => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0]/l, a[1]/l, a[2]/l]; };
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
/** Rodrigues rotation of `vec` about unit `axis` by angle with given cos/sin. */
const rotAxis = (vec: V3, axis: V3, c: number, s: number): V3 => {
    const d = dot(axis, vec), cr = cross(axis, vec);
    return [
        vec[0]*c + cr[0]*s + axis[0]*d*(1-c),
        vec[1]*c + cr[1]*s + axis[1]*d*(1-c),
        vec[2]*c + cr[2]*s + axis[2]*d*(1-c),
    ];
};

interface Accum {
    pos: number[]; nrm: number[]; uv: number[]; idx: number[]; count: number;
    // Spring-tail tagging: `curTailId` is the tail being built right now (−1 = cap/bangs/sidelocks), stamped
    // onto each vertex in `tailId`. The caller uses tailId (+ uv.v = the tail's root→tip param) to skin a tail
    // vertex to its spring-bone chain; everything else stays 100% on the head joint.
    tailId: number[]; curTailId: number;
}
function pushVert(ac: Accum, p: V3, n: V3, u: number, v: number): number {
    ac.pos.push(p[0], p[1], p[2]); ac.nrm.push(n[0], n[1], n[2]); ac.uv.push(u, v);
    ac.tailId.push(ac.curTailId);
    return ac.count++;
}
function perpFrame(axis: V3): { u: V3; v: V3 } {
    const a = norm(axis);
    const up: V3 = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(up, a));
    return { u, v: cross(a, u) };
}
function addRingN(ac: Accum, center: V3, u: V3, v: V3, r: number, n: number, uvV: number): number[] {
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
        const ang = (k / n) * Math.PI * 2;
        const dir = add(scl(u, Math.cos(ang)), scl(v, Math.sin(ang)));
        out.push(pushVert(ac, add(center, scl(dir, r)), dir, k / n, uvV));
    }
    return out;
}
function bandRings(ac: Accum, a: number[], b: number[]): void {
    for (let k = 0; k < a.length; k++) {
        const k2 = (k + 1) % a.length;
        ac.idx.push(a[k], a[k2], b[k2]);
        ac.idx.push(a[k], b[k2], b[k]);
    }
}
function capRing(ac: Accum, loop: number[], apex: V3, uvV: number): void {
    let c: V3 = [0, 0, 0];
    for (const vi of loop) c = [c[0]+ac.pos[vi*3], c[1]+ac.pos[vi*3+1], c[2]+ac.pos[vi*3+2]];
    c = scl(c, 1/loop.length);
    const ai = pushVert(ac, apex, norm(sub(apex, c)), 0.5, uvV);
    for (let k = 0; k < loop.length; k++) ac.idx.push(loop[k], loop[(k+1)%loop.length], ai);
}

// ── Cap: an ellipsoidal dome (crown → ear ring) + a back flap that hangs by backLength ──
function buildCap(ac: Accum, h: HeadFrame, p: HairParams, lat: number, ring: number): void {
    const Rx = h.rx * (1 + p.capThickness), Rz = h.rz * (1 + p.capThickness);
    const Ry = h.ry * (1 + p.capThickness) + h.ry * p.crownRound;
    const thetaMax = Math.PI * 0.56;   // a bit past the equator → covers the sides
    const rings: number[][] = [];
    for (let i = 0; i <= lat; i++) {
        const theta = (i / lat) * thetaMax;
        const st = Math.sin(theta), ct = Math.cos(theta);
        const r: number[] = [];
        for (let k = 0; k < ring; k++) {
            const phi = (k / ring) * Math.PI * 2;
            const dir: V3 = [st * Math.cos(phi), ct, st * Math.sin(phi)];
            const pos: V3 = [h.cx + dir[0] * Rx, h.cy + dir[1] * Ry, h.cz + dir[2] * Rz];
            r.push(pushVert(ac, pos, norm(dir), k / ring, (i / lat) * 0.3));
        }
        rings.push(r);
    }
    // Back-flap hem: drop the back of the bottom ring by backLength (front barely drops).
    const bottom = rings[lat];
    const hem: number[] = [];
    for (let k = 0; k < ring; k++) {
        const phi = (k / ring) * Math.PI * 2;
        const backness = Math.max(0, -Math.sin(phi));   // 1 at back (−Z), 0 at front
        const drop = h.ry * (0.12 + p.backLength * backness);
        const bx = ac.pos[bottom[k]*3], by = ac.pos[bottom[k]*3+1], bz = ac.pos[bottom[k]*3+2];
        hem.push(pushVert(ac, [bx, by - drop, bz], [Math.cos(phi), -0.2, Math.sin(phi)], k / ring, 0.3 + 0.5 * backness));
    }
    for (let i = 0; i < lat; i++) bandRings(ac, rings[i], rings[i + 1]);
    bandRings(ac, bottom, hem);
    capRing(ac, rings[0], [h.cx, h.cy + Ry, h.cz], 0);
}

// ── A flat tapered ribbon (one bang clump or side lock), hanging from `root` along `down` ──
function buildRibbon(
    ac: Accum, root: V3, down: V3, side: V3, length: number, baseW: number, segs: number, pointiness: number,
): void {
    const d = norm(down), s = norm(side);
    const n = norm(cross(d, s));   // faces forward
    let prevL = -1, prevR = -1;
    for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const c = add(root, scl(d, t * length));
        const w = baseW * Math.max(0.04, 1 - t * pointiness);
        const li = pushVert(ac, add(c, scl(s, -w * 0.5)), n, 0, t);
        const ri = pushVert(ac, add(c, scl(s,  w * 0.5)), n, 1, t);
        if (i > 0) { ac.idx.push(prevL, prevR, ri); ac.idx.push(prevL, ri, li); }
        prevL = li; prevR = ri;
    }
}

// ── Bangs across the front hairline, with a parting gap ──
function buildBangs(ac: Accum, h: HeadFrame, p: HairParams, segs: number): void {
    const count = Math.max(0, Math.round(p.bangCount));
    if (count <= 0) return;
    const frontW = h.rx * 0.95;                       // half the forehead span the bangs cover
    const rootY  = h.cy + h.ry * (p.hairlineFront + (p.bangOffset ?? 0));   // forehead hairline (+ bang offset)
    const down: V3 = norm([0, -1, p.bangCurve]);      // hang down + forward
    const side: V3 = [1, 0, 0];
    // root sits on the front of the head at the hairline height
    const yt = Math.max(0, 1 - (rootY - h.cy) * (rootY - h.cy) / (h.ry * h.ry));
    const zfront = h.cz + Math.sqrt(yt) * h.rz * (1 + p.capThickness);
    const place = (x: number, w: number) =>
        buildRibbon(ac, [h.cx + x, rootY, zfront], down, side, h.ry * p.bangLength, Math.max(0.01, w), segs, p.bangPointiness);

    const fringe = p.partingStyle === 'fringe';
    const partC  = fringe ? 0 : p.partingPosition * frontW * (p.partingStyle === 'swept' ? 1 : 0.6);
    const gap    = fringe ? 0 : p.partingWidth * h.rx;

    if (count % 2 === 0) {
        // EVEN → two symmetric clumps of count/2, one on each side of the parting.
        const half = count / 2;
        const leftSpan  = Math.max(0, (partC - gap * 0.5) - (-frontW));
        const rightSpan = Math.max(0, frontW - (partC + gap * 0.5));
        for (let i = 0; i < half; i++) {
            place(-frontW + leftSpan * (i + 0.5) / half,              leftSpan  / half * 1.3);
            place(partC + gap * 0.5 + rightSpan * (i + 0.5) / half,   rightSpan / half * 1.3);
        }
    } else {
        // ODD → an even spread across the front; the parting (if any) carves the middle.
        const w = (frontW * 2) / count * 1.25;
        for (let i = 0; i < count; i++) {
            const x = -frontW + (frontW * 2) * (i + 0.5) / count;
            if (gap > 0 && Math.abs(x - partC) < gap * 0.5) continue;
            place(x, w);
        }
    }
}

// ── Side locks beside the face ──
function buildSideLocks(ac: Accum, h: HeadFrame, p: HairParams, segs: number): void {
    if (!p.sideLock) return;
    const down: V3 = norm([0, -1, 0.15]);
    for (const sx of [-1, 1]) {
        const root: V3 = [h.cx + sx * h.rx * (1 + p.capThickness) * 0.92, h.cy + h.ry * 0.15, h.cz + h.rz * 0.2];
        buildRibbon(ac, root, down, [0, 0, 1], h.ry * p.sideLockLength, h.rx * p.sideLockWidth, segs, 0.4);
    }
}

// ── A tapered tube swept along a quadratic bezier (one tail) ──
function buildTail(ac: Accum, A: V3, C: V3, E: V3, r0: number, p: HairParams, segs: number, ring: number): void {
    const bez = (t: number): V3 => {
        const it = 1 - t;
        return [
            it*it*A[0] + 2*it*t*C[0] + t*t*E[0],
            it*it*A[1] + 2*it*t*C[1] + t*t*E[1],
            it*it*A[2] + 2*it*t*C[2] + t*t*E[2],
        ];
    };
    const tan = (t: number): V3 => {
        const it = 1 - t;
        return norm([
            2*it*(C[0]-A[0]) + 2*t*(E[0]-C[0]),
            2*it*(C[1]-A[1]) + 2*t*(E[1]-C[1]),
            2*it*(C[2]-A[2]) + 2*t*(E[2]-C[2]),
        ]);
    };
    // Sweep with PARALLEL TRANSPORT: one frame at the root, rotated minimally to follow each
    // tangent. (Recomputing perpFrame() per segment spins/flips the frame — and asymmetrically
    // between the mirrored left/right tails, which kinked one tail and not the other.)
    const rings: number[][] = [];
    let f = perpFrame(tan(0));
    let u = f.u, v = f.v, prevT = tan(0);
    for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const T = tan(t);
        if (i > 0) {
            const axis = cross(prevT, T), s = len(axis), c = dot(prevT, T);
            if (s > 1e-6) { const ax: V3 = [axis[0]/s, axis[1]/s, axis[2]/s]; u = rotAxis(u, ax, c, s); v = rotAxis(v, ax, c, s); }
            prevT = T;
        }
        let r = r0 * (1 - t * p.tailTaper);
        if (p.tailTip === 'flare' && t > 0.8) r *= 1 + (t - 0.8) * 5 * 0.4;   // widen near the end
        rings.push(addRingN(ac, bez(t), u, v, Math.max(0.001, r), ring, t));
    }
    for (let i = 0; i < segs; i++) bandRings(ac, rings[i], rings[i + 1]);
    const last = rings[segs];
    if (p.tailTip === 'point') capRing(ac, last, add(bez(1), scl(tan(1), r0 * 0.4)), 1);
    else capRing(ac, last, bez(1), 1);   // blunt / flare → flat cap
}

function buildTails(ac: Accum, h: HeadFrame, p: HairParams, segs: number, ring: number): void {
    if (p.tailStyle === 'none') return;
    const L = h.ry * p.tailLength, r0 = h.rx * p.tailThickness;
    const attach: { A: V3; out: V3 }[] = [];
    if (p.tailStyle === 'pony') {
        attach.push({ A: [h.cx, h.cy + h.ry * p.tailHeight, h.cz - h.rz * 0.9], out: [0, 0.1, -1] });
    } else {
        const y = h.cy + h.ry * (p.tailStyle === 'pig' ? p.tailHeight - 0.5 : p.tailHeight);
        for (const sx of [-1, 1]) {
            attach.push({ A: [h.cx + sx * h.rx * 0.92, y, h.cz - h.rz * 0.25], out: [sx, 0.05, -0.25] });
        }
    }
    let ti = 0;
    for (const { A, out } of attach) {
        ac.curTailId = ti++;             // tag this tail's verts so the caller can skin them to a spring chain
        const o = norm(out);
        const down: V3 = [0, -1, 0];
        const C = add(add(A, scl(o, L * p.tailSpread * 0.5)), scl(down, L * 0.4));
        const E = add(add(A, scl(o, L * p.tailSpread * 0.3)), scl(down, L * (1 + p.tailCurl * 0.3)));
        E[2] -= L * p.tailCurl * 0.25;   // curl back
        buildTail(ac, A, C, E, r0, p, segs, ring);
    }
    ac.curTailId = -1;
}

/** Smooth, outward-oriented per-vertex normals (area-weighted) — matches body-generator. */
function recomputeNormals(ac: Accum): void {
    const accN = new Float32Array(ac.count * 3);
    for (let i = 0; i < ac.idx.length; i += 3) {
        const a = ac.idx[i], b = ac.idx[i+1], c = ac.idx[i+2];
        const e1x = ac.pos[b*3]-ac.pos[a*3], e1y = ac.pos[b*3+1]-ac.pos[a*3+1], e1z = ac.pos[b*3+2]-ac.pos[a*3+2];
        const e2x = ac.pos[c*3]-ac.pos[a*3], e2y = ac.pos[c*3+1]-ac.pos[a*3+1], e2z = ac.pos[c*3+2]-ac.pos[a*3+2];
        let nx = e1y*e2z-e1z*e2y, ny = e1z*e2x-e1x*e2z, nz = e1x*e2y-e1y*e2x;
        const rx = ac.nrm[a*3]+ac.nrm[b*3]+ac.nrm[c*3];
        const ry = ac.nrm[a*3+1]+ac.nrm[b*3+1]+ac.nrm[c*3+1];
        const rz = ac.nrm[a*3+2]+ac.nrm[b*3+2]+ac.nrm[c*3+2];
        if (nx*rx + ny*ry + nz*rz < 0) { nx=-nx; ny=-ny; nz=-nz; }
        for (const v of [a, b, c]) { accN[v*3]+=nx; accN[v*3+1]+=ny; accN[v*3+2]+=nz; }
    }
    for (let i = 0; i < ac.count; i++) {
        let x = accN[i*3], y = accN[i*3+1], z = accN[i*3+2];
        const l = Math.hypot(x, y, z);
        if (l < 1e-6) { x = ac.nrm[i*3]; y = ac.nrm[i*3+1]; z = ac.nrm[i*3+2]; }
        else { x/=l; y/=l; z/=l; }
        ac.nrm[i*3]=x; ac.nrm[i*3+1]=y; ac.nrm[i*3+2]=z;
    }
}

/** Per-vertex one-ring neighbours (from the hair triangles) — to smooth the de-collision push. */
function buildAdjacency(ac: Accum): number[][] {
    const adj: Set<number>[] = Array.from({ length: ac.count }, () => new Set<number>());
    for (let i = 0; i < ac.idx.length; i += 3) {
        const a = ac.idx[i], b = ac.idx[i+1], c = ac.idx[i+2];
        adj[a].add(b); adj[a].add(c); adj[b].add(a); adj[b].add(c); adj[c].add(a); adj[c].add(b);
    }
    return adj.map(s => [...s]);
}

// ── Shrink-wrap the hair OUT of the body (build-time / rest pose, like the clothing fit) ──
// Any hair vertex inside the body (or closer than `gap`) is pushed out to the surface + gap along the nearest
// body vertex's normal, then the push is SMOOTHED over the hair so a correction lifts its neighbours into a
// soft bump (no spikes). Push-ONLY → free-hanging hair (a tail in open air) is untouched. This (1) CONFORMS
// the cap to the REAL sculpted head — which the ellipsoid cap approximates badly, so the jaw/occiput poked
// through — and (2) DRAPES the tails over the shoulders/back instead of clipping into the torso/shirt.
// `body` = the body's 12-float rest verts (pos 0-2, normal 3-5); the body INCLUDES the head, so one pass does
// both. NOTE: this is the REST-pose fit; posed tail swing (the head turning) is the spring-bone job (separate).
function fitHairToBody(ac: Accum, body: Float32Array, gap: number, maxPush: number): void {
    const bn = body.length / 12;
    if (bn === 0 || ac.count === 0) return;
    const push = new Float32Array(ac.count);
    const pnx = new Float32Array(ac.count), pny = new Float32Array(ac.count), pnz = new Float32Array(ac.count);
    for (let g = 0; g < ac.count; g++) {
        const gx = ac.pos[g*3], gy = ac.pos[g*3+1], gz = ac.pos[g*3+2];
        let best = -1, bestD = Infinity;
        for (let b = 0; b < bn; b++) {
            const dx = gx - body[b*12], dy = gy - body[b*12+1], dz = gz - body[b*12+2];
            const d = dx*dx + dy*dy + dz*dz;
            if (d < bestD) { bestD = d; best = b; }
        }
        if (best < 0) continue;
        const o = best*12, nx = body[o+3], ny = body[o+4], nz = body[o+5];
        const signed = (gx-body[o])*nx + (gy-body[o+1])*ny + (gz-body[o+2])*nz;   // dist from the surface along its normal
        push[g] = Math.min(maxPush, Math.max(0, gap - signed));                   // only push OUT (never pull a floating hair in)
        pnx[g] = nx; pny[g] = ny; pnz[g] = nz;
    }
    const adj = buildAdjacency(ac);
    for (let iter = 0; iter < 3; iter++) {
        const next = push.slice();
        for (let g = 0; g < ac.count; g++) {
            const nb = adj[g]; if (!nb.length) continue;
            let s = 0; for (const k of nb) s += push[k];
            next[g] = Math.max(push[g], 0.6 * (s / nb.length));   // max → corrections never drop below the required clearance
        }
        push.set(next);
    }
    for (let g = 0; g < ac.count; g++) {
        if (push[g] > 0) { ac.pos[g*3] += pnx[g]*push[g]; ac.pos[g*3+1] += pny[g]*push[g]; ac.pos[g*3+2] += pnz[g]*push[g]; }
    }
}

/** Spring-tail bone count per tail — the chain length the tail mesh skins to (root→tip). */
export const TAIL_BONES = 4;

/** generateHair output: the mesh + the dynamic-tail rig hints (the caller builds spring chains from these). */
export interface HairResult {
    geometry: MeshGeometry;
    /** One chain of body-local REST positions (root→tip, length TAIL_BONES) per tail — sampled from the
     *  DRAPED tail (post shrink-wrap) so the spring chain's rest pose matches the conformed hair. */
    tailBones: [number, number, number][][];
    /** Per vertex: the tail index it belongs to (−1 = cap/bangs/sidelocks → stays 100% on the head joint). */
    tailVertId: Int32Array;
}

/** Tail bone rest positions = centroid of each tail's verts bucketed by uv.v (root→tip) into TAIL_BONES bins.
 *  Uses the post-shrink-wrap positions so the chain follows the draped tail. Empty bins carry the last. */
function computeTailBones(ac: Accum, nTails: number): [number, number, number][][] {
    const out: [number, number, number][][] = [];
    for (let t = 0; t < nTails; t++) {
        const sx = new Array(TAIL_BONES).fill(0), sy = new Array(TAIL_BONES).fill(0), sz = new Array(TAIL_BONES).fill(0);
        const cnt = new Array(TAIL_BONES).fill(0);
        for (let i = 0; i < ac.count; i++) {
            if (ac.tailId[i] !== t) continue;
            const v = ac.uv[i*2+1];
            const b = Math.max(0, Math.min(TAIL_BONES - 1, Math.round(v * (TAIL_BONES - 1))));
            sx[b] += ac.pos[i*3]; sy[b] += ac.pos[i*3+1]; sz[b] += ac.pos[i*3+2]; cnt[b]++;
        }
        const bones: [number, number, number][] = [];
        for (let b = 0; b < TAIL_BONES; b++) {
            if (cnt[b] > 0) bones.push([sx[b]/cnt[b], sy[b]/cnt[b], sz[b]/cnt[b]]);
            else bones.push(bones.length ? [...bones[bones.length-1]] as [number, number, number] : [0, 0, 0]);
        }
        out.push(bones);
    }
    return out;
}

/** Generate a hairstyle mesh around `head`. `uv.v` runs 0 (root) → 1 (tip) for the gradient.
 *  `bodyVerts` (optional, the body's 12-float rest geometry) enables the shrink-wrap that conforms the cap to
 *  the head + drapes the tails over the body (no clipping). Returns the mesh + spring-tail rig hints. */
export function generateHair(headIn: HeadFrame, partial?: Partial<HairParams>, bodyVerts?: Float32Array): HairResult {
    const p = { ...DEFAULT_HAIR_PARAMS, ...partial };
    // Accept either case for the enum dropdowns ('Twin' ↔ 'twin', 'Parted' ↔ 'parted', …) so a UI
    // that binds a capitalized display label still drives the geometry.
    const lc = (s: string) => String(s ?? '').toLowerCase().trim();
    p.partingStyle = lc(p.partingStyle) as HairParams['partingStyle'];
    p.tailStyle    = lc(p.tailStyle)    as HairParams['tailStyle'];
    p.tailTip      = lc(p.tailTip)      as HairParams['tailTip'];
    // Shift the whole build up/down so the hairline clears the eyes (everything is built around `head`).
    const head: HeadFrame = { ...headIn, cy: headIn.cy + (p.verticalOffset ?? 0) * headIn.ry };
    const ac: Accum = { pos: [], nrm: [], uv: [], idx: [], count: 0, tailId: [], curTailId: -1 };
    const ch = Math.max(0, Math.min(1, p.chunkiness));
    const capLat = 5 + Math.round(ch * 5);   // cap latitude rings (3–6 → 4–8 → now 5–10) → the shrink-wrap conforms tighter to the head
    const ring   = 24;                        // cap segments around = the HEAD's 24-gon (built in the same X/Z frame, fu=[1,0,0]/fv=[0,0,1]) → segments angularly ALIGN with the head columns so nothing pokes between faces. ~40 extra verts, computed at generation time → perf is a non-issue.
    const ribSeg = 3 + Math.round(ch * 2);
    const tailSeg = 4 + Math.round(ch * 4);
    const tailRing = 6;

    buildCap(ac, head, p, capLat, ring);
    buildBangs(ac, head, p, ribSeg);
    buildSideLocks(ac, head, p, ribSeg + 1);
    buildTails(ac, head, p, tailSeg, tailRing);

    // Shrink-wrap out of the body: cap → conforms to the real head, tails → drape over the shoulders/back.
    // Small gap (a hair off the skin) + a generous push so a tail buried in the torso still clears. Done before
    // the normals are recomputed (it moves verts).
    if (bodyVerts && bodyVerts.length >= 12) fitHairToBody(ac, bodyVerts, 0.004, 0.1);

    recomputeNormals(ac);

    const vcount = ac.count;
    const verts = new Float32Array(vcount * 12);
    for (let i = 0; i < vcount; i++) {
        const o = i * 12;
        const nx = ac.nrm[i*3], ny = ac.nrm[i*3+1], nz = ac.nrm[i*3+2];
        const ref: V3 = Math.abs(ny) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        const t = norm(cross([nx, ny, nz], ref));
        verts[o]   = ac.pos[i*3]; verts[o+1] = ac.pos[i*3+1]; verts[o+2]  = ac.pos[i*3+2];
        verts[o+3] = nx;          verts[o+4] = ny;            verts[o+5]  = nz;
        verts[o+6] = ac.uv[i*2];  verts[o+7] = ac.uv[i*2+1];
        verts[o+8] = t[0];        verts[o+9] = t[1];          verts[o+10] = t[2]; verts[o+11] = 1;
    }
    const nTails = ac.tailId.reduce((m, v) => Math.max(m, v + 1), 0);
    return {
        geometry: { vertices: verts, indices: new Uint32Array(ac.idx), format: '12float' },
        tailBones: computeTailBones(ac, nTails),
        tailVertId: Int32Array.from(ac.tailId),
    };
}
