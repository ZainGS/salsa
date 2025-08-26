import { TextureCache } from "./texture-cache";

export class TextureArrayAtlas {
  private device: GPUDevice;
  private format: GPUTextureFormat = 'rgba8unorm';
  private width: number;
  private height: number;
  private capacity: number;

  private texture!: GPUTexture;
  private view!: GPUTextureView;

  private keyToLayer = new Map<string, number>();
  private inflight = new Map<string, Promise<number>>();
  private next = 1;

  public onRecreated?: (texture: GPUTexture, view: GPUTextureView) => void;

  constructor(device: GPUDevice, width = 1024, height = 1024, layers = 64) {
    this.device = device;
    this.width = width;
    this.height = height;
    this.capacity = Math.max(2, layers);
    this.createTexture(this.capacity);
    this.fillWhiteLayer0();
  }

  private createTexture(layers: number) {
    this.texture = this.device.createTexture({
      size: { width: this.width, height: this.height, depthOrArrayLayers: layers },
      format: this.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.view = this.texture.createView({ dimension: '2d-array' });
  }

  private fillWhiteLayer0() {
    const pixels = new Uint8Array(this.width * this.height * 4);
    pixels.fill(255);
    this.device.queue.writeTexture(
      { texture: this.texture, origin: { x: 0, y: 0, z: 0 } },
      pixels,
      { bytesPerRow: this.width * 4 },
      { width: this.width, height: this.height, depthOrArrayLayers: 1 },
    );
    this.keyToLayer.set('__white__', 0);
  }

  getLayer(key: string): number {
    const idx = this.keyToLayer.get(key);
    const result = idx === undefined ? -1 : idx;
    
    if (result < 0) {
    } else {
    }
    
    return result;
  }

  ensure(
    key: string,
    src?: ImageBitmap | OffscreenCanvas | HTMLCanvasElement,
  ): Promise<number> {
    const ready = this.getLayer(key);
    if (ready >= 0) {
      return Promise.resolve(ready);
    }

    const running = this.inflight.get(key);
    if (running) {
      return running;
    }

    const p = (async () => {
      // Reserve layer immediately to prevent race conditions
      let layer = this.next++;
      
      if (layer >= this.capacity) {
        await this.grow();
        layer = this.next++;
      }

      if (!src) src = await this.loadAndResize(key);

      console.log(`📥 Uploading ${key} to layer ${layer}`);
      this.device.queue.copyExternalImageToTexture(
        { source: src as any },
        { texture: this.texture, origin: { x: 0, y: 0, z: layer } },
        { width: this.width, height: this.height },
      );

      this.keyToLayer.set(key, layer);
      this.inflight.delete(key);
      
      return layer;
    })().catch((e) => {
      this.inflight.delete(key);
      // Don't increment next on failure - let it be reused
      this.next--;
      throw e;
    });

    this.inflight.set(key, p);
    return p;
  }

  private async grow() {
    const oldTex = this.texture;
    const oldCap = this.capacity;
    const oldNext = this.next;

    this.capacity = Math.max(2, oldCap * 2);
    this.createTexture(this.capacity);

    // Copy old layers
    const enc = this.device.createCommandEncoder();
    for (let z = 0; z < oldCap; z++) {
      enc.copyTextureToTexture(
        { texture: oldTex, origin: { x: 0, y: 0, z } },
        { texture: this.texture, origin: { x: 0, y: 0, z } },
        { width: this.width, height: this.height, depthOrArrayLayers: 1 },
      );
    }
    this.device.queue.submit([enc.finish()]);
    oldTex.destroy?.();

    // Refill white layer 0 in new texture
    this.fillWhiteLayer0();
    
    // Restore next counter after growing
    this.next = oldNext;

    // Notify renderer of new texture
    this.onRecreated?.(this.texture, this.view);
  }

  getWidth()  { return this.width; }
  getHeight() { return this.height; }
  getView()   { return this.view; }
  getTexture(){ return this.texture; }

  private async loadAndResize(key: string): Promise<OffscreenCanvas | HTMLCanvasElement> {
    const bmp = await TextureCache.getImageBitmap(key);
    const c = document.createElement('canvas');
    c.width = this.width; 
    c.height = this.height;
    const ctx = c.getContext('2d')!;
    
    // Flip the image vertically to match WebGPU texture coordinate system
    ctx.save();
    ctx.scale(1, -1);  // Flip Y axis
    ctx.translate(0, -this.height);  // Move origin back to top-left
    ctx.drawImage(bmp, 0, 0, this.width, this.height);
    ctx.restore();
    
    return c;
  }
}