import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

function seededRng(seed: number) {
  let s = (seed >>> 0) || 0xdeadbeef;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

function buildMotionLines(
  width: number,
  height: number,
  style: 'radial' | 'parallel' | 'burst' | 'shockwave' | 'diagonal',
  lineCount: number,
  seed: number,
  speed: number,         // 0-100, affects line length
  strokeWidth: number,
  color: string,
  bgColor: string,
  taper: boolean,
  jitter: number,        // 0-100, positional randomness
  focusX: number,        // 0-100 percent of width (for radial)
  focusY: number,        // 0-100 percent of height
  gap: number,           // center gap radius (for radial/burst)
): string {
  const rng = seededRng(seed);
  const cx = width  * focusX / 100;
  const cy = height * focusY / 100;
  const diag = Math.sqrt(width * width + height * height);

  const parts: string[] = [];

  const bg = bgColor !== 'transparent'
    ? `<rect x="0" y="0" width="${width}" height="${height}" fill="${bgColor}"/>`
    : '';

  const speedFactor = 0.3 + speed / 100 * 0.7;

  if (style === 'radial' || style === 'burst') {
    const angleStep = (2 * Math.PI) / lineCount;
    const isBurst = style === 'burst';

    for (let i = 0; i < lineCount; i++) {
      const baseAngle = i * angleStep;
      const angleJitter = (rng() - 0.5) * jitter * 0.02;
      const angle = baseAngle + angleJitter;

      const lineLen = (diag * 0.5 * speedFactor) * (0.6 + rng() * 0.4);
      const inner = gap + (isBurst ? rng() * gap * 0.5 : 0);
      const outer = inner + lineLen;

      const x1 = cx + Math.cos(angle) * inner;
      const y1 = cy + Math.sin(angle) * inner;
      const x2 = cx + Math.cos(angle) * outer;
      const y2 = cy + Math.sin(angle) * outer;

      const sw = taper
        ? strokeWidth * (0.2 + 0.8 * (1 - inner / (outer + 1)))
        : strokeWidth * (0.6 + rng() * 0.6);

      // Taper: use a path with variable width via polygon trick
      if (taper) {
        const perpA = angle + Math.PI / 2;
        const swOuter = sw * 0.1;
        const swInner = sw;
        const px1a = x1 + Math.cos(perpA) * swInner / 2;
        const py1a = y1 + Math.sin(perpA) * swInner / 2;
        const px1b = x1 - Math.cos(perpA) * swInner / 2;
        const py1b = y1 - Math.sin(perpA) * swInner / 2;
        const px2a = x2 + Math.cos(perpA) * swOuter / 2;
        const py2a = y2 + Math.sin(perpA) * swOuter / 2;
        const px2b = x2 - Math.cos(perpA) * swOuter / 2;
        const py2b = y2 - Math.sin(perpA) * swOuter / 2;
        const pts = `${px1a.toFixed(2)},${py1a.toFixed(2)} ${px2a.toFixed(2)},${py2a.toFixed(2)} ${px2b.toFixed(2)},${py2b.toFixed(2)} ${px1b.toFixed(2)},${py1b.toFixed(2)}`;
        parts.push(`<polygon points="${pts}" fill="${color}"/>`);
      } else {
        parts.push(`<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${color}" stroke-width="${sw.toFixed(2)}" stroke-linecap="round"/>`);
      }
    }

  } else if (style === 'parallel') {
    // Horizontal speed lines
    const spacing = height / (lineCount + 1);
    for (let i = 0; i < lineCount; i++) {
      const y = spacing * (i + 1) + (rng() - 0.5) * jitter * spacing * 0.3;
      const lineLen = width * speedFactor * (0.4 + rng() * 0.6);
      const startX = width - lineLen - rng() * (width - lineLen) * 0.2;
      const endX = startX + lineLen;
      const sw = strokeWidth * (0.4 + rng() * 0.8);

      if (taper) {
        parts.push(`<line x1="${startX.toFixed(2)}" y1="${y.toFixed(2)}" x2="${endX.toFixed(2)}" y2="${y.toFixed(2)}" stroke="${color}" stroke-width="${sw.toFixed(2)}" stroke-linecap="round" opacity="${(0.3 + rng() * 0.7).toFixed(2)}"/>`);
      } else {
        parts.push(`<line x1="${startX.toFixed(2)}" y1="${y.toFixed(2)}" x2="${endX.toFixed(2)}" y2="${y.toFixed(2)}" stroke="${color}" stroke-width="${sw.toFixed(2)}" stroke-linecap="round"/>`);
      }
    }

  } else if (style === 'shockwave') {
    // Concentric partial arcs expanding outward
    const ringCount = Math.max(3, Math.round(lineCount / 4));
    const maxR = diag * 0.45 * speedFactor;
    for (let ri = 0; ri < ringCount; ri++) {
      const t = (ri + 1) / ringCount;
      const r = gap + t * maxR;
      const arcSpan = (Math.PI * 0.3 + rng() * Math.PI * 0.5) * t;
      const arcStart = rng() * 2 * Math.PI;
      const sw = strokeWidth * (1.5 - t * 0.8) * (0.7 + rng() * 0.5);
      const opacity = 0.3 + (1 - t) * 0.7;

      const steps = Math.max(12, Math.round(arcSpan * r / 3));
      const pts: string[] = [];
      for (let s = 0; s <= steps; s++) {
        const a = arcStart + (s / steps) * arcSpan;
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        pts.push(`${s === 0 ? 'M' : 'L'}${px.toFixed(2)},${py.toFixed(2)}`);
      }
      parts.push(`<path d="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="${sw.toFixed(2)}" stroke-linecap="round" opacity="${opacity.toFixed(2)}"/>`);
    }

  } else { // diagonal
    const angle = -Math.PI / 4; // 45° down-right
    const perpAngle = angle + Math.PI / 2;
    const spread = Math.sqrt(width * width + height * height);
    const spacing = spread / (lineCount + 1);

    for (let i = 0; i < lineCount; i++) {
      const offset = spacing * (i + 1) + (rng() - 0.5) * jitter * spacing * 0.3;
      const perpX = Math.cos(perpAngle) * offset;
      const perpY = Math.sin(perpAngle) * offset;
      const lineLen = diag * speedFactor * (0.5 + rng() * 0.5);
      const startDist = -rng() * lineLen * 0.3;
      const endDist = startDist + lineLen;

      const x1 = perpX + Math.cos(angle) * startDist;
      const y1 = perpY + Math.sin(angle) * startDist;
      const x2 = perpX + Math.cos(angle) * endDist;
      const y2 = perpY + Math.sin(angle) * endDist;
      const sw = strokeWidth * (0.5 + rng() * 0.7);

      parts.push(`<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${color}" stroke-width="${sw.toFixed(2)}" stroke-linecap="round"/>`);
    }
  }

  // Clip to canvas bounds
  const clipId = 'ml-clip-' + Math.random().toString(36).slice(2, 6);
  const defs = `<defs><clipPath id="${clipId}"><rect x="0" y="0" width="${width}" height="${height}"/></clipPath></defs>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${defs}${bg}<g clip-path="url(#${clipId})">${parts.join('')}</g></svg>`;
}

export class MotionLinesGenerator implements IEphemeraGenerator {
  readonly typeId = 'motion-lines:standard';
  readonly categoryId = 'motion-lines';
  readonly displayName = 'Motion / Speed Lines';
  readonly description = 'Speed and impact lines: radial burst, parallel speed, shockwave arcs, and diagonal.';

  getDefaultParams(): Record<string, unknown> {
    return {
      width: 300,
      height: 300,
      style: 'radial',
      lineCount: 32,
      seed: 1,
      speed: 70,
      strokeWidth: 1.5,
      color: '#000000',
      bgColor: 'transparent',
      taper: true,
      jitter: 20,
      focusX: 50,
      focusY: 50,
      gap: 30,
    };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'width',       label: 'Width',         type: 'range',  default: 300, min: 80,  max: 600, step: 4, group: 'Size' },
      { key: 'height',      label: 'Height',        type: 'range',  default: 300, min: 80,  max: 600, step: 4, group: 'Size' },
      { key: 'style',       label: 'Style',         type: 'select', default: 'radial',
        options: [
          { value: 'radial',     label: 'Radial burst'  },
          { value: 'burst',      label: 'Burst (staggered)' },
          { value: 'parallel',   label: 'Parallel speed' },
          { value: 'shockwave',  label: 'Shockwave arcs' },
          { value: 'diagonal',   label: 'Diagonal'      },
        ],
      },
      { key: 'lineCount',   label: 'Line count',    type: 'range',  default: 32,  min: 4,  max: 120, step: 2,    group: 'Lines' },
      { key: 'seed',        label: 'Seed',          type: 'seed',   default: 1,                                  group: 'Lines' },
      { key: 'speed',       label: 'Speed (length)', type: 'range', default: 70,  min: 10, max: 100, step: 1,   group: 'Lines' },
      { key: 'jitter',      label: 'Jitter',        type: 'range',  default: 20,  min: 0,  max: 100, step: 5,   group: 'Lines' },
      { key: 'taper',       label: 'Taper lines',   type: 'toggle', default: true,                              group: 'Lines' },
      { key: 'gap',         label: 'Center gap',    type: 'range',  default: 30,  min: 0,  max: 100, step: 2,   group: 'Focus' },
      { key: 'focusX',      label: 'Focus X (%)',   type: 'range',  default: 50,  min: 0,  max: 100, step: 1,   group: 'Focus' },
      { key: 'focusY',      label: 'Focus Y (%)',   type: 'range',  default: 50,  min: 0,  max: 100, step: 1,   group: 'Focus' },
      { key: 'strokeWidth', label: 'Line weight',   type: 'range',  default: 1.5, min: 0.5,max: 6,  step: 0.25, group: 'Appearance' },
      { key: 'color',       label: 'Color',         type: 'color',  default: '#000000',                         group: 'Appearance' },
      { key: 'bgColor',     label: 'Background',    type: 'color',  default: 'transparent',                     group: 'Appearance' },
    ];
  }

  generate(p: Record<string, unknown>): string {
    return buildMotionLines(
      Number(p['width']       ?? 300),
      Number(p['height']      ?? 300),
      String(p['style']       ?? 'radial') as 'radial' | 'parallel' | 'burst' | 'shockwave' | 'diagonal',
      Math.round(Number(p['lineCount']  ?? 32)),
      Math.round(Number(p['seed']       ?? 1)),
      Number(p['speed']       ?? 70),
      Number(p['strokeWidth'] ?? 1.5),
      String(p['color']       ?? '#000000'),
      String(p['bgColor']     ?? 'transparent'),
      Boolean(p['taper']      ?? true),
      Number(p['jitter']      ?? 20),
      Number(p['focusX']      ?? 50),
      Number(p['focusY']      ?? 50),
      Number(p['gap']         ?? 30),
    );
  }
}
