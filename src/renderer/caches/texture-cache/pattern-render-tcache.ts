// pattern-render-tcache.ts
import { Pattern } from "../../../scene-graph/shapes/pattern";
import { TextureCache } from "./texture-cache";

const MAX_PATTERNS = 1;

export class PatternTextureCache {
  private textureViews: (GPUTextureView | null)[] = new Array(MAX_PATTERNS).fill(null);
  private patternIndices: Map<string, number> = new Map();
  private sampler: GPUSampler;
  private bindGroup: GPUBindGroup | null = null;
  private bindGroupLayout: GPUBindGroupLayout;

  constructor(private device: GPUDevice) {
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });

    // We'll need the same layout in your pipeline manager
    this.bindGroupLayout = device.createBindGroupLayout({
        entries: [
          ...Array.from({ length: MAX_PATTERNS }, (_, i) => ({
            binding: i,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: "float" },
          })),
          {
            binding: MAX_PATTERNS,
            visibility: GPUShaderStage.FRAGMENT,
            sampler: { type: "filtering" },
          },
        ] as GPUBindGroupLayoutEntry[], // Force the correct type here
      });

    // Initialize dummy textures
    for (let i = 0; i < MAX_PATTERNS; i++) {
      this.textureViews[i] = this.createDummyTextureView();
    }

    this.rebuildBindGroup();
  }

  private createDummyTextureView(): GPUTextureView {
    const dummyTexture = this.device.createTexture({
      size: [1, 1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    const whitePixel = new Uint8Array([255, 255, 255, 255]);
    this.device.queue.writeTexture(
      { texture: dummyTexture },
      whitePixel,
      { bytesPerRow: 4 },
      { width: 1, height: 1, depthOrArrayLayers: 1 }
    );

    return dummyTexture.createView();
  }

  async registerPattern(pattern: Pattern): Promise<void> {
    const url = pattern['_patternUrl'];
    if (this.patternIndices.has(url)) {
      pattern.patternIndex = this.patternIndices.get(url)!;
      return;
    }

    const index = this.patternIndices.size;
    if (index >= MAX_PATTERNS) {
      console.warn(`PatternTextureCache: Max texture limit of ${MAX_PATTERNS} reached.`);
      return;
    }

    const texture = await TextureCache.getTexture(this.device, url);
    const view = texture.createView();

    this.textureViews[index] = view;
    this.patternIndices.set(url, index);
    pattern.patternIndex = index;
    pattern.texture = texture;

    this.rebuildBindGroup();
  }

  private rebuildBindGroup() {
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        // One entry per texture binding
        ...this.textureViews.map((view, i) => ({
          binding: i,
          resource: view!,
        })),
        {
          binding: MAX_PATTERNS, // Sampler goes after textures
          resource: this.sampler,
        },
      ],
    });
  }

  getBindGroup(): GPUBindGroup {
    if (!this.bindGroup) throw new Error("Pattern bind group not ready");
    return this.bindGroup;
  }

  getBindGroupLayout(): GPUBindGroupLayout {
    return this.bindGroupLayout;
  }
}