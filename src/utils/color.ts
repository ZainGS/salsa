import { RGBA } from "../types/rgba";

export function rgbaToCssString(rgba: RGBA): string {
    const { r, g, b, a } = rgba;
    return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
}

export function hexToRgba(hex: string, alpha: number = 1): RGBA {
    hex = hex.replace(/^#/, '');
    let r, g, b;
    if (hex.length === 3) {
        r = parseInt(hex[0] + hex[0], 16);
        g = parseInt(hex[1] + hex[1], 16);
        b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length === 6) {
        r = parseInt(hex.substring(0, 2), 16);
        g = parseInt(hex.substring(2, 4), 16);
        b = parseInt(hex.substring(4, 6), 16);
    } else {
        throw new Error("Invalid hex color format. Use #RRGGBB or #RGB.");
    }

    return { r: r / 255, g: g / 255, b: b / 255, a: alpha };
}