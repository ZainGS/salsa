export class TextureCache {
    private static textures: Map<string, GPUTexture> = new Map();
    private static pendingTextures: Map<string, Promise<GPUTexture>> = new Map();

    static async getTexture(device: GPUDevice, url: string): Promise<GPUTexture> {
        if (this.textures.has(url)) {
            return this.textures.get(url)!;  // ✅ Return cached texture if it exists
        }

        if (this.pendingTextures.has(url)) {
            return await this.pendingTextures.get(url)!;  // ✅ Await in-progress request
        }
        
        // Load texture and store the promise while it's loading
        const texturePromise = loadTexture(device, url);
        this.pendingTextures.set(url, texturePromise);

        try {
            const texture = await texturePromise;
            this.textures.set(url, texture);  // ✅ Store final texture
            return texture;
        } finally {
            this.pendingTextures.delete(url); // ✅ Remove from pending when done
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
