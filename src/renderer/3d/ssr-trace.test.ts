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
    return {
        width, height,
        sample(px: number, py: number): Vec3 | null {
            const u = (px + 0.5) / width, v = (py + 0.5) / height;
            const ndcX = u * 2 - 1, ndcY = 1 - 2 * v;
            const p0 = unproject(ndcX, ndcY, 0.05);
            const p1 = unproject(ndcX, ndcY, 0.95);
            const rd = norm3(sub3(p1, p0));
            let best: { t: number; p: Vec3 } | null = null;
            for (const q of quads) {
                const h = intersectQuad(q, p0, rd);
                if (h && (!best || h.t < best.t)) best = h;
            }
            return best ? best.p : null;
        },
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

const PARAMS: SSRTraceParams = { maxSteps: 80, stride: 0.08, thickness: 0.15 };
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

    it('a WALL MIRROR falls back cleanly (back-side crossings rejected — no ghost, no garbage)', () => {
        // A wall-mirror ray reaches an object between camera and mirror from BEHIND — the face it should show (the
        // mirror-facing side) was never rendered. The front-side-crossing rule rejects the back-exit ghost, so wall
        // mirrors get the cubemap fallback (true mirrors are the planar-reflection feature's job).
        const P = square.center;
        const F = analyticFragmentPersp(C, mirror.center, mirror.normal, P);
        const res = traceFrom(F, mirror.normal, C);
        expect(res.hit).toBe(false);
    });

    it('moving the object moves the reflection the SAME lateral direction (mirror optics)', () => {
        const P1: Vec3 = [1.0, 0.8, 0];
        const P2: Vec3 = [1.2, 0.8, 0];   // object moves right (+x)
        const F1 = analyticFragmentPersp(C, mirror.center, mirror.normal, P1);
        const F2 = analyticFragmentPersp(C, mirror.center, mirror.normal, P2);
        expect(F2[0]).toBeGreaterThan(F1[0]);   // fragment moves right too — parallel motion does NOT flip
    });

    it('wall-mirror sweep produces ZERO hits (the whole back-exit family is rejected)', () => {
        let hits = 0;
        for (let gy = 0; gy <= 20; gy++) {
            for (let gx = 0; gx <= 20; gx++) {
                const F: Vec3 = [0.2 + (gx / 20) * 1.4, 0.1 + (gy / 20) * 1.2, -2];
                if (traceFrom(F, mirror.normal, C).hit) hits++;
            }
        }
        expect(hits).toBe(0);
    });

    it('wall-mirror dense sweep also stays at zero (no partial back-exit leakage)', () => {
        let attempted = 0, got = 0;
        for (let gy = 0; gy <= 24; gy++) {
            for (let gx = 0; gx <= 24; gx++) {
                const F: Vec3 = [0.4 + (gx / 24) * 0.9, 0.3 + (gy / 24) * 0.9, -2];
                const V = norm3(sub3(C, F));
                const R = reflect3(scale3(V, -1), mirror.normal);
                if (!intersectQuad(square, F, R)) continue;
                attempted++;
                if (traceFrom(F, mirror.normal, C).hit) got++;
            }
        }
        expect(attempted).toBeGreaterThan(30);
        expect(got).toBe(0);
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

    it('ortho tilted WALL mirror also falls back cleanly (back-exit rejected)', () => {
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
        // A wall-mirror-style reflector reaches the target's camera-facing face from BEHIND → back-exit rejected →
        // clean cubemap fallback (planar reflections are the true-mirror feature).
        expect(res.hit).toBe(false);
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
