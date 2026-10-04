// ── World generation — KERBS + GUTTERS (city-quality S3 / S14) ───────────────────────────────────
// The pavement stands a kerb height above the carriageway (elevation.makeGroundLevel adds it). This draws what
// makes that read as a street instead of a flat map:
//   · a vertical KERB FACE along every road-facing pavement edge (following the rounded junction corners),
//     dipping to a ~3 cm lip at the DROPPED kerbs behind each zebra crossing;
//   · a granite KERB-TOP strip along the edge (its own surface, so the pavement slabs stop at a real kerb);
//   · a concrete GUTTER channel on the road side, with a steel grate every ~10 m — the darker, glossier band a
//     wet Japanese street shows along its kerbs (S14: done as its own layer/material, no shader change).
// Everything is split on the ground lattice (ground-mesh.ts) so it meets the pavement and road exactly.

import type { LayoutPreviewLayer, V2 } from './types';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import { cityMetresPerUnit, metalScaleFor } from './types';
import { Accum3D } from './meshbuild';
import { signedArea } from './util';
import { cellLevelAt } from './elevation';
import { emitGround, bakedGroundAt, type GroundTess } from './ground-mesh';
import { inShotengaiCells } from './street-layout';
import { METAL_PAINTED } from './palette';
import { edgeChipSpec, EDGE_CHIP_NEAR_M } from './meshbuild';
import { kerbChipTwins, KERB_CHIP_BAND_M, type KerbSeg } from './edge-chips';

const KERB_TOP: [number, number, number] = [0.66, 0.65, 0.62];    // pale granite
const GUTTER: [number, number, number] = [0.36, 0.36, 0.35];      // concrete channel, darker than the pavement
const GRATE: [number, number, number] = [0.20, 0.20, 0.21];       // cast-iron grate

type V3 = [number, number, number];

export function buildKerbs(t: GroundTess): LayoutPreviewLayer[] {
    const graph = t.graph, p = graph.params, D = t.D, gy = p.groundY;
    if (!p.sidewalks || !t.pave.polys.length) return [];
    const faces = new Accum3D();
    const tops: V2[][] = [], gutters: V2[][] = [], grates: V2[][] = [];
    const eps = 0.002 * D.s;
    const sink = 0.012 * D.s;                 // the face runs this far BELOW the road so no gap can open at its foot
    const grateEvery = 10 / cityMetresPerUnit(p.radius), grateLen = 0.6 / cityMetresPerUnit(p.radius);
    // E2 edge wear: collect the face segments + inset top strips for the chipped NEAR twin (edge-chips.ts).
    const chip = edgeChipSpec(p.edgeWear, 1 / cityMetresPerUnit(p.radius), 0x6b3, 2.5);
    const chipSegs: KerbSeg[] = [], topsIn: V2[][] = [];

    t.pave.polys.forEach((poly, k) => {
        const kinds = t.pave.edgeKind[k], n = poly.length;
        const ccw = signedArea(poly) >= 0;
        // Per-edge outward normals + per-vertex MITER offsets (so strips round a filleted corner without wedges).
        const en: V2[] = [];
        for (let i = 0; i < n; i++) {
            const a = poly[i], b = poly[(i + 1) % n], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
            en.push(ccw ? [dz / L, -dx / L] : [-dz / L, dx / L]);
        }
        const miter: V2[] = [];
        for (let i = 0; i < n; i++) {
            const n0 = en[(i - 1 + n) % n], n1 = en[i];
            let mx = n0[0] + n1[0], mz = n0[1] + n1[1];
            const ml = Math.hypot(mx, mz);
            if (ml < 1e-6) { miter.push(n1); continue; }
            mx /= ml; mz /= ml;
            const c = Math.max(0.5, mx * n1[0] + mz * n1[1]);   // 1/cos(half-angle), capped for very sharp corners
            miter.push([mx / c, mz / c]);
        }
        let run = 0;   // distance along road-facing kerb, for grate spacing
        for (let i = 0; i < n; i++) {
            const kind = kinds[i];
            if (kind === 'none') continue;
            const a = poly[i], b = poly[(i + 1) % n], nrm = en[i];
            const mx = (a[0] + b[0]) * 0.5, mz = (a[1] + b[1]) * 0.5;
            const ox = mx + nrm[0] * eps, oz = mz + nrm[1] * eps;
            if (inShotengaiCells(graph, ox, oz) || inShotengaiCells(graph, mx - nrm[0] * eps, mz - nrm[1] * eps)) continue;
            if (t.terraced && cellLevelAt(graph, ox, oz) < 0) continue;   // canal trench: the embankment wall is the edge
            const ma = miter[i], mb = miter[(i + 1) % n];
            const ts = [0, ...t.cuts(a, b), 1];
            const at = (tt: number, w: number): V2 => [
                a[0] + (b[0] - a[0]) * tt + (ma[0] + (mb[0] - ma[0]) * tt) * w,
                a[1] + (b[1] - a[1]) * tt + (ma[1] + (mb[1] - ma[1]) * tt) * w,
            ];
            for (let s = 0; s + 1 < ts.length; s++) {
                const P0 = at(ts[s], 0), P1 = at(ts[s + 1], 0);
                // Heights just inside / outside this edge, at each end (levels, ramps and dropped kerbs vary along it).
                const yIn = (P: V2): number => bakedGroundAt(t, P[0] - nrm[0] * eps, P[1] - nrm[1] * eps, true);
                const yOut = (P: V2): number => bakedGroundAt(t, P[0] + nrm[0] * eps, P[1] + nrm[1] * eps, false);
                const i0 = yIn(P0), i1 = yIn(P1), o0 = yOut(P0), o1 = yOut(P1);
                if (i0 - o0 > D.kerbH * 3 || i1 - o1 > D.kerbH * 3) continue;   // a terrace wall, not a kerb
                const A: V3 = [P0[0], gy + o0 - sink, P0[1]], B: V3 = [P1[0], gy + o1 - sink, P1[1]];
                const Ct: V3 = [P1[0], gy + i1, P1[1]], Dt: V3 = [P0[0], gy + i0, P0[1]];
                faceToward(faces, A, B, Ct, Dt, nrm);
                if (chip) chipSegs.push({ P0, P1, i0, i1, o0, o1, n: nrm });
            }
            // Top strip (inward) + gutter (outward, road only) as ground polygons → split + baked like the pavement.
            tops.push([at(0, 0), at(1, 0), at(1, -D.kerbW), at(0, -D.kerbW)]);
            if (chip) { const c = KERB_CHIP_BAND_M / cityMetresPerUnit(p.radius); topsIn.push([at(0, -c), at(1, -c), at(1, -D.kerbW), at(0, -D.kerbW)]); }
            if (kind === 'road') {
                gutters.push([at(0, 0), at(1, 0), at(1, D.gutterW), at(0, D.gutterW)]);
                const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
                // A grate every ~10 m of kerb (measured continuously round the block so short arc pieces don't all get one).
                let next = grateEvery - (run % grateEvery);
                while (next + grateLen < len) {
                    const t0 = next / len, t1 = (next + grateLen) / len;
                    grates.push([at(t0, D.gutterW * 0.12), at(t1, D.gutterW * 0.12), at(t1, D.gutterW * 0.88), at(t0, D.gutterW * 0.88)]);
                    next += grateEvery;
                }
                run += len;
            }
        }
    });

    const mpu = cityMetresPerUnit(p.radius);
    const out: LayoutPreviewLayer[] = [];
    // Stacking: gutter just over the asphalt (+1 lift), grates over the gutter (+2); the kerb top just over the
    // pavement slabs (+1). All exactly coplanar with what they lie on, so these offsets are the whole separation.
    // ONE kerb layer (granite): the top strips and the vertical faces share the material, so they merge.
    const kerbGeo = mergeGeometry(tops.length ? emitGround(t, tops, { y: gy + D.lift, kerb: true }) : null, faces.empty ? null : faces.geometry());
    if (kerbGeo) out.push({ name: 'world:sidewalks-kerb', color: KERB_TOP, y: gy, drape: 'smooth', geometry: kerbGeo,
        ground: { surface: 'granite', tint: KERB_TOP, tileMm: 900, jitter: 0.2, metersPerUnit: mpu } });
    if (kerbGeo && chip) out.push(...kerbChipTwins(t, out[out.length - 1], chipSegs, topsIn, chip, 1 / mpu, sink, EDGE_CHIP_NEAR_M / mpu,
        [Math.min(1, KERB_TOP[0] * 1.08), Math.min(1, KERB_TOP[1] * 1.08), Math.min(1, KERB_TOP[2] * 1.08)]));
    // The gutter: precast concrete channel units (~1 m joints), a darker, dirtier concrete than the pavement.
    if (gutters.length) out.push({ name: 'world:gutter', color: GUTTER, y: gy, drape: 'smooth',
        geometry: emitGround(t, gutters, { y: gy + D.lift }),
        ground: { surface: 'concrete', tint: GUTTER, tileMm: 1000, weather: 'dirty', metersPerUnit: mpu } });
    if (grates.length) out.push({ name: 'world:gutter-grate', color: GRATE, y: gy, drape: 'smooth',
        geometry: emitGround(t, grates, { y: gy + D.lift * 2 }),
        metal: { ...METAL_PAINTED, tint: GRATE, scale: metalScaleFor(p.radius) } });
    return out;
}

/** A vertical quad a→b (bottom) / c,d (top: c above b, d above a) whose normal faces `n` (layout-plane). */
function faceToward(acc: Accum3D, a: V3, b: V3, c: V3, d: V3, n: V2): void {
    // quad4's normal is (b−a)×(d−a) = the LEFT perpendicular of a→b; flip the winding when that is not `n`.
    const ex = b[0] - a[0], ez = b[2] - a[2];
    if (-ez * n[0] + ex * n[1] >= 0) acc.quad4(a, b, c, d);
    else acc.quad4(b, a, d, c);
}

/** Concatenate two 12-float geometries (either may be null). */
function mergeGeometry(a: MeshGeometry | null, b: MeshGeometry | null): MeshGeometry | null {
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
