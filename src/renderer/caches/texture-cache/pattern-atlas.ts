// pattern-atlas.ts (replace pattern-render-tcache.ts)
import { TextureCache } from "./texture-cache";

export class PatternAtlas {
  private device: GPUDevice;
  private sampler: GPUSampler;

  private width: number;
  private height: number;
  private capacity: number;

  private arrayTex: GPUTexture;
  private arrayView: GPUTextureView;

  private urlToLayer = new Map<string, number>();
  private nextLayer = 0;

  private bindGroupLayout: GPUBindGroupLayout;
  private bindGroup!: GPUBindGroup;

  constructor(device: GPUDevice, width = 256, height = 256, capacity = 64) {
    this.device = device;
    this.width = width;
    this.height = height;
    this.capacity = capacity;

    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });

    this.arrayTex = device.createTexture({
      size: { width, height, depthOrArrayLayers: capacity },
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.arrayView = this.arrayTex.createView({ dimension: "2d-array" });

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } }, // storage buffer (instances) – pipeline will use this
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });

    // dummy storage buffer for initial bindgroup; you’ll set the real one later
    const dummy = device.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE });
    this.rebuildBindGroup(dummy);
  }

  private rebuildBindGroup(storageBuffer: GPUBuffer) {
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: storageBuffer } },
        { binding: 1, resource: this.arrayView },
        { binding: 2, resource: this.sampler },
      ],
    });
  }

  /** Call once after you create your real per-instance storage buffer */
  public setStorageBuffer(storageBuffer: GPUBuffer) {
    this.rebuildBindGroup(storageBuffer);
  }

  public getBindGroup() { return this.bindGroup; }
  public getBindGroupLayout() { return this.bindGroupLayout; }
  public getView() { return this.arrayView; }
  public getSize() { return { width: this.width, height: this.height }; }

  /** Ensure URL is uploaded into the array. Returns its layer index. */
  public async ensure(url: string): Promise<number> {
    if (this.urlToLayer.has(url)) return this.urlToLayer.get(url)!;
    if (this.nextLayer >= this.capacity) throw new Error("PatternAtlas full");

    const bmp = await TextureCache.getImageBitmap(url);

    // If source size differs, you can pre-resize on a canvas; otherwise it will be stretched.
    this.device.queue.copyExternalImageToTexture(
      { source: bmp },
      { texture: this.arrayTex, origin: { x: 0, y: 0, z: this.nextLayer } },
      { width: this.width, height: this.height }
    );

    const layer = this.nextLayer++;
    this.urlToLayer.set(url, layer);
    return layer;
  }

  public getLayerSync(key: string): number {
    return this.urlToLayer.has(key) ? this.urlToLayer.get(key)! : -1;
  }
  public has(key: string): boolean { return this.urlToLayer.has(key); }
}
