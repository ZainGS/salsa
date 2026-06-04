import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

// ── Hazard stripe fill helper ───────────────────────────────────────────────

function hazardStripes(
  x: number, y: number, w: number, h: number,
  color1: string, color2: string,
  stripeWidth: number,
  angle: number,
): string {
  const id = 'hazard-' + Math.random().toString(36).slice(2, 6);
  const diag = Math.sqrt(w * w + h * h);
  const sa = Math.sin(angle * Math.PI / 180);
  const ca = Math.cos(angle * Math.PI / 180);
  const sw = stripeWidth;

  // Pattern tile: two stripes side by side
  const tileW = sw * 2;
  const tileH = sw * 2;

  const pat = `<pattern id="${id}" x="0" y="0" width="${tileW}" height="${tileH}" patternUnits="userSpaceOnUse" patternTransform="rotate(${angle},${x + w / 2},${y + h / 2})">` +
    `<rect x="0" y="0" width="${tileW}" height="${tileH}" fill="${color1}"/>` +
    `<rect x="0" y="0" width="${sw}" height="${tileH}" fill="${color2}"/>` +
    `</pattern>`;

  return `<defs>${pat}</defs><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${id})"/>`;
}

// ── Warning symbol (triangle or diamond) ────────────────────────────────────

function warningSymbol(cx: number, cy: number, size: number, shape: 'triangle' | 'diamond', color: string, bg: string, sw: number): string {
  if (shape === 'triangle') {
    const h = size * 0.866;
    const pts = `${cx},${cy - h * 0.6} ${cx - size / 2},${cy + h * 0.4} ${cx + size / 2},${cy + h * 0.4}`;
    const bang = `<text x="${cx}" y="${cy + h * 0.28}" text-anchor="middle" dominant-baseline="middle" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="${size * 0.45}" fill="${color}">!</text>`;
    return `<polygon points="${pts}" fill="${bg}" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round"/>${bang}`;
  } else {
    const hs = size / 2;
    const pts = `${cx},${cy - hs} ${cx + hs},${cy} ${cx},${cy + hs} ${cx - hs},${cy}`;
    return `<polygon points="${pts}" fill="${bg}" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round"/>` +
      `<text x="${cx}" y="${cy + 1}" text-anchor="middle" dominant-baseline="middle" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="${size * 0.45}" fill="${color}">!</text>`;
  }
}

// ── Main generator ───────────────────────────────────────────────────────────

function buildWarningLabel(
  width: number,
  height: number,
  style: 'caution' | 'warning' | 'danger' | 'radiation' | 'biohazard' | 'high-voltage',
  labelText: string,
  subText: string,
  borderWidth: number,
  stripeWidth: number,
  fgColor: string,
  bgColor: string,
  altColor: string,
  fontSize: number,
  showStripes: boolean,
  showSymbol: boolean,
  cornerRadius: number,
): string {
  const parts: string[] = [];
  const pad = borderWidth + 2;

  // Background
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" rx="${cornerRadius}" ry="${cornerRadius}" fill="${bgColor}"/>`);

  // Hazard stripes border
  if (showStripes) {
    const stripeData = hazardStripes(0, 0, width, height, fgColor, altColor, stripeWidth, 45);
    // Mask to outer border ring
    const maskId = 'stripe-mask-' + Math.random().toString(36).slice(2, 6);
    parts.push(`<defs><mask id="${maskId}">` +
      `<rect x="0" y="0" width="${width}" height="${height}" rx="${cornerRadius}" ry="${cornerRadius}" fill="white"/>` +
      `<rect x="${borderWidth}" y="${borderWidth}" width="${width - borderWidth * 2}" height="${height - borderWidth * 2}" rx="${Math.max(0, cornerRadius - borderWidth)}" ry="${Math.max(0, cornerRadius - borderWidth)}" fill="black"/>` +
      `</mask></defs>`);
    parts.push(`<g mask="url(#${maskId})">${stripeData}</g>`);
    // Inner background
    parts.push(`<rect x="${borderWidth}" y="${borderWidth}" width="${width - borderWidth * 2}" height="${height - borderWidth * 2}" rx="${Math.max(0, cornerRadius - borderWidth)}" ry="${Math.max(0, cornerRadius - borderWidth)}" fill="${bgColor}"/>`);
  }

  // Outer border
  parts.push(`<rect x="${borderWidth / 2}" y="${borderWidth / 2}" width="${width - borderWidth}" height="${height - borderWidth}" rx="${cornerRadius}" ry="${cornerRadius}" fill="none" stroke="${fgColor}" stroke-width="${borderWidth}"/>`);

  const innerX = borderWidth + pad;
  const innerW = width - (borderWidth + pad) * 2;
  const innerH = height - (borderWidth + pad) * 2;
  const innerY = borderWidth + pad;

  // Symbol zone
  let textY = innerY + innerH / 2;
  if (showSymbol) {
    const symSize = Math.min(innerW * 0.35, innerH * 0.55);
    const symCx = width / 2;
    const symCy = innerY + symSize * 0.65;
    textY = symCy + symSize * 0.7;

    if (style === 'radiation') {
      // Trefoil
      const sr = symSize * 0.25;
      parts.push(`<circle cx="${symCx}" cy="${symCy}" r="${sr * 0.35}" fill="${fgColor}"/>`);
      for (let i = 0; i < 3; i++) {
        const a = i * 2 * Math.PI / 3 - Math.PI / 2;
        const bcx = symCx + Math.cos(a) * sr;
        const bcy = symCy + Math.sin(a) * sr;
        parts.push(`<circle cx="${bcx.toFixed(1)}" cy="${bcy.toFixed(1)}" r="${(sr * 0.75).toFixed(1)}" fill="none" stroke="${fgColor}" stroke-width="${(sr * 0.55).toFixed(1)}"/>`);
      }
    } else if (style === 'biohazard') {
      // Simplified biohazard (3 overlapping circles with center circle)
      const br = symSize * 0.28;
      const gap = br * 0.55;
      parts.push(`<circle cx="${symCx}" cy="${symCy}" r="${br * 0.3}" fill="${fgColor}"/>`);
      for (let i = 0; i < 3; i++) {
        const a = i * 2 * Math.PI / 3 - Math.PI / 2;
        const bcx = symCx + Math.cos(a) * gap;
        const bcy = symCy + Math.sin(a) * gap;
        parts.push(`<circle cx="${bcx.toFixed(1)}" cy="${bcy.toFixed(1)}" r="${br.toFixed(1)}" fill="none" stroke="${fgColor}" stroke-width="${(br * 0.45).toFixed(1)}"/>`);
      }
    } else if (style === 'high-voltage') {
      // Lightning bolt
      const bw = symSize * 0.4;
      const bh = symSize * 0.8;
      const bx = symCx - bw / 2;
      const by = symCy - bh / 2;
      const pts = `${bx + bw},${by} ${bx + bw * 0.35},${by + bh * 0.45} ${bx + bw * 0.65},${by + bh * 0.45} ${bx},${by + bh} ${bx + bw * 0.65},${by + bh * 0.55} ${bx + bw * 0.35},${by + bh * 0.55}`;
      parts.push(`<polygon points="${pts}" fill="${fgColor}"/>`);
    } else {
      const symShape = (style === 'danger') ? 'diamond' : 'triangle';
      parts.push(warningSymbol(symCx, symCy, symSize, symShape, fgColor, bgColor, borderWidth * 0.5));
    }
  }

  // Label text
  if (labelText) {
    parts.push(`<text x="${width / 2}" y="${textY + fontSize}" text-anchor="middle" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="${fontSize}" fill="${fgColor}" letter-spacing="2">${labelText.toUpperCase()}</text>`);
  }

  if (subText) {
    parts.push(`<text x="${width / 2}" y="${textY + fontSize * 2.2}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${fontSize * 0.6}" fill="${fgColor}">${subText}</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`;
}

export class WarningLabelGenerator implements IEphemeraGenerator {
  readonly typeId = 'warning-label:standard';
  readonly categoryId = 'warning-label';
  readonly displayName = 'Warning Label';
  readonly description = 'Industrial warning labels: caution, danger, radiation, biohazard, high-voltage.';

  getDefaultParams(): Record<string, unknown> {
    return {
      width: 260,
      height: 140,
      style: 'caution',
      labelText: 'CAUTION',
      subText: 'Read all instructions before use',
      borderWidth: 10,
      stripeWidth: 8,
      fgColor: '#000000',
      bgColor: '#f5c800',
      altColor: '#f5c800',
      fontSize: 22,
      showStripes: true,
      showSymbol: true,
      cornerRadius: 4,
    };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'width',       label: 'Width',         type: 'range',  default: 260,  min: 80,  max: 500, step: 4, group: 'Size' },
      { key: 'height',      label: 'Height',        type: 'range',  default: 140,  min: 60,  max: 300, step: 4, group: 'Size' },
      { key: 'style',       label: 'Style',         type: 'select', default: 'caution',
        options: [
          { value: 'caution',      label: 'Caution'      },
          { value: 'warning',      label: 'Warning'      },
          { value: 'danger',       label: 'Danger'       },
          { value: 'radiation',    label: 'Radiation'    },
          { value: 'biohazard',    label: 'Biohazard'    },
          { value: 'high-voltage', label: 'High Voltage' },
        ],
      },
      { key: 'labelText',   label: 'Label text',    type: 'text',   default: 'CAUTION',                      group: 'Text' },
      { key: 'subText',     label: 'Sub-text',      type: 'text',   default: 'Read all instructions before use', group: 'Text' },
      { key: 'fontSize',    label: 'Font size',     type: 'range',  default: 22,   min: 8,  max: 48, step: 1, group: 'Text' },
      { key: 'showSymbol',  label: 'Show symbol',   type: 'toggle', default: true,                           group: 'Symbol' },
      { key: 'showStripes', label: 'Hazard stripes',type: 'toggle', default: true,                           group: 'Symbol' },
      { key: 'borderWidth', label: 'Border width',  type: 'range',  default: 10,   min: 2,  max: 24, step: 1, group: 'Appearance' },
      { key: 'stripeWidth', label: 'Stripe width',  type: 'range',  default: 8,    min: 3,  max: 24, step: 1, group: 'Appearance' },
      { key: 'cornerRadius',label: 'Corner radius', type: 'range',  default: 4,    min: 0,  max: 20, step: 1, group: 'Appearance' },
      { key: 'fgColor',     label: 'Foreground',    type: 'color',  default: '#000000',                      group: 'Color' },
      { key: 'bgColor',     label: 'Background',    type: 'color',  default: '#f5c800',                      group: 'Color' },
      { key: 'altColor',    label: 'Stripe alt',    type: 'color',  default: '#f5c800',                      group: 'Color' },
    ];
  }

  generate(p: Record<string, unknown>): string {
    const width        = Number(p['width']        ?? 260);
    const height       = Number(p['height']       ?? 140);
    const style        = String(p['style']        ?? 'caution') as 'caution' | 'warning' | 'danger' | 'radiation' | 'biohazard' | 'high-voltage';
    const labelText    = String(p['labelText']    ?? 'CAUTION');
    const subText      = String(p['subText']      ?? '');
    const borderWidth  = Number(p['borderWidth']  ?? 10);
    const stripeWidth  = Number(p['stripeWidth']  ?? 8);
    const fgColor      = String(p['fgColor']      ?? '#000000');
    const bgColor      = String(p['bgColor']      ?? '#f5c800');
    const altColor     = String(p['altColor']     ?? '#f5c800');
    const fontSize     = Number(p['fontSize']     ?? 22);
    const showStripes  = Boolean(p['showStripes'] ?? true);
    const showSymbol   = Boolean(p['showSymbol']  ?? true);
    const cornerRadius = Number(p['cornerRadius'] ?? 4);

    return buildWarningLabel(width, height, style, labelText, subText, borderWidth, stripeWidth, fgColor, bgColor, altColor, fontSize, showStripes, showSymbol, cornerRadius);
  }
}
