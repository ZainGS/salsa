/**
 * src/packaging/packaging-polish.test.ts — §4 polish round (packaging-templates.md) + setStyle.
 *
 *  - §4.1 studio stage: background swap on enter / restore on exit, theme picker passthrough,
 *    contact-shadow lifecycle (created under the package root on enter, re-placed on
 *    setDimensions/fold, removed on exit).
 *  - §4.2 board material: preset payloads through applyPanelMaterial + persistence round-trip.
 *  - §4.3 motion: the easeInOutCubic tween easing.
 *  - setStyle: converting an existing box to a different template (the style-dropdown fix) —
 *    clean rebuild, re-links, creator-mode paint re-arm, persistence of the NEW style.
 *
 * Recording-fake-host style (packaging-creator.test.ts pattern).
 */

import { describe, it, expect } from 'vitest';
import {
  PackagingManager, easeInOutCubic, STUDIO_STAGE_BG,
  type PackagingHost, type StageBackgroundOpts, type StageShadowPlacement, type PanelBoardMaterial,
} from './packaging-manager';
import { tuckEnd } from './templates/tuck-end';
import { sleeve } from './templates/sleeve';

interface ShadowEvent { op: 'create' | 'update' | 'remove'; parentId?: string; p?: StageShadowPlacement; }

function makeHost() {
  const calls: string[] = [];
  const shadowEvents: ShadowEvent[] = [];
  const panelMaterials: { meshId: string; board?: PanelBoardMaterial }[] = [];
  let bg: StageBackgroundOpts = { mode: 'wavy' };            // the user's background before the mode
  const bgHistory: StageBackgroundOpts[] = [];
  let grp = 0, msh = 0, lyr = 0, shadowN = 0;
  const liveNodes = new Set<string>();
  const host: PackagingHost = {
    createGroup: () => { const id = `grp-${grp++}`; liveNodes.add(id); calls.push('createGroup:' + id); return id; },
    createPanelMesh: () => { const id = `mesh-${msh++}`; liveNodes.add(id); calls.push('createPanelMesh:' + id); return id; },
    setNodeTransform: () => {},
    setPanelGeometry: () => {},
    removeNode: (id) => { liveNodes.delete(id); calls.push('removeNode:' + id); },
    linkLiveTexture: (_id, layerId) => { calls.push('link:' + layerId); },
    unlinkLiveTexture: () => { calls.push('unlink'); },
    exportLayerPng: async () => null,
    scheduleRender: () => {},
    setDocSize: () => {},
    ensureDielineLayer: (existing) => existing ?? 'layer-legacy',
    ensureDielineLayerInfo: (existing) => {
      if (existing) return { layerId: existing, fresh: false };
      return { layerId: `layer-${lyr++}`, fresh: true };
    },
    frameAndOrbit: (id) => { calls.push('frameAndOrbit:' + id); },
    stopOrbit: () => { calls.push('stopOrbit'); },
    armSurfacePaint: (meshIds, layerId) => { calls.push(`arm:${meshIds.length}:${layerId}`); return true; },
    disarmSurfacePaint: () => { calls.push('disarm'); },
    markUnitWrapper: () => {},
    // §4.1 studio stage hooks
    setStageBackground: (opts) => { bg = { ...opts }; bgHistory.push({ ...opts }); },
    getStageBackground: () => ({ ...bg }),
    createStageShadow: (parentId, p) => {
      const id = `shadow-${shadowN++}`;
      shadowEvents.push({ op: 'create', parentId, p });
      return id;
    },
    updateStageShadow: (_id, p) => { shadowEvents.push({ op: 'update', p }); },
    removeStageShadow: () => { shadowEvents.push({ op: 'remove' }); },
    // §4.2 board hook
    applyPanelMaterial: (meshId, board) => { panelMaterials.push({ meshId, board }); },
  };
  return {
    host, calls, shadowEvents, panelMaterials, bgHistory,
    currentBg: () => bg, liveNodes,
  };
}

const DIMS = { width: 80, height: 60, depth: 40, bleed: 3 };

describe('§4.1 studio stage background', () => {
  it('enter swaps to the studio gradient, exit restores the user background', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    expect(h.currentBg().mode).toBe('wavy');                       // the user's pre-mode background

    mgr.enterCreatorMode({ params: DIMS });
    expect(h.currentBg().mode).toBe('gradient');                   // neutral studio stage default
    expect(h.currentBg().color1).toEqual(STUDIO_STAGE_BG.color1);
    expect(h.currentBg().color2).toEqual(STUDIO_STAGE_BG.color2);

    mgr.exitCreatorMode();
    expect(h.currentBg().mode).toBe('wavy');                       // restored exactly
  });

  it('setStageBackground is the theme picker: applies live, sticks across re-enter, restore intact', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    mgr.enterCreatorMode();
    mgr.setStageBackground({ mode: 'checkers' });                  // host theme choice, applied live
    expect(h.currentBg().mode).toBe('checkers');
    expect(mgr.getStageBackground().mode).toBe('checkers');

    mgr.exitCreatorMode();
    expect(h.currentBg().mode).toBe('wavy');                       // user's own bg still restored

    mgr.enterCreatorMode();                                        // theme remembered for the session
    expect(h.currentBg().mode).toBe('checkers');
    mgr.exitCreatorMode();
    expect(h.currentBg().mode).toBe('wavy');
  });

  it('a re-enter while ACTIVE never captures the studio bg as "previous"', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    mgr.enterCreatorMode();
    mgr.enterCreatorMode();                                        // idempotent re-enter, mode still active
    mgr.exitCreatorMode();
    expect(h.currentBg().mode).toBe('wavy');                       // NOT 'gradient'
  });
});

describe('§4.1 contact shadow', () => {
  it('created under the package ROOT on enter, removed on exit — exactly one', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    const st = mgr.enterCreatorMode({ params: DIMS });
    const creates = h.shadowEvents.filter(e => e.op === 'create');
    expect(creates.length).toBe(1);
    expect(creates[0].parentId).toBe(st.packageId);                // child of the root (thin wrapper hides it)
    expect(creates[0].p!.radiusX).toBeGreaterThan(0);
    expect(creates[0].p!.radiusZ).toBeGreaterThan(0);
    expect(creates[0].p!.y).toBeLessThan(0);                       // just below the flat net plane

    mgr.enterCreatorMode();                                        // idempotent re-enter → no second blob
    expect(h.shadowEvents.filter(e => e.op === 'create').length).toBe(1);

    mgr.exitCreatorMode();
    expect(h.shadowEvents.filter(e => e.op === 'remove').length).toBe(1);
  });

  it('tracks setDimensions (bigger net → bigger blob) and fold (closed box → smaller footprint)', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    const st = mgr.enterCreatorMode({ params: DIMS });
    const id = st.packageId!;
    const created = h.shadowEvents.find(e => e.op === 'create')!.p!;

    mgr.setDimensions(id, { ...DIMS, width: 160 });                // dims-only → in-place fast path
    const afterDims = [...h.shadowEvents].reverse().find(e => e.op === 'update')!.p!;
    expect(afterDims.radiusX).toBeGreaterThan(created.radiusX);

    mgr.setFoldAmount(id, 1);                                      // closed box footprint < flat net
    const afterFold = [...h.shadowEvents].reverse().find(e => e.op === 'update')!.p!;
    expect(afterFold.radiusX).toBeLessThan(afterDims.radiusX);
    expect(afterFold.radiusZ).toBeLessThan(afterDims.radiusZ);
  });

  it('no shadow churn outside the mode (fold/dims on a non-staged box never call the hooks)', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    const s = mgr.addPackage(DIMS);
    mgr.setFoldAmount(s.id, 0.5);
    mgr.setDimensions(s.id, { ...DIMS, width: 100 });
    expect(h.shadowEvents.length).toBe(0);
  });
});

describe('§4.2 board material', () => {
  it('fresh panels get the white-coated board payload (grain + per-panel UV rect + rim)', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    const s = mgr.addPackage(DIMS);
    const applied = h.panelMaterials.filter(pm => pm.board);
    expect(applied.length).toBe(s.box.panels.length);
    for (const pm of applied) {
      expect(pm.board!.preset).toBe('white');
      expect(pm.board!.diffuse.r).toBeCloseTo(0.96, 2);
      expect(pm.board!.grain).toBeGreaterThan(0);
      expect(pm.board!.rimStrength).toBeGreaterThan(0);
      const [u0, v0, u1, v1] = pm.board!.uvRect;
      expect(u1).toBeGreaterThan(u0); expect(v1).toBeGreaterThan(v0);
      expect(u0).toBeGreaterThanOrEqual(0); expect(v1).toBeLessThanOrEqual(1);
      expect(pm.board!.rimUV[0]).toBeGreaterThan(0);
      expect(pm.board!.rimUV[1]).toBeGreaterThan(0);
    }
    expect(mgr.getBoardPreset(s.id)).toBe('white');
  });

  it('setBoardPreset(kraft) re-tints every panel with the kraft base + heavier grain', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    const s = mgr.addPackage(DIMS);
    h.panelMaterials.length = 0;
    expect(mgr.setBoardPreset(s.id, 'kraft')).toBe(true);
    const applied = h.panelMaterials.filter(pm => pm.board);
    expect(applied.length).toBe(s.box.panels.length);
    expect(applied[0].board!.preset).toBe('kraft');
    expect(applied[0].board!.diffuse).toEqual({ r: 0.66, g: 0.50, b: 0.34 });
    expect(applied[0].board!.grain).toBeGreaterThan(0.1);
    expect(mgr.getBoardPreset(s.id)).toBe('kraft');
  });

  it('board preset persists: serialize → restore round-trip re-applies kraft', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    const s = mgr.addPackage(DIMS);
    mgr.setBoardPreset(s.id, 'kraft');
    const entries = mgr.serialize();
    expect(entries[0].board).toBe('kraft');

    // "Reload": fresh manager over a fresh recording host (persisted node ids adopted optimistically).
    const h2 = makeHost();
    const mgr2 = new PackagingManager(h2.host);
    expect(mgr2.restoreFromJSON(entries)).toBe(1);
    expect(mgr2.getBoardPreset(s.id)).toBe('kraft');
    const applied = h2.panelMaterials.filter(pm => pm.board);
    expect(applied.length).toBe(s.box.panels.length);
    expect(applied[0].board!.preset).toBe('kraft');

    // …and a package that never chose a preset stays implicit-white (no board field persisted).
    const h3 = makeHost();
    const mgr3 = new PackagingManager(h3.host);
    const plain = mgr3.addPackage(DIMS);
    expect(mgr3.serialize().find(e => e.id === plain.id)!.board).toBeUndefined();
  });
});

describe('§4.3 motion easing', () => {
  it('easeInOutCubic: endpoints exact, midpoint 0.5, cubic wings, monotonic, clamped', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 12);
    expect(easeInOutCubic(0.25)).toBeCloseTo(0.0625, 12);          // 4t³
    expect(easeInOutCubic(0.75)).toBeCloseTo(0.9375, 12);          // 1 − (−2t+2)³/2
    expect(easeInOutCubic(-1)).toBe(0);                            // clamped (defensive)
    expect(easeInOutCubic(2)).toBe(1);
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = easeInOutCubic(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    // Slower launch than the old quad → the ends feel softer, the middle carries the speed.
    expect(easeInOutCubic(0.1)).toBeLessThan(2 * 0.1 * 0.1);
  });
});

describe('setStyle (the style-dropdown fix)', () => {
  it('converts simpleBox → tuckEnd: clean rebuild, new net/guides, links re-established, fold preserved', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    const st = mgr.enterCreatorMode({ params: DIMS });             // simpleBox, dieline linked, mode active
    const oldId = st.packageId!;
    mgr.setFoldAmount(oldId, 0.6);
    h.calls.length = 0;

    const s = mgr.setStyle(oldId, 'tuckEnd')!;
    expect(s).not.toBeNull();
    expect(s.style).toBe('tuckEnd');
    expect(s.id).not.toBe(oldId);                                  // topology rebuild → id changes (documented)
    expect(h.calls).toContain('removeNode:' + oldId);              // old hierarchy fully gone
    expect(h.liveNodes.has(oldId)).toBe(false);
    expect(s.box.panels.length).toBe(13);                          // tuckEnd's 13 panels
    const ref = tuckEnd(DIMS);
    expect(s.canvasWidth).toBe(ref.canvasWidth);                   // guides/canvas match the NEW net
    expect(s.canvasHeight).toBe(ref.canvasHeight);
    expect(s.guides.length).toBe(ref.guides.length);
    expect(s.foldAmount).toBeCloseTo(0.6, 12);                     // global fold scalar is style-agnostic
    // Dieline layer re-linked onto all 13 new panels + creator paint re-armed on them.
    expect(h.calls.filter(c => c === 'link:' + st.dielineLayerId).length).toBe(13);
    expect(h.calls).toContain(`arm:13:${st.dielineLayerId}`);
    expect(mgr.getAll().length).toBe(1);                           // converted, not duplicated
    expect(mgr.getCreatorState().packageId).toBe(s.id);            // creator handle tracks the rebuilt box
    expect(mgr.getCreatorState().style).toBe('tuckEnd');
    // Same style again is a no-op (no rebuild).
    h.calls.length = 0;
    expect(mgr.setStyle(s.id, 'tuckEnd')!.id).toBe(s.id);
    expect(h.calls.filter(c => c.startsWith('removeNode')).length).toBe(0);
  });

  it('persists the NEW style (round-trip restores a tuckEnd)', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    const s0 = mgr.addPackage(DIMS);
    const s1 = mgr.setStyle(s0.id, 'tuckEnd')!;
    const entries = mgr.serialize();
    expect(entries[0].style).toBe('tuckEnd');
    expect(entries[0].panels.length).toBe(13);

    const h2 = makeHost();
    const mgr2 = new PackagingManager(h2.host);
    expect(mgr2.restoreFromJSON(entries)).toBe(1);
    const restored = mgr2.get(s1.id)!;
    expect(restored.style).toBe('tuckEnd');
    expect(restored.box.panels.length).toBe(13);
  });

  it('enterCreatorMode({ style }) on an existing creator box APPLIES the change (no longer ignored)', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    const first = mgr.enterCreatorMode({ params: DIMS });          // simpleBox
    expect(mgr.getCreatorState().style).toBe('simpleBox');

    const second = mgr.enterCreatorMode({ style: 'sleeve' });      // the style dropdown path
    expect(mgr.getCreatorState().style).toBe('sleeve');
    expect(mgr.getAll().length).toBe(1);                           // converted in place, no second box
    expect(second.packageId).not.toBe(first.packageId);            // rebuild re-keys (setDimensions contract)
    const ref = sleeve(DIMS);
    expect(mgr.get(second.packageId!)!.box.panels.length).toBe(ref.foldMeshData.panels.length);
    // Same style re-enter stays a no-op.
    const third = mgr.enterCreatorMode({ style: 'sleeve' });
    expect(third.packageId).toBe(second.packageId);
  });

  it('returns null for unknown ids/styles', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    expect(mgr.setStyle('nope', 'tuckEnd')).toBeNull();
    const s = mgr.addPackage(DIMS);
    expect(mgr.setStyle(s.id, 'notAStyle' as never)).toBeNull();
  });
});
