// ─────────────────────────────────────────────────────────────────────────────
// Building generator — geometry PART BUILDERS (Phases 2–7).
// Each emit* function reads the BuildCtx and appends geometry into the accumulator
// bundle (ctx.A). Layer colour/pattern is decided later, in building.ts's assembly.
// Type-only import of BuildCtx from building.ts (erased → no runtime import cycle).
// ─────────────────────────────────────────────────────────────────────────────

import { Accum3D } from './meshbuild';
import { offsetPoly, edgesOf, subdivide, edgePt, panel, post, centroid, bbox } from './building-geom';
import type { V2L, V3L, Edge } from './building-geom';
import type { V2, InstanceXform } from './types';
import type { BuildCtx, Section, BuildingParams } from './building';

// World-space pitch of ONE wall pattern cell (= 1/freq of wallPattern). wallsWin() quantizes the wall UVs to a
// WHOLE number of these, so windows never render as thin clipped slivers at a corner/roofline, and forEachWindow
// lands on exactly the windows the shader draws. (grid == bay is exact already; the others were mismatched → slivers.)
export function wallCellPitch(p: BuildingParams): number {
    const bay = Math.max(1, p.bayWidth);
    if (p.material === 'timber') return Math.max(0.7, bay * 0.5);   // lattice grid (freq 1/(bay·0.5))
    if (p.material === 'metal') return bay;                          // corrugated stripes — no window cells
    return p.windowStyle === 'punched' ? bay * 1.15 : p.windowStyle === 'ribbon' ? bay * 0.9 : bay;   // masonry
}
import { foliageClump, foliageBloom } from './foliage';

const v3 = (x: number, y: number, z: number): V3L => [x, y, z];
const sectionAt = (sections: Section[], y: number): Section => {
    for (const s of sections) if (y >= s.y0 - 0.01 && y <= s.y1 + 0.01) return s;
    return sections[sections.length - 1];
};

// ── PHASE 1/5 · MASSING — walls per section (setbacks/podium), plinth, setback terraces ──
export function emitMassing(ctx: BuildCtx): void {
    const { p, A, sections, foot, edges, front, baseTop, gH } = ctx;
    const bay = Math.max(1, p.bayWidth);
    const curtain = p.windowStyle === 'curtain';
    // Quantize the windowed wall UVs to WHOLE pattern cells (both axes) so windows fill the wall with no thin edge
    // slivers. Curtain glazes with its own finer mullion pitch.
    const pitch = wallCellPitch(p), cPitch = bay * 0.8;

    const plinth = offsetPoly(foot, 0.08);
    A.trim.walls(plinth, 0, baseTop); A.trim.cap(plinth, baseTop, 1);   // + serves as the ground-floor slab

    for (let si = 0; si < sections.length; si++) {
        const s = sections[si];
        const y0 = Math.max(s.y0, baseTop), y1 = s.y1;
        if (y1 - y0 < 0.1) continue;
        if (curtain) {
            A.glass.wallsWin(s.foot, y0, y1 - y0, cPitch, cPitch);
        } else if (si === 0 && p.storefront) {
            const gTop = Math.min(y1, gH);
            // Solid ground wall on every edge EXCEPT the shopfront (front) edge — the storefront glazing + door OPEN
            // that edge into the interior, so the entrance is a real opening (not glass-on-a-wall) that a door can
            // later swing THROUGH. Side/back walls stay (doubleSided → the shallow interior is visible through the front).
            if (gTop - y0 > 0.05) for (const e of edges) {
                if (e.i === front.i) continue;
                A.wallBase.quad4([e.a[0], y0, e.a[1]], [e.b[0], y0, e.b[1]], [e.b[0], gTop, e.b[1]], [e.a[0], gTop, e.a[1]]);
            }
            if (y1 > gH) A.wall.wallsWin(s.foot, gH, y1 - gH, pitch, pitch);     // windowed upper floors
        } else {
            A.wall.wallsWin(s.foot, y0, y1 - y0, pitch, pitch);
        }
        if (si < sections.length - 1) {   // setback terrace: cap the lower section + a low lip
            A.trim.cap(s.foot, s.y1, 1);
            const lip = offsetPoly(s.foot, 0.04);
            A.trim.walls(lip, s.y1, 0.3); A.trim.cap(lip, s.y1 + 0.3, 1);
        }
    }

    // curtain-wall mullions: real vertical + horizontal fins on the glazed sections (glass towers)
    if (p.mullions && curtain) {
        let count = 0;
        for (const s of sections) {
            const sEdges = edgesOf(s.foot);
            for (const e of sEdges) {
                const n = Math.max(2, Math.round(e.len / bay));
                for (let k = 0; k <= n && count < 240; k++) {
                    const pt = edgePt(e, k / n, 0.04);
                    A.trim.obox([pt[0], (s.y0 + s.y1) / 2, pt[1]], [e.dir[0], 0, e.dir[1]], [0, 1, 0], [e.out[0], 0, e.out[1]], 0.04, (s.y1 - s.y0) / 2, 0.06);
                    count++;
                }
            }
        }
    }
}

// ── PHASE 3 · FACADE DETAIL + MATERIALS — ledges, cornice, pilasters, quoins, downpipes, wall AC, fire escape, entrance ──
export function emitFacadeDetail(ctx: BuildCtx): void {
    const { p, A, edges, foot, sections, levels, floors, baseTop, topY, gH, front, rnd } = ctx;
    const bay = Math.max(1, p.bayWidth);

    if (p.ledges) {
        for (let i = 1; i < floors; i++) {
            const y = levels[i]; const s = sectionAt(sections, y); const lg = offsetPoly(s.foot, 0.12);
            A.trim.walls(lg, y - 0.05, 0.11); A.trim.cap(lg, y + 0.06, 1); A.trim.cap(lg, y - 0.05, -1);
        }
    }

    if (p.cornice) {   // pronounced crown moulding on the top section
        const s = sections[sections.length - 1]; const c1 = offsetPoly(s.foot, 0.2);
        A.trim.walls(c1, topY - 0.4, 0.4); A.trim.cap(c1, topY, 1); A.trim.cap(c1, topY - 0.4, -1);
    }

    if (p.pilasters) {   // vertical strips between bays on street edges (ground section height)
        const yTop = sections[0].y1; let count = 0;
        for (const e of edges) {
            if (!e.street) continue;
            const n = Math.max(1, Math.round(e.len / bay));
            for (let k = 1; k < n && count < 48; k++) {
                const pt = edgePt(e, k / n, 0.06);
                A.trim.obox([pt[0], (baseTop + yTop) / 2, pt[1]], [e.dir[0], 0, e.dir[1]], [0, 1, 0], [e.out[0], 0, e.out[1]], 0.09, (yTop - baseTop) / 2, 0.08);
                count++;
            }
        }
    }

    if (p.quoins) {   // alternating corner stone blocks (subtle — small, hugging the corner)
        const yTop = Math.min(topY, sections[0].y1); const step = 0.75, n = Math.min(26, Math.floor((yTop - baseTop) / step));
        for (const vtx of foot) for (let k = 0; k < n; k++) {
            if (k % 2) continue;
            A.trim.obox([vtx[0], baseTop + k * step + step * 0.5, vtx[1]], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.2, step * 0.42, 0.2);
        }
    }

    if (p.downpipes) {
        const rear = edges.filter(e => !e.street); const es = rear.length ? rear : edges;
        for (let i = 0; i < Math.min(2, es.length); i++) {
            const pt = edgePt(es[i], 0.12, 0.05); post(A.trim, pt[0], pt[1], 0.3, topY, 0.06);
        }
    }

    if (p.wallUnits) {   // window AC units on non-front upper floors
        let c = 0;
        for (let i = 1; i < floors && c < 10; i++) {
            const y = levels[i];
            for (const e of edges) {
                if (e.street || rnd() < 0.5 || c >= 10) continue;
                const pt = edgePt(e, 0.3 + rnd() * 0.4, 0.15);
                A.equip.obox([pt[0], y + 0.6, pt[1]], [e.dir[0], 0, e.dir[1]], [0, 1, 0], [e.out[0], 0, e.out[1]], 0.35, 0.25, 0.2);
                c++;
            }
        }
    }

    if (p.fireEscape) {
        const side = edges.find(e => !e.street) ?? edges[Math.min(1, edges.length - 1)];
        const w = Math.min(2.2, side.len * 0.5);
        for (let i = 1; i < floors; i++) {
            const y = levels[i]; const c = edgePt(side, 0.5, 0.55);
            A.equip.obox([c[0], y, c[1]], [side.dir[0], 0, side.dir[1]], [0, 1, 0], [side.out[0], 0, side.out[1]], w / 2, 0.04, 0.5);
            A.equip.obox([c[0] + side.out[0] * 0.5, y + 0.4, c[1] + side.out[1] * 0.5], [side.dir[0], 0, side.dir[1]], [0, 1, 0], [side.out[0], 0, side.out[1]], w / 2, 0.35, 0.03);
        }
        for (const s2 of [-1, 1]) { const a = edgePt(side, 0.5 + s2 * 0.18, 0.55); post(A.equip, a[0], a[1], baseTop, topY, 0.05); }
    }

    // Residential entrance (non-shop): a real door + a small canopy
    if (!p.storefront && !p.rollerDoors && !p.canopy) {
        const dw = Math.min(1.4, front.len * 0.24), dh = Math.min(2.4, gH * 0.78);
        emitDoor(ctx, front, 0.5, dw, dh, false);   // solid wall behind → keep the leaf proud so it's visible
        A.awn.obox([front.mid[0] + front.out[0] * 0.5, dh + 0.28, front.mid[1] + front.out[1] * 0.5], [front.dir[0], 0, front.dir[1]], [0, 1, 0], [front.out[0], 0, front.out[1]], dw * 0.9, 0.06, 0.5);   // canopy
    }
}

// ── PHASE 3 · BALCONIES ──
export function emitBalconies(ctx: BuildCtx): void {
    const { p, A, edges, levels, floors, front } = ctx;
    const bay = Math.max(1, p.bayWidth);
    const faces = edges.filter(e => e.street && (e === front || e.len >= front.len * 0.6));
    for (const e of faces) {
        const cols = Math.max(1, Math.floor(e.len / (bay * 1.15)));
        for (let i = 1; i < floors; i++) {
            const y = levels[i];
            for (let c = 0; c < cols; c++) {
                const t = (c + 0.5) / cols; const w2 = (e.len / cols) * 0.4;
                const slab = edgePt(e, t, 0.42), rail = edgePt(e, t, 0.82);
                A.trim.obox([slab[0], y + 0.05, slab[1]], [e.dir[0], 0, e.dir[1]], [0, 1, 0], [e.out[0], 0, e.out[1]], w2, 0.05, 0.42);
                A.trim.obox([rail[0], y + 0.4, rail[1]], [e.dir[0], 0, e.dir[1]], [0, 1, 0], [e.out[0], 0, e.out[1]], w2, 0.35, 0.04);
            }
        }
    }
}

// Iterate the ACTUAL rendered windows. Windows are a shader pattern (windowsPattern) on the wall UVs, laid out on
// a uniform `freq` grid — NOT the floor grid — so features that must hug windows have to replicate that grid:
//   • freq = 1/pitch, pitch = wallCellPitch (bay·1.15 punched · bay grid) → world cell size
//   • wall UVs (wallsWin) quantize u→round(len/pitch)·pitch, v→round(winH/pitch)·pitch (WHOLE cells, no sliver)
//   • masonry portrait inset: insetX = max(scale,0.2), insetY = insetX·0.5  (window opening within each cell)
// Emits one WinInfo per rendered window on the base windowed section's street faces (skips ground-floor row).
interface WinInfo { e: Edge; dirA: V3L; outA: V3L; t: number; halfWidth: number; yBottom: number; yTop: number; yCenter: number; }
function forEachWindow(ctx: BuildCtx, cap: number, cb: (w: WinInfo) => void): void {
    const { p, edges, gH, fh, baseTop, sections, topY } = ctx;
    if (p.windowStyle !== 'punched' && p.windowStyle !== 'grid') return;   // discrete windows only
    if (p.material === 'timber' || p.material === 'metal') return;         // those facades aren't windowed masonry
    const pitch = wallCellPitch(p), freq = 1 / pitch;                      // window cell pitch (whole windows fill the wall)
    const inset = Math.min(0.45, Math.max(0.05, p.windowStyle === 'punched' ? 0.22 : 0.3));   // = clamp(cfg.s)
    const insetX = Math.max(inset, 0.2), insetY = insetX * 0.5;            // masonry portrait window
    const s0 = sections[0];
    const winStart = p.storefront ? gH : Math.max(s0.y0, baseTop);          // where emitMassing starts the windowed wall
    const winH = Math.min(s0.y1, topY) - winStart;
    if (winH < fh * 0.5) return;
    const vMax = Math.max(1, Math.round(winH / pitch)) * pitch;            // wallsWin v quantization (matches emitMassing)
    const rowsWin = Math.max(1, Math.round(vMax * freq));                  // integer now → no clipped top row
    let count = 0;
    for (const e of edges) {
        if (!e.street || e.len < pitch * 0.6) continue;
        const nl = e.len;
        const uMax = nl < pitch * 0.55 ? pitch * 0.2 : Math.max(1, Math.round(nl / pitch)) * pitch;   // wallsWin u quantization
        const colsWin = Math.max(1, Math.round(uMax * freq));             // integer → every window is whole, gets trim/juliet
        const dirA: V3L = [e.dir[0], 0, e.dir[1]], outA: V3L = [e.out[0], 0, e.out[1]];
        const halfWidth = 0.5 * ((1 - 2 * insetX) / freq) * (nl / uMax);    // window opening half-width in world units
        for (let m = 0; m < rowsWin; m++) {
            const yBottom = winStart + (((m + insetY) / freq) / vMax) * winH;
            const yTop = winStart + (((m + 1 - insetY) / freq) / vMax) * winH;
            const yCenter = winStart + (((m + 0.5) / freq) / vMax) * winH;
            if (yCenter < gH) continue;                                     // skip the ground-floor (street-level) row
            for (let k = 0; k < colsWin; k++) {
                if (count++ >= cap) return;
                cb({ e, dirA, outA, t: ((k + 0.5) / freq) / uMax, halfWidth, yBottom, yTop, yCenter });
            }
        }
    }
}

const _vsub = (a: V3L, b: V3L): V3L => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const _vcross = (a: V3L, b: V3L): V3L => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const _vnrm = (a: V3L): V3L => { const L = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / L, a[1] / L, a[2] / L]; };

// Width/height BUCKET (0.05 m) so windows of ~the same size share ONE canonical geometry (and different buildings
// with the same bucket cross-instance). The instance transform carries the exact position; only geometry is bucketed.
const IBUCKET = 0.05;
const bk = (v: number): number => Math.round(v / IBUCKET) * IBUCKET;
// Per-building cap on windows that get juliet/trim. This was a NODE-count budget (one mesh per window) — instancing
// (ArrayGroups) makes node count independent of window count, so it's now just a runaway guard for pathological
// buildings (covers ~40 floors × 9 cols × 4 faces). Rendered TRIS still scale with instance count; LOD handles far-away.
const WINDOW_DETAIL_CAP = 1500;
const LX: V3L = [1, 0, 0], LY: V3L = [0, 1, 0], LZ: V3L = [0, 0, 1];   // canonical local axes: +X along, +Y up, +Z out

/** Build ONE juliet railing at the origin (local: +X = width, +Y = up from the sill, +Z = outward). Geometry only —
 *  colour is applied per-layer. `w2` = half-width, `railH` = rail height, `scroll` = ornateness. */
function buildJulietCanonical(acc: Accum3D, w2: number, railH: number, scroll: number): void {
    const P = (along: number, proj: number, yy: number): V3L => [along, yy, proj];
    const bar = (P0: V3L, P1: V3L, th: number) => {
        const seg = _vsub(P1, P0), L = Math.hypot(seg[0], seg[1], seg[2]) || 1e-4;
        const ay: V3L = [seg[0] / L, seg[1] / L, seg[2] / L];
        const az = _vnrm(_vcross(LX, ay));
        acc.obox([(P0[0] + P1[0]) / 2, (P0[1] + P1[1]) / 2, (P0[2] + P1[2]) / 2], LX, ay, az, th, L / 2, th);
    };
    const yBot = 0.02, yBelly = yBot + railH * 0.34, yTop = yBot + railH;   // local Y from the sill
    const pBot = 0.16, pBelly = 0.30, pTop = 0.12;
    const rail = (proj: number, yy: number, vh: number, oh: number, w = w2) => acc.obox([0, yy, proj], LX, LY, LZ, w, vh, oh);
    rail(pBot, yBot, 0.02, 0.02);
    rail(pBelly, yBelly, 0.018, 0.02);
    rail(pTop, yTop, 0.028, 0.03);
    rail(pTop, yTop + 0.032, 0.012, 0.042, w2 + 0.03);
    const nB = Math.max(4, Math.min(7, Math.round(w2 * 2 / 0.17)));
    for (let b = 0; b < nB; b++) {
        const a = ((b / (nB - 1)) - 0.5) * 2 * w2 * 0.9;
        bar(P(a, pBot, yBot), P(a, pBelly, yBelly), 0.013);
        bar(P(a, pBelly, yBelly), P(a, pTop, yTop), 0.013);
    }
    for (const a of [-w2 * 0.9, 0, w2 * 0.9]) {
        bar(P(a, pTop, yTop - 0.02), P(a, pTop, yTop + 0.13), 0.02);
        acc.obox(P(a, pTop, yTop + 0.15), LX, LY, LZ, 0.03, 0.03, 0.03);
    }
    if (scroll > 0.1) {
        const yMid = (yBelly + yTop) / 2, pO = 0.22;
        const hd = Math.min(w2 * 0.45, 0.12) * (0.6 + 0.4 * scroll), hv = (yTop - yBelly) * 0.4 * (0.7 + 0.3 * scroll);
        bar(P(0, pO, yMid + hv), P(hd, pO, yMid), 0.011); bar(P(hd, pO, yMid), P(0, pO, yMid - hv), 0.011);
        bar(P(0, pO, yMid - hv), P(-hd, pO, yMid), 0.011); bar(P(-hd, pO, yMid), P(0, pO, yMid + hv), 0.011);
        if (scroll > 0.6) for (const s of [-1, 1]) {
            const o = s * (hd + w2 * 0.24);
            bar(P(o - s * w2 * 0.16, pO, yMid + 0.04), P(o, pO, yMid + hv * 0.55), 0.01);
            bar(P(o, pO, yMid + hv * 0.55), P(o + s * w2 * 0.12, pO, yMid + 0.02), 0.01);
        }
    }
}

/** Build ONE window-trim surround at the origin (local axes as above). `ohw` = opening half-width, `winH` = opening
 *  height (sill→head), `keystone` adds the punched-window keystone. Geometry only. */
function buildWindowTrimCanonical(acc: Accum3D, ohw: number, winH: number, keystone: boolean): void {
    const at = (along: number, proj: number, yy: number): V3L => [along, yy, proj];
    const ft = 0.09, yHead = winH;   // local Y from the sill (ySill = 0)
    acc.obox(at(0, 0.055, yHead + ft), LX, LY, LZ, ohw + ft * 1.6, ft * 0.7, 0.055);          // lintel
    acc.obox(at(0, 0.075, yHead + ft * 1.9), LX, LY, LZ, ohw + ft * 2.1, ft * 0.32, 0.075);   // cornice lip
    acc.obox(at(0, 0.09, -ft * 0.6), LX, LY, LZ, ohw + ft * 2.0, ft * 0.5, 0.09);              // sill
    for (const s of [-1, 1]) acc.obox(at(s * (ohw + ft * 0.5), 0.05, winH / 2), LX, LY, LZ, ft * 0.5, winH / 2, 0.05);   // jambs
    if (keystone) acc.obox(at(0, 0.085, yHead + ft * 0.4), LX, LY, LZ, ft * 0.7, ft * 1.3, 0.085);   // keystone
}

export function emitJulietBalconies(ctx: BuildCtx): void {
    // Ornamental wrought-iron juliet balcony hugging each window (pot-bellied cage + finials + scroll). Emitted as
    // ONE canonical geometry per width bucket + a per-window transform list (translate+yaw) → instanceable.
    const { p } = ctx;
    const scroll = Math.max(0, Math.min(1, p.julietScroll));
    const buckets = new Map<string, { geometry: ReturnType<Accum3D['geometry']>; instances: InstanceXform[] }>();
    forEachWindow(ctx, WINDOW_DETAIL_CAP, (win) => {
        const w2 = bk(win.halfWidth), railH = bk(Math.min(1.1, (win.yTop - win.yBottom) * 0.62));
        const key = `juliet:w${w2.toFixed(2)}:h${railH.toFixed(2)}:s${scroll.toFixed(2)}`;
        let g = buckets.get(key);
        if (!g) { const acc = new Accum3D(); buildJulietCanonical(acc, w2, railH, scroll); g = { geometry: acc.geometry(), instances: [] }; buckets.set(key, g); }
        const c = edgePt(win.e, win.t, 0);
        g.instances.push({ x: c[0], y: win.yBottom, z: c[1], ry: Math.atan2(win.outA[0], win.outA[2]) });
    });
    for (const [key, g] of buckets) ctx.instGroups.push({ name: 'bldg:juliet', key, geometry: g.geometry, instances: g.instances });
}

export function emitWindowTrim(ctx: BuildCtx): void {
    // Raised stone surround (sill + lintel + jambs, +keystone on punched) around each window. Canonical geometry per
    // (width, height) bucket + per-window transforms → instanceable. Colour/pattern (stone) applied in assembly.
    const { p } = ctx;
    const keystone = p.windowStyle === 'punched';
    const buckets = new Map<string, { geometry: ReturnType<Accum3D['geometry']>; instances: InstanceXform[] }>();
    forEachWindow(ctx, WINDOW_DETAIL_CAP, (win) => {
        const ohw = bk(win.halfWidth), winH = bk(win.yTop - win.yBottom);
        const key = `wtrim:w${ohw.toFixed(2)}:h${winH.toFixed(2)}:${keystone ? 'k' : 'p'}`;
        let g = buckets.get(key);
        if (!g) { const acc = new Accum3D(); buildWindowTrimCanonical(acc, ohw, winH, keystone); g = { geometry: acc.geometry(), instances: [] }; buckets.set(key, g); }
        const c = edgePt(win.e, win.t, 0);
        g.instances.push({ x: c[0], y: win.yBottom, z: c[1], ry: Math.atan2(win.outA[0], win.outA[2]) });
    });
    for (const [key, g] of buckets) ctx.instGroups.push({ name: 'bldg:windowtrim', key, geometry: g.geometry, instances: g.instances });
}

export function emitStorefront(ctx: BuildCtx): void {
    const { p, A, front, gH, baseTop, meta } = ctx;

    if (p.canopy) {   // big flat entrance canopy (mall) on posts
        const ay = gH * 0.86;
        A.awn.obox([front.mid[0] + front.out[0] * 1.1, ay, front.mid[1] + front.out[1] * 1.1], [front.dir[0], 0, front.dir[1]], [0, 1, 0], [front.out[0], 0, front.out[1]], front.len * 0.5, 0.12, 1.1);
        for (const t of [0.12, 0.88]) { const pp = edgePt(front, t, 2.0); post(A.trim, pp[0], pp[1], 0, ay, 0.09); }
    }
    if (p.rollerDoors) {   // warehouse shutters across the front
        const n = Math.max(1, Math.round(front.len / 5)); const segs = subdivide(front, n);
        for (const s of segs) { if (ctx.rnd() < 0.35) continue; panel(A.trim, s.mid, front.dir, front.out, baseTop, gH * 0.85, 0.05, 0.1, s.len * 0.8); }
    }
    if (!p.storefront) return;

    // CURTAIN buildings already glaze the whole ground floor (the curtain skin) — a separate storefront would double up
    // the glass + framing (the "overlap in the storefront area"). So just place the entrance door(s), no shopfront.
    if (p.windowStyle === 'curtain') {
        emitDoor(ctx, front, 0.5, Math.min(2.6, front.len * 0.26), Math.min(gH - 0.3, gH * 0.86));
        return;
    }

    const bays = p.shopBays > 0 ? p.shopBays : Math.max(1, Math.round(front.len / 3.2));
    const segs = subdivide(front, bays);
    const gy0 = baseTop + (p.stallriser ? 0.5 : 0.12), gy1 = gH - (p.transom ? 0.5 : 0.3);
    const doorBay = Math.floor(bays / 2);                 // the entrance occupies the centre-most bay (a real opening)
    const doorH = Math.min(gH - 0.3, gH * 0.84);
    const dir = front.dir, ov = front.out;
    for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (i === doorBay) {
            // ENTRANCE bay: the door in a real opening + glazed SIDELIGHTS beside it (+ transom above via emitDoor).
            // Deliberately NO full-height glazing across this bay → nothing behind the door leaf (fixes the overlap).
            const doorW = Math.min(2.0, s.len * 0.66);
            const dl: V2L = [s.mid[0] - dir[0] * doorW / 2, s.mid[1] - dir[1] * doorW / 2];
            const dr: V2L = [s.mid[0] + dir[0] * doorW / 2, s.mid[1] + dir[1] * doorW / 2];
            for (const [pa, pb] of [[s.a, dl], [dr, s.b]] as [V2L, V2L][]) {
                const len = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
                if (len > 0.4) {
                    const mid: V2L = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
                    panel(A.glass, mid, dir, ov, gy0, gy1, 0.06, 0.08, len * 0.86);                 // sidelight glazing
                    if (p.stallriser) panel(A.front, mid, dir, ov, baseTop, gy0, 0.07, 0.14, len * 0.9);
                    if (p.transom) panel(A.glass, mid, dir, ov, doorH + 0.15, gy1, 0.06, 0.06, len * 0.9);
                }
            }
            emitDoor(ctx, front, (i + 0.5) / bays, doorW, doorH);
        } else {
            panel(A.glass, s.mid, dir, ov, gy0, gy1, 0.06, 0.08, s.len * 0.9);                       // shopfront glazing
            if (p.stallriser) panel(A.front, s.mid, dir, ov, baseTop, gy0, 0.07, 0.14, s.len * 0.92);
            if (p.transom) panel(A.front, s.mid, dir, ov, gy1, gy1 + 0.35, 0.07, 0.14, s.len * 0.92);
            const bars = Math.max(1, Math.round(s.len / 2.6));   // shopfront mullions (fewer, wider panels — less busy)
            for (let k = 1; k < bars; k++) {
                const t = k / bars;
                const px = s.a[0] + (s.b[0] - s.a[0]) * t, pz = s.a[1] + (s.b[1] - s.a[1]) * t;
                A.front.obox([px + ov[0] * 0.07, (gy0 + gy1) / 2, pz + ov[1] * 0.07], [dir[0], 0, dir[1]], [0, 1, 0], [ov[0], 0, ov[1]], 0.04, (gy1 - gy0) / 2, 0.05);
            }
            if (p.shutter) panel(A.front, s.mid, dir, ov, gy1 + 0.35, gy1 + 0.62, 0.1, 0.24, s.len * 0.94);   // shutter box
            if (p.noren) panel(A.awn, s.mid, dir, ov, gH * 0.55, gH * 0.78, 0.5, 0.03, s.len * 0.7);          // hanging shop curtain
        }
        if (p.awning) emitAwning(ctx, s.mid, s.len * 0.92, gH * 0.8);
        if (p.signage) {
            const sy0 = gH + 0.05, sy1 = gH + 0.5;
            panel(A.sign, s.mid, dir, ov, sy0, sy1, 0.09, 0.12, s.len * 0.88);
            meta.signSlots.push({ pos: [s.mid[0], (sy0 + sy1) / 2, s.mid[1]], out: ov, width: s.len * 0.88 });
        }
    }
}

// ── DOOR — a proper procedural entrance (frame + leaf/leaves + glazing + handle + transom + step) ──
function emitDoor(ctx: BuildCtx, e: Edge, t: number, w: number, h: number, openBehind = true): void {
    const { A, p } = ctx;
    const dir = e.dir, out = e.out;
    const gc = edgePt(e, t, 0);
    const cx = gc[0], cz = gc[1];
    const along = (d: number): V2L => [cx + dir[0] * d, cz + dir[1] * d];
    const fr = 0.13;                                         // frame member thickness
    // Leaf depth: storefront/curtain doors sit in a real OPENING (front edge is cut away) so they can recess into
    // the reveal; a residential door is set against a SOLID wall, so a negative offset would bury the leaf inside
    // the wall (the "invisible door" bug) — keep it PROUD of the wall so it actually reads as a door.
    const leafOff = openBehind ? (p.recessedEntry ? -0.14 : 0.03) : (p.recessedEntry ? 0.05 : 0.1);
    const glazed = p.doorStyle === 'glazed' || p.doorStyle === 'double';

    // jambs + head frame (doorFrameColor — its own layer so the surround can be coloured apart from the leaf). No
    // back plate — the opening stays clear so the door reads as a real doorway (and can later swing open through it).
    for (const sgn of [-1, 1]) {
        const jp = along((w / 2 + fr / 2) * sgn);
        A.dframe.obox([jp[0] + out[0] * 0.05, h / 2, jp[1] + out[1] * 0.05], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], fr / 2, h / 2 + fr, 0.16);
    }
    A.dframe.obox([cx + out[0] * 0.05, h + fr / 2, cz + out[1] * 0.05], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], w / 2 + fr, fr / 2, 0.16);

    if (p.doorStyle === 'auto-slide') {
        // COMMERCIAL AUTO-DOOR: two big glass panels meeting at the centre (baked CLOSED) + a header mechanism box
        // with a little sensor eye. `meta.door` carries width/height so the sim layer can later SLIDE the panels
        // apart on pedestrian proximity (spec Step 2) — the opening is already real (see emitMassing/emitStorefront).
        for (const sgn of [-1, 1]) {
            const pw = w / 2 - 0.03, pc = along(sgn * w / 4);
            const px = pc[0] + out[0] * leafOff, pz = pc[1] + out[1] * leafOff;
            panel(A.glass, [px, pz], dir, out, 0.14, h - 0.1, 0, 0.03, pw * 0.86);                                     // sliding glass leaf
            // full aluminium frame per leaf (bottom + top rails + outer + meeting stiles) so the see-through leaf
            // still reads as a framed sliding panel instead of an empty goalpost.
            A.door.obox([px, 0.11, pz], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], pw / 2, 0.06, 0.055);      // bottom rail
            A.door.obox([px, h - 0.09, pz], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], pw / 2, 0.055, 0.055); // top rail
            const oe = along(sgn * (w / 2 - 0.02));                                                                     // outer-edge stile
            A.door.obox([oe[0] + out[0] * leafOff, h / 2, oe[1] + out[1] * leafOff], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], 0.032, h / 2, 0.06);
            const le = along(sgn * 0.05);                                                                              // meeting stile at the centre
            A.door.obox([le[0] + out[0] * leafOff, h / 2, le[1] + out[1] * leafOff], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], 0.035, h / 2, 0.06);
        }
        A.door.obox([cx + out[0] * 0.03, h + 0.11, cz + out[1] * 0.03], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], w / 2 + fr, 0.11, 0.12);   // slim header mechanism box
        A.sign.obox([cx + out[0] * 0.1, h + 0.06, cz + out[1] * 0.1], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], 0.05, 0.035, 0.03);          // sensor eye (emissive)
    } else {
        // leaf/leaves
        const leaves = p.doorStyle === 'double' ? 2 : 1;
        const lw = w / leaves - 0.05;
        for (let li = 0; li < leaves; li++) {
            const off = leaves === 2 ? (li === 0 ? -1 : 1) * (w / 4) : 0;
            const lc = along(off);
            const lx = lc[0] + out[0] * leafOff, lz = lc[1] + out[1] * leafOff;
            if (glazed) {   // kick panel + glass + top stile
                const kick = h * 0.28;
                A.door.obox([lx, kick / 2, lz], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], lw / 2, kick / 2, 0.05);
                panel(A.glass, [lx, lz], dir, out, kick + 0.05, h - 0.08, 0.0, 0.04, lw * 0.9);
                A.door.obox([lx, (kick + h) / 2, lz], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], lw / 2, (h - kick) / 2, 0.045);
            } else if (p.doorStyle === 'panel') {   // slab + two raised panels
                A.door.obox([lx, h / 2, lz], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], lw / 2, h / 2, 0.06);
                for (const py of [h * 0.3, h * 0.68]) A.door.obox([lx + out[0] * 0.03, py, lz + out[1] * 0.03], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], lw * 0.34, h * 0.16, 0.04);
            } else {   // flush slab
                A.door.obox([lx, h / 2, lz], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], lw / 2, h / 2, 0.06);
            }
            const hs = leaves === 2 && li === 0 ? 1 : -1;   // handle on the leading edge
            const hp = along(off + lw * 0.34 * hs);
            A.dhandle.obox([hp[0] + out[0] * (leafOff + 0.07), h * 0.5, hp[1] + out[1] * (leafOff + 0.07)], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], 0.03, glazed ? h * 0.18 : 0.06, 0.03);
        }
        if (leaves === 2) A.door.obox([cx + out[0] * leafOff, h / 2, cz + out[1] * leafOff], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], 0.04, h / 2, 0.06);   // meeting stile
        if (glazed && p.storefront) {   // transom window above
            panel(A.glass, [cx, cz], dir, out, h + fr + 0.02, h + fr + 0.5, 0.03, 0.05, w * 0.92);
            A.dframe.obox([cx + out[0] * 0.05, h + fr + 0.52, cz + out[1] * 0.05], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], w / 2 + fr, 0.06, 0.14);
        }
    }
    // threshold / entry step
    A.front.obox([cx + out[0] * 0.22, 0.05, cz + out[1] * 0.22], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], w / 2 + 0.1, 0.06, 0.34);

    ctx.meta.door = { pos: [cx + out[0] * 0.3, cz + out[1] * 0.3], out, width: w, height: h };
}

function emitAwning(ctx: BuildCtx, mid: V2L, len: number, ay: number): void {
    const { A, front, p } = ctx;
    const proj = p.awningStyle === 'flat' ? 0.5 : 0.6;
    A.awn.obox([mid[0] + front.out[0] * proj, ay, mid[1] + front.out[1] * proj], [front.dir[0], 0, front.dir[1]], [0, 1, 0], [front.out[0], 0, front.out[1]], len / 2, 0.05, proj);
    if (p.awningStyle !== 'flat') {   // front valance
        A.awn.obox([mid[0] + front.out[0] * (proj * 1.9), ay - 0.2, mid[1] + front.out[1] * (proj * 1.9)], [front.dir[0], 0, front.dir[1]], [0, 1, 0], [front.out[0], 0, front.out[1]], len / 2, 0.2, 0.05);
    }
}

// ── PHASE 1/7 · ROOF — by roofStyle ──
export function emitRoof(ctx: BuildCtx): void {
    const { p, A } = ctx;
    const s = ctx.sections[ctx.sections.length - 1]; const foot = s.foot; const topY = s.y1; const c = centroid(foot);
    switch (p.roofStyle) {
        case 'flat': A.roof.cap(foot, topY, 1); ctx.meta.roofAnchor = [c[0], topY, c[1]]; break;
        case 'parapet': {
            A.roof.cap(foot, topY, 1); const par = offsetPoly(foot, 0.06);
            A.trim.walls(par, topY, 0.45); A.trim.cap(par, topY + 0.45, 1); ctx.meta.roofAnchor = [c[0], topY + 0.45, c[1]]; break;
        }
        case 'hip': {
            const eave = offsetPoly(foot, p.deepEaves ? 0.6 : 0.28); A.trim.walls(eave, topY - 0.06, 0.14);
            const rh = Math.max(1.2, Math.min(p.width, p.depth) * 0.34 * p.roofPitch * 1.6);
            A.roof.pyramid(eave, topY + 0.08, rh); ctx.meta.roofAnchor = [c[0], topY + rh, c[1]]; break;
        }
        case 'tiled-hip': {   // machiya: deep-eave low hip
            const eave = offsetPoly(foot, 0.9); A.trim.walls(eave, topY - 0.08, 0.16);
            const rh = Math.max(1.0, Math.min(p.width, p.depth) * 0.3 * p.roofPitch * 1.6);
            A.roof.pyramid(eave, topY + 0.05, rh); ctx.meta.roofAnchor = [c[0], topY + rh, c[1]]; break;
        }
        case 'gable': emitGable(ctx, foot, topY); break;
        case 'mansard': {
            const eave = offsetPoly(foot, 0.25); const lowerH = Math.max(1.2, p.floorHeight * 0.7);
            const topRing = offsetPoly(eave, -Math.min(p.width, p.depth) * 0.22);
            A.roof.frustum(eave, topRing, topY, topY + lowerH); A.roof.cap(topRing, topY + lowerH, 1);
            ctx.meta.roofAnchor = [c[0], topY + lowerH, c[1]]; break;
        }
        case 'sawtooth': emitSawtooth(ctx, foot, topY); break;
    }
}

function emitGable(ctx: BuildCtx, foot: V2[], topY: number): void {
    const { A, p } = ctx; const { hw, hd, cx, cz } = bbox(foot);
    const eaveO = p.deepEaves ? 0.5 : 0.25, HW = hw + eaveO, HD = hd + eaveO;
    const rh = Math.max(1.2, Math.min(2 * hw, 2 * hd) * 0.5 * p.roofPitch), ry = topY + rh;
    A.trim.walls(offsetPoly(foot, eaveO), topY - 0.06, 0.14);
    if (2 * hw >= 2 * hd) {   // ridge along X
        const rA = v3(cx - HW, ry, cz), rB = v3(cx + HW, ry, cz);
        const eNW = v3(cx - HW, topY, cz + HD), eNE = v3(cx + HW, topY, cz + HD), eSW = v3(cx - HW, topY, cz - HD), eSE = v3(cx + HW, topY, cz - HD);
        A.roof.quad4(eNW, eNE, rB, rA); A.roof.quad4(eSE, eSW, rA, rB); A.roof.quad4(eSW, eNW, rA, rA); A.roof.quad4(eNE, eSE, rB, rB);
    } else {                  // ridge along Z
        const rA = v3(cx, ry, cz - HD), rB = v3(cx, ry, cz + HD);
        const eSW = v3(cx - HW, topY, cz - HD), eNW = v3(cx - HW, topY, cz + HD), eSE = v3(cx + HW, topY, cz - HD), eNE = v3(cx + HW, topY, cz + HD);
        A.roof.quad4(eSW, eNW, rB, rA); A.roof.quad4(eNE, eSE, rA, rB); A.roof.quad4(eSE, eSW, rA, rA); A.roof.quad4(eNW, eNE, rB, rB);
    }
    ctx.meta.roofAnchor = [cx, ry, cz];
}

function emitSawtooth(ctx: BuildCtx, foot: V2[], topY: number): void {
    const { A, p } = ctx; const { hw, hd } = bbox(foot);
    const teeth = Math.max(3, Math.round((2 * hd) / 4)), segD = (2 * hd) / teeth, th = Math.max(1.2, p.floorHeight * 0.5);
    const low = topY, high = topY + th;
    for (let i = 0; i < teeth; i++) {
        const z0 = -hd + i * segD, z1 = z0 + segD;
        A.roof.quad4(v3(-hw, low, z0), v3(hw, low, z0), v3(hw, high, z1), v3(-hw, high, z1));    // slope
        A.glass.quad4(v3(-hw, high, z1), v3(hw, high, z1), v3(hw, low, z1), v3(-hw, low, z1));   // north-light glazing
    }
    ctx.meta.roofAnchor = [0, high, 0];
}

// ── PHASE 4 · ROOFTOP DETAIL — penthouse/railing/tanks/AC/antenna/dishes/vents/garden/helipad (flat roofs) ──
export function emitRoofDetail(ctx: BuildCtx): void {
    const { p, A, rnd, topY } = ctx;
    const s = ctx.sections[ctx.sections.length - 1]; const foot = s.foot; const c = centroid(foot); const { hw, hd } = bbox(foot);
    const flat = p.roofStyle === 'flat' || p.roofStyle === 'parapet';
    if (!flat) {
        if (p.category === 'house') A.equip.obox([c[0] + hw * 0.4, topY + 0.6, c[1] + hd * 0.2], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.28, 0.6, 0.28);   // chimney
        return;
    }
    const ry = s.y1 + (p.roofStyle === 'parapet' ? 0.45 : 0);

    if (p.roofRailing) {
        for (const e of edgesOf(offsetPoly(foot, 0.02))) {
            const n = Math.max(2, Math.round(e.len / 1.5));
            for (let k = 0; k <= n; k++) { const pt = edgePt(e, k / n, 0); post(A.equip, pt[0], pt[1], ry, ry + 0.5, 0.03); }
        }
    }
    // Distinct roof SLOTS (a 3×3 grid minus the centre, kept INSIDE the parapet), shuffled → clutter spreads out
    // instead of piling up or floating off the edge (the old ×1.4 offsets placed AC units past the roof rim).
    const slots: [number, number][] = [];
    for (const fx of [-0.58, 0, 0.58]) for (const fz of [-0.58, 0, 0.58]) if (fx || fz) slots.push([c[0] + fx * hw, c[1] + fz * hd]);
    for (let i = slots.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; const t = slots[i]; slots[i] = slots[j]; slots[j] = t; }
    let sIdx = 0; const slot = (): [number, number] => slots[(sIdx++) % slots.length];

    if (p.roofClutter) {
        const [tx, tz] = slot(); const tr = Math.min(Math.min(hw, hd) * 0.28, 0.7 + rnd() * 0.4), legH = 0.6;
        for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) post(A.equip, tx + sx * tr * 0.7, tz + sz * tr * 0.7, ry, ry + legH, 0.06);
        A.equip.prism([tx, ry + legH, tz], tr, tr, 1.0 + rnd() * 0.4, 8);
        const acN = 1 + (rnd() * 3 | 0);
        for (let i = 0; i < acN; i++) { const [ax, az] = slot(); A.equip.obox([ax, ry + 0.3, az], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.5 + rnd() * 0.3, 0.3, 0.4 + rnd() * 0.2); }
        const [mx, mz] = slot(); post(A.equip, mx, mz, ry, ry + 1.5 + rnd() * 2, 0.04);
    }
    if (p.roofVents) { const n = 2 + (rnd() * 3 | 0); for (let i = 0; i < n; i++) { const [x, z] = slot(); A.equip.prism([x, ry, z], 0.18, 0.18, 0.4 + rnd() * 0.3, 6); } }
    if (p.roofDishes) { const n = 1 + (rnd() * 2 | 0); for (let i = 0; i < n; i++) { const [x, z] = slot(); A.equip.disc([x, ry + 0.5, z], [0.3, 0.6, 0.3], 0.5, 10); } }
    if (p.roofPenthouse) {
        const pw = Math.min(hw, hd) * 0.7;
        A.equip.obox([c[0], ry + 1.1, c[1]], [1, 0, 0], [0, 1, 0], [0, 0, 1], pw * 0.6, 1.1, pw * 0.5);
        A.trim.cap([[c[0] - pw * 0.6, c[1] - pw * 0.5], [c[0] + pw * 0.6, c[1] - pw * 0.5], [c[0] + pw * 0.6, c[1] + pw * 0.5], [c[0] - pw * 0.6, c[1] + pw * 0.5]], ry + 2.2, 1);
    }
    if (p.roofGarden) { const n = 3 + (rnd() * 3 | 0); for (let i = 0; i < n; i++) { const [x, z] = slot(); A.trim.obox([x, ry + 0.2, z], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.4, 0.2, 0.4); } }
    if (p.helipad) {
        const r = Math.min(hw, hd) * 0.42;
        A.trim.cap([[c[0] - r, c[1] - r], [c[0] + r, c[1] - r], [c[0] + r, c[1] + r], [c[0] - r, c[1] + r]], ry + 0.08, 1);
        A.sign.obox([c[0], ry + 0.1, c[1]], [1, 0, 0], [0, 1, 0], [0, 0, 1], r * 0.55, 0.03, r * 0.12);   // 'H' bar (approx)
        A.sign.obox([c[0], ry + 0.1, c[1]], [1, 0, 0], [0, 1, 0], [0, 0, 1], r * 0.12, 0.03, r * 0.55);
    }
    // crown (towers): a spire mast or a mechanical box above the roof
    if (p.crown === 'spire') { post(A.equip, c[0], c[1], ry, ry + Math.max(4, topY * 0.14), 0.12); post(A.sign, c[0], c[1], ry + Math.max(4, topY * 0.14) - 0.4, ry + Math.max(4, topY * 0.14), 0.05); }
    else if (p.crown === 'mech') { const mw = Math.min(hw, hd) * 0.6; A.equip.obox([c[0], ry + 1.2, c[1]], [1, 0, 0], [0, 1, 0], [0, 0, 1], mw, 1.2, mw); A.equip.obox([c[0], ry + 2.8, c[1]], [1, 0, 0], [0, 1, 0], [0, 0, 1], mw * 0.6, 0.5, mw * 0.6); }
    else if (p.crown === 'blade') { A.trim.obox([c[0], ry + 2, c[1]], [1, 0, 0], [0, 1, 0], [0, 0, 1], hw * 0.9, 2, 0.2); }
}

// ── PHASE 6 · SIGNAGE / NEON — blade signs, wrap-corner band, rooftop sign, LED screens ──
export function emitSignage(ctx: BuildCtx): void {
    const { p, A, front, gH, edges, floors, fh, topY, meta } = ctx;

    if (p.bladeSign) {   // vertical projecting sign near one end of the front (perpendicular blade)
        const bp = edgePt(front, 0.85, 0.15);
        const y0 = gH * 0.4, y1 = Math.min(topY, gH + (floors - 1) * fh * 0.5);
        A.sign.obox([bp[0] + front.out[0] * 0.5, (y0 + y1) / 2, bp[1] + front.out[1] * 0.5], [front.out[0], 0, front.out[1]], [0, 1, 0], [front.dir[0], 0, front.dir[1]], 0.5, (y1 - y0) / 2, 0.06);
    }
    if (p.wrapSign) {   // horizontal band wrapping the front + one adjacent street edge (corner building)
        const y = gH + 0.7; const wrap = [front, ...edges.filter(e => e.street && e !== front).slice(0, 1)];
        for (const e of wrap) {
            panel(A.sign, e.mid, e.dir, e.out, y, y + 0.6, 0.08, 0.1, e.len * 0.9);
            meta.signSlots.push({ pos: [e.mid[0], y + 0.3, e.mid[1]], out: e.out, width: e.len * 0.9 });
        }
    }
    if (p.ledScreen) {   // big animated screen on the upper front facade
        const y0 = gH + 1, y1 = Math.min(topY - 0.5, gH + 1 + Math.min(6, (floors - 1) * fh * 0.6));
        if (y1 > y0) {
            panel(A.screen, front.mid, front.dir, front.out, y0, y1, 0.1, 0.12, front.len * 0.7);
            meta.signSlots.push({ pos: [front.mid[0], (y0 + y1) / 2, front.mid[1]], out: front.out, width: front.len * 0.7 });
        }
    }
    if (p.rooftopSign) {   // sign box standing on the roof, facing the front
        const s = ctx.sections[ctx.sections.length - 1]; const { hw } = bbox(s.foot); const c = centroid(s.foot);
        const ry = s.y1 + (p.roofStyle === 'parapet' ? 0.45 : 0); const w = Math.min(hw * 0.9, front.len * 0.4);
        A.sign.obox([c[0], ry + 1.2, c[1]], [front.dir[0], 0, front.dir[1]], [0, 1, 0], [front.out[0], 0, front.out[1]], w, 1.0, 0.15);
        for (const t of [-0.6, 0.6]) post(A.trim, c[0] + front.dir[0] * w * t, c[1] + front.dir[1] * w * t, ry, ry + 0.4, 0.06);
        meta.signSlots.push({ pos: [c[0], ry + 1.2, c[1]], out: front.out, width: w * 2 });
    }
}

// ── FOLIAGE ITEM 2 · attached greenery (auto-placed from the building's own geometry/meta) ──
// Also fills meta.windowAnchors (upper-floor window centres) for window-boxes + later interactions/sim.
// Canonical leaf clumps / vine blobs at the ORIGIN, built ONCE with a FIXED seed and cached, so EVERY building's
// hedge/box/planter/vine shares the identical geometry → the city-wide instancer collapses them to a handful of
// resident verts (the baked `world:detail-greenery` was ~1.76 M verts = 69% of the whole city's geometry).
const _clumpCanon = new Map<string, ReturnType<Accum3D['geometry']>>();
function _greenRng(seed: number): () => number { let s = (seed >>> 0) || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function clumpCanon(radius: number, density: number, tipFrac: number): ReturnType<Accum3D['geometry']> {
    const key = `c${radius}:${density}:${tipFrac}`;
    let g = _clumpCanon.get(key);
    if (!g) { const a = new Accum3D(); foliageClump(a, a, 0, 0, 0, radius, density, _greenRng(0x9e37 ^ Math.round(radius * 977) ^ Math.round(density * 613) * 7 ^ Math.round(tipFrac * 331) * 13), { tipFrac }); g = a.geometry(); _clumpCanon.set(key, g); }
    return g;
}
function blobCanon(r: number): ReturnType<Accum3D['geometry']> {
    const key = `b${r}`;
    let g = _clumpCanon.get(key);
    if (!g) { const a = new Accum3D(); a.blob([0, 0, 0], r, r * 0.9, r * 0.5, 0.4, Math.round(r * 1000)); g = a.geometry(); _clumpCanon.set(key, g); }
    return g;
}

export function emitGreenery(ctx: BuildCtx): void {
    const { p, A, edges, front, floors, gH, fh, topY, rnd } = ctx;

    // window anchors from the REAL rendered windows (forEachWindow) — so window boxes co-align with juliet + trim.
    // Fills meta.windowAnchors (centre + half-width, for sim/interactions) and collects the front-facing windows'
    // sills for the boxes below.
    const anchors = ctx.meta.windowAnchors;
    const frontWins: { x: number; y: number; z: number; w: number }[] = [];
    forEachWindow(ctx, 220, (win) => {
        const c = edgePt(win.e, win.t, 0);
        anchors.push({ pos: [c[0], win.yCenter, c[1]], out: win.e.out, w: win.halfWidth });
        if (win.e === front) frontWins.push({ x: c[0], y: win.yBottom, z: c[1], w: win.halfWidth });
    });

    // Leaf clumps are INSTANCED (canonical clump/blob at the origin + per-position transforms) instead of baked into
    // A.green — every residential hedge is the same clump repeated, so this is the single biggest resident-memory win
    // in the city. Bucketed by (type + radius) so same-shape clumps share ONE canonical; per-instance yaw jitter keeps
    // them from reading as clones. The box/pot boxes (A.trim) + blooms (A.bloom) stay baked (cheap, few).
    const buckets = new Map<string, { geo: ReturnType<Accum3D['geometry']>; xf: InstanceXform[] }>();
    const add = (key: string, geo: ReturnType<Accum3D['geometry']>, x: number, y: number, z: number): void => {
        let b = buckets.get(key); if (!b) { b = { geo, xf: [] }; buckets.set(key, b); }
        b.xf.push({ x, y, z, ry: rnd() * Math.PI * 2 });
    };

    // base hedge hugging the wall along street edges (gap at the entrance)
    if (p.baseHedge) {
        for (const e of edges) {
            if (!e.street) continue;
            const n = Math.max(2, Math.round(e.len / 0.55));
            for (let k = 0; k <= n; k++) {
                const t = k / n;
                if (e === front && t > 0.36 && t < 0.64) continue;   // leave a gap for the door
                const pt = edgePt(e, t, 0.14);
                add('hedge', clumpCanon(0.32, 0.35, 0.2), pt[0], 0.3, pt[1]);
            }
        }
    }

    // window boxes (a random subset of front-facing windows) — a box + spilling flowers, sitting on the sill and
    // sized to the window width (matches the real window, like juliet/trim).
    if (p.windowBoxes) {
        let count = 0;
        for (const fw of frontWins) {
            if (rnd() < 0.5 || count >= 12) continue;
            count++;
            const bw = Math.min(0.55, fw.w * 0.92);
            const bx = fw.x + front.out[0] * 0.16, by = fw.y + 0.02, bz = fw.z + front.out[1] * 0.16;
            A.trim.obox([bx, by, bz], [front.dir[0], 0, front.dir[1]], [0, 1, 0], [front.out[0], 0, front.out[1]], bw, 0.1, 0.14);   // box
            const rb = Math.round(bw * 0.7 * 20) / 20;
            add(`box${rb}`, clumpCanon(rb, 0.5, 0.3), bx, by + 0.14, bz);
            foliageBloom(A.bloom, rnd, bx, by + 0.18, bz, bw * 0.75, 4);
        }
    }

    // vines climbing a few street-facing wall strips
    if (p.vines) {
        for (const e of edges) {
            if (!e.street || rnd() < 0.4) continue;
            const t0 = 0.1 + rnd() * 0.8, climb = Math.min(topY, gH + (floors - 1) * fh) * (0.4 + rnd() * 0.5);
            const nLeaves = Math.min(60, Math.round(climb * 3));
            for (let i = 0; i < nLeaves; i++) {
                const t = Math.max(0.02, Math.min(0.98, t0 + (rnd() - 0.5) * 0.14));
                const pt = edgePt(e, t, 0.1);
                const rb = Math.round((0.09 + rnd() * 0.07) * 20) / 20;
                add(`vine${rb}`, blobCanon(rb), pt[0], rnd() * climb, pt[1]);   // single leaf cluster
            }
        }
    }

    // planters flanking the entrance
    if (p.basePlanters) {
        const dw = ctx.meta.door?.width ?? 1.2;
        for (const sgn of [-1, 1]) {
            const px = front.mid[0] + front.dir[0] * (dw / 2 + 0.5) * sgn + front.out[0] * 0.35;
            const pz = front.mid[1] + front.dir[1] * (dw / 2 + 0.5) * sgn + front.out[1] * 0.35;
            A.trim.obox([px, 0.2, pz], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.22, 0.2, 0.22);   // pot
            add('planter', clumpCanon(0.28, 0.5, 0.25), px, 0.52, pz);
            foliageBloom(A.bloom, rnd, px, 0.64, pz, 0.28, 3);
        }
    }

    for (const [key, b] of buckets) ctx.instGroups.push({ name: 'bldg:greenery', key, geometry: b.geo, instances: b.xf });
}

// ── PHASE 7 · TRADITIONAL / SPECIAL — machiya ground lattice (koshi) ──
export function emitTraditional(ctx: BuildCtx): void {
    const { p, A, front, gH, baseTop } = ctx;
    if (p.lattice) {
        const n = Math.min(60, Math.max(6, Math.round(front.len / 0.4)));
        const y0 = baseTop, y1 = gH * 0.9;
        for (let k = 0; k <= n; k++) {
            const pt = edgePt(front, k / n, 0.05);
            A.trim.obox([pt[0], (y0 + y1) / 2, pt[1]], [front.dir[0], 0, front.dir[1]], [0, 1, 0], [front.out[0], 0, front.out[1]], 0.03, (y1 - y0) / 2, 0.04);
        }
    }
}
