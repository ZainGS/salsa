// Atlas sheet packing off the main thread (performance-plan P3.2e): the pure layout plans, worker ≡ fallback
// painting, and the SignageController / GarpAtlasBuilder batching.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { advertPageOps, garpGridSheetOps, normaliseUploadOps, paintSheetOps, vendingLabelSheetOps, type SheetOp } from './atlas-sheet-ops';
import { composeSheetHandler, type AtlasComposeJob } from './atlas-jobs';
import type { JobApi } from './worker-job-runtime';
import { ADVERT_PAGE_GRID, ADVERT_PAGE_PX, advertCellPx } from '../../world/adverts';
import { VENDING_LABEL_CELLS, VENDING_LABEL_PAD, vendingLabelCell } from '../../world/vending';
import { GarpManager } from '../managers/garp-manager';
import { SignageController } from '../managers/signage-controller';
import { GarpAtlasBuilder } from '../managers/garp-atlas-builder';
import type { DecalSource } from '../managers/decal-geometry';

/** A recording 2D context: every call → one log line (images logged by their `tag`). */
function recorder() {
    const log: string[] = [];
    const ctx = {
        set fillStyle(v: unknown) { log.push(`fillStyle ${typeof v === 'string' ? v : (v as { id: string }).id}`); },
        get fillStyle(): unknown { return ''; },
        fillRect: (x: number, y: number, w: number, h: number) => log.push(`fillRect ${x},${y},${w},${h}`),
        drawImage: (im: { tag: string }, x: number, y: number, w: number, h: number) => log.push(`drawImage ${im.tag} ${x},${y},${w},${h}`),
        createLinearGradient: (x0: number, y0: number, x1: number, y1: number) => {
            const id = `grad(${x0},${y0},${x1},${y1})`;
            return { id, addColorStop: (o: number, c: string) => log.push(`${id} stop ${o} ${c}`) };
        },
    };
    return { log, ctx };
}
const fakeBmp = (tag: string, width = 64, height = 64) => ({ tag, width, height, close() {} }) as unknown as ImageBitmap;
const api: JobApi = { shared: {}, progress() {}, transfer() {}, fallback: false };

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('atlas sheet plans (pure layout)', () => {
    it('advert page: white background + bleed/inner per occupied cell, rects == advertCellPx', () => {
        const plan = advertPageOps('square', [0, -1, 1]);
        expect(plan.width).toBe(ADVERT_PAGE_PX);
        expect(plan.ops[0]).toEqual({ t: 'fill', color: '#ffffff', x: 0, y: 0, w: ADVERT_PAGE_PX, h: ADVERT_PAGE_PX });
        const imgs = plan.ops.filter((o): o is Extract<SheetOp, { t: 'img' }> => o.t === 'img');
        expect(imgs).toHaveLength(4);   // cell 1 empty → skipped
        const c0 = advertCellPx('square', 0), c2 = advertCellPx('square', 2);
        expect(imgs[0]).toEqual({ t: 'img', src: 0, ...c0.outer });
        expect(imgs[1]).toEqual({ t: 'img', src: 0, ...c0.inner });
        expect(imgs[2]).toEqual({ t: 'img', src: 1, ...c2.outer });
        expect(imgs[3]).toEqual({ t: 'img', src: 1, ...c2.inner });
        expect(ADVERT_PAGE_GRID.square.cols * ADVERT_PAGE_GRID.square.rows).toBe(4);
    });

    it('vending label sheet matches the legacy per-cell geometry (bleed, label, rim band)', () => {
        const S = 512, pad = VENDING_LABEL_PAD * S, plan = vendingLabelSheetOps(3);
        expect(plan.ops).toHaveLength(VENDING_LABEL_CELLS * 3);
        for (let i = 0; i < VENDING_LABEL_CELLS; i++) {
            const { cell, rim, label } = vendingLabelCell(i);
            const [x0, y0, x1, y1] = [cell[0] * S - pad, cell[1] * S - pad, cell[2] * S + pad, cell[3] * S + pad];
            const [a, b, c] = plan.ops.slice(i * 3, i * 3 + 3);
            expect(a).toEqual({ t: 'img', src: i % 3, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
            expect(b).toEqual({ t: 'img', src: i % 3, x: label[0] * S, y: label[1] * S, w: (label[2] - label[0]) * S, h: (label[3] - label[1]) * S });
            expect(c).toMatchObject({ t: 'hgrad', x: x0, y: y0, w: x1 - x0, h: rim[3] * S - y0 });
        }
    });

    it('grid sheet + normalise plans', () => {
        const g = garpGridSheetOps(2, 2, 1, 512, 4);
        expect(g.ops).toEqual([
            { t: 'img', src: 0, x: 0, y: 0, w: 256, h: 512 }, { t: 'img', src: 0, x: 4, y: 4, w: 248, h: 504 },
            { t: 'img', src: 1, x: 256, y: 0, w: 256, h: 512 }, { t: 'img', src: 1, x: 260, y: 4, w: 248, h: 504 },
        ]);
        expect(normaliseUploadOps(2048, 512, 1024)).toMatchObject({ width: 1024, height: 256 });
        expect(normaliseUploadOps(300, 200, 1024)).toMatchObject({ width: 300, height: 200 });   // never upscaled
    });
});

describe('worker handler ≡ main-thread fallback painter', () => {
    it('composeSheetHandler paints exactly the ops the fallback paints, and returns bitmap + data URL', async () => {
        const plan = vendingLabelSheetOps(2);
        const imgs = [fakeBmp('A'), fakeBmp('B')];
        // Fallback path: paintSheetOps on a <canvas>-like ctx.
        const main = recorder();
        paintSheetOps(main.ctx, plan.ops, imgs);
        // Worker path: the handler on a stub OffscreenCanvas.
        const worker = recorder();
        class FakeOffscreen {
            constructor(public width: number, public height: number) {}
            getContext() { return worker.ctx; }
            convertToBlob() { return Promise.resolve(new Blob(['x'], { type: 'image/png' })); }
            transferToImageBitmap() { return fakeBmp('sheet', this.width, this.height); }
        }
        vi.stubGlobal('OffscreenCanvas', FakeOffscreen);
        vi.stubGlobal('createImageBitmap', async () => fakeBmp('decoded'));
        vi.stubGlobal('FileReaderSync', class { readAsDataURL() { return 'data:image/png;base64,eA=='; } });
        const job: AtlasComposeJob = { plan, sources: imgs, encode: { mime: 'image/png' }, bitmap: true };
        const r = await composeSheetHandler(job, api);
        expect(worker.log).toEqual(main.log);
        expect(worker.log.length).toBeGreaterThan(0);
        expect(r.dataUrl).toBe('data:image/png;base64,eA==');
        expect(r.bitmap).toMatchObject({ width: 512, height: 512 });
        expect(r.srcSizes).toEqual([[64, 64], [64, 64]]);
    });

    it('throws without OffscreenCanvas (callers then take their legacy canvas path)', async () => {
        vi.stubGlobal('OffscreenCanvas', undefined);
        await expect(Promise.resolve().then(() => composeSheetHandler({ plan: advertPageOps('square', []), sources: [] }, api))).rejects.toThrow();
    });
});

/** A SignageController over a real GarpManager with fake decode / compose (no DOM). */
function harness() {
    const garp = new GarpManager();
    const calls = { rebuild: 0, refresh: 0, normalise: 0, pages: [] as string[], seeded: 0 };
    let ctl!: SignageController;
    ctl = new SignageController({
        garp,
        // 'img:WxH' → a fake bitmap of that size
        resolveBitmap: async (src) => {
            if (src.kind !== 'image') return null;
            const m = /^img:(\d+)x(\d+)/.exec(src.dataUrl);
            return m ? fakeBmp(src.dataUrl, +m[1], +m[2]) : (src.dataUrl.startsWith('norm:') ? fakeBmp(src.dataUrl) : null);
        },
        rebuildAtlas: async () => { calls.rebuild++; await ctl.ensurePacked(); },
        refreshCity: () => { calls.refresh++; },
        compose: async (job) => {
            if (job.encode?.mime === 'image/jpeg') { calls.normalise++; return { dataUrl: `norm:${job.plan.width}x${job.plan.height}`, bitmap: null, srcSizes: [] }; }
            calls.pages.push(job.sources.join('+'));
            return { dataUrl: `page:${calls.pages.length}`, bitmap: fakeBmp('page', 512, 512), srcSizes: [] };
        },
        seedBitmap: () => { calls.seeded++; },
    });
    return { garp, ctl, calls };
}

describe('SignageController batching (one pack / atlas / city rebuild per batch)', () => {
    it('addMany: same per-item results as add(), ONE atlas rebuild, ONE city refresh', async () => {
        vi.useFakeTimers();
        const { ctl, calls, garp } = harness();
        const res = await ctl.addMany([
            { bucket: 'auto', source: 'img:256x896' },          // portrait
            { bucket: 'auto', source: 'img:512x512' },          // square
            { bucket: 'square', source: 'img:600x500', opts: { lit: false, name: 'x' } },
            { bucket: 'auto', source: 'broken' },               // unreadable
            { bucket: 'nope' as never, source: 'img:1x1' },     // unknown bucket
        ]);
        expect(res.map(r => r.bucket)).toEqual(['portrait', 'square', 'square', null, null]);
        expect(res[3].errors).toEqual(['the image could not be read']);
        expect(res[4].errors[0]).toMatch(/unknown bucket/);
        expect(calls.normalise).toBe(3);
        expect(calls.rebuild).toBe(1);
        expect(calls.pages).toHaveLength(2);                      // portrait page + square page
        expect(calls.seeded).toBe(2);
        expect(garp.textureSource('signage/square/0')).toEqual({ kind: 'image', dataUrl: expect.stringMatching(/^page:/) });
        expect(ctl.list().find(r => r.name === 'x')).toMatchObject({ lit: false, dataUrl: 'norm:600x500' });
        vi.advanceTimersByTime(1000);
        expect(calls.refresh).toBe(1);
    });

    it('a host loop of awaited add()s (each slower than the debounce) refreshes the city ONCE', async () => {
        vi.useFakeTimers();
        const { ctl, calls } = harness();
        // Each pack takes "600 ms" (> the 400 ms debounce) — the previous add's timer fires mid-add and is held.
        const origPack = ctl.pack.bind(ctl);
        ctl.pack = async () => { vi.advanceTimersByTime(600); await origPack(); };
        for (const s of ['img:256x896', 'img:512x512', 'img:960x480', 'img:1200x200']) await ctl.add('auto', s);
        expect(calls.refresh).toBe(0);
        vi.advanceTimersByTime(1000);
        expect(calls.refresh).toBe(1);
    });

    it('re-pack recomposes ONLY pages whose cells changed (and pages a document load reset)', async () => {
        const { ctl, calls, garp } = harness();
        await ctl.addMany([{ bucket: 'portrait', source: 'img:256x896' }, { bucket: 'square', source: 'img:512x512' }], );
        expect(calls.pages).toHaveLength(2);
        await ctl.add('square', 'img:500x500', { regen: false });
        expect(calls.pages).toHaveLength(3);                      // only the square page again
        expect(calls.pages[2].split('+')).toHaveLength(2);
        // A document-load style reset re-seeds placeholders → that page is recomposed even with the same ids.
        garp.registerTexture('signage/portrait/0', { kind: 'image', dataUrl: '' });
        await ctl.add('square', 'img:510x510', { regen: false });
        expect(calls.pages.slice(3).length).toBe(2);              // square (changed) + portrait (reset)
    });
});

describe('GarpAtlasBuilder (coalesced + cached)', () => {
    it('overlapping rebuilds → one in-flight + one trailing build; unchanged textures decode once', async () => {
        const garp = new GarpManager();
        const a: DecalSource = { kind: 'image', dataUrl: 'a' }, b: DecalSource = { kind: 'image', dataUrl: 'b' };
        garp.registerTexture('k/a', a); garp.registerTexture('k/b', b);
        const decoded: string[] = [];
        const uploads: number[][] = [];
        const builder = new GarpAtlasBuilder({
            garp,
            resolveBitmap: async (s) => { decoded.push((s as { dataUrl: string }).dataUrl); return fakeBmp((s as { dataUrl: string }).dataUrl, 512, 512); },
            upload: (layers) => uploads.push(layers.map(l => l.layer)),
            afterUpload: () => {},
        });
        const p = [builder.rebuild(), builder.rebuild(), builder.rebuild()];
        await Promise.all(p);
        expect(builder.builds).toBe(2);
        expect(decoded.sort()).toEqual(['a', 'b']);               // the trailing build hit the cache
        // Replace one texture → only it decodes; a seeded source never decodes.
        const c: DecalSource = { kind: 'image', dataUrl: 'c' }, d: DecalSource = { kind: 'image', dataUrl: 'd' };
        garp.registerTexture('k/a', c); garp.registerTexture('k/d', d); builder.seed(d, fakeBmp('d', 512, 512));
        await builder.rebuild();
        expect(decoded.sort()).toEqual(['a', 'b', 'c']);
        expect(uploads.at(-1)).toEqual([1, 2, 3]);
    });
});
