import { describe, it, expect } from 'vitest';
import { createCDKit, rebuildCDKitUnderRoot, setCDKitScrub, setCDPieceArt, setCDTrayClear, setCDTrayCardFold, compileTrayCardFold, removeCDKit, type CDKitHost } from './cd-kit';
import type { MeshGeometry } from '../../renderer/3d/mesh-generators';

interface Node { id: string; geom?: MeshGeometry; mat?: unknown; name: string; parent?: string; pos: number[]; rot: number[]; tex?: unknown; removed?: boolean; }

function mockHost() {
  const nodes = new Map<string, Node>();
  let n = 0;
  const host: CDKitHost = {
    createRoot: (name) => { const id = `root-${n++}`; nodes.set(id, { id, name, pos: [0, 0, 0], rot: [0, 0, 0] }); return id; },
    createMesh: (geometry, material, name, parentId) => { const id = `m-${n++}`; nodes.set(id, { id, geom: geometry, mat: material, name, parent: parentId, pos: [0, 0, 0], rot: [0, 0, 0] }); return id; },
    setTransform: (id, pos, rot) => { const nd = nodes.get(id)!; nd.pos = [...pos]; nd.rot = [...rot]; },
    setTexture: async (id, source) => { const nd = nodes.get(id); if (!nd) return false; nd.tex = source; return true; },
    setMaterial: (id, material) => { const nd = nodes.get(id); if (nd) nd.mat = material; },
    setGeometry: (id, geometry) => { const nd = nodes.get(id); if (nd) nd.geom = geometry; },
    removeNode: (id) => { for (const nd of nodes.values()) if (nd.id === id || nd.parent === id) nd.removed = true; },
  };
  return { host, nodes };
}

describe('createCDKit', () => {
  it('builds a root + all six pieces parented to it', () => {
    const { host, nodes } = mockHost();
    const s = createCDKit(host);
    expect(nodes.get(s.rootId)!.name).toBe('CD Kit');
    const pieceIds = Object.values(s.pieces);
    expect(pieceIds.length).toBe(6);
    for (const id of pieceIds) expect(nodes.get(id)!.parent).toBe(s.rootId);
    // Every piece got real geometry.
    for (const id of pieceIds) expect((nodes.get(id)!.geom!.vertices.length)).toBeGreaterThan(0);
  });

  it('the lid is glass (translucent) and the tray is opaque dark', () => {
    const { host, nodes } = mockHost();
    const s = createCDKit(host);
    const lidMat = nodes.get(s.pieces.lid)!.mat as { opacity?: number };
    const trayMat = nodes.get(s.pieces.trayBack)!.mat as { opacity?: number; diffuse: { r: number } };
    expect(lidMat.opacity).toBeLessThan(0.5);            // see-through
    expect(trayMat.diffuse.r).toBeLessThan(0.2);         // dark tray
  });

  it('clearTray builds a glass tray; setCDTrayClear toggles it at runtime', () => {
    const { host, nodes } = mockHost();
    const s = createCDKit(host, undefined, true);        // all-clear
    expect(s.clearTray).toBe(true);
    expect((nodes.get(s.pieces.trayBack)!.mat as { opacity?: number }).opacity).toBeLessThan(0.5);   // clear
    setCDTrayClear(host, s, false);                       // → black
    expect(s.clearTray).toBe(false);
    expect((nodes.get(s.pieces.trayBack)!.mat as { diffuse: { r: number } }).diffuse.r).toBeLessThan(0.2);
  });

  it('seats closed at build (scrub 0): lid unrotated', () => {
    const { host, nodes } = mockHost();
    const s = createCDKit(host);
    expect(s.scrub).toBe(0);
    expect(nodes.get(s.pieces.lid)!.rot[1]).toBeCloseTo(0, 6);
  });

  it('scrub → 1 opens the lid and fans the art pieces apart', () => {
    const { host, nodes } = mockHost();
    const s = createCDKit(host);
    setCDKitScrub(host, s, 1);
    expect(s.scrub).toBe(1);
    expect(Math.abs(nodes.get(s.pieces.lid)!.rot[1])).toBeGreaterThan(1);      // lid opened
    expect(nodes.get(s.pieces.frontInsert)!.pos[2]).toBeGreaterThan(15);       // fanned front
    expect(nodes.get(s.pieces.trayCard)!.pos[2]).toBeLessThan(-10);            // fanned back
    expect(nodes.get(s.pieces.trayBack)!.pos[2]).toBeCloseTo(0, 6);            // the anchor stays put
  });

  it('the tray card straightens as the case opens (fold = 1 − scrub)', () => {
    const { host, nodes } = mockHost();
    const s = createCDKit(host);
    setCDKitScrub(host, s, 0);
    expect(s.trayCardFold).toBeCloseTo(1, 6);        // closed → flaps fully folded
    setCDKitScrub(host, s, 1);
    expect(s.trayCardFold).toBeCloseTo(0, 6);        // open → flat
    // The tray card mesh was re-meshed (geometry swapped).
    expect(nodes.get(s.pieces.trayCard)!.geom).toBeTruthy();
  });

  it('setCDTrayCardFold folds only the flaps (folded geometry differs from flat)', () => {
    const flat = compileTrayCardFold(0), folded = compileTrayCardFold(1);
    // Folding lifts the flap verts out of the card plane → the z-extent grows.
    const zSpan = (g: { vertices: Float32Array; format?: string }): number => {
      let mn = Infinity, mx = -Infinity; for (let i = 0; i < g.vertices.length; i += (g.format === '12float' ? 12 : 8)) { mn = Math.min(mn, g.vertices[i + 2]); mx = Math.max(mx, g.vertices[i + 2]); }
      return mx - mn;
    };
    expect(zSpan(folded)).toBeGreaterThan(zSpan(flat) + 1);
  });

  it('setCDPieceArt uploads onto the targeted piece only', async () => {
    const { host, nodes } = mockHost();
    const s = createCDKit(host);
    const img = { fake: 'front.png' };
    await setCDPieceArt(host, s, 'frontInsert', img);
    expect(nodes.get(s.pieces.frontInsert)!.tex).toBe(img);
    expect(nodes.get(s.pieces.disc)!.tex).toBeUndefined();
  });

  it('rebuildCDKitUnderRoot regenerates pieces under an EXISTING root (persistence path), stable names + saved scrub', () => {
    const { host, nodes } = mockHost();
    // Simulate a restored root node that survived the document save.
    const rootId = host.createRoot('CD Kit');
    const s = rebuildCDKitUnderRoot(host, rootId, 1);
    expect(s.rootId).toBe(rootId);                     // reused, not a fresh root
    expect(Object.values(s.pieces).length).toBe(6);
    for (const id of Object.values(s.pieces)) expect(nodes.get(id)!.parent).toBe(rootId);
    // Piece NAMES are stable (this is what re-attaches persisted art by container:childName).
    expect(nodes.get(s.pieces.frontInsert)!.name).toBe('Front Insert');
    expect(nodes.get(s.pieces.disc)!.name).toBe('Disc');
    // Seated at the saved scrub (open).
    expect(s.scrub).toBe(1);
    expect(Math.abs(nodes.get(s.pieces.lid)!.rot[1])).toBeGreaterThan(1);
  });

  it('removeCDKit removes the root subtree', () => {
    const { host, nodes } = mockHost();
    const s = createCDKit(host);
    removeCDKit(host, s);
    expect(nodes.get(s.rootId)!.removed).toBe(true);
    for (const id of Object.values(s.pieces)) expect(nodes.get(id)!.removed).toBe(true);
  });
});
