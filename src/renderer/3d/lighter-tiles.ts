// ── P20 lighter tiles: renderer-side A/B switches (performance-plan §P20; sm.world.setLighterTiles / salsaWorld.p20) ──
//  cheapCompaction  — the GPU pool compaction's bookkeeping re-points the meshes of moved keys at their new allocs and
//                     drops only what died, instead of clearing and rebuilding every per-mesh map of the scene
//                     (Renderer3D._compactBookkeepingP20; the same end state)
export const P20_RENDER = { cheapCompaction: true };
