// ── World generation — E2 EDGE CHIPS for the kerbs (persona-polish-plan.md E2) ─────────────────────────────
// The kerb's NEAR twin: the same kerb as kerbs.ts builds (granite top strip + vertical face), but the top strip stops
// a few centimetres short of the arris and the front band + the top of the face are rebuilt by `chipExtrude` with
// position-hashed notches / bites and a worn band (its own lighter layer). The clean kerb layer becomes the FAR twin,
// so near chunks show the chips and far ones the original geometry (LayoutPreviewLayer.nearTwin).
//
// UVs are matched to the clean kerb on purpose: the band's top uses the city ground's uv = worldXZ x 0.5 (so the
// granite tiles run on across the band), and the rebuilt face uses quad4's convention (u along the segment from its
// start, v up from the face's foot) — swapping twins at the near distance never jumps the stone pattern.

import type { LayoutPreviewLayer, V2 } from './types';
import { Accum3D, chipExtrude, type ChipSpec } from './meshbuild';
import { emitGround, type GroundTess } from './ground-mesh';

type V3 = [number, number, number];

/** One kerb-face sub-segment as kerbs.ts built it: layout ends, the pavement-side (i) and road-side (o) baked
 *  heights at each end (above groundY), and the outward (road-side) normal. */
export interface KerbSeg { P0: V2; P1: V2; i0: number; i1: number; o0: number; o1: number; n: V2 }

/** The chipped band's width on the kerb top (metres): the top strip is inset by this in the near twin. */
export const KERB_CHIP_BAND_M = 0.05;

/**
 * Build the kerb near twin + its wear layer from the segments / inset top strips kerbs.ts collected, and mark `far`
 * (the clean kerb layer) as the far twin. `m` = world units per metre, `sink` = how far the face runs below the road.
 */
export function kerbChipTwins(t: GroundTess, far: LayoutPreviewLayer, segs: KerbSeg[], topsInset: V2[][], spec: ChipSpec,
    m: number, sink: number, dist: number, wearTint: [number, number, number]): LayoutPreviewLayer[] {
    const gy = t.graph.params.groundY, lift = t.D.lift;
    const main = new Accum3D(), wear = new Accum3D();
    const band = KERB_CHIP_BAND_M * m;
    const up: V3 = [0, 1, 0];
    for (const sg of segs) {
        const h0 = sg.i0 - sg.o0, h1 = sg.i1 - sg.o1;
        if (!(h0 > 0) || !(h1 > 0)) continue;
        const A: V3 = [sg.P0[0], gy + sg.i0 + lift, sg.P0[1]], B: V3 = [sg.P1[0], gy + sg.i1 + lift, sg.P1[1]];
        const d: V3 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], L = Math.hypot(d[0], d[1], d[2]);
        if (L < 1e-9) continue;
        const fh = Math.max(0.004 * m, Math.min(0.06 * m, 0.7 * Math.min(h0, h1)));   // how much of the face the chips may eat
        const foot0 = gy + sg.o0 - sink, foot1 = gy + sg.o1 - sink;
        // The face below the chipped band: a plain quad (u along, v up from the foot — quad4's convention).
        faceToward(main, [A[0], foot0, A[2]], [B[0], foot1, B[2]], [B[0], B[1] - fh, B[2]], [A[0], A[1] - fh, A[2]], sg.n);
        // faceToward starts the quad at B when it has to flip the winding — follow it so u / v match the clean face.
        const flip = -(B[2] - A[2]) * sg.n[0] + (B[0] - A[0]) * sg.n[1] < 0;
        const uvAt = (p: V3, nn: V3, s: number): [number, number] => Math.abs(nn[1]) > 0.5 ? [p[0] * 0.5, p[2] * 0.5]
            : flip ? [L - s, p[1] - foot1] : [s, p[1] - foot0];
        chipExtrude(main, A, [d[0] / L, d[1] / L, d[2] / L], [-sg.n[0], 0, -sg.n[1]], up, L, [[band, 0], [0, 0], [0, -fh]], {
            chip: [false, true, false], spec: fh >= 0.012 * m ? spec : null, wear, endChips: [false, false], uvAt });
    }
    const top = topsInset.length ? emitGround(t, topsInset, { y: gy + lift, kerb: true }) : null;
    const nearGeo = mergeGeometry(top, main.empty ? null : main.geometry());
    if (!nearGeo) return [];
    const key = 'kerb';
    far.nearTwin = { key, role: 'far', dist };
    const out: LayoutPreviewLayer[] = [{ ...far, geometry: nearGeo, nearTwin: { key, role: 'near', dist } }];
    if (!wear.empty) out.push({ ...far, name: far.name + '-wear', color: wearTint, geometry: wear.geometry(),
        ground: far.ground ? { ...far.ground, tint: wearTint } : undefined, nearTwin: { key, role: 'near', dist } });
    return out;
}

/** A vertical quad a→b (bottom) / c,d (top) whose normal faces `n` (layout plane) — kerbs.ts's faceToward. */
function faceToward(acc: Accum3D, a: V3, b: V3, c: V3, d: V3, n: V2): void {
    const ex = b[0] - a[0], ez = b[2] - a[2];
    if (-ez * n[0] + ex * n[1] >= 0) acc.quad4(a, b, c, d);
    else acc.quad4(b, a, d, c);
}

function mergeGeometry(a: LayoutPreviewLayer['geometry'] | null, b: LayoutPreviewLayer['geometry'] | null): LayoutPreviewLayer['geometry'] | null {
    if (!a || !a.indices.length) return b && b.indices.length ? b : null;
    if (!b || !b.indices.length) return a;
    const nA = a.vertices.length / 12;
    const vertices = new Float32Array(a.vertices.length + b.vertices.length);
    vertices.set(a.vertices); vertices.set(b.vertices, a.vertices.length);
    const indices = new Uint32Array(a.indices.length + b.indices.length);
    indices.set(a.indices);
    for (let i = 0; i < b.indices.length; i++) indices[a.indices.length + i] = b.indices[i] + nA;
    return { vertices, indices, format: '12float' };
}
