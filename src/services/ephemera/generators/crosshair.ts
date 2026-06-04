import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

function buildCrosshair(
  size: number,
  style: 'simple' | 'tactical' | 'mil-dot' | 'hud' | 'rings',
  strokeWidth: number,
  centerGap: number,
  ringCount: number,
  ringSpacing: number,
  tickCount: number,
  rotation: number,
  color: string,
  bgColor: string,
  showDot: boolean,
): string {
  const cx = size / 2;
  const cy = size / 2;
  const r  = size / 2;
  const rot = rotation * Math.PI / 180;

  const parts: string[] = [];

  const line = (x1: number, y1: number, x2: number, y2: number, sw = strokeWidth, opacity = 1) =>
    `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" opacity="${opacity}"/>`;

  const circle = (cr: number, sw = strokeWidth, dash = '', opacity = 1) =>
    `<circle cx="${cx}" cy="${cy}" r="${cr.toFixed(2)}" fill="none" stroke="${color}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''} opacity="${opacity}"/>`;

  // Rotated arm helper
  const arm = (angle: number, inner: number, outer: number, sw = strokeWidth) => {
    const a = angle + rot;
    const x1 = cx + Math.cos(a) * inner;
    const y1 = cy + Math.sin(a) * inner;
    const x2 = cx + Math.cos(a) * outer;
    const y2 = cy + Math.sin(a) * outer;
    return line(x1, y1, x2, y2, sw);
  };

  if (style === 'simple') {
    // Four arms, center gap
    const armLen = r * 0.65;
    for (let i = 0; i < 4; i++) {
      parts.push(arm(i * Math.PI / 2, centerGap, armLen));
    }
    if (showDot) parts.push(`<circle cx="${cx}" cy="${cy}" r="${strokeWidth}" fill="${color}"/>`);

  } else if (style === 'tactical') {
    // Four arms + diagonal tick marks
    const armLen = r * 0.70;
    for (let i = 0; i < 4; i++) {
      parts.push(arm(i * Math.PI / 2, centerGap, armLen));
    }
    // Diagonal short ticks at 45°
    const tickLen = r * 0.12;
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4 + rot;
      const rd = r * 0.55;
      const x1 = cx + Math.cos(a) * (rd - tickLen / 2);
      const y1 = cy + Math.sin(a) * (rd - tickLen / 2);
      const x2 = cx + Math.cos(a) * (rd + tickLen / 2);
      const y2 = cy + Math.sin(a) * (rd + tickLen / 2);
      parts.push(line(x1, y1, x2, y2, strokeWidth * 0.7));
    }
    parts.push(circle(r * 0.20, strokeWidth * 0.6));
    if (showDot) parts.push(`<circle cx="${cx}" cy="${cy}" r="${strokeWidth}" fill="${color}"/>`);

  } else if (style === 'mil-dot') {
    // Arms with evenly-spaced dots along them
    const armLen = r * 0.72;
    const dotCount = Math.max(2, Math.round(tickCount / 2));
    const dotR = strokeWidth * 0.8;
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + rot;
      // Arm line (outside dot region)
      const outerStart = centerGap + (dotCount + 0.5) * (armLen - centerGap) / dotCount;
      parts.push(arm(i * Math.PI / 2, outerStart, armLen));
      // Dots
      for (let d = 1; d <= dotCount; d++) {
        const dist = centerGap + d * (armLen - centerGap) / (dotCount + 1);
        const dx = cx + Math.cos(a) * dist;
        const dy = cy + Math.sin(a) * dist;
        parts.push(`<circle cx="${dx.toFixed(2)}" cy="${dy.toFixed(2)}" r="${dotR}" fill="${color}"/>`);
      }
    }
    if (showDot) parts.push(`<circle cx="${cx}" cy="${cy}" r="${strokeWidth}" fill="${color}"/>`);

  } else if (style === 'hud') {
    // Corner bracket style — top/left/right/bottom open brackets
    const bLen = r * 0.30;
    const bInset = r * 0.45;
    const bSw = strokeWidth * 1.2;
    // Top bracket
    parts.push(line(cx - bLen, cy - bInset, cx - bLen, cy - bInset - bLen, bSw));
    parts.push(line(cx - bLen, cy - bInset - bLen, cx + bLen, cy - bInset - bLen, bSw));
    parts.push(line(cx + bLen, cy - bInset - bLen, cx + bLen, cy - bInset, bSw));
    // Bottom bracket
    parts.push(line(cx - bLen, cy + bInset, cx - bLen, cy + bInset + bLen, bSw));
    parts.push(line(cx - bLen, cy + bInset + bLen, cx + bLen, cy + bInset + bLen, bSw));
    parts.push(line(cx + bLen, cy + bInset + bLen, cx + bLen, cy + bInset, bSw));
    // Left bracket
    parts.push(line(cx - bInset, cy - bLen, cx - bInset - bLen, cy - bLen, bSw));
    parts.push(line(cx - bInset - bLen, cy - bLen, cx - bInset - bLen, cy + bLen, bSw));
    parts.push(line(cx - bInset, cy + bLen, cx - bInset - bLen, cy + bLen, bSw));
    // Right bracket
    parts.push(line(cx + bInset, cy - bLen, cx + bInset + bLen, cy - bLen, bSw));
    parts.push(line(cx + bInset + bLen, cy - bLen, cx + bInset + bLen, cy + bLen, bSw));
    parts.push(line(cx + bInset, cy + bLen, cx + bInset + bLen, cy + bLen, bSw));
    // Center cross (thin)
    for (let i = 0; i < 4; i++) parts.push(arm(i * Math.PI / 2, centerGap, r * 0.15, strokeWidth * 0.6));
    if (showDot) parts.push(`<circle cx="${cx}" cy="${cy}" r="${strokeWidth * 0.8}" fill="${color}"/>`);

  } else { // rings
    const n = Math.max(1, ringCount);
    const spacing = ringSpacing;
    for (let i = 1; i <= n; i++) {
      const ringR = i * spacing;
      if (ringR < r) parts.push(circle(ringR, strokeWidth * (1 - (i - 1) * 0.1)));
    }
    // Cardinal ticks on outermost ring
    const outerR = Math.min(n * spacing, r - strokeWidth);
    const tickLen = outerR * 0.12;
    for (let i = 0; i < 4; i++) {
      parts.push(arm(i * Math.PI / 2, outerR - tickLen, outerR + tickLen, strokeWidth * 1.2));
    }
    // Center arms
    for (let i = 0; i < 4; i++) parts.push(arm(i * Math.PI / 2, centerGap, outerR * 0.35));
    if (showDot) parts.push(`<circle cx="${cx}" cy="${cy}" r="${strokeWidth}" fill="${color}"/>`);
  }

  const bg = bgColor !== 'transparent'
    ? `<rect width="${size}" height="${size}" fill="${bgColor}"/>`
    : '';

  const gTransform = rotation !== 0 && (style === 'hud')
    ? ` transform="rotate(${rotation},${cx},${cy})"`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bg}<g${gTransform}>${parts.join('')}</g></svg>`;
}

export class CrosshairGenerator implements IEphemeraGenerator {
  readonly typeId = 'crosshair:standard';
  readonly categoryId = 'crosshair';
  readonly displayName = 'Crosshair / Reticle';
  readonly description = 'Targeting reticle in multiple styles: simple, tactical, mil-dot, HUD brackets, and rings.';

  getDefaultParams(): Record<string, unknown> {
    return {
      size: 200,
      style: 'tactical',
      strokeWidth: 1.5,
      centerGap: 12,
      ringCount: 2,
      ringSpacing: 35,
      tickCount: 4,
      rotation: 0,
      color: '#000000',
      bgColor: 'transparent',
      showDot: true,
    };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'size',        label: 'Size',          type: 'range',  default: 200, min: 60,  max: 400, step: 4,    group: 'Size' },
      { key: 'style',       label: 'Style',          type: 'select', default: 'tactical',
        options: [
          { value: 'simple',    label: 'Simple'    },
          { value: 'tactical',  label: 'Tactical'  },
          { value: 'mil-dot',   label: 'Mil-Dot'   },
          { value: 'hud',       label: 'HUD Brackets' },
          { value: 'rings',     label: 'Rings'     },
        ],
      },
      { key: 'strokeWidth', label: 'Line weight',   type: 'range',  default: 1.5, min: 0.5, max: 4,   step: 0.25, group: 'Appearance' },
      { key: 'centerGap',   label: 'Center gap',    type: 'range',  default: 12,  min: 0,   max: 40,  step: 1,    group: 'Appearance' },
      { key: 'showDot',     label: 'Center dot',    type: 'toggle', default: true,                               group: 'Appearance' },
      { key: 'rotation',    label: 'Rotation',      type: 'range',  default: 0,   min: -180, max: 180, step: 1,  group: 'Appearance' },
      { key: 'ringCount',   label: 'Ring count',    type: 'range',  default: 2,   min: 1,   max: 6,   step: 1,    group: 'Rings' },
      { key: 'ringSpacing', label: 'Ring spacing',  type: 'range',  default: 35,  min: 10,  max: 80,  step: 2,    group: 'Rings' },
      { key: 'tickCount',   label: 'Mil-dot count', type: 'range',  default: 4,   min: 2,   max: 10,  step: 1,    group: 'Mil-Dot' },
      { key: 'color',       label: 'Color',         type: 'color',  default: '#000000',                          group: 'Color' },
      { key: 'bgColor',     label: 'Background',    type: 'color',  default: 'transparent',                      group: 'Color' },
    ];
  }

  generate(p: Record<string, unknown>): string {
    const size        = Number(p['size']        ?? 200);
    const style       = String(p['style']       ?? 'tactical') as 'simple' | 'tactical' | 'mil-dot' | 'hud' | 'rings';
    const strokeWidth = Number(p['strokeWidth'] ?? 1.5);
    const centerGap   = Number(p['centerGap']   ?? 12);
    const ringCount   = Math.round(Number(p['ringCount']   ?? 2));
    const ringSpacing = Number(p['ringSpacing'] ?? 35);
    const tickCount   = Math.round(Number(p['tickCount']   ?? 4));
    const rotation    = Number(p['rotation']    ?? 0);
    const color       = String(p['color']       ?? '#000000');
    const bgColor     = String(p['bgColor']     ?? 'transparent');
    const showDot     = Boolean(p['showDot']    ?? true);

    return buildCrosshair(size, style, strokeWidth, centerGap, ringCount, ringSpacing, tickCount, rotation, color, bgColor, showDot);
  }
}
