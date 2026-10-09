import { describe, it, expect } from 'vitest';
import {
  launchRegion, launchCDPose, settleCDPose, nearestTurn, launchPreviewPose, LAUNCH_VIEWPORT_GROW, SHELL_VIEW_WORLD_H,
  LAUNCH_PREVIEW_SPIN_MS, type LaunchPreviewState, CD_SPIN_DIR, chooseLaunchStage, VIEWER_LAUNCH_MIN_PX, tilePressPose,
  viewerLaunchCDPose, viewerSettleCDPose, VIEWER_LAUNCH_GROW,
} from './shell-launch-pose';
import { LAUNCH, launchPose, type LaunchClock } from './shell-launch';
import { CD_TILE_SCALE, CD_IDLE_TILT, cdIdlePose, type CDPose } from './shell-cd';

const TAU = Math.PI * 2;
const pose = (): CDPose => ({ x: 0, y: 0, tilt: 0, spin: 0, roll: 0, scale: 1 });

describe('launchRegion', () => {
  it('grows the tile about its centre (×1.6) and draws the disc at the tile size in it', () => {
    const r = launchRegion([400, 300, 100, 100], 1920, 1080)!;
    expect(r.w).toBe(160); expect(r.h).toBe(160);
    expect(r.x).toBe(370); expect(r.y).toBe(270);
    expect(r.k).toBeCloseTo(100 / 160);
    expect(r.offX).toBeCloseTo(0); expect(r.offY).toBeCloseTo(0);
    expect(LAUNCH_VIEWPORT_GROW).toBeGreaterThan(LAUNCH.growScale);
  });

  it('clamps to the canvas (a viewport must stay inside the target) and offsets the disc back onto its tile', () => {
    const r = launchRegion([0, 0, 100, 100], 1000, 800)!;
    expect(r.x).toBe(0); expect(r.y).toBe(0);
    expect(r.w).toBe(130); expect(r.h).toBe(130);
    // tile centre (50, 50) vs region centre (65, 65): left and up by 15 px
    const perPx = SHELL_VIEW_WORLD_H / 130;
    expect(r.offX).toBeCloseTo(-15 * perPx);
    expect(r.offY).toBeCloseTo(15 * perPx);
    const br = launchRegion([950, 750, 50, 50], 1000, 800)!;
    expect(br.x + br.w).toBeLessThanOrEqual(1000);
    expect(br.y + br.h).toBeLessThanOrEqual(800);
  });

  it('null for an empty tile / canvas', () => {
    expect(launchRegion([0, 0, 0, 10], 100, 100)).toBeNull();
    expect(launchRegion([0, 0, 10, 10], 0, 100)).toBeNull();
  });
});

describe('launchCDPose', () => {
  it('frame 0 is exactly the idle tile disc (same size in the grown viewport, same whirl, tilt, bob)', () => {
    const idle = cdIdlePose(12.3, 1.7);
    const r = launchRegion([400, 300, 100, 100], 1920, 1080)!;
    const clock: LaunchClock = { yaw0: idle.spin, tilt0: idle.tilt, readyAtMs: null };
    const p = launchCDPose(launchPose(0, clock), 0, idle.y, r, pose());
    expect(p.spin).toBeCloseTo(idle.spin);
    expect(p.tilt).toBeCloseTo(idle.tilt);
    expect(p.roll + 0).toBe(0);   // (−0: the spin is negated — clockwise)
    // size on screen ∝ scale × viewport height
    expect(p.scale * r.h).toBeCloseTo(idle.scale * 100);
    expect(p.y * r.h).toBeCloseTo(idle.y * 100);
  });

  it('at the end of the flick: front-facing, grown ×1.35, bob gone; roll = the disc-axis spin, clockwise seen from the print', () => {
    const r = launchRegion([400, 300, 100, 100], 1920, 1080)!;
    const clock: LaunchClock = { yaw0: 3.3, readyAtMs: null };
    const lp = launchPose(1500, clock);
    const p = launchCDPose(lp, 1500, 0.05, r, pose());
    expect(((p.spin % TAU) + TAU) % TAU).toBeCloseTo(0);
    expect(p.scale * r.h).toBeCloseTo(CD_TILE_SCALE * LAUNCH.growScale * 100);
    expect(p.y).toBeCloseTo(0);
    expect(p.roll).toBeCloseTo(CD_SPIN_DIR * lp.spin);
    expect(CD_SPIN_DIR).toBe(-1);   // a real CD turns clockwise seen from its label side
  });
});

describe('settleCDPose (spin-down hand-back)', () => {
  it('ends exactly on the idle pose: whirl angle, bob, tilt, size, and the roll on a whole turn', () => {
    const r = { k: 1, offX: 0, offY: 0 };
    const from = launchPose(1700, { yaw0: 0.4, readyAtMs: null });
    const idle = cdIdlePose(20, 0.5);
    const out = pose();
    const { done } = settleCDPose(LAUNCH.spinDownMs, from, idle, r, false, out);
    expect(done).toBe(true);
    expect(((out.spin - idle.spin) / TAU) % 1).toBeCloseTo(0);
    expect(out.y).toBeCloseTo(idle.y);
    expect(out.tilt).toBeCloseTo(CD_IDLE_TILT);
    expect(out.scale).toBeCloseTo(CD_TILE_SCALE);
    expect(Math.abs(((out.roll / TAU) % 1 + 1) % 1 - 0) < 1e-6 || Math.abs(((out.roll / TAU) % 1 + 1) % 1 - 1) < 1e-6).toBe(true);
  });

  it('starts where the launch was (no jump at the error)', () => {
    const r = { k: 0.625, offX: 0, offY: 0 };
    const from = launchPose(1300, { yaw0: 0.4, readyAtMs: null });
    const out = pose();
    settleCDPose(0, from, cdIdlePose(5), r, false, out);
    const at = launchCDPose(from, 1300, 0, r, pose());
    expect(out.spin).toBeCloseTo(at.spin);
    expect(out.roll).toBeCloseTo(at.roll);
    expect(out.scale).toBeCloseTo(at.scale);
  });

  it('nearestTurn', () => {
    expect(nearestTurn(7, 0.5)).toBeCloseTo(0.5 + TAU);
    expect(nearestTurn(-0.2, 0.1)).toBeCloseTo(0.1);
  });
});

describe('launchPreviewPose (the export dialog)', () => {
  it('flick + spin-up, then back to idle and done', () => {
    const idle = cdIdlePose(0);
    const s: LaunchPreviewState = { startMs: 1000, yaw0: idle.spin, y0: idle.y, tilt0: idle.tilt, reducedMotion: false, from: null };
    const out = pose();
    expect(launchPreviewPose(s, 1000, idle, out)).not.toBeNull();
    expect(out.scale).toBeCloseTo(CD_TILE_SCALE);
    expect(launchPreviewPose(s, 1000 + 1200, idle, out)).not.toBeNull();
    expect(out.scale).toBeGreaterThan(CD_TILE_SCALE);          // grown (damped)
    expect(out.scale).toBeLessThan(CD_TILE_SCALE * 1.1);
    expect(launchPreviewPose(s, 1000 + LAUNCH_PREVIEW_SPIN_MS + 100, idle, out)).not.toBeNull();
    expect(launchPreviewPose(s, 1000 + LAUNCH_PREVIEW_SPIN_MS + LAUNCH.spinDownMs, idle, out)).toBeNull();
    expect(launchPreviewPose(s, 0, idle, out)).toBeNull();   // before it started
  });

  it('reduced motion: no spin, just the settle', () => {
    const idle = cdIdlePose(0);
    const s: LaunchPreviewState = { startMs: 0, yaw0: idle.spin, y0: idle.y, tilt0: idle.tilt, reducedMotion: true, from: null };
    const out = pose();
    expect(launchPreviewPose(s, 100, idle, out)).not.toBeNull();
    expect(out.roll).toBeCloseTo(0);
    expect(launchPreviewPose(s, LAUNCH.reducedFadeMs, idle, out)).toBeNull();
  });
});

describe('the split launch (tray tile presses, the hero viewer plays the rest)', () => {
  it('chooseLaunchStage: the viewer when it shows the tapped cart and is big enough, else the tile', () => {
    const ok = { viewerShowsCart: true, viewerVisible: true, viewerW: 1920, viewerH: 432, tileH: 120 };
    expect(chooseLaunchStage(ok)).toBe('viewer');
    expect(chooseLaunchStage({ ...ok, viewerShowsCart: false })).toBe('tile');
    expect(chooseLaunchStage({ ...ok, viewerVisible: false })).toBe('tile');
    expect(chooseLaunchStage({ ...ok, viewerH: VIEWER_LAUNCH_MIN_PX - 1 })).toBe('tile');
    expect(chooseLaunchStage({ ...ok, viewerH: 110, tileH: 120 })).toBe('tile');   // smaller than the tile itself
  });

  it('tilePressPose: the idle pose at the tap, only the scale dips (×0.94 mid-press), then ×1 and frozen', () => {
    const idle0 = cdIdlePose(7.7, 3.4);
    const out = pose();
    tilePressPose(0, idle0, out);
    expect(out).toEqual(idle0);
    tilePressPose(LAUNCH.pressMs / 2, idle0, out);
    expect(out.scale).toBeCloseTo(idle0.scale * LAUNCH.pressScale);
    expect(out.spin).toBe(idle0.spin);
    for (const t of [LAUNCH.pressMs, 500, 5000]) {
      tilePressPose(t, idle0, out);
      expect(out).toEqual(idle0);
    }
  });

  it('viewerLaunchCDPose: frame 0 = the viewer idle pose; grows only ×1.15; roll = the clockwise disc spin', () => {
    const idle = { x: 0, y: 0.08, tilt: -24 * Math.PI / 180, spin: 2.2, roll: 0, scale: 1.2 };
    const clock: LaunchClock = { yaw0: idle.spin, tilt0: idle.tilt, readyAtMs: null };
    const out = pose();
    viewerLaunchCDPose(launchPose(0, clock), 0, idle.y, idle.scale, out);
    expect(out.spin).toBeCloseTo(idle.spin); expect(out.tilt).toBeCloseTo(idle.tilt);
    expect(out.y).toBeCloseTo(idle.y); expect(out.scale).toBeCloseTo(idle.scale);
    const lp = launchPose(1500, clock);
    viewerLaunchCDPose(lp, 1500, idle.y, idle.scale, out);
    expect(out.scale).toBeCloseTo(idle.scale * VIEWER_LAUNCH_GROW);
    expect(out.roll).toBeCloseTo(CD_SPIN_DIR * lp.spin);
    expect(out.y).toBeCloseTo(0);
    // spin-down lands on the viewer idle pose now
    const now = { ...idle, spin: 9.1, y: -0.05 };
    const { done } = viewerSettleCDPose(LAUNCH.spinDownMs, lp, now, false, out);
    expect(done).toBe(true);
    expect(out.scale).toBeCloseTo(now.scale); expect(out.y).toBeCloseTo(now.y); expect(out.tilt).toBeCloseTo(now.tilt);
    expect(((out.spin - now.spin) / TAU) % 1).toBeCloseTo(0);
  });
});
