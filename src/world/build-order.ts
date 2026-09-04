// Single source of truth for the world build phase order (audit B2).
//
// Four hand-synced copies used to encode this sequence in prose lockstep — WorldManager.BUILD_ORDER, the async
// regen queue, centre-build's CENTRE_BUILD_ORDER, and tile-build's TILE_BUILD_ORDER. That guard already failed
// once: a streamed tile dropped 'World Road Signs', so neighbour tiles silently lacked regulatory sign poles +
// warning GARP. Now every list derives from the constants here.
//
// This module is PURE (no imports) so the worker-safe builders (centre-build, tile-build) and the test suite can
// import it without dragging in the services / WebGPU layer.

/** The layout + terrain frame groups built FIRST. The centre city and the async full regen build these; neighbour
 *  tiles skip them (they inherit the world's shared frame). */
export const LAYOUT_GROUPS: readonly string[] = [
    'World Layout', 'World Water', 'World Terraces', 'World Road Paint', 'World Apron', 'World Void Grid',
    'World Border Glow',
];

/** The post-layout dressing sequence — walked by generateWorld, every neighbour tile, and the async regen.
 *  'World Sky' yields nothing per-tile (one shared sky for the world, not per tile). Order is load-bearing:
 *  e.g. 'World Road Signs' sits between 'World Signals' and 'World Signage'. */
export const DRESSING_ORDER: readonly string[] = [
    'World Biome', 'World Streets', 'World Landmarks', 'World Shotengai', 'World Signals',
    'World Road Signs', 'World Signage', 'World Awnings', 'World Furniture', 'World Railway', 'World Skyway',
    'World Sky', 'World Pedestrians',
];

/** The full centre / async-regen order: the layout frame THEN the dressing sequence. */
export const FULL_BUILD_ORDER: readonly string[] = [...LAYOUT_GROUPS, ...DRESSING_ORDER];
