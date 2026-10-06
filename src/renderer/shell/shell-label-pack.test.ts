/**
 * shell-label-pack.test.ts — the label atlas is ADDITIVE: packed labels keep their cells, only new labels are
 * rasterized + uploaded, and a full repack happens only on invalidate / when the shelf is full.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LabelShelfPacker, labelKey, missingLabelKeys, atlasAllocHeight } from './shell-label-pack';
import { ShellLabelAtlas, type LabelRequest } from './shell-text';

describe('LabelShelfPacker', () => {
  it('places left to right and wraps to a new shelf (the atlas\'s original placement)', () => {
    // The pre-additive build loop, verbatim.
    const old = (cells: [number, number][], W: number) => {
      let cx = 0, cy = 0, rowMax = 0; const out: { x: number; y: number }[] = [];
      for (const [w, h] of cells) {
        if (cx + w > W) { cx = 0; cy += rowMax; rowMax = 0; }
        out.push({ x: cx, y: cy }); cx += w; rowMax = Math.max(rowMax, h);
      }
      return { out, height: cy + rowMax };
    };
    const cells: [number, number][] = [];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 200; i++) cells.push([20 + Math.floor(rnd() * 700), 30 + Math.floor(rnd() * 120)]);
    const ref = old(cells, 2048);
    const p = new LabelShelfPacker(2048);
    expect(cells.map(([w, h]) => p.place(w, h))).toEqual(ref.out);
    expect(p.height).toBe(ref.height);
  });

  it('snapshot / restore rolls a trial placement back', () => {
    const p = new LabelShelfPacker(100);
    p.place(60, 10);
    const snap = p.snapshot();
    p.place(60, 30); p.place(60, 30);
    expect(p.height).toBe(70);
    p.restore(snap);
    expect(p.height).toBe(10);
    expect(p.place(30, 10)).toEqual({ x: 60, y: 0 });
  });

  it('keys, missing set, allocation step', () => {
    expect(labelKey('A', 100.4, 16.2, 'F')).toBe(labelKey('A', 100, 16, 'F', 1, 1));
    expect(labelKey('A', 100, 16, 'F', 1.5, 1)).not.toBe(labelKey('A', 100, 16, 'F'));
    expect(missingLabelKeys(['a', 'b', 'a', 'c'], k => k === 'b')).toEqual(['a', 'c']);
    expect(atlasAllocHeight(1, 512, 8192)).toBe(512);
    expect(atlasAllocHeight(513, 512, 8192)).toBe(1024);
    expect(atlasAllocHeight(1100, 512, 8192)).toBe(2048);   // always step × 2^k
    expect(atlasAllocHeight(9000, 512, 8192)).toBe(8192);
    expect(atlasAllocHeight(0, 512, 8192)).toBe(512);
  });
});

describe('ShellLabelAtlas (additive)', () => {
  // A fake 2D canvas: text width = 0.5 em per character; every fillText is recorded.
  const fills: { text: string; x: number; y: number; font: string }[] = [];
  let clears = 0;
  class FakeCtx {
    font = ''; textBaseline = ''; textAlign = ''; fillStyle = '';
    private tx = 0; private ty = 0; private stack: [number, number][] = [];
    measureText(t: string) { const px = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10); return { width: t.length * px * 0.5 }; }
    fillText(text: string, x: number, y: number) { fills.push({ text, x: x + this.tx, y: y + this.ty, font: this.font }); }
    clearRect() { clears++; }
    save() { this.stack.push([this.tx, this.ty]); }
    restore() { [this.tx, this.ty] = this.stack.pop()!; }
    translate(x: number, y: number) { this.tx += x; this.ty += y; }
    scale() { /* positions recorded pre-scale */ }
  }
  class FakeCanvas {
    private ctx = new FakeCtx();
    constructor(public width: number, public height: number) {}
    getContext() { return this.ctx; }
  }
  const uploads: { y: number; h: number; premult: unknown; format: string }[] = [];
  let textures = 0;
  const device = {
    limits: { maxTextureDimension2D: 8192 },
    createTexture: (d: { format: string; size: { width: number; height: number } }) => { textures++; return { format: d.format, size: d.size, destroy() { /* */ } }; },
    queue: {
      copyExternalImageToTexture: (src: { origin: { y: number } }, dst: { texture: { format: string }; premultipliedAlpha?: boolean }, size: { height: number }) => {
        uploads.push({ y: src.origin.y, h: size.height, premult: dst.premultipliedAlpha, format: dst.texture.format });
      },
    },
  } as unknown as GPUDevice;

  const g = globalThis as { OffscreenCanvas?: unknown; GPUTextureUsage?: unknown };
  const saved = { oc: g.OffscreenCanvas, tu: g.GPUTextureUsage };
  beforeAll(() => {
    g.OffscreenCanvas = FakeCanvas;
    g.GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16 };
  });
  afterAll(() => { g.OffscreenCanvas = saved.oc; g.GPUTextureUsage = saved.tu; });

  const req = (text: string, fontPx = 16, extra: Partial<LabelRequest> = {}): LabelRequest => ({ text, maxWidthPx: 9999, fontPx, ...extra });
  const home = [req('GOOD'), req('MORNING', 16, { scaleY: 1.5 }), req('FROGCARTS', 12, { fontFamily: 'T' }), req('Illustrator'), req('Import'), req('Settings')];
  const grid = [req('‹ Back'), req('+ New Project'), req('Sketch 1', 14, { fontFamily: 'T' }), req('Sketch 2', 14, { fontFamily: 'T' })];

  it('rasterizes only what is new, keeps existing cells + pixels, uploads only the new rows, r8 coverage', () => {
    fills.length = 0; uploads.length = 0; textures = 0;
    const atlas = new ShellLabelAtlas(device);
    atlas.build(home, 'F');
    expect(fills.map(f => f.text)).toEqual(home.map(h => h.text));
    expect(atlas.rasterCount).toBe(6); expect(atlas.repackCount).toBe(1);
    expect(uploads).toEqual([{ y: 0, h: atlas.getSize()[1], premult: true, format: 'r8unorm' }]);
    const before = home.map(h => ({ ...atlas.get(h.text, h.maxWidthPx, h.fontPx, h.fontFamily ?? 'F', h.scaleX ?? 1, h.scaleY ?? 1)! }));
    const v1 = atlas.version;

    // Same set again (a hover rebuild): nothing happens.
    atlas.build(home.map(h => ({ ...h })), 'F');
    expect(fills.length).toBe(6); expect(uploads.length).toBe(1); expect(atlas.version).toBe(v1);

    // Flip to the illustrations grid: only its 4 labels are drawn; the home labels keep their exact entries.
    atlas.build(grid, 'F');
    expect(fills.slice(6).map(f => f.text)).toEqual(grid.map(h => h.text));
    expect(atlas.rasterCount).toBe(10); expect(atlas.repackCount).toBe(1); expect(textures).toBe(1);
    expect(home.map(h => atlas.get(h.text, h.maxWidthPx, h.fontPx, h.fontFamily ?? 'F', h.scaleX ?? 1, h.scaleY ?? 1))).toEqual(before);
    expect(uploads.length).toBe(2);
    expect(uploads[1].h).toBeLessThan(atlas.getSize()[1]);       // a band, not the whole atlas
    expect(atlas.version).toBeGreaterThan(v1);

    // Back home, then to the grid again: free.
    atlas.build(home, 'F'); atlas.build(grid, 'F'); atlas.build([...home, ...grid], 'F');
    expect(fills.length).toBe(10); expect(uploads.length).toBe(2);

    // New labels land where the shelf continues: no cell overlaps another.
    const all = [...home, ...grid].map(h => atlas.get(h.text, h.maxWidthPx, h.fontPx, h.fontFamily ?? 'F', h.scaleX ?? 1, h.scaleY ?? 1)!);
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      const apart = a.u1 <= b.u0 || b.u1 <= a.u0 || a.v1 <= b.v0 || b.v1 <= a.v0;
      expect(apart, `${i} vs ${j}`).toBe(true);
    }
  });

  it('a first build of a set packs it exactly like the pre-additive atlas (same cells, same order)', () => {
    fills.length = 0;
    const atlas = new ShellLabelAtlas(device);
    atlas.build([...home, ...grid], 'F');
    // old placement: SS = 3, lineH = ceil(fpx·1.4·sy), padX = ceil(fpx·0.3), w = ceil(textW·sx) + 2·padX, shelf-packed at 2048
    let cx = 0, cy = 0, rowMax = 0;
    for (const r of [...home, ...grid]) {
      const fpx = r.fontPx * 3, lineH = Math.ceil(fpx * 1.4 * (r.scaleY ?? 1)), padX = Math.ceil(fpx * 0.3);
      const w = Math.ceil(r.text.length * fpx * 0.5 * (r.scaleX ?? 1)) + padX * 2;
      if (cx + w > 2048) { cx = 0; cy += rowMax; rowMax = 0; }
      const e = atlas.get(r.text, r.maxWidthPx, r.fontPx, r.fontFamily ?? 'F', r.scaleX ?? 1, r.scaleY ?? 1)!;
      expect(e.u0 * 2048).toBeCloseTo(cx, 6); expect(e.v0 * atlas.getSize()[1]).toBeCloseTo(cy, 6);
      expect(e.wPx).toBe(w / 3); expect(e.hPx).toBe(lineH / 3);
      const f = fills.find(x => x.text === r.text)!;
      expect(f.x).toBe(cx + padX); expect(f.y).toBe(cy + lineH / 2);
      cx += w; rowMax = Math.max(rowMax, lineH);
    }
  });

  it('invalidate (font load) re-rasterizes the requested set; a full shelf repacks with the current set only', () => {
    fills.length = 0; uploads.length = 0;
    const atlas = new ShellLabelAtlas(device);
    atlas.build(home, 'F');
    atlas.invalidate();
    atlas.build(home, 'F');
    expect(fills.length).toBe(12); expect(atlas.repackCount).toBe(2);

    // Fill well past the accumulation cap with distinct labels (each ~2000 px wide, 68 rows of 135 px → > 4096).
    for (let i = 0; i < 80; i++) atlas.build([req(`${i}`.padStart(40, 'x'), 32)], 'F');
    expect(atlas.getSize()[1]).toBeLessThanOrEqual(4096);
    expect(atlas.repackCount).toBeGreaterThan(2);
    // whatever was dropped, the label asked for last is there, and asking for a dropped one brings it back
    expect(atlas.get('79'.padStart(40, 'x'), 9999, 32, 'F')).not.toBeNull();
    atlas.build(home, 'F');
    for (const h of home) expect(atlas.get(h.text, h.maxWidthPx, h.fontPx, h.fontFamily ?? 'F', h.scaleX ?? 1, h.scaleY ?? 1)).not.toBeNull();
  });
});
