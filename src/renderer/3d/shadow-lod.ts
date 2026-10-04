// P8 SHADOW LOD (docs/specs/performance-plan.md P8): a shadow map can only resolve a caster's shadow when the
// caster's smallest feature (Mesh3D.shadowFeatureSize, world units — a pole's width, a person's footprint) covers
// at least about one of the map's texels. Smaller casters land on a texel or none, and the 5×5 PCF smears what is
// left into a few-percent smudge, so the renderer leaves them out of that map's caster list. Each map (the far map,
// each near cascade) has its own texel, so a sub-metre prop leaves the coarse far map from the air but keeps casting
// into the fine near cascades around the camera.

/** World-space texel of a square shadow map covering a box of half-extent `halfExtent` at `mapSize` texels. */
export function shadowTexel(halfExtent: number, mapSize: number): number {
    return mapSize > 0 ? (2 * halfExtent) / mapSize : 0;
}

/** The feature-size threshold of a map: casters with a feature size below it are skipped. 0 = keep everything. */
export function shadowLodThreshold(enabled: boolean, texelsPerFeature: number, texel: number): number {
    return enabled && texelsPerFeature > 0 && texel > 0 ? texelsPerFeature * texel : 0;
}

/**
 * The SCREEN guard: the feature size that spans `px` pixels at the NEAREST distance any caster can be from the camera,
 * `minDist` (the city's aerial bias: the camera's distance to the city volume — 0 at street and roof level). A map's
 * texel says what it can RESOLVE; this says what still MATTERS on screen. Both must agree before a caster leaves a map:
 * a 12 m-high view down a street renders its whole far map at ~0.4 m texels too, but the railings beside the camera
 * are big on screen there, and must keep their (coarse) shadows. Constant per frame (no per-caster distance), so the
 * skipped set — and the P4.2 cached far map — only changes with the camera's height.
 * `pxAngle` = world units per pixel per unit distance (2 tan(fov / 2) / viewport height).
 */
export function shadowLodScreenThreshold(px: number, minDist: number, pxAngle: number): number {
    return px > 0 && minDist > 0 && pxAngle > 0 ? px * minDist * pxAngle : 0;
}

/** Whether a caster with `featureSize` (0 = always casts) is too small for a map with threshold `threshold`. */
export function tooSmallForShadowMap(featureSize: number, threshold: number): boolean {
    return featureSize > 0 && featureSize < threshold;
}
