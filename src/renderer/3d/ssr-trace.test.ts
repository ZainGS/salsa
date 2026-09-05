import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import {
    traceSSRRef, projectPoint, cameraForwardFromVP, norm3,
    type Vec3, type SSRWorldPosBuffer, type SSRTraceParams,
} from './ssr-trace';

// ── math helpers (test-only) ────────────────────────────────────────────────────────────────────────────────
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** WGSL-style reflect: i - 2·dot(i,n)·n. */
const reflect3 = (i: Vec3, n: Vec3): Vec3 => sub3(i, scale3(n, 2 * dot3(i, n)));

// ── synthetic scene: quads raycast per texel-center = what the world-pos prepass would write ────────────────
interface Quad { center: Vec3; normal: Vec3; uAxis: Vec3; vAxis: Vec3; halfU: number; halfV: number }

function quad(center: Vec3, normal: Vec3, halfU: number, halfV: number): Quad {
    const n = norm3(normal);
    const seed: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const uAxis = norm3(cross3(seed, n));
    const vAxis = cross3(n, uAxis);
    return { center, normal: n, uAxis, vAxis, halfU, halfV };
}

function intersectQuad(q: Quad, ro: Vec3, rd: Vec3): { t: number; p: Vec3 } | null {
    const denom = dot3(rd, q.normal);
    if (Math.abs(denom) < 1e-8) return null;
    const t = dot3(sub3(q.center, ro), q.normal) / denom;
    if (t <= 1e-4) return null;
    const p = add3(ro, scale3(rd, t));
    const lu = dot3(sub3(p, q.center), q.uAxis), lv = dot3(sub3(p, q.center), q.vAxis);
    if (Math.abs(lu) > q.halfU || Math.abs(lv) > q.halfV) return null;
    return { t, p };
}

/** Build the half-res world-pos buffer the prepass would produce: nearest quad along each texel-center camera ray. */
function makeBuffer(viewProj: Float32Array, width: number, height: number, quads: Quad[]): SSRWorldPosBuffer {
    const inv = mat4.invert(mat4.create(), viewProj)!;
    const unproject = (ndcX: number, ndcY: number, ndcZ: number): Vec3 => {
        const x = inv[0] * ndcX + inv[4] * ndcY + inv[8] * ndcZ + inv[12];
        const y = inv[1] * ndcX + inv[5] * ndcY + inv[9] * ndcZ + inv[13];
        const z = inv[2] * ndcX + inv[6] * ndcY + inv[10] * ndcZ + inv[14];
        const w = inv[3] * ndcX + inv[7] * ndcY + inv[11] * ndcZ + inv[15];
        return [x / w, y / w, z / w];
    };
    const layers = (px: number, py: number): { first: Vec3 | null; second: Vec3 | null } => {
        const u = (px + 0.5) / width, v = (py + 0.5) / height;
        const ndcX = u * 2 - 1, ndcY = 1 - 2 * v;
        const p0 = unproject(ndcX, ndcY, 0.05);
        const p1 = unproject(ndcX, ndcY, 0.95);
        const rd = norm3(sub3(p1, p0));
        let best: { t: number; p: Vec3 } | null = null;
        let next: { t: number; p: Vec3 } | null = null;
        for (const q of quads) {
            const h = intersectQuad(q, p0, rd);
            if (!h) continue;
            if (!best || h.t < best.t) { next = best; best = h; }
            else if (!next || h.t < next.t) next = h;
        }
        return { first: best ? best.p : null, second: next ? next.p : null };
    };
    return {
        width, height,
        sample: (px: number, py: number): Vec3 | null => layers(px, py).first,
        // Second-nearest surface = what the GPU peel prepass writes (discard fragments at/in front of layer 1).
        sampleBack: (px: number, py: number): Vec3 | null => layers(px, py).second,
    };
}

// ── analytic mirror optics (ground truth) ───────────────────────────────────────────────────────────────────
/** Perspective: the mirror fragment F at which a viewer at C sees object point P (virtual-image construction). */
function analyticFragmentPersp(C: Vec3, planePoint: Vec3, n: Vec3, P: Vec3): Vec3 {
    const Pv = sub3(P, scale3(n, 2 * dot3(sub3(P, planePoint), n)));   // virtual image of P behind the plane
    const dir = sub3(Pv, C);
    const s = dot3(sub3(planePoint, C), n) / dot3(dir, n);
    return add3(C, scale3(dir, s));
}
/** Ortho: all view rays share direction fwd; reflected dir R0 = reflect(fwd, n); F = P − R0·s with F on the plane. */
function analyticFragmentOrtho(fwd: Vec3, planePoint: Vec3, n: Vec3, P: Vec3): Vec3 {
    const R0 = reflect3(fwd, n);
    const s = dot3(sub3(P, planePoint), n) / dot3(R0, n);
    return sub3(P, scale3(R0, s));
}

/** Projected screen-bounds of a quad (min/max uv of its corners). */
function projectedBounds(viewProj: Float32Array, q: Quad): { min: [number, number]; max: [number, number] } {
    let minU = 1e9, minV = 1e9, maxU = -1e9, maxV = -1e9;
    for (const su of [-1, 1]) for (const sv of [-1, 1]) {
        const c = add3(add3(q.center, scale3(q.uAxis, su * q.halfU)), scale3(q.vAxis, sv * q.halfV));
        const pr = projectPoint(viewProj, c);
        minU = Math.min(minU, pr.uv[0]); maxU = Math.max(maxU, pr.uv[0]);
        minV = Math.min(minV, pr.uv[1]); maxV = Math.max(maxV, pr.uv[1]);
    }
    return { min: [minU, minV], max: [maxU, maxV] };
}

const PARAMS: SSRTraceParams = { maxSteps: 80, stride: 0.08, thickness: 0.15, edgeFeather: 2 };
const RES = 200;

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('SSR trace (CPU reference of the WGSL)', () => {
    // Scene A — the canonical mirror: camera head-on, mirror at z=-2 facing +Z, red square between them at z=0.
    const C: Vec3 = [0, 0, 5];
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspectiveZO(mat4.create(), (50 * Math.PI) / 180, 1, 0.1, 100);
    const vp = mat4.multiply(mat4.create(), proj, view) as Float32Array;
    const mirror = quad([0, 0, -2], [0, 0, 1], 3, 3);
    const square = quad([1.0, 0.8, 0], [0, 0, 1], 0.3, 0.3);
    const buf = makeBuffer(vp, RES, RES, [mirror, square]);

    const traceFrom = (F: Vec3, n: Vec3, eye: Vec3 | null, fwd?: Vec3) => {
        const V = eye ? norm3(sub3(eye, F)) : scale3(fwd!, -1);   // toward the camera
        const R = reflect3(scale3(V, -1), n);
        return traceSSRRef(F, n, R, vp, buf, PARAMS);
    };

    it('a WALL MIRROR BACKFACE-FILLS at the analytic position (flagged, gated, faded)', () => {
        // A wall-mirror ray reaches an object between camera and mirror from BEHIND — the mirror-facing side was
        // never rendered. The BACKFACE-FILL uses the back-exit through the camera-facing surface as a stand-in:
        // for a thin object that exit is at the analytically-correct reflection point, so the fill is accurate —
        // just flagged (backfill) and gated (ray heads toward the camera here, so the gate is fully open).
        const P = square.center;
        const F = analyticFragmentPersp(C, mirror.center, mirror.normal, P);
        const res = traceFrom(F, mirror.normal, C);
        expect(res.hit).toBe(true);
        expect(res.backfill).toBe(true);
        expect(res.backfillFade!).toBeGreaterThan(0.8);        // head-on mirror → ray toward camera → gate open
        const expected = projectPoint(vp, P).uv;
        expect(Math.abs(res.uv![0] - expected[0])).toBeLessThan(0.05);
        expect(Math.abs(res.uv![1] - expected[1])).toBeLessThan(0.05);
    });

    it('EDGE FEATHER: fills near the object silhouette fade below interior fills (coverage ring)', () => {
        const Pc = square.center;
        const Pe: Vec3 = [square.center[0] + 0.285, square.center[1], 0];   // ~0.015 from the +u edge (sub-texel)
        const Fc = analyticFragmentPersp(C, mirror.center, mirror.normal, Pc);
        const Fe = analyticFragmentPersp(C, mirror.center, mirror.normal, Pe);
        const rc = traceFrom(Fc, mirror.normal, C);
        const re = traceFrom(Fe, mirror.normal, C);
        expect(rc.hit).toBe(true);
        expect(re.hit).toBe(true);
        expect(re.backfillFade!).toBeLessThan(rc.backfillFade! - 0.05);   // silhouette fill feathers out
    });

    it('moving the object moves the reflection the SAME lateral direction (mirror optics)', () => {
        const P1: Vec3 = [1.0, 0.8, 0];
        const P2: Vec3 = [1.2, 0.8, 0];   // object moves right (+x)
        const F1 = analyticFragmentPersp(C, mirror.center, mirror.normal, P1);
        const F2 = analyticFragmentPersp(C, mirror.center, mirror.normal, P2);
        expect(F2[0]).toBeGreaterThan(F1[0]);   // fragment moves right too — parallel motion does NOT flip
    });

    it('wall-mirror sweep: every hit is a FLAGGED backfill inside the object bounds (no ghosts elsewhere)', () => {
        const bounds = projectedBounds(vp, square);
        const margin = 3 / RES;
        let hits = 0;
        for (let gy = 0; gy <= 20; gy++) {
            for (let gx = 0; gx <= 20; gx++) {
                const F: Vec3 = [0.2 + (gx / 20) * 1.4, 0.1 + (gy / 20) * 1.2, -2];
                const res = traceFrom(F, mirror.normal, C);
                if (res.hit) {
                    hits++;
                    expect(res.backfill).toBe(true);
                    expect(res.uv![0]).toBeGreaterThan(bounds.min[0] - margin);
                    expect(res.uv![0]).toBeLessThan(bounds.max[0] + margin);
                    expect(res.uv![1]).toBeGreaterThan(bounds.min[1] - margin);
                    expect(res.uv![1]).toBeLessThan(bounds.max[1] + margin);
                }
            }
        }
        expect(hits).toBeGreaterThan(10);   // the fill really covers the reflection region
    });

    it('wall-mirror dense sweep: the backfill covers the reflection region densely', () => {
        let attempted = 0, got = 0;
        for (let gy = 0; gy <= 24; gy++) {
            for (let gx = 0; gx <= 24; gx++) {
                const F: Vec3 = [0.4 + (gx / 24) * 0.9, 0.3 + (gy / 24) * 0.9, -2];
                const V = norm3(sub3(C, F));
                const R = reflect3(scale3(V, -1), mirror.normal);
                const a = intersectQuad(square, F, R);
                if (!a) continue;
                const lu = Math.abs(dot3(sub3(a.p, square.center), square.uAxis));
                const lv = Math.abs(dot3(sub3(a.p, square.center), square.vAxis));
                if (lu > square.halfU - 0.05 || lv > square.halfV - 0.05) continue;   // skip silhouette grazers
                attempted++;
                if (traceFrom(F, mirror.normal, C).hit) got++;
            }
        }
        expect(attempted).toBeGreaterThan(30);
        expect(got / attempted).toBeGreaterThan(0.85);
    });

    it('never hits with only the reflector present (no self-hit → no echo source)', () => {
        const lonely = makeBuffer(vp, RES, RES, [mirror]);
        for (let gy = 0; gy <= 12; gy++) {
            for (let gx = 0; gx <= 12; gx++) {
                const F: Vec3 = [-1.4 + (gx / 12) * 2.8, -1.4 + (gy / 12) * 2.8, -2];
                const V = norm3(sub3(C, F));
                const R = reflect3(scale3(V, -1), mirror.normal);
                const res = traceSSRRef(F, mirror.normal, R, vp, lonely, PARAMS);
                expect(res.hit).toBe(false);
            }
        }
    });

    it('a NEAR-COPLANAR object (floating just off the mirror plane) yields no ghosts outside its bounds', () => {
        // The optics: an object almost in the reflector's plane reflects only as a tiny sliver next to itself.
        // The requirement here is NO false copies elsewhere (the earlier plane-rejection bug banded this case).
        const shallow = quad([1.6, 0.4, -1.94], [0, 0, 1], 0.3, 0.3);   // 0.06 in front of the mirror plane
        const buf2 = makeBuffer(vp, RES, RES, [mirror, shallow]);
        const bounds = projectedBounds(vp, shallow);
        const margin = 3 / RES;
        for (let gy = 0; gy <= 16; gy++) {
            for (let gx = 0; gx <= 16; gx++) {
                const F: Vec3 = [0.6 + (gx / 16) * 2.0, -0.4 + (gy / 16) * 1.6, -2];
                const V = norm3(sub3(C, F));
                const R = reflect3(scale3(V, -1), mirror.normal);
                const res = traceSSRRef(F, mirror.normal, R, vp, buf2, PARAMS);
                if (res.hit) {
                    expect(res.uv![0]).toBeGreaterThan(bounds.min[0] - margin);
                    expect(res.uv![0]).toBeLessThan(bounds.max[0] + margin);
                    expect(res.uv![1]).toBeGreaterThan(bounds.min[1] - margin);
                    expect(res.uv![1]).toBeLessThan(bounds.max[1] + margin);
                }
            }
        }
    });

    it('ortho tilted WALL mirror backfills at the analytic position', () => {
        const oview = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
        const oproj = mat4.orthoZO(mat4.create(), -2.5, 2.5, -2.5, 2.5, 0.1, 100);
        const ovp = mat4.multiply(mat4.create(), oproj, oview) as Float32Array;
        const fwd = cameraForwardFromVP(ovp);
        const tilted = quad([0, 0, -2], [0.3, 0, 1], 3, 3);
        const target = quad([1.5, 0.2, -0.6], [0, 0, 1], 0.3, 0.3);
        const obuf = makeBuffer(ovp, RES, RES, [tilted, target]);
        const P = target.center;
        const F = analyticFragmentOrtho(fwd, tilted.center, tilted.normal, P);
        // sanity: F should be on the tilted mirror's face
        expect(Math.abs(dot3(sub3(F, tilted.center), tilted.normal))).toBeLessThan(1e-6);
        const V = scale3(fwd, -1);
        const R = reflect3(scale3(V, -1), tilted.normal);
        const res = traceSSRRef(F, tilted.normal, R, ovp, obuf, PARAMS);
        // A wall-mirror-style reflector reaches the target from BEHIND — the BACKFACE-FILL stands in at the
        // analytic position (thin target → the back-exit is the correct point), flagged for fading/blur.
        expect(res.hit).toBe(true);
        expect(res.backfill).toBe(true);
        const expected = projectPoint(ovp, P).uv;
        expect(Math.abs(res.uv![0] - expected[0])).toBeLessThan(0.05);
        expect(Math.abs(res.uv![1] - expected[1])).toBeLessThan(0.05);
    });

    it('VIEW-ALIGNED rays do not inflate the reflection footprint (the extruded/inset regression)', () => {
        // Mirror facing the camera head-on → reflection rays travel almost straight back along the view axis: huge
        // depth per screen texel. A depth window derived from span/steps ballooned here and accepted hits ~1 world
        // unit from the surface — the reflection smeared through depth ("extruded", front face "inset"). With the
        // per-step depth-range test, fragments whose TRUE reflected ray misses the cube must MISS.
        let missExpected = 0, falseHits = 0;
        for (let gy = 0; gy <= 20; gy++) {
            for (let gx = 0; gx <= 20; gx++) {
                const F: Vec3 = [-1.5 + (gx / 20) * 3.0, -1.5 + (gy / 20) * 3.0, -2];
                const V = norm3(sub3(C, F));
                const R = reflect3(scale3(V, -1), mirror.normal);
                const analytic = intersectQuad(square, F, R);
                if (analytic) continue;                       // true hit — covered by the density test
                // margin: skip rays that graze within 2 texels of the square's silhouette (quantization boundary)
                const tPlane = dot3(sub3([0, 0, 0] as Vec3, F), [0, 0, 1] as Vec3) / dot3(R, [0, 0, 1] as Vec3);
                if (tPlane > 0) {
                    const pAt = add3(F, scale3(R, tPlane));
                    const lu = Math.abs(dot3(sub3(pAt, square.center), square.uAxis));
                    const lv = Math.abs(dot3(sub3(pAt, square.center), square.vAxis));
                    if (lu < square.halfU + 0.08 && lv < square.halfV + 0.08) continue;
                }
                missExpected++;
                if (traceSSRRef(F, mirror.normal, R, vp, buf, PARAMS).hit) falseHits++;
            }
        }
        expect(missExpected).toBeGreaterThan(100);
        expect(falseHits / missExpected).toBeLessThan(0.02);   // no footprint inflation
    });

    it('GRAZING top-face reflection is dense and correct (the striped-cube-top regression)', () => {
        // A cube in front of a vertical mirror, camera above → the mirror reflects the cube's TOP face at a grazing
        // angle (steeply receding in depth). The old fixed-world-stride march sampled this band with uneven screen
        // spacing → per-fragment acceptance flicker → striped reflections. The screen-space DDA must cover it densely.
        const eye: Vec3 = [0, 1.6, 5];
        const gview = mat4.lookAt(mat4.create(), [0, 1.6, 5], [0, 0.4, -1], [0, 1, 0]);
        const gproj = mat4.perspectiveZO(mat4.create(), (50 * Math.PI) / 180, 1, 0.1, 100);
        const gvp = mat4.multiply(mat4.create(), gproj, gview) as Float32Array;
        const gMirror = quad([0, 0.8, -2], [0, 0, 1], 3, 3);
        const topFace = quad([0.5, 0.7, -0.8], [0, 1, 0], 0.35, 0.35);   // horizontal top of the "cube"
        const frontFace = quad([0.5, 0.35, -0.45], [0, 0, 1], 0.35, 0.35);
        const gbuf = makeBuffer(gvp, RES, RES, [gMirror, topFace, frontFace]);
        let expected = 0, got = 0;
        for (let gx = 0; gx <= 12; gx++) {
            for (let gz = 0; gz <= 12; gz++) {
                // sweep points ON the top face (inset from edges), reflect each analytically
                const P: Vec3 = [0.5 - 0.28 + (gx / 12) * 0.56, 0.7, -0.8 - 0.28 + (gz / 12) * 0.56];
                const F = analyticFragmentPersp(eye, gMirror.center, gMirror.normal, P);
                if (Math.abs(F[0]) > gMirror.halfU || Math.abs(F[1] - gMirror.center[1]) > gMirror.halfV) continue;
                // skip fragments whose sightline is occluded by the cube itself (F must be camera-visible)
                const toF = sub3(F, eye);
                const sTop = intersectQuad(topFace, eye, norm3(toF));
                const sFront = intersectQuad(frontFace, eye, norm3(toF));
                const distF = Math.hypot(toF[0], toF[1], toF[2]);
                if ((sTop && sTop.t < distF) || (sFront && sFront.t < distF)) continue;
                expected++;
                const V = norm3(sub3(eye, F));
                const R = reflect3(scale3(V, -1), gMirror.normal);
                const res = traceSSRRef(F, gMirror.normal, R, gvp, gbuf, PARAMS);
                if (res.hit) got++;
            }
        }
        expect(expected).toBeGreaterThan(40);
        // ≥85%: the strict front-side-crossing rule drops a thin sliver of sub-texel grazing crossings adjacent to
        // invalid pixels — acceptable edge erosion vs the ~50% banded loss this test was built against.
        expect(got / expected).toBeGreaterThan(0.85);
    });

    it('ISOMETRIC floor reflections WORK (front-side crossings need no view-angle fade)', () => {
        // The old confidence fade suppressed high-angle floors wholesale; with back-exit hits rejected, the front-face
        // reflection resolves via the SURFACE's own depth gradient — correct even in the iso/ortho view.
        const iview = mat4.lookAt(mat4.create(), [5, 5, 5], [0, 0, 0], [0, 1, 0]);
        const iproj = mat4.orthoZO(mat4.create(), -3, 3, -3, 3, 0.1, 100);
        const ivp = mat4.multiply(mat4.create(), iproj, iview) as Float32Array;
        const ifwd = cameraForwardFromVP(ivp);
        const ifloor = quad([0, 0, 0], [0, 1, 0], 4, 4);
        const face = quad([0, 0.6, 0], [0, 0, 1], 0.5, 0.5);   // standing camera-facing surface above the floor
        const ibuf = makeBuffer(ivp, RES, RES, [ifloor, face]);
        const P: Vec3 = [0, 0.5, 0];                            // a point on the standing face
        const F = analyticFragmentOrtho(ifwd, ifloor.center, ifloor.normal, P);
        const V = scale3(ifwd, -1);
        const R = reflect3(scale3(V, -1), ifloor.normal);
        const res = traceSSRRef(F, ifloor.normal, R, ivp, ibuf, PARAMS);
        expect(res.hit).toBe(true);
        const expected = projectPoint(ivp, P).uv;
        expect(Math.abs(res.uv![0] - expected[0])).toBeLessThan(0.05);
        expect(Math.abs(res.uv![1] - expected[1])).toBeLessThan(0.05);
    });

    it('FLOOR reflection (the wet-floor case): object standing above a horizontal reflector', () => {
        const eye: Vec3 = [0, 1.2, 3];
        const fview = mat4.lookAt(mat4.create(), [0, 1.2, 3], [0, 0.2, -1], [0, 1, 0]);
        const fproj = mat4.perspectiveZO(mat4.create(), (50 * Math.PI) / 180, 1, 0.1, 100);
        const fvp = mat4.multiply(mat4.create(), fproj, fview) as Float32Array;
        const floor = quad([0, 0, -0.5], [0, 1, 0], 4, 4);
        const standee = quad([0, 0.5, -1], [0, 0, 1], 0.35, 0.3);
        const fbuf = makeBuffer(fvp, RES, RES, [floor, standee]);
        const P = standee.center;
        const F = analyticFragmentPersp(eye, floor.center, floor.normal, P);
        const V = norm3(sub3(eye, F));
        const R = reflect3(scale3(V, -1), floor.normal);
        const res = traceSSRRef(F, floor.normal, R, fvp, fbuf, PARAMS);
        expect(res.hit).toBe(true);
        const expected = projectPoint(fvp, P).uv;
        expect(Math.abs(res.uv![0] - expected[0])).toBeLessThan(0.05);
        expect(Math.abs(res.uv![1] - expected[1])).toBeLessThan(0.05);
        expect(res.reachFade!).toBeGreaterThan(0.95);   // target well inside the budget → full strength
    });

    // ── DEPTH-PEELED backface-fill (two-layer): membership is PROVEN, trails are impossible ────────────────
    describe('depth-peeled backface-fill', () => {
        const PEEL: SSRTraceParams = { ...PARAMS, depthPeel: true };
        // CLOSED axis-aligned box (all 6 faces) — the peel model must match real meshes: an open box gives
        // parallax-band texels a degenerate [receding-face → far-scene] column that falsely admits deep rays;
        // closed geometry brackets its interior with consecutive layers (entry face + exit face).
        const boxQuads = (center: Vec3, hx: number, hy: number, hz: number): Quad[] => [
            quad([center[0], center[1], center[2] + hz], [0, 0, 1], hx, hy),
            quad([center[0], center[1], center[2] - hz], [0, 0, 1], hx, hy),
            quad([center[0] + hx, center[1], center[2]], [1, 0, 0], hz, hy),
            quad([center[0] - hx, center[1], center[2]], [1, 0, 0], hz, hy),
            // quad() derives uAxis = Z / vAxis = X for a [0,1,0] normal → extents are (hz, hx) here
            quad([center[0], center[1] + hy, center[2]], [0, 1, 0], hz, hx),
            quad([center[0], center[1] - hy, center[2]], [0, 1, 0], hz, hx),
        ];
        // Thin closed box standing where the heuristic tests put the thin square.
        const thinFront = quad([1.0, 0.8, 0], [0, 0, 1], 0.3, 0.3);
        const thinBuf = makeBuffer(vp, RES, RES, [mirror, ...boxQuads([1.0, 0.8, -0.025], 0.3, 0.3, 0.025)]);
        // Thick closed box for volume sweeps.
        const thickBox = boxQuads([1.0, 0.8, -0.15], 0.3, 0.3, 0.15);
        const boxBack = quad([1.0, 0.8, -0.3], [0, 0, 1], 0.3, 0.3);
        const boxBuf = makeBuffer(vp, RES, RES, [mirror, ...thickBox]);

        it('keeps the thin-object EXACT fill position (parity with the heuristic)', () => {
            const P = thinFront.center;
            const F = analyticFragmentPersp(C, mirror.center, mirror.normal, P);
            const V = norm3(sub3(C, F));
            const R = reflect3(scale3(V, -1), mirror.normal);
            const res = traceSSRRef(F, mirror.normal, R, vp, thinBuf, PEEL);
            expect(res.hit).toBe(true);
            expect(res.backfill).toBe(true);
            expect(res.backfillFade!).toBeGreaterThan(0.8);   // proven member → full strength (no depth feather)
            const expected = projectPoint(vp, P).uv;
            expect(Math.abs(res.uv![0] - expected[0])).toBeLessThan(0.05);
            expect(Math.abs(res.uv![1] - expected[1])).toBeLessThan(0.05);
        });

        // Solidity sweeps run with the edge feather OFF — they measure volume MEMBERSHIP coverage; the feather
        // legitimately dims silhouette-adjacent fills (its job) and would misread as hollowing here.
        const PEEL_NF: SSRTraceParams = { ...PEEL, edgeFeather: 0 };

        it('fills a THICK volume densely head-on (interior coverage, no hollow center)', () => {
            let attempted = 0, got = 0;
            for (let gy = 0; gy <= 24; gy++) {
                for (let gx = 0; gx <= 24; gx++) {
                    const F: Vec3 = [0.4 + (gx / 24) * 0.9, 0.3 + (gy / 24) * 0.9, -2];
                    const V = norm3(sub3(C, F));
                    const R = reflect3(scale3(V, -1), mirror.normal);
                    const a = intersectQuad(boxBack, F, R);   // the mirror sees the box's BACK face first
                    if (!a) continue;
                    const lu = Math.abs(dot3(sub3(a.p, boxBack.center), boxBack.uAxis));
                    const lv = Math.abs(dot3(sub3(a.p, boxBack.center), boxBack.vAxis));
                    if (lu > boxBack.halfU - 0.05 || lv > boxBack.halfV - 0.05) continue;   // skip silhouette grazers
                    attempted++;
                    const res = traceSSRRef(F, mirror.normal, R, vp, boxBuf, PEEL_NF);
                    if (res.hit && (res.backfillFade === undefined || res.backfillFade > 0.7)) got++;
                }
            }
            expect(attempted).toBeGreaterThan(30);
            expect(got / attempted).toBeGreaterThan(0.85);
        });

        it('stays SOLID at a SIDE ANGLE (the hollow-crescent regression that killed guards v2+v3)', () => {
            const eye: Vec3 = [2.5, 0.8, 5];
            const sview = mat4.lookAt(mat4.create(), [2.5, 0.8, 5], [0, 0, 0], [0, 1, 0]);
            const sproj = mat4.perspectiveZO(mat4.create(), (50 * Math.PI) / 180, 1, 0.1, 100);
            const svp = mat4.multiply(mat4.create(), sproj, sview) as Float32Array;
            const sbuf = makeBuffer(svp, RES, RES, [mirror, ...boxQuads([1.0, 0.8, -0.15], 0.3, 0.3, 0.15)]);
            let attempted = 0, got = 0;
            for (let gy = 0; gy <= 12; gy++) {
                for (let gx = 0; gx <= 12; gx++) {
                    const P: Vec3 = [0.72 + (gx / 12) * 0.56, 0.52 + (gy / 12) * 0.56, -0.3];
                    const F = analyticFragmentPersp(eye, mirror.center, mirror.normal, P);
                    if (Math.abs(F[0]) > mirror.halfU || Math.abs(F[1]) > mirror.halfV) continue;
                    attempted++;
                    const V = norm3(sub3(eye, F));
                    const R = reflect3(scale3(V, -1), mirror.normal);
                    const res = traceSSRRef(F, mirror.normal, R, svp, sbuf, PEEL_NF);
                    if (res.hit && (res.backfillFade === undefined || res.backfillFade > 0.7)) got++;
                }
            }
            expect(attempted).toBeGreaterThan(40);
            expect(got / attempted).toBeGreaterThan(0.8);
        });

        it('REJECTS a tangent-skimmer trail ray the heuristic band accepts (the discriminator)', () => {
            // A ray crossing a thin box's footprint 0.11–0.15 BEHIND its front face while the box is only 0.02
            // thick: inside the heuristic band (→ trail fill) but provably OUTSIDE the volume (→ peel rejects).
            // The ray exits the footprint through its TOP edge while still ≥0.07 behind the front face (margin
            // beyond the volume+eps window even under half-texel quantization) — the footprint's side edges would
            // let quantization put the last texel legitimately within eps of the volume.
            const tBuf = makeBuffer(vp, RES, RES, [mirror, ...boxQuads([1.0, 0.8, -1.51], 0.3, 0.3, 0.01)]);
            const F: Vec3 = [1.0, 0.759, -2];
            const R = norm3([0.3, 0.5, 0.6]);   // toCam ≈ 0.72 → backGate fully open
            const heur = traceSSRRef(F, mirror.normal, R, vp, tBuf, PARAMS);
            expect(heur.hit).toBe(true);          // the heuristic paints the trail (dimmed by its feather)…
            expect(heur.backfill).toBe(true);
            const peeled = traceSSRRef(F, mirror.normal, R, vp, tBuf, PEEL);
            expect(peeled.hit).toBe(false);       // …the peel proves the ray never entered the volume
        });

        it('REJECTS a back layer on the REFLECTOR plane (the thin-false-fill-LINE mechanism)', () => {
            // On GPU, an object's exit fragment can be missing at silhouette-edge texels (a nearly edge-on face
            // rasterizes to nothing at half-res) — the second layer there is the MIRROR itself, a degenerate
            // [object-front → mirror] column that admits any deep ray crossing it and paints a thin straight
            // LINE of false fills. A mirror cannot be an object's back face: such back samples must be rejected
            // (the texel falls back to the thickness shell, which deep rays fail).
            const mirrorOnly = makeBuffer(vp, RES, RES, [mirror]);
            const sabotaged: SSRWorldPosBuffer = {
                width: RES, height: RES,
                sample: (px, py) => boxBuf.sample(px, py),
                sampleBack: (px, py) => mirrorOnly.sample(px, py),   // every exit fragment "dropped"
            };
            // Near-view-aligned rays from mirror fragments hidden behind the box's screen footprint — the family
            // that filled through the degenerate column before the closed-box fix, and on GPU paints the lines.
            const starts: Vec3[] = [[1.2, 0.6, -2], [1.35, 0.6, -2], [0.75, 1.05, -2], [0.9, 1.05, -2], [1.05, 1.05, -2], [0.9, 1.2, -2]];
            for (const F of starts) {
                const V = norm3(sub3(C, F));
                const R = reflect3(scale3(V, -1), mirror.normal);
                if (thickBox.some((q) => intersectQuad(q, F, R))) continue;   // only true misses
                expect(traceSSRRef(F, mirror.normal, R, vp, sabotaged, PEEL).hit).toBe(false);
            }
        });

        it('stays dense on a STEEPLY-RECEDING back surface (slope-aware membership tolerance)', () => {
            // The back layer is sampled at texel centers: on a steep back surface the per-texel depth change
            // rivals a fixed tolerance and membership flickers per texel (hatched/serrated fills at oblique
            // views). The tolerance widens with the local back-depth gradient. Rays here hug a slope-2 back
            // face 0.01 inside the volume and never exit through the front — pure membership coverage.
            const wFront = quad([1.0, 0.8, 0], [0, 0, 1], 0.3, 0.3);
            const wBack = quad([1.0, 0.8, -0.7], [0, -0.894, 0.447], 0.3, 0.7);   // z(y) = -0.1 - 2(1.1 - y)
            const wBuf = makeBuffer(vp, RES, RES, [mirror, wFront, wBack]);
            const dir = norm3([0, 1, 2]);   // parallel to the back slope, toward the camera (gate open)
            let attempted = 0, got = 0;
            for (let g = 0; g <= 20; g++) {
                const y0 = 0.55 + (g / 20) * 0.35;
                const z0 = -0.1 - 2.0 * (1.1 - y0) + 0.01;   // 0.01 inside the back surface
                const t0 = (z0 + 2) / dir[2];
                const F: Vec3 = [1.0, y0 - dir[1] * t0, -2];
                attempted++;
                const res = traceSSRRef(F, mirror.normal, dir, vp, wBuf, PEEL_NF);
                if (res.hit && (res.backfillFade === undefined || res.backfillFade > 0.7)) got++;
            }
            expect(attempted).toBeGreaterThan(15);
            expect(got / attempted).toBeGreaterThan(0.9);
        });

        it('REJECTS under-object pass-by rays from an ELEVATED camera (the curtain-smear mechanism)', () => {
            // From a high camera, a ray passing just UNDER an object projects onto the object's lower texels,
            // where the depth column shrinks while the back-layer gradient spikes. An uncapped slope-widened
            // tolerance admitted those rays (tall curtain smears hanging off wall-mirror fills); the widening is
            // clamped to half the local column depth. A genuine volume ray in the same scene must still fill.
            const eye: Vec3 = [0, 2, 6];
            const hview = mat4.lookAt(mat4.create(), [0, 2, 6], [0, 0.3, 0], [0, 1, 0]);
            const hproj = mat4.perspectiveZO(mat4.create(), (50 * Math.PI) / 180, 1, 0.1, 100);
            const hvp = mat4.multiply(mat4.create(), hproj, hview) as Float32Array;
            const hMirror = quad([0, 0, -2], [0, 0, 1], 3, 3);
            const hBox = boxQuads([0, 0.5, -0.5], 0.3, 0.25, 0.25);
            const hBuf = makeBuffer(hvp, RES, RES, [hMirror, ...hBox]);
            const rayThrough = (P: Vec3) => {
                const d = norm3(sub3(eye, P));
                const t = (P[2] + 2) / d[2];
                const F: Vec3 = [P[0] - d[0] * t, P[1] - d[1] * t, -2];
                return traceSSRRef(F, hMirror.normal, d, hvp, hBuf, PEEL_NF);
            };
            expect(rayThrough([0, 0.5, -0.5]).hit).toBe(true);    // control: through the volume center → fills
            expect(rayThrough([0, 0.18, -0.5]).hit).toBe(false);  // 0.07 UNDER the box → provably outside
        });

        it('stays FULL-STRENGTH at a steep mirror angle (the gate that hollow-washed angled fills)', () => {
            // At 30-45° mirror views the reflected rays' toward-camera component lands mid-ramp of the old
            // conservative gate — whole fills went translucent while ungated primary rim hits stayed bright
            // (the "hollow at angles" look). Peel mode arms the gate almost immediately.
            const eye: Vec3 = [5, 0.8, 3.6];
            const aview = mat4.lookAt(mat4.create(), [5, 0.8, 3.6], [0, 0.5, -1], [0, 1, 0]);
            const aproj = mat4.perspectiveZO(mat4.create(), (50 * Math.PI) / 180, 1, 0.1, 100);
            const avp = mat4.multiply(mat4.create(), aproj, aview) as Float32Array;
            const afwd = cameraForwardFromVP(avp);
            const aBuf = makeBuffer(avp, RES, RES, [mirror, ...boxQuads([1.0, 0.8, -0.15], 0.3, 0.3, 0.15)]);
            const P: Vec3 = [1.0, 0.8, -0.3];
            const F = analyticFragmentPersp(eye, mirror.center, mirror.normal, P);
            const V = norm3(sub3(eye, F));
            const R = reflect3(scale3(V, -1), mirror.normal);
            const toCam = -dot3(R, afwd);
            expect(toCam).toBeGreaterThan(0.12);   // precondition: inside the OLD ramp (would have washed out)
            expect(toCam).toBeLessThan(0.45);
            const res = traceSSRRef(F, mirror.normal, R, avp, aBuf, PEEL_NF);
            expect(res.hit).toBe(true);
            expect(res.backfillFade === undefined || res.backfillFade > 0.7).toBe(true);
        });

        it('PRIMARY hits reject OVER-PASSING rays (the debug-confirmed stretched-column ghost)', () => {
            // A shallow away-heading floor ray passing OVER an object still crosses the object's depth column
            // inside its screen silhouette — a front-side sign flip the march accepted as a hit, painting long
            // ray-aligned columns trailing floor reflections (confirmed primary-path via the debug view). The
            // Euclidean crossing validation rejects it: the ray point is offset from the stored surface point
            // by the object's own scale. A genuine volume-crossing ray in the same scene must still hit.
            const iview = mat4.lookAt(mat4.create(), [5, 5, 5], [0, 0, 0], [0, 1, 0]);
            const iproj = mat4.orthoZO(mat4.create(), -3, 3, -3, 3, 0.1, 100);
            const ivp = mat4.multiply(mat4.create(), iproj, iview) as Float32Array;
            const ifwd = cameraForwardFromVP(ivp);
            const ifloor = quad([0, 0, 0], [0, 1, 0], 4, 4);
            const iBox = boxQuads([0, 0.35, 0], 0.25, 0.35, 0.25);
            const iBuf = makeBuffer(ivp, RES, RES, [ifloor, ...iBox]);
            const R = reflect3(ifwd, [0, 1, 0]);
            const over = traceSSRRef([1.6, 0, 1.6], [0, 1, 0], R, ivp, iBuf, PEEL);
            expect(iBox.some((q) => intersectQuad(q, [1.6, 0, 1.6] as Vec3, R))).toBe(false);   // truly misses (0.65 over the top)
            expect(over.hit).toBe(false);
            const legit = traceSSRRef([0.45, 0, 0.2], [0, 1, 0], R, ivp, iBuf, PEEL);
            expect(iBox.some((q) => intersectQuad(q, [0.45, 0, 0.2] as Vec3, R))).toBe(true);   // truly hits (mid side face)
            expect(legit.hit).toBe(true);
        });

        it('rejects over-passers when a stacked object’s back layer DROPS OUT onto the object below', () => {
            // The sphere-on-cube-top regression: where the top object's exit fragments don't rasterize (grazing,
            // subpixel at half-res), the peel's layer 2 falls through to the object BELOW — the column reads
            // [top-object-front → lower-object] and the air gap becomes "interior", feeding the primary march's
            // validation. Modeled by including only the top box's camera-VISIBLE faces in the buffer.
            const iview = mat4.lookAt(mat4.create(), [5, 5, 5], [0, 0, 0], [0, 1, 0]);
            const iproj = mat4.orthoZO(mat4.create(), -3, 3, -3, 3, 0.1, 100);
            const ivp = mat4.multiply(mat4.create(), iproj, iview) as Float32Array;
            const ifwd = cameraForwardFromVP(ivp);
            const ifloor = quad([0, 0, 0], [0, 1, 0], 4, 4);
            const cube = boxQuads([0, 0.35, 0], 0.25, 0.35, 0.25);          // y ∈ [0, 0.7]
            // Top box y ∈ [0.7, 0.9], resting on the cube — VISIBLE faces only (+x, +z, top): its own back
            // layer is absent, so layer 2 at its texels is the cube below (the dropout column).
            const topVisible = [
                quad([0.15, 0.8, 0], [1, 0, 0], 0.15, 0.1),
                quad([0, 0.8, 0.15], [0, 0, 1], 0.15, 0.1),
                quad([0, 0.9, 0], [0, 1, 0], 0.15, 0.15),
            ];
            const dBuf = makeBuffer(ivp, RES, RES, [ifloor, ...cube, ...topVisible]);
            const R = reflect3(ifwd, [0, 1, 0]);
            // Over-passers clearing the stack by 0.15–0.5 — the family that painted the debug-confirmed column.
            for (const fx of [1.2, 1.35, 1.5, 1.7]) {
                const F: Vec3 = [fx, 0, fx];
                const missAll = ![...cube, ...topVisible].some((q) => intersectQuad(q, F, R));
                expect(missAll).toBe(true);
                expect(traceSSRRef(F, [0, 1, 0], R, ivp, dBuf, PEEL).hit).toBe(false);
            }
            // Control: a ray genuinely striking the stack still reflects.
            const legit = traceSSRRef([0.45, 0, 0.2], [0, 1, 0], R, ivp, dBuf, PEEL);
            expect(legit.hit).toBe(true);
        });

        it('keeps GENUINE face reflections at SHALLOW viewing angles (validation must scale with the ray footprint)', () => {
            // At shallow angles the reflected ray covers more WORLD per screen texel, so a genuine hit's bisected
            // crossing sits farther (in world) from the texel-center surface point — pure quantization. A radius
            // scaled only by the SURFACE footprint erodes real face reflections as the camera tilts (the
            // "reflected cube face fades out fast" report). The allowance must include the ray's own footprint.
            const eye: Vec3 = [5, 2.2, 5];   // shallow iso — the angle family where the face faded
            const sview = mat4.lookAt(mat4.create(), [5, 2.2, 5], [0, 0.3, 0], [0, 1, 0]);
            const sproj = mat4.orthoZO(mat4.create(), -3, 3, -3, 3, 0.1, 100);
            const svp = mat4.multiply(mat4.create(), sproj, sview) as Float32Array;
            const sfwd = cameraForwardFromVP(svp);
            const sfloor = quad([0, 0, 0], [0, 1, 0], 4, 4);
            const sCube = boxQuads([0, 0.35, -1.2], 0.25, 0.35, 0.25);
            const sBuf = makeBuffer(svp, RES, RES, [sfloor, ...sCube]);
            let attempted = 0, got = 0;
            for (let gy = 0; gy <= 8; gy++) {
                for (let gx = 0; gx <= 8; gx++) {
                    // Points on the cube's +x and +z faces (the mirror-visible faces at this eye), inset from edges.
                    const P: Vec3 = gy % 2 === 0
                        ? [0.25, 0.1 + (gx / 8) * 0.5, -1.2 - 0.18 + (gy / 8) * 0.36]
                        : [-0.18 + (gx / 8) * 0.36, 0.1 + (gy / 8) * 0.5, -0.95];
                    const F = analyticFragmentOrtho(sfwd, sfloor.center, sfloor.normal, P);
                    const V = scale3(sfwd, -1);
                    const R = reflect3(scale3(V, -1), sfloor.normal);
                    // Only count fragments whose analytic first strike really is this face point (unoccluded).
                    const a = [...sCube].map((q) => intersectQuad(q, F, R)).filter(Boolean) as { t: number; p: Vec3 }[];
                    if (!a.length) continue;
                    const nearest = a.reduce((m, x) => (x.t < m.t ? x : m));
                    if (Math.hypot(nearest.p[0] - P[0], nearest.p[1] - P[1], nearest.p[2] - P[2]) > 0.05) continue;
                    attempted++;
                    if (traceSSRRef(F, sfloor.normal, R, svp, sBuf, PEEL).hit) got++;
                }
            }
            expect(attempted).toBeGreaterThan(20);
            expect(got / attempted).toBeGreaterThan(0.85);
        });

        it('OVERLAPPING solids do not merge into one fat column (no fills between/around the union)', () => {
            // With two intersecting closed meshes, layer 1 and layer 2 at a texel can come from DIFFERENT solids.
            // Second-NEAREST semantics make that mix CONSERVATIVE (the column shrinks to [A-front, B-front], never
            // spans both solids' union) — so overlap must not create fills outside the union silhouette.
            const boxA = boxQuads([0.9, 0.8, -0.15], 0.3, 0.3, 0.15);
            const boxB = boxQuads([1.25, 0.8, -0.2], 0.25, 0.25, 0.2);   // intersects boxA in x and z
            const oBuf = makeBuffer(vp, RES, RES, [mirror, ...boxA, ...boxB]);
            let missExpected = 0, falseHits = 0;
            for (let gy = 0; gy <= 20; gy++) {
                for (let gx = 0; gx <= 20; gx++) {
                    const F: Vec3 = [-1.5 + (gx / 20) * 3.0, -1.5 + (gy / 20) * 3.0, -2];
                    const V = norm3(sub3(C, F));
                    const R = reflect3(scale3(V, -1), mirror.normal);
                    if ([...boxA, ...boxB].some((q) => intersectQuad(q, F, R))) continue;
                    let grazes = false;
                    for (const z of [0, -0.4]) {
                        const tPlane = (z - F[2]) / R[2];
                        if (tPlane <= 0) continue;
                        const pAt = add3(F, scale3(R, tPlane));
                        if (Math.abs(pAt[0] - 1.05) < 0.53 && Math.abs(pAt[1] - 0.8) < 0.38) grazes = true;
                    }
                    if (grazes) continue;
                    missExpected++;
                    if (traceSSRRef(F, mirror.normal, R, vp, oBuf, PEEL).hit) falseHits++;
                }
            }
            expect(missExpected).toBeGreaterThan(100);
            expect(falseHits / missExpected).toBeLessThan(0.01);
        });

        it('does NOT inflate the footprint (missing rays stay misses — exact silhouettes)', () => {
            let missExpected = 0, falseHits = 0;
            for (let gy = 0; gy <= 20; gy++) {
                for (let gx = 0; gx <= 20; gx++) {
                    const F: Vec3 = [-1.5 + (gx / 20) * 3.0, -1.5 + (gy / 20) * 3.0, -2];
                    const V = norm3(sub3(C, F));
                    const R = reflect3(scale3(V, -1), mirror.normal);
                    if (thickBox.some((q) => intersectQuad(q, F, R))) continue;
                    // margin: skip rays grazing within ~2 texels of the silhouette at EITHER face depth
                    let grazes = false;
                    for (const z of [0, -0.3]) {
                        const tPlane = (z - F[2]) / R[2];
                        if (tPlane <= 0) continue;
                        const pAt = add3(F, scale3(R, tPlane));
                        if (Math.abs(pAt[0] - 1.0) < 0.38 && Math.abs(pAt[1] - 0.8) < 0.38) grazes = true;
                    }
                    if (grazes) continue;
                    missExpected++;
                    if (traceSSRRef(F, mirror.normal, R, vp, boxBuf, PEEL).hit) falseHits++;
                }
            }
            expect(missExpected).toBeGreaterThan(100);
            expect(falseHits / missExpected).toBeLessThan(0.01);
        });
    });

    describe('silhouette solidify (ssrFallbackShadow: back-layer hole BORROWING)', () => {
        // edgeFeather 0: the hug ray's anchor sits near the footprint's top edge, where the coverage ring
        // legitimately dims — this suite measures the borrowing mechanics, not the feather.
        const PEEL: SSRTraceParams = { ...PARAMS, depthPeel: true, edgeFeather: 0 };
        // Ortho head-on so a vertical ray projects into ONE texel column — dropout there is forced to matter.
        const oview = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
        const oproj = mat4.orthoZO(mat4.create(), -3, 3, -3, 3, 0.1, 100);
        const ovp = mat4.multiply(mat4.create(), oproj, oview) as Float32Array;
        const oMirror = quad([0, 0, -2], [0, 0, 1], 3, 3);
        const boxQuads2 = (c: Vec3, hx: number, hy: number, hz: number): Quad[] => [
            quad([c[0], c[1], c[2] + hz], [0, 0, 1], hx, hy), quad([c[0], c[1], c[2] - hz], [0, 0, 1], hx, hy),
            quad([c[0] + hx, c[1], c[2]], [1, 0, 0], hz, hy), quad([c[0] - hx, c[1], c[2]], [1, 0, 0], hz, hy),
            quad([c[0], c[1] + hy, c[2]], [0, 1, 0], hz, hx), quad([c[0], c[1] - hy, c[2]], [0, 1, 0], hz, hx),
        ];
        // DEEP box: the hug ray below stays inside the volume its whole footprint crossing (no exit pierce),
        // so its ONLY admission path is inside-sample membership — killable by back-layer dropout.
        // (Box front sits at depth 5.2: the synthetic buffer's view rays start at ndcZ=0.05 ≈ depth 5.1 in
        // orthoZO, so anything nearer never rasterizes into the test buffer.)
        const deepBox = boxQuads2([1.0, 0.8, -0.7], 0.3, 0.15, 0.5);
        const base = makeBuffer(ovp, RES, RES, [oMirror, ...deepBox]);
        // Dropout: the back layer is missing on ODD texel columns (the hug ray's column); EVEN neighbours keep it.
        const holed: SSRWorldPosBuffer = {
            width: RES, height: RES,
            sample: (px, py) => base.sample(px, py),
            sampleBack: (px, py) => (px % 2 === 1 ? null : base.sampleBack!(px, py)),
        };
        const hugDir = norm3([0, 0.5, 0.866]);                 // up + toward camera (gate open), vertical on screen
        const hugF: Vec3 = [1.0, 0.073, -2];                   // enters the volume at depth front+0.8, leaves via the top edge

        it('dropout kills the fill; BORROWING from neighbour columns restores it at slider strength', () => {
            const off = traceSSRRef(hugF, oMirror.normal, hugDir, ovp, holed, PEEL);
            expect(off.hit).toBe(false);                       // strength 0 → membership fails on the dropped column
            const on = traceSSRRef(hugF, oMirror.normal, hugDir, ovp, holed, { ...PEEL, fallbackShadow: 1 });
            expect(on.hit).toBe(true);
            expect(on.shadow).toBe(true);                      // flagged as borrowed-evidence
            expect(on.backfillFade!).toBeGreaterThan(0.5);
            const dim = traceSSRRef(hugF, oMirror.normal, hugDir, ovp, holed, { ...PEEL, fallbackShadow: 0.4 });
            expect(dim.hit).toBe(true);
            expect(dim.backfillFade!).toBeLessThanOrEqual(0.4);   // slider caps borrowed-fill opacity
        });

        it('with an INTACT back layer, borrowing changes nothing (parity)', () => {
            const a = traceSSRRef(hugF, oMirror.normal, hugDir, ovp, base, PEEL);
            const b = traceSSRRef(hugF, oMirror.normal, hugDir, ovp, base, { ...PEEL, fallbackShadow: 1 });
            expect(a.hit).toBe(true);
            expect(b.hit).toBe(true);
            expect(b.shadow ?? false).toBe(false);             // real membership → full-strength fill, no flag
            expect(Math.abs((a.backfillFade ?? 1) - (b.backfillFade ?? 1))).toBeLessThan(1e-6);
        });

        it('deep misses STAY misses with borrowing on (silhouette-exact — no smear family)', () => {
            // A ray passing clearly outside the volume: borrowing must not manufacture membership.
            const missF: Vec3 = [1.0, 0.546, -2];              // same direction, shifted — crosses the footprint beyond the box's back
            const res = traceSSRRef(missF, oMirror.normal, hugDir, ovp, holed, { ...PEEL, fallbackShadow: 1 });
            expect(res.hit).toBe(false);
        });
    });

    it('REACH FADE: hits near the march limit ease out instead of cutting with a hard seam', () => {
        // Same floor scene, but shrink the budget until the hit lands in the fade zone: as maxSteps drops, the
        // crossing sits later in the marched range → reachFade must decline BELOW full strength before the hit is
        // lost entirely (the gradient that replaces the diagonal truncation seam).
        const eye: Vec3 = [0, 1.2, 3];
        const fview = mat4.lookAt(mat4.create(), [0, 1.2, 3], [0, 0.2, -1], [0, 1, 0]);
        const fproj = mat4.perspectiveZO(mat4.create(), (50 * Math.PI) / 180, 1, 0.1, 100);
        const fvp = mat4.multiply(mat4.create(), fproj, fview) as Float32Array;
        const floor = quad([0, 0, -0.5], [0, 1, 0], 4, 4);
        const standee = quad([0, 0.5, -1], [0, 0, 1], 0.35, 0.3);
        const fbuf = makeBuffer(fvp, RES, RES, [floor, standee]);
        const P = standee.center;
        const F = analyticFragmentPersp(eye, floor.center, floor.normal, P);
        const V = norm3(sub3(eye, F));
        const R = reflect3(scale3(V, -1), floor.normal);
        let sawFaded = false;
        for (let steps = 80; steps >= 4; steps = Math.floor(steps * 0.75)) {
            const res = traceSSRRef(F, floor.normal, R, fvp, fbuf, { ...PARAMS, maxSteps: steps });
            if (!res.hit) break;                                    // budget too small → clean miss (cubemap)
            expect(res.reachFade!).toBeGreaterThanOrEqual(0);
            expect(res.reachFade!).toBeLessThanOrEqual(1);
            if (res.reachFade! < 0.9) sawFaded = true;              // the gradient zone was exercised
        }
        expect(sawFaded).toBe(true);
    });
});
