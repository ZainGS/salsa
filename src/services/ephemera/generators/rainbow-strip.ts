import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

/** Rainbow / spectrum strip — the OBI-band rainbow bar. Emits a wide strip (non-square). */
function buildRainbowStrip(
  length: number,
  thickness: number,
  style: 'smooth' | 'banded',
  segments: number,
  vertical: boolean,
): string {
  const W = vertical ? thickness : length;
  const H = vertical ? length : thickness;
  const defs: string[] = [];
  const parts: string[] = [];
  const hues = [0, 35, 60, 130, 200, 260, 300]; // red→orange→yellow→green→blue→indigo→violet

  if (style === 'smooth') {
    const stops = hues.map((h, i) =>
      `<stop offset="${((i / (hues.length - 1)) * 100).toFixed(0)}%" stop-color="hsl(${h},90%,55%)"/>`).join('');
    const grad = vertical
      ? `<linearGradient id="rb" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient>`
      : `<linearGradient id="rb" x1="0" y1="0" x2="1" y2="0">${stops}</linearGradient>`;
    defs.push(grad);
    parts.push(`<rect width="${W}" height="${H}" fill="url(#rb)"/>`);
  } else {
    const n = Math.max(2, segments);
    const seg = (vertical ? H : W) / n;
    for (let i = 0; i < n; i++) {
      const hue = hues[Math.round((i / (n - 1)) * (hues.length - 1))];
      const x = vertical ? 0 : i * seg;
      const y = vertical ? i * seg : 0;
      const w = vertical ? W : seg + 0.5;
      const h = vertical ? seg + 0.5 : H;
      parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="hsl(${hue},90%,55%)"/>`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(0)}" height="${H.toFixed(0)}" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}"><defs>${defs.join('')}</defs>${parts.join('')}</svg>`;
}

export class RainbowStripGenerator implements IEphemeraGenerator {
  readonly typeId = 'rainbow-strip:standard';
  readonly categoryId = 'rainbow-strip';
  readonly displayName = 'Rainbow Strip';
  readonly description = 'Spectrum bar (the OBI rainbow stripe) — smooth gradient or discrete bands, horizontal or vertical.';

  getDefaultParams(): Record<string, unknown> {
    return { length: 480, thickness: 36, style: 'smooth', segments: 7, vertical: false };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'length',    label: 'Length',    type: 'range',  default: 480, min: 64, max: 1024, step: 16, group: 'Size' },
      { key: 'thickness', label: 'Thickness', type: 'range',  default: 36,  min: 4,  max: 160,  step: 2,  group: 'Size' },
      { key: 'style',     label: 'Style',     type: 'select', default: 'smooth',
        options: [
          { value: 'smooth', label: 'Smooth gradient' },
          { value: 'banded', label: 'Bands'           },
        ], group: 'Spectrum' },
      { key: 'segments',  label: 'Bands',     type: 'range',  default: 7,   min: 3,  max: 16,   step: 1,  group: 'Spectrum' },
      { key: 'vertical',  label: 'Vertical',  type: 'toggle', default: false,                            group: 'Spectrum' },
    ];
  }

  generate(p: Record<string, unknown>): string {
    return buildRainbowStrip(
      Number(p['length'] ?? 480),
      Number(p['thickness'] ?? 36),
      String(p['style'] ?? 'smooth') as 'smooth' | 'banded',
      Math.round(Number(p['segments'] ?? 7)),
      Boolean(p['vertical'] ?? false),
    );
  }
}
