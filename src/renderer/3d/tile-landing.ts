// ── P22 tile landing: renderer-side switches and state (performance-plan §P22; sm.world.setTileLanding / salsaWorld.p22) ──
// Plain module state (no imports), read by renderer-3d.ts and written by the world manager, like lighter-tiles.ts.

/** Renderer-side A/B switches (all on by default):
 *  · packedVertices — city / world geometry the world builds mark packable (`MeshGeometry.packable`: the constant
 *    tangent (1, 0, 0, 1), ≤ 65,536 vertices) is stored in the geometry pool as 32-byte vertices (position, normal,
 *    uv: the tangent comes from a stride-0 vertex buffer) with 16-bit indices, instead of 48-byte vertices and 32-bit
 *    indices (vertex-pack.ts). Lossless: the same floats reach the vertex shader. Takes effect on the next pool
 *    placement of a geometry (a switch flip rebuilds the pool).
 *  · propCull — instanced prop groups (P20) are culled per copy: the group draws only the copies whose box is in the
 *    view (renderer-3d `_propCullRanges`), in one or a few contiguous instance runs. */
export const P22_RENDER = { packedVertices: true, propCull: true };

/** The world manager's landing state (WorldManager.P22.landingLedger): while `active`, the per-frame write ledger
 *  (STREAM_HITCH_LIMITS.frameWriteBytes) is raised to `writeBytes` — a still camera landing a window of full tiles can
 *  take bigger frames than a fly. */
export const TILE_LANDING = { active: false, writeBytes: 16 << 20 };
