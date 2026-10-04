// Atlas SHEET OPS — the pure layout half of every packed GARP / adverts sheet (performance-plan P3.2e).
//
// A sheet (an advert page, a vending can-label sheet, a generic GARP grid sheet, a normalised upload) is described
// as a flat list of DRAW OPS computed on the main thread by the pure planners below. The SAME list is painted by
// `paintSheetOps` — in the 'atlas' worker (OffscreenCanvas) AND in the main-thread <canvas> fallback — so rects,
// page / cell assignment and draw order can never drift between the two paths (determinism by construction).
//
// Pure: no DOM at module level (only the 2D-context interface passed in).

import { ADVERT_PAGE_PX, advertCellPx, type AdvertBucket } from '../../world/adverts';
import { VENDING_LABEL_CELLS, VENDING_LABEL_PAD, vendingLabelCell } from '../../world/vending';

/** One draw op. `src` indexes the job's source list. */
export type SheetOp =
    | { t: 'fill'; color: string; x: number; y: number; w: number; h: number }
    | { t: 'img'; src: number; x: number; y: number; w: number; h: number }
    /** A horizontal linear gradient (from x to x+w) filling the rect. */
    | { t: 'hgrad'; stops: [number, string][]; x: number; y: number; w: number; h: number };

/** A whole sheet: its pixel size + ops (painted in order on a cleared, transparent canvas). */
export interface SheetPlan { width: number; height: number; ops: SheetOp[] }

/** The 2D-context subset the painter uses (CanvasRenderingContext2D and OffscreenCanvasRenderingContext2D both fit). */
export interface SheetCtx {
    fillStyle: unknown;
    fillRect(x: number, y: number, w: number, h: number): void;
    drawImage(img: any, x: number, y: number, w: number, h: number): void;
    createLinearGradient(x0: number, y0: number, x1: number, y1: number): { addColorStop(o: number, c: string): void };
}

/** Paint `ops` with `images[op.src]` (a missing / null image skips its op — the cell stays as the background). */
export function paintSheetOps(ctx: SheetCtx, ops: readonly SheetOp[], images: readonly (unknown | null)[]): void {
    for (const op of ops) {
        if (op.t === 'fill') { ctx.fillStyle = op.color; ctx.fillRect(op.x, op.y, op.w, op.h); }
        else if (op.t === 'img') { const im = images[op.src]; if (im) ctx.drawImage(im, op.x, op.y, op.w, op.h); }
        else {
            const g = ctx.createLinearGradient(op.x, 0, op.x + op.w, 0);
            for (const [o, c] of op.stops) g.addColorStop(o, c);
            ctx.fillStyle = g; ctx.fillRect(op.x, op.y, op.w, op.h);
        }
    }
}

/** An ADVERT PAGE: white background, then per occupied cell the image STRETCHED over the whole cell (bleed into the
 *  padding, so bilinear filtering never mixes neighbours) and again into the inner rect. `cellSrc[cell]` = the source
 *  index of that cell's image, or -1 for an empty / unreadable cell (stays white). */
export function advertPageOps(bucket: AdvertBucket, cellSrc: readonly number[]): SheetPlan {
    const S = ADVERT_PAGE_PX;
    const ops: SheetOp[] = [{ t: 'fill', color: '#ffffff', x: 0, y: 0, w: S, h: S }];
    cellSrc.forEach((src, cell) => {
        if (src < 0) return;
        const { outer, inner } = advertCellPx(bucket, cell);
        ops.push({ t: 'img', src, ...outer }, { t: 'img', src, ...inner });
    });
    return { width: S, height: S, ops };
}

/** The silver rim gradient of a vending can-label cell. */
const RIM_STOPS: [number, string][] = [[0, '#8d9096'], [0.45, '#e4e6ea'], [1, '#9a9da3']];

/** A VENDING CAN-LABEL SHEET (512², 4×2 cells) from `n` images: cell i shows image i % n, bled over the unpadded cell
 *  then drawn into the label rect, with the brushed-aluminium rim band on top. Mirrors ShapeManager's
 *  _drawVendingLabelSheet for image art. */
export function vendingLabelSheetOps(n: number, S = 512): SheetPlan {
    const pad = VENDING_LABEL_PAD * S, ops: SheetOp[] = [];
    if (n <= 0) return { width: S, height: S, ops };
    for (let i = 0; i < VENDING_LABEL_CELLS; i++) {
        const { cell, rim, label } = vendingLabelCell(i);
        const [x0, y0, x1, y1] = [cell[0] * S - pad, cell[1] * S - pad, cell[2] * S + pad, cell[3] * S + pad];
        const src = i % n;
        ops.push({ t: 'img', src, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
        ops.push({ t: 'img', src, x: label[0] * S, y: label[1] * S, w: (label[2] - label[0]) * S, h: (label[3] - label[1]) * S });
        ops.push({ t: 'hgrad', stops: RIM_STOPS, x: x0, y: y0, w: x1 - x0, h: rim[3] * S - y0 });
    }
    return { width: S, height: S, ops };
}

/** A generic GARP GRID SHEET: `n` images into cols×rows cells of a size² sheet (image i % n per cell), bled then inset by padPx. */
export function garpGridSheetOps(n: number, cols: number, rows: number, size = 512, padPx = 4): SheetPlan {
    const ops: SheetOp[] = [];
    if (n <= 0) return { width: size, height: size, ops };
    const cw = size / cols, ch = size / rows;
    for (let i = 0; i < cols * rows; i++) {
        const src = i % n, x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
        ops.push({ t: 'img', src, x, y, w: cw, h: ch }, { t: 'img', src, x: x + padPx, y: y + padPx, w: cw - 2 * padPx, h: ch - 2 * padPx });
    }
    return { width: size, height: size, ops };
}

/** NORMALISE an uploaded image: flattened onto white, longest side capped at `maxPx` (never upscaled). */
export function normaliseUploadOps(w: number, h: number, maxPx: number): SheetPlan {
    const k = Math.min(1, maxPx / Math.max(w, h));
    const W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(h * k));
    return { width: W, height: H, ops: [{ t: 'fill', color: '#ffffff', x: 0, y: 0, w: W, h: H }, { t: 'img', src: 0, x: 0, y: 0, w: W, h: H }] };
}
