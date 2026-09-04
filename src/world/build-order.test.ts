/**
 * src/world/build-order.test.ts — build-order single-source-of-truth guard (audit §5.10 / B2).
 *
 * The four build-order lists (WorldManager.BUILD_ORDER, the async regen queue, centre-build's CENTRE_BUILD_ORDER,
 * and tile-build's TILE_BUILD_ORDER) used to stay in step only via prose — audit §1.6 proved that guard already
 * failed once (a streamed tile dropped 'World Road Signs', so it silently lacked regulatory sign poles + warning
 * GARP). They now ALL derive from the constants in build-order.ts, so drift is structurally impossible.
 *
 * This suite pins the canonical literals (so an accidental edit is a caught review moment) and verifies the
 * derived list (TILE_BUILD_ORDER) is identical to its source.
 */

import { describe, it, expect } from 'vitest';
import { LAYOUT_GROUPS, DRESSING_ORDER, FULL_BUILD_ORDER } from './build-order';
import { TILE_BUILD_ORDER } from './tile-build';

// The canonical post-layout dressing sequence — pinned so a value change is a deliberate, reviewed edit.
const CANONICAL_DRESSING = [
    'World Biome', 'World Streets', 'World Landmarks', 'World Shotengai', 'World Signals',
    'World Road Signs', 'World Signage', 'World Awnings', 'World Furniture', 'World Railway', 'World Skyway',
    'World Sky', 'World Pedestrians',
];

// The layout/terrain frame groups built first (centre + async full only).
const CANONICAL_LAYOUT = [
    'World Layout', 'World Water', 'World Terraces', 'World Road Paint', 'World Apron', 'World Void Grid',
    'World Border Glow',
];

describe('build-order single source of truth', () => {
    it('DRESSING_ORDER matches the pinned canonical sequence', () => {
        expect([...DRESSING_ORDER]).toEqual(CANONICAL_DRESSING);
    });

    it('LAYOUT_GROUPS matches the pinned canonical frame', () => {
        expect([...LAYOUT_GROUPS]).toEqual(CANONICAL_LAYOUT);
    });

    it('FULL_BUILD_ORDER is the layout frame followed by the dressing sequence', () => {
        expect([...FULL_BUILD_ORDER]).toEqual([...CANONICAL_LAYOUT, ...CANONICAL_DRESSING]);
    });

    it('TILE_BUILD_ORDER IS the shared DRESSING_ORDER (worker tiles can never drift from it)', () => {
        expect(TILE_BUILD_ORDER).toBe(DRESSING_ORDER);
    });

    it("includes 'World Road Signs' between Signals and Signage — the exact group audit §1.6 dropped", () => {
        const i = DRESSING_ORDER.indexOf('World Road Signs');
        expect(i).toBeGreaterThan(-1);
        expect(DRESSING_ORDER[i - 1]).toBe('World Signals');
        expect(DRESSING_ORDER[i + 1]).toBe('World Signage');
    });

    it('no duplicate entries in the full order', () => {
        expect(new Set(FULL_BUILD_ORDER).size).toBe(FULL_BUILD_ORDER.length);
    });
});
