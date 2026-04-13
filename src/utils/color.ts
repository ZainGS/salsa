import { RGBA } from "../types/rgba";

export function rgbaToCssString(rgba: RGBA): string {
    const { r, g, b, a } = rgba;
    return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
}

/**
 * Convert RGB (0-1 each) to HSB/HSV (h: 0-1, s: 0-1, b: 0-1).
 */
export function rgbToHsb(r: number, g: number, b: number): [number, number, number] {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    const s = max === 0 ? 0 : d / max;
    const v = max;
    if (d > 0) {
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
    }
    return [h, s, v];
}

/**
 * Convert HSB/HSV (h: 0-1, s: 0-1, b: 0-1) to RGB (0-1 each).
 */
export function hsbToRgb(h: number, s: number, v: number): [number, number, number] {
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    switch (i % 6) {
        case 0: return [v, t, p];
        case 1: return [q, v, p];
        case 2: return [p, v, t];
        case 3: return [p, q, v];
        case 4: return [t, p, v];
        case 5: return [v, p, q];
        default: return [v, t, p];
    }
}

export function hexToRgba(hex: string, alpha: number = 1): RGBA {
    hex = hex.replace(/^#/, '');
    let r: number, g: number, b: number;
    if (hex.length === 3) {
        r = parseInt(hex[0] + hex[0], 16);
        g = parseInt(hex[1] + hex[1], 16);
        b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length === 6) {
        r = parseInt(hex.substring(0, 2), 16);
        g = parseInt(hex.substring(2, 4), 16);
        b = parseInt(hex.substring(4, 6), 16);
    } else if (hex.length === 8) {
        r = parseInt(hex.substring(0, 2), 16);
        g = parseInt(hex.substring(2, 4), 16);
        b = parseInt(hex.substring(4, 6), 16);
        alpha = parseInt(hex.substring(6, 8), 16) / 255;
    } else {
        throw new Error("Invalid hex color format. Use #RRGGBB, #RGB, or #RRGGBBAA.");
    }

    // Guard against NaN from invalid hex characters
    if (isNaN(r) || isNaN(g) || isNaN(b) || isNaN(alpha)) {
        console.warn(`Invalid hex color value: #${hex}, defaulting to black`);
        return { r: 0, g: 0, b: 0, a: 1 };
    }

    return { r: r / 255, g: g / 255, b: b / 255, a: alpha };
}