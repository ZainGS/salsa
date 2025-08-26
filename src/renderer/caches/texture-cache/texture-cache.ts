`
You have two caching paths (both are useful):
getImageBitmap(url) — fetches/caches ImageBitmap; this is what you feed to the atlas (copyExternalImageToTexture).
getTexture(device, url) — fetches/caches standalone GPUTexture; this was your old path (one texture per pattern). You can keep it for legacy rendering, but the array atlas path is what you’ll use for batching.
If you fully migrate to the atlas, most of your new textured draws should go through getImageBitmap → TextureArrayAtlas.ensure.
`
export class TextureCache {
    private static textures: Map<string, GPUTexture> = new Map();
    private static pendingTextures: Map<string, Promise<GPUTexture>> = new Map();
    private static bitmaps = new Map<string, ImageBitmap>();
    private static pendingBitmaps = new Map<string, Promise<ImageBitmap>>();

    static async getImageBitmap(url: string): Promise<ImageBitmap> {
        if (this.bitmaps.has(url)) return this.bitmaps.get(url)!;
        if (this.pendingBitmaps.has(url)) return this.pendingBitmaps.get(url)!;

        const p = (async () => {
        const resp = await fetch(url);
        const blob = await resp.blob();
        const bmp = await createImageBitmap(blob);
        this.bitmaps.set(url, bmp);
        return bmp;
        })();
        this.pendingBitmaps.set(url, p);
        try { return await p; } finally { this.pendingBitmaps.delete(url); }
    }

    static async getTexture(device: GPUDevice, url: string): Promise<GPUTexture> {
        if (this.textures.has(url)) {
            return this.textures.get(url)!;  // Return cached texture if it exists
        }

        if (this.pendingTextures.has(url)) {
            return await this.pendingTextures.get(url)!;  // Await in-progress request
        }
        
        // Load texture and store the promise while it's loading
        const texturePromise = loadTexture(device, url);
        this.pendingTextures.set(url, texturePromise);

        try {
            const texture = await texturePromise;
            this.textures.set(url, texture);  // Store final texture
            return texture;
        } finally {
            this.pendingTextures.delete(url); // Remove from pending when done
        }
    }
}

async function loadTexture(device: GPUDevice, url: string): Promise<GPUTexture> {
    const response = await fetch(url);
    const blob = await response.blob();
    const imageBitmap = await createImageBitmap(blob);

    const texture = device.createTexture({
        size: [imageBitmap.width, imageBitmap.height, 1],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    device.queue.copyExternalImageToTexture(
        { source: imageBitmap },
        { texture: texture },
        [imageBitmap.width, imageBitmap.height, 1]
    );

    return texture;
}
