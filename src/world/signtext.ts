// ── World generation — real TEXT signs ──────────────────────────────────────────────────────────
// Landmark name plates + the shotengai arch boards become REAL TEXT: this module computes the sign SPECS
// (label, world placement, quad geometry with 0..1 UVs); the WorldManager rasterizes each label to a small
// canvas and binds it as the mesh texture (browser-side — headless builds just show the plate colour).
// Shop blade signs stay coloured rectangles for now (hundreds of them → needs a texture atlas later).

import type { WorldGraph, LayoutPreviewLayer, V2, LandmarkType } from './types';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import { FLOATS_PER_VERT } from '../renderer/3d/mesh-generators';
import { centroid, frontageEdge, hash2 } from './util';
import { makeElevation } from './elevation';

type V3 = [number, number, number];

export interface TextSignSpec { label: string; layer: LayoutPreviewLayer; }

const LANDMARK_LABEL: Record<LandmarkType, string> = {
    cityhall: 'CITY HALL', station: 'STATION', museum: 'MUSEUM', hospital: 'HOSPITAL', shrine: 'SHRINE',
    radiotower: 'BROADCAST', postoffice: 'POST OFFICE', stadium: 'STADIUM', powerplant: 'POWER PLANT',
    megatower: 'NEXUS TOWER', school: 'SCHOOL',
};
const PLATE: [number, number, number] = [0.16, 0.17, 0.22];   // dark plate (warm-white text rasterized on top)

/** A TWO-FACED vertical sign plate centred at `c`, spanning ±hw along `eDir`, ±hh vertically, facing
 *  `outward`. Two slightly separated quads: the back face's U runs mirrored, so the TEXT READS CORRECTLY
 *  FROM BOTH SIDES (a single double-sided quad shows mirror-writing from behind — the ИOITATƧ bug).
 *  v = 0 at the TOP, matching image row order. */
function signQuad(c: V3, eDir: V2, outward: V2, hw: number, hh: number): MeshGeometry {
    const n: V3 = [outward[0], 0, outward[1]];
    const px = eDir[0] * hw, pz = eDir[1] * hw;
    // ★ Half-thickness. This was hh * 0.06 — about 1.8 cm on a shop sign, which z-fights at city viewing
    // distance and lets the MIRRORED back face win, producing the "JOOHOS" mirror-writing. The faces are
    // also culled now (layer `singleSided`), so this only has to survive depth precision, not correctness.
    const t = Math.max(4e-4, hh * 0.22);
    const face = (side: 1 | -1): [V3, number, number][] => {
        const ox = n[0] * t * side, oz = n[2] * t * side;
        const u0 = side > 0 ? 0 : 1, u1 = 1 - u0;   // mirrored U on the back face
        return [
            [[c[0] - px + ox, c[1] - hh, c[2] - pz + oz], u0, 1], [[c[0] + px + ox, c[1] - hh, c[2] + pz + oz], u1, 1],
            [[c[0] + px + ox, c[1] + hh, c[2] + pz + oz], u1, 0], [[c[0] - px + ox, c[1] + hh, c[2] - pz + oz], u0, 0],
        ];
    };
    const vertices = new Float32Array(8 * FLOATS_PER_VERT);
    let o = 0;
    for (const side of [1, -1] as const) {
        for (const [p, u, v] of face(side)) {
            vertices[o++] = p[0]; vertices[o++] = p[1]; vertices[o++] = p[2];
            vertices[o++] = n[0] * side; vertices[o++] = n[1]; vertices[o++] = n[2] * side;
            vertices[o++] = u; vertices[o++] = v;
            vertices[o++] = eDir[0] * side; vertices[o++] = 0; vertices[o++] = eDir[1] * side; vertices[o++] = 1;
        }
    }
    // Front face wound toward +n, back face toward −n.
    return { vertices, indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6]), format: '12float' };
}

/** Sign specs for a graph: one name plate per landmark entrance + the shotengai arch boards. */
export function computeTextSigns(graph: WorldGraph): TextSignSpec[] {
    const p = graph.params, gy = p.groundY, s = p.radius / 10;
    const out: TextSignSpec[] = [];
    const elev = makeElevation(graph);   // plates bake the same anchor lift as their (rigid) buildings

    for (const lm of graph.landmarks) {
        const foot = lm.footprint; if (foot.length < 3) continue;
        // frontage direction (longest edge) + outward, mirroring landmarks.ts
        let a = foot[0], b = foot[1], len = 0;
        for (let i = 0; i < foot.length; i++) { const q = foot[i], w = foot[(i + 1) % foot.length], l = Math.hypot(w[0] - q[0], w[1] - q[1]); if (l > len) { len = l; a = q; b = w; } }
        if (len < 1e-4) continue;
        const eDir: V2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
        let outward: V2 = [-eDir[1], eDir[0]];
        const c = centroid(foot), mid: V2 = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
        if ((mid[0] - c[0]) * outward[0] + (mid[1] - c[1]) * outward[1] < 0) outward = [-outward[0], -outward[1]];
        const pos: V3 = [mid[0] + outward[0] * 0.02 * s, gy + elev(lm.center[0], lm.center[1]) + 0.36 * s, mid[1] + outward[1] * 0.02 * s];
        out.push({
            label: LANDMARK_LABEL[lm.type],
            layer: { name: 'world:textsign-lm' + lm.id, color: PLATE, y: gy, geometry: signQuad(pos, eDir, outward, Math.min(len * 0.3, 0.22 * s), 0.045 * s), emissive: 0.85, singleSided: true },
        });
    }

    // SHOP LABELS: one named shop per commercial-ish block (capped) — a small text plate above its door, and the
    // kind is stamped onto the lot (`lot.shopType`) so the future NPC-schedule sim knows where the bakery is.
    const SHOPS = ['BAKERY', 'GROCER', 'CAFE', 'BOOKS', 'RAMEN', 'FLOWERS', 'CLINIC', 'BARBER', 'PHARMACY', 'HARDWARE', 'SUSHI', 'RECORDS', 'LAUNDRY', 'DELI', 'TEA HOUSE', 'ARCADE'];
    let shopCount = 0;
    for (const b of graph.blocks) {
        if (shopCount >= 40) break;
        if (b.zone !== 'commercial' && b.district !== 'market') continue;
        const lot = graph.lots.find(l => l.block === b.id && l.slot === 'building');
        if (!lot) continue;
        const foot = lot.poly.map(pt => [pt[0] + (lot.center[0] - pt[0]) * 0.12, pt[1] + (lot.center[1] - pt[1]) * 0.12] as V2);
        if (foot.length < 3) continue;
        const bc = centroid(b.poly);
        const fr = frontageEdge(foot, bc, hash2(lot.center[0] * 991, lot.center[1] * 761, p.seed) * 100);
        if (fr.len < 0.1 * s) continue;
        const eDir: V2 = [(fr.b[0] - fr.a[0]) / fr.len, (fr.b[1] - fr.a[1]) / fr.len];
        let outward: V2 = [-eDir[1], eDir[0]];
        const mid: V2 = [(fr.a[0] + fr.b[0]) * 0.5, (fr.a[1] + fr.b[1]) * 0.5];
        const lc = centroid(foot);
        if ((mid[0] - lc[0]) * outward[0] + (mid[1] - lc[1]) * outward[1] < 0) outward = [-outward[0], -outward[1]];
        const label = SHOPS[(hash2(b.id * 17.3, lot.center[0] * 7.7 + lot.center[1] * 3.1, (p.seed ^ 0x5109) >>> 0) * SHOPS.length) | 0];
        lot.shopType = label;
        const pos: V3 = [mid[0] + outward[0] * 0.014 * s, gy + elev(lot.center[0], lot.center[1]) + Math.min(0.19 * s, (lot.builtH ?? 0.4 * s) * 0.82), mid[1] + outward[1] * 0.014 * s];
        out.push({
            label,
            layer: { name: 'world:textsign-shop' + shopCount, color: [0.13, 0.14, 0.18], y: gy, geometry: signQuad(pos, eDir, outward, Math.min(fr.len * 0.28, 0.09 * s), 0.02 * s), emissive: 0.9, singleSided: true },
        });
        shopCount++;
    }

    // STREET NAME PLATES: a small green dual-blade sign at ~every 3rd junction corner (grid cities) — the
    // vertical street is a numbered AVE (by column), the horizontal a tree-name ST (by row). Mounted at the
    // same curb corner the street-light pole occupies, so it reads as mounted street furniture.
    if (p.pattern === 'grid') {
        const AVES = ['1ST AVE', '2ND AVE', '3RD AVE', '4TH AVE', '5TH AVE', '6TH AVE', '7TH AVE', '8TH AVE', '9TH AVE', '10TH AVE', '11TH AVE', '12TH AVE'];
        const STS = ['OAK ST', 'ELM ST', 'MAPLE ST', 'CHERRY ST', 'PINE ST', 'CEDAR ST', 'BIRCH ST', 'WILLOW ST', 'ASPEN ST', 'HOLLY ST', 'LAUREL ST', 'ROWAN ST'];
        const R = p.radius, cw = 2 * R / Math.max(2, p.gridCols), ch = 2 * R / Math.max(2, p.gridRows);
        let nPlates = 0;
        for (let ii = 0; ii < graph.intersections.length && nPlates < 12; ii++) {
            if (hash2(ii * 7.3, 11, (p.seed ^ 0x57ee) >>> 0) > 0.34) continue;   // ~every 3rd junction
            const it = graph.intersections[ii];
            if (it.type !== 'cross') continue;
            const col = Math.round((it.pos[0] + R) / cw), row = Math.round((it.pos[1] + R) / ch);
            const corner: V2 = [it.pos[0] + p.streetWidth * 0.62, it.pos[1] + p.streetWidth * 0.62];
            const lift = elev(corner[0], corner[1]);
            // Two perpendicular plates on one corner: the AVE plate faces along X, the ST plate along Z.
            out.push({
                label: AVES[((col % AVES.length) + AVES.length) % AVES.length],
                layer: { name: 'world:textsign-ave' + nPlates, color: [0.10, 0.32, 0.20], y: gy, geometry: signQuad([corner[0], gy + lift + 0.15 * s, corner[1]], [0, 1], [1, 0], 0.032 * s, 0.011 * s), emissive: 0.7, singleSided: true },
            });
            out.push({
                label: STS[((row % STS.length) + STS.length) % STS.length],
                layer: { name: 'world:textsign-st' + nPlates, color: [0.10, 0.32, 0.20], y: gy, geometry: signQuad([corner[0], gy + lift + 0.125 * s, corner[1]], [1, 0], [0, 1], 0.032 * s, 0.011 * s), emissive: 0.7, singleSided: true },
            });
            nPlates++;
        }
    }

    const sg = graph.shotengai;
    if (sg) {
        const dx = sg.spine[1][0] - sg.spine[0][0], dz = sg.spine[1][1] - sg.spine[0][1], L = Math.hypot(dx, dz) || 1;
        const axis: V2 = [dx / L, dz / L], perp: V2 = [-axis[1], axis[0]];
        const R = p.radius, cw = 2 * R / p.gridCols, ch = 2 * R / p.gridRows;
        for (const sign of [-1, 1]) {
            const e = sign < 0 ? sg.spine[0] : sg.spine[1];
            const ax2 = e[0] + axis[0] * (cw * 0.5) * sign, az2 = e[1] + axis[1] * (ch * 0.5) * sign;
            const pos: V3 = [ax2, gy + elev(ax2, az2) + 0.62 * (p.radius / 10) * 0.82, az2];
            const face: V2 = [axis[0] * sign, axis[1] * sign];
            out.push({
                label: 'MARKET ST',
                layer: { name: 'world:textsign-sg' + (sign < 0 ? 'a' : 'b'), color: [0.72, 0.16, 0.14], y: gy, geometry: signQuad(pos, perp, face, sg.width * 0.34, 0.05 * s), emissive: 0.9, singleSided: true },
            });
        }
    }
    return out;
}
