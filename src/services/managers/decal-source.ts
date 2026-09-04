import type { DecalSource } from './decal-geometry';
import type { EphemeraService } from '../ephemera/ephemera-service';

/**
 * Resolve a {@link DecalSource} (a procedural ephemera SVG, or an uploaded image dataURL) to an
 * `ImageBitmap`. Shared by the decal subsystem (Mode A quads + Mode B baking) AND GARP skin
 * resolution — hence a free function taking the {@link EphemeraService} rather than a method on any
 * one owner. Returns null on any failure (caller falls back to a placeholder).
 */
export async function resolveDecalBitmap(source: DecalSource, ephemera: EphemeraService): Promise<ImageBitmap | null> {
    try {
        if (source.kind === 'ephemera') {
            // ★ Rasterise the SVG via an <img> ELEMENT → canvas (the same robust route the 2D ephemera
            // overlay uses). `createImageBitmap(svgBlob, …)` is unreliable on SVG in Chrome — it returned
            // blank/grey. An <img> renders the SVG faithfully, then the CANVAS bitmap always decodes.
            const svg = ephemera.generate(source.typeId, source.params);
            const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
            try {
                const img = new Image();
                await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('svg')); img.src = url; });
                const c = new OffscreenCanvas(512, 512);
                const ctx = c.getContext('2d');
                if (!ctx) return null;
                ctx.clearRect(0, 0, 512, 512);
                ctx.drawImage(img, 0, 0, 512, 512);
                return await createImageBitmap(c);
            } finally { URL.revokeObjectURL(url); }
        }
        const blob = await (await fetch(source.dataUrl)).blob();
        return await createImageBitmap(blob);
    } catch { return null; }
}
