import { describe, it, expect } from 'vitest';

// mobile-parity 7.3b S3: RasterTextureManager.readToCanvas reads back only the given rect, reuses ONE MAP_READ buffer
// and ONE full-size ImageData, and lands the texels at the right place (single `set` when the padded row pitch equals
// the tight one, row-wise sets otherwise). The fake device "GPU" is a CPU texture the copy reads from.
const g = globalThis as Record<string, unknown>;
g.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
g.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
g.GPUMapMode ??= { READ: 1, WRITE: 2 };
class FakeImageData { data: Uint8ClampedArray; constructor(public width: number, public height: number) { this.data = new Uint8ClampedArray(width * height * 4); } }
g.ImageData ??= FakeImageData;

import { RasterTextureManager } from './raster-texture-manager';

function setup(W: number, H: number) {
  const texels = new Uint8Array(W * H * 4);
  for (let i = 0; i < texels.length; i++) texels[i] = (i * 7 + 3) & 255;
  const buffers: Array<{ size: number; data: Uint8Array }> = [];
  let pending: { buf: { data: Uint8Array }; x: number; y: number; w: number; h: number; bpr: number } | null = null;
  const device = {
    createTexture: (d: { size: number[] }) => ({ width: d.size[0], height: d.size[1], destroy() {}, createView: () => ({}) }),
    createBuffer: (d: { size: number }) => {
      const b = {
        size: d.size, data: new Uint8Array(d.size),
        mapAsync: async () => {
          const p = pending!; pending = null;
          for (let r = 0; r < p.h; r++) for (let c = 0; c < p.w * 4; c++) p.buf.data[r * p.bpr + c] = texels[((p.y + r) * W + p.x) * 4 + c];
        },
        getMappedRange: (off = 0, size?: number) => b.data.buffer.slice(off, size !== undefined ? off + size : undefined),
        unmap() {}, destroy() {},
      };
      buffers.push(b);
      return b;
    },
    createCommandEncoder: () => ({
      copyTextureToBuffer: (src: { origin?: { x: number; y: number } }, dst: { buffer: { data: Uint8Array }; bytesPerRow: number }, ext: { width: number; height: number }) => {
        pending = { buf: dst.buffer, x: src.origin?.x ?? 0, y: src.origin?.y ?? 0, w: ext.width, h: ext.height, bpr: dst.bytesPerRow };
      },
      finish: () => ({}),
    }),
    queue: { submit() {}, onSubmittedWorkDone: async () => undefined },
  };
  const mgr = new RasterTextureManager(device as unknown as GPUDevice);
  mgr.ensureTexture(W, H);
  const puts: Array<{ img: FakeImageData; dx: number; dy: number; x: number; y: number; w: number; h: number }> = [];
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({ putImageData: (img: FakeImageData, dx: number, dy: number, x: number, y: number, w: number, h: number) => { puts.push({ img, dx, dy, x, y, w, h }); } }),
  } as unknown as HTMLCanvasElement;
  return { mgr, canvas, texels, buffers, puts, W, H };
}

const texel = (d: Uint8Array | Uint8ClampedArray, W: number, x: number, y: number) => [...d.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];

describe('S3 RasterTextureManager.readToCanvas', () => {
  it('first read is FULL (the canvas is sized), single-set path (64 px wide = 256 B rows)', async () => {
    const s = setup(64, 8);
    await s.mgr.readToCanvas(s.canvas, { x: 5, y: 2, w: 4, h: 3 });   // canvas had to be resized → whole texture
    expect(s.canvas.width).toBe(64);
    expect(s.puts[0]).toMatchObject({ x: 0, y: 0, w: 64, h: 8 });
    expect([...s.puts[0].img.data]).toEqual([...s.texels]);
  });

  it('a rect read copies only the rect, lands it in place, and reuses the buffer + ImageData', async () => {
    const s = setup(50, 12);                                          // 200 B rows → padded to 256: row-wise path
    await s.mgr.readToCanvas(s.canvas);
    const img = s.puts[0].img;
    const nBuf = s.buffers.length;
    img.data.fill(0);                                                 // prove only the rect is (re)written
    await s.mgr.readToCanvas(s.canvas, { x: 7.5, y: 3.2, w: 10, h: 4 });
    const p = s.puts[1];
    expect(p.img).toBe(img);                                          // the same ImageData
    expect(s.buffers.length).toBe(nBuf);                              // the same MAP_READ buffer
    expect(p).toMatchObject({ dx: 0, dy: 0, x: 7, y: 3, w: 11, h: 5 }); // floor / ceil to whole texels
    expect(texel(img.data, s.W, 7, 3)).toEqual(texel(s.texels, s.W, 7, 3));
    expect(texel(img.data, s.W, 17, 7)).toEqual(texel(s.texels, s.W, 17, 7));
    expect(texel(img.data, s.W, 6, 3)).toEqual([0, 0, 0, 0]);         // outside the rect: untouched
    expect(texel(img.data, s.W, 18, 7)).toEqual([0, 0, 0, 0]);
  });

  it('a rect off the texture is clamped; an empty one reads nothing', async () => {
    const s = setup(64, 8);
    await s.mgr.readToCanvas(s.canvas);
    await s.mgr.readToCanvas(s.canvas, { x: -20, y: 6, w: 30, h: 50 });
    expect(s.puts[1]).toMatchObject({ x: 0, y: 6, w: 10, h: 2 });
    await s.mgr.readToCanvas(s.canvas, { x: 100, y: 100, w: 5, h: 5 });
    expect(s.puts).toHaveLength(2);
  });
});
