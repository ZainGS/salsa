export type RGBA = { r: number; g: number; b: number; a?: number };

export class RasterCanvas {
  public width: number;
  public height: number;
  // RGBA8
  private buffer: Uint8ClampedArray;

  // Dirty rect tracking [x0,y0,x1,y1]
  private dirty: number[] | null = null;

  constructor(width: number, height: number, clearColor: RGBA = { r: 255, g: 255, b: 255, a: 255 }) {
    this.width = Math.max(1, width | 0);
    this.height = Math.max(1, height | 0);
    this.buffer = new Uint8ClampedArray(this.width * this.height * 4);
    this.clear(clearColor);
  }

  public getBuffer(): Uint8ClampedArray { return this.buffer; }

  public setPixel(x: number, y: number, rgba: { r: number; g: number; b: number; a: number }) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.buffer[i+0] = rgba.r;
    this.buffer[i+1] = rgba.g;
    this.buffer[i+2] = rgba.b;
    this.buffer[i+3] = rgba.a;
    this.markDirtyRect(x, y, x+1, y+1);
  }

  public getPixel(x: number, y: number): { r: number; g: number; b: number; a: number } | null {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    const i = (y * this.width + x) * 4;
    return { r: this.buffer[i+0], g: this.buffer[i+1], b: this.buffer[i+2], a: this.buffer[i+3] };
  }

  public clear(color: RGBA = { r: 255, g: 255, b: 255, a: 255 }) {
    const w = this.width, h = this.height;
    const buf = this.buffer;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        buf[i+0] = color.r;
        buf[i+1] = color.g;
        buf[i+2] = color.b;
        buf[i+3] = color.a ?? 255;
      }
    }
    this.markDirtyRect(0,0,this.width,this.height);
  }

  private markDirtyRect(x0:number,y0:number,x1:number,y1:number) {
    if (!this.dirty) this.dirty = [x0,y0,x1,y1];
    else {
      this.dirty[0] = Math.min(this.dirty[0], x0);
      this.dirty[1] = Math.min(this.dirty[1], y0);
      this.dirty[2] = Math.max(this.dirty[2], x1);
      this.dirty[3] = Math.max(this.dirty[3], y1);
    }
  }

  public consumeDirtyRect(): { x:number;y:number;w:number;h:number } | null {
    if (!this.dirty) return null;
    const [x0,y0,x1,y1] = this.dirty;
    this.dirty = null;
    return { x: x0|0, y: y0|0, w: Math.max(1, (x1|0) - (x0|0)), h: Math.max(1, (y1|0) - (y0|0)) };
  }

  public resize(newW: number, newH: number, clearColor: RGBA = { r:255,g:255,b:255,a:255 }) {
    const w = Math.max(1, newW|0), h = Math.max(1, newH|0);
    if (w === this.width && h === this.height) return;
    const newBuf = new Uint8ClampedArray(w * h * 4);
    // copy overlapping region
    const copyW = Math.min(this.width, w);
    const copyH = Math.min(this.height, h);
    for (let y = 0; y < copyH; y++) {
      const srcRow = y * this.width * 4;
      const dstRow = y * w * 4;
      newBuf.set(this.buffer.subarray(srcRow, srcRow + copyW * 4), dstRow);
    }
    this.width = w; this.height = h; this.buffer = newBuf;
    if (w !== copyW || h !== copyH) this.clear(clearColor);
    this.markDirtyRect(0,0,w,h);
  }
}
