import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

/** Iridescent foil seal / hologram sticker — the "Original" / "PROMO" holo circles. */
function buildHoloSeal(
  size: number,
  hueShift: number,
  scallops: number,
  shineCount: number,
  text: string,
  bgColor: string,
): string {
  const S = size;
  const cx = S / 2, cy = S / 2;
  const r = S * 0.46;
  const defs: string[] = [];
  const parts: string[] = [];

  // Iridescent radial gradient (rainbow stops, hue-shifted).
  const stops = 7;
  const gradStops: string[] = [];
  for (let i = 0; i <= stops; i++) {
    const hue = (hueShift + (i / stops) * 360) % 360;
    gradStops.push(`<stop offset="${((i / stops) * 100).toFixed(0)}%" stop-color="hsl(${hue.toFixed(0)},85%,65%)"/>`);
  }
  defs.push(`<radialGradient id="holo" cx="40%" cy="35%" r="75%">${gradStops.join('')}</radialGradient>`);

  // Scalloped foil edge (star-ish circle).
  if (scallops > 2) {
    const n = scallops * 2;
    const pts: string[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const rad = i % 2 === 0 ? r : r * 0.9;
      pts.push(`${(cx + Math.cos(a) * rad).toFixed(1)},${(cy + Math.sin(a) * rad).toFixed(1)}`);
    }
    parts.push(`<polygon points="${pts.join(' ')}" fill="url(#holo)"/>`);
  } else {
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="url(#holo)"/>`);
  }

  // Inner ring + center disc.
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${(r * 0.7).toFixed(1)}" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="${(S * 0.01).toFixed(1)}"/>`);
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${(r * 0.55).toFixed(1)}" fill="rgba(255,255,255,0.18)"/>`);

  // Shine streaks (rotated translucent wedges).
  for (let i = 0; i < shineCount; i++) {
    const a = (i / shineCount) * 360 + hueShift;
    parts.push(`<rect x="${cx - r}" y="${(cy - S * 0.012).toFixed(1)}" width="${(r * 2).toFixed(1)}" height="${(S * 0.024).toFixed(1)}" fill="rgba(255,255,255,0.35)" transform="rotate(${a.toFixed(0)},${cx},${cy})"/>`);
  }

  // Optional center label.
  if (text) {
    parts.push(`<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-family="Arial, sans-serif" font-weight="bold" font-size="${(S * 0.12).toFixed(0)}" fill="rgba(20,20,40,0.85)">${text.replace(/[<&>]/g, '')}</text>`);
  }

  const bg = bgColor !== 'transparent' ? `<rect width="${S}" height="${S}" fill="${bgColor}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><defs>${defs.join('')}</defs>${bg}${parts.join('')}</svg>`;
}

export class HoloSealGenerator implements IEphemeraGenerator {
  readonly typeId = 'holo-seal:standard';
  readonly categoryId = 'holo-seal';
  readonly displayName = 'Holographic Seal';
  readonly description = 'Iridescent foil seal / hologram sticker with a scalloped edge and shine streaks.';

  getDefaultParams(): Record<string, unknown> {
    return { size: 200, hueShift: 200, scallops: 16, shineCount: 4, text: '', bgColor: 'transparent' };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'size',       label: 'Size',      type: 'range',  default: 200, min: 64, max: 400, step: 4,  group: 'Size' },
      { key: 'hueShift',   label: 'Hue shift', type: 'range',  default: 200, min: 0,  max: 360, step: 5,  group: 'Holo' },
      { key: 'scallops',   label: 'Scallops',  type: 'range',  default: 16,  min: 0,  max: 32,  step: 1,  group: 'Holo' },
      { key: 'shineCount', label: 'Shine streaks', type: 'range', default: 4, min: 0, max: 8,  step: 1,  group: 'Holo' },
      { key: 'text',       label: 'Center text', type: 'text', default: '',                              group: 'Text' },
      { key: 'bgColor',    label: 'Background', type: 'color',  default: 'transparent',                  group: 'Color' },
    ];
  }

  generate(p: Record<string, unknown>): string {
    return buildHoloSeal(
      Number(p['size'] ?? 200),
      Number(p['hueShift'] ?? 200),
      Math.round(Number(p['scallops'] ?? 16)),
      Math.round(Number(p['shineCount'] ?? 4)),
      String(p['text'] ?? ''),
      String(p['bgColor'] ?? 'transparent'),
    );
  }
}
