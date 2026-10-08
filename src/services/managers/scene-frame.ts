/**
 * scene-frame.ts — pure helpers behind `frameScene3D` (T7.2, the "return to the scene" button).
 *
 * `sceneFrameBounds` unions the world AABBs of the meshes that should drive framing: VISIBLE, not `frameExclude`
 * (sky stars / moon, void grid, apron, border glow — far decoration that would shrink the scene to a dot) and with
 * finite bounds. `framePose` places a perspective / ortho camera to fit a box, keeping the current view DIRECTION
 * (so the button returns you to the scene from where you were looking) but lifting a below-horizon / grazing
 * direction to a readable 3/4 angle.
 */

export interface Box3 { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }

/** The minimal mesh surface the bounds pass needs (Mesh3D satisfies it). */
export interface FrameCandidate { frameExclude?: boolean; isEffectivelyVisible(): boolean }

/** Union of the candidates' world AABBs (via `aabbOf`, e.g. the renderer's cached `getMeshWorldAABB3D`), skipping
 *  hidden + `frameExclude` meshes and non-finite boxes. Null when nothing qualifies. */
export function sceneFrameBounds<M extends FrameCandidate>(meshes: Iterable<M>, aabbOf: (m: M) => Box3 | null): Box3 | null {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const m of meshes) {
        if (m.frameExclude || !m.isEffectivelyVisible()) continue;
        const b = aabbOf(m);
        if (!b || !Number.isFinite(b.minX) || !Number.isFinite(b.maxX) || !Number.isFinite(b.minY) || !Number.isFinite(b.maxY)
            || !Number.isFinite(b.minZ) || !Number.isFinite(b.maxZ)) continue;
        if (b.minX < minX) minX = b.minX; if (b.minY < minY) minY = b.minY; if (b.minZ < minZ) minZ = b.minZ;
        if (b.maxX > maxX) maxX = b.maxX; if (b.maxY > maxY) maxY = b.maxY; if (b.maxZ > maxZ) maxZ = b.maxZ;
    }
    return Number.isFinite(minX) ? { minX, minY, minZ, maxX, maxY, maxZ } : null;
}

export interface FramePose {
    target: [number, number, number];
    position: [number, number, number];
    /** Bounding-sphere radius of the box (feeds the camera's autoFar sceneRadius). */
    radius: number;
    /** Ortho half-height to use (ortho only; perspective leaves orthoSize alone). */
    orthoSize: number | null;
}

/** Fit `b` in view. `dir` = the current camera→position direction from the target (any length; zero → default).
 *  Directions under `minElevation` (below the horizon / grazing) are lifted to `liftTo` radians of elevation. */
export function framePose(b: Box3, dir: [number, number, number], opts: {
    mode: 'perspective' | 'orthographic'; fov: number; aspect: number; padding?: number; minElevation?: number; liftTo?: number;
    /** The view's ROLL (radians, OrbitController.roll): the box is fitted on the rolled screen. Default 0. */
    roll?: number;
}): FramePose {
    const pad = opts.padding ?? 1.3;
    const cx = (b.minX + b.maxX) * 0.5, cy = (b.minY + b.maxY) * 0.5, cz = (b.minZ + b.maxZ) * 0.5;
    const dx = b.maxX - b.minX, dy = b.maxY - b.minY, dz = b.maxZ - b.minZ;
    const radius = Math.max(1e-3, Math.hypot(dx, dy, dz) * 0.5);

    let [ux, uy, uz] = dir;
    let len = Math.hypot(ux, uy, uz);
    if (len < 1e-6) { ux = 0; uy = 0.4; uz = 1; len = Math.hypot(ux, uy, uz); }
    ux /= len; uy /= len; uz /= len;
    const minEl = opts.minElevation ?? 0.12;
    if (Math.asin(Math.max(-1, Math.min(1, uy))) < minEl) {
        // Keep the heading (azimuth), lift the elevation to a readable 3/4 view.
        const el = opts.liftTo ?? 0.5;
        let hx = ux, hz = uz;
        const h = Math.hypot(hx, hz);
        if (h < 1e-6) { hx = 0; hz = 1; } else { hx /= h; hz /= h; }
        ux = hx * Math.cos(el); uy = Math.sin(el); uz = hz * Math.cos(el);
    }

    let dist: number, orthoSize: number | null = null;
    if (opts.mode === 'perspective') {
        // TIGHT box fit (a bounding-sphere fit leaves a flat city at half the screen): for each of the 8 corners, in
        // the camera basis for this view direction, the distance at which it sits exactly on the (padded) frustum
        // edge — d ≥ |x| / tanH + along, d ≥ |y| / tanV + along — and take the max.
        const tanV = Math.tan(Math.max(0.05, opts.fov * 0.5)) / pad;
        const tanH = tanV * Math.max(1e-3, opts.aspect);
        // forward f = −u; right = f × worldUp; up = right × f (degenerate straight-down view → right = +X).
        let rx = -uz, rz = ux; const rl = Math.hypot(rx, rz);
        if (rl < 1e-6) { rx = 1; rz = 0; } else { rx /= rl; rz /= rl; }
        const upx = -(rz * uy), upy = rz * ux - rx * uz, upz = rx * uy;   // right × (−u)
        const rc = Math.cos(opts.roll ?? 0), rs = Math.sin(opts.roll ?? 0);   // rolled screen: x' = x·c − y·s, y' = y·c + x·s
        dist = radius * 0.5;
        for (let c = 0; c < 8; c++) {
            const ox = (c & 1 ? b.maxX : b.minX) - cx, oy = (c & 2 ? b.maxY : b.minY) - cy, oz = (c & 4 ? b.maxZ : b.minZ) - cz;
            const along = ox * ux + oy * uy + oz * uz;        // toward the camera
            const x0 = ox * rx + oz * rz, y0 = ox * upx + oy * upy + oz * upz;
            const x = x0 * rc - y0 * rs, y = y0 * rc + x0 * rs;
            dist = Math.max(dist, Math.abs(x) / tanH + along, Math.abs(y) / tanV + along);
        }
    } else {
        // The bounding sphere fits whatever the view orientation (ortho half-height; widen for a portrait aspect).
        orthoSize = radius * pad * Math.max(1, 1 / Math.max(1e-3, opts.aspect));
        dist = Math.max(radius * 2, 2);
    }
    return { target: [cx, cy, cz], position: [cx + ux * dist, cy + uy * dist, cz + uz * dist], radius, orthoSize };
}
