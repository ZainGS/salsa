// ── World generation — shared STREET CROSS-SECTION (kerbs, gutters, crossings) ─────────────────────
// One place for the numbers every street-level builder must agree on: kerb height and width, the gutter,
// the rounded block corners, where a zebra crossing sits on each junction arm, and where the kerb DROPS
// for it. elevation.ts (the height every prop/pedestrian is lifted by), preview.ts (the pavement polygons),
// kerbs.ts (kerb + gutter geometry) and roadpaint.ts (zebras + tactile paving) all read these — the canal-gap
// bug was two copies of one length disagreeing, so nothing here is re-derived at a call site.
//
// Pure data + 2D geometry (no elevation import — elevation imports THIS), worker-safe.

import type { WorldGraph, LayoutParams, V2, Block } from './types';
import { bounds, pointInPolygon, signedArea, clipConvex } from './util';

/**
 * Half-width of the band a level change must NOT cut through: the carriageway PLUS the pavement.
 *
 * ★ This is the rule "a terrace step never divides a street", and the ONE constant for the street edge of
 * everything built on a block (city-quality S6): blocks are the grid cell inset by streetWidth/2 (the road),
 * and the LOT LINE — where lots, courtyards and the retaining wall all start — is this far from the cell
 * boundary. The ring between is the pavement. Keeping road + pavement at the lower level is what makes a
 * staircase read as "steps from the pavement up to buildings on a raised section".
 */
export function streetBandHalf(params: LayoutParams): number {
    return Math.max(params.streetWidth, params.arterialWidth ?? 0) * 0.5 + params.streetWidth * 0.31;
}

/** The part of a GRID block that lots may occupy: the block inset to the lot line (`streetBandHalf` from the
 *  cell boundary) on every side that faces a road, and left at the block edge on a merged side. Returns the
 *  region, clipped to the block polygon (the border), plus which sides face a road (S, N, W, E). */
export function gridLotRegion(params: LayoutParams, block: Block): { poly: V2[]; road: { S: boolean; N: boolean; W: boolean; E: boolean }; rect: [number, number, number, number] } | null {
    const R = params.radius, cw = 2 * R / params.gridCols, ch = 2 * R / params.gridRows;
    const bb = bounds(block.poly), e = 1e-6;
    // The owning cell from the block's own position (not block.sector/ring): a neighbour TILE's graph is offset by
    // a whole number of cells, so this stays right in world coordinates too.
    const ci = Math.floor(((bb.min[0] + bb.max[0]) * 0.5 + R) / cw), ri = Math.floor(((bb.min[1] + bb.max[1]) * 0.5 + R) / ch);
    const cx0 = -R + ci * cw, cx1 = cx0 + cw, cz0 = -R + ri * ch, cz1 = cz0 + ch;
    // A side has a road iff the block was inset there (removed roads leave the block flush with the cell edge).
    // A border-clipped side sits INSIDE the cell too, but then it is the border, not a road — only count insets of
    // exactly the half street width.
    const half = params.streetWidth * 0.5;
    const W = Math.abs(bb.min[0] - (cx0 + half)) < 1e-5, E = Math.abs(bb.max[0] - (cx1 - half)) < 1e-5;
    const S = Math.abs(bb.min[1] - (cz0 + half)) < 1e-5, N = Math.abs(bb.max[1] - (cz1 - half)) < 1e-5;
    const band = streetBandHalf(params);
    const x0 = W ? cx0 + band : Math.max(bb.min[0], cx0), x1 = E ? cx1 - band : Math.min(bb.max[0], cx1);
    const z0 = S ? cz0 + band : Math.max(bb.min[1], cz0), z1 = N ? cz1 - band : Math.min(bb.max[1], cz1);
    if (x1 - x0 < e || z1 - z0 < e) return null;
    const rect: V2[] = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
    const poly = clipConvex(rect, block.poly);
    if (poly.length < 3) return null;
    return { poly, road: { S, N, W, E }, rect: [x0, z0, x1, z1] };
}

/** The street cross-section, in world units (all scale with s = radius/10, so a bigger diorama keeps metres). */
export interface StreetDims {
    s: number;
    /** Half the carriageway = the KERB LINE offset from a road centreline (blocks are inset by this). */
    half: number;
    /** Kerb face height = how far the pavement stands above the road (15 cm). */
    kerbH: number;
    /** Granite kerb-top strip width (18 cm). */
    kerbW: number;
    /** Concrete gutter channel on the road side of the kerb (30 cm). */
    gutterW: number;
    /** Radius of the rounded block corners at junctions. */
    cornerR: number;
    /** Zebra crossing depth along the arm (3.5 m). */
    cwDepth: number;
    /** Distance from the junction centre to the zebra's near edge along an arm (clear of the corner radius). */
    cwStart: number;
    /** Depth of the DROPPED-kerb ramp behind a crossing (the pavement slopes down to the road over this). */
    dropW: number;
    /** Kerb height that remains at a dropped kerb, as a fraction of kerbH (a ~3 cm lip). */
    dropLip: number;
    /** Separation between stacked coplanar ground overlays (paint over asphalt, strips over pavement). */
    lift: number;
}

export function streetDims(p: LayoutParams): StreetDims {
    const s = p.radius / 10, half = p.streetWidth * 0.5;
    const pave = streetBandHalf(p) - half;   // pavement width (kerb line → lot line)
    const cornerR = Math.max(0, Math.min(0.12 * s, pave * 0.8, half * 0.9));
    return {
        s, half,
        kerbH: 0.010 * s,
        kerbW: 0.012 * s,
        gutterW: 0.020 * s,
        cornerR,
        cwDepth: 0.23 * s,
        cwStart: half + cornerR + 0.01 * s,
        dropW: 0.05 * s,
        dropLip: 0.2,
        lift: 0.0008 * s,
    };
}

const nrm = (d: V2): V2 => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; };

/** One zebra crossing: centred at `c`, spanning the arm's carriageway. `d` = unit arm direction (away from the
 *  junction), `p` = perp(d). Half-extents `hd` along d, `hp` across. */
export interface Crossing { c: V2; d: V2; p: V2; hd: number; hp: number; junction: V2; axisAligned: boolean }

/** Whether a GRID junction node sits in a canal trench: its box takes the lowest of the four cells around it
 *  (elevation.cellLevelAt), so one canal cell sinks the whole box. Local copy of that rule — elevation imports
 *  this module, not the other way round. */
export function junctionSunk(graph: { params: LayoutParams; levels?: number[][] | null }, pos: V2): boolean {
    const lv = graph.levels, p = graph.params;
    if (!lv || p.pattern !== 'grid' || !(p.terraces ?? true)) return false;
    const R = p.radius, cols = p.gridCols, rows = p.gridRows, cw = 2 * R / cols, ch = 2 * R / rows;
    const c = Math.round((pos[0] + R) / cw), r = Math.round((pos[1] + R) / ch);
    const at = (ci: number, ri: number): number => (ci < 0 || ci >= cols || ri < 0 || ri >= rows) ? 0 : (lv[ci]?.[ri] ?? 0);
    return Math.min(at(c - 1, r - 1), at(c, r - 1), at(c - 1, r), at(c, r)) < 0;
}

/** Every zebra crossing in the city — one per junction ARM, just outside the junction box and clear of the
 *  rounded corners. roadpaint draws the bars here; kerbs/elevation drop the kerb at both ends.
 *  ★ None at a junction sunk into a canal trench (S13): its box is excavated and bridged, so a zebra there led
 *  off the kerb into the canal — and its dropped kerb landed on the bridge approach, breaking the flush joint
 *  between the deck's footway and the pavement. */
export function crossings(graph: { params: LayoutParams; intersections: { pos: V2; arms: V2[] }[]; levels?: number[][] | null }): Crossing[] {
    const D = streetDims(graph.params), out: Crossing[] = [];
    for (const it of graph.intersections) {
        if (junctionSunk(graph, it.pos)) continue;
        for (const arm of it.arms) {
            const d = nrm(arm), p: V2 = [-d[1], d[0]];
            const along = D.cwStart + D.cwDepth * 0.5;
            out.push({
                c: [it.pos[0] + d[0] * along, it.pos[1] + d[1] * along], d, p, hd: D.cwDepth * 0.5, hp: D.half,
                junction: it.pos, axisAligned: Math.abs(d[0]) > 0.999 || Math.abs(d[1]) > 0.999,
            });
        }
    }
    return out;
}

/** A dropped-kerb zone: the strip of pavement behind one END of a crossing. The pavement lift ramps from
 *  `dropLip·kerbH` at the kerb line up to the full kerb height `dropW` inward. `inward` = unit direction away
 *  from the road; `edge` = signed offset of the kerb line along `inward` from the origin (so the inward depth of
 *  a point q is dot(q, inward) − edge). Only axis-aligned zones are emitted — the ground tessellator can split
 *  exactly along axis-aligned lines, which keeps the slope planar per piece. */
export interface DropZone { x0: number; z0: number; x1: number; z1: number; inward: V2; edge: number }

export function dropZones(graph: { params: LayoutParams; intersections: { pos: V2; arms: V2[] }[]; levels?: number[][] | null }): DropZone[] {
    const D = streetDims(graph.params), out: DropZone[] = [];
    for (const cw of crossings(graph)) {
        if (!cw.axisAligned) continue;
        for (const sd of [1, -1]) {
            const inward: V2 = [cw.p[0] * sd, cw.p[1] * sd];
            // Kerb line of this end: the junction's arm centreline offset by `half` toward this side.
            const kx = cw.c[0] + inward[0] * D.half, kz = cw.c[1] + inward[1] * D.half;
            // The four corners: kerb line ± hd along the arm, and the same pushed dropW inward.
            const xs: number[] = [], zs: number[] = [];
            for (const sa of [1, -1]) for (const w of [0, D.dropW]) {
                xs.push(kx + cw.d[0] * cw.hd * sa + inward[0] * w);
                zs.push(kz + cw.d[1] * cw.hd * sa + inward[1] * w);
            }
            out.push({
                x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs),
                inward, edge: kx * inward[0] + kz * inward[1],
            });
        }
    }
    return out;
}

// ── Pavement surfaces (the kerbed, raised part of every block) ───────────────────────────────────────

/** The raised pavement index: every kerbed block outline (with rounded junction corners), and a fast point test. */
export interface PavementIndex {
    /** Filleted outlines of the kerbed blocks (and the radial plaza), CCW. The pavement polygons ARE these. */
    polys: V2[][];
    /** For each outline, per EDGE: what lies outside it — 'road' (kerb + gutter), 'low' (a lower unkerbed
     *  surface, e.g. a park: kerb face only), 'none' (a merged neighbour block / outside the city). */
    edgeKind: ('road' | 'low' | 'none')[][];
    /** Owning block of each outline (null for the plaza). */
    block: (Block | null)[];
    /** Whether (x,z) lies on a raised pavement surface (ignores terrace levels — elevation adds that rule). */
    test(x: number, z: number): boolean;
    /** Height the pavement stands above the road at (x,z): kerbH on a pavement, ramping down to
     *  dropLip·kerbH inside a dropped-kerb zone, 0 off the pavement. */
    lift(x: number, z: number): number;
    /** The dropped-kerb zone containing (x,z), if any (the ground tessellator evaluates it per vertex). */
    dropAt(x: number, z: number): DropZone | null;
    /** All dropped-kerb zones (their edges are split lines for the ground tessellator). */
    drops: DropZone[];
}

/** Pavement lift inside one drop zone at (x,z): linear from the lip at the kerb line to full height dropW in. */
export function dropLift(z0: DropZone, D: StreetDims, x: number, z: number): number {
    const depth = x * z0.inward[0] + z * z0.inward[1] - z0.edge;
    const t = Math.max(0, Math.min(1, depth / Math.max(D.dropW, 1e-9)));
    return D.kerbH * (D.dropLip + (1 - D.dropLip) * t);
}

const cache = new WeakMap<object, { key: string; idx: PavementIndex }>();

/** Build (or fetch the cached) pavement index for a graph. Cached on the blocks array + the params that shape it,
 *  because makeElevation is constructed by a dozen builders per city build. */
export function pavementIndex(graph: Pick<WorldGraph, 'params' | 'blocks' | 'border' | 'shotengai' | 'plaza' | 'intersections'> & { levels?: number[][] | null }): PavementIndex {
    const p = graph.params;
    const key = `${p.sidewalks}|${p.streetWidth}|${p.arterialWidth}|${p.radius}|${graph.shotengai?.cells.length ?? 0}|${graph.plaza?.length ?? 0}|${graph.intersections.length}`;
    const hit = cache.get(graph.blocks);
    if (hit && hit.key === key) return hit.idx;
    const idx = buildPavementIndex(graph);
    cache.set(graph.blocks, { key, idx });
    return idx;
}

/** Shotengai corridor cells — pedestrian paving owns them, so no kerbs / raised pavement there. */
export function inShotengaiCells(graph: Pick<WorldGraph, 'params' | 'shotengai'>, x: number, z: number): boolean {
    const sg = graph.shotengai; if (!sg) return false;
    const R = graph.params.radius, cw = 2 * R / graph.params.gridCols, ch = 2 * R / graph.params.gridRows;
    for (const [ci, ri] of sg.cells) {
        const x0 = -R + ci * cw, z0 = -R + ri * ch;
        if (x >= x0 && x <= x0 + cw && z >= z0 && z <= z0 + ch) return true;
    }
    return false;
}

function buildPavementIndex(graph: Pick<WorldGraph, 'params' | 'blocks' | 'border' | 'shotengai' | 'plaza' | 'intersections'> & { levels?: number[][] | null }): PavementIndex {
    const p = graph.params, D = streetDims(p);
    const empty: PavementIndex = { polys: [], edgeKind: [], block: [], test: () => false, lift: () => 0, dropAt: () => null, drops: [] };
    if (!p.sidewalks) return empty;
    // Every block (kerbed or not) — "is the outside of this edge road?" means "not inside ANY block".
    const all = graph.blocks.filter(b => b.poly.length >= 3).map(b => ({ b, bb: bounds(b.poly) }));
    const inAnyBlock = (x: number, z: number): Block | null => {
        for (const { b, bb } of all) {
            if (x < bb.min[0] || x > bb.max[0] || z < bb.min[1] || z > bb.max[1]) continue;
            if (pointInPolygon([x, z], b.poly)) return b;
        }
        return null;
    };
    const kerbed = (b: Block): boolean => b.zone !== 'park' && b.zone !== 'water';
    const eps = 0.004 * D.s;
    const polys: V2[][] = [], edgeKind: ('road' | 'low' | 'none')[][] = [], owner: (Block | null)[] = [];
    const axisRect: boolean[] = [];   // the outline is an axis-aligned rectangle with (at most) rounded corners
    const classify = (poly: V2[]): ('road' | 'low' | 'none')[] => {
        const ccw = signedArea(poly) >= 0, out: ('road' | 'low' | 'none')[] = [];
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i], b = poly[(i + 1) % poly.length];
            const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
            const nx = (ccw ? dz : -dz) / L, nz = (ccw ? -dx : dx) / L;   // outward normal
            const ox = (a[0] + b[0]) * 0.5 + nx * eps, oz = (a[1] + b[1]) * 0.5 + nz * eps;
            if (!pointInPolygon([ox, oz], graph.border)) { out.push('none'); continue; }
            const nb = inAnyBlock(ox, oz);
            out.push(!nb ? 'road' : kerbed(nb) ? 'none' : 'low');
        }
        return out;
    };
    for (const { b } of all) {
        if (!kerbed(b)) continue;
        const raw = b.poly, kinds = classify(raw);
        // Round a corner only where BOTH edges meeting at it face a road (a junction corner). A corner where the
        // block touches a merged neighbour stays sharp, or a pocket of asphalt would open between the two.
        const round = raw.map((_, i) => kinds[(i - 1 + raw.length) % raw.length] === 'road' && kinds[i] === 'road');
        const poly = filletCorners(raw, D.cornerR, round);
        polys.push(poly); edgeKind.push(classify(poly)); owner.push(b);
        axisRect.push(raw.length === 4 && raw.every((q, i) => { const r2 = raw[(i + 1) % 4]; return Math.abs(q[0] - r2[0]) < 1e-9 || Math.abs(q[1] - r2[1]) < 1e-9; }));
    }
    if (graph.plaza && graph.plaza.length >= 3) {
        // The radial plaza octagon reaches the CENTRE of the first ring road; its raised, kerbed paving stops at
        // that road's kerb line instead, so the ring carriageway stays at road level.
        const c = graph.plaza.reduce((a, q) => [a[0] + q[0] / graph.plaza!.length, a[1] + q[1] / graph.plaza!.length] as V2, [0, 0] as V2);
        const r = Math.max(...graph.plaza.map(q => Math.hypot(q[0] - c[0], q[1] - c[1])));
        const k = Math.max(0.3, 1 - D.half / Math.max(r, 1e-6));
        const plaza = graph.plaza.map(q => [c[0] + (q[0] - c[0]) * k, c[1] + (q[1] - c[1]) * k] as V2);
        polys.push(plaza); edgeKind.push(classify(plaza)); owner.push(null); axisRect.push(false);
    }

    // Uniform bucket grid over the outlines' bounds → O(1) candidate lookup per test.
    const bbs = polys.map(bounds);
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const bb of bbs) { x0 = Math.min(x0, bb.min[0]); z0 = Math.min(z0, bb.min[1]); x1 = Math.max(x1, bb.max[0]); z1 = Math.max(z1, bb.max[1]); }
    if (!polys.length) return empty;
    const N = 32, cx = Math.max((x1 - x0) / N, 1e-6), cz = Math.max((z1 - z0) / N, 1e-6);
    const buckets: number[][] = Array.from({ length: N * N }, () => []);
    bbs.forEach((bb, k) => {
        const i0 = Math.max(0, Math.floor((bb.min[0] - x0) / cx)), i1 = Math.min(N - 1, Math.floor((bb.max[0] - x0) / cx));
        const j0 = Math.max(0, Math.floor((bb.min[1] - z0) / cz)), j1 = Math.min(N - 1, Math.floor((bb.max[1] - z0) / cz));
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) buckets[j * N + i].push(k);
    });
    const rC = D.cornerR + 1e-9;
    const test = (x: number, z: number): boolean => {
        if (x < x0 || x > x1 || z < z0 || z > z1) return false;
        const i = Math.min(N - 1, Math.floor((x - x0) / cx)), j = Math.min(N - 1, Math.floor((z - z0) / cz));
        for (const k of buckets[j * N + i]) {
            const bb = bbs[k];
            if (x < bb.min[0] || x > bb.max[0] || z < bb.min[1] || z > bb.max[1]) continue;
            // Fast path: inside a rounded rectangle unless in a corner square (only there can the fillet exclude it).
            const inside = axisRect[k] && ((x > bb.min[0] + rC && x < bb.max[0] - rC) || (z > bb.min[1] + rC && z < bb.max[1] - rC))
                ? true : pointInPolygon([x, z], polys[k]);
            if (inside) return !inShotengaiCells(graph, x, z);
        }
        return false;
    };
    // Dropped kerbs: only where the crossing end actually lands on a raised pavement (a park corner has none).
    const drops = dropZones(graph).filter(dz => test((dz.x0 + dz.x1) * 0.5, (dz.z0 + dz.z1) * 0.5));
    const dBuckets: number[][] = Array.from({ length: N * N }, () => []);
    drops.forEach((dz, k) => {
        const i0 = Math.max(0, Math.floor((dz.x0 - x0) / cx)), i1 = Math.min(N - 1, Math.floor((dz.x1 - x0) / cx));
        const j0 = Math.max(0, Math.floor((dz.z0 - z0) / cz)), j1 = Math.min(N - 1, Math.floor((dz.z1 - z0) / cz));
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) dBuckets[j * N + i].push(k);
    });
    const dropAt = (x: number, z: number): DropZone | null => {
        if (x < x0 || x > x1 || z < z0 || z > z1) return null;
        const i = Math.min(N - 1, Math.floor((x - x0) / cx)), j = Math.min(N - 1, Math.floor((z - z0) / cz));
        for (const k of dBuckets[j * N + i]) { const d = drops[k]; if (x >= d.x0 && x <= d.x1 && z >= d.z0 && z <= d.z1) return d; }
        return null;
    };
    const lift = (x: number, z: number): number => {
        if (!test(x, z)) return 0;
        const d = dropAt(x, z);
        return d ? dropLift(d, D, x, z) : D.kerbH;
    };
    return { polys, edgeKind, block: owner, test, lift, dropAt, drops };
}

/** Round the flagged corners of a CONVEX-cornered polygon with circular arcs of radius `r` (clamped so an arc
 *  never eats more than 45% of either edge). Unflagged / reflex corners are kept sharp. */
export function filletCorners(poly: V2[], r: number, flags: boolean[], segs = 5): V2[] {
    const n = poly.length;
    if (n < 3 || r <= 0) return poly.slice();
    const ccw = signedArea(poly) >= 0, out: V2[] = [];
    for (let i = 0; i < n; i++) {
        const prev = poly[(i - 1 + n) % n], cur = poly[i], next = poly[(i + 1) % n];
        const ax = prev[0] - cur[0], az = prev[1] - cur[1], bx = next[0] - cur[0], bz = next[1] - cur[1];
        const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
        if (!flags[i] || la < 1e-9 || lb < 1e-9) { out.push(cur); continue; }
        const ua: V2 = [ax / la, az / la], ub: V2 = [bx / lb, bz / lb];
        const turn = (bx * az - bz * ax) * (ccw ? 1 : -1);          // > 0 for a convex corner
        const cosT = Math.max(-1, Math.min(1, ua[0] * ub[0] + ua[1] * ub[1]));
        const theta = Math.acos(cosT);                               // interior angle
        if (turn <= 0 || theta > Math.PI * 0.8) { out.push(cur); continue; }
        let t = r / Math.tan(theta / 2);
        t = Math.min(t, la * 0.45, lb * 0.45);
        const rr = t * Math.tan(theta / 2);
        const A: V2 = [cur[0] + ua[0] * t, cur[1] + ua[1] * t], B: V2 = [cur[0] + ub[0] * t, cur[1] + ub[1] * t];
        const bis = nrm([ua[0] + ub[0], ua[1] + ub[1]]), dc = rr / Math.sin(theta / 2);
        const C: V2 = [cur[0] + bis[0] * dc, cur[1] + bis[1] * dc];
        const a0 = Math.atan2(A[1] - C[1], A[0] - C[0]), a1 = Math.atan2(B[1] - C[1], B[0] - C[0]);
        let da = a1 - a0;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        for (let k = 0; k <= segs; k++) { const a = a0 + da * (k / segs); out.push([C[0] + Math.cos(a) * rr, C[1] + Math.sin(a) * rr]); }
    }
    return out;
}
