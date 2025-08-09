// SDF Text Atlas Manager
export class SDFTextAtlas {
    private device: GPUDevice;
    private atlasTexture: GPUTexture | null = null;
    private atlasSize: number = 1024;
    private charMap: Map<string, CharacterInfo> = new Map();
    private currentX: number = 0;
    private currentY: number = 0;
    private lineHeight: number = 0;

    constructor(device: GPUDevice) {
        this.device = device;
        this.initializeAtlas();
    }

    private initializeAtlas() {
        this.atlasTexture = this.device.createTexture({
            size: { width: this.atlasSize, height: this.atlasSize },
            format: 'r8unorm', // Single channel for SDF
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        });
    }

    // Generate SDF for a character using canvas and distance transform
    private generateCharacterSDF(char: string, fontSize: number, fontFamily: string = 'Arial'): {
        sdfData: Uint8Array,
        width: number,
        height: number,
        metrics: TextMetrics
    } {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d')!;
        
        // Render at high resolution for better SDF quality
        const scale = 4;
        const fontString = `${fontSize * scale}px ${fontFamily}`;
        ctx.font = fontString;
        const metrics = ctx.measureText(char);
        
        const width = Math.ceil(metrics.width) + 16; // Padding for SDF
        const height = fontSize * scale + 16;
        
        canvas.width = width;
        canvas.height = height;
        
        // Clear and render character
        ctx.fillStyle = 'black';           // BLACK background
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = 'white';           // WHITE text
        ctx.font = fontString; // set font again after canvas resize
        ctx.textBaseline = 'middle';
        ctx.fillText(char, 8, height / 2);
        
        // Get image data and convert to SDF
        const imageData = ctx.getImageData(0, 0, width, height);
        const sdfData = this.generateSDF(imageData.data, width, height);
        
        return { sdfData, width, height, metrics };
    }

    // Simple distance transform for SDF generation
    private generateSDF(imageData: Uint8ClampedArray, width: number, height: number): Uint8Array {
        const sdf = new Uint8Array(width * height);
        const maxDistance = 32; // Maximum distance to calculate
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                const pixel = imageData[idx * 4]; // Red channel
                const isInside = pixel < 128;
                
                let minDist = maxDistance;
                
                // Search in a radius around current pixel
                for (let dy = -maxDistance; dy <= maxDistance; dy++) {
                    for (let dx = -maxDistance; dx <= maxDistance; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        
                        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                            const nIdx = ny * width + nx;
                            const nPixel = imageData[nIdx * 4];
                            const nIsInside = nPixel < 128;
                            
                            if (isInside !== nIsInside) {
                                const dist = Math.sqrt(dx * dx + dy * dy);
                                minDist = Math.min(minDist, dist);
                            }
                        }
                    }
                }
                
                // Convert to 0-255 range, with 128 as the edge
                const normalizedDist = Math.min(minDist / maxDistance, 1);
                sdf[idx] = Math.round(128 + (isInside ? -normalizedDist : normalizedDist) * 127);
            }
        }
        
        return sdf;
    }

    public addCharacter(char: string, fontSize: number, fontFamily: string = 'Arial'): CharacterInfo {
    const fontKey = `${char}-${fontSize}-${fontFamily}`;
        if (this.charMap.has(fontKey)) {
            return this.charMap.get(fontKey)!;
        }

        const { sdfData, width, height, metrics } = this.generateCharacterSDF(char, fontSize, fontFamily);
        
        // Check if we need to move to next line in atlas
        if (this.currentX + width > this.atlasSize) {
            this.currentX = 0;
            this.currentY += this.lineHeight;
            this.lineHeight = 0;
        }
        
        // Upload SDF data to atlas texture
        this.device.queue.writeTexture(
            { 
                texture: this.atlasTexture!,
                origin: { x: this.currentX, y: this.currentY }
            },
            sdfData,
            { bytesPerRow: width },
            { width, height }
        );
        
        const charInfo: CharacterInfo = {
            atlasX: this.currentX,
            atlasY: this.currentY,
            width,
            height,
            advance: metrics.width / 4 * (4), // Scale back down
            bearingX: 0,
            bearingY: -height / 8, // Adjust based on actual font metrics
            //bearingY: height / 2
        };
        
        this.charMap.set(fontKey, charInfo);  // Use fontKey instead of char
        this.currentX += width;
        this.lineHeight = Math.max(this.lineHeight, height);
        
        return charInfo;
    }

    public getAtlasTexture(): GPUTexture {
        return this.atlasTexture!;
    }

    public getCharacterInfo(char: string, fontSize: number, fontFamily: string = 'Arial'): CharacterInfo | undefined {
        const fontKey = `${char}-${fontSize}-${fontFamily}`;
        return this.charMap.get(fontKey);
    }

    public getAtlasSize(): number {
        return this.atlasSize;
    }
}

// For production apps, we can consider pre-generating atlases with common characters:

// class PrecomputedSDFAtlas {
//     // Load pre-generated SDF atlas from file
//     // Includes ASCII + common Unicode ranges
//     // Much faster than runtime generation
// }