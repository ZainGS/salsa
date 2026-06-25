import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PALETTES: Record<string, string[]> = {
  vaporwave: ['#ff71ce', '#01cdfe', '#05ffa1', '#b967ff', '#fffb96'],
  pastel:    ['#ffadad', '#ffd6a5', '#caffbf', '#9bf6ff', '#bdb2ff'],
  primary:   ['#e63946', '#f4a261', '#2a9d8f', '#264653', '#e9c46a'],
  mono:      ['#222222', '#555555', '#888888', '#bbbbbb'],
};

/** Memphis-style scattered geometric confetti — triangles, zigzags, squiggles, dots, crosses. */
function buildMemphis(size: number, density: number, paletteId: string, seed: number): string {
  const rand = rng(seed);
  const S = size;
  const palette = PALETTES[paletteId] ?? PALETTES['vaporwave'];
  const pick = () => palette[Math.floor(rand() * palette.length)];
  const parts: string[] = [];
  const count = Math.round(density);

  for (let i = 0; i < count; i++) {
    const x = rand() * S, y = rand() * S;
    const sc = S * (0.03 + rand() * 0.07);
    const rot = rand() * 360;
    const c = pick();
    const kind = Math.floor(rand() * 6);
    const g = (inner: string) => parts.push(`<g transform="translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${rot.toFixed(0)}) scale(${sc.toFixed(2)})">${inner}</g>`);

    if (kind === 0) {        // triangle
      g(`<polygon points="0,-1 0.87,0.5 -0.87,0.5" fill="${c}"/>`);
    } else if (kind === 1) { // zigzag
      g(`<polyline points="-1.5,-0.5 -0.75,0.5 0,-0.5 0.75,0.5 1.5,-0.5" fill="none" stroke="${c}" stroke-width="0.3" stroke-linecap="round"/>`);
    } else if (kind === 2) { // squiggle
      g(`<path d="M-1.5,0 Q-0.75,-1 0,0 T1.5,0" fill="none" stroke="${c}" stroke-width="0.3" stroke-linecap="round"/>`);
    } else if (kind === 3) { // dot cluster
      g(`<circle cx="0" cy="0" r="0.6" fill="${c}"/>`);
    } else if (kind === 4) { // cross / plus
      g(`<path d="M-1,0 H1 M0,-1 V1" stroke="${c}" stroke-width="0.35" stroke-linecap="round"/>`);
    } else {                 // quarter arc
      g(`<path d="M-1,1 A2,2 0 0 1 1,-1" fill="none" stroke="${c}" stroke-width="0.3"/>`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${parts.join('')}</svg>`;
}

export class MemphisGenerator implements IEphemeraGenerator {
  readonly typeId = 'memphis:confetti';
  readonly categoryId = 'memphis';
  readonly displayName = 'Memphis Confetti';
  readonly description = 'Scattered 80s/90s geometric confetti — triangles, zigzags, squiggles, dots, crosses.';

  getDefaultParams(): Record<string, unknown> {
    return { size: 512, density: 40, palette: 'vaporwave', seed: 1 };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'size',    label: 'Size',    type: 'range',  default: 512, min: 128, max: 1024, step: 16, group: 'Size' },
      { key: 'density', label: 'Density', type: 'range',  default: 40,  min: 5,   max: 150,   step: 5,  group: 'Field' },
      { key: 'palette', label: 'Palette', type: 'select', default: 'vaporwave',
        options: [
          { value: 'vaporwave', label: 'Vaporwave' },
          { value: 'pastel',    label: 'Pastel'    },
          { value: 'primary',   label: 'Primary'   },
          { value: 'mono',      label: 'Mono'      },
        ], group: 'Field' },
      { key: 'seed',    label: 'Seed',    type: 'seed',   default: 1,                                  group: 'Field' },
    ];
  }

  generate(p: Record<string, unknown>): string {
    return buildMemphis(
      Number(p['size'] ?? 512),
      Math.round(Number(p['density'] ?? 40)),
      String(p['palette'] ?? 'vaporwave'),
      Math.round(Number(p['seed'] ?? 1)) || 1,
    );
  }
}
