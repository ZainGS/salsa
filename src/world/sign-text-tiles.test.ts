import { describe, it, expect } from 'vitest';
import { buildCentreGroups } from './centre-build';
import { buildTileLayerGroups, type TileLayerGroup } from './tile-build';
import { generateCityLayout } from './layout';
import { drapeLayerGroups } from './drape';
import { makeElevation, makeHeightField } from './elevation';
import { makeDomainWarpInto } from './warp';
import { cityTextSigns, signTextLayers, signTextByName, SIGN_TEXT_GROUP, type SignTextLayer } from './sign-text-all';
import type { LayoutPreviewLayer } from './types';

// STOP signs (2026-10-04): (a) the octagon came out LOPSIDED in game — the per-vertex 'full' drape lifted each plate
// vertex by the kerb under it (the plate straddles the kerb line) and the per-vertex warp sheared it; the signals are
// now rigid (one elevation + one warp offset at the pole foot, drape 'baked' + noWarp). (b) STREAMED tiles had no
// lettering at all (no 'World Sign Text' group), so every STOP / street-name / NO PARKING plate outside the centre was
// blank. These check the shapes AFTER the real build pipeline (builders → drape → warp), centre and tile.

type V3 = [number, number, number];
const R = 10, S = R / 10;
const CENTRE = buildCentreGroups({ seed: 7, radius: R, warp: 1 }, { parkedTrain: true, activeRegions: null, runBoxes: false });
const TP = generateCityLayout({ seed: 3, pattern: 'grid', border: 'square', radius: R, gridCols: 11, gridRows: 11, worldMode: 'tiled', tileRadius: 1, tileDetail: 'full', warp: 1 }).params;
const TILE = buildTileLayerGroups(TP, 1, 0, true, { propInstancing: false });          // the baked props (vertex for vertex)
const TILE_INST = buildTileLayerGroups(TP, 1, 0, true, {});                            // P20 instancing on (the default)

const layers = (groups: TileLayerGroup[], re: RegExp): LayoutPreviewLayer[] => groups.flatMap(g => g.layers).filter(L => re.test(L.name));

/** The 8-gon discs of a STOP layer (Accum3D.disc: a centre vertex + 8 ring vertices, 9 per disc, in emission order). */
function discs(L: LayoutPreviewLayer): { c: V3; n: V3; plan: number; spread: number; r: number }[] {
    const v = L.geometry.vertices, out: { c: V3; n: V3; plan: number; spread: number; r: number }[] = [];
    const P = (i: number): V3 => [v[i * 12], v[i * 12 + 1], v[i * 12 + 2]];
    for (let k = 0; k + 9 <= v.length / 12; k += 9) {
        const c = P(k), ring = [1, 2, 3, 4, 5, 6, 7, 8].map(i => P(k + i));
        const a = ring[4].map((x, j) => x - ring[0][j]), b = ring[6].map((x, j) => x - ring[2][j]);
        const nn: V3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        const nl = Math.hypot(...nn), n = nn.map(x => x / nl) as V3;
        let plan = 0;
        for (const p of ring) plan = Math.max(plan, Math.abs((p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1] + (p[2] - c[2]) * n[2]));
        const rs = ring.map(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
        out.push({ c, n, plan, spread: Math.max(...rs) - Math.min(...rs), r: rs.reduce((x, y) => x + y, 0) / 8 });
    }
    return out;
}

/** Centre of a signQuad's FRONT face (its first 4 vertices) + that face's normal. */
function quadFront(L: LayoutPreviewLayer): { c: V3; n: V3 } {
    const v = L.geometry.vertices, c: V3 = [0, 0, 0];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) c[j] += v[i * 12 + j] / 4;
    return { c, n: [v[3], v[4], v[5]] };
}

function checkRigid(groups: TileLayerGroup[], tag: string): number {
    let n = 0;
    for (const L of layers(groups, /^world:signal-(stop-rim|red-stop)$/)) {
        const want = L.name.endsWith('rim') ? 0.032 * S : 0.0285 * S;
        for (const d of discs(L)) {
            n++;
            expect(d.plan, `${tag} ${L.name} planar`).toBeLessThan(1e-5 * S);
            expect(d.spread, `${tag} ${L.name} regular`).toBeLessThan(1e-5 * S);   // was ~0.019 (60 % of the radius)
            expect(Math.abs(d.r - want), `${tag} ${L.name} radius`).toBeLessThan(1e-5 * S);
            expect(Math.abs(d.n[1]), `${tag} ${L.name} upright`).toBeLessThan(1e-4);
        }
    }
    return n;
}

/** Every STOP lettering quad sits ON a red face: same height + lateral position, just in front of it. */
function checkLettering(faces: LayoutPreviewLayer[], text: LayoutPreviewLayer[], tag: string): void {
    const ds = faces.flatMap(discs);
    const stops = text.filter(L => /^world:signaltext-stop/.test(L.name));
    expect(stops.length, `${tag}: one STOP lettering per octagon`).toBe(ds.length);
    for (const L of stops) {
        const q = quadFront(L);
        let best = ds[0], bd = Infinity;
        for (const d of ds) { const e = Math.hypot(d.c[0] - q.c[0], d.c[1] - q.c[1], d.c[2] - q.c[2]); if (e < bd) { bd = e; best = d; } }
        const off = [q.c[0] - best.c[0], q.c[1] - best.c[1], q.c[2] - best.c[2]];
        const along = off[0] * best.n[0] + off[1] * best.n[1] + off[2] * best.n[2];
        const lateral = Math.hypot(off[0] - along * best.n[0], off[1] - along * best.n[1], off[2] - along * best.n[2]);
        expect(lateral, `${tag} ${L.name} centred on its plate`).toBeLessThan(1e-5 * S);
        // in FRONT of the red face (the octagon faces along its normal ±; the quad's front normal says which way)
        const facing = q.n[0] * best.n[0] + q.n[2] * best.n[2] > 0 ? along : -along;
        expect(facing, `${tag} ${L.name} in front of the face`).toBeGreaterThan(0.002 * S);
        expect(facing, `${tag} ${L.name} on (not off) the plate`).toBeLessThan(0.012 * S);
    }
}

describe('STOP signs are rigid (no kerb / warp distortion)', () => {
    it('centre: every octagon (rim + face) is planar and regular after the drape + warp', () => {
        expect(checkRigid(CENTRE.groups, 'centre')).toBeGreaterThan(4);
    });
    it('tile: every octagon (rim + face) is planar and regular after the drape + warp', () => {
        expect(checkRigid(TILE, 'tile')).toBeGreaterThan(4);
    });
    it('tile with P20 instancing: what stays baked is still regular, and the rest is instanced', () => {
        checkRigid(TILE_INST, 'tile-inst');
        const all = layers(TILE_INST, /^world:signal-(stop-rim|red-stop)$/);
        expect(all.length).toBeGreaterThan(0);
    });
    it('every signal / STOP layer is drape baked + noWarp (one frame per prop)', () => {
        for (const L of layers(CENTRE.groups, /^world:signal-/)) {
            expect(L.drape, L.name).toBe('baked');
            expect(L.noWarp, L.name).toBe(true);
        }
    });
});

describe('STOP lettering lands on its octagon', () => {
    it('centre: the main-thread text layers (draped like _addStaged) sit on their red faces', () => {
        const g = CENTRE.graph;
        const text = signTextLayers(cityTextSigns(g, null));
        drapeLayerGroups([{ name: SIGN_TEXT_GROUP, layers: text }], makeElevation(g), makeHeightField(g.params), makeDomainWarpInto(g.params));
        checkLettering(layers(CENTRE.groups, /^world:signal-red-stop$/), text, 'centre');
    });
    it('tile: the tile\'s own Sign Text group sits on its red faces', () => {
        checkLettering(layers(TILE, /^world:signal-red-stop$/), layers(TILE, /^world:signaltext-/), 'tile');
    });
});

describe('streamed tiles carry their text plates', () => {
    const grp = TILE.find(g => g.name === `World Tile 1_0 ${SIGN_TEXT_GROUP}`);
    it('a full tile builds a Sign Text group with STOP, street-name and road-sign plates, each labelled', () => {
        expect(grp).toBeTruthy();
        const ls = grp!.layers as SignTextLayer[];
        expect(ls.some(L => /^world:signaltext-stop/.test(L.name))).toBe(true);
        expect(ls.some(L => /^world:signaltext-name/.test(L.name))).toBe(true);
        expect(ls.some(L => /^world:roadsign-reg/.test(L.name))).toBe(true);
        for (const L of ls) expect(L.signText?.label, L.name).toBeTruthy();
        expect(ls.filter(L => /signaltext-stop/.test(L.name)).every(L => L.signText!.label === 'STOP' && L.signText!.square)).toBe(true);
        // names are unique → the main thread can texture by name
        expect(new Set(ls.map(L => L.name)).size).toBe(ls.length);
        expect(signTextByName(ls).size).toBe(ls.length);
    });
    it('the plates carry no collision run boxes and keep the 48-byte vertex format', () => {
        for (const L of grp!.layers) {
            expect((L.geometry as { runBoxes?: unknown }).runBoxes, L.name).toBeUndefined();
            expect((L.geometry as { packable?: boolean }).packable, L.name).not.toBe(true);
        }
    });
    it('P22 split: the Sign Text group builds in half 0, byte-identical to the whole build', () => {
        const h0 = buildTileLayerGroups(TP, 1, 0, true, { propInstancing: false, half: 0 });
        const h1 = buildTileLayerGroups(TP, 1, 0, true, { propInstancing: false, half: 1 });
        const a = h0.find(g => g.name === grp!.name);
        expect(a).toBeTruthy();
        expect(h1.some(g => g.name === grp!.name)).toBe(false);
        expect(a!.layers.map(L => L.name)).toEqual(grp!.layers.map(L => L.name));
        for (let i = 0; i < a!.layers.length; i++) expect(Array.from(a!.layers[i].geometry.vertices)).toEqual(Array.from(grp!.layers[i].geometry.vertices));
    });
    it('flat / massing tiles have no plates', () => {
        expect(buildTileLayerGroups(TP, 1, 0, false, {}).some(g => g.name.endsWith(SIGN_TEXT_GROUP))).toBe(false);
    });
});
