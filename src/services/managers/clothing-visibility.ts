/**
 * clothing-visibility.ts — what the VIEWER sees of a dressed, posed character (test support for the clothing fit
 * round 2, 2026-10-04). The ROM harness (clothing-audit-harness.ts) measures how deep skin pokes through a garment at
 * the vertices; this rasterises the posed body + garments from several views with a depth buffer and counts pixels.
 * Winding follows the GPU: a triangle counter-clockwise toward the viewer is its FRONT face. The body is drawn
 * single-sided (back faces culled, as the GPU draws it); garments double-sided.
 *   - measureVisibility: EXPOSED = a body triangle flagged `covered` wins the depth test (skin showing where it should
 *     be under cloth); LINING = a garment triangle seen from its inside (its back face).
 *   - measureMaskHoles: what the BODY-HIDING MASK (body-hide-mask.ts) costs — pixels where a hidden body triangle would
 *     have been the visible surface AND, with it hidden, the viewer sees nothing / the inside of the body / the inside
 *     of a garment (a see-through HOLE). A hidden triangle that pokes out through the cloth is not a hole: the cloth's
 *     own outside is right behind it, which is exactly what the mask is for (counted as `hiddenPokes`).
 */

import { TriRayGrid, type MaskGarment } from './body-hide-mask';

export interface VisMesh { P: Float32Array; indices: Uint32Array }
export interface VisView { yaw: number; pitch: number }
export interface VisResult { exposedPx: number; liningPx: number; garmentPx: number; bodyPx: number; exposedTris: Set<number> }

export const VIS_VIEWS: VisView[] = [0, 60, 120, 180, 240, 300].map((yaw) => ({ yaw, pitch: 4 }))
    .concat([{ yaw: 90, pitch: -18 }, { yaw: 270, pitch: -18 }]);

/** Body triangles under a garment at rest (outward normal ray from 3 mm under the skin meets cloth within `reach`). */
export function coveredBodyTris(bodyVerts: Float32Array, bodyIndices: Uint32Array, garments: MaskGarment[], reach = 0.15): Uint8Array {
    const grid = new TriRayGrid(garments, 0.04);
    const nb = bodyVerts.length / 12, cov = new Uint8Array(nb);
    for (let v = 0; v < nb; v++) {
        const o = v * 12, nx = bodyVerts[o + 3], ny = bodyVerts[o + 4], nz = bodyVerts[o + 5], l = Math.hypot(nx, ny, nz) || 1;
        const t = grid.raycast(bodyVerts[o] - nx / l * 0.003, bodyVerts[o + 1] - ny / l * 0.003, bodyVerts[o + 2] - nz / l * 0.003, nx / l, ny / l, nz / l, reach);
        if (t < Infinity) cov[v] = 1;
    }
    const nt = bodyIndices.length / 3, out = new Uint8Array(nt);
    for (let t = 0; t < nt; t++) out[t] = cov[bodyIndices[t * 3]] & cov[bodyIndices[t * 3 + 1]] & cov[bodyIndices[t * 3 + 2]];
    return out;
}

/** One rasterised view: per pixel the winning mesh slot (-1 = nothing), its triangle and whether it is a back face. */
interface Raster { W: number; H: number; who: Int32Array; tri: Int32Array; back: Uint8Array }

function frame(meshes: VisMesh[]): { cx: number; cy: number; cz: number; scale: number } {
    const P = meshes[0].P, n = P.length / 3;
    let y0 = Infinity, y1 = -Infinity, cx = 0, cz = 0;
    for (let i = 0; i < n; i++) { const y = P[i * 3 + 1]; if (y < y0) y0 = y; if (y > y1) y1 = y; cx += P[i * 3]; cz += P[i * 3 + 2]; }
    return { cx: cx / n, cy: (y0 + y1) / 2, cz: cz / n, scale: 0.92 / Math.max(0.2, y1 - y0) };
}

/** Rasterise `meshes` (slot 0 = the body, culled single-sided when `cullBody`) into a tile. Degenerate (masked)
 *  triangles draw nothing. */
function rasterize(meshes: VisMesh[], vw: VisView, tile: number, fr: ReturnType<typeof frame>, cullBody: boolean): Raster {
    const W = tile, H = tile, z = new Float32Array(W * H).fill(-Infinity);
    const who = new Int32Array(W * H).fill(-1), tri = new Int32Array(W * H).fill(-1), back = new Uint8Array(W * H);
    const ya = (vw.yaw * Math.PI) / 180, pa = (vw.pitch * Math.PI) / 180;
    const cyw = Math.cos(ya), syw = Math.sin(ya), cp = Math.cos(pa), sp = Math.sin(pa), scale = fr.scale * tile;
    meshes.forEach((m, mi) => {
        const n = m.P.length / 3, S = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            const x = m.P[i * 3] - fr.cx, y = m.P[i * 3 + 1] - fr.cy, zz = m.P[i * 3 + 2] - fr.cz;
            const rx = x * cyw - zz * syw, rz = x * syw + zz * cyw;
            const ry = y * cp + rz * sp, rz2 = -y * sp + rz * cp;
            S[i * 3] = W / 2 + rx * scale; S[i * 3 + 1] = H / 2 - ry * scale; S[i * 3 + 2] = rz2;
        }
        const I = m.indices;
        for (let t = 0; t + 2 < I.length; t += 3) {
            const a = I[t], b = I[t + 1], c = I[t + 2];
            if (a === b || b === c || a === c) continue;
            const ax = S[a * 3], ay = S[a * 3 + 1], bx = S[b * 3], by = S[b * 3 + 1], cx = S[c * 3], cy2 = S[c * 3 + 1];
            const area = (bx - ax) * (cy2 - ay) - (by - ay) * (cx - ax);
            if (Math.abs(area) < 1e-9) continue;
            // Screen y points DOWN, so a CCW (front) triangle in view space has a NEGATIVE screen area here.
            const isBack = area > 0 ? 1 : 0;
            if (isBack && mi === 0 && cullBody) continue;
            const xa = Math.max(0, Math.floor(Math.min(ax, bx, cx))), xb = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
            const ya0 = Math.max(0, Math.floor(Math.min(ay, by, cy2))), yb = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy2)));
            for (let py = ya0; py <= yb; py++) for (let px = xa; px <= xb; px++) {
                const qx = px + 0.5, qy = py + 0.5;
                const w0 = ((bx - qx) * (cy2 - qy) - (by - qy) * (cx - qx)) / area;
                const w1 = ((cx - qx) * (ay - qy) - (cy2 - qy) * (ax - qx)) / area;
                const w2 = 1 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                const d = w0 * S[a * 3 + 2] + w1 * S[b * 3 + 2] + w2 * S[c * 3 + 2];
                const o = py * W + px;
                if (d <= z[o]) continue;
                z[o] = d; who[o] = mi; tri[o] = t / 3; back[o] = isBack;
            }
        }
    });
    return { W, H, who, tri, back };
}

/**
 * Rasterise and count. `body.indices` may contain degenerate (masked) triangles — they draw nothing.
 * `png` (optional) receives an RGB image per view: skin tan, exposed skin magenta, garments grey, lining dark blue.
 */
export function measureVisibility(body: VisMesh, covered: Uint8Array, garments: VisMesh[], views: VisView[] = VIS_VIEWS, tile = 260,
    png?: (view: number, w: number, h: number, rgb: Uint8Array) => void): VisResult {
    const res: VisResult = { exposedPx: 0, liningPx: 0, garmentPx: 0, bodyPx: 0, exposedTris: new Set() };
    const meshes = [body, ...garments], fr = frame(meshes);
    views.forEach((vw, vi) => {
        const r = rasterize(meshes, vw, tile, fr, true);
        const rgb = png ? new Uint8Array(r.W * r.H * 3).fill(240) : null;
        for (let o = 0; o < r.W * r.H; o++) {
            const mi = r.who[o];
            if (mi < 0) continue;
            let col: [number, number, number];
            if (mi === 0) {
                res.bodyPx++;
                if (covered[r.tri[o]]) { res.exposedPx++; res.exposedTris.add(r.tri[o]); col = [235, 0, 200]; } else col = [226, 190, 168];
            } else {
                res.garmentPx++;
                if (r.back[o]) { res.liningPx++; col = [30, 40, 110]; } else col = [150, 150, 160];
            }
            if (rgb) { rgb[o * 3] = col[0]; rgb[o * 3 + 1] = col[1]; rgb[o * 3 + 2] = col[2]; }
        }
        if (png && rgb) png(vi, r.W, r.H, rgb);
    });
    return res;
}

/** holePx = see-through to the background or other skin INSIDE the silhouette (no background pixel within 2 px in the
 *  unmasked render); edgePx = the same on the silhouette's 2-px rim — skin that stuck out past the cloth's outline by a
 *  few mm, so the outline simply becomes the cloth's own (benign); liningPx = a garment's inside shows where the hidden skin was
 *  (the garment itself is folded there — a crease the lining shades, not an opening); hiddenPokePx = skin the mask
 *  correctly replaced with the cloth's outside. */
export interface HoleResult { holePx: number; edgePx: number; liningPx: number; hiddenPokePx: number; holeTris: Set<number> }

/**
 * See-through HOLES the body-hiding mask opens in a pose (see the header). `body.indices` = the FULL body triangles;
 * `hide` = one flag per triangle. Pixel by pixel: the unmasked render's winner is a hidden body triangle, and the
 * masked render shows nothing (background), other skin behind it, or a garment's inside.
 * `png` (optional): holes red, hidden pokes (cloth correctly shown instead) green, everything else as measureVisibility.
 */
export function measureMaskHoles(body: VisMesh, hide: Uint8Array, garments: VisMesh[], views: VisView[] = VIS_VIEWS, tile = 260,
    png?: (view: number, w: number, h: number, rgb: Uint8Array) => void): HoleResult {
    const res: HoleResult = { holePx: 0, edgePx: 0, liningPx: 0, hiddenPokePx: 0, holeTris: new Set() };
    const masked = new Uint32Array(body.indices);
    for (let t = 0; t < hide.length; t++) if (hide[t]) { masked[t * 3 + 1] = masked[t * 3]; masked[t * 3 + 2] = masked[t * 3]; }
    const full = [body, ...garments], fr = frame(full);
    const mk = [{ P: body.P, indices: masked }, ...garments];
    views.forEach((vw, vi) => {
        const a = rasterize(full, vw, tile, fr, true), b = rasterize(mk, vw, tile, fr, true);
        const rgb = png ? new Uint8Array(a.W * a.H * 3).fill(240) : null;
        for (let o = 0; o < a.W * a.H; o++) {
            let col: [number, number, number] | null = null;
            if (a.who[o] === 0 && hide[a.tri[o]]) {
                const seen = b.who[o];
                if (seen <= 0) {
                    const x = o % a.W, y = (o / a.W) | 0;
                    let rim = false;
                    for (let dy = -2; dy <= 2 && !rim; dy++) for (let dx = -2; dx <= 2; dx++) {
                        const xx = x + dx, yy = y + dy;
                        if (xx < 0 || yy < 0 || xx >= a.W || yy >= a.H || a.who[yy * a.W + xx] < 0) { rim = true; break; }
                    }
                    if (rim) { res.edgePx++; col = [250, 150, 180]; } else { res.holePx++; res.holeTris.add(a.tri[o]); col = [230, 20, 20]; }
                }
                else if (b.back[o]) { res.liningPx++; col = [240, 160, 20]; }
                else { res.hiddenPokePx++; col = [40, 200, 60]; }
            }
            if (rgb) {
                if (!col) { const mi = b.who[o]; col = mi < 0 ? [240, 240, 240] : mi === 0 ? [226, 190, 168] : b.back[o] ? [30, 40, 110] : [150, 150, 160]; }
                rgb[o * 3] = col[0]; rgb[o * 3 + 1] = col[1]; rgb[o * 3 + 2] = col[2];
            }
        }
        if (png && rgb) png(vi, a.W, a.H, rgb);
    });
    return res;
}
