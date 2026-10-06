/**
 * ROCK contact sheet — renders every archetype of the rock pool (rocks.ts) with a tiny CPU rasterizer: interpolated
 * (split) normals, a soft-banded Lambert like the city's toon look, the shared foliage base-AO ramp + grass bleed,
 * and the grass plane at the ground line (so the sink reads). Runs only with ROCK_PREVIEW=<dir>:
 *   ROCK_PREVIEW=out npx vitest run src/world/rocks-preview.test.ts
 */
import { describe, it } from 'vitest';
import { rockVariants, ROCK_MOSS_COLOR } from './rocks';
import { encodePNG } from '../services/managers/pose-preview';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';

type V3 = [number, number, number];

function render(tile: number, cols: number): Uint8Array {
    const pool = rockVariants(), rows = Math.ceil(pool.length / cols) * 2;   // two views per archetype (3/4 + low side)
    const W = tile * cols, H = tile * rows;
    const rgb = new Uint8Array(W * H * 3), zb = new Float32Array(W * H).fill(-Infinity);
    const L = (() => { const l: V3 = [0.45, 0.8, 0.35]; const n = Math.hypot(...l); return l.map(v => v / n) as V3; })();
    const grass: V3 = [0.42, 0.55, 0.30];
    pool.forEach((v, vi) => {
        for (let view = 0; view < 2; view++) {
            const ox = (vi % cols) * tile, oy = (Math.floor(vi / cols) * 2 + view) * tile;
            const yaw = view === 0 ? 0.6 : 2.2, pitch = view === 0 ? 0.55 : 0.12;
            const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
            const scale = tile * 0.62, cyOff = 0.15;
            const proj = (p: V3): V3 => {
                const x1 = p[0] * cyw - p[2] * syw, z1 = p[0] * syw + p[2] * cyw;
                const y2 = p[1] * cp - z1 * sp, z2 = p[1] * sp + z1 * cp;
                return [ox + tile / 2 + x1 * scale, oy + tile * 0.62 - (y2 - cyOff * 0) * scale, z2];
            };
            // Background sky + ground plane (a big quad at y = 0).
            for (let y = oy; y < oy + tile; y++) for (let x = ox; x < ox + tile; x++) { const o = (y * W + x) * 3; rgb[o] = 214; rgb[o + 1] = 226; rgb[o + 2] = 236; }
            const tri = (a: V3, b: V3, c: V3, na: V3, nb: V3, nc: V3, col: V3, ya: number, yb: number, yc: number, flat = false): void => {
                const A = proj(a), B = proj(b), C = proj(c);
                const x0 = Math.max(ox, Math.floor(Math.min(A[0], B[0], C[0]))), x1 = Math.min(ox + tile - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
                const y0 = Math.max(oy, Math.floor(Math.min(A[1], B[1], C[1]))), y1 = Math.min(oy + tile - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
                const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
                if (Math.abs(den) < 1e-9) return;
                for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                    const w0 = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (y - C[1])) / den;
                    const w1 = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / den;
                    const w2 = 1 - w0 - w1;
                    if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                    const z = A[2] * w0 + B[2] * w1 + C[2] * w2, k = y * W + x;
                    if (z <= zb[k]) continue;
                    zb[k] = z;
                    let n: V3 = [na[0] * w0 + nb[0] * w1 + nc[0] * w2, na[1] * w0 + nb[1] * w1 + nc[1] * w2, na[2] * w0 + nb[2] * w1 + nc[2] * w2];
                    const nl = Math.hypot(...n) || 1; n = [n[0] / nl, n[1] / nl, n[2] / nl];
                    let c = col;
                    if (!flat) {
                        // foliageBase(): base AO + ground bleed over the bottom 15 % of the rock height.
                        const ly = Math.min(1, Math.max(0, (ya * w0 + yb * w1 + yc * w2) / v.height));
                        const t = Math.min(1, Math.max(0, ly / 0.15)), ramp = 1 - t * t * (3 - 2 * t);
                        c = c.map(ch => ch * (1 - 0.5 * ramp)) as V3;
                        c = c.map((ch, i) => ch + ([0.34, 0.45, 0.25][i] - ch) * 0.3 * ramp) as V3;
                    }
                    const ndl = Math.max(0, n[0] * L[0] + n[1] * L[1] + n[2] * L[2]);
                    const band = flat ? 1 : Math.round(ndl * 4) / 4 * 0.35 + ndl * 0.65;   // soft toon banding
                    const lit = 0.42 + 0.7 * band;
                    const o = k * 3;
                    rgb[o] = Math.min(255, c[0] * lit * 255); rgb[o + 1] = Math.min(255, c[1] * lit * 255); rgb[o + 2] = Math.min(255, c[2] * lit * 255);
                }
            };
            const G = 1.1, up: V3 = [0, 1, 0];
            tri([-G, 0, -G], [G, 0, -G], [G, 0, G], up, up, up, grass, 0, 0, 0, true);
            tri([-G, 0, -G], [G, 0, G], [-G, 0, G], up, up, up, grass, 0, 0, 0, true);
            const draw = (g: MeshGeometry, col: V3): void => {
                const vs = g.vertices, ix = g.indices;
                const P = (i: number): V3 => [vs[i * 12], vs[i * 12 + 1], vs[i * 12 + 2]];
                const N = (i: number): V3 => [vs[i * 12 + 3], vs[i * 12 + 4], vs[i * 12 + 5]];
                for (let t = 0; t < ix.length; t += 3) {
                    const a = ix[t], b = ix[t + 1], c = ix[t + 2];
                    tri(P(a), P(b), P(c), N(a), N(b), N(c), col, P(a)[1], P(b)[1], P(c)[1]);
                }
            };
            draw(v.stone, v.tone);
            if (v.moss) draw(v.moss, ROCK_MOSS_COLOR);
        }
    });
    return encodePNG(W, H, rgb);
}

describe.skipIf(!process.env.ROCK_PREVIEW)('rock contact sheet', () => {
    it('renders the archetype pool', async () => {
        const fs = await import('node:fs'), path = await import('node:path');
        const dir = process.env.ROCK_PREVIEW!; fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'rocks-contact-sheet.png'), render(240, 5));
        const lines = rockVariants().map(v => `${v.id.padEnd(10)} ${v.kind.padEnd(8)} tris ${String(v.tris).padStart(4)}  h ${v.height.toFixed(2)}  sink ${v.sink.toFixed(2)} (${((v.sink / (v.sink + v.height)) * 100).toFixed(0)}%)  moss ${v.moss ? 'y' : 'n'}`);
        fs.writeFileSync(path.join(dir, 'rocks.txt'), lines.join('\n') + '\n');
    });
});
