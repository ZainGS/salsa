// ── World generation — the Void Grid + border glow (Phase A of world-borders) ───────────────────────────
// A grid / concentric rings extending PAST the city border into the void — the "city floating in cyberspace"
// read. Built as flat EMISSIVE line geometry (thin ground quads), not a shader pattern, so the lines glow on
// transparent void (gaps see straight through). Shape follows the border: grid for square/oct, three 60-deg
// line families for hex, concentric RINGS for circle. Faded outward by binning segments into 3 emissive/opacity
// bands (+ the camera-relative fog softens the far edge). The border outline is a bright emissive ribbon that
// reads especially in City Edit Mode. Ground-level, whole-city (not region-filtered); stays FLAT + UNWARPED
// (the abstract floor), unlike the organic warped city on top of it. See docs/specs/world-borders.md.

import type { WorldGraph, LayoutPreviewLayer, V2 } from './types';
import { polysToGeometry } from './preview';
import { pointInPolygon } from './util';
import { Accum3D } from './meshbuild';

// Cyber accent — saturated cyan so the bloom pass makes it glow against the sky. Tunable per palette later.
const GRID_COLOR:  [number, number, number] = [0.16, 0.82, 1.00];
const GLOW_COLOR:  [number, number, number] = [0.42, 0.92, 1.00];

const sub  = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const nrm  = (d: V2): V2 => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; };
const perp = (d: V2): V2 => [-d[1], d[0]];

/** A rectangle centered on segment a→b, `halfW` to each side. */
function segQuad(a: V2, b: V2, halfW: number): V2[] {
    const d = nrm(sub(b, a)), p = perp(d);
    return [
        [a[0] + p[0] * halfW, a[1] + p[1] * halfW], [b[0] + p[0] * halfW, b[1] + p[1] * halfW],
        [b[0] - p[0] * halfW, b[1] - p[1] * halfW], [a[0] - p[0] * halfW, a[1] - p[1] * halfW],
    ];
}

/** One tessellated line segment tagged by its centroid distance from the world centre (for the fade bins). */
interface Seg { quad: V2[]; r: number; }

/** Emit ONE thin line quad a→b, tagged by its centroid radius. Clipped to a SQUARE box of half-extent `ext`
 *  (grid/hex/oct — keeps the corners, so a square grid stays complete) or a DISC of radius `ext` (rings). */
function pushSeg(a: V2, b: V2, hw: number, ext: number, out: Seg[], square = false): void {
    const cx = (a[0] + b[0]) * 0.5, cz = (a[1] + b[1]) * 0.5;
    const r = Math.hypot(cx, cz);
    const keep = square ? (Math.abs(cx) <= ext && Math.abs(cz) <= ext) : (r <= ext);
    if (keep) out.push({ quad: segQuad(a, b, hw), r });
}

/** Walk a straight line a→b in steps ~`step` long, emitting a thin quad per step within the `ext` clip (square). */
function tessLine(a: V2, b: V2, step: number, hw: number, ext: number, out: Seg[], square = false): void {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-4) return;
    const d = nrm(sub(b, a)), n = Math.max(1, Math.ceil(len / step));
    for (let i = 0; i < n; i++) {
        const t0 = (i / n) * len, t1 = ((i + 1) / n) * len;
        pushSeg([a[0] + d[0] * t0, a[1] + d[1] * t0], [a[0] + d[0] * t1, a[1] + d[1] * t1], hw, ext, out, square);
    }
}

/**
 * The void grid — emissive tiling geometry past the border, in 3 radial fade bands. Each CELL is exactly the
 * CITY's own size + shape (matching `borderPolygon`), tiled outward → the city IS the centre cell and one cell =
 * one future Phase-C tile, so it connects seamlessly. No spacing knob: square → square grid (cell = the city
 * square), hexagon → pointy-top honeycomb (cell = the city hexagon), octagon → octagon-and-square (cell = the
 * city octagon), circle → concentric rings a city-radius apart (circles can't tile). `voidExtent` = how far out,
 * `voidLineWidth` = line thickness. NOTE: with domain WARP on, the city EDGE wobbles off the straight cell edge
 * (the cell marks the true tile boundary ±R); drop Warp for a clean edge-on-cell fit.
 */
export function buildVoidGrid(graph: WorldGraph): LayoutPreviewLayer[] {
    const p = graph.params;
    if (p.voidGrid === false) return [];
    const R = p.radius, gy = p.groundY, s = R / 10;
    const ext = R * (p.voidExtent ?? 5.0);           // grid reaches this far out (a couple of city-cells)
    const hw  = R * (p.voidLineWidth ?? 0.025);       // line half-thickness (× city radius) — user-controlled
    const segs: Seg[] = [];

    if (p.border === 'circle') {
        // Concentric RINGS a city-radius apart, marching out from the city edge (circles don't tile).
        for (let r = R; r <= ext + 1e-3; r += R) {
            const n = Math.max(24, Math.ceil((2 * Math.PI * r) / (R * 0.25)));
            let prev: V2 = [r, 0];
            for (let i = 1; i <= n; i++) {
                const th = (i / n) * Math.PI * 2;
                const cur: V2 = [Math.cos(th) * r, Math.sin(th) * r];
                pushSeg(prev, cur, hw, ext, segs);
                prev = cur;
            }
        }
    } else if (p.border === 'hexagon') {
        // POINTY-TOP HONEYCOMB matching the city hexagon (borderPolygon off=π/6 → vertex up), circumradius = R,
        // so the CENTRE hex IS the city and neighbours share its edges. Deduped shared edges.
        const a = R, rowH = 1.5 * a, colW = Math.sqrt(3) * a;
        const nrw = Math.ceil(ext / rowH) + 1, ncl = Math.ceil(ext / colW) + 1;
        const seen = new Set<string>();
        const edge = (u: V2, v: V2) => {
            const key = Math.round((u[0] + v[0]) / (a * 0.15)) + ',' + Math.round((u[1] + v[1]) / (a * 0.15));
            if (seen.has(key)) return; seen.add(key); pushSeg(u, v, hw, ext, segs, true);
        };
        for (let row = -nrw; row <= nrw; row++) for (let c = -ncl; c <= ncl; c++) {
            const cx = c * colW + ((row & 1) ? colW * 0.5 : 0), cz = row * rowH;
            if (Math.abs(cx) > ext + a || Math.abs(cz) > ext + a) continue;   // square coverage (keep corners)
            const v: V2[] = [];
            for (let k = 0; k < 6; k++) { const ang = Math.PI / 6 + k * Math.PI / 3; v.push([cx + a * Math.cos(ang), cz + a * Math.sin(ang)]); }
            for (let k = 0; k < 6; k++) edge(v[k], v[(k + 1) % 6]);
        }
    } else if (p.border === 'octagon') {
        // OCTAGON-AND-SQUARE matching the city octagon (off=π/8, circumradius R): octagons on a square pitch =
        // the octagon's flat-to-flat width, touching → the diagonal gaps read as squares. Centre octagon = the city.
        const half = R * Math.cos(Math.PI / 8);          // octagon centre→flat = half the pitch (circumradius R)
        const d = 2 * half, hh = d / (2 * (1 + Math.SQRT2));
        const nCell = Math.ceil(ext / d) + 1;
        const seen = new Set<string>();
        const edge = (u: V2, v: V2) => {
            const key = Math.round((u[0] + v[0]) / (d * 0.08)) + ',' + Math.round((u[1] + v[1]) / (d * 0.08));
            if (seen.has(key)) return; seen.add(key); pushSeg(u, v, hw, ext, segs, true);
        };
        for (let c = -nCell; c <= nCell; c++) for (let row = -nCell; row <= nCell; row++) {
            const cx = c * d, cz = row * d;
            if (Math.abs(cx) > ext + d || Math.abs(cz) > ext + d) continue;   // square coverage (keep corners)
            const v: V2[] = [
                [cx + half, cz + hh], [cx + hh, cz + half], [cx - hh, cz + half], [cx - half, cz + hh],
                [cx - half, cz - hh], [cx - hh, cz - half], [cx + hh, cz - half], [cx + half, cz - hh],
            ];
            for (let k = 0; k < 8; k++) edge(v[k], v[(k + 1) % 8]);
        }
    } else {
        // SQUARE grid — cell = the city square (side 2R). Lines at odd multiples of R (±R, ±3R…) so the CITY is
        // the centre cell and its border (±R) coincides with the innermost grid lines.
        const cell = 2 * R;
        for (const dir of [[1, 0] as V2, [0, 1] as V2]) {
            const off = perp(dir);   // lines offset along this axis, anchored so pos = -R (the city edge) is a line
            const mMin = Math.floor((-ext + R) / cell), mMax = Math.ceil((ext + R) / cell);
            for (let m = mMin; m <= mMax; m++) {
                const pos = -R + m * cell;
                const cpt: V2 = [off[0] * pos, off[1] * pos];
                // Tessellate finer than a full cell (→ R) + SQUARE clip → the grid stays complete to the box edge
                // (no disc-clipped corners, no chunky pop as Extent slides).
                tessLine([cpt[0] - dir[0] * ext, cpt[1] - dir[1] * ext], [cpt[0] + dir[0] * ext, cpt[1] + dir[1] * ext], R, hw, ext, segs, true);
            }
        }
    }

    // Bin by distance into fade bands (OPAQUE glowing lines — transparency was invisible from above + fought depth;
    // the fade is by emissive strength, and the fog dissolves the very far edge). The bands SCALE with the grid span
    // (city edge R → Extent), so the gradient stays balanced at ANY Extent: bright by the city, dimming smoothly to
    // the rim (a fixed-radius fade washed the whole grid out at a large Extent and cramped it at a small one).
    const NB = 5, span = Math.max(R * 0.5, ext - R);
    const bands: { max: number; name: string; e: number }[] = [];
    for (let i = 0; i < NB; i++) {
        const max = i === NB - 1 ? ext * 1.5 + 1 : R + span * ((i + 1) / NB);   // last band catches the square corners (r → ext·√2)
        bands.push({ max, name: `world:void-grid-${i}`, e: 1.35 - (1.35 - 0.28) * (i / (NB - 1)) });
    }
    // Only the part that EXTENDS PAST the edge (skip lines under the city — the city owns its own ground) and
    // drape it just above the terrain (see _addStaged: 'void-grid' NOT baked → follows the height field), so it
    // reads as a glowing floor around the city from ABOVE, never occluded by the opaque ground below it.
    const border = graph.border;
    const outside = (q: V2[]): boolean => {
        let cx = 0, cz = 0; for (const v of q) { cx += v[0]; cz += v[1]; }
        return !pointInPolygon([cx / q.length, cz / q.length], border);
    };
    const y = gy + 0.02 * s;   // small lift; _addStaged then drapes it onto the terrain
    // SINGLE PASS (was NB× filter+map sweeps = NB redundant point-in-polygon tests per segment): compute the
    // band index + the outside() test once per segment and bucket directly. Bands are contiguous from 0, so a
    // segment lands in the first band whose max exceeds its radius — same binning, and per-band quad order
    // still follows `segs` order → the emitted geometry is byte-identical to the old sweeps.
    const byBand: V2[][][] = bands.map(() => []);
    for (const sg of segs) {
        let bi = 0;
        while (bi < NB && sg.r >= bands[bi].max) bi++;
        if (bi >= NB || !outside(sg.quad)) continue;   // bi===NB can't happen (the last band catches ext·√2) — belt+braces
        byBand[bi].push(sg.quad);
    }
    const out: LayoutPreviewLayer[] = [];
    for (let bi = 0; bi < bands.length; bi++) {
        const quads = byBand[bi];
        if (quads.length) out.push({ name: bands[bi].name, color: GRID_COLOR, y, geometry: polysToGeometry(quads, y), emissive: bands[bi].e, excludeFromFrame: true });
    }
    return out;
}

/**
 * The border glow — a bright emissive edge that hugs the (domain-warped, terrain-draped) city border. A flat
 * ribbon on the ground PLUS an optional raised luminous WALL (`borderGlowHeight`) — the flat vertical boundary
 * you see in games. The wall base is tessellated so it drapes smoothly onto rolling terrain.
 */
export function buildBorderGlow(graph: WorldGraph): LayoutPreviewLayer[] {
    const p = graph.params;
    if (p.borderGlow === false) return [];
    const gy = p.groundY, s = p.radius / 10;
    const poly = graph.border;
    if (!poly || poly.length < 3) return [];
    const out: LayoutPreviewLayer[] = [];

    // Flat ground ribbon (the outline on the floor).
    const hw = 0.11 * s;
    const quads: V2[][] = [];
    for (let i = 0; i < poly.length; i++) quads.push(segQuad(poly[i], poly[(i + 1) % poly.length], hw));
    const y = gy + 0.05 * s;   // drapes (name matches 'border-glow' → not baked); OPAQUE + emissive → blooms
    out.push({ name: 'world:border-glow', color: GLOW_COLOR, y, geometry: polysToGeometry(quads, y), emissive: 1.6, excludeFromFrame: true });

    // Raised luminous WALL — TAPERED: split the height into vertical bands, bright + opaque at the base fading to a
    // faint translucent top → a soft force-field look, not a flat glowing slab. Each band's base is tessellated so
    // it drapes on the terrain; stacked bands lift together and stay aligned.
    const h = (p.borderGlowHeight ?? 1.2) * s;
    if (h > 1e-4) {
        const step = p.radius * 0.1, NW = 4;
        for (let band = 0; band < NW; band++) {
            const y0 = gy + h * (band / NW), y1 = gy + h * ((band + 1) / NW);
            const wall = new Accum3D();
            for (let i = 0; i < poly.length; i++) {
                const a = poly[i], b = poly[(i + 1) % poly.length];
                const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
                const n = Math.max(1, Math.ceil(len / step)), d = nrm(sub(b, a));
                for (let k = 0; k < n; k++) {
                    const p0: V2 = [a[0] + d[0] * (k / n) * len, a[1] + d[1] * (k / n) * len];
                    const p1: V2 = [a[0] + d[0] * ((k + 1) / n) * len, a[1] + d[1] * ((k + 1) / n) * len];
                    wall.quad4([p0[0], y0, p0[1]], [p1[0], y0, p1[1]], [p1[0], y1, p1[1]], [p0[0], y1, p0[1]]);
                }
            }
            const t = band / (NW - 1);   // 0 = base, 1 = top
            out.push({ name: `world:border-glow-wall-${band}`, color: GLOW_COLOR, y: gy, geometry: wall.geometry(),
                emissive: 1.7 - 1.3 * t, opacity: band === NW - 1 ? 0.5 : 1, excludeFromFrame: true });
        }
    }
    return out;
}
