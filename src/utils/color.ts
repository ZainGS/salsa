import { RGBA } from "../types/rgba";

export function rgbaToCssString(rgba: RGBA): string {
    const { r, g, b, a } = rgba;
    return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
}