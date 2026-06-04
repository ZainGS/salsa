import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

// ── EAN / UPC encoding tables (7 modules each) ─────────────────────────────
const EAN_L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const EAN_G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const EAN_R = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];

// First digit parity for left group (false=L, true=G)
const EAN13_PARITY = [
  [false,false,false,false,false,false],
  [false,false,true, false,true, true ],
  [false,false,true, true, false,true ],
  [false,false,true, true, true, false],
  [false,true, false,false,true, true ],
  [false,true, true, false,false,true ],
  [false,true, true, true, false,false],
  [false,true, false,true, false,true ],
  [false,true, false,true, true, false],
  [false,true, true, false,true, false],
];

function ean13CheckDigit(d: number[]): number {
  // d = 12 digits
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += d[i] * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

function encodeEAN13(value: string): { bits: string; digits: number[] } | null {
  const digits = Array.from(value.replace(/\D/g, '')).map(Number);
  // Pad/trim to 12 data digits (check will be appended)
  while (digits.length < 12) digits.push(0);
  const data12 = digits.slice(0, 12);
  const check = ean13CheckDigit(data12);
  const all13 = [...data12, check];

  const first = all13[0];
  const parity = EAN13_PARITY[first];

  let bits = '101'; // start guard
  for (let i = 1; i <= 6; i++) {
    const d = all13[i];
    bits += parity[i - 1] ? EAN_G[d] : EAN_L[d];
  }
  bits += '01010'; // center guard
  for (let i = 7; i <= 12; i++) {
    bits += EAN_R[all13[i]];
  }
  bits += '101'; // end guard

  return { bits, digits: all13 };
}

function bitsToSvg(
  bits: string,
  digits: number[],
  barH: number,
  moduleW: number,
  quietZone: number,
  barColor: string,
  bgColor: string,
  showText: boolean,
  fontSize: number,
): string {
  const totalW = quietZone * 2 + bits.length * moduleW;
  const guardExtra = showText ? fontSize * 1.2 : 0; // guards extend below text baseline
  const textH = showText ? fontSize + 6 : 0;
  const svgH = barH + textH;

  const rects: string[] = [];
  let x = quietZone;
  let runStart = x;
  let runLen = 0;
  let inBar = false;

  for (let i = 0; i <= bits.length; i++) {
    const bit = i < bits.length ? bits[i] : null;
    const isBar = bit === '1';
    if (i === 0) { inBar = isBar; runStart = x; runLen = moduleW; }
    else {
      if (isBar === inBar && bit !== null) { runLen += moduleW; }
      else {
        // Guard bars (positions 0-2, 45-49, 92-94) extend by guardExtra
        const bitIdx = Math.round((runStart - quietZone) / moduleW);
        const isGuard = bitIdx < 3 || (bitIdx >= 45 && bitIdx <= 49) || bitIdx >= 92;
        if (inBar) {
          const h = showText && isGuard ? barH + guardExtra : barH;
          rects.push(`<rect x="${runStart}" y="0" width="${runLen}" height="${h.toFixed(1)}" fill="${barColor}"/>`);
        }
        inBar = isBar; runStart = x; runLen = moduleW;
      }
    }
    x += moduleW;
  }

  const bgRect = bgColor !== 'transparent'
    ? `<rect x="0" y="0" width="${totalW}" height="${svgH}" fill="${bgColor}"/>`
    : '';

  let textEl = '';
  if (showText) {
    const ty = barH + guardExtra + fontSize;
    // First digit left of barcode, then two groups of 6 digits in center zones
    const leftCx = quietZone + 3 * moduleW + 6 * 7 * moduleW / 2;
    const rightCx = quietZone + (3 + 42 + 5) * moduleW + 6 * 7 * moduleW / 2;
    const firstX = quietZone - moduleW;
    const ff = `font-family="monospace" font-size="${fontSize}" fill="${barColor}"`;
    textEl = `<text x="${firstX}" y="${ty}" text-anchor="middle" ${ff}>${digits[0]}</text>` +
      `<text x="${leftCx}" y="${ty}" text-anchor="middle" ${ff}>${digits.slice(1,7).join('')}</text>` +
      `<text x="${rightCx}" y="${ty}" text-anchor="middle" ${ff}>${digits.slice(7,13).join('')}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${svgH}" viewBox="0 0 ${totalW} ${svgH}">${bgRect}${rects.join('')}${textEl}</svg>`;
}

export class BarcodeEAN13Generator implements IEphemeraGenerator {
  readonly typeId = 'barcode:ean13';
  readonly categoryId = 'barcode-1d';
  readonly displayName = 'EAN-13';
  readonly description = 'European Article Number 13-digit barcode with check digit computation.';

  getDefaultParams(): Record<string, unknown> {
    return { value: '590123412345', height: 80, moduleWidth: 2, quietZone: 20, barColor: '#000000', bgColor: '#ffffff', showText: true, fontSize: 11 };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'value',       label: 'Value (12 digits)', type: 'text',  default: '590123412345',  group: 'Data' },
      { key: 'showText',    label: 'Show digits',       type: 'toggle',default: true,            group: 'Data' },
      { key: 'fontSize',    label: 'Font size',         type: 'range', default: 11, min: 6, max: 18, step: 1, group: 'Data' },
      { key: 'height',      label: 'Bar height',        type: 'range', default: 80, min: 20, max: 200, step: 4, group: 'Size' },
      { key: 'moduleWidth', label: 'Module width',      type: 'range', default: 2,  min: 1,  max: 5,   step: 0.5, group: 'Size' },
      { key: 'quietZone',   label: 'Quiet zone',        type: 'range', default: 20, min: 7,  max: 40,  step: 1, group: 'Size' },
      { key: 'barColor',    label: 'Bar color',         type: 'color', default: '#000000', group: 'Appearance' },
      { key: 'bgColor',     label: 'Background',        type: 'color', default: '#ffffff', group: 'Appearance' },
    ];
  }

  generate(p: Record<string, unknown>): string {
    const value      = String(p['value']      ?? '590123412345');
    const height     = Number(p['height']     ?? 80);
    const moduleW    = Number(p['moduleWidth'] ?? 2);
    const quietZone  = Number(p['quietZone']  ?? 20);
    const barColor   = String(p['barColor']   ?? '#000000');
    const bgColor    = String(p['bgColor']    ?? '#ffffff');
    const showText   = Boolean(p['showText']  ?? true);
    const fontSize   = Number(p['fontSize']   ?? 11);

    const encoded = encodeEAN13(value);
    if (!encoded) return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="${height}"><text x="10" y="${height/2}" fill="red" font-size="12">Invalid EAN-13</text></svg>`;
    return bitsToSvg(encoded.bits, encoded.digits, height, moduleW, quietZone, barColor, bgColor, showText, fontSize);
  }
}
