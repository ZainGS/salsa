// ── World generation — FRONTAGE DRESSING (persona-polish D1) ──────────────────────────────────────
// Persona 5's streets are dense at eye level; ours read as grey boxes with shutters. This pass adds the small,
// cheap things that make a Japanese shop street feel lived in, all placed by the shared pavement plan
// (street-slots.ts step 14 — so walkers, trees, poles and vending runs never collide with them):
//   · NOBORI — tall vertical shop banners on a thin pole in a weighted base, in runs of 1-3 beside shop doors, plus
//     rows down the shotengai. ONE canonical geometry, GPU-instanced (one draw per part for the whole city), a
//     per-instance tint for the flag colour, and the shared WIND sway (pole + flag + lettering carry the SAME wind
//     spec, so the flag never detaches from its pole — a fibreglass nobori pole really does flex).
//   · NOREN — a short split curtain over the door of the small shops whose building has none of its own (lot meta
//     says which: archetype + ownNoren), hung from a rod just proud of the door head. World-baked, merged per colour.
//   · BIKES parked against the wall (a mamachari outside a house or shop) — the furniture bicycle builder.
// Doorway pots, extra crate stacks and menu boards are EXISTING kinds the plan now also reserves at doors: biome
// (pots) and furniture (crates / A-boards) emit them, so they need nothing here.
//
// Deterministic (position hashes only), region-filterable, chunk-friendly (instanced + merged layers split by the
// city chunker like every other). Layer names are chosen for the tiers on purpose: `world:frontage-*` and
// `world:bicycle-*` are PROPS_LOD, `world:noren-*` is DETAIL_LOD (and BAKED in the drape pass). Nothing is lit, so
// no GLOW rule applies (the catch-all 0.05 / 0.03). One material family per mesh: the flag / text / pole layers are
// `wind` only, the base is `metal` only.

import type { WorldGraph, LayoutPreviewLayer, V2, InstanceXform } from './types';
import { cityMetresPerUnit, metalScaleFor } from './types';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import { Accum3D } from './meshbuild';
import { hash2, graphLookups } from './util';
import { cellLevelAt, makeElevation } from './elevation';
import { regionAt } from './layout';
import { streetPlan, pavementLift, type Slot } from './street-slots';
import { lotMeta } from './lot-meta';
import { emitBicycle } from './mannequin';

type V3 = [number, number, number];
type C3 = [number, number, number];

/** Nobori flag colours — saturated but varied in hue AND value (B5 palette discipline: not pure primaries). Each
 *  pairs with a lettering colour that reads on it. */
export const NOBORI_COLORS: { flag: C3; text: C3 }[] = [
    { flag: [0.74, 0.14, 0.12], text: [0.95, 0.93, 0.88] },   // ramen red / white
    { flag: [0.13, 0.19, 0.40], text: [0.95, 0.93, 0.88] },   // indigo / white
    { flag: [0.93, 0.73, 0.16], text: [0.66, 0.11, 0.09] },   // yellow / red
    { flag: [0.93, 0.92, 0.87], text: [0.66, 0.11, 0.09] },   // white / red
    { flag: [0.17, 0.44, 0.28], text: [0.95, 0.93, 0.88] },   // green / white
    { flag: [0.88, 0.44, 0.12], text: [0.12, 0.11, 0.11] },   // orange / black
    { flag: [0.10, 0.10, 0.11], text: [0.95, 0.93, 0.88] },   // black / white
];
const NOREN_COLORS: C3[] = [[0.13, 0.17, 0.32], [0.46, 0.13, 0.11], [0.86, 0.84, 0.78], [0.12, 0.12, 0.13]];   // indigo / brick red / unbleached / black
const NOREN_NAMES = ['indigo', 'red', 'white', 'black'];
const NOREN_MARK: C3 = [0.94, 0.92, 0.86];
const POLE: C3 = [0.86, 0.87, 0.88];      // white-painted steel / fibreglass pole
const BASE: C3 = [0.16, 0.16, 0.17];      // black water-filled plastic base
const BIKES: C3[] = [[0.72, 0.74, 0.76], [0.12, 0.12, 0.13], [0.56, 0.74, 0.70], [0.70, 0.22, 0.20]];   // as furniture: silver / black / mint / red
/** Small shops that would hang a noren (not konbini auto-doors, offices, malls, houses). */
const NOREN_ARCH = new Set(['zakkyo', 'retro-shophouse', 'neon-arcade', 'machiya', 'izakaya']);

/** Nobori metrics (METRES — the canonical geometry is in metres, instanced at scale u). */
export const NOBORI_M = { poleH: 2.75, flagW: 0.45, flagTop: 2.6, flagBot: 0.95, pitch: 0.9 };
/** The shared wind spec (flag + lettering + pole move together). Scene wind strength 0.06 × 2 → ~12 cm at the top. */
const NOBORI_WIND = { height: NOBORI_M.poleH, stiffness: 1.5, amount: 2.0 };

/** `shared` = the furniture composer's bicycle accumulators (same colours / materials): wall bikes then merge into its
 *  bicycle layers instead of adding five more draws. Standalone (tests) they get their own `world:bicycle-lean-*` layers. */
export function buildFrontage(graph: WorldGraph, keep?: ((region: number) => boolean) | null,
    shared?: { bikeFrames: Accum3D[]; bikeTyre: Accum3D }): LayoutPreviewLayer[] {
    const p = graph.params;
    if (!(p.frontageDressing ?? true) || !(p.streetFurniture ?? true)) return [];
    const gy = p.groundY, s = p.radius / 10, py = gy + pavementLift(p);
    const u = 1 / cityMetresPerUnit(p.radius), metalScale = metalScaleFor(p.radius);
    const H = (a: number, b: number, salt: number): number => hash2(a, b, (p.seed ^ salt) >>> 0);
    const plan = streetPlan(graph);
    const lift = makeElevation(graph);
    const wet = (x: number, z: number): boolean => cellLevelAt(graph, x, z) < 0;
    const enabled = (x: number, z: number): boolean => !keep || keep(regionAt(graph, x, z) ?? -1);
    const use = (sl: Slot): boolean => enabled(sl.x, sl.z) && !wet(sl.x, sl.z);

    // ── NOBORI (instanced) ───────────────────────────────────────────────────────────────────────
    const flagInst: InstanceXform[] = [];
    const addFlag = (x: number, z: number, xDir: V2, ci: number, scale = 1): void => {
        const c = NOBORI_COLORS[ci % NOBORI_COLORS.length];
        flagInst.push({ x, y: py + lift(x, z), z, ry: Math.atan2(-xDir[1], xDir[0]), s: u * scale, tint: c.flag });
    };
    for (const sl of plan.of('nobori')) {
        if (!use(sl)) continue;
        const R = plan.roads[sl.ri]!, n = Math.max(1, sl.n);
        const toRoad: V2 = [-R.pp[0] * sl.side, -R.pp[1] * sl.side];
        // One run = one shop's flags: mostly one colour, sometimes alternating two.
        const c0 = (sl.h * NOBORI_COLORS.length) | 0, alt = H(sl.ri, Math.round(sl.along * 1000), 0x0b01) < 0.3;
        // The flag plane sits between "facing along the street" and "facing the road" (35-60 deg off the facade), so
        // it reads to someone walking down the pavement AND from across the road; the run shares one lean.
        const sgn = H(sl.ri, Math.round(sl.along * 997), 0x0b02) < 0.5 ? 1 : -1;
        for (let k = 0; k < n; k++) {
            const al = sl.along + (k - (n - 1) / 2) * NOBORI_M.pitch * u;
            const [x, z] = plan.at(sl.ri, sl.side, al, sl.off);
            if (wet(x, z)) continue;
            const a = (0.6 + H(sl.ri, Math.round(al * 1000), 0x0b03) * 0.45) * sgn;
            const xd: V2 = [R.d[0] * Math.cos(a) + toRoad[0] * Math.sin(a), R.d[1] * Math.cos(a) + toRoad[1] * Math.sin(a)];
            addFlag(x, z, xd, alt && k % 2 ? c0 + 3 : c0, 0.95 + H(sl.ri, k, 0x0b04) * 0.1);
        }
    }
    // SHOTENGAI: a flag row down both sides of the pedestrian street, between the stall line and the shops (clear of
    // the walker lanes ±0.31 W and the static crowd ±0.39 W).
    const sg = graph.shotengai;
    if (sg && (!keep || keep(sg.region))) {
        const dx = sg.spine[1][0] - sg.spine[0][0], dz = sg.spine[1][1] - sg.spine[0][1], L = Math.hypot(dx, dz) || 1;
        const ax: V2 = [dx / L, dz / L], pp: V2 = [-ax[1], ax[0]];
        const R = p.radius, cw = 2 * R / p.gridCols, ch = 2 * R / p.gridRows, cellL = Math.abs(ax[0]) > 0.5 ? cw : ch;
        const lat = sg.width * 0.43, step = 2.2 * u;
        const nAlong = Math.floor((L + cellL) / step);
        for (let i = 0; i < nAlong; i++) {
            const t = -cellL * 0.5 + (i + 0.5) * step;
            for (const side of [1, -1]) {
                if (H(i, side + 3, 0x5a90) > 0.62) continue;
                const x = sg.spine[0][0] + ax[0] * t + pp[0] * lat * side, z = sg.spine[0][1] + ax[1] * t + pp[1] * lat * side;
                if (wet(x, z)) continue;
                const a = (0.35 + H(i, side, 0x5a91) * 0.3) * side;
                const xd: V2 = [ax[0] * Math.cos(a) - pp[0] * side * Math.sin(a), ax[1] * Math.cos(a) - pp[1] * side * Math.sin(a)];
                addFlag(x, z, xd, (H(i >> 1, side, 0x5a92) * NOBORI_COLORS.length) | 0);
            }
        }
    }

    // ── NOREN over small-shop doors (lot meta) ───────────────────────────────────────────────────────────
    const noren = NOREN_COLORS.map(() => new Accum3D()), mark = new Accum3D(), rod = new Accum3D();
    const { regionByBlock } = graphLookups(graph);
    for (const lot of graph.lots) {
        if (lot.slot !== 'building' || lot.zone === 'residential') continue;
        const m = lotMeta(lot);
        if (!m || !m.detailed || !m.shopfront || m.ownNoren || !m.door || !m.archetype || !NOREN_ARCH.has(m.archetype)) continue;
        if (!m.doorW || !m.doorH || m.doorY == null) continue;
        if (keep && !keep(regionByBlock.get(lot.block) ?? -1)) continue;
        const hN = H(Math.round(lot.center[0] * 1000), Math.round(lot.center[1] * 1000), 0x0e01);
        if (hN > 0.6) continue;
        addNoren(noren[(hN * 7 * NOREN_COLORS.length | 0) % NOREN_COLORS.length], mark, rod, m.door, m.doorOut, m.doorW, m.doorY + m.doorH, u, hN);
    }

    // ── BIKES parked against the wall ────────────────────────────────────────────────────────────────
    const bikeFrames = shared?.bikeFrames ?? BIKES.map(() => new Accum3D()), bikeTyre = shared?.bikeTyre ?? new Accum3D();
    for (const sl of plan.of('bikewall')) {
        if (!use(sl) || p.bicycles === false) continue;
        const R = plan.roads[sl.ri]!, n = Math.max(1, sl.n), pitch = 1.75 * u;
        for (let k = 0; k < n; k++) {
            const al = sl.along + (k - (n - 1) / 2) * pitch;
            const [x, z] = plan.at(sl.ri, sl.side, al, sl.off);
            if (wet(x, z)) continue;
            const hb = H(sl.ri, Math.round(al * 1000), 0xb1a1);
            const ang = (hb - 0.5) * 0.16, fs = hb < 0.5 ? 1 : -1;   // parallel to the wall, a few degrees off, either way round
            const ca = Math.cos(ang), sa = Math.sin(ang);
            const f: V2 = [(R.d[0] * ca - R.d[1] * sa) * fs, (R.d[1] * ca + R.d[0] * sa) * fs];
            emitBicycle(bikeFrames[(hb * 997 | 0) % BIKES.length], bikeTyre, { o: [x, py, z], f, u }, { basket: hb < 0.7 });
        }
    }

    const out: LayoutPreviewLayer[] = [];
    if (flagInst.length) {
        const geo = noboriGeometry();
        // ★ Each layer gets its OWN copy of the transforms (the drape pass mutates instance arrays in place).
        // ★ An ArrayGroup shares ONE material across its copies (per-instance tint is ignored there), so the flag and
        // its lettering split into one instanced layer PER COLOUR (the palette is small: 7 flag + 3 lettering draws before chunking).
        const copy = (list: InstanceXform[]): InstanceXform[] => list.map(t => ({ x: t.x, y: t.y, z: t.z, ry: t.ry, s: t.s }));
        const lay = (name: string, g: MeshGeometry, color: C3, inst: InstanceXform[], extra: Partial<LayoutPreviewLayer>): void => {
            if (inst.length) out.push({ name, color, y: gy, geometry: g, instances: inst, arrayGroup: true, drape: 'baked', instanceKey: 'nobori:' + name.split('-')[2], ...extra });
        };
        const key = (c: C3): string => c.join(',');
        const byFlag = new Map<string, InstanceXform[]>(), byText = new Map<string, InstanceXform[]>();
        for (const t of flagInst) {
            const c = NOBORI_COLORS.find(e => key(e.flag) === key(t.tint!))!;
            (byFlag.get(key(c.flag)) ?? byFlag.set(key(c.flag), []).get(key(c.flag))!).push(t);
            (byText.get(key(c.text)) ?? byText.set(key(c.text), []).get(key(c.text))!).push(t);
        }
        for (const [k, list] of byFlag) lay('world:frontage-nobori-flag', geo.flag, k.split(',').map(Number) as C3, copy(list), { wind: NOBORI_WIND });
        for (const [k, list] of byText) lay('world:frontage-nobori-text', geo.text, k.split(',').map(Number) as C3, copy(list), { wind: NOBORI_WIND });
        lay('world:frontage-nobori-pole', geo.pole, POLE, copy(flagInst), { wind: NOBORI_WIND });
        lay('world:frontage-nobori-base', geo.base, BASE, copy(flagInst), { metal: { tint: BASE, roughness: 0.6, streakAmount: 0, grime: 0.35, scale: metalScale } });
    }
    noren.forEach((acc, i) => { if (!acc.empty) out.push({ name: 'world:noren-door-' + NOREN_NAMES[i], color: NOREN_COLORS[i], y: gy, geometry: acc.geometry(), drape: 'baked' }); });
    if (!mark.empty) out.push({ name: 'world:noren-door-mark', color: NOREN_MARK, y: gy, geometry: mark.geometry(), drape: 'baked' });
    if (!rod.empty) out.push({ name: 'world:noren-door-rod', color: [0.28, 0.22, 0.16], y: gy, geometry: rod.geometry(), drape: 'baked' });
    if (!shared) bikeFrames.forEach((acc, i) => {
        if (acc.empty) return;
        const c = BIKES[i];
        out.push({ name: `world:bicycle-lean-${i}`, color: c, y: gy, geometry: acc.geometry(),
            metal: { tint: c, streak: [c[0] * 0.6, c[1] * 0.6, c[2] * 0.62], roughness: 0.30, streakAmount: 0.30, grime: 0.20, scale: metalScale * 2.0 } });
    });
    if (!shared && !bikeTyre.empty) out.push({ name: 'world:bicycle-lean-tyre', color: [0.07, 0.07, 0.08], y: gy, geometry: bikeTyre.geometry(), metal: { tint: [0.07, 0.07, 0.08], roughness: 0.7, streakAmount: 0, grime: 0.3, scale: metalScale } });
    return out;
}

/** The canonical NOBORI (metres, pole foot at the origin, the flag hanging off the pole along +X). Four parts, one
 *  per material: the flag cloth (a gentle 3-strip ripple so it reads as fabric), the lettering (a column of glyph
 *  blocks + the pole-side loop band, on both faces), the pole + top yard, and the weighted base. ~130 tris total. */
export function noboriGeometry(): { flag: MeshGeometry; text: MeshGeometry; pole: MeshGeometry; base: MeshGeometry } {
    const M = NOBORI_M, flag = new Accum3D(), text = new Accum3D(), pole = new Accum3D(), base = new Accum3D();
    const x0 = 0.035, x1 = x0 + M.flagW, y0 = M.flagBot, y1 = M.flagTop;
    const rip = (x: number): number => Math.sin((x - x0) / M.flagW * Math.PI * 1.6) * 0.03;   // cloth ripple (z offset)
    const strips = 3;
    for (let i = 0; i < strips; i++) {
        const a = x0 + (x1 - x0) * i / strips, b = x0 + (x1 - x0) * (i + 1) / strips;
        flag.quad4([a, y0, rip(a)], [b, y0, rip(b)], [b, y1, rip(b)], [a, y1, rip(a)]);
    }
    // Lettering: 4-5 glyph blocks down the middle + a narrow loop band on the pole side, a hair off each face.
    // ★ Each block is split at the cloth's STRIP seams so it follows the same piecewise-flat ripple as the flag. One
    //   chord quad per block (xa → xb) cut straight through the cloth's kinks — the 3 cm ripple dwarfs the 8 mm offset,
    //   so the middle blocks clipped through the flag ("squares glitching through the middle", 2026-10-04).
    const seams: number[] = [];
    for (let i = 1; i < strips; i++) seams.push(x0 + (x1 - x0) * i / strips);
    const glyph = (xa: number, xb: number, ya: number, yb: number): void => {
        const xs = [xa, ...seams.filter(x => x > xa + 1e-6 && x < xb - 1e-6), xb];
        for (const side of [1, -1]) {
            for (let j = 0; j + 1 < xs.length; j++) {
                const pa = xs[j], pb = xs[j + 1], za = rip(pa) + side * 0.008, zb = rip(pb) + side * 0.008;
                text.quad4([pa, ya, za], [pb, ya, zb], [pb, yb, zb], [pa, yb, za]);
            }
        }
    };
    const gx0 = x0 + M.flagW * 0.3, gx1 = x0 + M.flagW * 0.74, gh = 0.2, gap = 0.07;
    for (let k = 0, y = y1 - 0.14; k < 5 && y - gh > y0 + 0.12; k++, y -= gh + gap) glyph(gx0, gx1, y - gh, y);
    glyph(x0, x0 + 0.045, y0, y1);                                    // the loop band (chichi) sewn to the pole
    glyph(x0, x1, y1 - 0.06, y1);                                     // the top hem under the yard
    // Pole (6-sided, slight taper) + the horizontal yard the flag hangs from + a cap.
    pole.lathe([0, 0.12, 0], [0, 1, 0], [[0.019, 0], [0.016, M.poleH - 0.12], [0.0, M.poleH - 0.1]], 6, { caps: [false, false] });
    pole.beam([0, y1 + 0.02, 0], [x1 + 0.01, y1 + 0.02, 0], 0.009, 4);
    // Weighted base: a squat water-tank drum with a stepped lid and a socket collar.
    base.lathe([0, 0, 0], [0, 1, 0], [[0.24, 0], [0.24, 0.07], [0.2, 0.12], [0.07, 0.14], [0.045, 0.3], [0, 0.3]], 8, { caps: [true, false] });
    return { flag: flag.geometry(), text: text.geometry(), pole: pole.geometry(), base: base.geometry() };
}

/** A han-noren (half-length shop curtain) over a door: 2-3 panels split by slits, hung from a rod just proud of the
 *  door head, with a pale crest on the middle panel. `door` / `out` / `w` / `topY` in city units (absolute Y). */
function addNoren(cloth: Accum3D, mark: Accum3D, rod: Accum3D, door: V2, out: V2, w: number, topY: number, u: number, h: number): void {
    const eD: V3 = [-out[1], 0, out[0]], oW: V3 = [out[0], 0, out[1]], up: V3 = [0, 1, 0];
    const W = Math.max(0.9 * u, Math.min(w * 1.08, 1.8 * u)), hang = (0.5 + h * 0.25) * u;
    const off = 0.09 * u, yTop = topY + 0.05 * u;
    const cx = door[0] + out[0] * off, cz = door[1] + out[1] * off;
    const panels = W > 1.25 * u ? 3 : 2, slit = 0.025 * u, pw = (W - slit * (panels - 1)) / panels;
    rod.beam([cx - eD[0] * (W * 0.5 + 0.05 * u), yTop + 0.02 * u, cz - eD[2] * (W * 0.5 + 0.05 * u)], [cx + eD[0] * (W * 0.5 + 0.05 * u), yTop + 0.02 * u, cz + eD[2] * (W * 0.5 + 0.05 * u)], 0.015 * u, 4);
    for (let i = 0; i < panels; i++) {
        const t = -W * 0.5 + pw * 0.5 + i * (pw + slit);
        const px = cx + eD[0] * t, pz = cz + eD[2] * t;
        // A thin box (cloth + a little thickness so it catches light edge-on), a touch of lean outward at the hem.
        cloth.obox([px + oW[0] * 0.01 * u, yTop - hang * 0.5, pz + oW[2] * 0.01 * u], eD, up, oW, pw * 0.5, hang * 0.5, 0.008 * u);
    }
    // Crest: a pale square on the centre of the curtain, proud of both faces.
    const cr = Math.min(0.13 * u, hang * 0.28);
    mark.obox([cx + oW[0] * 0.01 * u, yTop - hang * 0.42, cz + oW[2] * 0.01 * u], eD, up, oW, cr, cr, 0.012 * u);
}
