// ── World generation — Phase 4: landmark composer ───────────────────────────────────────────────
// "Significant buildings" that claim a whole civic/market block, get their own silhouette, and carry a game
// spawn/interaction anchor (the entrance). `placeLandmarks` picks blocks + tags their lots (so normal buildings
// skip them); `buildLandmarks` renders the templates. 9 templates, each with a stone base that carries WINDOWS
// (shader grid pattern — free), a wide PLINTH, a CORNICE, and signature detail (porticos, pediments, canopies,
// torii, floodlights, steam…). Everything post-transforms with the elevation field + honours the region filter.

import type { WorldGraph, LayoutPreviewLayer, V2, Landmark, LandmarkType } from './types';
import { makeRng, Rng, centroid, polyArea, bounds, graphLookups } from './util';
import { Accum3D } from './meshbuild';
import { makeElevation } from './elevation';

type V3 = [number, number, number];

const STONE: [number, number, number] = [0.80, 0.78, 0.72];   // pale masonry (distinct from the tinted zone buildings)
const ROOF: [number, number, number] = [0.44, 0.33, 0.30];    // terracotta / copper roof + cornice
const DOME: [number, number, number] = [0.40, 0.58, 0.55];    // verdigris dome
const DARK: [number, number, number] = [0.22, 0.22, 0.26];    // spire / canopy / mast / clock frame
const ACCENT: [number, number, number] = [0.92, 0.86, 0.55];  // gold clock face / helipad H / floodlight head
const STEP: [number, number, number] = [0.72, 0.70, 0.66];    // stone steps + plinth
const RED: [number, number, number] = [0.80, 0.20, 0.18];     // torii / hospital cross / hazard band / flag
const GREEN: [number, number, number] = [0.34, 0.54, 0.32];   // stadium pitch
const GLASS: [number, number, number] = [0.62, 0.75, 0.82];   // pale glazing / steam plume / skylight

interface Accs { stone: Accum3D; roof: Accum3D; dome: Accum3D; dark: Accum3D; accent: Accum3D; steps: Accum3D; red: Accum3D; field: Accum3D; glass: Accum3D; }

/** The building's street frontage (longest edge) + an outward normal. */
function frontage(foot: V2[]): { a: V2; b: V2; eDir: V2; outward: V2; len: number } | null {
    if (foot.length < 3) return null;
    let a = foot[0], b = foot[1], len = 0;
    for (let i = 0; i < foot.length; i++) { const q = foot[i], w = foot[(i + 1) % foot.length], l = Math.hypot(w[0] - q[0], w[1] - q[1]); if (l > len) { len = l; a = q; b = w; } }
    if (len < 1e-4) return null;
    const eDir: V2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    let outward: V2 = [-eDir[1], eDir[0]];
    const c = centroid(foot), mid: V2 = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
    if ((mid[0] - c[0]) * outward[0] + (mid[1] - c[1]) * outward[1] < 0) outward = [-outward[0], -outward[1]];
    return { a, b, eDir, outward, len };
}

const insetToward = (poly: V2[], c: V2, f: number): V2[] => poly.map(p => [p[0] + (c[0] - p[0]) * f, p[1] + (c[1] - p[1]) * f] as V2);

/** Pick a few big civic/market blocks to become landmarks; tag their lots so normal buildings/signage skip them. */
export function placeLandmarks(graph: WorldGraph): Landmark[] {
    const p = graph.params;
    if (!(p.landmarks ?? true)) return [];
    const minA = (p.radius * 0.05) ** 2;
    let cands = graph.blocks.filter(b => (b.district === 'civic' || b.district === 'market') && b.poly.length >= 3 && polyArea(b.poly) > minA);
    if (cands.length < 2) cands = graph.blocks.filter(b => b.zone !== 'park' && b.zone !== 'water' && b.poly.length >= 3 && polyArea(b.poly) > minA);
    cands = cands.slice().sort((a, b) => polyArea(b.poly) - polyArea(a.poly));
    const n = Math.min(cands.length, Math.max(3, Math.round(p.radius / 4)));   // ≥3 so all hero templates appear
    // The cyber suite claims the BIGGEST block for the MEGATOWER (the sky-train weaves through its portal).
    // school sits 3rd so it appears even at the default landmark count (n = max(3, R/4) — tail types need bigger cities).
    const types: LandmarkType[] = [...((p.holograms ?? false) ? ['megatower' as LandmarkType] : []),
        'cityhall', 'station', 'school', 'museum', 'hospital', 'shrine', 'radiotower', 'postoffice', 'stadium', 'powerplant'];
    const claimed = new Set<number>();
    const out: Landmark[] = [];
    for (let i = 0; i < n; i++) {
        const b = cands[i], foot = insetToward(b.poly, centroid(b.poly), 0.08);
        if (foot.length < 3) continue;
        const fr = frontage(foot), c = centroid(foot);
        const entrance: V2 = fr ? [(fr.a[0] + fr.b[0]) * 0.5 + fr.outward[0] * 0.05, (fr.a[1] + fr.b[1]) * 0.5 + fr.outward[1] * 0.05] : c;
        out.push({ id: i, type: types[i % types.length], block: b.id, footprint: foot, center: c, entrance });
        claimed.add(b.id);
    }
    if (claimed.size) for (const lot of graph.lots) if (claimed.has(lot.block)) lot.slot = 'landmark';
    return out;
}

/** Render the placed landmarks (region-filterable for the active-region editor). */
export function buildLandmarks(graph: WorldGraph, keep?: ((region: number) => boolean) | null): LayoutPreviewLayer[] {
    if (!graph.landmarks.length) return [];
    const gy = graph.params.groundY, s = graph.radius / 10;
    const { regionByBlock } = graphLookups(graph);
    const rng = makeRng((graph.params.seed ^ 0x2b17f3) >>> 0);
    const a: Accs = { stone: new Accum3D(), roof: new Accum3D(), dome: new Accum3D(), dark: new Accum3D(), accent: new Accum3D(), steps: new Accum3D(), red: new Accum3D(), field: new Accum3D(), glass: new Accum3D() };
    // SLOPE PADS: landmarks are RIGID at their anchor height (elevation at the centre) with a stone foundation
    // pad down to the lowest terrain corner — the lm-* layers are routed with NO height field in the manager.
    const elev = makeElevation(graph);
    for (const lm of graph.landmarks) {
        if (keep && !keep(regionByBlock.get(lm.block) ?? -1)) continue;
        const lift = elev(lm.center[0], lm.center[1]);
        let minE = Infinity; for (const pt of lm.footprint) minE = Math.min(minE, elev(pt[0], pt[1]));
        if (lift - minE > 0.004 * s) a.steps.walls(lm.footprint, gy + minE - 0.012 * s, lift - minE + 0.013 * s);
        const gyl = gy + lift;
        if (lm.type !== 'stadium' && lm.type !== 'shrine' && lm.type !== 'school') plinth(a, lm.footprint, lm.center, gyl, s);   // grand wide base course (school keeps a flat open yard)
        switch (lm.type) {
            case 'cityhall': cityHall(a, lm, gyl, s); break;
            case 'museum': museum(a, lm, gyl, s); break;
            case 'station': station(a, lm, gyl, s); break;
            case 'hospital': hospital(a, lm, gyl, s); break;
            case 'shrine': shrine(a, lm, gyl, s); break;
            case 'radiotower': radiotower(a, lm, gyl, s); break;
            case 'postoffice': postoffice(a, lm, gyl, s); break;
            case 'stadium': stadium(a, lm, gyl, s); break;
            case 'powerplant': powerplant(a, lm, gyl, s); break;
            case 'megatower': megatower(a, lm, gyl, s, gy + 0.8 * s); break;   // portal centred on the sky-train line
            case 'school': school(a, lm, gyl, s); break;
        }
        void rng;
    }
    const layers: LayoutPreviewLayer[] = [];
    const push = (acc: Accum3D, name: string, color: [number, number, number], emissive?: number): void => { if (!acc.empty) layers.push({ name, color, y: gy, geometry: acc.geometry(), emissive }); };
    // Stone walls use the full WINDOWS pattern (real inset openings + sills + stone plinth + concrete panel shade,
    // and they LIGHT UP at night like every other building) — landmark facades stop reading as giant blank grids.
    if (!a.stone.empty) layers.push({ name: 'world:lm-stone', color: STONE, y: gy, geometry: a.stone.geometry(), pattern: { color: [1.0, 0.87, 0.55], freq: 62.5 / graph.radius, scale: 0.24, mode: 'windows', spacing: graph.params.nightMode ? 0.5 : 0, angle: 1 } });
    // Landmark roofs share the SHINGLE pattern (staggered courses + per-tile shade) with the zone buildings.
    if (!a.roof.empty) layers.push({ name: 'world:lm-roof', color: ROOF, y: gy, geometry: a.roof.geometry(), pattern: { color: [ROOF[0] * 0.68, ROOF[1] * 0.68, ROOF[2] * 0.68], freq: 26, scale: 0.3, mode: 'grid', spacing: 1 } });
    push(a.dome, 'world:lm-dome', DOME);
    push(a.dark, 'world:lm-dark', DARK);
    push(a.accent, 'world:lm-accent', ACCENT, graph.params.nightMode ? 1.1 : 0.5);
    push(a.steps, 'world:lm-steps', STEP);
    push(a.red, 'world:lm-red', RED);
    push(a.field, 'world:lm-field', GREEN);
    push(a.glass, 'world:lm-glass', GLASS);
    return layers;
}

// ── Templates ────────────────────────────────────────────────────────────────────────────────────

/** City Hall: a symmetric masonry block with corner pilasters, an entrance portico, a central clock tower + spire. */
function cityHall(a: Accs, lm: Landmark, gy: number, s: number): void {
    const foot = lm.footprint, c = lm.center, h = 0.9 * s;
    a.stone.walls(foot, gy, h); a.stone.cap(foot, gy + h); cornice(a, foot, c, gy + h, s);
    cornerPilasters(a, foot, gy, h, s);
    stringCourses(a, foot, c, gy, h, s);
    portal(a, foot, gy, s);
    const tf = insetToward(foot, c, 0.66);
    if (tf.length >= 3) {
        const th = h + 1.15 * s;
        a.stone.walls(tf, gy, th); a.stone.cap(tf, gy + th); cornice(a, tf, c, gy + th, s); a.dark.pyramid(tf, gy + th, 0.5 * s);
        const fr = frontage(tf);
        if (fr) {
            const cx = (fr.a[0] + fr.b[0]) * 0.5, cz = (fr.a[1] + fr.b[1]) * 0.5;
            a.accent.disc([cx + fr.outward[0] * 0.012 * s, gy + th - 0.14 * s, cz + fr.outward[1] * 0.012 * s], [fr.outward[0], 0, fr.outward[1]], 0.06 * s, 14);
        }
    }
    portico(a, foot, gy, s, 0.44 * s);
    frontSteps(a.steps, foot, gy, s);
}

/** Museum: a grand block, a fronting colonnade under a triangular PEDIMENT, a verdigris dome, front steps. */
function museum(a: Accs, lm: Landmark, gy: number, s: number): void {
    const foot = lm.footprint, c = lm.center, h = 0.62 * s;
    a.stone.walls(foot, gy, h); a.stone.cap(foot, gy + h); cornice(a, foot, c, gy + h, s);
    stringCourses(a, foot, c, gy, h, s);
    portal(a, foot, gy, s);
    const dr = Math.min(0.16 * s, Math.sqrt(Math.max(0, polyArea(foot))) * 0.22);
    a.dome.prism([c[0], gy + h, c[1]], dr, dr, 0.08 * s, 14); a.dome.cone([c[0], gy + h + 0.08 * s, c[1]], dr, 0.14 * s, 14);
    a.accent.blob([c[0], gy + h + 0.24 * s, c[1]], 0.018 * s, 0.03 * s, 0.018 * s, 0, 0);   // dome finial
    const fr = frontage(foot);
    if (fr) {
        const eW: V3 = [fr.eDir[0], 0, fr.eDir[1]], oW: V3 = [fr.outward[0], 0, fr.outward[1]], up: V3 = [0, 1, 0];
        const nCol = Math.max(3, Math.floor(fr.len / (0.09 * s))), colH = h * 0.92, colR = 0.014 * s, ox = oW[0] * 0.03 * s, oz = oW[2] * 0.03 * s;
        for (let i = 0; i <= nCol; i++) { const t = i / nCol; a.stone.prism([fr.a[0] + (fr.b[0] - fr.a[0]) * t + ox, gy, fr.a[1] + (fr.b[1] - fr.a[1]) * t + oz], colR, colR, colH, 8); }
        const mx = (fr.a[0] + fr.b[0]) * 0.5 + ox, mz = (fr.a[1] + fr.b[1]) * 0.5 + oz;
        a.roof.obox([mx, gy + colH + 0.02 * s, mz], eW, up, oW, fr.len * 0.5, 0.03 * s, 0.035 * s);   // entablature
        pediment(a, [mx, gy + colH + 0.05 * s, mz], eW, oW, fr.len * 0.5, 0.11 * s, s);
    }
    frontSteps(a.steps, foot, gy, s);
}

/** Station: a wide low hall under a big gable train-shed roof, a front clock, an entrance canopy on posts. */
function station(a: Accs, lm: Landmark, gy: number, s: number): void {
    const foot = lm.footprint, c = lm.center, h = 0.5 * s;
    a.stone.walls(foot, gy, h); a.stone.cap(foot, gy + h); cornice(a, foot, c, gy + h, s);
    stringCourses(a, foot, c, gy, h, s);
    portal(a, foot, gy, s);
    gableRoof(a.roof, foot, gy + h, 0.42 * s);
    const fr = frontage(foot);
    if (fr) {
        const eW: V3 = [fr.eDir[0], 0, fr.eDir[1]], oW: V3 = [fr.outward[0], 0, fr.outward[1]], up: V3 = [0, 1, 0];
        const mx = (fr.a[0] + fr.b[0]) * 0.5, mz = (fr.a[1] + fr.b[1]) * 0.5;
        a.accent.disc([mx + oW[0] * 0.02 * s, gy + h + 0.18 * s, mz + oW[2] * 0.02 * s], oW, 0.05 * s, 14);   // gable clock
        a.dark.obox([mx + oW[0] * 0.06 * s, gy + 0.3 * s, mz + oW[2] * 0.06 * s], eW, up, oW, fr.len * 0.42, 0.008 * s, 0.06 * s);   // canopy roof
        for (const side of [-1, 1]) a.dark.prism([mx + eW[0] * fr.len * 0.38 * side + oW[0] * 0.1 * s, gy, mz + eW[2] * fr.len * 0.38 * side + oW[2] * 0.1 * s], 0.006 * s, 0.006 * s, 0.3 * s, 4);
    }
}

/** Post office: a utilitarian block + a big front sign band + an entrance canopy + a flagpole with flag. */
function postoffice(a: Accs, lm: Landmark, gy: number, s: number): void {
    const foot = lm.footprint, c = lm.center, h = 0.55 * s;
    setbackBlock(a, foot, c, gy, h, s);
    stringCourses(a, foot, c, gy, h * 0.7, s);
    portal(a, foot, gy, s);
    const fr = frontage(foot);
    if (fr) {
        const eW: V3 = [fr.eDir[0], 0, fr.eDir[1]], oW: V3 = [fr.outward[0], 0, fr.outward[1]], up: V3 = [0, 1, 0];
        const mx = (fr.a[0] + fr.b[0]) * 0.5, mz = (fr.a[1] + fr.b[1]) * 0.5;
        a.accent.obox([mx + oW[0] * 0.008 * s, gy + h * 0.72, mz + oW[2] * 0.008 * s], eW, up, oW, fr.len * 0.42, 0.05 * s, 0.008 * s);
        const px = fr.a[0] + oW[0] * 0.03 * s, pz = fr.a[1] + oW[2] * 0.03 * s;
        a.dark.prism([px, gy, pz], 0.005 * s, 0.005 * s, h + 0.4 * s, 4);
        a.red.obox([px + eW[0] * 0.045 * s, gy + h + 0.3 * s, pz + eW[2] * 0.045 * s], eW, up, oW, 0.045 * s, 0.026 * s, 0.003 * s);
    }
    entranceCanopy(a, foot, gy, s, 0.34 * s);
    frontSteps(a.steps, foot, gy, s);
}

/** Hospital: a tall block with window bands, a rooftop HELIPAD, an entrance canopy + a red cross on the frontage. */
function hospital(a: Accs, lm: Landmark, gy: number, s: number): void {
    const foot = lm.footprint, c = lm.center, h = 1.0 * s;
    setbackBlock(a, foot, c, gy, h, s);   // base + inset upper tier (grander silhouette than one box)
    stringCourses(a, foot, c, gy, h * 0.7, s);
    portal(a, foot, gy, s);
    const r = Math.min(0.13 * s, Math.sqrt(Math.max(0, polyArea(foot))) * 0.28);
    a.dark.disc([c[0], gy + h + 0.004 * s, c[1]], [0, 1, 0], r, 16);
    const bar = (dx: number, hx: number, hz: number): void => a.accent.obox([c[0] + dx, gy + h + 0.008 * s, c[1]], [1, 0, 0], [0, 1, 0], [0, 0, 1], hx, 0.002 * s, hz);
    bar(-r * 0.34, r * 0.07, r * 0.42); bar(r * 0.34, r * 0.07, r * 0.42); bar(0, r * 0.34, r * 0.07);
    const fr = frontage(foot);
    if (fr) {
        const eW: V3 = [fr.eDir[0], 0, fr.eDir[1]], oW: V3 = [fr.outward[0], 0, fr.outward[1]], up: V3 = [0, 1, 0];
        const mx = (fr.a[0] + fr.b[0]) * 0.5 + oW[0] * 0.008 * s, mz = (fr.a[1] + fr.b[1]) * 0.5 + oW[2] * 0.008 * s, y = gy + h * 0.62;
        a.red.obox([mx, y, mz], eW, up, oW, 0.018 * s, 0.055 * s, 0.006 * s);
        a.red.obox([mx, y, mz], eW, up, oW, 0.055 * s, 0.018 * s, 0.006 * s);
    }
    entranceCanopy(a, foot, gy, s, 0.32 * s);
    frontSteps(a.steps, foot, gy, s);
}

/** Radio/TV station: a mid block + a tall tapering broadcast MAST with an observation deck + a red beacon. */
function radiotower(a: Accs, lm: Landmark, gy: number, s: number): void {
    const foot = lm.footprint, c = lm.center, h = 0.6 * s;
    a.stone.walls(foot, gy, h); a.stone.cap(foot, gy + h); cornice(a, foot, c, gy + h, s);
    let cur = insetToward(foot, c, 0.82), y = gy + h;
    for (let i = 0; i < 4; i++) {
        const next = insetToward(cur, c, 0.34), th = 0.55 * s; a.dark.frustum(cur, next, y, y + th);
        if (i === 1) { const dr = Math.hypot(cur[0][0] - c[0], cur[0][1] - c[1]) * 1.35; a.glass.prism([c[0], y - 0.02 * s, c[1]], dr, dr, 0.06 * s, 12); }   // observation deck
        cur = next; y += th;
    }
    a.red.blob([c[0], y + 0.05 * s, c[1]], 0.02 * s, 0.03 * s, 0.02 * s, 0, 0);
}

/** Shrine: an OUTER + inner vermilion TORII, two guardian komainu, a hall under a broad hip roof + steps. */
function shrine(a: Accs, lm: Landmark, gy: number, s: number): void {
    const foot = lm.footprint, c = lm.center, hall = insetToward(foot, c, 0.4), h = 0.4 * s;
    if (hall.length >= 3) { a.stone.walls(hall, gy, h); a.roof.pyramid(hall, gy + h, 0.42 * s); a.roof.pyramid(hall, gy + h + 0.16 * s, 0.24 * s); }   // 2-tier roof
    const fr = frontage(foot);
    if (fr) {
        const eW: V3 = [fr.eDir[0], 0, fr.eDir[1]], oW: V3 = [fr.outward[0], 0, fr.outward[1]], up: V3 = [0, 1, 0];
        const mx = (fr.a[0] + fr.b[0]) * 0.5, mz = (fr.a[1] + fr.b[1]) * 0.5, gw = fr.len * 0.4;
        toriiGate(a, [mx + oW[0] * 0.06 * s, mz + oW[2] * 0.06 * s], eW, oW, up, gw, 0.5 * s, gy, s);        // inner
        toriiGate(a, [mx + oW[0] * 0.24 * s, mz + oW[2] * 0.24 * s], eW, oW, up, gw * 1.25, 0.62 * s, gy, s); // outer (grander)
        for (const side of [-1, 1]) komainu(a, [mx + eW[0] * gw * 1.15 * side + oW[0] * 0.13 * s, mz + eW[2] * gw * 1.15 * side + oW[2] * 0.13 * s], gy, s);
    }
    frontSteps(a.steps, foot, gy, s);
}

/** Stadium: an outer bowl wall, a seating rake down to a green pitch, four corner floodlight masts. */
function stadium(a: Accs, lm: Landmark, gy: number, s: number): void {
    const foot = lm.footprint, c = lm.center, outerH = 0.5 * s;
    a.stone.walls(foot, gy, outerH);
    const inner = insetToward(foot, c, 0.5);
    if (inner.length >= 3) a.stone.frustum(foot, inner, gy + outerH, gy + outerH * 0.4);
    const field = insetToward(foot, c, 0.6);
    if (field.length >= 3) a.field.cap(field, gy + outerH * 0.32, 1);
    // floodlight masts at the footprint's extreme corners
    const bb = bounds(foot);
    for (const cx of [bb.min[0], bb.max[0]]) for (const cz of [bb.min[1], bb.max[1]]) floodMast(a, [c[0] + (cx - c[0]) * 0.98, c[1] + (cz - c[1]) * 0.98], gy, s);
}

/** Power plant: a block + two hyperboloid COOLING TOWERS (steam plumes) + a tall smokestack with a hazard band. */
function powerplant(a: Accs, lm: Landmark, gy: number, s: number): void {
    const foot = lm.footprint, c = lm.center, h = 0.5 * s, bb = bounds(foot);
    a.stone.walls(foot, gy, h); a.stone.cap(foot, gy + h);
    const t1x = c[0] + (bb.max[0] - c[0]) * 0.45, t1z = c[1] + (bb.max[1] - c[1]) * 0.45;
    coolingTower(a.stone, t1x, t1z, gy, 0.11 * s, 0.9 * s); a.glass.blob([t1x, gy + 0.95 * s, t1z], 0.09 * s, 0.05 * s, 0.09 * s, 0.3, 11);   // steam
    const t2x = c[0] + (bb.max[0] - c[0]) * 0.05, t2z = c[1] + (bb.min[1] - c[1]) * 0.5;
    coolingTower(a.stone, t2x, t2z, gy, 0.08 * s, 0.66 * s); a.glass.blob([t2x, gy + 0.7 * s, t2z], 0.065 * s, 0.04 * s, 0.065 * s, 0.3, 23);
    const skx = c[0] + (bb.min[0] - c[0]) * 0.45, skz = c[1] + (bb.min[1] - c[1]) * 0.45;
    a.dark.prism([skx, gy, skz], 0.024 * s, 0.024 * s, 1.3 * s, 8);
    a.red.prism([skx, gy + 1.14 * s, skz], 0.027 * s, 0.027 * s, 0.08 * s, 8);
}

/** MEGATOWER (the cyber landmark): a podium + TWO slab towers bridged again at the top, leaving a square
 *  PORTAL through the middle that the SKY-TRAIN weaves through (the skyway path runs +X through `lm.center`
 *  at `trainY`, so the hole is open along X and centred on that height). Neon edge trim frames the opening. */
function megatower(a: Accs, lm: Landmark, gy: number, s: number, trainY: number): void {
    const foot = lm.footprint, c = lm.center, bb = bounds(foot);
    const wx = Math.max(0.12 * s, (bb.max[0] - bb.min[0]) / 2), wz = Math.max(0.12 * s, (bb.max[1] - bb.min[1]) / 2);
    const H = 1.9 * s;                                        // dominates the skyline
    const xA: V3 = [1, 0, 0], up: V3 = [0, 1, 0], zA: V3 = [0, 0, 1];
    const loTop = Math.max(gy + 0.25 * s, trainY - 0.3 * s);  // podium roof = portal floor
    const hiBot = trainY + 0.32 * s;                          // upper bridge = portal ceiling
    const tw = wz * 0.32;                                     // each tower slab's half-depth (z)
    // Podium (full footprint, up to the portal floor).
    a.stone.obox([c[0], (gy + loTop) / 2, c[1]], xA, up, zA, wx * 0.98, (loTop - gy) / 2, wz * 0.98);
    // Twin towers at the ±z edges (the portal walls), podium → full height.
    for (const sz of [-1, 1]) a.stone.obox([c[0], (loTop + gy + H) / 2, c[1] + sz * (wz - tw)], xA, up, zA, wx * 0.86, (gy + H - loTop) / 2, tw);
    // Upper bridge spanning the towers above the portal → the "square hole" silhouette.
    a.stone.obox([c[0], (hiBot + gy + H) / 2, c[1]], xA, up, zA, wx * 0.74, (gy + H - hiBot) / 2, Math.max(0.02 * s, wz - 2 * tw) * 1.1);
    // Neon trim framing the portal mouth (glows at night like the accent layer).
    a.accent.obox([c[0], loTop + 0.008 * s, c[1]], xA, up, zA, wx * 0.9, 0.008 * s, Math.max(0.02 * s, wz - 2 * tw));
    a.accent.obox([c[0], hiBot - 0.008 * s, c[1]], xA, up, zA, wx * 0.9, 0.008 * s, Math.max(0.02 * s, wz - 2 * tw));
    // Crown: helipad + comms mast + red beacon.
    a.dark.disc([c[0], gy + H + 0.004 * s, c[1]], [0, 1, 0], Math.min(wx, wz) * 0.5, 14);
    a.dark.prism([c[0], gy + H, c[1]], 0.012 * s, 0.012 * s, 0.35 * s, 4);
    a.red.blob([c[0], gy + H + 0.38 * s, c[1]], 0.016 * s, 0.024 * s, 0.016 * s, 0, 0);
}

/** SCHOOL: an L of classroom wings at the back of the lot + a big open YARD in front — pale sports court
 *  with white line markings, two goal frames, and a flagpole. The yard is the tell (schools read by their field). */
function school(a: Accs, lm: Landmark, gy: number, s: number): void {
    const foot = lm.footprint, c = lm.center, bb = bounds(foot);
    const wx = (bb.max[0] - bb.min[0]) / 2, wz = (bb.max[1] - bb.min[1]) / 2, h = 0.42 * s;
    const xA: V3 = [1, 0, 0], up: V3 = [0, 1, 0], zA: V3 = [0, 0, 1];
    // Classroom wings: a long block along the back edge + a short wing down one side (the L).
    a.stone.obox([c[0], gy + h / 2, bb.min[1] + wz * 0.3], xA, up, zA, wx * 0.9, h / 2, wz * 0.28);
    a.stone.obox([bb.min[0] + wx * 0.24, gy + h * 0.4, c[1]], xA, up, zA, wx * 0.22, h * 0.4, wz * 0.62);
    cornice(a, [[bb.min[0] + wx * 0.1, bb.min[1]], [bb.max[0] - wx * 0.1, bb.min[1]], [bb.max[0] - wx * 0.1, bb.min[1] + wz * 0.6], [bb.min[0] + wx * 0.1, bb.min[1] + wz * 0.6]], c, gy + h, s);
    // Clock on the main wing's yard-facing face.
    a.accent.disc([c[0], gy + h * 0.78, bb.min[1] + wz * 0.58 + 0.006 * s], [0, 0, 1], 0.035 * s, 12);
    // The YARD: pale court + white markings (centre circle + a mid line) + two goal frames.
    const yc: V2 = [c[0] + wx * 0.12, bb.max[1] - wz * 0.42], yw = wx * 0.62, yd = wz * 0.36;
    const yard: V2[] = [[yc[0] - yw, yc[1] - yd], [yc[0] + yw, yc[1] - yd], [yc[0] + yw, yc[1] + yd], [yc[0] - yw, yc[1] + yd]];
    a.field.cap(yard, gy + 0.006 * s, 1);
    a.accent.obox([yc[0], gy + 0.009 * s, yc[1]], xA, up, zA, 0.0015 * s, 0.0008 * s, yd * 0.92);          // mid line
    a.accent.prism([yc[0], gy + 0.008 * s, yc[1]], 0.03 * s, 0.03 * s, 0.0012 * s, 12);                    // centre circle (thin disc)
    for (const sx of [-1, 1]) {                                                                             // goal frames
        const gx = yc[0] + sx * yw * 0.88;
        for (const sz of [-1, 1]) a.dark.prism([gx, gy, yc[1] + sz * 0.03 * s], 0.0022 * s, 0.0022 * s, 0.025 * s, 4);
        a.dark.beam([gx, gy + 0.025 * s, yc[1] - 0.03 * s], [gx, gy + 0.025 * s, yc[1] + 0.03 * s], 0.002 * s, 3);
    }
    // Flagpole at the yard corner.
    const fx = yc[0] - yw * 0.9, fz = yc[1] - yd * 0.9;
    a.dark.prism([fx, gy, fz], 0.004 * s, 0.004 * s, 0.34 * s, 4);
    a.red.obox([fx + 0.028 * s, gy + 0.315 * s, fz], xA, up, zA, 0.026 * s, 0.016 * s, 0.002 * s);
}

// ── Shared detail helpers ─────────────────────────────────────────────────────────────────────────

/** A wide, short stone base course (expands the footprint outward a touch) — grounds the building grandly. */
function plinth(a: Accs, foot: V2[], c: V2, gy: number, s: number): void {
    const base = insetToward(foot, c, -0.06);   // negative = expand outward
    if (base.length < 3) return;
    a.steps.walls(base, gy, 0.05 * s); a.steps.cap(base, gy + 0.05 * s);
}

/** Thin projecting STRING COURSES between floors — the intricate masonry banding of a real civic building. */
function stringCourses(a: Accs, foot: V2[], c: V2, gy: number, h: number, s: number): void {
    const band = insetToward(foot, c, -0.018);
    if (band.length < 3) return;
    const floorH = 0.28 * s;
    for (let y = gy + floorH; y < gy + h - 0.08 * s; y += floorH) { a.steps.walls(band, y, 0.014 * s); a.steps.cap(band, y + 0.014 * s); }
}

/** The MAIN block with an upper SETBACK tier (base → cornice line → inset upper storey) — a grander silhouette
 *  than one extrusion. Returns the roofline Y. */
function setbackBlock(a: Accs, foot: V2[], c: V2, gy: number, h: number, s: number): number {
    const split = gy + h * 0.7;
    a.stone.walls(foot, gy, h * 0.7); a.stone.cap(foot, split);
    cornice(a, foot, c, split, s);
    const upper = insetToward(foot, c, 0.16);
    if (upper.length >= 3) { a.stone.walls(upper, split, h * 0.3); a.stone.cap(upper, gy + h); cornice(a, upper, c, gy + h, s); }
    return gy + h;
}

/** A grand ENTRANCE PORTAL: dark double-height doorway + stone jambs + a lintel over it, at the frontage middle. */
function portal(a: Accs, foot: V2[], gy: number, s: number): void {
    const fr = frontage(foot); if (!fr) return;
    const eW: V3 = [fr.eDir[0], 0, fr.eDir[1]], oW: V3 = [fr.outward[0], 0, fr.outward[1]], up: V3 = [0, 1, 0];
    const mx = (fr.a[0] + fr.b[0]) * 0.5 + oW[0] * 0.006 * s, mz = (fr.a[1] + fr.b[1]) * 0.5 + oW[2] * 0.006 * s;
    const doorH = 0.2 * s, doorW = 0.055 * s;
    a.dark.obox([mx, gy + doorH * 0.5, mz], eW, up, oW, doorW, doorH * 0.5, 0.006 * s);                       // recessed dark doorway
    for (const side of [-1, 1]) a.steps.obox([mx + eW[0] * (doorW + 0.012 * s) * side, gy + doorH * 0.5, mz + eW[2] * (doorW + 0.012 * s) * side], eW, up, oW, 0.012 * s, doorH * 0.5, 0.012 * s);   // jambs
    a.steps.obox([mx, gy + doorH + 0.016 * s, mz], eW, up, oW, doorW + 0.03 * s, 0.016 * s, 0.014 * s);        // lintel
}

/** A projecting cornice band (slightly overhangs the wall) at the top of a block. */
function cornice(a: Accs, foot: V2[], c: V2, y: number, s: number): void {
    const cf = insetToward(foot, c, -0.035);
    if (cf.length < 3) return;
    a.roof.walls(cf, y, 0.035 * s); a.roof.cap(cf, y + 0.035 * s);
}

/** Thin pilasters at each footprint corner (vertical stone ribs framing the facade). */
function cornerPilasters(a: Accs, foot: V2[], gy: number, h: number, s: number): void {
    for (const v of foot) a.stone.prism([v[0], gy, v[1]], 0.02 * s, 0.02 * s, h * 1.02, 4);
}

/** A grand entrance PORTICO: two columns + an entablature + a triangular pediment, projecting from the frontage. */
function portico(a: Accs, foot: V2[], gy: number, s: number, ph: number): void {
    const fr = frontage(foot); if (!fr) return;
    const eW: V3 = [fr.eDir[0], 0, fr.eDir[1]], oW: V3 = [fr.outward[0], 0, fr.outward[1]], up: V3 = [0, 1, 0];
    const mx = (fr.a[0] + fr.b[0]) * 0.5 + oW[0] * 0.045 * s, mz = (fr.a[1] + fr.b[1]) * 0.5 + oW[2] * 0.045 * s;
    const pw = Math.min(fr.len * 0.24, 0.16 * s);
    for (const side of [-1, 1]) a.stone.prism([mx + eW[0] * pw * side, gy, mz + eW[2] * pw * side], 0.016 * s, 0.016 * s, ph, 8);
    a.roof.obox([mx, gy + ph + 0.02 * s, mz], eW, up, oW, pw * 1.35, 0.02 * s, 0.045 * s);
    pediment(a, [mx, gy + ph + 0.04 * s, mz], eW, oW, pw * 1.35, 0.09 * s, s);
}

/** A flat entrance canopy on two slim posts over the door. */
function entranceCanopy(a: Accs, foot: V2[], gy: number, s: number, doorH: number): void {
    const fr = frontage(foot); if (!fr) return;
    const eW: V3 = [fr.eDir[0], 0, fr.eDir[1]], oW: V3 = [fr.outward[0], 0, fr.outward[1]], up: V3 = [0, 1, 0];
    const mx = (fr.a[0] + fr.b[0]) * 0.5, mz = (fr.a[1] + fr.b[1]) * 0.5, w = Math.min(fr.len * 0.2, 0.14 * s), proj = 0.07 * s;
    for (const side of [-1, 1]) a.dark.prism([mx + eW[0] * w * side + oW[0] * proj, gy, mz + eW[2] * w * side + oW[2] * proj], 0.006 * s, 0.006 * s, doorH, 4);
    a.dark.obox([mx + oW[0] * proj * 0.5, gy + doorH, mz + oW[2] * proj * 0.5], eW, up, oW, w * 1.15, 0.006 * s, proj * 0.5);
}

/** A triangular pediment (tympanum) facing outward, `halfW` wide, `ph` tall, at `base` (top of the entablature). */
function pediment(a: Accs, base: V3, eW: V3, oW: V3, halfW: number, ph: number, s: number): void {
    const d = 0.035 * s;
    const L: V3 = [base[0] - eW[0] * halfW, base[1], base[2] - eW[2] * halfW];
    const R: V3 = [base[0] + eW[0] * halfW, base[1], base[2] + eW[2] * halfW];
    const AP: V3 = [base[0], base[1] + ph, base[2]];
    const Lo: V3 = [L[0] - oW[0] * d, L[1], L[2] - oW[2] * d], Ro: V3 = [R[0] - oW[0] * d, R[1], R[2] - oW[2] * d], APo: V3 = [AP[0] - oW[0] * d, AP[1], AP[2] - oW[2] * d];
    a.roof.quad4(L, R, AP, AP);      // front face
    a.roof.quad4(Ro, Lo, APo, APo);  // back face
    a.roof.quad4(L, AP, APo, Lo);    // left rake
    a.roof.quad4(R, Ro, APo, AP);    // right rake
    a.roof.quad4(L, Lo, Ro, R);      // underside
}

/** A vermilion torii gate: two battered posts, a curved top lintel (kasagi) + a lower tie-beam (nuki). */
function toriiGate(a: Accs, pos: V2, eW: V3, oW: V3, up: V3, gw: number, gh: number, gy: number, s: number): void {
    for (const side of [1, -1]) a.red.prism([pos[0] + eW[0] * gw * side, gy, pos[1] + eW[2] * gw * side], 0.016 * s, 0.014 * s, gh, 6);
    a.red.obox([pos[0], gy + gh, pos[1]], eW, up, oW, gw * 1.28, 0.022 * s, 0.032 * s);        // kasagi (top)
    a.red.obox([pos[0], gy + gh * 0.72, pos[1]], eW, up, oW, gw, 0.014 * s, 0.022 * s);         // nuki (tie-beam)
}

/** A stone guardian (komainu): a squat body blob + a head blob. */
function komainu(a: Accs, pos: V2, gy: number, s: number): void {
    a.stone.blob([pos[0], gy + 0.03 * s, pos[1]], 0.02 * s, 0.03 * s, 0.026 * s, 0.2, pos[0] * 13.1 + 1);
    a.stone.blob([pos[0], gy + 0.075 * s, pos[1]], 0.016 * s, 0.018 * s, 0.016 * s, 0.2, pos[1] * 7.3 + 2);
}

/** A stadium floodlight mast: a tall dark pole + a bright angled head. */
function floodMast(a: Accs, pos: V2, gy: number, s: number): void {
    a.dark.prism([pos[0], gy, pos[1]], 0.008 * s, 0.008 * s, 0.72 * s, 4);
    a.accent.obox([pos[0], gy + 0.72 * s, pos[1]], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.03 * s, 0.016 * s, 0.012 * s);
}

function circlePoly(cx: number, cz: number, r: number, n = 12): V2[] {
    const o: V2[] = []; for (let i = 0; i < n; i++) { const ang = (i / n) * Math.PI * 2; o.push([cx + Math.cos(ang) * r, cz + Math.sin(ang) * r]); } return o;
}
function coolingTower(acc: Accum3D, cx: number, cz: number, gy: number, r: number, h: number): void {
    const b = circlePoly(cx, cz, r), w = circlePoly(cx, cz, r * 0.58), t = circlePoly(cx, cz, r * 0.72);
    acc.frustum(b, w, gy, gy + h * 0.58); acc.frustum(w, t, gy + h * 0.58, gy + h);
}

/** A gable roof over a footprint's bounding box (ridge along the longer axis). */
function gableRoof(roof: Accum3D, foot: V2[], baseY: number, ridgeH: number): void {
    const bb = bounds(foot), topY = baseY + ridgeH;
    const x0 = bb.min[0], x1 = bb.max[0], z0 = bb.min[1], z1 = bb.max[1];
    if (x1 - x0 >= z1 - z0) {
        const zm = (z0 + z1) * 0.5;
        roof.quad4([x0, baseY, z0], [x1, baseY, z0], [x1, topY, zm], [x0, topY, zm]);
        roof.quad4([x0, baseY, z1], [x0, topY, zm], [x1, topY, zm], [x1, baseY, z1]);
        roof.quad4([x0, baseY, z0], [x0, topY, zm], [x0, baseY, z1], [x0, baseY, z0]);
        roof.quad4([x1, baseY, z0], [x1, baseY, z1], [x1, topY, zm], [x1, baseY, z0]);
    } else {
        const xm = (x0 + x1) * 0.5;
        roof.quad4([x0, baseY, z0], [xm, topY, z0], [xm, topY, z1], [x0, baseY, z1]);
        roof.quad4([x1, baseY, z0], [x1, baseY, z1], [xm, topY, z1], [xm, topY, z0]);
        roof.quad4([x0, baseY, z0], [x1, baseY, z0], [xm, topY, z0], [x0, baseY, z0]);
        roof.quad4([x0, baseY, z1], [xm, topY, z1], [x1, baseY, z1], [x0, baseY, z1]);
    }
}

/** A short flight of front steps at the entrance (a grand threshold). */
function frontSteps(steps: Accum3D, foot: V2[], gy: number, s: number): void {
    const fr = frontage(foot); if (!fr) return;
    const mx = (fr.a[0] + fr.b[0]) * 0.5, mz = (fr.a[1] + fr.b[1]) * 0.5;
    const eW: V3 = [fr.eDir[0], 0, fr.eDir[1]], oW: V3 = [fr.outward[0], 0, fr.outward[1]], up: V3 = [0, 1, 0];
    const n = 3, rise = 0.02 * s, run = 0.035 * s, width = fr.len * 0.32;
    for (let i = 0; i < n; i++) { const off = (n - i) * run; steps.obox([mx + oW[0] * off, gy + (i + 0.5) * rise, mz + oW[2] * off], eW, up, oW, width, rise * 0.6, run); }
}
