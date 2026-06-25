import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

/** Halftone dot field — print-style dot grid with optional density gradient. */
function buildHalftone(
  size: number,
  spacing: number,
  maxDot: number,
  angle: number,
  gradient: 'none' | 'radial' | 'linear-h' | 'linear-v',
  color: string,
  bgColor: string,
): string {
  const S = size;
  const parts: string[] = [];
  const rad = angle * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  // Oversample the grid so the rotated field still covers the whole square.
  const span = Math.ceil((S * 1.5) / spacing);
  const cx = S / 2, cy = S / 2;

  for (let gx = -span; gx <= span; gx++) {
    for (let gy = -span; gy <= span; gy++) {
      // Grid point rotated about the center.
      const lx = gx * spacing, ly = gy * spacing;
      const x = cx + lx * cos - ly * sin;
      const y = cy + lx * sin + ly * cos;
      if (x < -maxDot || x > S + maxDot || y < -maxDot || y > S + maxDot) continue;

      let f = 1;
      if (gradient === 'radial') {
        f = 1 - Math.min(1, Math.hypot(x - cx, y - cy) / (S * 0.7));
      } else if (gradient === 'linear-h') {
        f = 1 - x / S;
      } else if (gradient === 'linear-v') {
        f = 1 - y / S;
      }
      const r = maxDot * Math.max(0, f);
      if (r < 0.15) continue;
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="${color}"/>`);
    }
  }

  const bg = bgColor !== 'transparent' ? `<rect width="${S}" height="${S}" fill="${bgColor}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${bg}${parts.join('')}</svg>`;
}

export class HalftoneGenerator implements IEphemeraGenerator {
  readonly typeId = 'halftone:dots';
  readonly categoryId = 'halftone';
  readonly displayName = 'Halftone Dots';
  readonly description = 'Print-style halftone dot grid with an optional density gradient and rotation.';

  getDefaultParams(): Record<string, unknown> {
    return { size: 512, spacing: 18, maxDot: 7, angle: 0, gradient: 'radial', color: '#000000', bgColor: 'transparent' };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'size',     label: 'Size',     type: 'range',  default: 512, min: 128, max: 1024, step: 16, group: 'Size' },
      { key: 'spacing',  label: 'Spacing',  type: 'range',  default: 18,  min: 6,   max: 48,   step: 1,  group: 'Dots' },
      { key: 'maxDot',   label: 'Dot size', type: 'range',  default: 7,   min: 1,   max: 24,   step: 0.5, group: 'Dots' },
      { key: 'angle',    label: 'Angle',    type: 'range',  default: 0,   min: 0,   max: 90,   step: 1,  group: 'Dots' },
      { key: 'gradient', label: 'Gradient', type: 'select', default: 'radial',
        options: [
          { value: 'none',     label: 'Uniform'        },
          { value: 'radial',   label: 'Radial'         },
          { value: 'linear-h', label: 'Horizontal'     },
          { value: 'linear-v', label: 'Vertical'       },
        ], group: 'Dots' },
      { key: 'color',    label: 'Color',      type: 'color', default: '#000000',                        group: 'Color' },
      { key: 'bgColor',  label: 'Background', type: 'color', default: 'transparent',                    group: 'Color' },
    ];
  }

  generate(p: Record<string, unknown>): string {
    return buildHalftone(
      Number(p['size'] ?? 512),
      Number(p['spacing'] ?? 18),
      Number(p['maxDot'] ?? 7),
      Number(p['angle'] ?? 0),
      String(p['gradient'] ?? 'radial') as 'none' | 'radial' | 'linear-h' | 'linear-v',
      String(p['color'] ?? '#000000'),
      String(p['bgColor'] ?? 'transparent'),
    );
  }
}
