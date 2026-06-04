import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

function buildRegistrationMarks(
  size: number,
  style: 'crop-corners' | 'color-target' | 'crosshair-target' | 'dot-grid' | 'halftone-patch',
  markSize: number,
  strokeWidth: number,
  color: string,
  bgColor: string,
  gap: number,
): string {
  const parts: string[] = [];
  const cx = size / 2;
  const cy = size / 2;

  const bg = bgColor !== 'transparent'
    ? `<rect x="0" y="0" width="${size}" height="${size}" fill="${bgColor}"/>`
    : '';

  const sw = strokeWidth;
  const line = (x1: number, y1: number, x2: number, y2: number) =>
    `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${color}" stroke-width="${sw}" stroke-linecap="square"/>`;

  if (style === 'crop-corners') {
    // Corner crop marks — L-shaped marks at each corner
    const m = markSize;
    const g = gap;
    // Top-left
    parts.push(line(g, g + m, g, g));
    parts.push(line(g, g, g + m, g));
    // Top-right
    parts.push(line(size - g, g + m, size - g, g));
    parts.push(line(size - g, g, size - g - m, g));
    // Bottom-left
    parts.push(line(g, size - g - m, g, size - g));
    parts.push(line(g, size - g, g + m, size - g));
    // Bottom-right
    parts.push(line(size - g, size - g - m, size - g, size - g));
    parts.push(line(size - g, size - g, size - g - m, size - g));
    // Center registration crosshair
    const ch = markSize * 0.6;
    parts.push(line(cx - ch, cy, cx + ch, cy));
    parts.push(line(cx, cy - ch, cx, cy + ch));
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${ch * 0.5}" fill="none" stroke="${color}" stroke-width="${sw}"/>`);

  } else if (style === 'color-target') {
    // CMYK-style concentric circle target with crosshairs
    const radii = [markSize * 0.18, markSize * 0.32, markSize * 0.46, markSize * 0.60];
    const fills = ['#00ffff', '#ff00ff', '#ffff00', '#000000'];
    for (let i = radii.length - 1; i >= 0; i--) {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${radii[i]}" fill="${fills[i]}" stroke="${color}" stroke-width="${sw * 0.5}"/>`);
    }
    // Center dot
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${markSize * 0.04}" fill="${color}"/>`);
    // Crosshair arms outside the circles
    const outer = markSize * 0.72;
    const inner = markSize * 0.64;
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      const x1 = cx + Math.cos(a) * inner;
      const y1 = cy + Math.sin(a) * inner;
      const x2 = cx + Math.cos(a) * outer;
      const y2 = cy + Math.sin(a) * outer;
      parts.push(line(x1, y1, x2, y2));
    }

  } else if (style === 'crosshair-target') {
    // Precision crosshair target with concentric rings and ticks
    const rings = [markSize * 0.20, markSize * 0.38, markSize * 0.55];
    for (const r of rings) {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}"/>`);
    }
    // Radial tick marks at 8 positions on outermost ring
    const outerR = rings[rings.length - 1];
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      const tickLen = i % 2 === 0 ? markSize * 0.10 : markSize * 0.06;
      parts.push(line(
        cx + Math.cos(a) * (outerR - tickLen),
        cy + Math.sin(a) * (outerR - tickLen),
        cx + Math.cos(a) * (outerR + tickLen),
        cy + Math.sin(a) * (outerR + tickLen),
      ));
    }
    // Center cross
    const armLen = markSize * 0.65;
    const armGap = markSize * 0.08;
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      parts.push(line(
        cx + Math.cos(a) * armGap, cy + Math.sin(a) * armGap,
        cx + Math.cos(a) * armLen, cy + Math.sin(a) * armLen,
      ));
    }
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${markSize * 0.03}" fill="${color}"/>`);

  } else if (style === 'dot-grid') {
    // Evenly spaced dot grid
    const dotR = strokeWidth * 0.8;
    const spacing = markSize * 0.22;
    const cols = Math.floor(size / spacing);
    const rows = Math.floor(size / spacing);
    const offX = (size - (cols - 1) * spacing) / 2;
    const offY = (size - (rows - 1) * spacing) / 2;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const px = offX + c * spacing;
        const py = offY + r * spacing;
        parts.push(`<circle cx="${px.toFixed(2)}" cy="${py.toFixed(2)}" r="${dotR}" fill="${color}"/>`);
      }
    }

  } else { // halftone-patch
    // Halftone dot gradient patch (dots grow from left to right)
    const cols = Math.max(4, Math.round(size / markSize * 2));
    const rows = Math.max(2, Math.round(size / markSize));
    const cw = size / cols;
    const rh = size / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const t = c / (cols - 1);
        const maxR = Math.min(cw, rh) * 0.45;
        const dotR = maxR * t;
        if (dotR < 0.5) continue;
        const px = cw * (c + 0.5);
        const py = rh * (r + 0.5);
        parts.push(`<circle cx="${px.toFixed(2)}" cy="${py.toFixed(2)}" r="${dotR.toFixed(2)}" fill="${color}"/>`);
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bg}${parts.join('')}</svg>`;
}

export class RegistrationMarksGenerator implements IEphemeraGenerator {
  readonly typeId = 'registration-marks:standard';
  readonly categoryId = 'registration-marks';
  readonly displayName = 'Registration / Print Marks';
  readonly description = 'Crop marks, CMYK color targets, crosshair targets, dot grids, and halftone patches.';

  getDefaultParams(): Record<string, unknown> {
    return { size: 160, style: 'crop-corners', markSize: 24, strokeWidth: 1, color: '#000000', bgColor: 'transparent', gap: 8 };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'size',        label: 'Size',         type: 'range',  default: 160, min: 60,  max: 400, step: 4, group: 'Size' },
      { key: 'style',       label: 'Style',        type: 'select', default: 'crop-corners',
        options: [
          { value: 'crop-corners',    label: 'Crop corners'    },
          { value: 'color-target',    label: 'CMYK color target' },
          { value: 'crosshair-target',label: 'Crosshair target' },
          { value: 'dot-grid',        label: 'Dot grid'        },
          { value: 'halftone-patch',  label: 'Halftone patch'  },
        ],
      },
      { key: 'markSize',    label: 'Mark size',    type: 'range',  default: 24,  min: 8,   max: 80,  step: 2, group: 'Size' },
      { key: 'gap',         label: 'Gap',          type: 'range',  default: 8,   min: 2,   max: 30,  step: 1, group: 'Size' },
      { key: 'strokeWidth', label: 'Line weight',  type: 'range',  default: 1,   min: 0.25,max: 3,   step: 0.25, group: 'Appearance' },
      { key: 'color',       label: 'Color',        type: 'color',  default: '#000000',              group: 'Appearance' },
      { key: 'bgColor',     label: 'Background',   type: 'color',  default: 'transparent',          group: 'Appearance' },
    ];
  }

  generate(p: Record<string, unknown>): string {
    return buildRegistrationMarks(
      Number(p['size']        ?? 160),
      String(p['style']       ?? 'crop-corners') as any,
      Number(p['markSize']    ?? 24),
      Number(p['strokeWidth'] ?? 1),
      String(p['color']       ?? '#000000'),
      String(p['bgColor']     ?? 'transparent'),
      Number(p['gap']         ?? 8),
    );
  }
}
