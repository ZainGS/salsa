import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

// ── Code 128B encoding table ─────────────────────────────────────────
// 107 entries (0-106). Each is an 11-module binary string: '1'=bar, '0'=space.
// Indices 0-94 map to Code 128B values (ASCII 32-126 = index + 32).
// Indices 103/104/105 = START A/B/C; 106 = STOP (body, excluding trailing bar).
const PATTERNS: string[] = [
  '11011001100', // 0   ' '
  '11001101100', // 1   '!'
  '11001100110', // 2   '"'
  '10010011000', // 3   '#'
  '10010001100', // 4   '$'
  '10001001100', // 5   '%'
  '10011001000', // 6   '&'
  '10011000100', // 7   "'"
  '10001100100', // 8   '('
  '11001001000', // 9   ')'
  '11001000100', // 10  '*'
  '11000100100', // 11  '+'
  '10110011100', // 12  ','
  '10011011100', // 13  '-'
  '10011001110', // 14  '.'
  '10111001100', // 15  '/'
  '10011101100', // 16  '0'
  '10011100110', // 17  '1'
  '11001110010', // 18  '2'
  '11001011100', // 19  '3'
  '11001001110', // 20  '4'
  '11011100100', // 21  '5'
  '11001110100', // 22  '6'
  '11101101110', // 23  '7'
  '11101001100', // 24  '8'
  '11100101100', // 25  '9'
  '11100100110', // 26  ':'
  '11101100100', // 27  ';'
  '11100110100', // 28  '<'
  '11100110010', // 29  '='
  '11011011000', // 30  '>'
  '11011000110', // 31  '?'
  '11000110110', // 32  '@'
  '10100011000', // 33  'A'
  '10001011000', // 34  'B'
  '10001000110', // 35  'C'
  '10110001000', // 36  'D'
  '10001101000', // 37  'E'
  '10001100010', // 38  'F'
  '11010001000', // 39  'G'
  '11000101000', // 40  'H'
  '11000100010', // 41  'I'
  '10110111100', // 42  'J'
  '10110001110', // 43  'K'
  '10001101110', // 44  'L'
  '10111011000', // 45  'M'
  '10111000110', // 46  'N'
  '10001110110', // 47  'O'
  '11101110110', // 48  'P'
  '11010001110', // 49  'Q'
  '11000101110', // 50  'R'
  '11011101000', // 51  'S'
  '11011100010', // 52  'T'
  '11011101110', // 53  'U'
  '11101011000', // 54  'V'
  '11101000110', // 55  'W'
  '11100010110', // 56  'X'
  '11101101000', // 57  'Y'
  '11101100010', // 58  'Z'
  '11100011010', // 59  '['
  '11101111010', // 60  '\\'
  '11001000010', // 61  ']'
  '11110100010', // 62  '^'
  '10100110000', // 63  '_'
  '10100001100', // 64  '`'
  '10010110000', // 65  'a'
  '10010000110', // 66  'b'
  '10000101100', // 67  'c'
  '10000100110', // 68  'd'
  '10110010000', // 69  'e'
  '10110000100', // 70  'f'
  '10011010000', // 71  'g'
  '10011000010', // 72  'h'
  '10000110100', // 73  'i'
  '10000110010', // 74  'j'
  '11000010010', // 75  'k'
  '11001010000', // 76  'l'
  '11110111010', // 77  'm'
  '11000010100', // 78  'n'
  '10001111010', // 79  'o'
  '10100111100', // 80  'p'
  '10010111100', // 81  'q'
  '10010011110', // 82  'r'
  '10111100100', // 83  's'
  '10011110100', // 84  't'
  '10011110010', // 85  'u'
  '11110100100', // 86  'v'
  '11110010100', // 87  'w'
  '11110010010', // 88  'x'
  '11011011110', // 89  'y'
  '11011110110', // 90  'z'
  '11110110110', // 91  '{'
  '10101111000', // 92  '|'
  '10100011110', // 93  '}'
  '10001011110', // 94  '~'
  '10111101000', // 95  DEL (not used in 128B)
  '10111100010', // 96
  '11110101000', // 97
  '11110100010', // 98
  '10111011110', // 99
  '10111101110', // 100  Code C symbol
  '11101011110', // 101  Code B symbol
  '11010000100', // 102  FNC1
  '11010010000', // 103  START A
  '11010011110', // 104  START B
  '11010111000', // 105  START C
  '11000111010', // 106  STOP (11 modules; caller appends '11' trailing bar)
];

const START_B = 104;
const STOP    = 106;
const STOP_TRAILER = '11'; // Code 128 stop has a 2-module trailing bar

function encodeCode128B(value: string): string {
  // Clamp to printable ASCII 32-126
  const chars = Array.from(value).filter(c => {
    const cp = c.charCodeAt(0);
    return cp >= 32 && cp <= 126;
  });
  if (chars.length === 0) return '';

  const symbolValues: number[] = [];
  symbolValues.push(START_B);
  for (const ch of chars) {
    symbolValues.push(ch.charCodeAt(0) - 32);
  }

  // Checksum: start_value + sum(position * char_value) mod 103
  let check = START_B;
  for (let i = 0; i < chars.length; i++) {
    check += (i + 1) * (chars[i].charCodeAt(0) - 32);
  }
  check %= 103;
  symbolValues.push(check);
  symbolValues.push(STOP);

  return symbolValues.map((v, i) => {
    const p = PATTERNS[v];
    return i === symbolValues.length - 1 ? p + STOP_TRAILER : p;
  }).join('');
}

// ── SVG rendering ───────────────────────────────────────────────────

function patternToSvg(
  bits: string,
  w: number, h: number,
  quietZone: number,
  moduleWidth: number,
  barColor: string,
  bgColor: string,
  showText: boolean,
  textValue: string,
  fontSize: number,
): string {
  const totalWidth = quietZone * 2 + bits.length * moduleWidth;
  const textHeight = showText ? fontSize + 6 : 0;
  const svgHeight = h + textHeight;

  const rects: string[] = [];
  let x = quietZone;
  let runStart = x;
  let runLen = 0;
  let inBar = false;

  for (let i = 0; i <= bits.length; i++) {
    const bit = i < bits.length ? bits[i] : null;
    const isBar = bit === '1';

    if (i === 0) {
      inBar = isBar;
      runStart = x;
      runLen = moduleWidth;
    } else {
      if (isBar === inBar && bit !== null) {
        runLen += moduleWidth;
      } else {
        if (inBar) {
          rects.push(`<rect x="${runStart}" y="0" width="${runLen}" height="${h}" fill="${barColor}"/>`);
        }
        inBar = isBar;
        runStart = x;
        runLen = moduleWidth;
      }
    }
    x += moduleWidth;
  }

  const bgRect = bgColor !== 'transparent'
    ? `<rect x="0" y="0" width="${totalWidth}" height="${svgHeight}" fill="${bgColor}"/>`
    : '';

  const textEl = showText
    ? `<text x="${totalWidth / 2}" y="${h + fontSize + 1}" text-anchor="middle" font-family="monospace" font-size="${fontSize}" fill="${barColor}">${textValue}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${svgHeight}" viewBox="0 0 ${totalWidth} ${svgHeight}">${bgRect}${rects.join('')}${textEl}</svg>`;
}

// ── Generator ───────────────────────────────────────────────────────

export class BarcodeCode128Generator implements IEphemeraGenerator {
  readonly typeId = 'barcode:code128';
  readonly categoryId = 'barcode-1d';
  readonly displayName = 'Code 128';
  readonly description = 'Alphanumeric barcode supporting all printable ASCII characters.';

  getDefaultParams(): Record<string, unknown> {
    return {
      value: 'FROGMARKS',
      width: 240,
      height: 80,
      moduleWidth: 2,
      quietZone: 20,
      barColor: '#000000',
      bgColor: '#ffffff',
      showText: true,
      fontSize: 11,
    };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'value',      label: 'Value',        type: 'text',   default: 'FROGMARKS',  group: 'Data' },
      { key: 'showText',   label: 'Show text',    type: 'toggle', default: true,          group: 'Data' },
      { key: 'fontSize',   label: 'Font size',    type: 'range',  default: 11, min: 6, max: 18, step: 1, group: 'Data' },
      { key: 'height',     label: 'Bar height',   type: 'range',  default: 80, min: 20, max: 200, step: 4, group: 'Size' },
      { key: 'moduleWidth',label: 'Module width', type: 'range',  default: 2,  min: 1,  max: 5,   step: 0.5, group: 'Size' },
      { key: 'quietZone',  label: 'Quiet zone',   type: 'range',  default: 20, min: 4,  max: 40,  step: 2, group: 'Size' },
      { key: 'barColor',   label: 'Bar color',    type: 'color',  default: '#000000', group: 'Appearance' },
      { key: 'bgColor',    label: 'Background',   type: 'color',  default: '#ffffff', group: 'Appearance' },
    ];
  }

  generate(p: Record<string, unknown>): string {
    const value      = String(p['value']      ?? 'FROGMARKS');
    const height     = Number(p['height']     ?? 80);
    const moduleWidth = Number(p['moduleWidth'] ?? 2);
    const quietZone  = Number(p['quietZone']  ?? 20);
    const barColor   = String(p['barColor']   ?? '#000000');
    const bgColor    = String(p['bgColor']    ?? '#ffffff');
    const showText   = Boolean(p['showText']  ?? true);
    const fontSize   = Number(p['fontSize']   ?? 11);

    const bits = encodeCode128B(value);
    if (!bits) return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="${height}"><text x="10" y="${height/2}" fill="red" font-size="12">Invalid input</text></svg>`;

    const totalWidth = quietZone * 2 + bits.length * moduleWidth;
    return patternToSvg(bits, height, totalWidth, quietZone, moduleWidth, barColor, bgColor, showText, value, fontSize);
  }
}
