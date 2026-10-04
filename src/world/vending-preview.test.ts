/**
 * VENDING PREVIEW (dev tool, gated like pose-preview): VENDING_PREVIEW=<out.png> npx vitest run src/world/vending-preview.test.ts
 *
 * CPU-rasterises the machine the way the CITY builds it — the merged layers + the instanced body shell, backdrop and
 * label-textured cans — in colour, from a few views, so the layout and the can UV mapping can be LOOKED AT without a
 * browser. The label sheet is the placeholder design reproduced procedurally (per-cell hue + band + disc + rim), so
 * a wrong UV mapping shows as scrambled labels. Not a renderer test: skipped unless VENDING_PREVIEW is set.
 */
import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { encodePNG } from '../services/managers/pose-preview';
import { buildVendingMachine, resolveVendingParams, vendingShellGeometry, vendingProductsGeometry, vendingStockGeometry,
    vendingLabelCell, VENDING_LABEL_CELLS, emitVending, newVendingAccum, vendingLayers, VENDING_BRANDS, type VendingParams } from './vending';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';

const OUT = process.env.VENDING_PREVIEW;
type RGB = [number, number, number];
interface Part { geo: MeshGeometry; color: RGB; emissive?: number; tex?: (u: number, v: number) => RGB; glass?: boolean; dy?: number }

const HUES: RGB[] = ['#e8453c', '#2f7fd6', '#f2c230', '#4caf6a', '#f08bb6', '#8a5cd6', '#f07a2a', '#3cc6c8']
    .map((h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]);

/** The placeholder label sheet (mirrors ShapeManager._vendingPlaceholderLabelsUrl) sampled at sheet uv. */
function labelTex(brandIdx: number): (u: number, v: number) => RGB {
    return (u, v) => {
        for (let i = 0; i < VENDING_LABEL_CELLS; i++) {
            const { cell, rim, label } = vendingLabelCell(i);
            if (u < cell[0] - 0.01 || u > cell[2] + 0.01 || v < cell[1] - 0.01 || v > cell[3] + 0.01) continue;
            if (v <= rim[3]) return [0.85, 0.86, 0.88];
            const lx = (u - label[0]) / (label[2] - label[0]), ly = (v - label[1]) / (label[3] - label[1]);
            const w = label[2] - label[0], h = label[3] - label[1];
            if (ly > 0.30 && ly < 0.46) return [1, 1, 1];
            const dx = (lx - 0.5) * w, dy = (ly - 0.62) * h;
            if (Math.hypot(dx, dy) < w * 0.26) return HUES[(i + brandIdx * 3 + 4) % 8];
            return HUES[(i + brandIdx * 3) % 8];
        }
        return [1, 0, 1];   // magenta = a UV outside every cell (a bug)
    };
}

function partsFor(q: Partial<VendingParams>, brand: number): Part[] {
    const p = resolveVendingParams({ ...q, brand });
    const acc = newVendingAccum();
    emitVending(acc, [0, 0, 0], [0, 1], p, 1, p.seed, true, true);   // the city's merged layers
    const parts: Part[] = vendingLayers(acc, 3, { night: false }).map((L) => ({ geo: L.geometry, color: L.color, emissive: L.emissive, glass: L.glass }));
    const b = VENDING_BRANDS[brand];
    parts.push({ geo: vendingShellGeometry(p, 1), color: b.body, dy: p.heightM / 2 });                      // shell (centred)
    parts.push({ geo: vendingProductsGeometry(p, 1), color: [1, 1, 1], emissive: 0.3, tex: (_u, v) => [0.92 - v * 0.1, 0.94 - v * 0.08, 0.97 - v * 0.05] });
    if (p.stock === 'cans') parts.push({ geo: vendingStockGeometry(p, 1, 0), color: [1, 1, 1], emissive: 0.12, tex: labelTex(brand) });
    return parts;
}

function render(parts: Part[], yawDeg: number, pitchDeg: number, W: number, H: number, centre: [number, number, number], span: number): Uint8Array {
    const rgb = new Uint8Array(W * H * 3), zb = new Float32Array(W * H).fill(-Infinity);
    for (let i = 0; i < W * H; i++) { rgb[i * 3] = 236; rgb[i * 3 + 1] = 238; rgb[i * 3 + 2] = 242; }
    const cy = Math.cos(yawDeg * Math.PI / 180), sy = Math.sin(yawDeg * Math.PI / 180), cp = Math.cos(pitchDeg * Math.PI / 180), sp = Math.sin(pitchDeg * Math.PI / 180);
    const view = (x: number, y: number, z: number): [number, number, number] => {
        x -= centre[0]; y -= centre[1]; z -= centre[2];
        const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;          // yaw about Y
        const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;          // pitch about X
        return [x1, y2, z2];
    };
    const scale = Math.min(W, H) / span, light = [0.45, 0.75, 0.5], ll = Math.hypot(...light);
    const glassParts: Part[] = [];
    const drawPart = (pt: Part, alpha: number) => {
        const v = pt.geo.vertices, ix = pt.geo.indices, dy = pt.dy ?? 0;
        for (let t = 0; t < ix.length; t += 3) {
            const P = [0, 1, 2].map((k) => { const o = ix[t + k] * 12; const [x, y, z] = view(v[o], v[o + 1] + dy, v[o + 2]); return { sx: W / 2 + x * scale, sy: H / 2 - y * scale, z, u: v[o + 6], vv: v[o + 7], n: [v[o + 3], v[o + 4], v[o + 5]] }; });
            const [a, b, c] = P;
            const area = (b.sx - a.sx) * (c.sy - a.sy) - (c.sx - a.sx) * (b.sy - a.sy);
            if (Math.abs(area) < 1e-9) continue;
            const minX = Math.max(0, Math.floor(Math.min(a.sx, b.sx, c.sx))), maxX = Math.min(W - 1, Math.ceil(Math.max(a.sx, b.sx, c.sx)));
            const minY = Math.max(0, Math.floor(Math.min(a.sy, b.sy, c.sy))), maxY = Math.min(H - 1, Math.ceil(Math.max(a.sy, b.sy, c.sy)));
            for (let py = minY; py <= maxY; py++) for (let px = minX; px <= maxX; px++) {
                const x = px + 0.5, y = py + 0.5;
                const w0 = ((b.sx - x) * (c.sy - y) - (c.sx - x) * (b.sy - y)) / area;
                const w1 = ((c.sx - x) * (a.sy - y) - (a.sx - x) * (c.sy - y)) / area;
                const w2 = 1 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                const z = w0 * a.z + w1 * b.z + w2 * c.z, i = py * W + px;
                if (z <= zb[i] + 1e-6) continue;
                if (alpha >= 1) zb[i] = z;
                const n = [0, 1, 2].map((k) => w0 * a.n[k] + w1 * b.n[k] + w2 * c.n[k]);
                const nl = Math.hypot(n[0], n[1], n[2]) || 1;
                const lam = Math.abs(n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) / (nl * ll);
                const base = pt.tex ? pt.tex(w0 * a.u + w1 * b.u + w2 * c.u, w0 * a.vv + w1 * b.vv + w2 * c.vv) : pt.color;
                const e = pt.emissive ?? 0, k = Math.min(1.25, 0.38 + 0.62 * lam + e * 0.6);
                for (let ch = 0; ch < 3; ch++) {
                    const col = Math.min(255, Math.round(base[ch] * k * 255));
                    rgb[i * 3 + ch] = Math.round(rgb[i * 3 + ch] * (1 - alpha) + col * alpha);
                }
            }
        }
    };
    for (const pt of parts) { if (pt.glass) glassParts.push(pt); else drawPart(pt, 1); }
    for (const pt of glassParts) drawPart(pt, 0.18);
    return rgb;
}

describe.skipIf(!OUT)('vending preview (dev)', () => {
    it('renders the city machine from three views', () => {
        const views: { yaw: number; pitch: number; q: Partial<VendingParams>; brand: number; zoom?: boolean }[] = [
            { yaw: 0, pitch: 4, q: {}, brand: 0 },
            { yaw: 32, pitch: 12, q: {}, brand: 1 },
            { yaw: -38, pitch: 18, q: { shelves: 4, cansPerShelf: 10, widthM: 1.0 }, brand: 2 },
            { yaw: 18, pitch: 8, q: {}, brand: 0, zoom: true },
        ];
        const T = 420, W = T * views.length, H = 520;
        const out = new Uint8Array(W * H * 3);
        views.forEach((vw, k) => {
            const p = resolveVendingParams(vw.q);
            const img = vw.zoom
                ? render(partsFor(vw.q, vw.brand), vw.yaw, vw.pitch, T, H, [0, p.heightM * 0.74, p.depthM / 2], p.heightM * 0.5)
                : render(partsFor(vw.q, vw.brand), vw.yaw, vw.pitch, T, H, [0, p.heightM / 2, 0], p.heightM * 1.15);
            for (let y = 0; y < H; y++) for (let x = 0; x < T; x++) for (let c = 0; c < 3; c++) out[(y * W + k * T + x) * 3 + c] = img[(y * T + x) * 3 + c];
        });
        writeFileSync(OUT!, encodePNG(W, H, out));
        void buildVendingMachine;
    });
});
