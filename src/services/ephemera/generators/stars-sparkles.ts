import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

function seededRng(seed: number) {
  let s = (seed >>> 0) || 0xdeadbeef;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

function starPath(cx: number, cy: number, outer: number, inner: number, points: number, rotation: number): string {
  const pts: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i * Math.PI / points) + rotation * Math.PI / 180;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(' ') + ' Z';
}

function sparkleSpikePath(cx: number, cy: number, outer: number, waist: number, points: number, rotation: number): string {
  // Elongated diamond spikes (starburst)
  const pts: string[] = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * 2 * Math.PI + rotation * Math.PI / 180;
    const aNext = ((i + 0.5) / points) * 2 * Math.PI + rotation * Math.PI / 180;
    const aPrev = ((i - 0.5) / points) * 2 * Math.PI + rotation * Math.PI / 180;
    const tipX = cx + Math.cos(a) * outer;
    const tipY = cy + Math.sin(a) * outer;
    const leftX = cx + Math.cos(aPrev) * waist;
    const leftY = cy + Math.sin(aPrev) * waist;
    const rightX = cx + Math.cos(aNext) * waist;
    const rightY = cy + Math.sin(aNext) * waist;
    pts.push(`${i === 0 ? 'M' : 'L'}${leftX.toFixed(2)},${leftY.toFixed(2)}`);
    pts.push(`L${tipX.toFixed(2)},${tipY.toFixed(2)}`);
    pts.push(`L${rightX.toFixed(2)},${rightY.toFixed(2)}`);
  }
  return pts.join(' ') + ' Z';
}

function buildStars(
  size: number,
  style: 'filled' | 'outline' | 'starburst' | 'cluster',
  points: number,
  outerRadius: number,
  innerRatio: number,
  rotation: number,
  strokeWidth: number,
  count: number,
  scatter: number,
  seed: number,
  color: string,
  bgColor: string,
): string {
  const rng = seededRng(seed);
  const cx = size / 2;
  const cy = size / 2;
  const parts: string[] = [];

  const bg = bgColor !== 'transparent'
    ? `<rect x="0" y="0" width="${size}" height="${size}" fill="${bgColor}"/>`
    : '';

  const renderStar = (scx: number, scy: number, outer: number, rot: number, alpha = 1) => {
    const inner = outer * innerRatio;
    const opacity = alpha < 1 ? ` opacity="${alpha.toFixed(2)}"` : '';

    if (style === 'starburst') {
      const waist = outer * 0.06;
      const d = sparkleSpikePath(scx, scy, outer, waist, points, rot);
      return `<path d="${d}" fill="${color}"${opacity}/>`;
    } else if (style === 'outline') {
      const d = starPath(scx, scy, outer, inner, points, rot);
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linejoin="round"${opacity}/>`;
    } else {
      // filled
      const d = starPath(scx, scy, outer, inner, points, rot);
      return `<path d="${d}" fill="${color}"${opacity}/>`;
    }
  };

  if (count <= 1 || style === 'starburst') {
    parts.push(renderStar(cx, cy, outerRadius, rotation));
  } else {
    // Cluster: one main star + smaller scattered ones
    parts.push(renderStar(cx, cy, outerRadius, rotation));
    for (let i = 1; i < count; i++) {
      const angle = rng() * 2 * Math.PI;
      const dist = (0.3 + rng() * 0.7) * scatter;
      const scx = cx + Math.cos(angle) * dist;
      const scy = cy + Math.sin(angle) * dist;
      const sr = outerRadius * (0.25 + rng() * 0.5);
      const rot = rotation + rng() * 45;
      const alpha = 0.5 + rng() * 0.5;
      parts.push(renderStar(scx, scy, sr, rot, alpha));
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bg}${parts.join('')}</svg>`;
}

export class StarsSparklesGenerator implements IEphemeraGenerator {
  readonly typeId = 'stars-sparkles:standard';
  readonly categoryId = 'stars-sparkles';
  readonly displayName = 'Stars / Sparkles';
  readonly description = 'Parametric N-point stars, starbursts, and sparkle clusters.';

  getDefaultParams(): Record<string, unknown> {
    return {
      size: 160, style: 'filled', points: 4,
      outerRadius: 70, innerRatio: 0.4, rotation: -18,
      strokeWidth: 1.5, count: 1, scatter: 50, seed: 1,
      color: '#000000', bgColor: 'transparent',
    };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'size',        label: 'Canvas size',   type: 'range',  default: 160, min: 60,  max: 400, step: 4,    group: 'Size' },
      { key: 'outerRadius', label: 'Outer radius',  type: 'range',  default: 70,  min: 10,  max: 190, step: 2,    group: 'Size' },
      { key: 'style',       label: 'Style',         type: 'select', default: 'filled',
        options: [
          { value: 'filled',    label: 'Filled star'   },
          { value: 'outline',   label: 'Outline star'  },
          { value: 'starburst', label: 'Starburst'     },
          { value: 'cluster',   label: 'Cluster'       },
        ],
      },
      { key: 'points',      label: 'Points',        type: 'select', default: 4,
        options: [
          { value: 4, label: '4-point' },
          { value: 5, label: '5-point' },
          { value: 6, label: '6-point' },
          { value: 8, label: '8-point' },
          { value: 12, label: '12-point' },
        ],
        group: 'Shape',
      },
      { key: 'innerRatio',  label: 'Inner ratio',   type: 'range',  default: 0.4, min: 0.05,max: 0.9, step: 0.05, group: 'Shape' },
      { key: 'rotation',    label: 'Rotation',      type: 'range',  default: -18, min: -180,max: 180, step: 1,    group: 'Shape' },
      { key: 'count',       label: 'Cluster count', type: 'range',  default: 1,   min: 1,   max: 8,   step: 1,    group: 'Cluster' },
      { key: 'scatter',     label: 'Scatter radius',type: 'range',  default: 50,  min: 10,  max: 150, step: 5,    group: 'Cluster' },
      { key: 'seed',        label: 'Seed',          type: 'seed',   default: 1,                                   group: 'Cluster' },
      { key: 'strokeWidth', label: 'Stroke weight', type: 'range',  default: 1.5, min: 0.5, max: 4,   step: 0.25, group: 'Appearance' },
      { key: 'color',       label: 'Color',         type: 'color',  default: '#000000',                           group: 'Appearance' },
      { key: 'bgColor',     label: 'Background',    type: 'color',  default: 'transparent',                       group: 'Appearance' },
    ];
  }

  generate(p: Record<string, unknown>): string {
    return buildStars(
      Number(p['size']        ?? 160),
      String(p['style']       ?? 'filled') as any,
      Math.round(Number(p['points']      ?? 4)),
      Number(p['outerRadius'] ?? 70),
      Number(p['innerRatio']  ?? 0.4),
      Number(p['rotation']    ?? -18),
      Number(p['strokeWidth'] ?? 1.5),
      Math.round(Number(p['count']       ?? 1)),
      Number(p['scatter']     ?? 50),
      Math.round(Number(p['seed']        ?? 1)),
      String(p['color']       ?? '#000000'),
      String(p['bgColor']     ?? 'transparent'),
    );
  }
}
