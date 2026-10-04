// ── World generation — the railway ARCADE (railway-upgrade.md R3.1, `railViaduct: 'arcade'`) ───────────────────────
// Tokyo's iconic viaduct look (Yurakucho, Koenji, Akihabara): the line runs BESIDE its road over a strip of lots on a
// continuous masonry arcade, and the bays underneath are the city's cheapest, busiest frontage — izakaya with red
// lanterns and noren, little eateries and shops behind glass, bike parking, roller-shuttered storage and fenced
// service bays full of pipes and meters. The street face gets the life; the back face is plain (service doors).
//
// Structure: cross walls every ~10 m (the bay lots claimed by rail-layout.claimViaductLots) carry the deck slab; the
// street face is a brick ARCH arcade (basket arches with a proud voussoir ring and keystone, a barrel vault through
// each bay) or a concrete RECTANGULAR one (lintels + a flat soffit), picked per line. Pilasters and a cornice band
// run along the street face; a thicker end wall closes each run at a cross street (steel plate girders — railway.ts
// — carry the deck over the gap).
//
// Spaces: built in the rigid frame of the WARPED centreline (railFrameAt), like the deck, so the walls meet the slab
// exactly; each bay stands on the ground at its own layout point (elev(rx + offset, z)). Every layer is noWarp +
// BAKED (railway.ts adds both). Deterministic: position / bay hashes only. Chunk-friendly: plain merged layers.
//
// Layer names ↔ tiers (world-manager regexes), on purpose:
//   · world:rail-arc-prop*  — racks, bikes, fences, pipes, meters, menu boards, noren / awning cloth: PROPS
//   · every other world:rail-arc-* (walls, vault, trim, floor, fronts, glass, signs, lanterns): STRUCTURE
//   · lit parts glow by name: '-sign-' (lightboxes + lit lettering), 'lantern', 'lamplights', 'shop-glass' (the
//     shop-interior windows and the izakaya's lit shoji). Lettering INK is 'letter-ink' (never a light).
// One material family per mesh (city-materials.test): each layer carries at most one of pattern / metal.

import type { WorldGraph, LayoutPreviewLayer, ArcadeBayKind } from './types';
import { metalScaleFor } from './types';
import { Accum3D } from './meshbuild';
import { hash2 } from './util';
import { METAL_PAINTED, METAL_GALVANISED } from './palette';
import { emitGlyphRun, signWord, signWordKind, type SignWordKind } from './sign-glyphs';
import { signLum } from './sign-style';
import { emitBikeRack, DEFAULT_BIKE_RACK_PARAMS } from './bike-rack';
import { emitBicycle } from './mannequin';
import { railFrameAt, ARC_M, type RailLayout, type RailFrame, type ArcadeBay } from './rail-layout';
import type { HeightFn } from './elevation';

type V3 = [number, number, number];
type RGB = [number, number, number];

const BRICK: RGB = [0.50, 0.30, 0.24];          // Meiji-era red brick
const BRICK_TRIM: RGB = [0.62, 0.56, 0.48];     // sandstone voussoirs / string courses
const CONC: RGB = [0.60, 0.59, 0.56];           // fair-faced concrete
const CONC_TRIM: RGB = [0.52, 0.51, 0.48];
const VAULT: RGB = [0.36, 0.33, 0.31];
const FLOOR: RGB = [0.46, 0.45, 0.43];
const PAINT: RGB = [0.90, 0.88, 0.80];          // floor paint lines
const TIMBER: RGB = [0.26, 0.17, 0.11];
const SHOJI: RGB = [0.95, 0.86, 0.64];          // lit paper (warm)
const PLASTER: RGB = [0.80, 0.74, 0.62];        // izakaya / eatery front plaster over the sign
const GLASS: RGB = [0.40, 0.48, 0.52];
const FRAME: RGB = [0.62, 0.63, 0.64];          // aluminium shopfront frames
const SHUTTER: RGB = [0.60, 0.61, 0.62];
const PANEL: RGB = [0.40, 0.46, 0.48];
const BACK: RGB = [0.30, 0.32, 0.33];           // back-face service doors / louvres
const LANTERN: RGB = [0.88, 0.20, 0.14];
const LAMP: RGB = [1.0, 0.94, 0.80];
const PROP: RGB = [0.52, 0.54, 0.56];
const FENCE: RGB = [0.56, 0.58, 0.58];
const MENU: RGB = [0.10, 0.12, 0.11];
const TYRE: RGB = [0.07, 0.07, 0.07];
const WARN: RGB = [0.92, 0.76, 0.10];
const TEXT: RGB = [0.98, 0.96, 0.90];
const INK: RGB = [0.10, 0.08, 0.08];

/** Lightbox face colours (a fixed curated set — each is one lit layer). */
const SIGN_FACES: RGB[] = [[0.93, 0.93, 0.90], [0.94, 0.88, 0.72], [0.07, 0.07, 0.08], [0.82, 0.26, 0.17], [0.13, 0.19, 0.40], [0.93, 0.66, 0.18], [0.16, 0.52, 0.44], [0.10, 0.45, 0.80]];
/** Noren / awning cloth colours. */
const CLOTH: RGB[] = [[0.14, 0.18, 0.36], [0.74, 0.14, 0.12], [0.90, 0.88, 0.82], [0.24, 0.40, 0.30]];
const BIKE_FRAMES: RGB[] = [[0.72, 0.72, 0.74], [0.20, 0.30, 0.52], [0.62, 0.16, 0.14], [0.16, 0.16, 0.18]];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A quad whose normal faces `want` (the winding is flipped if needed). */
function faceQuad(acc: Accum3D, a: V3, b: V3, c: V3, d: V3, want: V3): void {
    if (dot(cross(sub(b, a), sub(d, a)), want) >= 0) acc.quad4(a, b, c, d); else acc.quad4(a, d, c, b);
}

/** Sign lettering in METRES (the glyph font's stroke widths / minimums are metric — building signs are authored in
 *  metres), mapped onto a world-space face: centre `c`, unit in-plane axes `right` / `up`, normal `out`, `u` units per
 *  metre. `wM` × `hM` is the lettering box in metres. */
function glyphsM(acc: Accum3D, c: V3, right: V3, up: V3, out: V3, wM: number, hM: number, word: readonly string[], vertical: boolean, weight: number, u: number): void {
    const tmp = new Accum3D();
    emitGlyphRun(tmp, [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], wM, hM, word, vertical, 0.012, weight);
    if (tmp.empty) return;
    const g = tmp.geometry(), v = g.vertices, I = g.indices, ids: number[] = [];
    for (let i = 0; i < v.length; i += 12) {
        const x = v[i] * u, y = v[i + 1] * u, z = v[i + 2] * u, nx = v[i + 3], ny = v[i + 4], nz = v[i + 5];
        ids.push(acc.vertex([c[0] + right[0] * x + up[0] * y + out[0] * z, c[1] + right[1] * x + up[1] * y + out[1] * z, c[2] + right[2] * x + up[2] * y + out[2] * z],
            [right[0] * nx + up[0] * ny + out[0] * nz, right[1] * nx + up[1] * ny + out[1] * nz, right[2] * nx + up[2] * ny + out[2] * nz], v[i + 6], v[i + 7]));
    }
    for (let t = 0; t < I.length; t += 3) acc.triangle(ids[I[t]], ids[I[t + 1]], ids[I[t + 2]]);
}

export interface ArcadeStats { bays: number; kinds: Record<ArcadeBayKind, number>; style: 'brick' | 'concrete' }

/** The arcade under an ARCADE-mode line (R3.1): structure + bay fills, as layers (noWarp / baked added by the caller).
 *  `stats` (optional) receives a summary for tests / the report. */
export function buildArcade(graph: WorldGraph, RL: RailLayout, elev: HeightFn, stats?: ArcadeStats): LayoutPreviewLayer[] {
    const line = RL.line;
    if (line.mode !== 'arcade' || !RL.bays.length) return [];
    const p = graph.params, gy = p.groundY, u = line.unitsPerMetre, M = (m: number): number => m * u;
    const s = line.side;
    const oF = -s * M(ARC_M.centre - ARC_M.front);   // street face (offset along the frame normal)
    const oB = oF + s * M(ARC_M.depth);              // back face
    const ys = line.deckY - M(ARC_M.slab);          // wall tops = the deck soffit
    const brick = hash2(p.seed, 77, 0xb41c) < 0.55;
    const H = (a: number, b: number, salt: number): number => hash2(Math.round(a * 1000), Math.round(b * 1000), (p.seed ^ salt) >>> 0);
    const at = (f: RailFrame, o: number, y: number, t = 0): V3 => [f.x + f.nx * o + f.tx * t, y, f.z + f.nz * o + f.tz * t];
    const gAt = (o: number, z: number): number => gy + elev(line.rx + o, z);

    const A = (): Accum3D => new Accum3D();
    const wall = A(), trim = A(), vault = A(), floor = A(), paint = A(), back = A();
    const plaster = A();
    const timber = A(), shoji = A(), shopGlass = A(), glass = A(), frame = A(), shutter = A(), panel = A();
    const signs = SIGN_FACES.map(() => A()), text = A(), ink = A(), lantern = A(), lamps = A();
    const prop = A(), fence = A(), menu = A(), tyre = A(), warn = A(), stair = A();
    const bikes = BIKE_FRAMES.map(() => A()), cloth = CLOTH.map(() => A());
    const kinds: Record<ArcadeBayKind, number> = { izakaya: 0, eatery: 0, shop: 0, bike: 0, storage: 0, service: 0, station: 0 };

    // ── Walls: a cross wall at every bay boundary; thicker end walls close each run. ──
    const halfWall = (b: ArcadeBay, end: 'a' | 'b'): number => {
        const list = RL.bays.filter(q => q.run === b.run);
        const first = b.i === 0, last = b.i === list.length - 1;
        return M((end === 'a' ? first : last) ? ARC_M.endPier : ARC_M.pier / 2);
    };
    for (let r = 0; r < RL.runs.length; r++) {
        const list = RL.bays.filter(b => b.run === r);
        if (!list.length) continue;
        const bounds = [list[0].za, ...list.map(b => b.zb)];
        bounds.forEach((z, k) => {
            const end = k === 0 || k === bounds.length - 1;
            const th = M(end ? ARC_M.endPier : ARC_M.pier);
            const zc = z + (k === 0 ? th / 2 : k === bounds.length - 1 ? -th / 2 : 0);
            const f = railFrameAt(line, zc);
            const N3: V3 = [f.nx, 0, f.nz], T3: V3 = [f.tx, 0, f.tz];
            const yb = Math.min(gAt(oF, zc), gAt(oB, zc)) - M(0.5);
            wall.obox(at(f, (oF + oB) / 2, (yb + ys) / 2), N3, [0, 1, 0], T3, Math.abs(oB - oF) / 2, (ys - yb) / 2, th / 2);
            // Street-face pilaster (proud 12 cm) + its impost cap, and a bulkhead lamp.
            const yTop = ys - M(0.4);
            wall.obox(at(f, oF - s * M(0.06), (yb + yTop) / 2), N3, [0, 1, 0], T3, M(0.06), (yTop - yb) / 2, th / 2 + M(0.12));
            const yg = gAt(oF, zc);
            lamps.obox(at(f, oF - s * M(0.16), yg + M(3.3)), N3, [0, 1, 0], T3, M(0.05), M(0.09), M(0.14));
        });
    }

    // ── Bays ──
    for (const b of RL.bays) {
        kinds[b.kind]++;
        const zA = b.za + halfWall(b, 'a'), zB = b.zb - halfWall(b, 'b');
        const half = (zB - zA) / 2, zc = (zA + zB) / 2;
        if (half < M(1.5)) continue;
        const f = railFrameAt(line, zc);
        const N3: V3 = [f.nx, 0, f.nz], T3: V3 = [f.tx, 0, f.tz], Y: V3 = [0, 1, 0];
        const OUT: V3 = [-s * f.nx, 0, -s * f.nz];                   // toward the street
        const RIGHT: V3 = [OUT[2], 0, -OUT[0]];                       // the viewer's right, facing the arcade
        const tR = dot(RIGHT, T3) >= 0 ? 1 : -1;                      // +t along the viewer's right?
        const yF = Math.max(gAt(oF, zA), gAt(oF, zB), gAt(oB, zA), gAt(oB, zB)) + M(0.03);
        const yb = Math.min(gAt(oF, zA), gAt(oF, zB), gAt(oB, zA), gAt(oB, zB)) - M(0.5);
        // Opening profile.
        let spring: number, rise: number;
        if (brick) {
            const yc = Math.min(ys - M(0.75), yF + M(5.6));
            rise = Math.min(half, M(2.4)); spring = yc - rise;
            if (spring < yF + M(2.9)) { spring = yF + M(2.9); rise = Math.max(M(0.5), yc - spring); }
        } else { spring = Math.min(ys - M(0.9), yF + M(4.4)); rise = 0; }
        const top = (t: number): number => spring + rise * Math.sqrt(Math.max(0, 1 - (t / half) ** 2));
        const NS = brick ? 14 : 1;
        const ts: number[] = []; for (let i = 0; i <= NS; i++) ts.push(-half + 2 * half * i / NS);
        const oV = oB - s * M(0.45);
        // Front spandrel (street face above the opening).
        for (let i = 0; i < NS; i++) faceQuad(wall, at(f, oF, top(ts[i]), ts[i]), at(f, oF, top(ts[i + 1]), ts[i + 1]), at(f, oF, ys, ts[i + 1]), at(f, oF, ys, ts[i]), OUT);
        // Vault / soffit through the bay.
        for (let i = 0; i < NS; i++) {
            const tm = (ts[i] + ts[i + 1]) / 2, ym = (top(ts[i]) + top(ts[i + 1])) / 2;
            const want: V3 = brick ? [-T3[0] * tm, spring - ym - M(0.01), -T3[2] * tm] : [0, -1, 0];
            faceQuad(vault, at(f, oF, top(ts[i]), ts[i]), at(f, oF, top(ts[i + 1]), ts[i + 1]), at(f, oV, top(ts[i + 1]), ts[i + 1]), at(f, oV, top(ts[i]), ts[i]), want);
        }
        // Back wall (plain) + a steel service door and a louvre on the back face.
        wall.obox(at(f, oB - s * M(0.225), (yb + ys) / 2), N3, Y, T3, M(0.225), (ys - yb) / 2, half + M(0.05));
        const yBk = gAt(oB, zc), dT = (H(zc, 3, 0x0bac) - 0.5) * (half - M(1.2)) * 1.6;
        back.obox(at(f, oB + s * M(0.02), yBk + M(1.05), dT), N3, Y, T3, M(0.03), M(1.05), M(0.5));
        back.obox(at(f, oB + s * M(0.02), yBk + M(2.9), -dT * 0.5), N3, Y, T3, M(0.03), M(0.35), M(0.6));
        // Floor slab.
        floor.obox(at(f, (oF + oV) / 2, yF - M(0.1)), N3, Y, T3, Math.abs(oV - oF) / 2, M(0.1), half);
        // Trim: voussoir ring + keystone (arch) or a lintel beam (concrete); the cornice band under the slab.
        if (brick) {
            const ring = M(0.42), of = oF - s * M(0.05);
            const topR = (t: number): number => spring + (rise + ring) * Math.sqrt(Math.max(0, 1 - (t / (half + ring)) ** 2));
            for (let i = 0; i < NS; i++) {
                const t0 = ts[i], t1 = ts[i + 1], r0 = t0 * (half + ring) / half, r1 = t1 * (half + ring) / half;
                faceQuad(trim, at(f, of, top(t0), t0), at(f, of, top(t1), t1), at(f, of, topR(r1), r1), at(f, of, topR(r0), r0), OUT);
            }
            trim.obox(at(f, oF - s * M(0.08), spring + rise + M(0.2)), N3, Y, T3, M(0.08), M(0.32), M(0.22));   // keystone
            for (const e of [-1, 1]) trim.obox(at(f, oF - s * M(0.07), spring - M(0.1), e * (half + M(0.1))), N3, Y, T3, M(0.07), M(0.12), M(0.28));   // imposts
        } else {
            trim.obox(at(f, oF - s * M(0.08), spring + M(0.22)), N3, Y, T3, M(0.1), M(0.22), half + M(0.2));
        }
        trim.obox(at(f, oF - s * M(0.12), ys - M(0.2)), N3, Y, T3, M(0.12), M(0.2), (b.zb - b.za) / 2 + M(0.02));   // cornice band (continuous)

        // ── The fill (street side) ──
        const oS = oF + s * M(ARC_M.shopSet);
        const salt = Math.round(zc * 997) + b.lot.block * 7;
        const P = (o: number, y: number, t: number): V3 => at(f, o, y, t);
        /** Vertical infill strips in the fill plane from `y0` up to the opening top (over [t0, t1]). */
        const infill = (acc: Accum3D, o: number, y0: number, t0 = -half, t1 = half): void => {
            for (let i = 0; i < NS; i++) {
                const a = Math.max(t0, ts[i]), c = Math.min(t1, ts[i + 1]);
                if (c - a < 1e-6) continue;
                const ya = top(a), yc2 = top(c);
                if (Math.max(ya, yc2) <= y0) continue;
                faceQuad(acc, P(o, y0, a), P(o, y0, c), P(o, Math.max(y0, yc2), c), P(o, Math.max(y0, ya), a), OUT);
            }
        };
        const lightbox = (y0: number, y1: number, w: number, kind: SignWordKind, faceIdx: number, t0 = 0): void => {
            const oc = oS - s * M(0.12);
            signs[faceIdx].obox(P(oc, (y0 + y1) / 2, t0), T3, Y, N3, w / 2, (y1 - y0) / 2, M(0.1));
            const face = SIGN_FACES[faceIdx], word = signWord(salt, Math.max(2, Math.min(5, Math.floor(w / ((y1 - y0) * 1.1)))), false, kind);
            const lit = signLum(face) < 0.5;
            glyphsM(lit ? text : ink, P(oc - s * M(0.1), (y0 + y1) / 2, t0), RIGHT, Y, OUT, w * 0.9 / u, (y1 - y0) * 0.95 / u, word, false, lit ? 1 : 1.25, u);
        };
        const pickFace = (list: number[]): number => list[Math.floor(H(zc, 11, 0x5f1c) * list.length) % list.length];
        const doorLeft = H(zc, 5, 0xd00e) < 0.5;
        const dW = M(1.8), dC = (doorLeft ? -1 : 1) * tR * (half - dW / 2 - M(0.25));   // door centre (t)
        const dA = dC - dW / 2, dB = dC + dW / 2;

        if (b.kind === 'izakaya' || b.kind === 'eatery') {
            const ya = yF + M(2.2);
            // Door: two sliding lattice leaves (lit paper behind), head beam, noren.
            const dH = M(2.0);
            for (const e of [-1, 1]) {
                const lc = dC + e * dW / 4;
                faceQuad(shoji, P(oS + s * M(0.02), yF + M(0.5), lc - dW / 4), P(oS + s * M(0.02), yF + M(0.5), lc + dW / 4), P(oS + s * M(0.02), yF + dH, lc + dW / 4), P(oS + s * M(0.02), yF + dH, lc - dW / 4), OUT);
                timber.obox(P(oS, yF + M(0.25), lc), T3, Y, N3, dW / 4, M(0.25), M(0.03));
                for (let k = 0; k <= 5; k++) timber.obox(P(oS - s * M(0.01), yF + M(0.5) + (dH - M(0.5)) / 2, lc - dW / 4 + k * dW / 10), T3, Y, N3, M(0.015), (dH - M(0.5)) / 2, M(0.02));
            }
            timber.obox(P(oS, yF + dH + M(0.1), dC), T3, Y, N3, dW / 2 + M(0.1), M(0.1), M(0.06));
            // Window part (lit shoji / glass over a timber dado), mullions, head beam.
            const wa = dC > 0 ? -half : dB + M(0.1), wb = dC > 0 ? dA - M(0.1) : half;
            const wlo = Math.min(wa, wb), whi = Math.max(wa, wb);
            if (whi - wlo > M(0.6)) {
                timber.obox(P(oS, yF + M(0.45), (wlo + whi) / 2), T3, Y, N3, (whi - wlo) / 2, M(0.45), M(0.05));
                const wacc = b.kind === 'izakaya' ? shoji : shopGlass;
                const u0 = (salt >>> 0) % 997;
                const q = [P(oS, yF + M(0.9), wlo), P(oS, yF + M(0.9), whi), P(oS, ya, whi), P(oS, ya, wlo)];
                if (b.kind === 'eatery') {
                    if (dot(cross(sub(q[1], q[0]), sub(q[3], q[0])), OUT) >= 0) shopGlass.quadUV4(q[0], q[1], q[2], q[3], [u0, 0], [u0 + 1, 0], [u0 + 1, 1], [u0, 1]);
                    else shopGlass.quadUV4(q[1], q[0], q[3], q[2], [u0, 0], [u0 + 1, 0], [u0 + 1, 1], [u0, 1]);
                } else faceQuad(wacc, q[0], q[1], q[2], q[3], OUT);
                const nm = Math.max(1, Math.round((whi - wlo) / M(0.9)));
                for (let k = 1; k < nm; k++) timber.obox(P(oS - s * M(0.02), (yF + M(0.9) + ya) / 2, wlo + (whi - wlo) * k / nm), T3, Y, N3, M(0.03), (ya - yF - M(0.9)) / 2, M(0.03));
            }
            timber.obox(P(oS, ya + M(0.07), 0), T3, Y, N3, half, M(0.07), M(0.06));
            // Lightbox over the front + timber / plaster infill up to the arch.
            const sy0 = ya + M(0.14), sy1 = sy0 + M(0.55);
            lightbox(sy0, sy1, 2 * half * 0.86, b.kind === 'izakaya' ? 'izakaya' : 'food', b.kind === 'izakaya' ? pickFace([0, 1, 2, 3]) : pickFace([3, 1, 5, 0, 6]));
            infill(plaster, oS + s * M(0.02), sy1);
            timber.obox(P(oS - s * M(0.01), sy1 + M(0.05), 0), T3, Y, N3, half, M(0.05), M(0.03));
            // Noren over the door (3 split panels).
            const cc = cloth[Math.floor(H(zc, 13, 0x2e2e) * 3) % 3];
            if (b.kind === 'izakaya' || H(zc, 17, 0x7070) < 0.5) for (let k = 0; k < 3; k++) {
                const t0 = dA + dW * (k / 3) + M(0.02), t1 = dA + dW * ((k + 1) / 3) - M(0.02);
                faceQuad(cc, P(oS - s * M(0.1), yF + dH + M(0.05), t0), P(oS - s * M(0.1), yF + dH + M(0.05), t1), P(oS - s * M(0.1), yF + dH - M(0.6), t1), P(oS - s * M(0.1), yF + dH - M(0.6), t0), OUT);
            }
            // Red paper lanterns (chōchin) hanging on the arch face, izakaya only (an eatery gets an awning).
            if (b.kind === 'izakaya') for (const e of [-1, 1]) {
                const lt = e * (half - M(0.65));
                const c = P(oF - s * M(0.38), yF + M(2.35), lt);
                lantern.lathe(c, [0, 1, 0], [[0.001 * u, -M(0.26)], [M(0.16), -M(0.22)], [M(0.21), 0], [M(0.16), M(0.22)], [0.001 * u, M(0.26)]], 8, { smooth: true });
                prop.beam(P(oF - s * M(0.38), yF + M(2.61), lt), P(oF - s * M(0.38), yF + M(2.95), lt), M(0.012), 3);
                prop.beam(P(oF - s * M(0.38), yF + M(2.95), lt), P(oF - s * M(0.02), yF + M(2.95), lt), M(0.015), 3);
            } else {
                const ac = cloth[(Math.floor(H(zc, 19, 0x3a3a) * 4) % 4)];
                const y0a = ya + M(0.05), out = M(0.95);
                faceQuad(ac, P(oS - s * M(0.02), y0a + M(0.1), -half + M(0.1)), P(oS - s * M(0.02), y0a + M(0.1), half - M(0.1)), P(oS - s * (M(0.02) + out), y0a - M(0.35), half - M(0.1)), P(oS - s * (M(0.02) + out), y0a - M(0.35), -half + M(0.1)), [OUT[0], 1, OUT[2]]);
            }
            // A vertical (tate) sign on the pilaster, and a menu board beside the door.
            if (H(zc, 23, 0x7a7e) < 0.7) {
                const tb = -tR * (half + M(ARC_M.pier / 2)), fi = pickFace([0, 1, 3, 2]);
                const c = P(oF - s * M(0.42), yF + M(3.3), tb);
                signs[fi].obox(c, T3, Y, N3, M(0.05), M(0.75), M(0.28));
                const lit = signLum(SIGN_FACES[fi]) < 0.5, wd = signWord(salt ^ 0x77, 3, true, b.kind === 'izakaya' ? 'izakaya' : 'food');
                for (const e of [-1, 1]) {
                    const n: V3 = [T3[0] * e, 0, T3[2] * e], r: V3 = [n[2], 0, -n[0]];
                    glyphsM(lit ? text : ink, [c[0] + n[0] * M(0.05), c[1], c[2] + n[2] * M(0.05)], r, Y, n, 0.5, 1.45, wd, true, lit ? 1 : 1.25, u);
                }
            }
            const mt = dC - (dC > 0 ? 1 : -1) * (dW / 2 + M(0.45));
            if (Math.abs(mt) < half - M(0.3)) {
                menu.obox(P(oS - s * M(0.04), yF + M(1.35), mt), T3, Y, N3, M(0.3), M(0.42), M(0.02));
                timber.obox(P(oS - s * M(0.035), yF + M(1.35), mt), T3, Y, N3, M(0.33), M(0.45), M(0.015));
            }
        } else if (b.kind === 'station') {
            // STATION ENTRANCE: an open hall under a lit name band (white, with the line-colour stripe), a row of
            // ticket gates, ticket machines on the side wall and the stair climbing along the back wall up into the
            // viaduct (to the platforms).
            const hH = yF + M(2.8);
            frame.obox(P(oS - s * M(0.05), hH, 0), T3, Y, N3, half, M(0.08), M(0.08));
            const sy0 = hH + M(0.1), sy1 = sy0 + M(0.6);
            signs[0].obox(P(oS - s * M(0.12), (sy0 + sy1) / 2, 0), T3, Y, N3, half * 0.92, (sy1 - sy0) / 2, M(0.1));
            signs[6].obox(P(oS - s * M(0.23), sy0 + M(0.08), 0), T3, Y, N3, half * 0.92, M(0.05), M(0.005));
            infill(glass, oS + s * M(0.02), sy1);
            const oG = oF + s * M(3.0), nG = Math.max(3, Math.floor((2 * half - M(3.2)) / M(0.9)));
            for (let k = 0; k <= nG; k++) {
                const t = -half + M(2.4) + k * (2 * half - M(3.2)) / nG;
                frame.obox(P(oG, yF + M(0.5), t), N3, Y, T3, M(0.6), M(0.5), M(0.08));
                lamps.obox(P(oG - s * M(0.61), yF + M(0.85), t), N3, Y, T3, M(0.005), M(0.06), M(0.05));   // gate indicator
            }
            const mT = -half + M(0.35);
            for (let k = 0; k < 3; k++) {
                const o = oF + s * M(1.0 + k * 0.8);
                frame.obox(P(o, yF + M(0.9), mT), N3, Y, T3, M(0.35), M(0.9), M(0.3));
                signs[0].obox(P(o, yF + M(1.2), mT + M(0.31)), N3, Y, T3, M(0.28), M(0.3), M(0.01));
            }
            const stairO = oV - s * M(0.9), run = 2 * half - M(1.8), rise = Math.max(M(1), top(0) - yF - M(0.3));
            const nSt = Math.max(6, Math.ceil(rise / M(0.18)));
            for (let k = 0; k < nSt; k++) {
                const t = -half + M(0.9) + (k + 0.5) * run / nSt, yt = yF + (k + 1) * rise / nSt;
                if (yt > top(t) - M(0.2)) break;
                stair.obox(P(stairO, (yF + yt) / 2, t * tR), N3, Y, T3, M(0.8), (yt - yF) / 2, run / nSt / 2 + M(0.005));
            }
            prop.beam(P(stairO - s * M(0.8), yF + M(0.9), -half * tR + M(0.9) * tR), P(stairO - s * M(0.8), yF + rise * 0.8 + M(0.9), (-half + M(0.9) + run * 0.8) * tR), M(0.025), 4);
            for (const t of [-half * 0.4, half * 0.4]) lamps.obox(P((oF + oV) / 2 - s * M(1.5), top(t) - M(0.08), t), N3, Y, T3, M(0.6), M(0.03), M(0.05));
        } else if (b.kind === 'shop') {
            const riser = M(0.35), gH = yF + M(2.55);
            frame.obox(P(oS, yF + riser / 2, 0), T3, Y, N3, half, riser / 2, M(0.05));
            const u0 = (salt >>> 0) % 997;
            const q = [P(oS, yF + riser, -half), P(oS, yF + riser, half), P(oS, gH, half), P(oS, gH, -half)];
            if (dot(cross(sub(q[1], q[0]), sub(q[3], q[0])), OUT) >= 0) shopGlass.quadUV4(q[0], q[1], q[2], q[3], [u0, 0], [u0 + 1, 0], [u0 + 1, 1], [u0, 1]);
            else shopGlass.quadUV4(q[1], q[0], q[3], q[2], [u0, 0], [u0 + 1, 0], [u0 + 1, 1], [u0, 1]);
            const nm = Math.max(2, Math.round(2 * half / M(2.4)));
            for (let k = 0; k <= nm; k++) frame.obox(P(oS - s * M(0.03), (yF + gH) / 2, -half + 2 * half * k / nm), T3, Y, N3, M(0.035), (gH - yF) / 2, M(0.04));
            frame.obox(P(oS - s * M(0.03), gH, 0), T3, Y, N3, half, M(0.05), M(0.05));
            // Door: a framed glass leaf, and a pull handle.
            frame.obox(P(oS - s * M(0.05), yF + M(1.05), dC + dW * 0.22), T3, Y, N3, M(0.015), M(0.25), M(0.02));
            const sy0 = gH + M(0.06), sy1 = sy0 + M(0.55);
            lightbox(sy0, sy1, 2 * half * 0.9, signWordKind('', b.district), pickFace([0, 2, 4, 6, 5, 7]));
            infill(glass, oS + s * M(0.02), sy1);
            frame.obox(P(oS - s * M(0.02), sy1 + M(0.04), 0), T3, Y, N3, half, M(0.04), M(0.04));
            if (H(zc, 29, 0xa3a1) < 0.55) {   // a fabric awning under the sign
                const ac = cloth[(Math.floor(H(zc, 31, 0x3b3b) * 4) % 4)], out = M(0.9);
                faceQuad(ac, P(oS - s * M(0.02), gH, -half + M(0.15)), P(oS - s * M(0.02), gH, half - M(0.15)), P(oS - s * (M(0.02) + out), gH - M(0.35), half - M(0.15)), P(oS - s * (M(0.02) + out), gH - M(0.35), -half + M(0.15)), [OUT[0], 1, OUT[2]]);
            }
        } else if (b.kind === 'bike') {
            // Open bay: painted bays on the floor, two rows of hoop racks with parked bicycles, a lit "P" sign.
            const rows = [oF + s * M(2.3), oF + s * M(6.1)];
            const nH = Math.max(2, Math.min(8, Math.floor((2 * half - M(0.8)) / M(0.75))));
            const len = (nH - 1) * M(0.75);
            for (const [ri, ro] of rows.entries()) {
                emitBikeRack(prop, [...P(ro, yF, 0)] as V3, [f.nx, f.nz], { ...DEFAULT_BIKE_RACK_PARAMS, hoops: nH, lengthM: len / u }, u);
                for (let k = 0; k < nH; k++) {
                    const t = -len / 2 + k * M(0.75);
                    faceQuad(paint, P(ro - s * M(0.95), yF + M(0.006), t + M(0.37)), P(ro + s * M(0.95), yF + M(0.006), t + M(0.37)), P(ro + s * M(0.95), yF + M(0.006), t + M(0.41)), P(ro - s * M(0.95), yF + M(0.006), t + M(0.41)), [0, 1, 0]);
                    const hb = H(zc + t, ri, 0xb1ce);
                    if (hb > 0.72) continue;   // an empty stall here and there
                    const fs = hb < 0.36 ? 1 : -1;
                    emitBicycle(bikes[Math.floor(hb * 97) % bikes.length], tyre, { o: P(ro - s * fs * M(0.8), yF, t + M(0.37)), f: [f.nx * s * fs, f.nz * s * fs], u }, { basket: hb < 0.5 });
                }
            }
            const sc = P(oF - s * M(0.12), spring - M(0.45), 0);
            signs[7].obox(sc, T3, Y, N3, M(0.55), M(0.28), M(0.06));
            // "P" pictogram in lit white strokes.
            const g = (a: number, b2: number): V3 => [sc[0] + RIGHT[0] * a + OUT[0] * M(0.07), sc[1] + b2, sc[2] + RIGHT[2] * a + OUT[2] * M(0.07)];
            const bar = (a0: number, b0: number, a1: number, b1: number): void => {
                const dx = a1 - a0, dy = b1 - b0, L = Math.hypot(dx, dy) || 1, w = M(0.035), nx = -dy / L * w, ny = dx / L * w;
                faceQuad(text, g(a0 - nx, b0 - ny), g(a1 - nx, b1 - ny), g(a1 + nx, b1 + ny), g(a0 + nx, b0 + ny), OUT);
            };
            const x0 = -M(0.1);
            bar(x0, -M(0.2), x0, M(0.2)); bar(x0, M(0.2), x0 + M(0.14), M(0.2)); bar(x0 + M(0.14), M(0.2), x0 + M(0.2), M(0.1));
            bar(x0 + M(0.2), M(0.1), x0 + M(0.14), 0); bar(x0 + M(0.14), 0, x0, 0);
            for (const t of [-half * 0.45, half * 0.45]) lamps.obox(P((oF + oV) / 2, top(t) - M(0.08), t), N3, Y, T3, M(0.6), M(0.03), M(0.05));
        } else if (b.kind === 'storage') {
            // Roller shutter down over the opening (its box above), a louvred panel up to the arch.
            const yS = Math.min(top(half * 0.999), yF + M(3.2));
            faceQuad(shutter, P(oF + s * M(0.25), yF, -half), P(oF + s * M(0.25), yF, half), P(oF + s * M(0.25), yS, half), P(oF + s * M(0.25), yS, -half), OUT);
            frame.obox(P(oF + s * M(0.2), yS + M(0.2), 0), T3, Y, N3, half, M(0.2), M(0.14));
            for (const e of [-1, 1]) frame.obox(P(oF + s * M(0.2), (yF + yS) / 2, e * (half - M(0.04))), T3, Y, N3, M(0.04), (yS - yF) / 2, M(0.08));
            infill(panel, oF + s * M(0.3), yS + M(0.4));
            menu.obox(P(oF + s * M(0.2), yF + M(1.6), dC), T3, Y, N3, M(0.22), M(0.15), M(0.01));   // a small owner's plate
        } else {
            // SERVICE bay: a mesh fence + gate across the front; pipes, meters and a cabinet inside; a warning plate.
            const fo = oF + s * M(0.2), fH = M(2.3);
            faceQuad(fence, P(fo, yF, -half), P(fo, yF, half), P(fo, yF + fH, half), P(fo, yF + fH, -half), OUT);
            const nP = Math.max(2, Math.round(2 * half / M(2.0)));
            for (let k = 0; k <= nP; k++) prop.beam(P(fo, yF, -half + 2 * half * k / nP), P(fo, yF + fH + M(0.05), -half + 2 * half * k / nP), M(0.03), 4);
            prop.beam(P(fo, yF + fH, -half), P(fo, yF + fH, half), M(0.022), 4);
            prop.beam(P(fo, yF + M(0.1), -half), P(fo, yF + M(0.1), half), M(0.022), 4);
            warn.obox(P(fo - s * M(0.03), yF + M(1.4), dC), T3, Y, N3, M(0.25), M(0.18), M(0.01));
            // Pipes along one side wall (three runs + a riser), meters on the other, a cabinet at the back.
            const sideT = (doorLeft ? 1 : -1) * (half - M(0.18));
            for (const [k, yy] of [M(2.1), M(2.4), M(2.7)].entries()) prop.beam(P(oF + s * M(0.6), yF + yy, sideT), P(oV - s * M(0.2), yF + yy, sideT), M(0.05 + 0.02 * k), 6);
            prop.beam(P(oV - s * M(0.25), yF, sideT), P(oV - s * M(0.25), yF + M(2.7), sideT), M(0.07), 6);
            for (let k = 0; k < 3; k++) prop.obox(P(oF + s * M(2.0 + k * 1.1), yF + M(1.5), -sideT + (sideT > 0 ? M(0.1) : -M(0.1))), T3, Y, N3, M(0.08), M(0.2), M(0.16));
            prop.obox(P(oV - s * M(0.45), yF + M(0.9), 0), T3, Y, N3, M(0.5), M(0.9), M(0.25));
            lamps.obox(P((oF + oV) / 2, top(0) - M(0.08), 0), N3, Y, T3, M(0.6), M(0.03), M(0.05));
        }
    }

    // ── Emit ──
    const metalScale = metalScaleFor(p.radius);
    const out: LayoutPreviewLayer[] = [];
    const add = (name: string, color: RGB, acc: Accum3D, extra: Partial<LayoutPreviewLayer> = {}): void => {
        if (!acc.empty) out.push({ name, color, y: gy, geometry: acc.geometry(), noWarp: true, drape: 'baked', ...extra });
    };
    const metal = (tint: RGB, recipe = METAL_PAINTED, extra: Partial<NonNullable<LayoutPreviewLayer['metal']>> = {}): Partial<LayoutPreviewLayer> => ({ metal: { ...recipe, tint, scale: metalScale, ...extra } });
    const W = brick ? BRICK : CONC, WT = brick ? BRICK_TRIM : CONC_TRIM;
    const mortar = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
    add('world:rail-arc-wall', W, wall, { pattern: brick ? { color: mortar(BRICK, 1.28), freq: 1 / (0.075 * u), scale: 0.1, mode: 'stripes', angle: 0 } : { color: mortar(CONC, 0.86), freq: 1 / (1.2 * u), scale: 0.03, mode: 'grid' } });
    add('world:rail-arc-trim', WT, trim, { pattern: { color: mortar(WT, 0.84), freq: 1 / (0.45 * u), scale: 0.05, mode: 'grid' } });
    add('world:rail-arc-vault', VAULT, vault, { pattern: brick ? { color: mortar(VAULT, 1.25), freq: 1 / (0.075 * u), scale: 0.1, mode: 'stripes', angle: 1.5708 } : { color: mortar(VAULT, 0.85), freq: 1 / (1.2 * u), scale: 0.03, mode: 'grid' } });
    add('world:rail-arc-floor', FLOOR, floor, { pattern: { color: mortar(FLOOR, 0.88), freq: 1 / (1.0 * u), scale: 0.03, mode: 'grid' } });
    add('world:rail-arc-floor-paint', PAINT, paint);
    add('world:rail-arc-stair', CONC, stair, { pattern: { color: mortar(CONC, 0.8), freq: 1 / (0.5 * u), scale: 0.04, mode: 'grid' } });
    add('world:rail-arc-back', BACK, back, metal(BACK));
    add('world:rail-arc-timber', TIMBER, timber, { pattern: { color: mortar(TIMBER, 0.72), freq: 1 / (0.06 * u), scale: 0.18, mode: 'stripes', angle: 1.5708 } });
    add('world:rail-arc-plaster', PLASTER, plaster, { pattern: { color: [0.62, 0.56, 0.46], freq: 1 / (0.9 * u), scale: 0.05, mode: 'grid' } });
    add('world:rail-arc-shop-glass-shoji', SHOJI, shoji, { emissive: 0.35, pattern: { color: [0.55, 0.40, 0.24], freq: 1 / (0.3 * u), scale: 0.06, mode: 'grid' } });
    add('world:rail-arc-shop-glass', GLASS, shopGlass, { pattern: { color: [0.94, 0.97, 1.0], freq: 1, scale: 0.03, mode: 'windows', angle: 6, spacing: 0.6 }, emissive: 0.12, glass: true });
    add('world:rail-arc-glass', GLASS, glass, { glass: true, emissive: 0.05 });
    add('world:rail-arc-frame', FRAME, frame, metal(FRAME, METAL_GALVANISED, { grime: 0.2 }));
    add('world:rail-arc-shutter', SHUTTER, shutter, { pattern: { color: [0.44, 0.45, 0.47], freq: 1 / (0.08 * u), scale: 0.35, mode: 'stripes', angle: 0 } });
    add('world:rail-arc-panel', PANEL, panel, metal(PANEL, METAL_PAINTED, { streakAmount: 0.5 }));
    const glow = p.nightMode ? 1.1 : 0.6;
    signs.forEach((acc, i) => add('world:rail-arc-sign-' + i, SIGN_FACES[i], acc, { emissive: glow * (signLum(SIGN_FACES[i]) > 0.6 ? 0.72 : 1) }));
    add('world:rail-arc-sign-text', TEXT, text, { emissive: 1.5 });
    add('world:rail-arc-letter-ink', INK, ink, { emissive: 0.05 });
    add('world:rail-arc-lantern', LANTERN, lantern, { emissive: 1.5 });
    add('world:rail-arc-lamplights', LAMP, lamps, { emissive: p.nightMode ? 1.0 : 0.5 });
    // PROPS tier
    add('world:rail-arc-prop', PROP, prop, metal(PROP, METAL_GALVANISED));
    add('world:rail-arc-prop-fence', FENCE, fence, { pattern: { color: [0.30, 0.31, 0.31], freq: 1 / (0.06 * u), scale: 0.5, mode: 'diamonds' }, opacity: 0.75 });
    add('world:rail-arc-prop-menu', MENU, menu, { pattern: { color: [0.80, 0.80, 0.74], freq: 1 / (0.05 * u), scale: 0.12, mode: 'stripes', angle: 0 } });
    add('world:rail-arc-prop-tyre', TYRE, tyre);
    add('world:rail-arc-prop-warn', WARN, warn, { pattern: { color: [0.08, 0.08, 0.08], freq: 1 / (0.08 * u), scale: 0.5, mode: 'stripes', angle: 0.785 } });
    bikes.forEach((acc, i) => add('world:rail-arc-prop-bike-' + i, BIKE_FRAMES[i], acc, metal(BIKE_FRAMES[i], METAL_PAINTED, { roughness: 0.3, grime: 0.1 })));
    cloth.forEach((acc, i) => add('world:rail-arc-prop-cloth-' + i, CLOTH[i], acc));
    if (stats) { stats.bays = RL.bays.length; stats.kinds = kinds; stats.style = brick ? 'brick' : 'concrete'; }
    return out;
}
