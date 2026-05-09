/**
 * TextureLibrary — Manages shared GPU textures for 3D mesh materials.
 *
 * Textures are uploaded once and referenced by ID. Multiple meshes can
 * reference the same texture entry, avoiding duplicate GPU uploads.
 * Metadata (id, name, size) is serializable for document persistence;
 * the actual GPUTexture is re-uploaded on document load.
 */

import { nanoid } from 'nanoid';

export interface TextureEntry {
  id: string;
  name: string;
  width: number;
  height: number;
  gpuTexture: GPUTexture;
  /** Base64 data URL captured at upload time — used for document serialization. */
  dataUrl?: string;
}

export interface TextureEntryMeta {
  id: string;
  name: string;
  width: number;
  height: number;
}

export class TextureLibrary {
  private device: GPUDevice;
  private entries = new Map<string, TextureEntry>();

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /**
   * Upload a texture from a File, Blob, or ImageBitmap and add it to the library.
   * Returns the new entry's ID.
   */
  async upload(source: File | Blob | ImageBitmap, name?: string): Promise<string> {
    const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source);

    const gpuTexture = this.device.createTexture({
      size: [bitmap.width, bitmap.height, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture: gpuTexture },
      [bitmap.width, bitmap.height],
    );

    const id = nanoid();
    const entryName = name ?? (source instanceof File ? source.name : `Texture ${this.entries.size + 1}`);
    const dataUrl = await TextureLibrary._bitmapToDataUrl(bitmap);

    this.entries.set(id, { id, name: entryName, width: bitmap.width, height: bitmap.height, gpuTexture, dataUrl });
    return id;
  }

  /** Re-upload from an ImageBitmap with a known ID (used when restoring from serialized state). */
  async restoreFromBitmap(id: string, bitmap: ImageBitmap, name: string, knownDataUrl?: string): Promise<void> {
    const existing = this.entries.get(id);
    if (existing) existing.gpuTexture.destroy();

    const gpuTexture = this.device.createTexture({
      size: [bitmap.width, bitmap.height, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture: gpuTexture },
      [bitmap.width, bitmap.height],
    );

    // Skip re-encoding if the caller already has the data URL (e.g. restoring from JSON).
    const dataUrl = knownDataUrl ?? await TextureLibrary._bitmapToDataUrl(bitmap);
    this.entries.set(id, { id, name, width: bitmap.width, height: bitmap.height, gpuTexture, dataUrl });
  }

  /** Restore all entries from a serialized data snapshot (e.g., from a saved document). */
  async restoreFromJSON(data: { entries: (TextureEntryMeta & { dataUrl?: string })[] }): Promise<void> {
    await Promise.all(
      (data.entries ?? []).map(async (entry) => {
        if (!entry.dataUrl) return;
        try {
          const response = await fetch(entry.dataUrl);
          const blob = await response.blob();
          const bitmap = await createImageBitmap(blob);
          await this.restoreFromBitmap(entry.id, bitmap, entry.name, entry.dataUrl);
        } catch (e) {
          console.warn(`TextureLibrary: failed to restore "${entry.name}"`, e);
        }
      }),
    );
  }

  private static async _bitmapToDataUrl(bitmap: ImageBitmap): Promise<string | undefined> {
    try {
      const offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = offscreen.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const blob = await offscreen.convertToBlob({ type: 'image/webp', quality: 0.85 });
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch {
      return undefined;
    }
  }

  getTexture(id: string): GPUTexture | null {
    return this.entries.get(id)?.gpuTexture ?? null;
  }

  getEntry(id: string): TextureEntry | null {
    return this.entries.get(id) ?? null;
  }

  listEntries(): TextureEntry[] {
    return Array.from(this.entries.values());
  }

  rename(id: string, name: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.name = name;
    return true;
  }

  remove(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.gpuTexture.destroy();
    this.entries.delete(id);
    return true;
  }

  /** Metadata-only snapshot (no image data). */
  toJSON(): { entries: TextureEntryMeta[] } {
    return {
      entries: Array.from(this.entries.values()).map(e => ({
        id: e.id,
        name: e.name,
        width: e.width,
        height: e.height,
      })),
    };
  }

  /** Full snapshot including base64 data URLs — use this for document save/load. */
  toJSONWithData(): { entries: (TextureEntryMeta & { dataUrl?: string })[] } {
    return {
      entries: Array.from(this.entries.values()).map(e => ({
        id: e.id,
        name: e.name,
        width: e.width,
        height: e.height,
        dataUrl: e.dataUrl,
      })),
    };
  }

  destroy(): void {
    for (const entry of this.entries.values()) entry.gpuTexture.destroy();
    this.entries.clear();
  }
}
