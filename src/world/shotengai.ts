// ── World generation — shotengai (pedestrian shopping street) ────────────────────────────────────
// A special zone in the MARKET district: a run of grid cells turned into a car-free corridor with brick
// paving, a torii-like ENTRY ARCH at each end, a row of covered MARKET STALLS down both sides, and banners
// strung overhead — the Yanaka-Ginza look. `placeShotengai` picks the run + tags its lots (so normal
// buildings skip the corridor; the flanking blocks stay as the shops behind the stalls). Grid only.

import type { WorldGraph, LayoutPreviewLayer, V2, Shotengai, Block } from './types';
import { makeRng, Rng, hash2 } from './util';
import { polysToGeometry } from './preview';
import { Accum3D } from './meshbuild';

type V3 = [number, number, number];

const PAVING: [number, number, number] = [0.60, 0.48, 0.40];   // warm brick paving
const STRUCT: [number, number, number] = [0.26, 0.22, 0.19];   // dark timber (counters / posts / arch frame)
const LANTERN: [number, number, number] = [0.86, 0.22, 0.17];  // red paper lantern (chōchin), glows
const FABRIC: [number, number, number][] = [[0.80, 0.26, 0.22], [0.86, 0.76, 0.56], [0.28, 0.46, 0.66], [0.36, 0.55, 0.40]];   // awnings / banners / sign
const NAMES = ['red', 'cream', 'blue', 'green'];

/** Pick a straight run of market/commercial cells → the pedestrian street. Tags the run's lots so buildings skip them. */
export function placeShotengai(graph: WorldGraph): Shotengai | null {
    const p = graph.params;
    if (p.pattern !== 'grid' || !(p.shotengai ?? true)) return null;
    const rng = makeRng((p.seed ^ 0x54071a) >>> 0);
    const R = p.radius, cols = p.gridCols, rows = p.gridRows, cw = 2 * R / cols, ch = 2 * R / rows;
    const x0 = (c: number): number => -R + c * cw, y0 = (r: number): number => -R + r * ch;
    const byCell = new Map<string, Block>();
    for (const b of graph.blocks) byCell.set(b.sector + ',' + b.ring, b);
    const claimed = new Set(graph.landmarks.map(l => l.block));
    const usable = (ci: number, ri: number): Block | null => { const b = byCell.get(ci + ',' + ri); return b && b.zone !== 'water' && b.level !== -1 && !claimed.has(b.id) ? b : null; };
    const pool = graph.blocks.filter(b => (b.district === 'market' || b.zone === 'commercial') && usable(b.sector, b.ring));
    if (!pool.length) return null;
    const market = pool.filter(b => b.district === 'market');
    const starts = (market.length ? market : pool).slice().sort((a, b) => hash2(a.sector, a.ring, p.seed) - hash2(b.sector, b.ring, p.seed));

    for (const start of starts) {
        for (const dir of (rng.next() < 0.5 ? [[1, 0], [0, 1]] : [[0, 1], [1, 0]]) as [number, number][]) {
            const cells: [number, number][] = [];
            let ci = start.sector, ri = start.ring;
            while (cells.length < 5 && usable(ci, ri)) { cells.push([ci, ri]); ci += dir[0]; ri += dir[1]; }
            if (cells.length < 3) continue;
            const s0 = cells[0], sN = cells[cells.length - 1];
            const spine: [V2, V2] = [[x0(s0[0]) + cw * 0.5, y0(s0[1]) + ch * 0.5], [x0(sN[0]) + cw * 0.5, y0(sN[1]) + ch * 0.5]];
            const runIds = new Set(cells.map(c => byCell.get(c[0] + ',' + c[1])!.id));
            for (const lot of graph.lots) if (runIds.has(lot.block)) lot.slot = 'shotengai';
            return { cells, spine, width: dir[0] ? ch : cw, region: byCell.get(s0[0] + ',' + s0[1])!.region ?? -1 };
        }
    }
    return null;
}

/** Is a world point inside one of the shotengai's cells? Road paint / signals / cars keep OUT of the corridor. */
export function inShotengai(graph: WorldGraph, x: number, z: number): boolean {
    const sg = graph.shotengai; if (!sg) return false;
    const R = graph.params.radius, cw = 2 * R / graph.params.gridCols, ch = 2 * R / graph.params.gridRows;
    for (const [ci, ri] of sg.cells) {
        const x0 = -R + ci * cw, z0 = -R + ri * ch;
        if (x >= x0 && x <= x0 + cw && z >= z0 && z <= z0 + ch) return true;
    }
    return false;
}

/** Render the shotengai (paving + stalls + banners + entry arches). Region-filterable. */
export function buildShotengai(graph: WorldGraph, keep?: ((region: number) => boolean) | null): LayoutPreviewLayer[] {
    const sg = graph.shotengai; if (!sg) return [];
    if (keep && !keep(sg.region)) return [];
    const p = graph.params, gy = p.groundY, s = p.radius / 10, R = p.radius, cw = 2 * R / p.gridCols, ch = 2 * R / p.gridRows;
    const x0 = (c: number): number => -R + c * cw, y0 = (r: number): number => -R + r * ch;
    const rng = makeRng((p.seed ^ 0x9a1c) >>> 0);
    const paving = new Accum3D(), struct = new Accum3D(), fabric = FABRIC.map(() => new Accum3D()), lantern = new Accum3D();

    // Corridor paving = the run cells (drapes/lifts with the elevation post-transform like everything else).
    const py = gy + 0.006 * s;
    const cellPolys: V2[][] = sg.cells.map(([ci, ri]) => [[x0(ci), y0(ri)], [x0(ci + 1), y0(ri)], [x0(ci + 1), y0(ri + 1)], [x0(ci), y0(ri + 1)]]);

    const dx = sg.spine[1][0] - sg.spine[0][0], dz = sg.spine[1][1] - sg.spine[0][1], L = Math.hypot(dx, dz) || 1;
    const axis: V2 = [dx / L, dz / L], perp: V2 = [-axis[1], axis[0]];
    const axW: V3 = [axis[0], 0, axis[1]], pW: V3 = [perp[0], 0, perp[1]], up: V3 = [0, 1, 0];
    const halfW = sg.width * 0.5;

    for (const [ci, ri] of sg.cells) {
        const c: V2 = [x0(ci) + cw * 0.5, y0(ri) + ch * 0.5];
        for (const side of [1, -1]) {
            const base: V3 = [c[0] + perp[0] * halfW * 0.7 * side, gy, c[1] + perp[1] * halfW * 0.7 * side];
            const face: V3 = [-perp[0] * side, 0, -perp[1] * side];   // toward the corridor centre
            addStall(struct, fabric[(rng.next() * FABRIC.length) | 0], base, face, axW, s);
        }
        // banner strung across the corridor
        fabric[(rng.next() * FABRIC.length) | 0].obox([c[0], gy + 0.3 * s, c[1]], pW, up, axW, halfW * 0.9, 0.018 * s, 0.004 * s);
        // a couple of hanging paper lanterns (chōchin) down the corridor
        if (p.lanterns ?? true) for (let k = 0; k < 2; k++) {
            const off = (k - 0.5) * cw * 0.42;
            lantern.prism([c[0] + axis[0] * off, gy + 0.33 * s, c[1] + axis[1] * off], 0.018 * s, 0.018 * s, 0.04 * s, 6);
        }
    }

    // Entry arch at each end (pushed a touch beyond the corridor).
    for (const sign of [-1, 1]) {
        const e = sign < 0 ? sg.spine[0] : sg.spine[1];
        const pos: V2 = [e[0] + axis[0] * (cw * 0.5) * sign, e[1] + axis[1] * (ch * 0.5) * sign];
        addArch(struct, fabric[0], pos, pW, axW, halfW, gy, s);
    }

    const layers: LayoutPreviewLayer[] = [];
    layers.push({ name: 'world:sg-paving', color: PAVING, y: py, geometry: polysToGeometry(cellPolys, py), pattern: { color: [0.56, 0.44, 0.37], freq: 44, scale: 0.5, mode: 'checker' } });   // fine, subtle brick paving (NOT a giant checkerboard)
    if (!struct.empty) layers.push({ name: 'world:sg-struct', color: STRUCT, y: gy, geometry: struct.geometry() });
    fabric.forEach((a, i) => { if (!a.empty) layers.push({ name: 'world:sg-' + NAMES[i], color: FABRIC[i], y: gy, geometry: a.geometry() }); });
    if (!lantern.empty) layers.push({ name: 'world:sg-lantern', color: LANTERN, y: gy, geometry: lantern.geometry(), emissive: p.nightMode ? 1.4 : 0.95 });
    return layers;
}

/** A covered market stall: a counter, two posts, and a coloured awning tilting over the corridor. */
function addStall(struct: Accum3D, awn: Accum3D, base: V3, face: V3, axW: V3, s: number): void {
    const up: V3 = [0, 1, 0], w = 0.085 * s;
    struct.obox([base[0] + face[0] * 0.02 * s, base[1] + 0.03 * s, base[2] + face[2] * 0.02 * s], axW, up, face, w, 0.03 * s, 0.03 * s);   // counter
    for (const side of [1, -1]) struct.prism([base[0] + axW[0] * w * side + face[0] * 0.05 * s, base[1], base[2] + axW[2] * w * side + face[2] * 0.05 * s], 0.005 * s, 0.005 * s, 0.16 * s, 4);
    awn.obox([base[0] + face[0] * 0.06 * s, base[1] + 0.15 * s, base[2] + face[2] * 0.06 * s], axW, up, face, w * 1.15, 0.006 * s, 0.06 * s);   // awning
}

/** An entry arch/gate spanning the corridor: two posts + a top beam + a coloured signboard. */
function addArch(struct: Accum3D, sign: Accum3D, pos: V2, pW: V3, axW: V3, halfW: number, gy: number, s: number): void {
    const up: V3 = [0, 1, 0], h = 0.55 * s;
    for (const side of [1, -1]) struct.prism([pos[0] + pW[0] * halfW * side, gy, pos[1] + pW[2] * halfW * side], 0.016 * s, 0.016 * s, h, 6);
    struct.obox([pos[0], gy + h, pos[1]], pW, up, axW, halfW * 1.12, 0.02 * s, 0.03 * s);                        // top beam
    sign.obox([pos[0], gy + h * 0.82, pos[1]], pW, up, axW, halfW * 0.72, 0.06 * s, 0.006 * s);                  // signboard
}
