/**
 * P16 lodStampMemo (performance-plan.md §P16): the LOD stamp with its tier lookups memoised by name stamps exactly what
 * the per-node regex scans stamp (draw distance, bias, shadow feature, fog class + no-fade, twin distances), over
 * random trees, repeated stamps, a fresh tier list (thresholds moved) and the city's own tier lists.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { assignDrawDistances, type DistanceTier, type FogClassify } from './view-cull';
import { STREAM_HITCH, streamHitchStats } from '../../renderer/3d/stream-hitch';
import { WorldManager } from './world-manager';

type N = { name: string; children?: N[]; drawDistance?: number; drawDistanceBias?: number; shadowFeatureSize?: number; lodTwinRole?: number; lodTwinDist?: number; lodTwinDist2?: number; fogClass?: number; fogNoFade?: boolean; materialDirty?: boolean };

function rng(seed: number): () => number { let x = seed; return () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; }; }
const NAMES = ['World Streets', 'World Furniture', 'world:lamp-3', 'world:ped-12', 'world:tree-crown', 'World Signals', 'road paint', 'gutter', 'storefront 4',
    'World Tile 3_1 World Pedestrians', 'chip', 'roof vent', 'bench', 'World Layout', 'can', 'World Roof Objects', 'unknown thing'];

function tree(r: () => number, depth = 0): N {
    const n: N = { name: NAMES[Math.floor(r() * NAMES.length)] + (r() < 0.3 ? ' ' + Math.floor(r() * 5) : '') };
    if (depth < 3 && r() < 0.7) n.children = Array.from({ length: 1 + Math.floor(r() * 6) }, () => tree(r, depth + 1));
    else { n.drawDistance = 0; n.drawDistanceBias = 1; n.shadowFeatureSize = 0; n.fogClass = 0; n.fogNoFade = false; n.materialDirty = false; if (r() < 0.3) { n.lodTwinRole = 1 + Math.floor(r() * 4); n.lodTwinDist = 5; n.lodTwinDist2 = 9; } }
    return n;
}
const clone = (n: N): N => JSON.parse(JSON.stringify(n)) as N;

const was = STREAM_HITCH.lodStampMemo;
afterEach(() => { STREAM_HITCH.lodStampMemo = was; });

describe('P16 LOD stamp memo', () => {
    it('stamps exactly what the regex scans stamp (custom tiers, fog extras, twins)', () => {
        const tiers: DistanceTier[] = [
            [/^World Furniture|bench/, 30, 0.5, 0.2], [/world:ped-/, 12, 1, 0.1], [/lamp/, 60], [/chip/, 8, 0, 0, 'twin'], [/chip|can/, 14, 0, 0, 'twin2'],
            [/world:tree-/, 25, 0, 0, 'twin'], [/roof/, 40, 0.25],
        ] as unknown as DistanceTier[];
        const fog: FogClassify = { tiers, extras: [[/paint|gutter/, 'overlay'], [/storefront/, 'attachment'], [/Signals/, 'other']] as unknown as FogClassify['extras'] };
        const r = rng(4);
        for (let k = 0; k < 20; k++) {
            const t = tree(r), a = clone(t), b = clone(t);
            STREAM_HITCH.lodStampMemo = false; assignDrawDistances([a], tiers, fog);
            STREAM_HITCH.lodStampMemo = true; assignDrawDistances([b], tiers, fog); assignDrawDistances([b], tiers, fog);   // twice: memo hits
            expect(b).toEqual(a);
        }
        expect(streamHitchStats.memoHits).toBeGreaterThan(0);
    });
    it('the city tier lists: memo on = memo off, also after the thresholds move (a fresh list)', () => {
        const r = rng(9);
        for (const far of [60, 140]) {
            const tiers = WorldManager.cityDistanceTiers(far, 1.3), fog = WorldManager.fogClassify();
            const t = { name: 'root', children: Array.from({ length: 12 }, () => tree(r)) };
            const a = clone(t), b = clone(t);
            STREAM_HITCH.lodStampMemo = false; assignDrawDistances([a], tiers, fog);
            STREAM_HITCH.lodStampMemo = true; assignDrawDistances([b], tiers, fog);
            expect(b).toEqual(a);
        }
    });
    it('a list with a stateful (global) regex is never memoised', () => {
        const tiers = [[/lamp/g, 60]] as unknown as DistanceTier[];
        const t: N = { name: 'r', children: [{ name: 'world:lamp-1', drawDistance: 0 }, { name: 'world:lamp-1', drawDistance: 0 }, { name: 'world:lamp-1', drawDistance: 0 }] };
        const a = clone(t), b = clone(t);
        STREAM_HITCH.lodStampMemo = false; assignDrawDistances([a], tiers);
        STREAM_HITCH.lodStampMemo = true; assignDrawDistances([b], tiers);
        expect(b).toEqual(a);
    });
});
