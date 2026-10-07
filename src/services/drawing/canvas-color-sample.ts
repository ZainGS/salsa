/**
 * Eyedropper (UI review 2026-10-07 §3 #10): one pixel of the FINAL frame — what the user sees on the canvas
 * (raster layers, vector shapes, 3D, post effects, overlays) — read from WebGPURenderer.captureRealFrame's readback.
 */

/** The readback captureRealFrame returns (RGBA order, premultiplied alpha). */
export interface FramePixels { rgba: Uint8ClampedArray; width: number; height: number }

export interface SampledColor {
    /** 0..255, alpha un-premultiplied */
    r: number; g: number; b: number;
    /** 0..1 */
    a: number;
    /** #rrggbb */
    hex: string;
}

const hex2 = (v: number): string => v.toString(16).padStart(2, '0');

/**
 * The colour at a CSS-pixel point of the canvas (`cssX`, `cssY` from its top-left; `cssW` × `cssH` its CSS size), or
 * null off the frame. The backing store may be bigger than the CSS box (device pixel ratio / resolution scale), so the
 * point is mapped proportionally. Premultiplied colour is divided back by alpha; a fully transparent pixel reads as
 * black with a = 0.
 */
export function sampleFramePixel(frame: FramePixels, cssX: number, cssY: number, cssW: number, cssH: number): SampledColor | null {
    if (!(cssW > 0) || !(cssH > 0) || frame.width <= 0 || frame.height <= 0) return null;
    if (cssX < 0 || cssY < 0 || cssX >= cssW || cssY >= cssH) return null;
    const px = Math.min(frame.width - 1, Math.floor(cssX * frame.width / cssW));
    const py = Math.min(frame.height - 1, Math.floor(cssY * frame.height / cssH));
    const i = (py * frame.width + px) * 4;
    const a8 = frame.rgba[i + 3];
    const un = (v: number) => (a8 > 0 && a8 < 255 ? Math.min(255, Math.round(v * 255 / a8)) : a8 === 0 ? 0 : v);
    const r = un(frame.rgba[i]), g = un(frame.rgba[i + 1]), b = un(frame.rgba[i + 2]);
    return { r, g, b, a: a8 / 255, hex: '#' + hex2(r) + hex2(g) + hex2(b) };
}
