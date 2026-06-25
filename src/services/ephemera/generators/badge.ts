import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

/** Sticker badge / stamp — PROMO, 1ST EDITION, SALE bursts, ribbons. */
function buildBadge(
  size: number,
  shape: 'starburst' | 'circle' | 'rounded' | 'seal',
  text: string,
  points: number,
  color: string,
  textColor: string,
  rotation: number,
): string {
  const S = size;
  const cx = S / 2, cy = S / 2;
  const r = S * 0.46;
  const parts: string[] = [];
  const safe = text.replace(/[<&>]/g, '');

  if (shape === 'starburst') {
    const n = Math.max(6, points) * 2;
    const pts: string[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const rad = i % 2 === 0 ? r : r * 0.74;
      pts.push(`${(cx + Math.cos(a) * rad).toFixed(1)},${(cy + Math.sin(a) * rad).toFixed(1)}`);
    }
    parts.push(`<polygon points="${pts.join(' ')}" fill="${color}"/>`);
  } else if (shape === 'circle') {
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="${color}"/>`);
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${(r * 0.82).toFixed(1)}" fill="none" stroke="${textColor}" stroke-width="${(S * 0.012).toFixed(1)}"/>`);
  } else if (shape === 'seal') {
    // double scalloped ring
    const n = 24;
    const pts: string[] = [];
    for (let i = 0; i < n * 2; i++) {
      const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
      const rad = i % 2 === 0 ? r : r * 0.92;
      pts.push(`${(cx + Math.cos(a) * rad).toFixed(1)},${(cy + Math.sin(a) * rad).toFixed(1)}`);
    }
    parts.push(`<polygon points="${pts.join(' ')}" fill="${color}"/>`);
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${(r * 0.78).toFixed(1)}" fill="none" stroke="${textColor}" stroke-width="${(S * 0.01).toFixed(1)}" stroke-dasharray="${(S * 0.03).toFixed(0)} ${(S * 0.02).toFixed(0)}"/>`);
  } else { // rounded
    parts.push(`<rect x="${(cx - r).toFixed(1)}" y="${(cy - r * 0.5).toFixed(1)}" width="${(r * 2).toFixed(1)}" height="${(r).toFixed(1)}" rx="${(S * 0.06).toFixed(0)}" fill="${color}"/>`);
  }

  // Multi-line text (split on \n or spaces into up to 2 lines for the burst look).
  const lines = safe.includes('\n') ? safe.split('\n') : (safe.length > 8 ? safe.split(' ') : [safe]);
  const fs = S * (lines.length > 1 ? 0.16 : 0.2);
  const startY = cy - (lines.length - 1) * fs * 0.55;
  lines.forEach((ln, i) => {
    parts.push(`<text x="${cx}" y="${(startY + i * fs * 1.1).toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-family="Arial, sans-serif" font-weight="bold" font-size="${fs.toFixed(0)}" fill="${textColor}">${ln}</text>`);
  });

  const g = rotation !== 0 ? `<g transform="rotate(${rotation},${cx},${cy})">${parts.join('')}</g>` : parts.join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${g}</svg>`;
}

export class BadgeGenerator implements IEphemeraGenerator {
  readonly typeId = 'badge:standard';
  readonly categoryId = 'badge';
  readonly displayName = 'Badge / Stamp';
  readonly description = 'Sticker burst / stamp with text — PROMO, 1ST EDITION, SALE. Starburst, circle, seal, or ribbon.';

  getDefaultParams(): Record<string, unknown> {
    return { size: 200, shape: 'starburst', text: 'PROMO', points: 12, color: '#e63946', textColor: '#ffffff', rotation: -8 };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'size',   label: 'Size',  type: 'range',  default: 200, min: 64, max: 400, step: 4, group: 'Size' },
      { key: 'shape',  label: 'Shape', type: 'select', default: 'starburst',
        options: [
          { value: 'starburst', label: 'Starburst' },
          { value: 'circle',    label: 'Circle'    },
          { value: 'seal',      label: 'Seal'      },
          { value: 'rounded',   label: 'Ribbon'    },
        ], group: 'Shape' },
      { key: 'text',     label: 'Text',   type: 'text',  default: 'PROMO',                          group: 'Text' },
      { key: 'points',   label: 'Points', type: 'range', default: 12, min: 6, max: 24, step: 1,     group: 'Shape' },
      { key: 'rotation', label: 'Tilt',   type: 'range', default: -8, min: -45, max: 45, step: 1,   group: 'Shape' },
      { key: 'color',     label: 'Color',     type: 'color', default: '#e63946',                    group: 'Color' },
      { key: 'textColor', label: 'Text color', type: 'color', default: '#ffffff',                   group: 'Color' },
    ];
  }

  generate(p: Record<string, unknown>): string {
    return buildBadge(
      Number(p['size'] ?? 200),
      String(p['shape'] ?? 'starburst') as 'starburst' | 'circle' | 'rounded' | 'seal',
      String(p['text'] ?? 'PROMO'),
      Math.round(Number(p['points'] ?? 12)),
      String(p['color'] ?? '#e63946'),
      String(p['textColor'] ?? '#ffffff'),
      Number(p['rotation'] ?? -8),
    );
  }
}
