import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

// UPC-A uses the same L/R encoding as EAN-13 left/right groups
const UPC_L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const UPC_R = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];

function upcaCheckDigit(d: number[]): number {
  // d = 11 digits, returns check (12th)
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += d[i] * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}

function encodeUPCA(value: string): { bits: string; digits: number[] } | null {
  const raw = Array.from(value.replace(/\D/g, '')).map(Number);
  while (raw.length < 11) raw.push(0);
  const d11 = raw.slice(0, 11);
  const check = upcaCheckDigit(d11);
  const all12 = [...d11, check];

  let bits = '101'; // start guard
  for (let i = 0; i < 6; i++) bits += UPC_L[all12[i]];
  bits += '01010'; // center guard
  for (let i = 6; i < 12; i++) bits += UPC_R[all12[i]];
  bits += '101'; // end guard

  return { bits, digits: all12 };
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
  const guardExtra = showText ? fontSize * 1.2 : 0;
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
    const ff = `font-family="monospace" font-size="${fontSize}" fill="${barColor}"`;
    // UPC-A: first and last digit flanking the barcode, middle 10 digits split in two groups
    const leftCx  = quietZone + 3 * moduleW + (6 * 7 * moduleW) / 2;
    const rightCx = quietZone + (3 + 42 + 5) * moduleW + (6 * 7 * moduleW) / 2;
    textEl =
      `<text x="${quietZone - moduleW}" y="${ty}" text-anchor="middle" ${ff}>${digits[0]}</text>` +
      `<text x="${leftCx}" y="${ty}" text-anchor="middle" ${ff}>${digits.slice(1,6).join('')}</text>` +
      `<text x="${rightCx}" y="${ty}" text-anchor="middle" ${ff}>${digits.slice(6,11).join('')}</text>` +
      `<text x="${totalW - quietZone + moduleW}" y="${ty}" text-anchor="middle" ${ff}>${digits[11]}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${svgH}" viewBox="0 0 ${totalW} ${svgH}">${bgRect}${rects.join('')}${textEl}</svg>`;
}

export class BarcodeUPCAGenerator implements IEphemeraGenerator {
  readonly typeId = 'barcode:upca';
  readonly categoryId = 'barcode-1d';
  readonly displayName = 'UPC-A';
  readonly description = 'Universal Product Code 12-digit barcode with check digit computation.';

  getDefaultParams(): Record<string, unknown> {
    return { value: '03600029145', height: 80, moduleWidth: 2, quietZone: 20, barColor: '#000000', bgColor: '#ffffff', showText: true, fontSize: 11 };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'value',       label: 'Value (11 digits)', type: 'text',  default: '03600029145',   group: 'Data' },
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
    const encoded = encodeUPCA(String(p['value'] ?? '03600029145'));
    if (!encoded) return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><text x="10" y="40" fill="red" font-size="12">Invalid UPC-A</text></svg>`;
    return bitsToSvg(
      encoded.bits, encoded.digits,
      Number(p['height']      ?? 80),
      Number(p['moduleWidth'] ?? 2),
      Number(p['quietZone']   ?? 20),
      String(p['barColor']    ?? '#000000'),
      String(p['bgColor']     ?? '#ffffff'),
      Boolean(p['showText']   ?? true),
      Number(p['fontSize']    ?? 11),
    );
  }
}
