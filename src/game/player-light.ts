/**
 * PLAYER LIGHT (visual-polish #7c) — the small key light that rides with the Play player so the character stays
 * readable at night (Persona keeps its lead lit and rimmed whatever the street does).
 *
 * One unshadowed point light, pinned ahead of the street-lamp candidates in the renderer's 16-light budget
 * (Renderer3D.setPinnedPointLights). It sits on the CAMERA side of the player, above the shoulder and a little to
 * the left, so it lights the side of the character the camera sees; its reach is about one and a half body heights,
 * which keeps the pavement under the feet nearly untouched (the falloff is (1 - d / r) squared). Pure math here; the
 * Play loop (Scene3DManager) feeds the feet, the camera eye and the body height every render frame.
 */

export interface PlayerLightConfig {
    /** Light strength (WorldManager passes playerLight × the night ramp). 0 = off. */
    strength: number;
    /** Light colour (0..1 rgb). */
    color: [number, number, number];
}

export interface PlayerLightPlacement {
    pos: [number, number, number];
    radius: number;
    color: [number, number, number];
    intensity: number;
}

/** Where the light goes this frame. `height` = the body height (world units), `eye` = the camera position. */
export function placePlayerLight(feet: ArrayLike<number>, eye: ArrayLike<number>, height: number, cfg: PlayerLightConfig): PlayerLightPlacement | null {
    if (!(cfg.strength > 0) || !(height > 0) || !Number.isFinite(height)) return null;
    const H = height;
    const px = feet[0], py = feet[1] + H * 0.62, pz = feet[2];   // the chest
    let dx = eye[0] - px, dz = eye[2] - pz;
    const l = Math.hypot(dx, dz);
    if (l > 1e-6) { dx /= l; dz /= l; } else { dx = 0; dz = 1; }
    // camera-side, up, and a touch to the camera's LEFT (the classic upper-left key)
    const sx = -dz, sz = dx;
    return {
        pos: [px + dx * H * 0.6 + sx * H * 0.3, py + H * 0.28, pz + dz * H * 0.6 + sz * H * 0.3],
        radius: H * 1.5,
        color: [cfg.color[0], cfg.color[1], cfg.color[2]],
        intensity: Math.min(2, cfg.strength) * 0.95,
    };
}
