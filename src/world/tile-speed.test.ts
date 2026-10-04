import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildTileLayerGroups, mergeTileHalves, TILE_HALF_OF, TILE_BUILD_ORDER, markPackable, type TileLayerGroup } from './tile-build';
import { generateCityLayout } from './layout';
import { TILE_SPEED_OFF } from './tile-speed';
import type { LayoutParams } from './types';

// performance-plan §P22 — faster tile builds: every speed switch and the two-worker split leave the OUTPUT unchanged,
// byte for byte (vertices, indices, bounds, instance transforms, run boxes, layer fields). The instanced crowd's
// per-build id (crowdInst.id / crowdRecords: a serial + random nonce by design) is the only field left out.
const P: LayoutParams = generateCityLayout({ seed: 3, pattern: 'grid', border: 'square', radius: 10, gridCols: 11, gridRows: 11, worldMode: 'tiled', tileRadius: 1, tileDetail: 'full' }).params;
const OPTS = { contact: { opacity: 0.55 }, runBoxes: true };

const bytes = (a: ArrayBufferView): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
/** A hash of everything a group carries (geometry once per object, layer fields as JSON, typed fields as bytes). */
function groupHash(G: TileLayerGroup): string {
    const h = createHash('sha1');
    h.update(G.name);
    const seen = new Set<object>();
    for (const L of G.layers) {
        const rec = L as unknown as Record<string, unknown>;
        for (const k of Object.keys(rec).sort()) {
            const v = rec[k];
            if (k === 'geometry' || k === 'crowdRecords') continue;
            if (k === 'crowdInst' && v && typeof v === 'object') { const { id: _id, ...rest } = v as Record<string, unknown>; void _id; h.update(k + JSON.stringify(rest)); continue; }
            if (ArrayBuffer.isView(v)) { h.update(k); h.update(bytes(v)); continue; }
            h.update(k + JSON.stringify(v));
        }
        const g = L.geometry as { vertices: Float32Array; indices: Uint32Array; bounds?: Float32Array };
        if (seen.has(g)) { h.update('shared'); continue; }
        seen.add(g);
        h.update(bytes(g.vertices)); if (g.indices) h.update(bytes(g.indices)); if (g.bounds) h.update(bytes(g.bounds));
    }
    return h.digest('hex');
}
const hashes = (gs: TileLayerGroup[]): Map<string, string> => new Map(gs.map(g => [g.name, groupHash(g)]));

describe('P22 tile build speed-ups: identical output', () => {
    it('the speed switches (node blocks, fused warp, fused drape) all on = all off, every group', () => {
        const on = hashes(buildTileLayerGroups(P, 1, 0, true, OPTS));
        const off = hashes(buildTileLayerGroups(P, 1, 0, true, { ...OPTS, speed: TILE_SPEED_OFF }));
        expect([...on.keys()]).toEqual([...off.keys()]);
        for (const [k, v] of on) expect(off.get(k), k).toBe(v);
    }, 120_000);
    it('splitTile: half 0 + half 1, merged, are the whole build — the same groups in the same order, byte for byte', () => {
        const whole = buildTileLayerGroups(P, -1, 1, true, OPTS);
        const merged = mergeTileHalves(buildTileLayerGroups(P, -1, 1, true, { ...OPTS, half: 0 }), buildTileLayerGroups(P, -1, 1, true, { ...OPTS, half: 1 }));
        expect(merged.map(g => g.name)).toEqual(whole.map(g => g.name));
        const W = hashes(whole), M = hashes(merged);
        for (const [k, v] of W) expect(M.get(k), k).toBe(v);
    }, 120_000);
    it('every tile group has a half; World Streets and its readers share one', () => {
        for (const n of ['Layout', 'Water', 'Road Paint', ...TILE_BUILD_ORDER]) expect(TILE_HALF_OF[n], n).toBeDefined();
        for (const n of ['World Signage', 'World Awnings', 'World Furniture', 'World Pedestrians']) expect(TILE_HALF_OF[n]).toBe(TILE_HALF_OF['World Streets']);
    });
    it('a full tile marks its geometry packable (indexed, ≤ 65,536 vertices); flat tiles are left alone', () => {
        const full = buildTileLayerGroups(P, 0, 1, true, OPTS);
        let yes = 0, no = 0;
        for (const G of full) for (const L of G.layers) { const g = L.geometry as { packable?: boolean; vertices: Float32Array }; if (g.packable) { yes++; expect(g.vertices.length / 12).toBeLessThanOrEqual(65536); } else no++; }
        expect(yes).toBeGreaterThan(500);
        expect(no).toBeLessThan(yes / 20);
        const flat = buildTileLayerGroups(P, 0, 1, false, OPTS);
        for (const G of flat) for (const L of G.layers) expect((L.geometry as { packable?: boolean }).packable).toBeUndefined();
        expect(markPackable(full)).toBe(0);   // idempotent: already marked
    }, 120_000);
});
