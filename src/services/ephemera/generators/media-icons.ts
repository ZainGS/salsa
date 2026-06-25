import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

/**
 * Retro media-format icons — MiniDisc, cassette, CD, cartridge, floppy.
 * Crisp flat-vector glyphs for the Y2K / OBI aesthetic (the "Mini Disc / ROM" marks).
 */
function buildMediaIcon(
  size: number,
  format: 'minidisc' | 'cassette' | 'cd' | 'cartridge' | 'floppy',
  color: string,
  accent: string,
  bgColor: string,
): string {
  const S = size;
  const p: string[] = [];
  const rect = (x: number, y: number, w: number, h: number, fill: string, rx = 0, opacity = 1) =>
    `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${rx}" fill="${fill}" opacity="${opacity}"/>`;
  const circ = (cx: number, cy: number, r: number, fill: string, opacity = 1) =>
    `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${fill}" opacity="${opacity}"/>`;
  const ring = (cx: number, cy: number, r: number, sw: number, stroke: string, opacity = 1) =>
    `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="${stroke}" stroke-width="${sw.toFixed(1)}" opacity="${opacity}"/>`;

  const m = S * 0.1; // margin
  const w = S - m * 2;

  if (format === 'minidisc') {
    p.push(rect(m, m, w, w, color, S * 0.04));            // shell
    p.push(rect(m + w * 0.12, m + w * 0.1, w * 0.76, w * 0.42, accent, S * 0.02)); // label area
    p.push(rect(m + w * 0.2, m + w * 0.58, w * 0.6, w * 0.3, bgColor, S * 0.015)); // shutter window
    p.push(rect(m + w * 0.2, m + w * 0.58, w * 0.16, w * 0.3, accent, S * 0.01));  // shutter
  } else if (format === 'cassette') {
    p.push(rect(m, m + w * 0.12, w, w * 0.76, color, S * 0.04));   // body
    p.push(rect(m + w * 0.1, m + w * 0.2, w * 0.8, w * 0.34, accent, S * 0.02)); // label
    const ry = m + w * 0.66, rr = w * 0.1;
    p.push(circ(m + w * 0.3, ry, rr, bgColor)); p.push(circ(m + w * 0.3, ry, rr * 0.4, accent));
    p.push(circ(m + w * 0.7, ry, rr, bgColor)); p.push(circ(m + w * 0.7, ry, rr * 0.4, accent));
    p.push(rect(m + w * 0.42, ry - rr * 0.25, w * 0.16, rr * 0.5, bgColor)); // window between reels
  } else if (format === 'cd') {
    const cx = S / 2, cy = S / 2;
    p.push(circ(cx, cy, w * 0.5, color));                  // disc
    p.push(ring(cx, cy, w * 0.5, S * 0.01, accent));
    p.push(ring(cx, cy, w * 0.38, S * 0.008, accent, 0.6));
    p.push(ring(cx, cy, w * 0.26, S * 0.008, accent, 0.6));
    p.push(circ(cx, cy, w * 0.16, accent));                // hub
    p.push(circ(cx, cy, w * 0.06, bgColor));               // center hole
  } else if (format === 'cartridge') {
    p.push(rect(m, m, w, w * 0.8, color, S * 0.03));        // body
    p.push(rect(m + w * 0.12, m + w * 0.1, w * 0.76, w * 0.4, accent, S * 0.015)); // label
    // ridged top
    for (let i = 0; i < 5; i++) p.push(rect(m + w * 0.15 + i * w * 0.15, m + w * 0.6, w * 0.08, w * 0.16, accent));
    p.push(rect(m + w * 0.2, m + w * 0.78, w * 0.6, w * 0.04, bgColor)); // contact slot
  } else { // floppy
    p.push(rect(m, m, w, w, color, S * 0.02));              // body
    p.push(rect(m + w * 0.18, m, w * 0.64, w * 0.28, accent)); // metal shutter
    p.push(rect(m + w * 0.6, m + w * 0.02, w * 0.12, w * 0.22, bgColor)); // shutter window
    p.push(rect(m + w * 0.15, m + w * 0.4, w * 0.7, w * 0.5, accent, S * 0.01)); // label
  }

  const bg = bgColor !== 'transparent' ? rect(0, 0, S, S, bgColor) : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${bg}${p.join('')}</svg>`;
}

export class MediaIconsGenerator implements IEphemeraGenerator {
  readonly typeId = 'media-icons:format';
  readonly categoryId = 'media-icons';
  readonly displayName = 'Media Format Icon';
  readonly description = 'Retro media-format glyphs: MiniDisc, cassette, CD, cartridge, floppy — the "Mini Disc / ROM" marks.';

  getDefaultParams(): Record<string, unknown> {
    return { size: 200, format: 'minidisc', color: '#1a1a2e', accent: '#9b59b6', bgColor: 'transparent' };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'size',    label: 'Size',   type: 'range',  default: 200, min: 48, max: 400, step: 4, group: 'Size' },
      { key: 'format',  label: 'Format', type: 'select', default: 'minidisc',
        options: [
          { value: 'minidisc',  label: 'MiniDisc'  },
          { value: 'cassette',  label: 'Cassette'  },
          { value: 'cd',        label: 'CD / Disc' },
          { value: 'cartridge', label: 'Cartridge' },
          { value: 'floppy',    label: 'Floppy'    },
        ], group: 'Format' },
      { key: 'color',   label: 'Body',       type: 'color', default: '#1a1a2e',      group: 'Color' },
      { key: 'accent',  label: 'Accent',     type: 'color', default: '#9b59b6',      group: 'Color' },
      { key: 'bgColor', label: 'Background', type: 'color', default: 'transparent',  group: 'Color' },
    ];
  }

  generate(p: Record<string, unknown>): string {
    const size    = Number(p['size'] ?? 200);
    const format  = String(p['format'] ?? 'minidisc') as 'minidisc' | 'cassette' | 'cd' | 'cartridge' | 'floppy';
    const color   = String(p['color']   ?? '#1a1a2e');
    const accent  = String(p['accent']  ?? '#9b59b6');
    const bgColor = String(p['bgColor'] ?? 'transparent');
    return buildMediaIcon(size, format, color, accent, bgColor);
  }
}
