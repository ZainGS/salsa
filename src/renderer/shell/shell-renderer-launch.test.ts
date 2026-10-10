/**
 * ShellRenderer as the cart-launch presenter (docs/specs/frogcart-cd-art-and-launch.md Part A, phase 2): the per-frame
 * launch state (prepareLaunchFrame / finishLaunchFrame) on a renderer object with no GPU — the tapped tile + its slot,
 * the pose at the tap = the idle pose, black → loop stopped + onBlack once (and still active), cancel from black →
 * the fade back in → onSettled, reduced motion freezing the 3D tiles' idle clock and the parallax. The GPU side (CD
 * shader + the draw order) is checked on a real device by the Dawn harness (scratchpad dawn/launch_strip.cjs).
 */
import { describe, it, expect, vi } from 'vitest';
import { ShellRenderer, parseLaunchColor } from './shell-renderer';
import { LAUNCH, launchBlackAtMs, type ShellLaunchBeginOptions, type LaunchClock } from './shell-launch';
import { cdIdlePose, CD_TILE_SCALE, type CDPose } from './shell-cd';
import { CartridgeViewer } from './shell-cartridge';
import { launchFlightTarget } from './shell-launch-pose';

type R = Pick<ShellRenderer, 'beginLaunch' | 'markLaunchReady' | 'skipLaunch' | 'cancelLaunch' | 'launchActive' | 'launchBlack'
  | 'setReducedMotion' | 'setPointer' | 'start' | 'stop' | 'render'> & {
  prepareLaunchFrame(nowMs: number, now: number, w: number, h: number): void;
  finishLaunchFrame(): void;
  tileClock(now: number): number;
  _lf: { on: boolean; fly: boolean; tile: { id: string } | null; pressTile: { id: string } | null; viewer: boolean; slot: number; pose: { dim: number; fade: number; black: boolean; chromeOpacity: number } | null; blur: number; goBlack: boolean; settled: boolean };
  _launchCD: { spin: number; tilt: number; scale: number; roll: number; y: number };
  _launchRegion: { x: number; y: number; w: number; h: number };
  _launchTilePose: { spin: number; tilt: number; scale: number; roll: number; y: number };
  launchStage: 'viewer' | 'tile' | null;
  cartTileClock(id: string, now: number): number;
  viewer: CartridgeViewer;
  pointerTarget: [number, number];
};

const tile = (id: string, x: number, o: Record<string, unknown>) => ({ id, rect: [x, 300, 100, 100], ...o });

/** A ShellRenderer with only what the launch path touches (no constructor: no GPU). `viewerCart` = the top viewer
 *  shows that cart's CD (the host switched it at the tap); null = no viewer (→ the in-tile launch). */
function renderer(viewerCart: string | null = null, viewerFraction = 0.4): R {
  const r = Object.create(ShellRenderer.prototype) as R;
  // the real viewer CD idle maths, on a viewer that has been showing the CD for a while (no pop-in)
  const viewer = Object.assign(Object.create(CartridgeViewer.prototype), { appearKey: '#cd', appearStart: -100 });
  Object.assign(r, {
    model: {
      tiles: [tile('sys', 0, { billboardKey: 'sys' }), tile('a', 120, { cd: true }), tile('b', 240, { cd: true })],
      viewer: viewerCart ? { kind: 'cd', bodyColor: [0, 0, 0, 1], labelColor: [0, 0, 0, 1] } : null,
      viewerThumbId: viewerCart ?? undefined, viewerFraction,
    },
    viewer, dbg: { hero: true }, canvas: { width: 1920, height: 1080 }, _heroReady: true, _loadingDots: false,
    _tileTimeOffset: new Map<string, number>(),
    _launchTilePose: { x: 0, y: 0, tilt: 0, spin: 0, roll: 0, scale: 1 },
    _launch: null,
    _launchCD: { x: 0, y: 0, tilt: 0, spin: 0, roll: 0, scale: 1 },
    _launchIdle: { x: 0, y: 0, tilt: 0, spin: 0, roll: 0, scale: 1 },
    _launchRegion: { x: 0, y: 0, w: 0, h: 0 },
    _flightSrc: { x: 0, y: 0, w: 0, h: 0 }, _flightDst: { x: 0, y: 0, w: 0, h: 0 },
    _launchRgb: [0, 0, 0],
    _lf: { on: false, fly: false, tile: null, pressTile: null, viewer: false, slot: -1, pose: null, blur: 0, goBlack: false, settled: false },
    _reducedMotion: false, _calmTime: 0,
    running: true, destroyed: false, pointerTarget: [0, 0],
  });
  r.start = vi.fn(() => { (r as Record<string, unknown>).running = true; }) as never;
  r.stop = vi.fn(() => { (r as Record<string, unknown>).running = false; }) as never;
  r.render = vi.fn() as never;
  return r;
}

const opts = (o: Partial<ShellLaunchBeginOptions> = {}): ShellLaunchBeginOptions => ({
  slotId: 'b', startMs: 10_000, reducedMotion: false, fadeColor: '#0a0a0a',
  onBlack: vi.fn(), onSettled: vi.fn(), onFrame: vi.fn(), ...o,
});

describe('ShellRenderer launch presenter', () => {
  it('finds the tapped CD tile + its 3D slot, and frame 0 is that disc\'s idle pose', () => {
    const r = renderer();
    const o = opts();
    r.beginLaunch(o);
    expect(r.launchActive).toBe(true);
    expect(r.start).toHaveBeenCalled();
    r.prepareLaunchFrame(10_000, 10, 1920, 1080);
    expect(r._lf.tile?.id).toBe('b');
    expect(r._lf.slot).toBe(2);                     // after the system cutout and tile a
    const idle = cdIdlePose(10, 2 * 1.7);
    expect(r._launchCD.spin).toBeCloseTo(idle.spin);
    expect(r._launchCD.tilt).toBeCloseTo(idle.tilt);
    expect(r._launchCD.scale * r._launchRegion.h).toBeCloseTo(CD_TILE_SCALE * 100);
    expect(o.onFrame).toHaveBeenCalledWith(expect.objectContaining({ dim: 0, fade: 0 }));
  });

  it('black: the frame is drawn, then the loop stops and onBlack fires once; it stays active (input locked)', () => {
    const r = renderer();
    const o = opts();
    r.beginLaunch(o);
    r.markLaunchReady(10_050);
    const B = launchBlackAtMs((r as unknown as { _launch: { clock: LaunchClock } })._launch.clock)!;
    r.prepareLaunchFrame(10_000 + B - LAUNCH.fadeMs / 2, 11.2, 1920, 1080);
    expect(r._lf.pose!.fade).toBeGreaterThan(0.3);
    r.finishLaunchFrame();
    expect(o.onBlack).not.toHaveBeenCalled();
    r.prepareLaunchFrame(10_000 + B + 1, 11.4, 1920, 1080);
    expect(r._lf.goBlack).toBe(true);
    r.finishLaunchFrame();
    expect(r.stop).toHaveBeenCalled();
    expect(o.onBlack).toHaveBeenCalledTimes(1);
    expect(r.launchActive).toBe(true);
    expect(r.launchBlack).toBe(true);
    // a redraw while black (resize) is still black and reports nothing again
    r.prepareLaunchFrame(20_000, 20, 1920, 1080);
    expect(r._lf.pose!.fade).toBe(1);
    r.finishLaunchFrame();
    expect(o.onBlack).toHaveBeenCalledTimes(1);
    // start() is held while black
    (r as Record<string, unknown>).running = false;
    ShellRenderer.prototype.start.call(r);
    expect((r as Record<string, unknown>).running).toBe(false);
  });

  it('cancel from black fades back in, hands the disc back to idle, then onSettled and inactive', () => {
    const r = renderer();
    const o = opts({ reducedMotion: true });
    r.beginLaunch(o);
    r.markLaunchReady(10_000);
    r.prepareLaunchFrame(10_000 + LAUNCH.reducedFadeMs, 10.24, 1920, 1080);
    r.finishLaunchFrame();
    expect(r.launchBlack).toBe(true);
    r.cancelLaunch(11_000);
    expect(r.start).toHaveBeenCalled();
    r.prepareLaunchFrame(11_000, 11, 1920, 1080);
    expect(r._lf.pose!.fade).toBeCloseTo(1);         // no flash: from full black
    r.finishLaunchFrame();
    r.prepareLaunchFrame(11_000 + LAUNCH.reducedFadeMs, 11.24, 1920, 1080);
    expect(r._lf.settled).toBe(true);
    expect(r._lf.tile).toBeNull();                   // the idle tile draw takes over this frame
    r.finishLaunchFrame();
    expect(o.onSettled).toHaveBeenCalledTimes(1);
    expect(o.onFrame).toHaveBeenLastCalledWith(expect.objectContaining({ dim: 0, fade: 0, chromeOpacity: 1 }));
    expect(r.launchActive).toBe(false);
  });

  it('an error mid-launch spins down from where the disc was', () => {
    const r = renderer();
    const o = opts();
    r.beginLaunch(o);
    r.prepareLaunchFrame(12_400, 12.4, 1920, 1080);
    const roll = r._launchCD.roll;
    r.cancelLaunch(12_400);
    r.prepareLaunchFrame(12_400, 12.4, 1920, 1080);
    expect(r._launchCD.roll).toBeCloseTo(roll);
    expect(r._lf.blur).toBeGreaterThan(0);
    r.prepareLaunchFrame(12_400 + LAUNCH.spinDownMs, 12.95, 1920, 1080);
    r.finishLaunchFrame();
    expect(o.onSettled).toHaveBeenCalled();
    expect(o.onBlack).not.toHaveBeenCalled();
  });

  it('a slot that is not on screen still dims / fades (no disc pose)', () => {
    const r = renderer();
    r.beginLaunch(opts({ slotId: 'gone' }));
    r.markLaunchReady(10_000);
    r.prepareLaunchFrame(10_000 + 800, 10.8, 1920, 1080);
    expect(r._lf.tile).toBeNull();
    expect(r._lf.pose!.dim).toBeGreaterThan(0);
  });

  it('reduced motion freezes the 3D tiles\' idle clock and rests the parallax', () => {
    const r = renderer();
    expect(r.tileClock(5)).toBe(5);
    r.setReducedMotion(true);
    const frozen = r.tileClock(5);
    expect(r.tileClock(50)).toBe(frozen);
    r.setPointer(0.8, -0.5);
    expect(r.pointerTarget).toEqual([0, 0]);
    r.setReducedMotion(false);
    expect(r.tileClock(50)).toBe(50);
    r.setPointer(0.8, -0.5);
    expect(r.pointerTarget).toEqual([0.8, -0.5]);
  });

  it('FLIGHT: the viewer CD flies to the centre (grown in its viewport) and plays the launch; the tile only holds', () => {
    const r = renderer('b');
    const o = opts();
    r.beginLaunch(o);
    expect(r.launchStage).toBe('viewer');
    const tile0 = cdIdlePose(10, 2 * 1.7);
    const spec = (r as unknown as { model: { viewer: never } }).model.viewer;
    const v0 = r.viewer.cdViewerIdlePose(spec, 10, { x: 0, y: 0, tilt: 0, spin: 0, roll: 0, scale: 1 } as CDPose);
    // frame 0: the viewer CD = its idle pose (no jump), the tile = its idle pose
    r.prepareLaunchFrame(10_000, 10, 1920, 1080);
    expect(r._lf.viewer).toBe(true);
    expect(r._lf.tile).toBeNull();                       // no grown viewport for the tile any more
    expect(r._lf.pressTile?.id).toBe('b');
    expect(r._launchCD.spin).toBeCloseTo(v0.spin);
    expect(r._launchCD.tilt).toBeCloseTo(v0.tilt);
    expect(r._launchCD.scale).toBeCloseTo(v0.scale);
    expect(r._launchTilePose.spin).toBeCloseTo(tile0.spin);
    // no press dip any more (LAUNCH.pressScale 1): the tile just holds while the viewer flicks
    r.prepareLaunchFrame(10_045, 10.045, 1920, 1080);
    expect(r._launchTilePose.scale).toBeCloseTo(tile0.scale);
    // mid-flight: the viewport is between the viewer region and the centred target
    const src = { x: 0, y: 0, w: 1920, h: 432 };
    const dst = launchFlightTarget(src, v0.scale, 1920, 1080);
    r.prepareLaunchFrame(10_000 + LAUNCH.travelMs / 2, 10 + LAUNCH.travelMs / 2000, 1920, 1080);
    expect(r._lf.fly).toBe(true);
    expect(r._launchRegion.h).toBeGreaterThan(432);
    expect(r._launchRegion.h).toBeLessThan(dst.h);
    expect(r._launchRegion.y).toBeGreaterThan(0);
    // after the press the tile is back at ×1 and FROZEN (no whirl / bob) while the disc spins up at the centre
    r.prepareLaunchFrame(12_400, 12.4, 1920, 1080);
    expect(r._launchTilePose.scale).toBeCloseTo(tile0.scale);
    expect(r._launchTilePose.spin).toBeCloseTo(tile0.spin);
    expect(r._launchTilePose.y).toBeCloseTo(tile0.y);
    const vNow = r.viewer.cdViewerIdlePose(spec, 12.4, { x: 0, y: 0, tilt: 0, spin: 0, roll: 0, scale: 1 } as CDPose);
    expect(r._launchCD.scale).toBeCloseTo(vNow.scale);            // the viewport carries the growth
    expect(r._launchRegion.h).toBe(Math.round(dst.h));
    expect(r._launchRegion.y + r._launchRegion.h / 2).toBeCloseTo(540, -1);
    expect(Math.abs(r._launchCD.roll)).toBeGreaterThan(1);   // the disc-axis spin
    expect(r._lf.blur).toBeGreaterThan(0);
    expect(r._lf.pose!.dim).toBeCloseTo(LAUNCH.dimMax);
  });

  it('FLIGHT error / cancel: the disc flies back into the viewer while it spins down; the tile whirls on from where it paused', () => {
    const r = renderer('b');
    const o = opts();
    r.beginLaunch(o);
    r.prepareLaunchFrame(11_300, 11.3, 1920, 1080);
    const held = { ...r._launchTilePose };
    r.cancelLaunch(11_300);
    // the tile resumes at the pose it held: its clock now runs 1.3 s behind
    const resumed = cdIdlePose(r.cartTileClock('b', 11.3), 2 * 1.7);
    expect(resumed.spin).toBeCloseTo(held.spin);
    expect(resumed.y).toBeCloseTo(held.y);
    r.prepareLaunchFrame(11_300, 11.3, 1920, 1080);
    expect(r._lf.pressTile).toBeNull();                  // drawn by its idle clock again
    expect(r._lf.viewer).toBe(true);
    r.prepareLaunchFrame(11_300 + LAUNCH.spinDownMs, 11.85, 1920, 1080);
    expect(r._lf.settled).toBe(true);
    const spec = (r as unknown as { model: { viewer: never } }).model.viewer;
    const idle = r.viewer.cdViewerIdlePose(spec, 11.85, { x: 0, y: 0, tilt: 0, spin: 0, roll: 0, scale: 1 } as CDPose);
    expect(r._launchCD.scale).toBeCloseTo(idle.scale);
    expect(r._launchCD.tilt).toBeCloseTo(idle.tilt);
    expect((r._lf.pose as { travel?: number } | null)?.travel ?? 0).toBeCloseTo(0);   // back in the viewer
    expect(((r._launchCD.spin - idle.spin) / (2 * Math.PI)) % 1).toBeCloseTo(0);
    r.finishLaunchFrame();
    expect(o.onSettled).toHaveBeenCalled();
  });

  it('FLIGHT fallback: no viewer, a viewer showing another cart, or one too small → the flight starts from the tile', () => {
    for (const r of [renderer(null), renderer('a'), renderer('b', 0.05)]) {
      r.beginLaunch(opts());
      expect(r.launchStage).toBe('tile');
      r.prepareLaunchFrame(10_500, 10.5, 1920, 1080);
      expect(r._lf.tile?.id).toBe('b');
      expect(r._lf.fly).toBe(true);
      expect(r._lf.viewer).toBe(false);
      expect(r._lf.pressTile).toBeNull();
    }
    // reduced motion keeps the fade-only path
    const rm = renderer('b');
    rm.beginLaunch(opts({ reducedMotion: true }));
    expect(rm.launchStage).toBe('tile');
  });

  // it('RETURN: starts at the launch end state (centre, face-on, full spin, dim), winds home over returnSpinDownMs, no input lock', () => {
  //   const r = renderer('b');
  //   const onSettled = vi.fn(), onFrame = vi.fn();
  //   expect((r as unknown as { beginReturn(o: object): boolean }).beginReturn({ slotId: 'b', startMs: 10_000, onSettled, onFrame })).toBe(true);
  //   expect(r.launchActive).toBe(false);                    // the Shell stays usable
  //   expect((r as unknown as { returnActive: boolean }).returnActive).toBe(true);
  //   r.prepareLaunchFrame(10_000, 10, 1920, 1080);
  //   expect(r._lf.fly).toBe(true);
  //   expect(r._lf.pose!.dim).toBeCloseTo(LAUNCH.dimMax);
  //   expect(r._lf.pose!.travel).toBeCloseTo(1);
  //   expect(r._lf.blur).toBeGreaterThan(0);
  //   r.prepareLaunchFrame(10_000 + LAUNCH.returnSpinDownMs / 2, 10.45, 1920, 1080);
  //   expect(r._lf.settled).toBe(false);                     // longer than the 550 ms error spin-down
  //   r.prepareLaunchFrame(10_000 + LAUNCH.returnSpinDownMs, 10.9, 1920, 1080);
  //   expect(r._lf.settled).toBe(true);
  //   expect(r._lf.pose!.dim).toBeCloseTo(0);
  //   r.finishLaunchFrame();
  //   expect(onSettled).toHaveBeenCalledTimes(1);
  //   expect((r as unknown as { returnActive: boolean }).returnActive).toBe(false);
  // });

  // it('RETURN: any input cuts it straight to idle; a slot not on screen plays nothing', () => {
  //   const r = renderer('b') as R & { beginReturn(o: object): boolean; cutReturn(): boolean };
  //   const onSettled = vi.fn();
  //   r.beginReturn({ slotId: 'b', startMs: 10_000, onSettled });
  //   expect(r.cutReturn()).toBe(true);
  //   expect(onSettled).toHaveBeenCalledTimes(1);
  //   expect(r.cutReturn()).toBe(false);
  //   expect(renderer(null).beginReturn.call(renderer(null), { slotId: 'gone', startMs: 0, onSettled })).toBe(false);
  // });

  it('parseLaunchColor: #rrggbb / #rgb, else the Player black', () => {
    const o: [number, number, number] = [0, 0, 0];
    expect(parseLaunchColor('#0a0a0a', o)).toEqual([10 / 255, 10 / 255, 10 / 255]);
    expect(parseLaunchColor('#fff', o)).toEqual([1, 1, 1]);
    expect(parseLaunchColor('rgb(1,2,3)', o)).toEqual([10 / 255, 10 / 255, 10 / 255]);
  });
});
