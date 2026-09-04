import { describe, it, expect } from 'vitest';
import { cdKitAssembly, cdComponentView, CD_CASE, CD_LID_OPEN_RAD, CD_ALL_PIECES, CD_EDITABLE_COMPONENTS, CD_PIECE_WIDTH, type CDPiece } from './cd-kit-assembly';

const dims = { ...CD_CASE };
const PIECES: CDPiece[] = ['lid', 'trayBack', 'disc', 'frontInsert', 'booklet', 'trayCard'];
const xspine = -dims.width / 2;

describe('cdKitAssembly', () => {
  it('t=0 is a compact closed case: lid unrotated & centred, tray back at the origin', () => {
    const p = cdKitAssembly(dims, 0);
    for (const piece of PIECES) expect(Math.abs(p[piece].pos[2])).toBeLessThanOrEqual(dims.thickness + 1e-6);
    expect(p.lid.rot[1]).toBeCloseTo(0, 6);
    expect(p.lid.pos[0]).toBeCloseTo(0, 6);          // the lid sits centred over the case when closed
    expect(p.trayBack.pos[2]).toBeCloseTo(0, 6);     // tray back is the anchor
  });

  it('tray + tray-card CENTRED; disc RIGHT-aligned; front insert + booklet OPEN WITH THE LID', () => {
    const p = cdKitAssembly(dims, 1);
    for (const piece of ['trayBack', 'trayCard'] as CDPiece[]) expect(p[piece].pos[0]).toBeCloseTo(0, 6);
    const innerRight = dims.width / 2 - 2;
    // the disc stays right-aligned on the tray hub (exposed once the cover swings open)
    expect(p.disc.pos[0] + CD_PIECE_WIDTH.disc / 2).toBeCloseTo(innerRight, 6);
    // the front insert + booklet are held in the lid → they rotate open on the SAME hinge as the lid
    expect(p.frontInsert.rot[1]).toBeCloseTo(-CD_LID_OPEN_RAD, 5);
    expect(p.booklet.rot[1]).toBeCloseTo(-CD_LID_OPEN_RAD, 5);
    expect(p.lid.rot[1]).toBeCloseTo(-CD_LID_OPEN_RAD, 5);
    // and they swing FORWARD (+z) with the cover instead of lying flat in the tray
    expect(p.frontInsert.pos[2]).toBeGreaterThan(0);
    expect(p.booklet.pos[2]).toBeGreaterThan(0);
  });

  it('t=1 opens the lid FORWARD (+z) about the fixed spine, tray back stays put, tray pieces fan out', () => {
    const p = cdKitAssembly(dims, 1);
    expect(p.lid.rot[1]).toBeCloseTo(-CD_LID_OPEN_RAD, 5);   // NEGATIVE = forward
    expect(p.lid.pos[2]).toBeGreaterThan(0);                // swung toward the viewer
    expect(p.lid.pos[0]).toBeLessThan(0);                   // and around toward the spine
    expect(p.trayBack.pos[2]).toBeCloseTo(0, 6);            // the black back does NOT translate
    expect(p.disc.pos[2]).toBeGreaterThan(0);               // the disc lifts toward the viewer out of the tray
    expect(p.trayCard.pos[2]).toBeLessThan(-10);            // the tray card fans behind
    const flat: CDPiece[] = ['trayCard', 'trayBack', 'disc'];   // the pieces that stay in the tray separate along z
    const zs = flat.map(pc => p[pc].pos[2]).sort((a, b) => a - b);
    for (let i = 1; i < zs.length; i++) expect(zs[i] - zs[i - 1]).toBeGreaterThan(1);
  });

  it('the lid opening is monotonic across the scrub', () => {
    let prev = 1;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const a = cdKitAssembly(dims, t).lid.rot[1];   // grows more negative
      expect(a).toBeLessThanOrEqual(prev + 1e-9);
      prev = a;
    }
  });

  it('clamps t outside [0,1]', () => {
    expect(cdKitAssembly(dims, -5).lid.rot[1]).toBeCloseTo(0, 6);
    expect(cdKitAssembly(dims, 5).lid.rot[1]).toBeCloseTo(-CD_LID_OPEN_RAD, 5);
  });
});

describe('cdComponentView', () => {
  it('Complete shows every piece, no focus, scrub live', () => {
    const v = cdComponentView('complete');
    expect(v.visiblePieces).toEqual(CD_ALL_PIECES);
    expect(v.focusPiece).toBeNull();
    expect(v.scrubEnabled).toBe(true);
  });

  it('a piece component isolates + focuses that piece, scrub off', () => {
    for (const c of CD_EDITABLE_COMPONENTS) {
      const v = cdComponentView(c);
      expect(v.visiblePieces).toEqual([c]);
      expect(v.focusPiece).toBe(c);
      expect(v.scrubEnabled).toBe(false);
    }
  });

  it('the case shells are never editable components', () => {
    expect(CD_EDITABLE_COMPONENTS).not.toContain('lid' as never);
    expect(CD_EDITABLE_COMPONENTS).not.toContain('trayBack' as never);
  });
});
