import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

/** Small deterministic PRNG (mulberry32) so a given seed always renders the same damage. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Worn edges / creases / scuffs — a procedural damage overlay for the retro/OBI aesthetic.
 * Designed to be placed full-canvas and drawn with a `multiply` (dark damage) or `screen`
 * (light dust) blend mode so it sits INTO the artwork rather than as a flat sticker.
 */
function buildWornEdges(
  size: number,
  style: 'torn' | 'creases' | 'scuffed' | 'all',
  wear: number,
  foldCount: number,
  color: string,
  seed: number,
): string {
  const rand = rng(seed);
  const parts: string[] = [];
  const S = size;

  const doTorn = style === 'torn' || style === 'all';
  const doCreases = style === 'creases' || style === 'all';
  const doScuff = style === 'scuffed' || style === 'all';

  // ── Torn frame: a filled border band whose INNER contour is jagged ──
  if (doTorn) {
    const baseInset = S * (0.02 + 0.06 * wear);
    const jag = baseInset * 0.9;
    const perSide = 14;
    const pts: [number, number][] = [];
    const pushEdge = (
      from: [number, number], to: [number, number], nrm: [number, number],
    ) => {
      for (let i = 0; i <= perSide; i++) {
        const t = i / perSide;
        const x = from[0] + (to[0] - from[0]) * t;
        const y = from[1] + (to[1] - from[1]) * t;
        const d = baseInset + (rand() - 0.3) * jag;
        pts.push([x + nrm[0] * d, y + nrm[1] * d]);
      }
    };
    pushEdge([0, 0], [S, 0], [0, 1]);   // top → inset downward
    pushEdge([S, 0], [S, S], [-1, 0]);  // right → inset left
    pushEdge([S, S], [0, S], [0, -1]);  // bottom → inset up
    pushEdge([0, S], [0, 0], [1, 0]);   // left → inset right
    const inner = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') + ' Z';
    // Outer rect + inner jagged hole, evenodd ⇒ only the border band is filled.
    parts.push(
      `<path d="M0,0 L${S},0 L${S},${S} L0,${S} Z ${inner}" fill="${color}" fill-rule="evenodd" opacity="${(0.55 + 0.35 * wear).toFixed(2)}"/>`,
    );
  }

  // ── Creases: fold lines crossing the canvas (dark ridges; pair with multiply) ──
  if (doCreases) {
    const n = Math.max(0, Math.round(foldCount));
    for (let i = 0; i < n; i++) {
      // Random near-straight line spanning the canvas.
      const vertical = rand() < 0.5;
      const pos = (0.15 + rand() * 0.7) * S;
      const drift = (rand() - 0.5) * S * 0.08;
      const x1 = vertical ? pos : 0;
      const y1 = vertical ? 0 : pos;
      const x2 = vertical ? pos + drift : S;
      const y2 = vertical ? S : pos + drift;
      const sw = (0.6 + rand() * 1.4) * (0.5 + wear);
      parts.push(
        `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="${sw.toFixed(2)}" opacity="${(0.25 + 0.3 * rand()).toFixed(2)}"/>`,
      );
    }
  }

  // ── Scuffs: scattered short scratches + specks ──
  if (doScuff) {
    const count = Math.round((20 + 60 * wear));
    for (let i = 0; i < count; i++) {
      const x = rand() * S;
      const y = rand() * S;
      if (rand() < 0.6) {
        const len = (2 + rand() * 14) * (0.5 + wear);
        const ang = rand() * Math.PI;
        parts.push(
          `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + Math.cos(ang) * len).toFixed(1)}" y2="${(y + Math.sin(ang) * len).toFixed(1)}" stroke="${color}" stroke-width="${(0.4 + rand() * 0.8).toFixed(2)}" opacity="${(0.1 + 0.4 * rand()).toFixed(2)}"/>`,
        );
      } else {
        parts.push(
          `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.4 + rand() * 1.6).toFixed(2)}" fill="${color}" opacity="${(0.1 + 0.4 * rand()).toFixed(2)}"/>`,
        );
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${parts.join('')}</svg>`;
}

export class WornEdgesGenerator implements IEphemeraGenerator {
  readonly typeId = 'worn-edges:standard';
  readonly categoryId = 'worn-edges';
  readonly displayName = 'Worn Edges / Creases';
  readonly description = 'Procedural damage overlay — torn borders, fold creases, and scuffs. Place full-canvas with a multiply (dark) or screen (light) blend mode.';

  getDefaultParams(): Record<string, unknown> {
    return {
      size: 512,
      style: 'all',
      wear: 0.5,
      foldCount: 3,
      color: '#000000',
      seed: 1,
    };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'size',      label: 'Size',       type: 'range',  default: 512, min: 128, max: 1024, step: 16, group: 'Size' },
      { key: 'style',     label: 'Damage',     type: 'select', default: 'all',
        options: [
          { value: 'all',     label: 'Everything'   },
          { value: 'torn',    label: 'Torn edges'   },
          { value: 'creases', label: 'Fold creases' },
          { value: 'scuffed', label: 'Scuffs/dust'  },
        ], group: 'Damage' },
      { key: 'wear',      label: 'Wear amount', type: 'range', default: 0.5, min: 0, max: 1, step: 0.05, group: 'Damage' },
      { key: 'foldCount', label: 'Fold count',  type: 'range', default: 3,   min: 0, max: 10, step: 1,   group: 'Damage' },
      { key: 'color',     label: 'Damage color', type: 'color', default: '#000000',                      group: 'Color' },
      { key: 'seed',      label: 'Seed',        type: 'seed',  default: 1,                                group: 'Color' },
    ];
  }

  generate(p: Record<string, unknown>): string {
    const size      = Number(p['size']      ?? 512);
    const style     = String(p['style']     ?? 'all') as 'torn' | 'creases' | 'scuffed' | 'all';
    const wear      = Math.max(0, Math.min(1, Number(p['wear'] ?? 0.5)));
    const foldCount = Math.round(Number(p['foldCount'] ?? 3));
    const color     = String(p['color']     ?? '#000000');
    const seed      = Math.round(Number(p['seed'] ?? 1)) || 1;
    return buildWornEdges(size, style, wear, foldCount, color, seed);
  }
}
