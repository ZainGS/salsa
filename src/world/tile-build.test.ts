import { describe, it, expect } from 'vitest';
import { buildTileLayerGroups, type TileLayerGroup } from './tile-build';
import { generateCityLayout } from './layout';
import { tileParams, tileSeed } from './tiled';
import { drapeTileLayers } from './drape';
import { buildLayoutPreview } from './preview';
import { offsetGraphGeometry } from './tiled';
import { railwayLine } from './rail-layout';
import { contactFootprints, cityContactShadowOptions, isContactDone } from './contact-shadows';
import type { LayoutParams, LayoutPreviewLayer } from './types';

// performance-plan P10 — streamed-tile content + the cheap tiers.
const P: LayoutParams = generateCityLayout({ seed: 3, pattern: 'grid', border: 'square', radius: 10, gridCols: 11, gridRows: 11, worldMode: 'tiled', tileRadius: 1, tileDetail: 'full' }).params;
const R = P.radius;

/** World-XZ centre of a layer: its instances' mean, or its vertex box centre. */
function centreOf(L: LayoutPreviewLayer): [number, number] | null {
    const inst = (L as { instances?: { x: number; z: number }[] }).instances;
    if (inst?.length) { let x = 0, z = 0; for (const t of inst) { x += t.x; z += t.z; } return [x / inst.length, z / inst.length]; }
    const v = L.geometry?.vertices;
    if (!v || !v.length) return null;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < v.length; i += 12) { x0 = Math.min(x0, v[i]); x1 = Math.max(x1, v[i]); z0 = Math.min(z0, v[i + 2]); z1 = Math.max(z1, v[i + 2]); }
    return [(x0 + x1) / 2, (z0 + z1) / 2];
}
const layersOf = (groups: TileLayerGroup[], re: RegExp): LayoutPreviewLayer[] => groups.filter(g => re.test(g.name)).flatMap(g => g.layers);

describe('streamed tile content (P10.A1 / A2)', () => {
    const TX = 1, TZ = 0, CX = TX * 2 * R, CZ = TZ * 2 * R;
    const opts = { contact: { opacity: 0.55 } };
    const fixed = buildTileLayerGroups(P, TX, TZ, true, opts);

    it('every railway / landmark / skyway layer of a full tile lies on ITS tile (not on the centre city)', () => {
        const ls = layersOf(fixed, /World (Railway|Landmarks|Skyway)$/);
        expect(ls.filter(L => /rail-deck/.test(L.name)).length).toBeGreaterThan(0);   // the tile has a viaduct
        for (const L of ls) {
            const c = centreOf(L); if (!c) continue;
            expect(Math.abs(c[0] - CX), L.name).toBeLessThanOrEqual(R * 1.1);
            expect(Math.abs(c[1] - CZ), L.name).toBeLessThanOrEqual(R * 1.1);
        }
    }, 120_000);

    it('legacy build (tileFrame: false) put the viaduct on the centre city — the bug this fixes', () => {
        const legacy = buildTileLayerGroups(P, TX, TZ, true, { tileFrame: false });
        const deck = layersOf(legacy, /World Railway$/).filter(L => /rail-deck$/.test(L.name)).map(centreOf).filter(Boolean) as [number, number][];
        expect(deck.length).toBeGreaterThan(0);
        expect(deck.some(c => Math.abs(c[0]) < R && Math.abs(c[1]) < R)).toBe(true);
    }, 120_000);

    it('a tile railway line is the local line moved to the tile origin', () => {
        const flat = { ...P, warp: 0 };
        const a = railwayLine(flat), b = railwayLine({ ...flat, tileOrigin: [40, -20] });
        expect(b.rx - a.rx).toBeCloseTo(40, 9);
        expect(b.z0 - a.z0).toBeCloseTo(-20, 9);
        expect(b.z1 - a.z1).toBeCloseTo(-20, 9);
        expect(b.path.length).toBe(a.path.length);
        for (let i = 0; i < a.path.length; i++) { expect(b.path[i][0] - a.path[i][0]).toBeCloseTo(40, 9); expect(b.path[i][1] - a.path[i][1]).toBeCloseTo(-20, 9); }
    });

    it('tile seeds never collide (the legacy hash mirrored (1,1) ≡ (−1,−1) and (1,−1) ≡ (−1,1))', () => {
        const seen = new Map<number, string>(), legacy = new Map<number, string>();
        let legacyHits = 0;
        const ctz = (v: number): number => 31 - Math.clz32(v & -v);
        for (let z = -8; z <= 8; z++) for (let x = -8; x <= 8; x++) {
            const s = tileSeed(P.seed, x, z), l = tileSeed(P.seed, x, z, false);
            expect(seen.has(s), `${x},${z} collides with ${seen.get(s)}`).toBe(false);
            seen.set(s, `${x},${z}`);
            if (legacy.has(l)) legacyHits++; else legacy.set(l, `${x},${z}`);
            if (!(x < 0 && z !== 0 && ctz(x) === ctz(z))) expect(s).toBe(l);   // every non-colliding tile keeps its legacy seed
        }
        expect(legacyHits).toBeGreaterThan(0);
        expect(tileSeed(P.seed, 1, 1, false)).toBe(tileSeed(P.seed, -1, -1, false));
        expect(tileSeed(P.seed, 2, -2, false)).toBe(tileSeed(P.seed, -2, 2, false));
    });

    it('contact blobs are built over each WHOLE group in the tile build (one blob layer per group, marked done)', () => {
        const co = cityContactShadowOptions(R, 0.55);
        // P20: the blobs are built BEFORE the prop instancing pass, over the baked props — so the expected count comes
        // from the baked build (an instanced layer's canonical geometry is not where its copies stand), and the blob
        // geometry of the instanced build must be exactly the baked build's.
        const baked = buildTileLayerGroups(P, TX, TZ, true, { ...opts, propInstancing: false });
        let blobs = 0;
        for (const g of fixed) {
            const blobLayers = g.layers.filter(L => L.name === 'world:contact-shadow');
            expect(blobLayers.length).toBeLessThanOrEqual(1);
            expect(isContactDone(g.layers)).toBe(true);
            const b = baked.find(x => x.name === g.name)!;
            const want = contactFootprints(b.layers.filter(L => L.name !== 'world:contact-shadow'), co).length;
            const got = blobLayers.length ? blobLayers[0].geometry.vertices.length / 48 : 0;   // 4 verts × 12 floats a blob
            expect(got, g.name).toBe(want);
            const bb = b.layers.find(L => L.name === 'world:contact-shadow');
            if (blobLayers.length) expect(Array.from(blobLayers[0].geometry.vertices), g.name).toEqual(Array.from(bb!.geometry.vertices));
            blobs += got;
        }
        expect(blobs).toBeGreaterThan(0);
    }, 120_000);
});

describe('cheap tiers (P10.B3 / C1)', () => {
    it('MASSING: flat map + one box per building lot, inside the tile, a few draws', () => {
        const tx = 2, tz = -1;
        const groups = buildTileLayerGroups(P, tx, tz, false, { massing: true });
        const m = groups.find(g => g.name === `World Tile ${tx}_${tz} Massing`);
        expect(m).toBeTruthy();
        expect(m!.layers.every(L => /^world:(bldg-(residential|commercial|civic)-\d|roofs)$/.test(L.name))).toBe(true);
        expect(m!.layers.length).toBeLessThanOrEqual(10);
        const g = generateCityLayout(tileParams(P, tileSeed(P.seed, tx, tz)), { layoutOnly: true });
        const lots = g.lots.filter(l => l.slot === 'building' && l.poly.length >= 3 && /residential|commercial|civic/.test(l.zone));
        const wallTris = m!.layers.filter(L => L.name !== 'world:roofs').reduce((a, L) => a + L.geometry.indices.length / 3, 0);
        expect(wallTris).toBe(lots.reduce((a, l) => a + 2 * l.poly.length, 0));
        for (const L of m!.layers) {
            const v = L.geometry.vertices;
            for (let i = 0; i < v.length; i += 12) {
                expect(Math.abs(v[i] - tx * 2 * R)).toBeLessThanOrEqual(R * 1.05);
                expect(Math.abs(v[i + 2] - tz * 2 * R)).toBeLessThanOrEqual(R * 1.05);
            }
        }
        expect(buildTileLayerGroups(P, tx, tz, false).some(gr => /Massing$/.test(gr.name))).toBe(false);   // flat proxy: none
    });

    it('lazy kerb lift is exact; the tile-centred height core matches to float rounding', () => {
        const mk = (): { name: string; layers: LayoutPreviewLayer[] }[] => {
            const g = generateCityLayout(tileParams(P, tileSeed(P.seed, 3, 2)), { layoutOnly: true });
            offsetGraphGeometry(g, 3 * 2 * R, 2 * 2 * R);
            return [{ name: 'x', layers: buildLayoutPreview(g) }];
        };
        const g0 = generateCityLayout(tileParams(P, tileSeed(P.seed, 3, 2)), { layoutOnly: true }); offsetGraphGeometry(g0, 3 * 2 * R, 2 * 2 * R);
        const a = mk(), b = mk(), c = mk();
        drapeTileLayers(a, P, 3, 2, g0, false, false);
        drapeTileLayers(b, P, 3, 2, g0, true, false);
        drapeTileLayers(c, P, 3, 2, g0, true, true);
        let maxD = 0;
        a[0].layers.forEach((L, k) => {
            expect(Array.from(b[0].layers[k].geometry.vertices)).toEqual(Array.from(L.geometry.vertices));   // lazy: bit-identical
            const va = L.geometry.vertices, vc = c[0].layers[k].geometry.vertices;
            expect(vc.length).toBe(va.length);
            for (let i = 0; i < va.length; i += 12) maxD = Math.max(maxD, Math.abs(va[i + 1] - vc[i + 1]), Math.abs(va[i] - vc[i]), Math.abs(va[i + 2] - vc[i + 2]));
        });
        expect(maxD).toBeLessThan(1e-4 * R);
    });
});
