/**
 * src/packaging/cd/cd-print.ts
 *
 * PURE print specification for each printed CD piece — the physical size, the print canvas pixel size at a given
 * DPI, and the crop / fold / bleed / safe MARKS. The dieline pieces (front insert, tray card, booklet) derive
 * their canvas + guides straight from their templates (already print-exact); the disc is a special circular
 * layout (outer cut, centre hole, stacking-ring safe). The browser layer rasterises the uploaded art onto a
 * canvas of this size and strokes these marks → a print-ready PNG (the host muxes PNGs → a print PDF).
 */

import { cdFrontInsert, CD_FRONT_INSERT } from '../templates/cd-front-insert';
import { cdTrayCard, CD_TRAY_CARD } from '../templates/cd-tray-card';
import { cdBooklet, CD_BOOKLET } from '../templates/cd-booklet';
import { CD_DISC } from './cd-disc-geometry';
import type { CDPiece } from './cd-kit-assembly';

type P2 = [number, number];
export type PrintMarkKind = 'cut' | 'fold' | 'bleed' | 'safe';

export interface PrintMark {
  kind: PrintMarkKind;
  color: string;
  /** Straight marks (px). */
  lines: [P2, P2][];
  /** Circular marks (px) — used by the disc. */
  circles: { cx: number; cy: number; r: number }[];
}

export interface CDPrintSpec {
  piece: CDPiece;
  widthMm: number;
  heightMm: number;
  dpi: number;
  widthPx: number;
  heightPx: number;
  marks: PrintMark[];
}

/** The four printed pieces (the case shells aren't printed). */
export const CD_PRINT_PIECES: CDPiece[] = ['frontInsert', 'trayCard', 'disc', 'booklet'];

const MARK_COLOR: Record<PrintMarkKind, string> = { cut: '#000000', fold: '#00aaff', bleed: '#ff3399', safe: '#33cc66' };

/** Disc printable-area / stacking-ring inner radius (mm) — art inside this may be obscured by the hub clamp. */
export const CD_DISC_SAFE_R = 18;

/** The print spec for a piece at `dpi` (default 300). Throws for a non-printed piece (lid/tray). */
export function cdPrintSpec(piece: CDPiece, dpi = 300): CDPrintSpec {
  if (piece === 'disc') {
    const wMm = CD_DISC.outerR * 2;                 // 120
    const px = Math.round(wMm / 25.4 * dpi);
    const c = px / 2;
    const rPx = (mm: number): number => mm / 25.4 * dpi;
    const marks: PrintMark[] = [
      { kind: 'cut', color: MARK_COLOR.cut, lines: [], circles: [{ cx: c, cy: c, r: rPx(CD_DISC.outerR) }] },
      { kind: 'cut', color: MARK_COLOR.cut, lines: [], circles: [{ cx: c, cy: c, r: rPx(CD_DISC.innerR) }] },   // centre hole
      { kind: 'safe', color: MARK_COLOR.safe, lines: [], circles: [{ cx: c, cy: c, r: rPx(CD_DISC_SAFE_R) }] }, // stacking ring
    ];
    return { piece, widthMm: wMm, heightMm: wMm, dpi, widthPx: px, heightPx: px, marks };
  }

  const tpl = piece === 'frontInsert' ? { fn: cdFrontInsert, wMm: CD_FRONT_INSERT.size, hMm: CD_FRONT_INSERT.size }
    : piece === 'trayCard' ? { fn: cdTrayCard, wMm: CD_TRAY_CARD.totalW, hMm: CD_TRAY_CARD.height }
    : piece === 'booklet' ? { fn: cdBooklet, wMm: 2 * CD_BOOKLET.leaf, hMm: CD_BOOKLET.leaf }
    : null;
  if (!tpl) throw new Error(`cdPrintSpec: '${piece}' is not a printed piece`);

  const r = tpl.fn({ width: 0, height: 0, depth: 0, dpi });
  const marks: PrintMark[] = [];
  for (const g of r.guides) {
    if (g.type === 'panel') continue;               // panel outlines are editor-only, not print marks
    const kind = g.type as PrintMarkKind;
    marks.push({ kind, color: MARK_COLOR[kind] ?? '#000000', lines: g.segments as [P2, P2][], circles: [] });
  }
  return { piece, widthMm: tpl.wMm, heightMm: tpl.hMm, dpi, widthPx: r.canvasWidth, heightPx: r.canvasHeight, marks };
}
