import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

/** CRT scanlines + vignette overlay. Place full-canvas with multiply/overlay blend. */
function buildScanline(
  size: number,
  spacing: number,
  lineOpacity: number,
  vignette: number,
  curvature: boolean,
  color: string,
): string {
  const S = size;
  const defs: string[] = [];
  const parts: string[] = [];

  // Scanlines (every `spacing` px, a thin dark band).
  const lh = Math.max(1, spacing * 0.5);
  for (let y = 0; y < S; y += spacing) {
    parts.push(`<rect x="0" y="${y.toFixed(1)}" width="${S}" height="${lh.toFixed(1)}" fill="${color}" opacity="${lineOpacity.toFixed(2)}"/>`);
  }

  // Vignette (radial darkening toward the corners).
  if (vignette > 0) {
    defs.push(`<radialGradient id="vig" cx="50%" cy="50%" r="72%"><stop offset="55%" stop-color="${color}" stop-opacity="0"/><stop offset="100%" stop-color="${color}" stop-opacity="${vignette.toFixed(2)}"/></radialGradient>`);
    parts.push(`<rect width="${S}" height="${S}" fill="url(#vig)"/>`);
  }

  // Subtle screen curvature highlight (a bright sheen arc near the top).
  if (curvature) {
    defs.push(`<radialGradient id="sheen" cx="50%" cy="15%" r="60%"><stop offset="0%" stop-color="#ffffff" stop-opacity="0.12"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/></radialGradient>`);
    parts.push(`<rect width="${S}" height="${S}" fill="url(#sheen)"/>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><defs>${defs.join('')}</defs>${parts.join('')}</svg>`;
}

export class ScanlineGenerator implements IEphemeraGenerator {
  readonly typeId = 'scanline:crt';
  readonly categoryId = 'scanline';
  readonly displayName = 'Scanlines / CRT';
  readonly description = 'CRT scanline + vignette overlay. Place full-canvas with a multiply or overlay blend mode.';

  getDefaultParams(): Record<string, unknown> {
    return { size: 512, spacing: 4, lineOpacity: 0.35, vignette: 0.5, curvature: true, color: '#000000' };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'size',        label: 'Size',        type: 'range',  default: 512, min: 128, max: 1024, step: 16, group: 'Size' },
      { key: 'spacing',     label: 'Line spacing', type: 'range', default: 4,   min: 2,  max: 16,   step: 1,   group: 'Scanlines' },
      { key: 'lineOpacity', label: 'Line opacity', type: 'range', default: 0.35, min: 0, max: 1,    step: 0.05, group: 'Scanlines' },
      { key: 'vignette',    label: 'Vignette',     type: 'range', default: 0.5, min: 0,  max: 1,    step: 0.05, group: 'Screen' },
      { key: 'curvature',   label: 'Screen sheen', type: 'toggle', default: true,                              group: 'Screen' },
      { key: 'color',       label: 'Color',        type: 'color', default: '#000000',                          group: 'Color' },
    ];
  }

  generate(p: Record<string, unknown>): string {
    return buildScanline(
      Number(p['size'] ?? 512),
      Number(p['spacing'] ?? 4),
      Math.max(0, Math.min(1, Number(p['lineOpacity'] ?? 0.35))),
      Math.max(0, Math.min(1, Number(p['vignette'] ?? 0.5))),
      Boolean(p['curvature'] ?? true),
      String(p['color'] ?? '#000000'),
    );
  }
}
