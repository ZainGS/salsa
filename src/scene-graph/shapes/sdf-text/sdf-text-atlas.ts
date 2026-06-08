import { SDFGlyphCompute } from "./sdf-glyph-compute";

// SDF Text Atlas Manager
export class SDFTextAtlas {
  private device: GPUDevice;
  public supersample = 8;

	private retireBuckets: GPUTexture[][] = [[], []];
	private retireCursor = 0;
	private scheduleRetire(tex?: GPUTexture | null) {
		if (!tex) return;
		this.retireBuckets[this.retireCursor].push(tex);
	}

  private atlasTexture: GPUTexture | null = null;
  private atlasSize: number = 1024;
  private static readonly INITIAL_SIZE = 1024;

  // keep a small gutter (2–4 texels)
  private static readonly GUTTER = 4;

  private charMap: Map<string, CharacterInfo> = new Map();
  private currentX: number = 0;
  private currentY: number = 0;
  private lineHeight: number = 0;
  public glyphCompute: SDFGlyphCompute;

  // notify the app when we recreate the atlas, so you can rebuild bind groups, etc.
  public onAtlasRecreated?: (newTexture: GPUTexture, newSize: number) => void;
  public version = 0; // <- bump on every replace

  constructor(device: GPUDevice) {
    this.device = device;
    this.glyphCompute = new SDFGlyphCompute(device);
    this.replaceAtlas(this.createAtlas(this.atlasSize), this.atlasSize, /*clearLayout*/ true);
  }

  // ---- helpers -------------------------------------------------------------

  private createAtlas(size: number): GPUTexture {
    const tex = this.device.createTexture({
      label: `SDFAtlas_${size}`,
      size: { width: size, height: size },
      format: "rgba8unorm",
      // no need for RENDER_ATTACHMENT on the atlas
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC,
      mipLevelCount: 1,
    });
    return tex;
  }

  public async sweepComputeTemps(queue: GPUQueue) {
    await this.glyphCompute.sweepComputeTemps(queue);
  }

  // grow to at least newSize; keep layout & charMap
  private growAtlas(newSize: number) {
		this.version++;
		if (!this.atlasTexture) return;
 	  if (newSize <= this.atlasSize) return; // no-op

    const newTex = this.createAtlas(newSize);

    // copy old -> new at (0,0)
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToTexture(
        { texture: this.atlasTexture! },
        { texture: newTex },
        { width: this.atlasSize, height: this.atlasSize, depthOrArrayLayers: 1 }
    );
    this.device.queue.submit([enc.finish()]);

    const old = this.atlasTexture!;
    this.atlasTexture = newTex;
    this.atlasSize = newSize;

    // rebind the sampler/bindgroup; UVs & charMap remain valid
    this.onAtlasRecreated?.(newTex, newSize);

    // destroy old after GPU work completes
    this.scheduleRetire(old); // <- retire old, destroy next frame in sweepRetired()
  }

  /** Call once per frame AFTER you submit the frame. */
	public async sweepRetired() {
		// flip bucket so anything scheduled THIS frame
		// won’t be destroyed until next sweep
		this.retireCursor ^= 1;

		// fence all work submitted so far (this frame’s submit)
		this.device.queue.onSubmittedWorkDone();

		const bucket = this.retireBuckets[this.retireCursor];
		for (const t of bucket) { try { t.destroy(); } catch {} }
		bucket.length = 0;
	}

  private replaceAtlas(newTex: GPUTexture, newSize: number, clearLayout: boolean) {
    const old = this.atlasTexture;
    this.atlasTexture = newTex;
    this.atlasSize = newSize;
    this.version++;

    if (clearLayout) {
      this.currentX = 0;
      this.currentY = 0;
      this.lineHeight = 0;
      this.charMap.clear();
    }

    this.onAtlasRecreated?.(newTex, newSize);
    this.scheduleRetire(old); // <- DON’T destroy here; retire for next frame
  }

  private initializeAtlas() {
    this.replaceAtlas(this.createAtlas(this.atlasSize), this.atlasSize, /*clear*/ true);
  }

  // Ensure there is space for a glyph of given size (without writing yet).
	private ensureSpace(glyphW: number, glyphH: number) {
		const G = SDFTextAtlas.GUTTER;
		const packedW = glyphW + 2 * G;
		const packedH = glyphH + 2 * G;

		// wrap to next row if needed
		if (this.currentX + packedW > this.atlasSize) {
			this.currentX = 0;
			this.currentY += this.lineHeight;
			this.lineHeight = 0;
		}

		// make sure the new row fits vertically; grow until it does
		let targetSize = this.atlasSize;
		while (this.currentY + packedH > targetSize) targetSize *= 2;
		if (targetSize > this.atlasSize) this.growAtlas(targetSize);
	}

  private mask = new OffscreenCanvas(1, 1);
  private ctx = this.mask.getContext('2d')!;
  private ensure(w:number,h:number){
    if (this.mask.width!==w || this.mask.height!==h) {
      this.mask.width = w;
      this.mask.height = h; // resets 2D context state -> re-apply font/fill styles
    }
  }
  // ---- CPU mask (now OffscreenCanvas, no DOM) ----------------------------
private rasterizeGlyphMask(
  char: string,
  fontSize: number,
  fontFamily: string = "Arial"
): {
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  metrics: TextMetrics;
} {
  const scale = this.supersample;
  const fontString = `${fontSize * scale}px ${fontFamily}`;

  this.ctx.font = fontString;
  const metrics = this.ctx.measureText(char);
  const width  = Math.ceil(metrics.width) + 128;
  const height = Math.ceil(fontSize * scale) + 64;

  this.ensure(width, height);
  const ctx = this.ctx;
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "white";
  ctx.font = fontString;
  ctx.textBaseline = "middle";
  ctx.fillText(char, 8, height / 2);

  return { canvas: this.mask, width, height, metrics }; // <-- OffscreenCanvas
}

  // ---- PUBLIC API ----------------------------------------------------------
  public addCharacter(char: string, fontSize: number, fontFamily: string = "Arial"): CharacterInfo {
  const scale = this.supersample;
  const fontKey = `${char}-${fontSize}-${fontFamily}`;
  if (this.charMap.has(fontKey)) return this.charMap.get(fontKey)!;

  const { canvas, width, height, metrics } = this.rasterizeGlyphMask(char, fontSize, fontFamily);

  // ---- PACKING uses ATLAS (texel) size ----
  this.ensureSpace(width, height);
  const G = SDFTextAtlas.GUTTER;
  const packedWidth  = width  + 2 * G;
  const packedHeight = height + 2 * G;

  if (this.currentX + packedWidth > this.atlasSize) {
    this.currentX = 0;
    this.currentY += this.lineHeight;
    this.lineHeight = 0;
  }

  const writeX = this.currentX + G;
  const writeY = this.currentY + G;

  // ---- SDF compute writes in ATLAS pixels ----
  this.glyphCompute.run({
    canvas,
    width, 
    height,
    atlasTexture: this.atlasTexture!,
    atlasX: writeX,
    atlasY: writeY,
    threshold: 0.5,
    maxDistPx: 32 * scale,       // << keep visual sharpness constant
  });

  // ---- DISPLAY metrics are in screen px (NOT supersampled) ----
  const displayAdvance = metrics.width / scale;
  const displayWidth   = width   / scale;
  const displayHeight  = height  / scale;

  const charInfo: CharacterInfo = {
    // atlas-space (for UVs)
    atlasX: writeX,
    atlasY: writeY,
    texWidth: width,            // NEW: atlas texel width
    texHeight: height,          // NEW: atlas texel height

    // display-space (for quad size / cursor advance)
    width: displayWidth,        // CHANGED: screen px width
    height: displayHeight,      // CHANGED: screen px height
    advance: displayAdvance,
    bearingX: 0,
    bearingY: -(displayHeight / 8), // quick placeholder; use real font metrics if available
  };

  this.charMap.set(fontKey, charInfo);

  this.currentX += packedWidth;
  this.lineHeight = Math.max(this.lineHeight, packedHeight);

  return charInfo;
}

  public getAtlasTexture(): GPUTexture {
    return this.atlasTexture!;
  }

  public getCharacterInfo(
    char: string,
    fontSize: number,
    fontFamily: string = "Arial"
  ): CharacterInfo | undefined {
    const fontKey = `${char}-${fontSize}-${fontFamily}`;
    return this.charMap.get(fontKey);
  }

  public getAtlasSize(): number {
    return this.atlasSize;
  }

  /**
   * Wipe the glyph map and reset the packing cursor, replacing the GPU texture
   * with a fresh one at the initial 1024 size. Does NOT bump version — the caller
   * must repopulate by calling refreshText() on all live SDFText shapes, then call
   * bumpVersion() so handleAtlasChangeIfNeeded rebuilds the bind group.
   */
  public compact(): void {
    this.charMap.clear();
    this.currentX = 0;
    this.currentY = 0;
    this.lineHeight = 0;
    const fresh = this.createAtlas(SDFTextAtlas.INITIAL_SIZE);
    this.scheduleRetire(this.atlasTexture);
    this.atlasTexture = fresh;
    this.atlasSize = SDFTextAtlas.INITIAL_SIZE;
    // onAtlasRecreated intentionally not fired here — caller repopulates first,
    // then calls bumpVersion() which triggers handleAtlasChangeIfNeeded.
  }

  /** Signal that the atlas content has changed. Used after compact + repopulate. */
  public bumpVersion(): void {
    this.version++;
  }

	// Old CPU-driven render
	// public addCharacter(char: string, fontSize: number, fontFamily: string = 'Arial'): CharacterInfo {
  //   const fontKey = `${char}-${fontSize}-${fontFamily}`;
  //       if (this.charMap.has(fontKey)) {
  //           return this.charMap.get(fontKey)!;
  //       }

  //       const { sdfData, width, height, metrics } = this.generateCharacterSDF(char, fontSize, fontFamily);
        
  //       // Check if we need to move to next line in atlas
  //       if (this.currentX + width > this.atlasSize) {
  //           this.currentX = 0;
  //           this.currentY += this.lineHeight;
  //           this.lineHeight = 0;
  //       }
        
  //       // Upload SDF data to atlas texture
  //       this.device.queue.writeTexture(
  //           { 
  //               texture: this.atlasTexture!,
  //               origin: { x: this.currentX, y: this.currentY }
  //           },
  //           sdfData,
  //           { bytesPerRow: width },
  //           { width, height }
  //       );
        
  //       const charInfo: CharacterInfo = {
  //           atlasX: this.currentX,
  //           atlasY: this.currentY,
  //           width,
  //           height,
  //           advance: metrics.width / 4 * (4), // Scale back down
  //           bearingX: 0,
  //           bearingY: -height / 8, // Adjust based on actual font metrics
  //           //bearingY: height / 2
  //       };
        
  //       this.charMap.set(fontKey, charInfo);  // Use fontKey instead of char
  //       this.currentX += width;
  //       this.lineHeight = Math.max(this.lineHeight, height);
        
  //       return charInfo;
  //   }

	// Generate SDF for a character using canvas and distance transform
    // private generateCharacterSDF(char: string, fontSize: number, fontFamily: string = 'Arial'): {
    //     sdfData: Uint8Array,
    //     width: number,
    //     height: number,
    //     metrics: TextMetrics
    // } {
    //     const canvas = document.createElement('canvas');
    //     const ctx = canvas.getContext('2d')!;
        
    //     // Render at high resolution for better SDF quality
    //     const scale = 8;
    //     const fontString = `${fontSize * scale}px ${fontFamily}`;
    //     ctx.font = fontString;
    //     const metrics = ctx.measureText(char);
        
    //     const width = Math.ceil(metrics.width) + 16; // Padding for SDF
    //     const height = fontSize * scale + 16;
        
    //     canvas.width = width;
    //     canvas.height = height;
        
    //     // Clear and render character
    //     ctx.fillStyle = 'black';           // BLACK background
    //     ctx.fillRect(0, 0, width, height);
    //     ctx.fillStyle = 'white';           // WHITE text
    //     ctx.font = fontString; // set font again after canvas resize
    //     ctx.textBaseline = 'middle';
    //     ctx.fillText(char, 8, height / 2);
        
    //     // Get image data and convert to SDF
    //     const imageData = ctx.getImageData(0, 0, width, height);
    //     const sdfData = this.generateSDF(imageData.data, width, height);
        
    //     return { sdfData, width, height, metrics };
    // }

    // // Simple distance transform for SDF generation
    // private generateSDF(imageData: Uint8ClampedArray, width: number, height: number): Uint8Array {
    //     const sdf = new Uint8Array(width * height);
    //     const maxDistance = 32; // Maximum distance to calculate
        
    //     for (let y = 0; y < height; y++) {
    //         for (let x = 0; x < width; x++) {
    //             const idx = y * width + x;
    //             const pixel = imageData[idx * 4]; // Red channel
    //             const isInside = pixel < 128;
                
    //             let minDist = maxDistance;
                
    //             // Search in a radius around current pixel
    //             for (let dy = -maxDistance; dy <= maxDistance; dy++) {
    //                 for (let dx = -maxDistance; dx <= maxDistance; dx++) {
    //                     const nx = x + dx;
    //                     const ny = y + dy;
                        
    //                     if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
    //                         const nIdx = ny * width + nx;
    //                         const nPixel = imageData[nIdx * 4];
    //                         const nIsInside = nPixel < 128;
                            
    //                         if (isInside !== nIsInside) {
    //                             const dist = Math.sqrt(dx * dx + dy * dy);
    //                             minDist = Math.min(minDist, dist);
    //                         }
    //                     }
    //                 }
    //             }
                
    //             // Convert to 0-255 range, with 128 as the edge
    //             const normalizedDist = Math.min(minDist / maxDistance, 1);
    //             sdf[idx] = Math.round(128 + (isInside ? -normalizedDist : normalizedDist) * 127);
    //         }
    //     }
        
    //     return sdf;
    // }
}

