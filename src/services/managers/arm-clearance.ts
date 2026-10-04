/**
 * arm-clearance.ts — keep a posed character's arms OUT of its own body, whatever its shape (pose & animation audit
 * 2026-09-28).
 *
 * A preset pose is a fixed set of joint angles, but bodies differ: the relaxed arms that hang clear of a default body
 * sink ~4 cm into the torso of a heavy or broad-shouldered one (measured). So after a preset is applied the engine
 * runs {@link resolveArmClearance}: for each arm that hangs DOWN, it raises the arm sideways the smallest amount that
 * leaves the upper arm + forearm clear of the torso/hips/legs (plus a small margin so the idle sway doesn't brush it).
 * A body the pose already clears is left exactly as posed. Hands are allowed to touch (hands on hips, chin in hand).
 *
 * Also exports the self-intersection measure itself ({@link limbIntersections}) — the pose preview report uses the same
 * one, so what the report calls clean is what the engine enforces.
 */
import { mat4 } from 'gl-matrix';
import { posedJointWorld, type SkinnedMeshData, type PoseRotations } from './skin-deform-metrics';
import { packDualQuatSkin, skinMatrixForTS } from '../../renderer/3d/dual-quat-skin';
import { VertGrid } from './vert-grid';

type Quat = [number, number, number, number];
export type ClearanceMethod = 'linear' | 'dualQuat';

/** Skin every vertex (positions + normals, xyz-packed) exactly as the GPU does. */
export function skinVerts(m: SkinnedMeshData, pose: PoseRotations, method: ClearanceMethod): { P: Float32Array; N: Float32Array } {
    const world = posedJointWorld(m, pose);
    const skin = new Float32Array(world.length * 16);
    const tmp = mat4.create();
    world.forEach((w, j) => skin.set(mat4.multiply(tmp, w, m.inverseBindMatrices.subarray(j * 16, j * 16 + 16) as unknown as mat4), j * 16));
    const buf = method === 'dualQuat' ? (packDualQuatSkin(skin) ?? skin) : skin;
    const stride = m.stride, po = m.posOffset ?? 0, n = m.vertices.length / stride;
    const P = new Float32Array(n * 3), N = new Float32Array(n * 3);
    const jj = [0, 0, 0, 0], ww = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < 4; k++) { jj[k] = m.jointIndices[i * 4 + k]; ww[k] = m.jointWeights[i * 4 + k]; }
        const s = skinMatrixForTS(buf, jj, ww);
        const o = i * stride + po, x = m.vertices[o], y = m.vertices[o + 1], z = m.vertices[o + 2];
        P[i * 3] = s[0] * x + s[4] * y + s[8] * z + s[12];
        P[i * 3 + 1] = s[1] * x + s[5] * y + s[9] * z + s[13];
        P[i * 3 + 2] = s[2] * x + s[6] * y + s[10] * z + s[14];
        // normals sit right after the position in the 12-float body layout
        const nx0 = m.vertices[o + 3], ny0 = m.vertices[o + 4], nz0 = m.vertices[o + 5];
        const nx = s[0] * nx0 + s[4] * ny0 + s[8] * nz0, ny = s[1] * nx0 + s[5] * ny0 + s[9] * nz0, nz = s[2] * nx0 + s[6] * ny0 + s[10] * nz0;
        const l = Math.hypot(nx, ny, nz) || 1;
        N[i * 3] = nx / l; N[i * 3 + 1] = ny / l; N[i * 3 + 2] = nz / l;
    }
    return { P, N };
}

const ARM_L = ['shoulder_L', 'lowerarm_L', 'hand_L'], ARM_R = ['shoulder_R', 'lowerarm_R', 'hand_R'];
const LEG_L = ['upperleg_L', 'lowerleg_L', 'foot_L'], LEG_R = ['upperleg_R', 'lowerleg_R', 'foot_R'];
export type BodyPart = 'armL' | 'armR' | 'legL' | 'legR' | 'head' | 'torso';
export const partOfJoint = (j: string): BodyPart => ARM_L.includes(j) ? 'armL' : ARM_R.includes(j) ? 'armR'
    : LEG_L.includes(j) ? 'legL' : LEG_R.includes(j) ? 'legR' : j === 'head' || j === 'neck' ? 'head' : 'torso';

function dominantJointIdx(m: SkinnedMeshData, i: number): number {
    let d = 0, bw = -1;
    for (let k = 0; k < 4; k++) if (m.jointWeights[i * 4 + k] > bw) { bw = m.jointWeights[i * 4 + k]; d = m.jointIndices[i * 4 + k]; }
    return d;
}
/** A joint's rest WORLD position (rest joints are unrotated, so it's minus the inverse-bind translation). */
function restJointPos(m: SkinnedMeshData, name: string): [number, number, number] {
    const j = m.jointNames.indexOf(name), b = m.inverseBindMatrices;
    return [-b[j * 16 + 12], -b[j * 16 + 13], -b[j * 16 + 14]];
}
const pack12 = (P: Float32Array, idx: number[]): Float32Array => {
    const o = new Float32Array(idx.length * 12);
    idx.forEach((v, k) => { o[k * 12] = P[v * 3]; o[k * 12 + 1] = P[v * 3 + 1]; o[k * 12 + 2] = P[v * 3 + 2]; });
    return o;
};

/** Upper-arm verts this close (rest, m) to the shoulder joint that fold into the torso = the body's ARMPIT CREASE. */
const ARMPIT_CREASE_R = 0.16;
/** How deep (m) a limb vert must be behind another part's surface to count as inside it. */
const INSIDE_DEPTH = 0.005;

export interface IntersectReport {
    /** Limb verts inside another body part, keyed "limb→part". */
    hits: Record<string, number>;
    maxMm: number;
    verts: Set<number>;
    /** Armpit-crease verts — counted, not flagged: the underside of the upper arm right at the armpit folds into the
     *  torso side whenever the arm is down (a skinning crease of the body, ~2 verts/side in EVERY arms-down pose). */
    creases: number;
}

/** Precomputed per-mesh data for {@link limbIntersections} (vertex parts, rest seam exclusion). */
export interface LimbCache { part: BodyPart[]; dom: string[]; seam: Uint8Array; armpit: Float32Array; }
export function buildLimbCache(m: SkinnedMeshData, restP: Float32Array): LimbCache {
    const n = restP.length / 3, part = new Array<BodyPart>(n), dom = new Array<string>(n);
    for (let i = 0; i < n; i++) { dom[i] = m.jointNames[dominantJointIdx(m, i)]; part[i] = partOfJoint(dom[i]); }
    // A limb vert within 4 cm of ANOTHER part AT REST is the seam (shoulder socket, inner thigh), not a collision.
    const seam = new Uint8Array(n);
    for (const limb of ['armL', 'armR', 'legL', 'legR'] as const) {
        const others: number[] = []; for (let i = 0; i < n; i++) if (part[i] !== limb) others.push(i);
        const g = new VertGrid(pack12(restP, others), 0.04);
        for (let i = 0; i < n; i++) {
            if (part[i] !== limb) continue;
            const { d2 } = g.nearest(restP[i * 3], restP[i * 3 + 1], restP[i * 3 + 2]);
            if (d2 <= 0.04 * 0.04) seam[i] = 1;
        }
    }
    const shL = restJointPos(m, 'shoulder_L'), shR = restJointPos(m, 'shoulder_R');
    const armpit = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const s = restP[i * 3] > 0 ? shL : shR;
        armpit[i] = Math.hypot(restP[i * 3] - s[0], restP[i * 3 + 1] - s[1], restP[i * 3 + 2] - s[2]);
    }
    return { part, dom, seam, armpit };
}

/**
 * Limb skin (each arm, each leg) that went INSIDE a different body part: for every limb vert, the nearest vert of the
 * OTHER parts (within 6 cm) — if the limb vert is > 5 mm behind that surface (along its normal), it's inside. Leg↔leg
 * (the crotch seam) and the armpit crease are not counted. `limbs` / `jointFilter` narrow what's tested.
 */
export function limbIntersections(c: LimbCache, P: Float32Array, N: Float32Array,
    limbs: readonly BodyPart[] = ['armL', 'armR', 'legL', 'legR'], jointFilter?: (joint: string) => boolean,
    against?: readonly BodyPart[]): IntersectReport {
    const n = P.length / 3;
    const hits: Record<string, number> = {}; let maxD = 0, creases = 0; const verts = new Set<number>();
    for (const limb of limbs) {
        const others: number[] = [];
        for (let i = 0; i < n; i++) if (c.part[i] !== limb && (!against || against.includes(c.part[i]))) others.push(i);
        const g = new VertGrid(pack12(P, others), 0.06);
        for (let i = 0; i < n; i++) {
            if (c.part[i] !== limb || c.seam[i]) continue;
            if (jointFilter && !jointFilter(c.dom[i])) continue;
            const { best, d2 } = g.nearest(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
            if (best < 0 || d2 > 0.06 * 0.06) continue;
            const o = others[best];
            const d = (P[o * 3] - P[i * 3]) * N[o * 3] + (P[o * 3 + 1] - P[i * 3 + 1]) * N[o * 3 + 1] + (P[o * 3 + 2] - P[i * 3 + 2]) * N[o * 3 + 2];
            if (d <= INSIDE_DEPTH) continue;
            if ((limb === 'legL' && c.part[o] === 'legR') || (limb === 'legR' && c.part[o] === 'legL')) continue;
            if (c.part[o] === 'torso' && c.dom[i].startsWith('shoulder_') && c.armpit[i] < ARMPIT_CREASE_R) { creases++; continue; }
            const key = `${limb}→${c.part[o]}`; hits[key] = (hits[key] ?? 0) + 1; maxD = Math.max(maxD, d); verts.add(i);
        }
    }
    return { hits, maxMm: maxD * 1000, verts, creases };
}

/**
 * A body plus garments it wears as ONE skinned mesh (same skeleton, the body's vertex stride), so the clearance fit
 * sees the OUTFIT: sleeves and bare forearms against a top's torso panel, not just skin against skin (visual-polish
 * item 13 — the Play arms sank into bulky jackets). Garment vertices must share the body's layout (the generators emit
 * the same 12-float vertex: position then normal).
 */
export function withGarments(m: SkinnedMeshData, garments: { vertices: Float32Array; indices: ArrayLike<number>; jointIndices: ArrayLike<number>; jointWeights: ArrayLike<number> }[]): SkinnedMeshData {
    const parts = garments.filter((g) => g.vertices.length > 0 && g.vertices.length % m.stride === 0 && g.jointIndices.length === (g.vertices.length / m.stride) * 4);
    if (!parts.length) return m;
    const nv = (m.vertices.length + parts.reduce((a, g) => a + g.vertices.length, 0)) / m.stride;
    const vertices = new Float32Array(nv * m.stride), ji = new Uint8Array(nv * 4), jw = new Float32Array(nv * 4);
    const indices = new Uint32Array(m.indices.length + parts.reduce((a, g) => a + g.indices.length, 0));
    vertices.set(m.vertices); ji.set(m.jointIndices); jw.set(m.jointWeights); indices.set(m.indices);
    let vo = m.vertices.length / m.stride, io = m.indices.length;
    for (const g of parts) {
        vertices.set(g.vertices, vo * m.stride); ji.set(g.jointIndices, vo * 4); jw.set(g.jointWeights, vo * 4);
        for (let k = 0; k < g.indices.length; k++) indices[io + k] = g.indices[k] + vo;
        vo += g.vertices.length / m.stride; io += g.indices.length;
    }
    return { ...m, vertices, indices, jointIndices: ji, jointWeights: jw };
}

// ── The solver ───────────────────────────────────────────────────────────────────────────────────────────────────
const qz = (deg: number): Quat => { const h = (deg * Math.PI) / 360; return [0, 0, Math.sin(h), Math.cos(h)]; };
const qy = (deg: number): Quat => { const h = (deg * Math.PI) / 360; return [0, Math.sin(h), 0, Math.cos(h)]; };
const qmul = (a: readonly number[], b: readonly number[]): Quat => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];

export interface ClearanceOptions {
    /** Largest extra sideways raise (deg) the solver may add. */ maxDeg?: number;
    /** Step (deg). */ stepDeg?: number;
    /** Extra raise (deg, default 3) added on top of the minimum that clears, so the idle sway doesn't brush the body. */ marginDeg?: number;
}

/**
 * Fit each arm of a pose to THIS body so the upper arm + forearm don't sink into it:
 *   • an arm hanging DOWN is raised sideways the minimum that clears the torso / hips / legs;
 *   • an arm bent UP (hand at the chin / chest) has its elbow OPENED the minimum that clears the head / torso / the
 *     other arm — a thicker hand or forearm then sits against the chin instead of inside it. (Swinging the whole arm
 *     forward was tried: it pushed the hand further into the face.)
 * Hands may touch (hands on hips, chin in hand). `rot` = joint name → local rotation (read, and MUTATED for
 * shoulder_L / shoulder_R). Returns the degrees added per side (0 = the pose already cleared — left untouched).
 */
export function resolveArmClearance(m: SkinnedMeshData, rot: Map<string, Quat>, method: ClearanceMethod = 'dualQuat', opts: ClearanceOptions = {}): { L: number; R: number } {
    const maxDeg = opts.maxDeg ?? 24, step = opts.stepDeg ?? 1.5, margin = opts.marginDeg ?? 3;
    const toPose = (): PoseRotations => [...rot].map(([joint, q]) => ({ joint, q }));
    const rest = skinVerts(m, [], method);
    const cache = buildLimbCache(m, rest.P);
    const out = { L: 0, R: 0 };
    const armJoints = (j: string) => j.startsWith('shoulder_') || j.startsWith('lowerarm_');   // hands may touch
    for (const side of ['L', 'R'] as const) {
        const sh = rot.get(`shoulder_${side}`); if (!sh) continue;
        const w = posedJointWorld(m, toPose());
        const si = m.jointNames.indexOf(`shoulder_${side}`), ei = m.jointNames.indexOf(`lowerarm_${side}`), hi = m.jointNames.indexOf(`hand_${side}`);
        if (si < 0 || ei < 0) continue;
        const up = w[ei][13] - w[si][13], len = Math.hypot(w[ei][12] - w[si][12], up, w[ei][14] - w[si][14]);
        const handUp = hi >= 0 && w[hi][13] > w[ei][13] + 0.05;          // forearm raised (chin / chest / folded)
        const hanging = up < -0.5 * len && !handUp;
        const bentUp = up < 0.3 * len && handUp;                         // elbow low, hand up — thinking / arms folded
        if (!hanging && !bentUp) continue;                               // raised arms: leave (raising further → head)
        const limb: BodyPart = side === 'L' ? 'armL' : 'armR';
        const other: BodyPart = side === 'L' ? 'armR' : 'armL';
        const against: BodyPart[] = hanging ? ['torso', 'legL', 'legR', other] : ['torso', 'head', other];
        // A hand held UP (chin, chest) may touch, but not sink in → count it too; a hanging hand may rest on the hip.
        const counted = hanging ? armJoints : (j: string) => armJoints(j) || j.startsWith('hand_');
        const el = rot.get(`lowerarm_${side}`) ?? [0, 0, 0, 1];
        // Strategies, tried in order; the first that clears within maxDeg wins. Hanging arm: raise it sideways; if that
        // can't clear (e.g. a forearm folded under the other arm's elbow), open its elbow instead. Bent-up arm: open the
        // elbow (swinging it forward was tried and pushes the hand further into the face).
        type Strat = { joint: string; orig: Quat; at: (deg: number) => Quat };
        const raise: Strat = { joint: `shoulder_${side}`, orig: sh, at: (d) => qmul(qz(side === 'L' ? d : -d), sh) };
        const open: Strat = { joint: `lowerarm_${side}`, orig: el, at: (d) => qmul(el, qy(side === 'L' ? d : -d)) };   // left flexes −Y
        const clashes = (st: Strat, deg: number): number => {
            rot.set(st.joint, st.at(deg));
            const p = skinVerts(m, toPose(), method);
            const n = limbIntersections(cache, p.P, p.N, [limb], counted, against).verts.size;
            rot.set(st.joint, st.orig);
            return n;
        };
        if (clashes(raise, 0) === 0) continue;                           // already clear → untouched
        let deg = 0;
        for (const st of hanging ? [raise, open] : [open]) {
            let d = step;
            while (d <= maxDeg && clashes(st, d) > 0) d += step;
            if (d > maxDeg) continue;                                    // this strategy can't clear it
            deg = d + margin;
            rot.set(st.joint, st.at(deg));
            break;
        }
        if (!deg) continue;                                              // nothing clears within limits → leave as authored
        out[side] = deg;
    }
    return out;
}
