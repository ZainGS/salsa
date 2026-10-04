// ─────────────────────────────────────────────────────────────────────────────
// Building generator — geometry PART BUILDERS (Phases 2–7 + the city-quality Japanese pass).
// Each emit* function reads the BuildCtx and appends geometry into the accumulator
// bundle (ctx.A). Layer colour/pattern is decided later, in building.ts's assembly.
// Type-only import of BuildCtx from building.ts (erased → no runtime import cycle).
//
// Edge KINDS (ctx.edges[i].kind, from the city's frontage mask): 'street' faces get the full facade (windows,
// balconies, trim, shopfront, signs); 'party' walls abut the neighbour and stay plain — NOTHING protrudes from
// them; 'open' edges (back yard / courtyard / alley) take the utilities (AC units, pipes, stairs, laundry). The
// standalone Creator passes no mask → every edge is street, and the legacy placements are kept.
//
// WINDOW GRID (B4): wall v runs ONE CELL PER STOREY (row j = levels[j]..levels[j+1]) so window rows, balconies,
// AC units and string courses all sit on the same floor grid. forEachWindow / windowRowBoundaries mirror it, and
// windowInsets mirrors the shader's winInsets (mesh3d-shaders) — change them together.
// ─────────────────────────────────────────────────────────────────────────────

import { Accum3D, partOf } from './meshbuild';
import { offsetPoly, offsetPolyEdges, edgesOf, subdivide, edgePt, panel, post, centroid, bbox, frameExtent, ihash } from './building-geom';
import type { V2L, V3L, Edge } from './building-geom';
import type { V2, InstanceXform } from './types';
import type { BuildCtx, Section, BuildingParams } from './building';
import { pointInPolygon } from './util';
import { emitGlyphRun, signWord, signWordKind, type SignWordKind } from './sign-glyphs';
import { letteringFor } from './sign-style';
import { foliageBloom } from './foliage';
import { emitLeafCluster, DEFAULT_LEAF } from './branch';

// World-space pitch of ONE wall pattern cell (= 1/freq of wallPattern) along a face. wallsWin() quantizes the wall
// u to a WHOLE number of these, so windows never render as thin clipped slivers at a corner, and forEachWindow
// lands on exactly the windows the shader draws. (Vertically a cell is one STOREY — see emitMassing.)
export function wallCellPitch(p: BuildingParams): number {
    const bay = Math.max(1, p.bayWidth);
    if (p.material === 'timber') return Math.max(0.7, bay * 0.5);   // lattice grid (freq 1/(bay·0.5))
    if (p.material === 'metal') return bay;                          // corrugated stripes — no window cells
    return p.windowStyle === 'punched' ? bay * 1.15 : p.windowStyle === 'ribbon' ? bay * 0.9 : bay;   // masonry
}

const discreteWindows = (p: BuildingParams): boolean => p.windowStyle === 'punched' || p.windowStyle === 'grid';

/** The windows shader's facade code (pattern `angle` slot): ribbon 3 · brick 0 · concrete 1 · small square TILE 4 ·
 *  lap SIDING 5 · smooth PLASTER (painted render) 7 · metal PANEL cladding 8; + 10 = Japanese sliding SASH openings.
 *  (2 = curtain glass, 6 = shop window.) */
export function facadeCode(p: BuildingParams): number {
    if (p.windowStyle === 'ribbon') return 3;
    const base = p.material === 'brick' ? 0 : p.material === 'tile' ? 4 : p.material === 'siding' ? 5 : p.material === 'plaster' ? 7 : p.material === 'panel' ? 8 : 1;
    return base + (p.windowSash && discreteWindows(p) ? 10 : 0);
}

/** Window OPENING insets as fractions of a cell: x = each side, b = below (sill), t = above (head).
 *  ★ MUST mirror winInsets() in mesh3d-shaders.ts. Sash = wide + low (Japanese aluminium sliding windows). */
export function windowInsets(p: BuildingParams): { x: number; b: number; t: number } {
    if (p.windowSash && discreteWindows(p)) return { x: 0.13, b: 0.30, t: 0.16 };
    const inset = Math.min(0.45, Math.max(0.05, p.windowStyle === 'punched' ? 0.22 : 0.3));   // = clamp(cfg.s)
    const x = Math.max(inset, 0.2);
    return { x, b: x * 0.5, t: x * 0.5 };
}

const v3 = (x: number, y: number, z: number): V3L => [x, y, z];
const sectionAt = (sections: Section[], y: number): Section => {
    for (const s of sections) if (y >= s.y0 - 0.01 && y <= s.y1 + 0.01) return s;
    return sections[sections.length - 1];
};
const isParty = (e: Edge): boolean => e.kind === 'party';
/** The viewer's RIGHT when facing edge `e` from outside (= −e.dir) — text on the face runs this way. */
const viewRight = (e: Edge): V3L => [-e.dir[0], 0, -e.dir[1]];
const dirA = (e: Edge): V3L => [e.dir[0], 0, e.dir[1]];
const outA = (e: Edge): V3L => [e.out[0], 0, e.out[1]];
const UP: V3L = [0, 1, 0];

/** Storey coordinate of height y: row j spans levels[j]..levels[j+1] (ground = row 0, height gH; upper rows fh). */
export function storeyV(ctx: BuildCtx, y: number): number {
    return y <= ctx.gH ? y / ctx.gH : 1 + (y - ctx.gH) / ctx.fh;
}

/** Windowed wall from ya to yb with ONE pattern cell per storey (split at the ground-floor line, where the storey
 *  height changes). `skip` masks party edges; ctx.uOff shifts each face's cell ids (L6 night-window variety). */
function storeyWall(ctx: BuildCtx, acc: Accum3D, poly: V2[], ya: number, yb: number, cell: number, skip?: boolean[]): void {
    const { gH, uOff } = ctx;
    if (ya < gH - 0.01 && yb > gH + 0.01) {
        acc.wallsWin(poly, ya, gH - ya, cell, cell, { rows: [storeyV(ctx, ya), 1], uOffset: uOff, skip });
        ya = gH;
    }
    if (yb - ya > 0.01) acc.wallsWin(poly, ya, yb - ya, cell, cell, { rows: [storeyV(ctx, ya), storeyV(ctx, yb)], uOffset: uOff, skip });
}

/** Does the shopfront WRAP onto this (non-front) edge? Only with city context (a corner lot's side street) and
 *  only when the edge is long enough for a bay — otherwise it keeps a plain ground wall. */
export function wrapsShop(ctx: BuildCtx, e: Edge): boolean {
    return ctx.contextual && ctx.p.storefront && e.kind === 'street' && e.i !== ctx.front.i && e.len >= 1.6 && ctx.p.windowStyle !== 'curtain';
}

/** Polygon offset that stays FLUSH on party edges (0) and projects `amt` elsewhere. */
const exposedOffset = (ctx: BuildCtx, poly: V2[], amt: number): V2[] =>
    poly === ctx.foot ? offsetPolyEdges(poly, ctx.edges.map(e => isParty(e) ? 0 : amt)) : offsetPoly(poly, amt);
const partyMask = (ctx: BuildCtx, poly: V2[]): boolean[] | undefined =>
    poly === ctx.foot && ctx.edges.some(isParty) ? ctx.edges.map(isParty) : undefined;

// ── PHASE 1/5 · MASSING — walls per section (setbacks/podium), plinth, setback terraces ──
export function emitMassing(ctx: BuildCtx): void {
    const { p, A, sections, foot, edges, front, baseTop, gH } = ctx;
    const bay = Math.max(1, p.bayWidth);
    const curtain = p.windowStyle === 'curtain';
    const pitch = wallCellPitch(p), cPitch = bay * 0.8;
    const party = partyMask(ctx, foot);

    // Plinth course (+ the ground-floor slab): proud on exposed faces, flush + faceless on party walls.
    const plinth = exposedOffset(ctx, foot, 0.08);
    A.trim.walls(plinth, 0, baseTop, party); A.trim.cap(plinth, baseTop, 1);

    for (let si = 0; si < sections.length; si++) {
        const s = sections[si];
        const skip = s.foot === foot ? party : undefined;
        const y0 = Math.max(s.y0, baseTop), y1 = s.y1;
        if (y1 - y0 < 0.1) continue;
        // PARTY walls: plain panels the full section height (from the ground on the base section).
        if (skip) A.party.walls(s.foot, si === 0 ? 0 : s.y0, y1 - (si === 0 ? 0 : s.y0), skip.map(b => !b));
        if (curtain) {
            storeyWall(ctx, A.glass, s.foot, y0, y1, cPitch, skip);
        } else if (si === 0 && p.storefront) {
            const gTop = Math.min(y1, gH);
            // Solid ground wall on every edge EXCEPT the shopfront edges — the storefront glazing + door OPEN those
            // edges into the interior (a real opening a door can swing through). With city context the shopfront
            // wraps round every street edge (corner lots — B11), so only open edges keep a plain ground wall.
            if (gTop - y0 > 0.05) for (const e of edges) {
                if (e.i === front.i || isParty(e) || wrapsShop(ctx, e)) continue;
                A.wallBase.quad4([e.a[0], y0, e.a[1]], [e.b[0], y0, e.b[1]], [e.b[0], gTop, e.b[1]], [e.a[0], gTop, e.a[1]]);
            }
            if (y1 > gH) storeyWall(ctx, A.wall, s.foot, gH, y1, pitch, skip);     // windowed upper floors
        } else {
            storeyWall(ctx, A.wall, s.foot, y0, y1, pitch, skip);
        }
        if (si < sections.length - 1) {   // setback terrace: cap the lower section + a low lip (roofline → parapet layer)
            A.parapet.cap(s.foot, s.y1, 1);
            const lip = offsetPoly(s.foot, 0.04);
            A.parapet.walls(lip, s.y1, 0.3); A.parapet.cap(lip, s.y1 + 0.3, 1);
        }
    }

    // curtain-wall mullions: real vertical fins on the glazed sections (glass towers) — never on a party wall
    if (p.mullions && curtain) {
        let count = 0;
        for (const s of sections) {
            const sEdges = edgesOf(s.foot);
            for (const e of sEdges) {
                if (s.foot === foot && isParty(edges[e.i])) continue;
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

/** Edges that host UTILITIES (AC, pipes, stairs, laundry): the open (non-street, non-party) edges in the city; in
 *  the standalone Creator every non-front edge (legacy "rear"). */
function utilityEdges(ctx: BuildCtx, minLen = 1.2): Edge[] {
    const { edges, front, contextual } = ctx;
    return contextual ? edges.filter(e => e.kind === 'open' && e.len >= minLen) : edges.filter(e => e.i !== front.i && e.len >= minLen);
}
/** The back edge: the open edge facing most AWAY from the front (fire escapes / back stairs prefer it). */
function backEdge(ctx: BuildCtx): Edge | null {
    const cands = utilityEdges(ctx, 1.6);
    let best: Edge | null = null, bs = Infinity;
    for (const e of cands) { const d = e.out[0] * ctx.front.out[0] + e.out[1] * ctx.front.out[1] - e.len * 0.01; if (d < bs) { bs = d; best = e; } }
    return best;
}

// ── PHASE 3 · FACADE DETAIL + MATERIALS — ledges, cornice, pilasters, quoins, downpipes, wall AC, fire escape, entrance ──
export function emitFacadeDetail(ctx: BuildCtx): void {
    const { p, A, edges, foot, sections, levels, floors, baseTop, topY, gH, front, rnd, contextual } = ctx;
    const bay = Math.max(1, p.bayWidth);

    if (p.ledges) {
        // Floor-band LEDGE (persona polish D2): a slab-edge string course ~11 cm tall, 9 cm proud — bold enough to
        // throw a shadow line at mid distance (the old 7 × 7 cm course vanished past a few metres). The window
        // shader paints a matching floor band, so the rhythm survives once the DETAIL tier culls this geometry.
        const LH = 0.055, LP = 0.09;
        const band = (poly: V2[], y: number, skip?: boolean[]): void => { A.trim.walls(poly, y - LH, LH * 2, skip); A.trim.cap(poly, y + LH, 1); A.trim.cap(poly, y - LH, -1); };
        const wb = windowRowBoundaries(ctx);
        if (wb) {
            // ★ String-course bands on the storey lines BETWEEN window rows (the rows are storeys now), so a band
            // never cuts across a window.
            const lg = exposedOffset(ctx, sections[0].foot, LP), sk = partyMask(ctx, sections[0].foot);
            for (const y of wb) band(lg, y, sk);
        } else {
            for (let i = 1; i < floors; i++) { const y = levels[i]; const s = sectionAt(sections, y); band(exposedOffset(ctx, s.foot, LP), y, partyMask(ctx, s.foot)); }
        }
    }

    if (p.cornice) {   // crown moulding on the top section → the PARAPET layer (the roofline must not LOD-cull, B10)
        const s = sections[sections.length - 1]; const c1 = exposedOffset(ctx, s.foot, 0.12), sk = partyMask(ctx, s.foot);
        A.parapet.walls(c1, topY - 0.3, 0.3, sk); A.parapet.cap(c1, topY, 1); A.parapet.cap(c1, topY - 0.3, -1);
    }

    if (p.pilasters) {   // vertical strips between bays on street edges (ground section height)
        const yTop = sections[0].y1; let count = 0;
        for (const e of edges) {
            if (!e.street) continue;
            const n = Math.max(1, Math.round(e.len / bay));
            for (let k = 1; k < n && count < 48; k++) {
                const pt = edgePt(e, k / n, 0.06);
                A.trim.obox([pt[0], (baseTop + yTop) / 2, pt[1]], [e.dir[0], 0, e.dir[1]], [0, 1, 0], [e.out[0], 0, e.out[1]], 0.07, (yTop - baseTop) / 2, 0.05);
                count++;
            }
        }
    }

    // Quoins only on corners between two EXPOSED faces (a corner stone against a party wall reads as a mistake).
    const exposedCorner = (vi: number): boolean => !isParty(edges[vi]) && !isParty(edges[(vi - 1 + edges.length) % edges.length]);
    if (p.quoins && (p.quoinStyle ?? 'alternating') === 'block') {
        // OLD 'block' style — a chunky cube centred on each corner vertex, jutting 0.2 m out of both faces.
        const yTop = Math.min(topY, sections[0].y1); const step = 0.75, n = Math.min(26, Math.floor((yTop - baseTop) / step));
        foot.forEach((vtx, vi) => {
            if (!exposedCorner(vi)) return;
            for (let k = 0; k < n; k++) {
                if (k % 2) continue;
                A.trim.obox([vtx[0], baseTop + k * step + step * 0.5, vtx[1]], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.2, step * 0.42, 0.2);
            }
        });
    } else if (p.quoins) {
        // Proper ALTERNATING quoins (default): each course is a stone running ALONG one wall face, only slightly
        // proud, alternating to the OTHER wall each course (the classic interlocking corner-stone look).
        const yTop = Math.min(topY, sections[0].y1);
        const step = 0.6, n = Math.min(30, Math.floor((yTop - baseTop) / step));
        const m = foot.length;
        let cx0 = 0, cz0 = 0; for (const v of foot) { cx0 += v[0]; cz0 += v[1]; } cx0 /= m; cz0 /= m;   // footprint centroid (for outward)
        const nrm2 = (dx: number, dz: number): [number, number] => { const l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
        const outFor = (vx: number, vz: number, dx: number, dz: number): [number, number] => {
            let px = dz, pz = -dx;                                            // perpendicular to the edge...
            if ((vx - cx0) * px + (vz - cz0) * pz < 0) { px = -px; pz = -pz; }  // ...pointing AWAY from the centroid
            return nrm2(px, pz);
        };
        const proud = 0.06, sh = step * 0.4;
        for (let vi = 0; vi < m; vi++) {
            if (!exposedCorner(vi)) continue;
            const vtx = foot[vi], nx = foot[(vi + 1) % m], pv = foot[(vi - 1 + m) % m];
            const dN = nrm2(nx[0] - vtx[0], nx[1] - vtx[1]), dP = nrm2(pv[0] - vtx[0], pv[1] - vtx[1]);   // along each edge from the corner
            const oN = outFor(vtx[0], vtx[1], dN[0], dN[1]), oP = outFor(vtx[0], vtx[1], dP[0], dP[1]);
            for (let k = 0; k < n; k++) {
                const useNext = k % 2 === 0;
                const along = useNext ? dN : dP, out = useNext ? oN : oP, seg = useNext ? nx : pv;
                const L = Math.min(0.55, Math.hypot(seg[0] - vtx[0], seg[1] - vtx[1]) * 0.38);   // clamp so short edges don't overshoot
                const y = baseTop + k * step + step * 0.5;
                A.trim.obox([vtx[0] + along[0] * L * 0.5, y, vtx[1] + along[1] * L * 0.5], [along[0], 0, along[1]], [0, 1, 0], [out[0], 0, out[1]], L * 0.5, sh, proud);
            }
        }
    }

    if (p.downpipes) {
        // Downpipes on the open side/back; with none (a mid-terrace lot) they run down the FRONT corners — the
        // Japanese street-facade look — never inside a party wall.
        const hosts = utilityEdges(ctx);
        if (hosts.length || !contextual) {
            const es = hosts.length ? hosts : edges;
            for (let i = 0; i < Math.min(2, es.length); i++) { const pt = edgePt(es[i], 0.12, 0.05); post(A.duct, pt[0], pt[1], 0.3, topY, 0.06); }
        } else {
            for (const t of [0.03, 0.97]) { const pt = edgePt(front, t, 0.05); post(A.duct, pt[0], pt[1], 0.3, topY, 0.05); }
        }
    }

    if (p.wallUnits) {   // window AC units on non-front upper floors (open edges only in the city)
        let c = 0;
        const hosts = utilityEdges(ctx);
        for (let i = 1; i < floors && c < 10; i++) {
            const y = levels[i];
            for (const e of hosts) {
                if (rnd() < 0.5 || c >= 10) continue;
                const pt = edgePt(e, 0.3 + rnd() * 0.4, 0.15);
                A.equip.obox([pt[0], y + 0.6, pt[1]], [e.dir[0], 0, e.dir[1]], [0, 1, 0], [e.out[0], 0, e.out[1]], 0.35, 0.25, 0.2);
                c++;
            }
        }
    }

    if (p.fireEscape) {
        // On an OPEN side/back face (never the front, never a party wall). Standalone: the legacy non-street pick.
        const side = contextual ? backEdge(ctx) : (edges.find(e => !e.street) ?? edges[Math.min(1, edges.length - 1)]);
        if (side) {
            const w = Math.min(2.2, side.len * 0.5);
            for (let i = 1; i < floors; i++) {
                const y = levels[i]; const c = edgePt(side, 0.5, 0.55);
                A.steel.obox([c[0], y, c[1]], [side.dir[0], 0, side.dir[1]], [0, 1, 0], [side.out[0], 0, side.out[1]], w / 2, 0.04, 0.5);
                A.steel.obox([c[0] + side.out[0] * 0.5, y + 0.4, c[1] + side.out[1] * 0.5], [side.dir[0], 0, side.dir[1]], [0, 1, 0], [side.out[0], 0, side.out[1]], w / 2, 0.35, 0.03);
            }
            for (const s2 of [-1, 1]) { const a = edgePt(side, 0.5 + s2 * 0.18, 0.55); post(A.steel, a[0], a[1], baseTop, topY, 0.05); }
        }
    }

    // Residential entrance (non-shop): a real door. (Apaato flats get their own doors off the corridor instead.)
    if (!p.storefront && !p.rollerDoors && !p.canopy && !p.openCorridor) {
        const dw = Math.max(0.9, Math.min(1.1, front.len * 0.2)), dh = Math.min(2.1, gH * 0.68);   // realistic ~2.0 m × 0.9–1.1 m
        emitDoor(ctx, front, 0.5, dw, dh, false);   // solid wall behind → keep the leaf proud so it's visible
    }
}

// ── PHASE 3 · BALCONIES ──
export function emitBalconies(ctx: BuildCtx): void {
    const { p, A, edges, levels, floors, front } = ctx;
    const pitch = wallCellPitch(p);
    const faces = edges.filter(e => e.street && (e === front || e.len >= front.len * 0.6));
    if (p.balconyStyle === 'panel') { for (const e of faces) emitPanelBalconies(ctx, e); return; }
    for (const e of faces) {
        // one balcony per WINDOW COLUMN (the same round(len / pitch) columns the shader draws), centred on it
        const cols = Math.max(1, Math.round(e.len / pitch));
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

/** MANSION balconies: a continuous slab per floor with a frosted / solid panel front, a divider between units, an
 *  AC condenser on each unit's slab and a laundry pole under the soffit (the Japanese apartment-block face). */
function emitPanelBalconies(ctx: BuildCtx, e: Edge): void {
    const { p, A, levels, floors, rnd } = ctx;
    const D = 1.05;                                            // balcony depth (m)
    const span = e.len - 0.3, half = span / 2;
    if (span < 1.5) return;
    const units = Math.max(1, Math.round(span / 5.4));        // ~5.4 m flats (two window bays)
    const d = dirA(e), o = outA(e);
    const at = (t: number, off: number): V2L => edgePt(e, t, off);
    for (let i = 1; i < floors; i++) {
        const y = levels[i];
        const c = at(0.5, D / 2);
        A.trim.obox([c[0], y + 0.07, c[1]], d, UP, o, half, 0.08, D / 2);                                         // slab
        const f = at(0.5, D - 0.03);
        A.panel.obox([f[0], y + 0.6, f[1]], d, UP, o, half, 0.46, 0.03);                                          // frosted front panel
        A.trim.obox([f[0], y + 1.1, f[1]], d, UP, o, half + 0.02, 0.04, 0.06);                                    // coping rail
        for (let u = 0; u <= units; u++) {                                                                         // unit dividers (fire-break boards)
            const t = 0.15 / e.len + (u / units) * (span / e.len);
            const dv = at(t, D / 2);
            A.panel.obox([dv[0], y + 1.2, dv[1]], d, UP, o, 0.025, 1.05, D / 2 - 0.04);
        }
        for (let u = 0; u < units; u++) {
            const t0 = 0.15 / e.len + (u / units) * (span / e.len), t1 = t0 + span / e.len / units;
            // AC condenser on the slab at one end of the unit (a real mansion balcony always has one)
            if (p.acUnits) {
                const ac = edgePt(e, t0 + (t1 - t0) * 0.14, D * 0.55);
                A.equip.obox([ac[0], y + 0.46, ac[1]], d, UP, o, 0.39, 0.3, 0.14);
                A.duct.disc([ac[0] + o[0] * 0.15, y + 0.46, ac[1] + o[2] * 0.15], o, 0.2, 10);
            }
            // laundry pole under the next floor's slab + a few garments on some units
            if (p.laundry && i < floors) {
                const py = Math.min(y + 2.15, (levels[i + 1] ?? y + 2.6) - 0.35);
                const a = edgePt(e, t0 + (t1 - t0) * 0.32, D * 0.72), b = edgePt(e, t1 - (t1 - t0) * 0.08, D * 0.72);
                A.steel.beam([a[0], py, a[1]], [b[0], py, b[1]], 0.018, 4);
                if (rnd() < 0.55) hangWashing(A.cloth, [a[0], py, a[1]], [b[0], py, b[1]], o, rnd);
            }
        }
    }
}

/** A few garments (flat quads) hanging from a pole a→b (towels / shirts / a futon over the rail). */
function hangWashing(acc: Accum3D, a: V3L, b: V3L, o: V3L, rnd: () => number): void {
    const n = 2 + ((rnd() * 3) | 0);
    for (let k = 0; k < n; k++) {
        const t = (k + 0.3 + rnd() * 0.4) / n;
        const cx = a[0] + (b[0] - a[0]) * t, cz = a[2] + (b[2] - a[2]) * t, y = a[1];
        const L = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1, dx = (b[0] - a[0]) / L, dz = (b[2] - a[2]) / L;
        const w = 0.18 + rnd() * 0.16, h = 0.45 + rnd() * 0.35;
        acc.quad4([cx - dx * w, y, cz - dz * w], [cx + dx * w, y, cz + dz * w], [cx + dx * w + o[0] * 0.02, y - h, cz + dz * w + o[2] * 0.02], [cx - dx * w + o[0] * 0.02, y - h, cz - dz * w + o[2] * 0.02]);
    }
}

// Iterate the ACTUAL rendered windows. Windows are a shader pattern (windowsPattern) on the wall UVs:
//   • u: freq = 1/pitch (pitch = wallCellPitch), quantized to round(len/pitch) whole cells per face (wallsWin)
//   • v: ONE ROW PER STOREY (emitMassing / storeyWall) — row j spans levels[j]..levels[j+1]
//   • opening within each cell: windowInsets(p) (x each side, b below, t above) — mirrors the shader's winInsets
// Emits one WinInfo per rendered window on the base section's STREET faces (party / open faces skipped), upper
// storeys only (the ground row is the street level).
interface WinInfo { e: Edge; dirA: V3L; outA: V3L; t: number; halfWidth: number; yBottom: number; yTop: number; yCenter: number; }
function forEachWindow(ctx: BuildCtx, cap: number, cb: (w: WinInfo) => void): void {
    const { p, edges, sections, levels, floors } = ctx;
    if (!discreteWindows(p)) return;                                       // discrete windows only
    if (p.material === 'timber' || p.material === 'metal') return;         // those facades aren't windowed masonry
    const pitch = wallCellPitch(p), freq = 1 / pitch;
    const ins = windowInsets(p);
    const s0 = sections[0];
    let count = 0;
    for (const e of edges) {
        if (!e.street || e.len < pitch * 0.6) continue;
        const nl = e.len;
        const uMax = nl < pitch * 0.55 ? pitch * 0.2 : Math.max(1, Math.round(nl / pitch)) * pitch;   // wallsWin u quantization
        const colsWin = Math.max(1, Math.round(uMax * freq));             // integer → every window is whole
        const dirA: V3L = [e.dir[0], 0, e.dir[1]], outA: V3L = [e.out[0], 0, e.out[1]];
        const halfWidth = 0.5 * ((1 - 2 * ins.x) / freq) * (nl / uMax);   // window opening half-width in world units
        for (let j = 1; j < floors; j++) {
            const ya = levels[j], yb = levels[j + 1];
            if (yb > s0.y1 + 0.01) break;                                   // only storeys on the base section
            const hgt = yb - ya;
            const yBottom = ya + ins.b * hgt, yTop = yb - ins.t * hgt;
            for (let k = 0; k < colsWin; k++) {
                if (count++ >= cap) return;
                cb({ e, dirA, outA, t: ((k + 0.5) / freq) / uMax, halfWidth, yBottom, yTop, yCenter: (yBottom + yTop) / 2 });
            }
        }
    }
}

/** Y positions for horizontal string-course bands: the storey lines between upper window rows (so a band never
 *  crosses a window). Null when the building isn't discrete-windowed masonry (caller falls back to the floor
 *  grid). ★ MUST mirror forEachWindow's row grid. */
function windowRowBoundaries(ctx: BuildCtx): number[] | null {
    const { p, gH, sections, topY, levels, floors } = ctx;
    if (!discreteWindows(p)) return null;
    if (p.material === 'timber' || p.material === 'metal') return null;
    const top = Math.min(sections[0].y1, topY);
    const out: number[] = [];
    for (let j = 2; j < floors; j++) { const y = levels[j]; if (y > gH + 0.1 && y < top - 0.05) out.push(y); }
    return out;
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
    const ft = 0.06, yHead = winH;   // frame member size — slimmed (was 0.09) so surrounds read slim, not chunky
    acc.obox(at(0, 0.04, yHead + ft), LX, LY, LZ, ohw + ft * 1.6, ft * 0.7, 0.04);            // lintel
    acc.obox(at(0, 0.055, yHead + ft * 1.9), LX, LY, LZ, ohw + ft * 2.1, ft * 0.32, 0.055);   // cornice lip
    acc.obox(at(0, 0.06, -ft * 0.6), LX, LY, LZ, ohw + ft * 2.0, ft * 0.5, 0.06);             // sill
    for (const s of [-1, 1]) acc.obox(at(s * (ohw + ft * 0.5), 0.035, winH / 2), LX, LY, LZ, ft * 0.5, winH / 2, 0.035);   // jambs
    if (keystone) acc.obox(at(0, 0.06, yHead + ft * 0.4), LX, LY, LZ, ft * 0.7, ft * 1.3, 0.06);   // keystone
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
    const keystone = p.windowStyle === 'punched' && p.material === 'brick' && !p.windowSash;   // keystones are a Western brick detail — never on Japanese sash facades
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

/** The D2 sill tone: aluminium flashing on sash facades, else pale or dark stone by the wall's own value — a FIXED
 *  set of three, so a whole city's sills fall into a handful of instance groups. */
export function sillColor(p: BuildingParams): [number, number, number] {
    if (p.windowSash && discreteWindows(p)) return [0.60, 0.61, 0.63];
    const lum = 0.2126 * p.baseColor[0] + 0.7152 * p.baseColor[1] + 0.0722 * p.baseColor[2];
    return lum > 0.5 ? [0.80, 0.79, 0.76] : [0.34, 0.34, 0.35];
}

/** Build ONE window sill at the origin (local: +X along, +Y up, +Z out): a slab whose TOP sits at y = 0, running a
 *  little past the opening each side. Sash = thin aluminium flashing; masonry = a chunkier stone / precast sill.
 *  Five faces (the back face is buried in the wall): 10 triangles. */
function buildSillCanonical(acc: Accum3D, hw: number, sash: boolean): void {
    const h = sash ? 0.035 : 0.06, d = sash ? 0.06 : 0.085, x0 = -hw, x1 = hw;
    const P = (x: number, y: number, z: number): V3L => [x, y, z];
    acc.quad4(P(x0, 0, d), P(x1, 0, d), P(x1, 0, 0), P(x0, 0, 0));                 // top (faces +Y)
    acc.quad4(P(x0, -h, d), P(x1, -h, d), P(x1, 0, d), P(x0, 0, d));               // front (faces +Z)
    acc.quad4(P(x0, -h, 0), P(x1, -h, 0), P(x1, -h, d), P(x0, -h, d));             // underside (faces −Y) — the drip shadow
    acc.quad4(P(x1, -h, d), P(x1, -h, 0), P(x1, 0, 0), P(x1, 0, d));               // right end
    acc.quad4(P(x0, -h, 0), P(x0, -h, d), P(x0, 0, d), P(x0, 0, 0));               // left end
}

/** D2 WINDOW SILLS: one slim projecting sill under every upper-floor window on the street faces (the same windows
 *  the shader draws — forEachWindow), as canonical geometry per width bucket + per-window transforms (instanced).
 *  With the shader's recessed reveal behind it, the opening reads as a punched hole with depth, not paint. */
export function emitWindowSills(ctx: BuildCtx): void {
    const { p } = ctx;
    if (p.julietBalconies || (p.balconies && p.balconyStyle === 'panel')) return;   // those already frame the window base
    const sash = p.windowSash && discreteWindows(p);
    const buckets = new Map<string, { geometry: ReturnType<Accum3D['geometry']>; instances: InstanceXform[] }>();
    forEachWindow(ctx, WINDOW_DETAIL_CAP, (win) => {
        const hw = bk(win.halfWidth + (sash ? 0.03 : 0.06));
        const key = `sill:w${hw.toFixed(2)}:${sash ? 's' : 'm'}`;
        let g = buckets.get(key);
        if (!g) { const acc = new Accum3D(); buildSillCanonical(acc, hw, sash); g = { geometry: acc.geometry(), instances: [] }; buckets.set(key, g); }
        const c = edgePt(win.e, win.t, 0);
        g.instances.push({ x: c[0], y: win.yBottom, z: c[1], ry: Math.atan2(win.outA[0], win.outA[2]) });
    });
    for (const [key, g] of buckets) ctx.instGroups.push({ name: 'bldg:trim-sill', key, geometry: g.geometry, instances: g.instances });
}

// ── PHASE 2 · STOREFRONTS ────────────────────────────────────────────────────────────────────────────────
/** The sign accumulator for tenant `k` (three colours rotate so a street of shops isn't one colour). */
const signAcc = (ctx: BuildCtx, k: number): Accum3D => [ctx.A.sign, ctx.A.signB, ctx.A.signC][((k % 3) + 3) % 3];

/** The word list for this building's signs (C1): archetype identity, else the district's mood. */
const wordKind = (ctx: BuildCtx): SignWordKind => signWordKind(ctx.p.archetype, ctx.p.signDistrict);

/** The LETTERING accumulator for text on a face of sign accumulator `face` (B5): cream glowing text on dark /
 *  saturated boxes, dark or coloured ink on white / cream / yellow boxes, coloured glowing text on black boxes.
 *  Any other face (LED screen …) keeps the cream text. */
function inkFor(ctx: BuildCtx, face: Accum3D): Accum3D {
    const { A, p } = ctx;
    const k = face === A.sign ? 0 : face === A.signB ? 1 : face === A.signC ? 2 : -1;
    if (k < 0) return A.signText;
    const col = [p.signColor, p.signColor2, p.signColor3][k];
    switch (letteringFor(col, ihash(p.seed, 0x1e7 + k))) {
        case 'ink': return A.signInk;
        case 'inkColor': return A.signInkC;
        case 'glowColor': return A.signTextC;
        default: return A.signText;
    }
}

/** Stroke weight per lettering accumulator: dark / coloured INK on a backlit box is drawn bolder (bloom from the
 *  bright face erodes thin dark strokes at night). */
const inkWeight = (ctx: BuildCtx, ink: Accum3D): number => (ink === ctx.A.signInk || ink === ctx.A.signInkC ? 1.3 : 1);

/** Glyph lettering on a flat sign face of accumulator `face` (centre `c`, facing e.out, width w × height h): a real
 *  shop word (C1) in the face's lettering colour (B5). */
function letter(ctx: BuildCtx, face: Accum3D, e: Edge, c: V3L, w: number, h: number, seed: number, vertical = false): void {
    const n = vertical ? Math.max(2, Math.min(5, Math.round(h / Math.max(0.2, w)))) : Math.max(2, Math.min(7, Math.round(w / Math.max(0.2, h * 0.95))));
    const ink = inkFor(ctx, face);
    emitGlyphRun(ink, c, viewRight(e), UP, outA(e), w, h, signWord(seed, n, vertical, wordKind(ctx)), vertical, 0.012, inkWeight(ctx, ink));
}

/** One LIGHTBOX face (C2): the lit panel `face` inset by a rim, joined to the casing's front by a bevelled lip in
 *  the frame colour. `fc` = the face centre ON the face plane (text / adverts sit on this plane, unchanged), `r`/`u`
 *  = the viewer's right / up on the face, `hx` × `hy` = the face half-size, `bev` = how far the casing front sits
 *  behind the face plane. 10 tris. Winding follows the lettering's (right × up = outward). */
function lightFace(face: Accum3D, frame: Accum3D, fc: V3L, r: V3L, u: V3L, n: V3L, hx: number, hy: number, bev: number): void {
    const rim = Math.min(0.05, 0.14 * Math.min(hx, hy));
    const P = (x: number, y: number, z: number): V3L => [fc[0] + r[0] * x + u[0] * y + n[0] * z, fc[1] + r[1] * x + u[1] * y + n[1] * z, fc[2] + r[2] * x + u[2] * y + n[2] * z];
    const ix = hx - rim, iy = hy - rim;
    const oBL = P(-hx, -hy, -bev), oBR = P(hx, -hy, -bev), oTR = P(hx, hy, -bev), oTL = P(-hx, hy, -bev);
    const iBL = P(-ix, -iy, 0), iBR = P(ix, -iy, 0), iTR = P(ix, iy, 0), iTL = P(-ix, iy, 0);
    face.quad4(iBL, iBR, iTR, iTL);                    // the lit panel
    frame.quad4(iTL, iTR, oTR, oTL);                   // top lip
    frame.quad4(oBL, oBR, iBR, iBL);                   // bottom lip
    frame.quad4(oBL, iBL, iTL, oTL);                   // left lip
    frame.quad4(iBR, oBR, oTR, iTR);                   // right lip
}

/** A wall-mounted LIGHTBOX sign replacing the flat colour slab (`panel`'s placement exactly — same front plane, so
 *  lettering + adverts sit where they always did): a casing box in the frame colour (its side faces show the
 *  depth) + a bevelled lit face. 22 tris (was 12). */
function signBox(ctx: BuildCtx, face: Accum3D, mid: V2L, dir: V2L, out: V2L, y0: number, y1: number, off: number, thick: number, len: number): void {
    const hy = Math.max(0.02, (y1 - y0) / 2), hx = len / 2, hz = thick / 2;
    const bev = Math.min(0.03, thick * 0.3);
    const cy = (y0 + y1) / 2;
    const cx = mid[0] + out[0] * off, cz = mid[1] + out[1] * off;
    const oA: V3L = [out[0], 0, out[1]];
    ctx.A.signFrame.obox([cx - out[0] * bev / 2, cy, cz - out[1] * bev / 2], [dir[0], 0, dir[1]], UP, oA, hx, hy, hz - bev / 2);
    lightFace(face, ctx.A.signFrame, [cx + out[0] * hz, cy, cz + out[1] * hz], [-dir[0], 0, -dir[1]], UP, oA, hx, hy, bev);
}

/** ADVERTS (docs/ui/garp.md §Adverts): cover a sign face with a pooled user image. `c` = the face centre ON the
 *  face plane, `n` = its outward normal, `w` × `h` = the face. True → an image went on (the caller skips the
 *  procedural lettering); false (no catalog / empty bucket / outside share) → today's procedural sign, untouched. */
function adFace(ctx: BuildCtx, c: V3L, n: V3L, w: number, h: number, salt: number, forceLit = false): boolean {
    return !!ctx.ads && ctx.ads.face(c, n, w, h, salt >>> 0, forceLit);
}

export function emitStorefront(ctx: BuildCtx): void {
    const { p, A, front, gH, baseTop, edges } = ctx;

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
    // the glass + framing. So just place the entrance door(s), no shopfront.
    if (p.windowStyle === 'curtain') {
        emitDoor(ctx, front, 0.5, Math.max(1.0, Math.min(1.8, front.len * 0.2)), Math.min(2.2, gH * 0.6));
        return;
    }
    ctx.meta.shopfront = true;
    emitShopEdge(ctx, front, true);
    // Corner lots: the shopfront WRAPS round the side street (no blank ground floor facing a street — B11).
    for (const e of edges) if (wrapsShop(ctx, e)) emitShopEdge(ctx, e, false);
}

/** One shopfront edge: glazed bays (lit shop interiors), stallriser / transom / mullions, the entrance (front
 *  only), roller shutters, noren, awnings, fascia or per-bay tenant signs with lettering. */
function emitShopEdge(ctx: BuildCtx, e: Edge, isFront: boolean): void {
    const { p, A, gH, baseTop, meta, rnd } = ctx;
    const bays = isFront && p.shopBays > 0 ? p.shopBays : Math.max(1, Math.round(e.len / 3.2));
    const segs = subdivide(e, bays);
    const fasciaH = p.fascia ? Math.min(1.1, gH * 0.26) : 0;
    const gy0 = baseTop + (p.stallriser ? 0.5 : 0.12), gy1 = gH - (p.transom ? 0.5 : 0.3) - fasciaH;
    const doorBay = isFront ? Math.floor(bays / 2) : -1;   // the entrance occupies the centre-most bay (a real opening)
    const doorH = Math.min(2.2, gH * 0.6);
    const dir = e.dir, ov = e.out;
    for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (i === doorBay) {
            // ENTRANCE bay: the door in a real opening + glazed SIDELIGHTS beside it (+ transom above via emitDoor).
            const sliding = p.doorStyle === 'sliding';
            const doorW = sliding ? Math.max(1.2, Math.min(1.9, s.len * 0.6)) : Math.max(1.0, Math.min(1.1, s.len * 0.45));
            const dl: V2L = [s.mid[0] - dir[0] * doorW / 2, s.mid[1] - dir[1] * doorW / 2];
            const dr: V2L = [s.mid[0] + dir[0] * doorW / 2, s.mid[1] + dir[1] * doorW / 2];
            for (const [pa, pb] of [[s.a, dl], [dr, s.b]] as [V2L, V2L][]) {
                const len = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
                if (len > 0.4) {
                    const mid: V2L = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
                    shopGlass(ctx, e, mid, len * 0.94, gy0, gy1, i * 2 + (pa === s.a ? 0 : 1));   // sidelight = a lit shop window too
                    if (p.stallriser) panel(A.front, mid, dir, ov, baseTop, gy0, 0.07, 0.14, len * 0.9);
                } else if (len > 0.08) {
                    panel(A.front, [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2], dir, ov, baseTop, gH - fasciaH, 0.04, 0.12, len);   // a narrow pier
                }
            }
            emitDoor(ctx, e, (i + 0.5) / bays, doorW, doorH);
            // close the wall over the entrance: above the door head (+ its transom light) and above the sidelights
            const glazedDoor = p.doorStyle === 'glazed' || p.doorStyle === 'double';
            const dTop = doorH + (p.doorStyle === 'auto-slide' ? 0.24 : 0.13 + (glazedDoor ? 0.6 : 0));
            if (gy1 - dTop > 0.05) panel(A.front, s.mid, dir, ov, dTop, gy1, 0.07, 0.14, doorW + 0.3);
            if (gH - fasciaH - gy1 > 0.05) panel(A.front, s.mid, dir, ov, gy1, gH - fasciaH, 0.07, 0.14, s.len * 0.96);
            if (p.noren && sliding) panel(A.awn, s.mid, dir, ov, doorH - 0.75, doorH + 0.08, 0.28, 0.03, doorW * 1.05);   // noren over the door
        } else {
            shopGlass(ctx, e, s.mid, s.len * 0.9, gy0, gy1, i * 2);
            if (p.stallriser) panel(A.front, s.mid, dir, ov, baseTop, gy0, 0.07, 0.14, s.len * 0.92);
            // HEADER: close the band between the glazing head and the upper wall / fascia (with or without a transom
            // it used to be an open slot into the hollow interior).
            panel(A.front, s.mid, dir, ov, gy1, gH - fasciaH, 0.07, 0.14, s.len * 0.96);
            const bars = Math.max(1, Math.round(s.len / 2.6));   // shopfront mullions (fewer, wider panels — less busy)
            for (let k = 1; k < bars; k++) {
                const t = k / bars;
                const px = s.a[0] + (s.b[0] - s.a[0]) * t, pz = s.a[1] + (s.b[1] - s.a[1]) * t;
                A.front.obox([px + ov[0] * 0.07, (gy0 + gy1) / 2, pz + ov[1] * 0.07], [dir[0], 0, dir[1]], [0, 1, 0], [ov[0], 0, ov[1]], 0.04, (gy1 - gy0) / 2, 0.05);
            }
            if (p.shutter) panel(A.front, s.mid, dir, ov, gy1 + 0.35, gy1 + 0.62, 0.1, 0.24, s.len * 0.94);   // shutter box
            // ROLLER SHUTTER partly / fully down on some bays (a closed shop, or one closing up) — B6.
            if (p.shutterBays > 0 && rnd() < p.shutterBays) {
                const drop = [0.35, 0.65, 1.0][(rnd() * 3) | 0];
                panel(A.shutter, s.mid, dir, ov, gy1 - drop * (gy1 - gy0), gy1 + 0.02, 0.1, 0.03, s.len * 0.9);
            }
            if (p.noren) panel(A.awn, s.mid, dir, ov, gH * 0.55, gH * 0.78, 0.5, 0.03, s.len * 0.7);          // hanging shop curtain
        }
        if (p.awning) emitAwning(ctx, e, s.mid, s.len * 0.92, gH * 0.8);
        if (p.signage && !p.fascia) {
            // per-bay TENANT sign over the shopfront, in rotating colours, with lettering
            const sy0 = gH + 0.05, sy1 = gH + 0.5, sw = s.len * 0.88;
            const k = ihash(p.seed, e.i * 17 + i) % 3;
            signBox(ctx, signAcc(ctx, k), s.mid, dir, ov, sy0, sy1, 0.09, 0.12, sw);
            const tc: V3L = [s.mid[0] + ov[0] * 0.15, (sy0 + sy1) / 2, s.mid[1] + ov[1] * 0.15], tSeed = ihash(p.seed, 0x5e1 + e.i * 31 + i);
            if (!adFace(ctx, tc, [ov[0], 0, ov[1]], sw, sy1 - sy0, tSeed)) letter(ctx, signAcc(ctx, k), e, tc, sw, sy1 - sy0, tSeed);
            meta.signSlots.push({ pos: [s.mid[0], (sy0 + sy1) / 2, s.mid[1]], out: ov, width: sw, k: ((k % 3) + 3) % 3 });   // k: visual-polish #5 spill colour
        }
    }
    // PIERS between bays (and at both ends) — the bay glazing is inset, so the joints were open slots.
    for (let i = 0; i <= segs.length; i++) {
        const q = edgePt(e, i / segs.length, 0);
        const hw = Math.min(0.2, (e.len / bays) * 0.05 + 0.03);
        const t0 = i === 0 ? hw : i === segs.length ? -hw : 0;   // end piers sit INSIDE the edge (flush with the corner)
        A.front.obox([q[0] + dir[0] * t0 + ov[0] * 0.07, (baseTop + gH - fasciaH) / 2, q[1] + dir[1] * t0 + ov[1] * 0.07], [dir[0], 0, dir[1]], [0, 1, 0], [ov[0], 0, ov[1]], hw, (gH - fasciaH - baseTop) / 2, 0.08);
    }
    if (p.fascia) emitFascia(ctx, e, gy1 + (p.transom ? 0.5 : 0.3), gH - 0.06, isFront);
}

/** A shop-window pane: ONE quad with 0..1 UVs (one pattern cell = the whole bay) in the windows-mode shop layer.
 *  Each bay gets its own whole-cell u offset so its interior (shelves / posters / lit or not) differs. Outward
 *  normal (the interior-mapping ray needs it). */
function shopGlass(ctx: BuildCtx, e: Edge, mid: V2L, w: number, y0: number, y1: number, idx: number): void {
    const off = 0.06, hw = w / 2;
    const cx = mid[0] + e.out[0] * off, cz = mid[1] + e.out[1] * off;
    const L: V2L = [cx - e.dir[0] * hw, cz - e.dir[1] * hw], R: V2L = [cx + e.dir[0] * hw, cz + e.dir[1] * hw];
    const bayKey = ihash(ctx.p.seed, e.i * 97 + idx * 13 + 7);
    // SHOP WINDOWS (C4): a pooled user image of the shop's interior → a real recessed room behind clear glass
    // (the image on its back wall — true parallax, no shader involved), else today's glass exactly.
    const n: V3L = outA(e);
    if (ctx.ads && ctx.ads.has('interior') && shopRoom(ctx, e, mid, w, y0, y1, bayKey)) {
        ctx.A.shopPane.quad4([R[0], y0, R[1]], [L[0], y0, L[1]], [L[0], y1, L[1]], [R[0], y1, R[1]]);
        shopPoster(ctx, [cx, 0, cz], n, e, w, y0, y1, bayKey, -0.012);   // behind the clear pane
        return;
    }
    if (!ctx.p.shopInterior) panel(ctx.A.shop, mid, e.dir, e.out, y0, y1, 0.06, 0.08, w);
    else {
        const u0 = bayKey % 997;
        ctx.A.shop.quadUV4([R[0], y0, R[1]], [L[0], y0, L[1]], [L[0], y1, L[1]], [R[0], y1, R[1]], [u0 + 1, 0], [u0, 0], [u0, 1], [u0 + 1, 1]);
    }
    shopPoster(ctx, [cx + n[0] * (ctx.p.shopInterior ? 0 : 0.04), 0, cz + n[2] * (ctx.p.shopInterior ? 0 : 0.04)], n, e, w, y0, y1, bayKey, 0.004);   // on the (opaque) glass
}

/** C4: the recessed ROOM of an image-interior bay — the picked 'interior' image on a back wall `depth` behind the
 *  glass plane + pale lit floor / ceiling / side walls facing in (10 tris + the image's 2). False when the bay drew
 *  no image (share / empty bucket) → the caller keeps the procedural glass. */
function shopRoom(ctx: BuildCtx, e: Edge, mid: V2L, w: number, y0: number, y1: number, bayKey: number): boolean {
    const ads = ctx.ads!;
    const glassOff = 0.06, hw = w / 2;
    let depth = Math.max(0.6, Math.min(1.1, (y1 - y0) * 0.45));
    // A corner shared with ANOTHER shopfront edge (front + its wrap-around): the two edges' end rooms would cross in
    // the corner square — keep the room clear of the neighbour's (a bay too close to the corner stays procedural).
    const t = (mid[0] - e.a[0]) * e.dir[0] + (mid[1] - e.a[1]) * e.dir[1];
    const shopEdge = (E: Edge | undefined): boolean => !!E && (E.i === ctx.front.i ? ctx.p.storefront : wrapsShop(ctx, E));
    const nE = ctx.edges.length;
    if (shopEdge(ctx.edges[(e.i - 1 + nE) % nE])) depth = Math.min(depth, t - hw - 0.05);
    if (shopEdge(ctx.edges[(e.i + 1) % nE])) depth = Math.min(depth, e.len - t - hw - 0.05);
    if (depth < 0.5) return false;
    const n = outA(e), yc = (y0 + y1) / 2;
    const back: V3L = [mid[0] + e.out[0] * (glassOff - depth), yc, mid[1] + e.out[1] * (glassOff - depth)];
    if (!ads.faceIn('interior', back, n, w, y1 - y0, (bayKey ^ 0x1e7e) >>> 0, false, 0)) return false;
    // room box corners (x along viewRight, y up, z out from the back wall); faces wound to face INTO the room
    const r = viewRight(e);
    const P = (x: number, y: number, z: number): V3L => [back[0] + r[0] * x + n[0] * z, y, back[2] + r[2] * x + n[2] * z];
    const zf = depth - 0.004;   // just inside the glass plane
    const room = ctx.A.shopRoom;
    room.quad4(P(-hw, y0, zf), P(hw, y0, zf), P(hw, y0, 0), P(-hw, y0, 0));          // floor (faces up)
    room.quad4(P(-hw, y1, 0), P(hw, y1, 0), P(hw, y1, zf), P(-hw, y1, zf));          // ceiling (faces down)
    room.quad4(P(-hw, y0, zf), P(-hw, y0, 0), P(-hw, y1, 0), P(-hw, y1, zf));        // left wall (faces +x)
    room.quad4(P(hw, y0, 0), P(hw, y0, zf), P(hw, y1, zf), P(hw, y1, 0));            // right wall (faces -x)
    return true;
}

/** C4: a pooled 'poster' image on the inside of a shop pane (about half the bays): A-series proportions, a hashed
 *  spot across the bay at eye height. `gc` = the glass centre (x/z), `lift` = its offset along the normal. */
function shopPoster(ctx: BuildCtx, gc: V3L, n: V3L, e: Edge, w: number, y0: number, y1: number, bayKey: number, lift: number): void {
    const ads = ctx.ads;
    if (!ads || !ads.has('poster') || (ihash(bayKey, 0x9057) & 1)) return;
    const ph = Math.min(0.9, (y1 - y0) * 0.42), pw = Math.min(ph * 0.72, w * 0.4);
    if (pw < 0.15) return;
    const span = Math.max(0, w / 2 - pw / 2 - 0.08);
    const t = ((ihash(bayKey, 0x9058) % 1000) / 999) * 2 - 1;
    const r = viewRight(e);
    const c: V3L = [gc[0] + r[0] * span * t, y0 + (y1 - y0) * 0.56, gc[2] + r[2] * span * t];
    ads.faceIn('poster', c, n, pw, ph, (bayKey ^ 0x9059) >>> 0, false, lift);
}

/** KONBINI fascia: a lit band across the whole shopfront edge — three colour stripes + a katakana logo. */
function emitFascia(ctx: BuildCtx, e: Edge, y0: number, y1: number, isFront: boolean): void {
    const { A, p, meta } = ctx;
    if (y1 - y0 < 0.3) return;
    const h = y1 - y0, L = e.len * 0.98;
    // ONE lightbox casing across the whole band (C2) with the brand stripes on its face: the top stripe is the
    // bevelled lit face, the two lower stripes lie on it (seamless, like a real konbini fascia).
    signBox(ctx, A.signB, e.mid, e.dir, e.out, y0, y1, 0.14, 0.12, L);
    const fz = 0.2 + 0.002, rim = Math.min(0.05, 0.14 * Math.min(L / 2, h / 2));
    for (const [acc, a, b] of [[A.signC, y0 + rim, y0 + h * 0.18], [A.sign, y0 + h * 0.18, y0 + h * 0.42]] as [Accum3D, number, number][]) {
        const r: V3L = viewRight(e), hw = L / 2 - rim, cx = e.mid[0] + e.out[0] * fz, cz = e.mid[1] + e.out[1] * fz;
        acc.quad4([cx - r[0] * hw, a, cz - r[2] * hw], [cx + r[0] * hw, a, cz + r[2] * hw], [cx + r[0] * hw, b, cz + r[2] * hw], [cx - r[0] * hw, b, cz - r[2] * hw]);
    }
    // an advert covers the whole band (all three stripes) — the fascia is one long shop strip
    if (!adFace(ctx, [e.mid[0] + e.out[0] * 0.2, (y0 + y1) / 2, e.mid[1] + e.out[1] * 0.2], outA(e), L, h, ihash(p.seed, 0xfa5c1a + e.i)) && isFront) letter(ctx, A.signB, e, [e.mid[0] + e.out[0] * 0.205, y0 + h * 0.71, e.mid[1] + e.out[1] * 0.205], Math.min(L * 0.5, 5), h * 0.5, ihash(p.seed, 0xfa5c1a));
    meta.signSlots.push({ pos: [e.mid[0], (y0 + y1) / 2, e.mid[1]], out: e.out, width: L });
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

    // jambs + head frame (doorFrameColor — its own layer so the surround can be coloured apart from the leaf).
    for (const sgn of [-1, 1]) {
        const jp = along((w / 2 + fr / 2) * sgn);
        A.dframe.obox([jp[0] + out[0] * 0.05, h / 2, jp[1] + out[1] * 0.05], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], fr / 2, h / 2 + fr, 0.16);
    }
    A.dframe.obox([cx + out[0] * 0.05, h + fr / 2, cz + out[1] * 0.05], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], w / 2 + fr, fr / 2, 0.16);

    if (p.doorStyle === 'auto-slide') {
        // COMMERCIAL AUTO-DOOR: two big glass panels meeting at the centre (baked CLOSED) + a header mechanism box
        // with a little sensor eye. `meta.door` carries width/height so the sim layer can later SLIDE the panels.
        for (const sgn of [-1, 1]) {
            const pw = w / 2 - 0.03, pc = along(sgn * w / 4);
            const px = pc[0] + out[0] * leafOff, pz = pc[1] + out[1] * leafOff;
            panel(A.glass, [px, pz], dir, out, 0.14, h - 0.1, 0, 0.03, pw * 0.86);                                     // sliding glass leaf
            A.door.obox([px, 0.11, pz], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], pw / 2, 0.06, 0.055);      // bottom rail
            A.door.obox([px, h - 0.09, pz], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], pw / 2, 0.055, 0.055); // top rail
            const oe = along(sgn * (w / 2 - 0.02));                                                                     // outer-edge stile
            A.door.obox([oe[0] + out[0] * leafOff, h / 2, oe[1] + out[1] * leafOff], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], 0.032, h / 2, 0.06);
            const le = along(sgn * 0.05);                                                                              // meeting stile at the centre
            A.door.obox([le[0] + out[0] * leafOff, h / 2, le[1] + out[1] * leafOff], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], 0.035, h / 2, 0.06);
        }
        A.door.obox([cx + out[0] * 0.03, h + 0.11, cz + out[1] * 0.03], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], w / 2 + fr, 0.11, 0.12);   // slim header mechanism box
        A.sign.obox([cx + out[0] * 0.1, h + 0.06, cz + out[1] * 0.1], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], 0.05, 0.035, 0.03);          // sensor eye (emissive)
    } else if (p.doorStyle === 'sliding') {
        // JAPANESE SLIDING DOOR (izakaya / machiya): two overlapping timber leaves in parallel tracks — glazed upper
        // panes behind a fine vertical LATTICE, a solid kick rail. Baked closed.
        for (const sgn of [-1, 1]) {
            const lw = w / 2 + 0.03, lc = along(sgn * w / 4);
            const off = leafOff + (sgn > 0 ? 0 : -0.045);     // two tracks
            const lx = lc[0] + out[0] * off, lz = lc[1] + out[1] * off;
            const kick = h * 0.3;
            A.door.obox([lx, kick / 2, lz], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], lw / 2, kick / 2, 0.035);            // kick panel
            panel(A.glass, [lx, lz], dir, out, kick, h - 0.06, 0, 0.02, lw * 0.92);                                                 // pane
            for (const yy of [kick, h - 0.04]) A.door.obox([lx, yy, lz], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], lw / 2, 0.035, 0.04);
            for (const sx of [-1, 1]) { const st = [lx + dir[0] * sx * (lw / 2 - 0.03), lz + dir[1] * sx * (lw / 2 - 0.03)]; A.door.obox([st[0], h / 2, st[1]], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], 0.03, h / 2, 0.04); }
            const bars = Math.max(3, Math.round(lw / 0.09));
            for (let b = 1; b < bars; b++) {                                                                                         // lattice (koshi) bars
                const bt = -lw / 2 + (b / bars) * lw, bx = lx + dir[0] * bt + out[0] * 0.03, bz = lz + dir[1] * bt + out[1] * 0.03;
                A.door.obox([bx, (kick + h) / 2, bz], [dir[0], 0, dir[1]], [0, 1, 0], [out[0], 0, out[1]], 0.011, (h - kick) / 2, 0.012);
            }
        }
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

function emitAwning(ctx: BuildCtx, e: Edge, mid: V2L, len: number, ay: number): void {
    const { A, p } = ctx;
    const proj = p.awningStyle === 'flat' ? 0.5 : 0.6;
    A.awn.obox([mid[0] + e.out[0] * proj, ay, mid[1] + e.out[1] * proj], [e.dir[0], 0, e.dir[1]], [0, 1, 0], [e.out[0], 0, e.out[1]], len / 2, 0.05, proj);
    if (p.awningStyle !== 'flat') {   // front valance
        A.awn.obox([mid[0] + e.out[0] * (proj * 1.9), ay - 0.2, mid[1] + e.out[1] * (proj * 1.9)], [e.dir[0], 0, e.dir[1]], [0, 1, 0], [e.out[0], 0, e.out[1]], len / 2, 0.2, 0.05);
    }
}

// ── PHASE 1/7 · ROOF — by roofStyle, sized from the REAL footprint + oriented to the front (B9) ──────────────
/** The roof's working frame: the top section's footprint, its centroid, the front edge's axes, and the footprint's
 *  extent along them (a0..a1 along the street, o0..o1 back→front). Rotated / radial lots stay aligned. */
function roofFrame(ctx: BuildCtx): { foot: V2[]; c: V2L; d: V2L; o: V2L; ext: { a0: number; a1: number; o0: number; o1: number }; span: number } {
    const s = ctx.sections[ctx.sections.length - 1];
    const c = centroid(s.foot), d = ctx.front.dir, o = ctx.front.out;
    const ext = frameExtent(s.foot, c, d, o);
    return { foot: s.foot, c, d, o, ext, span: Math.max(0.5, Math.min(ext.a1 - ext.a0, ext.o1 - ext.o0)) };
}

export function emitRoof(ctx: BuildCtx): void {
    const { p, A } = ctx;
    const s = ctx.sections[ctx.sections.length - 1]; const foot = s.foot; const topY = s.y1; const c = centroid(foot);
    const { span } = roofFrame(ctx);
    const eaveMask = (amt: number): number[] => foot === ctx.foot ? ctx.edges.map(e => isParty(e) ? 0.02 : amt) : foot.map(() => amt);
    switch (p.roofStyle) {
        case 'flat': A.roof.cap(foot, topY, 1); ctx.meta.roofAnchor = [c[0], topY, c[1]]; break;
        case 'parapet': {
            A.roof.cap(foot, topY, 1); const par = exposedOffset(ctx, foot, 0.06);
            A.parapet.walls(par, topY, 0.45); A.parapet.cap(par, topY + 0.45, 1); ctx.meta.roofAnchor = [c[0], topY + 0.45, c[1]]; break;
        }
        case 'hip': emitPitched(ctx, foot, topY, false, eaveMask(p.deepEaves ? 0.6 : 0.28), 0.34 * p.roofPitch * 1.6, span); break;
        case 'tiled-hip': emitPitched(ctx, foot, topY, false, eaveMask(0.9), 0.3 * p.roofPitch * 1.6, span); break;   // machiya: deep-eave low hip
        case 'gable': emitPitched(ctx, foot, topY, true, eaveMask(p.deepEaves ? 0.5 : 0.25), 0.5 * p.roofPitch, span); break;
        case 'mansard': {
            // The inset of the steep lower slope comes from the REAL footprint (was the archetype's default width /
            // depth → on a small lot the top ring crossed over and the roof turned inside-out). Capped well inside.
            const eave = offsetPolyEdges(foot, eaveMask(0.25)); const lowerH = Math.max(1.2, p.floorHeight * 0.7);
            const topRing = offsetPoly(eave, -Math.min(span * 0.22, span * 0.4));
            A.roof.frustum(eave, topRing, topY, topY + lowerH); A.roof.cap(topRing, topY + lowerH, 1);
            ctx.meta.roofAnchor = [c[0], topY + lowerH, c[1]]; break;
        }
        case 'sawtooth': emitSawtooth(ctx, topY); break;
    }
}

/** HIP / GABLE roof fitted to the real footprint. On a 4-sided lot the ridge runs parallel to the LONG pair of edges
 *  (from the midpoints of the short edges — pulled in by half the span for a hip), so the eaves follow the actual
 *  lot edges on rotated / trapezoid lots (the old bbox gable floated off radial lots). Other polygons (chamfered
 *  corner lots) get a pyramid hip sized from the real span. Eaves project only over EXPOSED edges. */
function emitPitched(ctx: BuildCtx, foot: V2[], topY: number, gable: boolean, eaves: number[], rhK: number, span: number): void {
    const { A } = ctx;
    const eave = offsetPolyEdges(foot, eaves);
    A.trim.walls(eave, topY - 0.06, 0.14);                                   // fascia board round the eave
    if (eave.length !== 4) {
        const rh = Math.max(1.0, span * rhK);
        A.roof.pyramid(eave, topY + 0.06, rh); const c = centroid(eave); ctx.meta.roofAnchor = [c[0], topY + rh, c[1]];
        return;
    }
    const L = (i: number): number => Math.hypot(eave[(i + 1) % 4][0] - eave[i][0], eave[(i + 1) % 4][1] - eave[i][1]);
    const k = (L(0) + L(2)) >= (L(1) + L(3)) ? 1 : 0;                       // index of a SHORT edge (ridge ∥ the long pair)
    const v = (j: number): V2L => eave[(k + j) % 4] as V2L;
    const mid = (a: V2L, b: V2L): V2L => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const shortLen = (L(k) + L((k + 2) % 4)) / 2;
    const rh = Math.max(0.8, shortLen * rhK);
    let R0 = mid(v(0), v(1)), R2 = mid(v(2), v(3));
    if (!gable) {   // hip: 45°-in-plan hips → pull each ridge end in by half the span (keep a short ridge)
        const dx = R2[0] - R0[0], dz = R2[1] - R0[1], dl = Math.hypot(dx, dz) || 1;
        const pull = Math.min(shortLen * 0.5, dl * 0.45);
        R0 = [R0[0] + dx / dl * pull, R0[1] + dz / dl * pull]; R2 = [R2[0] - dx / dl * pull, R2[1] - dz / dl * pull];
    }
    const y0 = topY + 0.06, ry = y0 + rh;
    const P = (q: V2L): V3L => [q[0], y0, q[1]];
    const r0: V3L = [R0[0], ry, R0[1]], r2: V3L = [R2[0], ry, R2[1]];
    // Faces in CLOCKWISE order (b, a, …) so quad4's cross product points OUT/UP (edges are CCW).
    A.roof.quad4(P(v(2)), P(v(1)), r0, r2);                                  // long slope over v1→v2
    A.roof.quad4(P(v(0)), P(v(3)), r2, r0);                                  // long slope over v3→v0
    if (gable) {
        // Gable ends: a vertical triangle on the eave line + the soffit band — plain wall colour.
        A.wallBase.quad4(P(v(1)), P(v(0)), r0, r0);
        A.wallBase.quad4(P(v(3)), P(v(2)), r2, r2);
    } else {
        A.roof.quad4(P(v(1)), P(v(0)), r0, r0);                              // hip ends
        A.roof.quad4(P(v(3)), P(v(2)), r2, r2);
    }
    // ridge cap (kawara ridge tiles read as a darker bar)
    const rl = Math.hypot(R2[0] - R0[0], R2[1] - R0[1]);
    if (rl > 0.1) { const rd: V3L = [(R2[0] - R0[0]) / rl, 0, (R2[1] - R0[1]) / rl]; A.trim.obox([(R0[0] + R2[0]) / 2, ry + 0.05, (R0[1] + R2[1]) / 2], rd, UP, [-rd[2], 0, rd[0]], rl / 2 + (gable ? 0 : 0.1), 0.07, 0.1); }
    ctx.meta.roofAnchor = [(R0[0] + R2[0]) / 2, ry, (R0[1] + R2[1]) / 2];
}

/** Warehouse SAWTOOTH roof in the front frame (teeth run back→front, ridges parallel to the street). */
function emitSawtooth(ctx: BuildCtx, topY: number): void {
    const { A, p } = ctx;
    const { c, d, o, ext } = roofFrame(ctx);
    const W = (a: number, oo: number, y: number): V3L => [c[0] + d[0] * a + o[0] * oo, y, c[1] + d[1] * a + o[1] * oo];
    const depth = ext.o1 - ext.o0;
    const teeth = Math.max(3, Math.round(depth / 4)), segD = depth / teeth, th = Math.max(1.2, p.floorHeight * 0.5);
    const low = topY, high = topY + th;
    for (let i = 0; i < teeth; i++) {
        const z0 = ext.o0 + i * segD, z1 = z0 + segD;
        A.roof.quad4(W(ext.a0, z0, low), W(ext.a1, z0, low), W(ext.a1, z1, high), W(ext.a0, z1, high));    // slope
        A.glass.quad4(W(ext.a0, z1, high), W(ext.a1, z1, high), W(ext.a1, z1, low), W(ext.a0, z1, low));   // north-light glazing
    }
    ctx.meta.roofAnchor = [c[0], high, c[1]];
}

// ── PHASE 4 · ROOFTOP DETAIL — penthouse / railing / tanks / AC / aerials / solar heaters / pipes (B9) ──
export function emitRoofDetail(ctx: BuildCtx): void {
    const { p, A, rnd, topY } = ctx;
    const { foot, c, d, o, ext } = roofFrame(ctx);
    const flat = p.roofStyle === 'flat' || p.roofStyle === 'parapet';
    const dA: V3L = [d[0], 0, d[1]], oA: V3L = [o[0], 0, o[1]];
    const W = (a: number, oo: number): V2L => [c[0] + d[0] * a + o[0] * oo, c[1] + d[1] * a + o[1] * oo];
    const halfA = (ext.a1 - ext.a0) / 2, halfO = (ext.o1 - ext.o0) / 2, midA = (ext.a0 + ext.a1) / 2, midO = (ext.o0 + ext.o1) / 2;
    if (!flat) {
        // Pitched roofs: a chimney on Western houses; a TV aerial + solar water heater at the ridge on Japanese ones.
        const [rx, ry0, rz] = ctx.meta.roofAnchor;
        if (p.category === 'house' && !p.windowSash) A.equip.obox([c[0] + d[0] * halfA * 0.4 + o[0] * halfO * 0.2, topY + 0.6, c[1] + d[1] * halfA * 0.4 + o[1] * halfO * 0.2], dA, UP, oA, 0.28, 0.6, 0.28);
        if (p.roofAerial) emitAerial(A, [rx + d[0] * Math.min(1.2, halfA * 0.4), ry0, rz + d[1] * Math.min(1.2, halfA * 0.4)], dA, oA, 1.6 + rnd() * 0.8);
        if (p.solarHeater) emitSolarHeater(A, [rx - d[0] * Math.min(1.0, halfA * 0.3) + o[0] * 0.5, ry0 - 0.35, rz - d[1] * Math.min(1.0, halfA * 0.3) + o[1] * 0.5], dA, oA);
        return;
    }
    if (p.roofPlant === 'clustered') { emitRoofDetailClustered(ctx); return; }   // visual-polish #11 tail
    const s = ctx.sections[ctx.sections.length - 1];
    const ry = s.y1 + (p.roofStyle === 'parapet' ? 0.45 : 0);
    const inside = (q: V2L): boolean => pointInPolygon(q as V2, foot);

    if (p.roofRailing) {
        for (const e of edgesOf(offsetPoly(foot, 0.02))) {
            const n = Math.max(2, Math.round(e.len / 1.5));
            for (let k = 0; k <= n; k++) { const pt = edgePt(e, k / n, 0); post(A.equip, pt[0], pt[1], ry, ry + 0.5, 0.03); }
        }
    }
    // Distinct roof SLOTS on a 3×3 grid in the FRONT frame (minus the centre, kept inside the real footprint),
    // shuffled → clutter spreads out, aligned with the building instead of the world axes.
    const slots: V2L[] = [];
    for (const fa of [-0.58, 0, 0.58]) for (const fo of [-0.58, 0, 0.58]) {
        if (!fa && !fo) continue;
        const q = W(midA + fa * halfA, midO + fo * halfO);
        if (inside(q)) slots.push(q);
    }
    if (!slots.length) slots.push(c);
    for (let i = slots.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; const t = slots[i]; slots[i] = slots[j]; slots[j] = t; }
    let sIdx = 0; const slot = (): V2L => slots[(sIdx++) % slots.length];
    const span = Math.max(0.6, Math.min(halfA, halfO));

    if (p.roofPenthouse) {
        // STAIR BOX (tou-ya) at a back corner: a small room with a steel door facing the front + a flat lid.
        const pw = Math.min(1.5, halfA * 0.45), pd = Math.min(1.3, halfO * 0.45), ph = 2.3;
        const q = W(ext.a0 + pw + 0.35, ext.o0 + pd + 0.35);
        if (inside(q)) {
            A.equip.obox([q[0], ry + ph / 2, q[1]], dA, UP, oA, pw, ph / 2, pd);
            A.parapet.obox([q[0], ry + ph + 0.06, q[1]], dA, UP, oA, pw + 0.12, 0.06, pd + 0.12);
            const dq = [q[0] + o[0] * (pd + 0.02), q[1] + o[1] * (pd + 0.02)];
            A.door.obox([dq[0], ry + 1.0, dq[1]], dA, UP, oA, 0.42, 1.0, 0.03);
        }
    }
    if (p.roofClutter) {
        const [tx, tz] = slot(); const tr = Math.min(span * 0.28, 0.7 + rnd() * 0.4), legH = 0.6;
        for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            const lx = tx + (d[0] * sx + o[0] * sz) * tr * 0.7, lz = tz + (d[1] * sx + o[1] * sz) * tr * 0.7;
            post(A.equip, lx, lz, ry, ry + legH, 0.06);
        }
        A.equip.prism([tx, ry + legH, tz], tr, tr, 1.0 + rnd() * 0.4, 8);                                   // water tank
        const acN = 1 + (rnd() * 3 | 0);
        for (let i = 0; i < acN; i++) {
            const [ax, az] = slot();
            A.equip.obox([ax, ry + 0.3, az], dA, UP, oA, 0.5 + rnd() * 0.3, 0.3, 0.4 + rnd() * 0.2);        // AC condenser, aligned
            A.duct.disc([ax + o[0] * 0.62, ry + 0.3, az + o[1] * 0.62], oA, 0.22, 10);
        }
        const [mx, mz] = slot(); post(A.equip, mx, mz, ry, ry + 1.5 + rnd() * 2, 0.04);
        // PIPE RUNS along the roof between the plant (low galvanised runs on sleepers)
        const pa = W(ext.a0 + 0.5, midO - halfO * 0.2), pb = W(ext.a1 - 0.5, midO - halfO * 0.2);
        if (halfA > 1.5) { A.duct.beam([pa[0], ry + 0.18, pa[1]], [pb[0], ry + 0.18, pb[1]], 0.06, 6); A.duct.beam([pa[0], ry + 0.34, pa[1]], [pb[0], ry + 0.34, pb[1]], 0.04, 6); }
    }
    if (p.roofVents) { const n = 2 + (rnd() * 3 | 0); for (let i = 0; i < n; i++) { const [x, z] = slot(); A.equip.prism([x, ry, z], 0.18, 0.18, 0.4 + rnd() * 0.3, 6); } }
    if (p.roofDishes) { const n = 1 + (rnd() * 2 | 0); for (let i = 0; i < n; i++) { const [x, z] = slot(); A.equip.disc([x, ry + 0.5, z], [o[0] * 0.3, 0.6, o[1] * 0.3], 0.5, 10); } }
    if (p.roofAerial) { const [x, z] = slot(); emitAerial(A, [x, ry, z], dA, oA, 2 + rnd()); }
    if (p.solarHeater) { const [x, z] = slot(); emitSolarHeater(A, [x, ry, z], dA, oA); }
    if (p.roofGarden) { const n = 3 + (rnd() * 3 | 0); for (let i = 0; i < n; i++) { const [x, z] = slot(); A.trim.obox([x, ry + 0.2, z], dA, UP, oA, 0.4, 0.2, 0.4); } }
    if (p.helipad) {
        const r = span * 0.42;
        const hp = [W(midA - r, midO - r), W(midA + r, midO - r), W(midA + r, midO + r), W(midA - r, midO + r)] as V2[];
        A.trim.cap(hp, ry + 0.08, 1);
        A.sign.obox([c[0], ry + 0.1, c[1]], dA, UP, oA, r * 0.55, 0.03, r * 0.12);   // 'H' bar (approx)
        A.sign.obox([c[0], ry + 0.1, c[1]], dA, UP, oA, r * 0.12, 0.03, r * 0.55);
    }
    // crown (towers): a spire mast or a mechanical box above the roof
    if (p.crown === 'spire') { post(A.equip, c[0], c[1], ry, ry + Math.max(4, topY * 0.14), 0.12); post(A.sign, c[0], c[1], ry + Math.max(4, topY * 0.14) - 0.4, ry + Math.max(4, topY * 0.14), 0.05); }
    else if (p.crown === 'mech') { const mw = span * 0.6; A.equip.obox([c[0], ry + 1.2, c[1]], dA, UP, oA, mw, 1.2, mw); A.equip.obox([c[0], ry + 2.8, c[1]], dA, UP, oA, mw * 0.6, 0.5, mw * 0.6); }
    else if (p.crown === 'blade') { A.trim.obox([c[0], ry + 2, c[1]], dA, UP, oA, halfA * 0.9, 2, 0.2); }
}

// ── visual-polish #11 tail · CLUSTERED ROOF PLANT (BuildingParams.roofPlant = 'clustered') ──
/** Water-tank colours of the clustered roofs (FRP sectional tanks + painted steel): a few FIXED tones, so the city's
 *  merge groups stay few and the tank props instance (P20). */
export const ROOF_TANK_COLORS: readonly (readonly [number, number, number])[] = [
    [0.30, 0.50, 0.72],   // FRP blue
    [0.88, 0.88, 0.85],   // white FRP
    [0.84, 0.76, 0.55],   // cream
    [0.36, 0.58, 0.44],   // green
    [0.74, 0.33, 0.25],   // red-oxide steel
];
/** Tank colour weights per district (indices into ROOF_TANK_COLORS). */
const TANK_W: Record<string, readonly number[]> = {
    downtown: [3, 4, 1, 1, 1], market: [3, 1, 3, 1, 2], residential: [4, 2, 2, 3, 1], civic: [2, 4, 1, 2, 0], mixed: [3, 2, 2, 2, 1],
};
/** Extra pieces per district — chances of [solar array, laundry line, neon frame, lit mast]; at most two are kept. */
export const ROOF_EXTRA_W: Record<string, readonly [number, number, number, number]> = {
    downtown: [0.06, 0, 0.3, 0.5], market: [0.15, 0.2, 0.25, 0.2], residential: [0.4, 0.3, 0, 0.1], civic: [0.45, 0, 0, 0.25], mixed: [0.25, 0.25, 0.12, 0.15],
};
const pickW = (w: readonly number[], u: number): number => {
    let t = 0; for (const x of w) t += x;
    let a = u * t;
    for (let i = 0; i < w.length; i++) { a -= w[i]; if (a < 0) return i; }
    return w.length - 1;
};

/** The CLUSTERED flat roof: the plant gathers along the BACK edge (away from the street) — a stair box in the wall
 *  colour, ONE coloured water tank on a stand and ONE AC bank — and the rest of the deck stays clear so the roof
 *  finish (roof variety) and gardens read from above. Up to two district-weighted extras use the front: a solar array,
 *  a laundry line, a neon frame on a commercial roof, a lit mast; a rare tower gets a painted helipad. The archetype's
 *  railing / aerial / dish / solar-heater / crown flags still apply (one of each). Draws come from a lot-seeded hash
 *  stream, never ctx.rnd. The tank / AC bank / mast are one P20 part each, in the building's front frame with fixed
 *  sizes (and yaw-invariant primitives: frame-aligned boxes, prisms turned with the frame), so their copies instance. */
export function emitRoofDetailClustered(ctx: BuildCtx): void {
    const { p, A, topY } = ctx;
    const { foot, c, d, o, ext } = roofFrame(ctx);
    const dA: V3L = [d[0], 0, d[1]], oA: V3L = [o[0], 0, o[1]];
    const W = (a: number, oo: number): V2L => [c[0] + d[0] * a + o[0] * oo, c[1] + d[1] * a + o[1] * oo];
    const X = (a: number, y: number, oo: number): V3L => { const q = W(a, oo); return [q[0], y, q[1]]; };
    const s = ctx.sections[ctx.sections.length - 1];
    const ry = s.y1 + (p.roofStyle === 'parapet' ? 0.45 : 0);
    const lenA = ext.a1 - ext.a0, lenO = ext.o1 - ext.o0, midA = (ext.a0 + ext.a1) / 2;
    const h = (salt: number): number => ihash(p.seed, 0x400f0 + salt) / 4294967296;
    const district = ROOF_EXTRA_W[p.signDistrict ?? ''] ? p.signDistrict! : 'mixed';
    const inset = p.roofStyle === 'parapet' ? 0.4 : 0.3;
    const rot = Math.atan2(-o[0], o[1]);   // a prism's first ring vertex on the frame's local +X (yaw-invariant parts)
    const fwd: V2 = [o[0], o[1]];

    if (p.roofRailing) {
        for (const e of edgesOf(offsetPoly(foot, 0.02))) {
            const n = Math.max(2, Math.round(e.len / 1.5));
            for (let k = 0; k <= n; k++) { const pt = edgePt(e, k / n, 0); post(A.equip, pt[0], pt[1], ry, ry + 0.5, 0.03); }
        }
    }
    // ── occupancy (frame rects: centre a / o, half extents) ──
    const used: [number, number, number, number][] = [];
    const free = (a: number, oo: number, ha: number, ho: number, gap = 0.35): boolean => {
        for (const [sa, so] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) if (!pointInPolygon(W(a + sa * (ha + 0.1), oo + so * (ho + 0.1)) as V2, foot)) return false;
        for (const [ua, uo, uha, uho] of used) if (Math.abs(a - ua) < ha + uha + gap && Math.abs(oo - uo) < ho + uho + gap) return false;
        return true;
    };
    const take = (a: number, oo: number, ha: number, ho: number): [number, number] => { used.push([a, oo, ha, ho]); return [a, oo]; };
    // The cluster: lane 0 runs along the back edge from one back corner; when it is full, lane 1 runs forward along
    // that corner's side edge (narrow deep lots).
    const side = h(1) < 0.5 ? 1 : -1;
    const startA = side > 0 ? ext.a0 : ext.a1;
    const depth = Math.min(2.8, Math.max(1.4, lenO * 0.4));
    let curA = 0, curO = 0;
    const slot = (wa: number, wo: number): [number, number] | null => {
        if (curA + wa + 2 * inset <= lenA) {
            const a = startA + side * (inset + curA + wa / 2), oo = ext.o0 + inset + wo / 2;
            if (free(a, oo, wa / 2, wo / 2, 0.2)) { curA += wa + 0.6; return take(a, oo, wa / 2, wo / 2); }
        }
        // lane 1 (the pieces stay frame-aligned; they step forward along the corner's side edge)
        const a = startA + side * (inset + wa / 2), oo = ext.o0 + inset + depth + 0.6 + curO + wo / 2;
        if (oo + wo / 2 + inset <= ext.o1 && free(a, oo, wa / 2, wo / 2, 0.2)) { curO += wo + 0.6; return take(a, oo, wa / 2, wo / 2); }
        return null;
    };
    const roomy = lenA >= 4.5 && lenO >= 4.5;
    const big = ctx.floors >= 5 && lenA >= 9 && lenO >= 7;

    // 1 · STAIR BOX (tou-ya): a room in the WALL colour, a steel door to the front, a flat lid in the parapet stone.
    if (p.roofPenthouse && roomy) {
        const pw = Math.min(3.2, Math.max(2.0, lenA * 0.22)), pd = Math.min(2.8, Math.max(1.8, depth)), ph = 2.5;
        const q = slot(pw, pd);
        if (q) {
            A.wallBase.obox(X(q[0], ry + ph / 2, q[1]), dA, UP, oA, pw / 2, ph / 2, pd / 2);
            A.parapet.obox(X(q[0], ry + ph + 0.06, q[1]), dA, UP, oA, pw / 2 + 0.12, 0.06, pd / 2 + 0.12);
            A.door.obox(X(q[0] - side * pw * 0.18, ry + 1.0, q[1] + pd / 2 + 0.02), dA, UP, oA, 0.42, 1.0, 0.03);
        }
    }
    if (p.roofClutter) {
        // 2 · ONE WATER TANK: an FRP sectional tank (or, on some roofs, a round steel one) on a steel stand, in one of
        // the fixed district-weighted colours. Two sizes.
        const tc = ROOF_TANK_COLORS[pickW(TANK_W[district] ?? TANK_W.mixed, h(2))];
        const tw = big ? 2.4 : 1.6, td = big ? 1.8 : 1.2, th = big ? 1.6 : 1.2, leg = 0.5;
        const round = h(3) < 0.15;   // (most Japanese roof tanks are FRP sectional boxes)
        const q = ctx.floors >= 4 || h(5) < 0.4 ? slot(tw, td) : null;   // (a low walk-up often feeds straight from the main)
        if (q) {
            ctx.roofTankColor = [tc[0], tc[1], tc[2]];
            partOf([A.tank, A.equip], X(q[0], ry, q[1]), fwd, () => {
                for (const [sa, so] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) A.equip.obox(X(q[0] + sa * (tw / 2 - 0.12), ry + leg / 2, q[1] + so * (td / 2 - 0.12)), dA, UP, oA, 0.06, leg / 2, 0.06);
                A.equip.obox(X(q[0], ry + leg - 0.04, q[1]), dA, UP, oA, tw / 2, 0.04, td / 2);           // stand deck
                if (round) A.tank.prism(X(q[0], ry + leg, q[1]), td / 2, td / 2, th, 8, rot);
                else A.tank.obox(X(q[0], ry + leg + th / 2, q[1]), dA, UP, oA, tw / 2, th / 2, td / 2);
                A.equip.obox(X(q[0], ry + leg + th + 0.04, q[1]), dA, UP, oA, 0.3, 0.04, 0.3);              // lid hatch
            });
        }
        // 3 · ONE AC BANK: 1-4 top-fan condensers on a skid (the size of the roof picks the count).
        for (let n = lenA >= 10 ? 4 : lenA >= 7 ? 3 : 2; n >= 1; n--) {
            const uw = 0.9, bw = n * uw + (n - 1) * 0.12, bd = 0.75, uh = 0.75;
            const b = slot(bw, bd);
            if (!b) continue;
            partOf([A.equip, A.duct], X(b[0], ry, b[1]), fwd, () => {
                A.equip.obox(X(b[0], ry + 0.06, b[1]), dA, UP, oA, bw / 2 + 0.1, 0.06, bd / 2 + 0.08);     // skid
                for (let i = 0; i < n; i++) {
                    const a = b[0] - bw / 2 + uw / 2 + i * (uw + 0.12);
                    A.equip.obox(X(a, ry + 0.12 + uh / 2, b[1]), dA, UP, oA, uw / 2, uh / 2, bd / 2);
                    A.duct.prism(X(a, ry + 0.12 + uh, b[1]), 0.3, 0.3, 0.03, 8, rot);                      // fan grille
                }
            });
            break;
        }
    }
    // archetype flags: one of each, in the cluster
    if (p.roofAerial) { const q = slot(1.2, 1.0); if (q) emitAerial(A, X(q[0], ry, q[1]), dA, oA, 2 + h(4)); }
    if (p.roofDishes && ctx.floors >= 6) { const q = slot(1.1, 1.1); if (q) A.equip.disc(X(q[0], ry + 0.55, q[1]), [o[0] * 0.3, 0.6, o[1] * 0.3], 0.55, 10); }
    if (p.solarHeater) { const q = slot(2.0, 1.4); if (q) emitSolarHeater(A, X(q[0], ry, q[1]), dA, oA); }

    // ── the front of the roof: extras (district weighted, at most two) ──
    const ew = ROOF_EXTRA_W[district];
    const commercial = p.storefront || p.signStack || p.floorSigns || p.ledScreen;
    const fo0 = ext.o0 + inset + depth + 0.6, fo1 = ext.o1 - inset;   // the clear front zone (frame o)
    let extras = 0;
    // HELIPAD (rare): a tall tower's painted pad; nothing else goes in front then.
    if (p.helipad && p.crown !== 'mech' && ctx.floors >= 14 && h(9) < 0.3) {
        const r = Math.min(lenA - 2 * inset, fo1 - fo0) * 0.46, oc = (fo0 + fo1) / 2;
        if (r >= 2.5 && free(midA, oc, r, r, 0.2)) {
            take(midA, oc, r, r);
            A.pad.obox(X(midA, ry + 0.04, oc), dA, UP, oA, r, 0.04, r);
            const y = ry + 0.085, bw = Math.max(0.12, r * 0.05);
            for (const so of [-1, 1]) A.mark.obox(X(midA, y, oc + so * (r - bw * 1.5)), dA, UP, oA, r - bw, 0.006, bw / 2);   // border
            for (const sa of [-1, 1]) A.mark.obox(X(midA + sa * (r - bw * 1.5), y, oc), dA, UP, oA, bw / 2, 0.006, r - bw);
            const hb = r * 0.09, hl = r * 0.36;
            for (const sa of [-1, 1]) A.mark.obox(X(midA + sa * r * 0.24, y, oc), dA, UP, oA, hb, 0.008, hl);                 // 'H'
            A.mark.obox(X(midA, y, oc), dA, UP, oA, r * 0.24, 0.008, hb);
            extras = 2;
        }
    }
    // NEON FRAME (commercial roofs without a billboard): two lit tube outlines on a steel stand at the front edge,
    // facing the street — the night roofline's colour.
    if (extras < 2 && commercial && !p.rooftopSign && h(10) < ew[2]) {
        const fw = Math.min(lenA * 0.6, 7), fh = Math.max(1.2, Math.min(2.2, fw * 0.3)), lift = 0.9, fo = fo1 - 0.35;
        if (fw >= 2.5 && fo - 0.3 > fo0 && free(midA, fo, fw / 2, 0.3)) {
            take(midA, fo, fw / 2, 0.3);
            const y0 = ry + lift, y1 = y0 + fh, t = 0.05;
            for (const sa of [-1, 1]) A.steel.obox(X(midA + sa * (fw / 2 - 0.1), (ry + y1) / 2, fo - 0.12), dA, UP, oA, 0.05, (y1 - ry) / 2, 0.05);   // posts
            const tube = (acc: Accum3D, k: number, sides: boolean): void => {
                const hw = fw / 2 - k, a0 = y0 + k, a1 = y1 - k;
                acc.obox(X(midA, a0, fo), dA, UP, oA, hw, t, t); acc.obox(X(midA, a1, fo), dA, UP, oA, hw, t, t);
                if (sides) { acc.obox(X(midA - hw, (a0 + a1) / 2, fo), dA, UP, oA, t, (a1 - a0) / 2, t); acc.obox(X(midA + hw, (a0 + a1) / 2, fo), dA, UP, oA, t, (a1 - a0) / 2, t); }
            };
            tube(h(14) < 0.5 ? A.signB : A.sign, 0, true); tube(A.signC, 0.28, false);   // outer frame + an inner pair of bars
            extras++;
        }
    }
    // SOLAR ARRAY (low / mid-rise): rows of tilted PV panels on rails, tilted up toward the back.
    if (extras < 2 && ctx.floors <= 10 && !p.roofGarden && h(11) < ew[0]) {
        const cols = Math.max(2, Math.min(5, Math.floor((lenA - 2 * inset) / 1.15))), rows = fo1 - fo0 >= 4.4 ? 2 : 1;
        const aw = cols * 1.15, od = rows * 2.0, oc = (fo0 + fo1) / 2;
        if (fo1 - fo0 >= 2.2 && free(midA, oc, aw / 2, od / 2)) {
            take(midA, oc, aw / 2, od / 2);
            const tl = 0.21, ay: V3L = [oA[0] * Math.sin(tl), Math.cos(tl), oA[2] * Math.sin(tl)], az: V3L = [oA[0] * Math.cos(tl), -Math.sin(tl), oA[2] * Math.cos(tl)];
            for (let r = 0; r < rows; r++) {
                const oo = oc - od / 2 + 1.0 + r * 2.0;
                A.equip.obox(X(midA, ry + 0.1, oo), dA, UP, oA, aw / 2, 0.1, 0.05);                         // rail
                A.solar.obox(X(midA, ry + 0.42, oo), dA, ay, az, aw / 2 - 0.045, 0.025, 0.8);   // one slab a row: the layer's grid pattern draws the module seams
            }
            extras++;
        }
    }
    // LAUNDRY LINE (residential roofs): two T-poles, two lines and the washing.
    if (extras < 2 && !commercial && h(12) < ew[1]) {
        const lw = Math.min(lenA * 0.5, 5), oc = Math.min(fo1 - 0.8, fo0 + 1.2);
        if (lw >= 2 && free(midA, oc, lw / 2, 0.6)) {
            take(midA, oc, lw / 2, 0.6);
            for (const sa of [-1, 1]) {
                A.equip.obox(X(midA + sa * lw / 2, ry + 0.9, oc), dA, UP, oA, 0.03, 0.9, 0.03);
                A.equip.obox(X(midA + sa * lw / 2, ry + 1.78, oc), dA, UP, oA, 0.03, 0.03, 0.5);
            }
            for (const so of [-0.4, 0.4]) {
                A.duct.obox(X(midA, ry + 1.76, oc + so), dA, UP, oA, lw / 2, 0.008, 0.008);
                let a = midA - lw / 2 + 0.3, k = 0;
                while (a < midA + lw / 2 - 0.6 && k < 3) {   // a few big pieces (sheets, towels), not a row of socks
                    const w = 0.55 + h(40 + k + (so > 0 ? 20 : 0)) * 0.5, dh = 0.3 + h(60 + k) * 0.3;
                    A.cloth.obox(X(a + w / 2, ry + 1.74 - dh, oc + so), dA, UP, oA, w / 2, dh, 0.01);
                    a += w + 0.12; k++;
                }
            }
            extras++;
        }
    }
    // GARDEN EDGES (turf roofs): long planters with hedges along the two side edges of the front zone.
    if (p.roofGarden && fo1 - fo0 >= 1.6) {
        const ho = (fo1 - fo0) / 2, oc = (fo0 + fo1) / 2;
        for (const sa of [-1, 1]) {
            const a = sa < 0 ? ext.a0 + inset + 0.4 : ext.a1 - inset - 0.4;
            if (!free(a, oc, 0.4, ho, 0.1)) continue;
            take(a, oc, 0.4, ho);
            A.trim.obox(X(a, ry + 0.25, oc), dA, UP, oA, 0.4, 0.25, ho);
            A.green.obox(X(a, ry + 0.56, oc), dA, UP, oA, 0.34, 0.08, ho - 0.06);
        }
    }
    // LIT MAST (towers + some downtown roofs): a lattice-less steel mast with cross-arms and a red aviation light.
    if (extras < 2 && !p.roofAerial && h(13) < (ctx.floors >= 14 ? 0.6 : ew[3] * 0.6)) {
        const q = slot(0.8, 0.8);
        if (q) {
            const mh = ctx.floors >= 14 ? 8 : 5;   // two fixed heights, so the masts instance (P20)
            partOf([A.equip, A.lantern], X(q[0], ry, q[1]), fwd, () => {
                A.equip.obox(X(q[0], ry + mh / 2, q[1]), dA, UP, oA, 0.07, mh / 2, 0.07);
                A.equip.obox(X(q[0], ry + mh * 0.8, q[1]), dA, UP, oA, 0.45, 0.025, 0.025);                  // cross-arm
                A.lantern.obox(X(q[0], ry + mh + 0.09, q[1]), dA, UP, oA, 0.09, 0.09, 0.09);
            });
        }
    }
    // crown (towers): as the classic roof
    if (p.crown === 'spire') { post(A.equip, c[0], c[1], ry, ry + Math.max(4, topY * 0.14), 0.12); post(A.sign, c[0], c[1], ry + Math.max(4, topY * 0.14) - 0.4, ry + Math.max(4, topY * 0.14), 0.05); }
    else if (p.crown === 'mech') { const mw = Math.max(0.6, Math.min(lenA, lenO) / 2) * 0.6; A.equip.obox([c[0], ry + 1.2, c[1]], dA, UP, oA, mw, 1.2, mw); A.equip.obox([c[0], ry + 2.8, c[1]], dA, UP, oA, mw * 0.6, 0.5, mw * 0.6); }
    else if (p.crown === 'blade') { A.trim.obox([c[0], ry + 2, c[1]], dA, UP, oA, (lenA / 2) * 0.9, 2, 0.2); }
}

/** A Yagi TV aerial: mast + boom + a row of crossbar elements (the Japanese rooftop silhouette). */
function emitAerial(A: BuildCtx['A'], base: V3L, d: V3L, o: V3L, h: number): void {
    post(A.duct, base[0], base[2], base[1], base[1] + h, 0.025);
    const y = base[1] + h - 0.12, bl = 0.9;
    A.duct.beam([base[0] - o[0] * bl * 0.3, y, base[2] - o[2] * bl * 0.3], [base[0] + o[0] * bl, y, base[2] + o[2] * bl], 0.012, 4);   // boom (points at the street)
    for (let k = 0; k < 6; k++) {
        const t = -0.3 + (k / 5) * 1.3, w = 0.34 - k * 0.03;
        const cx = base[0] + o[0] * bl * t, cz = base[2] + o[2] * bl * t;
        A.duct.beam([cx - d[0] * w, y, cz - d[2] * w], [cx + d[0] * w, y, cz + d[2] * w], 0.008, 3);
    }
}

/** A rooftop SOLAR WATER HEATER: a tilted collector panel on a frame + a horizontal tank along its top. */
function emitSolarHeater(A: BuildCtx['A'], base: V3L, d: V3L, o: V3L): void {
    const hw = 0.9, pl = 1.1, tilt = 0.5;
    const lowY = base[1] + 0.25, highY = lowY + pl * Math.sin(tilt), back = pl * Math.cos(tilt);
    const f0: V3L = [base[0] + o[0] * back * 0.5, lowY, base[2] + o[2] * back * 0.5];          // front (low) edge centre
    const b0: V3L = [base[0] - o[0] * back * 0.5, highY, base[2] - o[2] * back * 0.5];         // back (high) edge centre
    const q = (c: V3L, s: number): V3L => [c[0] + d[0] * hw * s, c[1], c[2] + d[2] * hw * s];
    A.panel.quad4(q(f0, 1), q(f0, -1), q(b0, -1), q(b0, 1));                                   // collector
    A.duct.beam(q(b0, -1.05), q(b0, 1.05), 0.2, 8);                                             // tank
    for (const s of [-0.85, 0.85]) { const t = q(b0, s); A.steel.beam([t[0], base[1], t[2]], t, 0.025, 4); const f = q(f0, s); A.steel.beam([f[0], base[1], f[2]], f, 0.025, 4); }
}

// ── PHASE 6 · SIGNAGE / NEON — sign stacks, blade + tenant signs, wrap band, LED screens, billboards (B7) ──
export function emitSignage(ctx: BuildCtx): void {
    const { p, A, front, gH, edges, floors, fh, topY, meta, levels } = ctx;

    if (p.signStack) emitSignStack(ctx);
    else if (p.bladeSign) {
        // Single vertical BLADE (1:4) projecting from the front near one end, lettered on both faces.
        const W = 0.62, H = Math.min(2.6, Math.max(1.2, topY - gH - 0.6));
        const y0 = gH + 0.25, y1 = Math.min(topY - 0.2, y0 + H);
        if (y1 - y0 > 0.8) bladePanel(ctx, A.sign, 0.85, 0.12, W, y0, y1, ihash(p.seed, 0xb1ade), true);
    }
    if (p.floorSigns) {
        // A TENANT sign under every upper floor's windows (zakkyo: a bar / clinic / karaoke on each floor), rotating
        // colours, horizontal lettering. Sits in the sill zone so it never covers the glass.
        const ins = windowInsets(p);
        for (let j = 1; j < floors; j++) {
            const ya = levels[j], hgt = (levels[j + 1] ?? topY) - ya;
            const y0 = ya + 0.06, y1 = ya + Math.max(0.42, Math.min(0.8, ins.b * hgt * 0.95));
            if (y1 > topY - 0.3) break;
            const w = Math.min(front.len * 0.78, 6);
            const acc = signAcc(ctx, j + (ihash(p.seed, 0xf1) % 3));
            signBox(ctx, acc, front.mid, front.dir, front.out, y0, y1, 0.07, 0.08, w);
            if (!adFace(ctx, [front.mid[0] + front.out[0] * 0.11, (y0 + y1) / 2, front.mid[1] + front.out[1] * 0.11], outA(front), w, y1 - y0, ihash(p.seed, 0xf100 + j)))
                letter(ctx, acc, front, [front.mid[0] + front.out[0] * 0.115, (y0 + y1) / 2, front.mid[1] + front.out[1] * 0.115], w, y1 - y0, ihash(p.seed, 0xf100 + j));
            meta.signSlots.push({ pos: [front.mid[0], (y0 + y1) / 2, front.mid[1]], out: front.out, width: w });
        }
    }
    if (p.wrapSign) {   // horizontal band wrapping the front + one adjacent street edge (corner building)
        const y = gH + 0.7; const wrap = [front, ...edges.filter(e => e.street && e !== front).slice(0, 1)];
        wrap.forEach((e, k) => {
            signBox(ctx, signAcc(ctx, k + 1), e.mid, e.dir, e.out, y, y + 0.6, 0.08, 0.1, e.len * 0.9);
            if (!adFace(ctx, [e.mid[0] + e.out[0] * 0.13, y + 0.3, e.mid[1] + e.out[1] * 0.13], outA(e), e.len * 0.9, 0.6, ihash(p.seed, 0x3a9 + e.i))) letter(ctx, signAcc(ctx, k + 1), e, [e.mid[0] + e.out[0] * 0.135, y + 0.3, e.mid[1] + e.out[1] * 0.135], e.len * 0.8, 0.5, ihash(p.seed, 0x3a9 + e.i));
            meta.signSlots.push({ pos: [e.mid[0], y + 0.3, e.mid[1]], out: e.out, width: e.len * 0.9 });
        });
    }
    if (p.ledScreen) {   // big animated screen on the upper front facade, in a steel frame
        const y0 = gH + 1, y1 = Math.min(topY - 0.5, gH + 1 + Math.min(6, (floors - 1) * fh * 0.6));
        if (y1 > y0) {
            panel(A.screen, front.mid, front.dir, front.out, y0, y1, 0.1, 0.12, front.len * 0.7);
            adFace(ctx, [front.mid[0] + front.out[0] * 0.16, (y0 + y1) / 2, front.mid[1] + front.out[1] * 0.16], outA(front), front.len * 0.7, y1 - y0, ihash(p.seed, 0x1ed5c), true);   // a screen is always lit
            panel(A.steel, front.mid, front.dir, front.out, y0 - 0.12, y1 + 0.12, 0.05, 0.08, front.len * 0.7 + 0.24);
            meta.signSlots.push({ pos: [front.mid[0], (y0 + y1) / 2, front.mid[1]], out: front.out, width: front.len * 0.7 });
        }
    }
    if (p.rooftopSign) emitBillboard(ctx);
}

/** A projecting vertical panel (perpendicular to the front) at param t along it: `W` projection, y0..y1, into `acc`,
 *  lettered on BOTH faces. `frameIt` adds the steel lit-box frame + wall brackets. */
function bladePanel(ctx: BuildCtx, acc: Accum3D, t: number, gap: number, W: number, y0: number, y1: number, seed: number, frameIt: boolean): void {
    const { A, front } = ctx;
    const e = front, th = 0.09;
    const base = edgePt(e, t, gap + W / 2);
    const c: V3L = [base[0], (y0 + y1) / 2, base[1]];
    // LIGHTBOX (C2): a casing in the frame colour + a bevelled lit face on each side
    const bev = 0.025;
    A.signFrame.obox(c, outA(e), UP, dirA(e), W / 2, (y1 - y0) / 2, th - bev);
    for (const sgn of [1, -1]) lightFace(acc, A.signFrame, [c[0] + e.dir[0] * sgn * th, c[1], c[2] + e.dir[1] * sgn * th], [e.out[0] * sgn, 0, e.out[1] * sgn], UP, [e.dir[0] * sgn, 0, e.dir[1] * sgn], W / 2, (y1 - y0) / 2, bev);
    const word = signWord(seed, Math.max(2, Math.min(5, Math.round((y1 - y0) / (W * 0.95)))), true, wordKind(ctx));
    const ink = inkFor(ctx, acc);
    // both faces: normal ±dir; on the +dir face the viewer's right is +out, on the −dir face it is −out
    for (const sgn of [1, -1]) {
        const fc: V3L = [c[0] + e.dir[0] * sgn * (th + 0.004), c[1], c[2] + e.dir[1] * sgn * (th + 0.004)];
        // both faces pick the SAME image (same salt + size) — a blade sign is one sign seen from either side
        if (adFace(ctx, [c[0] + e.dir[0] * sgn * th, c[1], c[2] + e.dir[1] * sgn * th], [e.dir[0] * sgn, 0, e.dir[1] * sgn], W, y1 - y0, seed)) continue;
        emitGlyphRun(ink, fc, [e.out[0] * sgn, 0, e.out[1] * sgn], UP, [e.dir[0] * sgn, 0, e.dir[1] * sgn], W, y1 - y0, word, true, 0.012, inkWeight(ctx, ink));
    }
    if (frameIt) {
        const outer = edgePt(e, t, gap + W + 0.03);
        A.steel.obox([outer[0], c[1], outer[1]], outA(e), UP, dirA(e), 0.03, (y1 - y0) / 2 + 0.04, th + 0.02);   // outer stile
        for (const yy of [y0 - 0.03, y1 + 0.03]) A.steel.obox([base[0], yy, base[1]], outA(e), UP, dirA(e), W / 2 + 0.03, 0.03, th + 0.02);
        for (const yy of [y0 + 0.25, y1 - 0.25]) { const b = edgePt(e, t, gap / 2); A.steel.obox([b[0], yy, b[1]], outA(e), UP, dirA(e), gap / 2 + 0.02, 0.025, 0.025); }   // wall brackets
    }
    const kk = [ctx.A.sign, ctx.A.signB, ctx.A.signC].indexOf(acc);   // visual-polish #5: the panel's colour slot (spill)
    ctx.meta.signSlots.push({ pos: c, out: [e.dir[0], e.dir[1]], width: W, ...(kk >= 0 ? { k: kk } : {}) });
}

/** The zakkyo VERTICAL SIGN STACK: one lit panel per storey up the facade (each tenant its own colour + kanji),
 *  inside one steel frame, projecting from the front near the end away from the door. */
function emitSignStack(ctx: BuildCtx): void {
    const { p, gH, levels, floors, topY, front } = ctx;
    const t = 0.88, W = front.len < 5 ? 0.62 : 0.8;   // near the end away from the (centred) entrance
    const rows: [number, number][] = [];
    if (gH - 2.6 > 0.6) rows.push([2.6, gH - 0.08]);                                   // above head height on the ground floor
    for (let j = 1; j < floors; j++) { const y0 = levels[j] + 0.08, y1 = Math.min(levels[j + 1] ?? topY, topY - 0.25) - 0.08; if (y1 - y0 > 0.8) rows.push([y0, y1]); }
    rows.forEach(([y0, y1], k) => bladePanel(ctx, signAcc(ctx, k + ihash(p.seed, 0x57) % 3), t, 0.15, W, y0, y1, ihash(p.seed, 0x5a0 + k), false));
    if (!rows.length) return;
    // one steel frame round the whole stack + brackets every other panel
    const A = ctx.A, e = front, yb = rows[0][0], yt = rows[rows.length - 1][1];
    const outer = edgePt(e, t, 0.15 + W + 0.035), cy = (yb + yt) / 2;
    A.steel.obox([outer[0], cy, outer[1]], outA(e), UP, dirA(e), 0.035, (yt - yb) / 2 + 0.06, 0.12);
    const mid = edgePt(e, t, 0.15 + W / 2);
    for (const yy of [yb - 0.05, yt + 0.05]) A.steel.obox([mid[0], yy, mid[1]], outA(e), UP, dirA(e), W / 2 + 0.05, 0.035, 0.12);
    // wall brackets: a top + bottom arm per panel (C2 — every blade hangs off visible brackets)
    for (let k = 0; k < rows.length; k++) { const b = edgePt(e, t, 0.08); for (const yy of [rows[k][0] + 0.25, rows[k][1] - 0.25]) A.steel.obox([b[0], yy, b[1]], outA(e), UP, dirA(e), 0.09, 0.025, 0.03); }
}

/** A ROOFTOP BILLBOARD: a lettered sign panel on a steel lattice frame (posts + rails + diagonal braces) facing
 *  the front, sized from the real roof (B7 / B9). */
function emitBillboard(ctx: BuildCtx): void {
    const { A, p, front } = ctx;
    const { c, d, o, ext } = roofFrame(ctx);
    const s = ctx.sections[ctx.sections.length - 1];
    const ry = s.y1 + (p.roofStyle === 'parapet' ? 0.45 : 0);
    const halfA = (ext.a1 - ext.a0) / 2;
    const w = Math.min(halfA * 1.7, front.len * 0.9, 9), h = Math.max(1.6, Math.min(3.6, w * 0.38));
    if (w < 1.5) return;
    const lift = 1.0, cy = ry + lift + h / 2;
    const bo = Math.max(ext.o0 + 0.6, (ext.o0 + ext.o1) / 2 - 0.4);          // a little behind the roof centre
    const pc: V3L = [c[0] + o[0] * bo, cy, c[1] + o[1] * bo];
    const dA: V3L = [d[0], 0, d[1]], oA: V3L = [o[0], 0, o[1]];
    const bAcc = signAcc(ctx, 1 + ihash(p.seed, 0xb1) % 3), bev = 0.03;
    A.signFrame.obox([pc[0] - o[0] * bev / 2, cy, pc[2] - o[1] * bev / 2], dA, UP, oA, w / 2, h / 2, 0.08 - bev / 2);   // casing (C2)
    lightFace(bAcc, A.signFrame, [pc[0] + o[0] * 0.08, cy, pc[2] + o[1] * 0.08], [-d[0], 0, -d[1]], UP, oA, w / 2, h / 2, bev);
    const fe: Edge = { ...front, dir: [d[0], d[1]], out: [o[0], o[1]] };
    if (!adFace(ctx, [pc[0] + o[0] * 0.08, cy, pc[2] + o[1] * 0.08], oA, w, h, ihash(p.seed, 0xb111))) letter(ctx, bAcc, fe, [pc[0] + o[0] * 0.09, cy, pc[2] + o[1] * 0.09], w * 0.86, h * 0.62, ihash(p.seed, 0xb111));
    // lattice frame behind the panel
    const back = (a: number, y: number): V3L => [pc[0] + d[0] * a - o[0] * 0.5, y, pc[2] + d[1] * a - o[1] * 0.5];
    const nP = Math.max(2, Math.round(w / 2.5));
    for (let k = 0; k <= nP; k++) {
        const a = -w / 2 + (k / nP) * w;
        const top = back(a, cy + h / 2), bot = back(a, ry);
        A.steel.beam(bot, top, 0.05, 4);                                                    // post
        A.steel.beam([pc[0] + d[0] * a, ry, pc[2] + d[1] * a], [pc[0] + d[0] * a - o[0] * 0.45, cy - h / 2, pc[2] + d[1] * a - o[1] * 0.45], 0.035, 4);   // front strut
        if (k < nP) { const a2 = -w / 2 + ((k + 1) / nP) * w; A.steel.beam(back(a, ry + 0.2), back(a2, cy + h / 2 - 0.1), 0.025, 3); }   // diagonal brace
    }
    for (const y of [ry + lift - 0.05, cy + h / 2]) A.steel.beam(back(-w / 2, y), back(w / 2, y), 0.04, 4);   // rails
    ctx.meta.signSlots.push({ pos: pc, out: [o[0], o[1]], width: w });
}

// ── FOLIAGE ITEM 2 · attached greenery (auto-placed from the building's own geometry/meta) ──
// Also fills meta.windowAnchors (upper-floor window centres) for window-boxes + later interactions/sim.
// Canonical leaf clumps / vine blobs at the ORIGIN, built ONCE with a FIXED seed and cached, so EVERY building's
// hedge/box/planter/vine shares the identical geometry → the city-wide instancer collapses them to a handful of
// resident verts (the baked `world:detail-greenery` was ~1.76 M verts = 69% of the whole city's geometry).
const _clumpCanon = new Map<string, ReturnType<Accum3D['geometry']>>();
function _greenRng(seed: number): () => number { let s = (seed >>> 0) || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
/** ★ Building greenery is REAL LEAVES now, not blobs. `foliageClump` builds the low-poly blob mound the
 *  whole library moved off in P4 — so hedges, window boxes and door planters on buildings stayed chunky
 *  while every freestanding plant became carded, which is exactly the mismatch that reads as "some
 *  buildings have chunky foliage". `emitLeafCluster` is the same primitive the woody archetypes use.
 *  The CANONICAL CACHE is untouched and is what makes this affordable: one geometry per (radius, density,
 *  tipFrac) shared by every building in the city, so the instancer still collapses them (this layer was
 *  ~69% of the city's geometry before it was canonicalised — do not un-cache it). */
function clumpCanon(radius: number, density: number, tipFrac: number): ReturnType<Accum3D['geometry']> {
    const key = `c${radius}:${density}:${tipFrac}`;
    let g = _clumpCanon.get(key);
    if (!g) {
        const a = new Accum3D();
        const rnd = _greenRng(0x9e37 ^ Math.round(radius * 977) ^ Math.round(density * 613) * 7 ^ Math.round(tipFrac * 331) * 13);
        emitLeafCluster(a, a, [0, 0, 0], {
            radius, density, irregular: 0.55, flatten: 0.85, tipFrac, mode: 'blade',
            leaf: { ...DEFAULT_LEAF, length: Math.max(0.03, radius * 0.62), width: Math.max(0.02, radius * 0.4) },
        }, rnd, Math.round(radius * 1000));
        g = a.geometry();
        _clumpCanon.set(key, g);
    }
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

// ── JAPANESE PARTS (B5) — apaato corridor + stair, zakkyo back stair, izakaya lanterns + menu board ──────────
export function emitJapanese(ctx: BuildCtx): void {
    const { p } = ctx;
    if (p.openCorridor) emitCorridor(ctx);
    else if (p.outsideStair) emitBackStair(ctx);
    if (p.lanterns) emitLanterns(ctx);
    if (p.menuBoard) emitMenuBoard(ctx);
}

/** A straight steel flight from (a, ya) to (b, yb), `w` wide across `side`: two stringers + treads. */
function steelFlight(A: BuildCtx['A'], a: V2L, ya: number, b: V2L, yb: number, side: V2L, w: number): void {
    const dx = b[0] - a[0], dz = b[1] - a[1], run = Math.hypot(dx, dz) || 1, rise = yb - ya;
    const d: V3L = [dx / run, 0, dz / run], sA: V3L = [side[0], 0, side[1]];
    for (const s of [-1, 1]) {
        const ox = side[0] * s * w / 2, oz = side[1] * s * w / 2;
        A.steel.beam([a[0] + ox, ya, a[1] + oz], [b[0] + ox, yb, b[1] + oz], 0.05, 4);                      // stringer
        A.steel.beam([a[0] + ox, ya + 0.9, a[1] + oz], [b[0] + ox, yb + 0.9, b[1] + oz], 0.02, 4);          // handrail
    }
    const n = Math.max(3, Math.round(Math.abs(rise) / 0.2));
    for (let k = 1; k < n; k++) {
        const t = k / n;
        A.steel.obox([a[0] + dx * t, ya + rise * t, a[1] + dz * t], d, UP, sA, run / n * 0.55, 0.02, w / 2);   // tread
    }
}

/** APAATO: an open corridor along the front on every upper floor (slab + steel balustrade + posts), a flat door per
 *  unit on every floor, an AC condenser beside each door, and an outside steel stair at one end (B5). */
function emitCorridor(ctx: BuildCtx): void {
    const { A, levels, floors, front: e, gH, p, rnd } = ctx;
    const D = 1.15;
    const rise = (levels[2] ?? gH * 2) - levels[1] || ctx.fh;
    const runLen = Math.min(e.len * 0.36, Math.max(2.2, rise * 1.2));
    const tS = runLen / e.len;                                                // the stair takes t ∈ [0, tS]
    const d = dirA(e), o = outA(e);
    const flats = Math.max(1, Math.round(e.len * (1 - tS) / 3.4));
    const flatT = (k: number): number => tS + (k + 0.5) / flats * (1 - tS);
    for (let j = 0; j < floors; j++) {
        const y = levels[j];
        // door + frame + AC per flat
        for (let k = 0; k < flats; k++) {
            const t = flatT(k), dc = edgePt(e, t - 0.12 / flats, 0.04), dh = Math.min(2.0, (levels[j + 1] ?? y + 2.6) - y - 0.45);
            A.door.obox([dc[0], y + dh / 2 + 0.02, dc[1]], d, UP, o, 0.42, dh / 2, 0.04);
            A.dframe.obox([dc[0], y + dh + 0.06, dc[1]], d, UP, o, 0.5, 0.04, 0.06);
            if (p.acUnits) {
                const ac = edgePt(e, Math.min(1 - 0.45 / e.len, t + 0.25 * (1 - tS) / flats), 0.34);   // beside the door, never past the corner
                A.equip.obox([ac[0], y + 0.33, ac[1]], d, UP, o, 0.36, 0.28, 0.13);
                A.duct.disc([ac[0] + o[0] * 0.14, y + 0.33, ac[1] + o[2] * 0.14], o, 0.19, 10);
            }
            if (p.utilities) { const m = edgePt(e, t - 0.12 / flats - 0.36, 0.05); A.equip.obox([m[0], y + 1.45, m[1]], d, UP, o, 0.13, 0.18, 0.06); }   // meter box
            if (j === 0 && k === 0) ctx.meta.door = { pos: [dc[0] + e.out[0] * 0.3, dc[1] + e.out[1] * 0.3], out: e.out, width: 0.84, height: dh };
        }
        if (j === 0) continue;
        // corridor slab + balustrade on this upper floor (the stair end stays open)
        const sc = edgePt(e, (tS + 1) / 2, D / 2), half = e.len * (1 - tS) / 2;
        A.trim.obox([sc[0], y - 0.08, sc[1]], d, UP, o, half, 0.1, D / 2);
        const rc = edgePt(e, (tS + 1) / 2, D - 0.03);
        A.steel.obox([rc[0], y + 0.55, rc[1]], d, UP, o, half, 0.45, 0.025);
        A.steel.obox([rc[0], y + 1.02, rc[1]], d, UP, o, half + 0.02, 0.03, 0.05);
        if (p.laundry && rnd() < 0.4) { const a = edgePt(e, flatT(0), D - 0.1), b = edgePt(e, flatT(flats - 1), D - 0.1); hangWashing(A.cloth, [a[0], y + 1.08, a[1]], [b[0], y + 1.08, b[1]], o, rnd); }
    }
    // steel posts under the corridor edge
    const nP = Math.max(2, Math.round(e.len * (1 - tS) / 3));
    for (let k = 0; k <= nP; k++) { const q = edgePt(e, tS + (k / nP) * (1 - tS) - (k === nP ? 0.01 : 0), D - 0.08); post(A.steel, q[0], q[1], 0, levels[floors - 1], 0.05); }
    // outside stair: flights alternate direction floor to floor (scissor) inside the stair strip
    for (let j = 0; j < floors - 1; j++) {
        const up = j % 2 === 0;
        const a = edgePt(e, up ? 0.02 : tS - 0.02, D / 2), b = edgePt(e, up ? tS - 0.02 : 0.02, D / 2);
        steelFlight(A, a, levels[j], b, levels[j + 1], [e.out[0], e.out[1]], D * 0.8);
    }
    if (floors > 2) { const lc = edgePt(e, tS / 2, D / 2); A.trim.obox([lc[0], levels[floors - 1] - 0.08, lc[1]], d, UP, o, e.len * tS / 2, 0.1, D / 2); }   // top landing
}

/** ZAKKYO / walk-up BACK STAIR: a zigzag steel stair with a landing + door at every floor, on an open back/side
 *  edge (never on a party wall — skipped when there is none). */
function emitBackStair(ctx: BuildCtx): void {
    const { A, levels, floors } = ctx;
    const e = backEdge(ctx) ?? (ctx.contextual ? null : ctx.edges.find(x => x.i !== ctx.front.i) ?? null);
    if (!e || floors < 2) return;
    const d = dirA(e), o = outA(e), W = 0.9, land = 1.1;
    const run = Math.min(e.len * 0.6, 3.2);
    const t0 = 0.5 - run / e.len / 2, t1 = 0.5 + run / e.len / 2;
    for (let j = 1; j < floors; j++) {
        const y = levels[j];
        const lt = j % 2 ? t1 : t0;
        const lc = edgePt(e, lt, W / 2 + 0.05);
        A.steel.obox([lc[0], y - 0.05, lc[1]], d, UP, o, land / 2, 0.05, W / 2);                               // landing
        A.steel.obox([lc[0] + o[0] * (W / 2), y + 0.5, lc[1] + o[2] * (W / 2)], d, UP, o, land / 2, 0.45, 0.02);   // landing guard
        const dc = edgePt(e, lt, 0.03);
        A.door.obox([dc[0], y + 1.0, dc[1]], d, UP, o, 0.4, 1.0, 0.04);                                      // fire door
        const a = edgePt(e, j % 2 ? t0 : t1, W / 2 + 0.05), b = edgePt(e, lt, W / 2 + 0.05);
        steelFlight(A, a, levels[j - 1], b, y, [e.out[0], e.out[1]], W);
    }
}

/** IZAKAYA red paper LANTERNS (chouchin) either side of the entrance, each with one inked kanji. */
function emitLanterns(ctx: BuildCtx): void {
    const { A, gH, front: e, p } = ctx;
    const dr = ctx.meta.door; if (!dr) return;
    const yc = Math.min(gH - 0.55, dr.height + 0.35);
    for (const sgn of [-1, 1]) {
        const x = dr.pos[0] - e.out[0] * 0.3 + e.dir[0] * (dr.width / 2 + 0.38) * sgn + e.out[0] * 0.42;
        const z = dr.pos[1] - e.out[1] * 0.3 + e.dir[1] * (dr.width / 2 + 0.38) * sgn + e.out[1] * 0.42;
        A.lantern.prism([x, yc - 0.3, z], 0.2, 0.2, 0.6, 10);                                              // the paper body (emissive)
        A.signInk.prism([x, yc + 0.3, z], 0.13, 0.13, 0.05, 8);                                            // black caps
        A.signInk.prism([x, yc - 0.35, z], 0.13, 0.13, 0.05, 8);
        A.steel.beam([x, yc + 0.35, z], [x, gH - 0.08, z], 0.01, 3);                                       // hook
        emitGlyphRun(A.signInk, [x + e.out[0] * 0.2, yc, z + e.out[1] * 0.2], viewRight(e), UP, outA(e), 0.22, 0.46, signWord(ihash(p.seed, 0x1a7 + sgn), 1, true, 'lantern'), true, 0.004);
    }
}

/** A standing MENU BOARD beside the entrance (dark board on legs, chalk lettering in rows). */
function emitMenuBoard(ctx: BuildCtx): void {
    const { A, front: e, p } = ctx;
    const dr = ctx.meta.door; if (!dr) return;
    const bc = [dr.pos[0] - e.out[0] * 0.3 - e.dir[0] * (dr.width / 2 + 0.85) + e.out[0] * 0.55, dr.pos[1] - e.out[1] * 0.3 - e.dir[1] * (dr.width / 2 + 0.85) + e.out[1] * 0.55];
    A.front.obox([bc[0], 1.0, bc[1]], dirA(e), UP, outA(e), 0.3, 0.42, 0.025);                                 // board
    for (const s of [-1, 1]) post(A.front, bc[0] + e.dir[0] * 0.24 * s, bc[1] + e.dir[1] * 0.24 * s, 0, 0.6, 0.02);   // legs
    for (let r = 0; r < 3; r++) {
        emitGlyphRun(A.signText, [bc[0] + e.out[0] * 0.03, 1.28 - r * 0.24, bc[1] + e.out[1] * 0.03], viewRight(e), UP, outA(e), 0.5, 0.2, signWord(ihash(p.seed, 0x3e40 + r), 4, false, 'food'), false, 0.004);
    }
}

// ── UTILITIES (B8) — AC condensers + pipe runs, meters + conduit, drain pipes, kitchen vents, laundry poles ─────
// The lived-in clutter of a Japanese facade. Everything goes on OPEN side/back edges (never a party wall — it would
// poke into the neighbour); meters + conduit sit by the front door. Also fills meta.wireAnchors (service drops).
export function emitUtilities(ctx: BuildCtx): void {
    const { p, A, levels, floors, gH, topY, rnd, front, meta } = ctx;
    // SERVICE-WIRE anchors on the front wall (~5–6 m up, near one corner) — where drops from the street poles land.
    const wy = Math.min(topY - 0.4, 5.6);
    if (wy > 2.4) { const a = edgePt(front, 0.08, 0.1); meta.wireAnchors.push([a[0], wy, a[1]]); }
    if (!p.utilities && !p.acUnits && !p.laundry) return;
    const hosts = utilityEdges(ctx);
    if (p.acUnits || p.utilities) emitEyeLevelClutter(ctx);

    if (p.acUnits && !p.openCorridor && !(p.balconies && p.balconyStyle === 'panel')) {
        // Condensers on wall brackets, one per flat per floor on the open faces, each with a refrigerant PIPE RUN
        // (up the wall to the room it serves, then into the wall). Shops skip the ground floor (the shopfront).
        let c = 0;
        const j0 = p.storefront ? 1 : 0;
        for (let j = j0; j < floors && c < 18; j++) {
            const y = j === 0 ? 0.05 : levels[j] + 0.25;
            for (const e of hosts) {
                const n = Math.max(1, Math.floor(e.len / 4.5));
                for (let k = 0; k < n && c < 18; k++) {
                    if (rnd() < (j <= 3 ? 0.18 : 0.45)) continue;   // D3: densest on the first storeys, where eyes land
                    const t = (k + 0.5) / n + (rnd() - 0.5) * 0.25 / n;
                    const pt = edgePt(e, t, 0.3), d = dirA(e), o = outA(e);
                    A.equip.obox([pt[0], y + 0.3, pt[1]], d, UP, o, 0.4, 0.28, 0.15);
                    A.duct.disc([pt[0] + o[0] * 0.155, y + 0.3, pt[1] + o[2] * 0.155], o, 0.18, 10);    // fan grille
                    if (j > 0) A.steel.obox([pt[0], y - 0.02, pt[1]], d, UP, o, 0.42, 0.02, 0.17);      // bracket
                    const px = pt[0] + e.dir[0] * 0.5 - e.out[0] * 0.22, pz = pt[1] + e.dir[1] * 0.5 - e.out[1] * 0.22;
                    const topP = Math.min(y + 2.0, topY - 0.3);
                    A.duct.beam([px, y + 0.25, pz], [px, topP, pz], 0.035, 4);                           // pipe run up
                    A.duct.beam([px, topP, pz], [px - e.out[0] * 0.07, topP, pz - e.out[1] * 0.07], 0.035, 4);   // …into the wall
                    c++;
                }
            }
        }
    }
    if (p.utilities) {
        // gas + electric METERS beside the door, with a CONDUIT up to the service-wire anchor
        const dr = meta.door;
        if (dr && !p.openCorridor) {
            const side = Math.min(front.len * 0.45, dr.width / 2 + 0.55);
            const mx = dr.pos[0] - front.out[0] * 0.3 + front.dir[0] * side, mz = dr.pos[1] - front.out[1] * 0.3 + front.dir[1] * side;
            const d = dirA(front), o = outA(front);
            A.equip.obox([mx + front.out[0] * 0.07, 1.5, mz + front.out[1] * 0.07], d, UP, o, 0.14, 0.19, 0.06);   // electric meter
            A.equip.obox([mx + front.out[0] * 0.09, 0.8, mz + front.out[1] * 0.09], d, UP, o, 0.12, 0.14, 0.08);   // gas meter
            const aw = meta.wireAnchors[0];
            if (aw) A.duct.beam([mx + front.out[0] * 0.05, 1.7, mz + front.out[1] * 0.05], [aw[0], aw[1], aw[2]], 0.02, 4);
        }
        // conduit + drain pipe down a side / back face
        for (const e of hosts.slice(0, 2)) {
            const a = edgePt(e, 0.9, 0.06);
            A.duct.beam([a[0], 0.1, a[1]], [a[0], topY - 0.1, a[1]], 0.05, 6);
            const b = edgePt(e, 0.84, 0.04);
            A.duct.beam([b[0], 0.3, b[1]], [b[0], Math.min(topY - 0.2, gH + 1.5), b[1]], 0.025, 4);
        }
        // KITCHEN VENT: shops / izakaya get a hooded extract at the back + a duct up the wall to the roof
        if (p.category === 'shophouse' && hosts.length) {
            const e = hosts[0], v = edgePt(e, 0.35, 0.2), d = dirA(e), o = outA(e);
            A.equip.obox([v[0], gH * 0.7, v[1]], d, UP, o, 0.3, 0.22, 0.2);
            A.duct.beam([v[0] + e.out[0] * 0.05, gH * 0.7 + 0.2, v[1] + e.out[1] * 0.05], [v[0] + e.out[0] * 0.05, topY + 0.8, v[1] + e.out[1] * 0.05], 0.13, 6);
        }
    }
    if (p.laundry && !p.openCorridor && !(p.balconies && p.balconyStyle === 'panel')) {
        // LAUNDRY POLES off the back windows on the upper floors (two brackets + a pole, washing on some)
        let c = 0;
        for (let j = 1; j < floors && c < 6; j++) {
            for (const e of hosts) {
                if (rnd() < 0.45 || e.len < 2) continue;
                const y = levels[j] + 1.9, a = edgePt(e, 0.25, 0.55), b = edgePt(e, 0.72, 0.55);
                for (const q of [a, b]) A.steel.beam([q[0] - e.out[0] * 0.55, y, q[1] - e.out[1] * 0.55], [q[0], y, q[1]], 0.015, 3);
                A.steel.beam([a[0], y, a[1]], [b[0], y, b[1]], 0.02, 4);
                if (rnd() < 0.7) hangWashing(A.cloth, [a[0], y, a[1]], [b[0], y, b[1]], outA(e), rnd);
                c++;
            }
        }
    }
}

// ── EYE-LEVEL FACADE CLUTTER (persona polish D3) ─────────────────────────────────────────────────────────────
// The street faces of a Tokyo building carry their services where you can see them: AC condensers on brackets
// under / beside the first few floors' windows, refrigerant pipe runs into the wall, a grey conduit / drain down a
// corner pier. emitUtilities puts the bulk on the OPEN back / side faces — a mid-terrace lot has none, so its
// street face stayed a clean box. This dresses storeys 1–3 of the STREET faces only (never a party wall, never the
// sign-stack / blade / screen zone, never over glass), deterministic per window (ihash, NOT the shared rnd stream
// — the emitters after this one keep their draws). Capped per building so the city budget stays flat.
const EYE_AC_CAP = 6;
function emitEyeLevelClutter(ctx: BuildCtx): void {
    const { p, A, levels, floors, front, gH } = ctx;
    if (floors < 2 || p.balconies || p.openCorridor || p.julietBalconies) return;
    if (!discreteWindows(p) || p.material === 'timber' || p.material === 'metal') return;
    const sash = p.windowSash;
    const ins = windowInsets(p);
    const pitch = wallCellPitch(p);
    const yMax = levels[Math.min(floors, 4)];
    const storeyBase = (y: number): number => { let ya = levels[1]; for (let j = 1; j < floors; j++) if (levels[j] <= y + 1e-6) ya = levels[j]; return ya; };
    let n = 0, idx = 0;
    const piped = new Set<number>();
    forEachWindow(ctx, 400, (w) => {
        idx++;
        if (n >= EYE_AC_CAP || w.yBottom > yMax) return;
        const e = w.e;
        if (e.i === front.i && (p.ledScreen || w.t > 0.72 || p.wrapSign)) return;   // the sign stack / blade / screen zone
        const h = ihash(p.seed ^ 0xac1e, idx) / 4294967296;
        if (h > 0.36) return;
        const ya = storeyBase(w.yBottom), sh = (levels[levels.indexOf(ya) + 1] ?? ya + ctx.fh) - ya;
        const pitchEff = e.len / Math.max(1, Math.round(e.len / pitch));
        const d = w.dirA, o = w.outA;
        let along: number, cy: number;
        if (sash && !p.floorSigns && w.yBottom - ya >= 0.78) {
            along = w.t * e.len; cy = ya + 0.36;                                   // under the window, on the sill zone
        } else {
            const pier = pitchEff - 2 * w.halfWidth;
            if (pier < 0.95) return;                                               // no pier wide enough for a unit
            along = w.t * e.len + (h < 0.18 ? -1 : 1) * pitchEff / 2; cy = ya + sh * 0.45;
        }
        if (along < 0.7 || e.len - along < 0.7) return;                            // clear of the corners (party walls)
        const t = along / e.len;
        const pt = edgePt(e, t, 0.17);
        A.equip.obox([pt[0], cy, pt[1]], d, UP, o, 0.38, 0.27, 0.14);             // condenser
        A.duct.disc([pt[0] + o[0] * 0.145, cy, pt[1] + o[2] * 0.145], o, 0.17, 10); // fan grille
        const bk0 = edgePt(e, t, 0.16);
        A.steel.obox([bk0[0], cy - 0.29, bk0[1]], d, UP, o, 0.4, 0.018, 0.16);     // wall bracket
        // refrigerant pipe pair: out of the unit's side, up, and into the wall
        const s = (ihash(p.seed, idx * 7 + 3) & 1) ? 1 : -1;
        const px = pt[0] + e.dir[0] * s * 0.44 - e.out[0] * 0.1, pz = pt[1] + e.dir[1] * s * 0.44 - e.out[1] * 0.1;
        const top = Math.min(cy + 0.75, ya + sh - 0.15);
        A.duct.beam([px, cy - 0.1, pz], [px, top, pz], 0.022, 4);
        A.duct.beam([px, top, pz], [px - e.out[0] * 0.06, top, pz - e.out[1] * 0.06], 0.022, 4);
        n++;
        // one grey conduit / drain down the nearest corner margin per face (where no window is)
        if (!piped.has(e.i)) {
            piped.add(e.i);
            const margin = ins.x * pitchEff;
            if (margin >= 0.3) {
                const at = (t < 0.5 ? margin * 0.5 : e.len - margin * 0.5) / e.len;
                if (at * e.len >= 0.12 && (1 - at) * e.len >= 0.12) {
                    const q = edgePt(e, at, 0.05);
                    A.duct.beam([q[0], Math.max(0.3, gH * 0.5), q[1]], [q[0], Math.min(yMax + 0.3, ctx.topY - 0.2), q[1]], 0.035, 6);
                }
            }
        }
    });
}
