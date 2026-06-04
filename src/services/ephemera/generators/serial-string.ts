import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

// ── Seeded pseudo-random (xorshift32) ──────────────────────────────────────

function seededRng(seed: number) {
  let s = (seed >>> 0) || 0xdeadbeef;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

// ── Alphabet helpers ───────────────────────────────────────────────────────

const ALPHA_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ALPHA_LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS      = '0123456789';
const HEX_UPPER   = '0123456789ABCDEF';
const ALPHANUM    = ALPHA_UPPER + DIGITS;

function randomString(rng: () => number, alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}

// ── Format tokens ──────────────────────────────────────────────────────────
// Pattern: A=uppercase letter, 9=digit, X=hex, *=alphanumeric, #=any printable

function applyPattern(pattern: string, rng: () => number): string {
  let out = '';
  for (const ch of pattern) {
    switch (ch) {
      case 'A': out += randomString(rng, ALPHA_UPPER, 1); break;
      case 'a': out += randomString(rng, ALPHA_LOWER, 1); break;
      case '9': out += randomString(rng, DIGITS, 1); break;
      case 'X': out += randomString(rng, HEX_UPPER, 1); break;
      case '*': out += randomString(rng, ALPHANUM, 1); break;
      default:  out += ch; // literal
    }
  }
  return out;
}

// ── Preset patterns ────────────────────────────────────────────────────────

const PRESETS: Record<string, string> = {
  'serial':      'AAA-999999-X',
  'part-number': 'AA-9999-AA-99',
  'mac-address': 'XX:XX:XX:XX:XX:XX',
  'uuid-short':  'XXXXXXXX-XXXX-XXXX-XXXX',
  'military':    'A-9999-AAA-999',
  'product-key': 'XXXXX-XXXXX-XXXXX-XXXXX',
  'asset-tag':   'AST-AAAA999999',
  'custom':      '',
  'literal':     '',
};

// ── SVG builder ────────────────────────────────────────────────────────────

function buildSerialString(
  pattern: string,
  preset: string,
  seed: number,
  prefix: string,
  suffix: string,
  layout: 'single' | 'stacked' | 'label-box' | 'data-block',
  fontSize: number,
  fontFamily: string,
  color: string,
  bgColor: string,
  borderColor: string,
  showBorder: boolean,
  showLabel: boolean,
  labelText: string,
  letterSpacing: number,
  lines: number,
): string {
  const rng = seededRng(seed);
  const isLiteral = preset === 'literal';
  const resolvedPattern = (preset !== 'custom' && preset !== 'literal') ? PRESETS[preset] ?? PRESETS['serial'] : pattern;

  const generatedLines: string[] = [];
  for (let i = 0; i < lines; i++) {
    const body = isLiteral ? resolvedPattern : applyPattern(resolvedPattern, rng);
    generatedLines.push(prefix + body + suffix);
  }

  const charW = fontSize * 0.62;
  const lineH = fontSize * 1.5;
  const maxLen = Math.max(...generatedLines.map(l => l.length));
  const textW = maxLen * charW + letterSpacing * maxLen;

  let svgW: number, svgH: number;
  const padX = 16, padY = 10;
  const labelH = showLabel ? fontSize + 6 : 0;

  if (layout === 'single' || lines === 1) {
    svgW = Math.ceil(textW + padX * 2);
    svgH = Math.ceil(lineH + padY * 2 + labelH);
  } else if (layout === 'stacked') {
    svgW = Math.ceil(textW + padX * 2);
    svgH = Math.ceil(lineH * lines + padY * 2 + labelH);
  } else if (layout === 'label-box') {
    svgW = Math.ceil(textW + padX * 2);
    svgH = Math.ceil(lineH * lines + padY * 2 + labelH + 4);
  } else { // data-block: 2 columns
    const half = Math.ceil(lines / 2);
    svgW = Math.ceil(textW * 2 + padX * 3);
    svgH = Math.ceil(lineH * half + padY * 2 + labelH);
  }

  const parts: string[] = [];

  // Background
  if (bgColor !== 'transparent') {
    parts.push(`<rect x="0" y="0" width="${svgW}" height="${svgH}" fill="${bgColor}"/>`);
  }

  // Border
  if (showBorder) {
    const bw = 1.5;
    parts.push(`<rect x="${bw / 2}" y="${bw / 2}" width="${svgW - bw}" height="${svgH - bw}" fill="none" stroke="${borderColor}" stroke-width="${bw}"/>`);
    if (showLabel && labelText) {
      parts.push(`<line x1="0" y1="${labelH + padY / 2}" x2="${svgW}" y2="${labelH + padY / 2}" stroke="${borderColor}" stroke-width="${bw * 0.6}"/>`);
    }
  }

  // Label
  if (showLabel && labelText) {
    parts.push(`<text x="${padX}" y="${padY + fontSize * 0.75}" font-family='${fontFamily}' font-size="${fontSize * 0.65}" fill="${color}" opacity="0.55" letter-spacing="1">${labelText.toUpperCase()}</text>`);
  }

  const baseY = padY + labelH;

  // Text lines
  const monoFont = fontFamily.includes('mono') || fontFamily.toLowerCase().includes('courier') ? fontFamily : `"Courier New",Courier,monospace`;
  const ls = letterSpacing !== 0 ? ` letter-spacing="${letterSpacing}"` : '';

  if (layout === 'data-block' && lines > 1) {
    const half = Math.ceil(lines / 2);
    const colW = svgW / 2;
    for (let i = 0; i < lines; i++) {
      const col = i < half ? 0 : 1;
      const row = i < half ? i : i - half;
      const tx = padX + col * colW;
      const ty = baseY + padY / 2 + row * lineH + fontSize;
      parts.push(`<text x="${tx}" y="${ty}" font-family='${monoFont}' font-size="${fontSize}" fill="${color}"${ls}>${generatedLines[i]}</text>`);
    }
  } else {
    for (let i = 0; i < generatedLines.length; i++) {
      const ty = baseY + padY / 2 + i * lineH + fontSize;
      parts.push(`<text x="${padX}" y="${ty}" font-family="${monoFont}" font-size="${fontSize}" fill="${color}"${ls}>${generatedLines[i]}</text>`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">${parts.join('')}</svg>`;
}

export class SerialStringGenerator implements IEphemeraGenerator {
  readonly typeId = 'serial-string:standard';
  readonly categoryId = 'serial-string';
  readonly displayName = 'Serial / Data String';
  readonly description = 'Procedurally generated serial numbers, part numbers, MAC addresses, and product keys.';

  getDefaultParams(): Record<string, unknown> {
    return {
      preset: 'serial',
      pattern: 'AAA-999999-X',
      seed: 42,
      prefix: '',
      suffix: '',
      lines: 1,
      layout: 'single',
      fontSize: 14,
      fontFamily: '"Courier New",Courier,monospace',
      color: '#000000',
      bgColor: '#ffffff',
      borderColor: '#000000',
      showBorder: true,
      showLabel: false,
      labelText: 'SERIAL NO.',
      letterSpacing: 2,
    };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'preset',       label: 'Preset',        type: 'select', default: 'serial',
        options: [
          { value: 'serial',      label: 'Serial number'  },
          { value: 'part-number', label: 'Part number'    },
          { value: 'mac-address', label: 'MAC address'    },
          { value: 'uuid-short',  label: 'UUID (short)'   },
          { value: 'military',    label: 'Military ID'    },
          { value: 'product-key', label: 'Product key'    },
          { value: 'asset-tag',   label: 'Asset tag'      },
          { value: 'literal',     label: 'Type your own'  },
          { value: 'custom',      label: 'Custom pattern' },
        ],
        group: 'Data',
      },
      { key: 'pattern',      label: 'Value / pattern', type: 'text',   default: 'AAA-999999-X', group: 'Data' },
      { key: 'seed',         label: 'Seed',           type: 'seed',   default: 42,             group: 'Data' },
      { key: 'prefix',       label: 'Prefix',         type: 'text',   default: '',             group: 'Data' },
      { key: 'suffix',       label: 'Suffix',         type: 'text',   default: '',             group: 'Data' },
      { key: 'lines',        label: 'Line count',     type: 'range',  default: 1, min: 1, max: 8, step: 1, group: 'Layout' },
      { key: 'layout',       label: 'Layout',         type: 'select', default: 'single',
        options: [
          { value: 'single',     label: 'Single line'   },
          { value: 'stacked',    label: 'Stacked'       },
          { value: 'label-box',  label: 'Label box'     },
          { value: 'data-block', label: 'Data block (2-col)' },
        ],
        group: 'Layout',
      },
      { key: 'fontSize',     label: 'Font size',      type: 'range',  default: 14, min: 8, max: 36, step: 1, group: 'Text' },
      { key: 'letterSpacing',label: 'Letter spacing', type: 'range',  default: 2, min: -2, max: 10, step: 1, group: 'Text' },
      { key: 'showLabel',    label: 'Show label',     type: 'toggle', default: false, group: 'Text' },
      { key: 'labelText',    label: 'Label text',     type: 'text',   default: 'SERIAL NO.', group: 'Text' },
      { key: 'showBorder',   label: 'Border',         type: 'toggle', default: true,  group: 'Appearance' },
      { key: 'color',        label: 'Text color',     type: 'color',  default: '#000000', group: 'Appearance' },
      { key: 'bgColor',      label: 'Background',     type: 'color',  default: '#ffffff', group: 'Appearance' },
      { key: 'borderColor',  label: 'Border color',   type: 'color',  default: '#000000', group: 'Appearance' },
    ];
  }

  generate(p: Record<string, unknown>): string {
    return buildSerialString(
      String(p['pattern']      ?? 'AAA-999999-X'),
      String(p['preset']       ?? 'serial'),
      Math.round(Number(p['seed'] ?? 42)),
      String(p['prefix']       ?? ''),
      String(p['suffix']       ?? ''),
      String(p['layout']       ?? 'single') as 'single' | 'stacked' | 'label-box' | 'data-block',
      Number(p['fontSize']     ?? 14),
      String(p['fontFamily']   ?? '"Courier New",Courier,monospace'),
      String(p['color']        ?? '#000000'),
      String(p['bgColor']      ?? '#ffffff'),
      String(p['borderColor']  ?? '#000000'),
      Boolean(p['showBorder']  ?? true),
      Boolean(p['showLabel']   ?? false),
      String(p['labelText']    ?? 'SERIAL NO.'),
      Number(p['letterSpacing'] ?? 2),
      Math.round(Number(p['lines'] ?? 1)),
    );
  }
}
