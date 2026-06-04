import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

function seededRng(seed: number) {
  let s = (seed >>> 0) || 0xdeadbeef;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

function buildGeometricFrame(
  width: number,
  height: number,
  style: 'bracket' | 'circuit' | 'hexagonal' | 'military' | 'target',
  strokeWidth: number,
  cornerSize: number,
  inset: number,
  color: string,
  bgColor: string,
  seed: number,
): string {
  const parts: string[] = [];
  const sw = strokeWidth;
  const cs = cornerSize;

  const bg = bgColor !== 'transparent'
    ? `<rect x="0" y="0" width="${width}" height="${height}" fill="${bgColor}"/>`
    : '';

  const line = (x1: number, y1: number, x2: number, y2: number, _sw = sw) =>
    `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${color}" stroke-width="${_sw}" stroke-linecap="square"/>`;

  const rect = (x: number, y: number, w: number, h: number, _sw = sw, dash = '') =>
    `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="none" stroke="${color}" stroke-width="${_sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;

  if (style === 'bracket') {
    // Corner L-brackets only
    const pad = sw / 2;
    const corners = [
      [pad, pad, 1, 1],
      [width - pad, pad, -1, 1],
      [pad, height - pad, 1, -1],
      [width - pad, height - pad, -1, -1],
    ] as const;
    for (const [x, y, dx, dy] of corners) {
      parts.push(line(x, y, x + dx * cs, y));
      parts.push(line(x, y, x, y + dy * cs));
    }
    if (inset > 0) {
      // Inner inset brackets
      const ip = inset + pad;
      const ics = cs * 0.6;
      const iCorners = [
        [ip, ip, 1, 1],
        [width - ip, ip, -1, 1],
        [ip, height - ip, 1, -1],
        [width - ip, height - ip, -1, -1],
      ] as const;
      for (const [x, y, dx, dy] of iCorners) {
        parts.push(line(x, y, x + dx * ics, y, sw * 0.7));
        parts.push(line(x, y, x, y + dy * ics, sw * 0.7));
      }
    }

  } else if (style === 'circuit') {
    // PCB-inspired: corner pads + trace segments along edges
    const rng = seededRng(seed);
    const pad = sw / 2;
    const padR = cs * 0.35;

    // Outer rect
    parts.push(rect(pad, pad, width - sw, height - sw));

    // Corner pads
    for (const [px, py] of [[cs, cs], [width - cs, cs], [cs, height - cs], [width - cs, height - cs]]) {
      parts.push(`<circle cx="${px}" cy="${py}" r="${padR}" fill="${color}"/>`);
      parts.push(`<circle cx="${px}" cy="${py}" r="${padR * 1.6}" fill="none" stroke="${color}" stroke-width="${sw}"/>`);
    }

    // Random trace stubs along the edges
    const traceCount = Math.round(4 + rng() * 4);
    for (let i = 0; i < traceCount; i++) {
      const edge = Math.floor(rng() * 4);
      const t = cs / (edge % 2 === 0 ? width : height) + rng() * (1 - 2 * cs / (edge % 2 === 0 ? width : height));
      const stubLen = cs * (0.3 + rng() * 0.5);
      const w2 = width, h2 = height;
      if (edge === 0) parts.push(line(t * w2, pad, t * w2, pad + stubLen)); // top
      else if (edge === 1) parts.push(line(w2 - pad, t * h2, w2 - pad - stubLen, t * h2)); // right
      else if (edge === 2) parts.push(line(t * w2, h2 - pad, t * w2, h2 - pad - stubLen)); // bottom
      else parts.push(line(pad, t * h2, pad + stubLen, t * h2)); // left
    }

    if (inset > 0) {
      parts.push(rect(inset, inset, width - inset * 2, height - inset * 2, sw * 0.6, `${sw * 3},${sw * 2}`));
    }

  } else if (style === 'hexagonal') {
    // Hexagonal / panel border with angled cuts on corners
    const cut = cs;
    const p = sw / 2;
    const w = width - sw, h = height - sw;
    const d = `M${p + cut},${p} L${p + w - cut},${p} L${p + w},${p + cut} L${p + w},${p + h - cut} L${p + w - cut},${p + h} L${p + cut},${p + h} L${p},${p + h - cut} L${p},${p + cut} Z`;
    parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linejoin="miter"/>`);

    // Inner inset
    if (inset > 0) {
      const ip = inset + p;
      const iw = width - sw - inset * 2, ih = height - sw - inset * 2;
      const ics = Math.max(2, cut - inset);
      const id2 = `M${ip + ics},${ip} L${ip + iw - ics},${ip} L${ip + iw},${ip + ics} L${ip + iw},${ip + ih - ics} L${ip + iw - ics},${ip + ih} L${ip + ics},${ip + ih} L${ip},${ip + ih - ics} L${ip},${ip + ics} Z`;
      parts.push(`<path d="${id2}" fill="none" stroke="${color}" stroke-width="${sw * 0.5}" stroke-linejoin="miter"/>`);
    }

  } else if (style === 'military') {
    // Military/document frame: double border with corner diamond ornaments
    const p = sw / 2;
    parts.push(rect(p, p, width - sw, height - sw, sw * 1.2));
    const inner = cs * 0.6;
    parts.push(rect(inner, inner, width - inner * 2, height - inner * 2, sw * 0.6));

    // Corner diamonds
    const diamondSize = cs * 0.35;
    for (const [px, py] of [[cs, cs], [width - cs, cs], [cs, height - cs], [width - cs, height - cs]]) {
      const ds = diamondSize;
      parts.push(`<polygon points="${px},${py - ds} ${px + ds},${py} ${px},${py + ds} ${px - ds},${py}" fill="${color}"/>`);
    }

    // Tick marks along the edges
    const ticks = 4;
    for (let i = 1; i < ticks; i++) {
      const t = i / ticks;
      const tickLen = cs * 0.25;
      const e = sw / 2;
      parts.push(line(t * width, e, t * width, e + tickLen, sw * 0.7));
      parts.push(line(t * width, height - e, t * width, height - e - tickLen, sw * 0.7));
      parts.push(line(e, t * height, e + tickLen, t * height, sw * 0.7));
      parts.push(line(width - e, t * height, width - e - tickLen, t * height, sw * 0.7));
    }

    if (inset > 0) {
      const ip = inset;
      parts.push(rect(ip, ip, width - ip * 2, height - ip * 2, sw * 0.4, `${sw * 4},${sw * 2}`));
    }

  } else { // target
    // Target frame: concentric rectangles converging to center
    const cx = width / 2, cy = height / 2;
    const steps = Math.max(2, Math.round(cs / 8));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const fw = width * (1 - t * 0.7);
      const fh = height * (1 - t * 0.7);
      const fx = cx - fw / 2;
      const fy = cy - fh / 2;
      const opacity = 1 - t * 0.4;
      parts.push(`<rect x="${fx.toFixed(2)}" y="${fy.toFixed(2)}" width="${fw.toFixed(2)}" height="${fh.toFixed(2)}" fill="none" stroke="${color}" stroke-width="${sw}" opacity="${opacity.toFixed(2)}"/>`);
    }
    // Center crosshair
    const armLen = Math.min(width, height) * 0.08;
    parts.push(line(cx - armLen, cy, cx + armLen, cy, sw * 0.7));
    parts.push(line(cx, cy - armLen, cx, cy + armLen, sw * 0.7));

    if (inset > 0) {
      parts.push(rect(inset, inset, width - inset * 2, height - inset * 2, sw * 0.5, `${sw * 3},${sw * 2}`));
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${bg}${parts.join('')}</svg>`;
}

export class GeometricFrameGenerator implements IEphemeraGenerator {
  readonly typeId = 'geometric-frame:standard';
  readonly categoryId = 'geometric-frame';
  readonly displayName = 'Geometric Frame / Border';
  readonly description = 'Bracket corners, circuit board border, hexagonal frame, military document frame, and target frame.';

  getDefaultParams(): Record<string, unknown> {
    return { width: 240, height: 160, style: 'bracket', strokeWidth: 1.5, cornerSize: 20, inset: 0, color: '#000000', bgColor: 'transparent', seed: 1 };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'width',       label: 'Width',         type: 'range',  default: 240, min: 60,  max: 600, step: 4,    group: 'Size' },
      { key: 'height',      label: 'Height',        type: 'range',  default: 160, min: 40,  max: 400, step: 4,    group: 'Size' },
      { key: 'style',       label: 'Style',         type: 'select', default: 'bracket',
        options: [
          { value: 'bracket',    label: 'Bracket corners' },
          { value: 'circuit',    label: 'Circuit board'   },
          { value: 'hexagonal',  label: 'Hexagonal'       },
          { value: 'military',   label: 'Military doc'    },
          { value: 'target',     label: 'Target frame'    },
        ],
      },
      { key: 'cornerSize',  label: 'Corner size',   type: 'range',  default: 20,  min: 6,   max: 80,  step: 2,    group: 'Style' },
      { key: 'inset',       label: 'Inner inset',   type: 'range',  default: 0,   min: 0,   max: 30,  step: 2,    group: 'Style' },
      { key: 'seed',        label: 'Seed',          type: 'seed',   default: 1,                                   group: 'Style' },
      { key: 'strokeWidth', label: 'Line weight',   type: 'range',  default: 1.5, min: 0.5, max: 4,   step: 0.25, group: 'Appearance' },
      { key: 'color',       label: 'Color',         type: 'color',  default: '#000000',                           group: 'Appearance' },
      { key: 'bgColor',     label: 'Background',    type: 'color',  default: 'transparent',                       group: 'Appearance' },
    ];
  }

  generate(p: Record<string, unknown>): string {
    return buildGeometricFrame(
      Number(p['width']       ?? 240),
      Number(p['height']      ?? 160),
      String(p['style']       ?? 'bracket') as any,
      Number(p['strokeWidth'] ?? 1.5),
      Number(p['cornerSize']  ?? 20),
      Number(p['inset']       ?? 0),
      String(p['color']       ?? '#000000'),
      String(p['bgColor']     ?? 'transparent'),
      Math.round(Number(p['seed'] ?? 1)),
    );
  }
}
