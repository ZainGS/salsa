import { describe, it, expect } from 'vitest';
import { cdPrintSpec, CD_PRINT_PIECES, CD_DISC_SAFE_R } from './cd-print';
import { CD_FRONT_INSERT } from '../templates/cd-front-insert';
import { CD_TRAY_CARD } from '../templates/cd-tray-card';
import { CD_BOOKLET } from '../templates/cd-booklet';
import { CD_DISC } from './cd-disc-geometry';

describe('cdPrintSpec — dieline pieces', () => {
  it('front insert: 120×120 mm, 300 DPI, cut + bleed marks, no fold', () => {
    const s = cdPrintSpec('frontInsert');
    expect(s.widthMm).toBe(CD_FRONT_INSERT.size);
    expect(s.heightMm).toBe(CD_FRONT_INSERT.size);
    expect(s.widthPx).toBe(Math.round(CD_FRONT_INSERT.size / 25.4 * 300));
    expect(s.marks.some(m => m.kind === 'cut')).toBe(true);
    expect(s.marks.some(m => m.kind === 'bleed')).toBe(true);
    expect(s.marks.some(m => m.kind === 'fold')).toBe(false);
  });

  it('tray card: 150×118 mm with fold (spine) marks', () => {
    const s = cdPrintSpec('trayCard');
    expect(s.widthMm).toBe(CD_TRAY_CARD.totalW);
    expect(s.heightMm).toBe(CD_TRAY_CARD.height);
    const fold = s.marks.find(m => m.kind === 'fold');
    expect(fold).toBeTruthy();
    expect(fold!.lines.length).toBe(2);              // two spine creases
  });

  it('booklet: 240×120 mm flat with a single spine fold', () => {
    const s = cdPrintSpec('booklet');
    expect(s.widthMm).toBe(2 * CD_BOOKLET.leaf);
    expect(s.heightMm).toBe(CD_BOOKLET.leaf);
    expect(s.marks.find(m => m.kind === 'fold')!.lines.length).toBe(1);
  });

  it('scales with DPI', () => {
    expect(cdPrintSpec('frontInsert', 600).widthPx).toBe(Math.round(CD_FRONT_INSERT.size / 25.4 * 600));
  });
});

describe('cdPrintSpec — disc', () => {
  const s = cdPrintSpec('disc');
  it('is a square 120 mm canvas', () => {
    expect(s.widthMm).toBe(CD_DISC.outerR * 2);
    expect(s.widthPx).toBe(s.heightPx);
  });
  it('has concentric circle marks: outer cut, centre hole, and a safe stacking-ring, all centred', () => {
    const circles = s.marks.flatMap(m => m.circles);
    expect(circles.length).toBe(3);
    const c = s.widthPx / 2;
    for (const ci of circles) { expect(ci.cx).toBeCloseTo(c, 6); expect(ci.cy).toBeCloseTo(c, 6); }
    const radiiMm = circles.map(ci => ci.r / (300 / 25.4)).sort((a, b) => a - b);
    expect(radiiMm[0]).toBeCloseTo(CD_DISC.innerR, 3);     // hole (smallest)
    expect(radiiMm[1]).toBeCloseTo(CD_DISC_SAFE_R, 3);     // stacking ring
    expect(radiiMm[2]).toBeCloseTo(CD_DISC.outerR, 3);     // outer cut (largest)
  });
});

describe('cdPrintSpec — guards', () => {
  it('CD_PRINT_PIECES are exactly the four printed pieces (no case shells)', () => {
    expect(CD_PRINT_PIECES.sort()).toEqual(['booklet', 'disc', 'frontInsert', 'trayCard']);
  });
  it('throws for a non-printed piece', () => {
    expect(() => cdPrintSpec('lid')).toThrow();
    expect(() => cdPrintSpec('trayBack')).toThrow();
  });
});
