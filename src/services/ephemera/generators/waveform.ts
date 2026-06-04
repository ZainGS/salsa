import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

function seededRng(seed: number) {
  let s = (seed >>> 0) || 0xdeadbeef;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

function buildWaveform(
  width: number,
  height: number,
  style: 'spectrum' | 'eq' | 'ecg' | 'histogram',
  barCount: number,
  barWidth: number,
  gap: number,
  seed: number,
  minHeight: number,
  rounded: boolean,
  mirror: boolean,
  color: string,
  bgColor: string,
  strokeWidth: number,
): string {
  const rng = seededRng(seed);
  const parts: string[] = [];

  const bg = bgColor !== 'transparent'
    ? `<rect x="0" y="0" width="${width}" height="${height}" fill="${bgColor}"/>`
    : '';

  if (style === 'spectrum' || style === 'eq' || style === 'histogram') {
    const totalBarW = barWidth + gap;
    const actualBars = Math.min(barCount, Math.floor(width / totalBarW));
    const totalUsed = actualBars * totalBarW - gap;
    const startX = (width - totalUsed) / 2;
    const rx = rounded ? Math.min(barWidth / 2, 3) : 0;
    const minH = height * (minHeight / 100);

    for (let i = 0; i < actualBars; i++) {
      let t: number;
      if (style === 'eq') {
        // Bell curve with jitter
        const center = actualBars / 2;
        const spread = actualBars / 3;
        t = Math.exp(-0.5 * Math.pow((i - center) / spread, 2)) * (0.6 + rng() * 0.4);
      } else if (style === 'histogram') {
        // Quasi-normal distribution
        t = Math.max(0, Math.min(1, 0.15 + rng() * 0.85));
      } else {
        t = minHeight / 100 + rng() * (1 - minHeight / 100);
      }

      const bh = Math.max(minH, t * (mirror ? height / 2 : height));
      const bx = startX + i * totalBarW;

      if (mirror) {
        const by = height / 2 - bh;
        parts.push(`<rect x="${bx.toFixed(2)}" y="${by.toFixed(2)}" width="${barWidth}" height="${(bh * 2).toFixed(2)}" rx="${rx}" ry="${rx}" fill="${color}"/>`);
      } else {
        const by = height - bh;
        parts.push(`<rect x="${bx.toFixed(2)}" y="${by.toFixed(2)}" width="${barWidth}" height="${bh.toFixed(2)}" rx="${rx}" ry="${rx}" fill="${color}"/>`);
      }
    }

  } else if (style === 'ecg') {
    // ECG/heartbeat trace
    const baseY = height * 0.65;
    const amplitude = height * 0.55;
    const pts: string[] = [];

    // Build ECG-like signal: flat → P wave → Q dip → R spike → S dip → T wave → flat
    const steps = 200;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = t * width;
      let y = baseY;

      // Repeat the pattern 2-3 times
      const period = 0.33;
      const tp = (t % period) / period;

      if (tp < 0.1) {
        // flat
        y = baseY;
      } else if (tp < 0.15) {
        // P wave (small bump)
        const p = (tp - 0.1) / 0.05;
        y = baseY - amplitude * 0.12 * Math.sin(p * Math.PI);
      } else if (tp < 0.25) {
        // Q dip
        const p = (tp - 0.15) / 0.1;
        y = baseY + amplitude * 0.08 * Math.sin(p * Math.PI * 0.5);
      } else if (tp < 0.32) {
        // R spike (sharp up)
        const p = (tp - 0.25) / 0.07;
        y = baseY - amplitude * 0.85 * Math.sin(p * Math.PI);
      } else if (tp < 0.40) {
        // S dip
        const p = (tp - 0.32) / 0.08;
        y = baseY + amplitude * 0.15 * Math.sin(p * Math.PI * 0.5);
      } else if (tp < 0.55) {
        // T wave
        const p = (tp - 0.40) / 0.15;
        y = baseY - amplitude * 0.25 * Math.sin(p * Math.PI);
      } else {
        y = baseY;
      }

      pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`);
    }

    parts.push(`<path d="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${bg}${parts.join('')}</svg>`;
}

export class WaveformGenerator implements IEphemeraGenerator {
  readonly typeId = 'waveform:standard';
  readonly categoryId = 'waveform';
  readonly displayName = 'Waveform / Data Bars';
  readonly description = 'Audio spectrum bars, EQ curves, ECG/heartbeat trace, and histogram.';

  getDefaultParams(): Record<string, unknown> {
    return {
      width: 200, height: 60, style: 'spectrum',
      barCount: 24, barWidth: 4, gap: 2, seed: 1,
      minHeight: 10, rounded: false, mirror: false,
      color: '#000000', bgColor: 'transparent', strokeWidth: 1.5,
    };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'width',      label: 'Width',         type: 'range',  default: 200, min: 60,  max: 600, step: 4, group: 'Size' },
      { key: 'height',     label: 'Height',        type: 'range',  default: 60,  min: 20,  max: 300, step: 4, group: 'Size' },
      { key: 'style',      label: 'Style',         type: 'select', default: 'spectrum',
        options: [
          { value: 'spectrum',  label: 'Spectrum bars'  },
          { value: 'eq',        label: 'EQ curve'       },
          { value: 'ecg',       label: 'ECG / Heartbeat'},
          { value: 'histogram', label: 'Histogram'      },
        ],
      },
      { key: 'barCount',   label: 'Bar count',     type: 'range',  default: 24,  min: 4,  max: 64,  step: 1, group: 'Bars' },
      { key: 'barWidth',   label: 'Bar width',     type: 'range',  default: 4,   min: 1,  max: 20,  step: 1, group: 'Bars' },
      { key: 'gap',        label: 'Gap',           type: 'range',  default: 2,   min: 0,  max: 10,  step: 1, group: 'Bars' },
      { key: 'seed',       label: 'Seed',          type: 'seed',   default: 1,                              group: 'Bars' },
      { key: 'minHeight',  label: 'Min height (%)',type: 'range',  default: 10,  min: 0,  max: 50,  step: 1, group: 'Bars' },
      { key: 'rounded',    label: 'Rounded tops',  type: 'toggle', default: false,                          group: 'Bars' },
      { key: 'mirror',     label: 'Mirror (center)',type:'toggle', default: false,                          group: 'Bars' },
      { key: 'strokeWidth',label: 'Trace weight',  type: 'range',  default: 1.5, min: 0.5,max: 4,   step: 0.25, group: 'ECG' },
      { key: 'color',      label: 'Color',         type: 'color',  default: '#000000',                      group: 'Appearance' },
      { key: 'bgColor',    label: 'Background',    type: 'color',  default: 'transparent',                  group: 'Appearance' },
    ];
  }

  generate(p: Record<string, unknown>): string {
    return buildWaveform(
      Number(p['width']       ?? 200),
      Number(p['height']      ?? 60),
      String(p['style']       ?? 'spectrum') as any,
      Math.round(Number(p['barCount']   ?? 24)),
      Number(p['barWidth']    ?? 4),
      Number(p['gap']         ?? 2),
      Math.round(Number(p['seed']       ?? 1)),
      Number(p['minHeight']   ?? 10),
      Boolean(p['rounded']    ?? false),
      Boolean(p['mirror']     ?? false),
      String(p['color']       ?? '#000000'),
      String(p['bgColor']     ?? 'transparent'),
      Number(p['strokeWidth'] ?? 1.5),
    );
  }
}
