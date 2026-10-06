/**
 * Visual-only meshes are never Play collision (rise bug 2026-10-04, docs/ui/play-mode.md "Rising forever").
 *
 * The city's moving contact-shadow blobs (world-mover-shadows.ts) are ONE transparent radialFade mesh that also holds
 * a blob under the Play player, rewritten to the feet every frame. It was in the collision snapshot, so the ground ray
 * (cast down from feet + stepHeight) hit the player's own blob a few mm above the street, the controller stepped up
 * onto it, the blob followed the feet up, and the player rose forever (until something overhead — the rail viaduct —
 * stopped it). It looked random because the picker caches a mesh BVH by reference to the live vertex array: the blob
 * was only hittable while the cached tree happened to cover the current feet (rebuilt while the blob sat under the
 * player — a Play entry whose BVH build was deferred by the per-frame budget, a traffic respawn, an eviction).
 *
 * Visual-only = `noCollide` set on the mesh (decals, the blob meshes) OR a radialFade material: every radialFade
 * surface is a soft overlay drawn on / above real geometry (contact blobs, lamp / headlight / shop light pools, sky
 * and cloud cards, the packaging floor shadow) — never something to stand on or bump into.
 */

export interface CollisionFilterMesh {
    noCollide?: boolean;
    material?: { radialFade?: boolean } | null;
}

/** Is `m` a visual-only overlay (never ground, wall or camera obstacle in Play)? */
export function isVisualOnlyMesh(m: CollisionFilterMesh): boolean {
    return m.noCollide === true || m.material?.radialFade === true;
}
