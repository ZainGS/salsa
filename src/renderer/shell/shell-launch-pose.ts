/**
 * shell-launch-pose.ts — From the launch timeline (shell-launch.ts) to a Shell CD's draw: the grown viewport around the
 * tapped tile, the CDPose of each launch frame, and the hand-back to the idle whirl after a spin-down. Pure (no GPU):
 * ShellRenderer and the export dialog's disc preview (cart-disc-preview.ts) both use it; shell-launch-pose.test.ts.
 *
 * Mapping (shell-cd.ts CDPose): the launch's yaw → CDPose.spin (the idle Y whirl), its spin about the disc's own axis
 * → CDPose.roll, its tilt → tilt, its scale × the tile scale → scale.
 */

import {
  LAUNCH, launchPose, launchPressScale, spinDownPose, spinDownDurationMs, easeOutCubic, clamp01, type LaunchPose,
} from './shell-launch';
import { CD_TILE_SCALE, SHELL_EYE, SHELL_FOV, type CDPose } from './shell-cd';

const TAU = Math.PI * 2;

/** The launching disc draws into its tile rect grown by this (about the tile centre, clamped to the canvas): room for
 *  the ×1.35 growth (and the tilt) without the tile's viewport clipping it. */
export const LAUNCH_VIEWPORT_GROW = 1.6;

/** World units the Shell camera sees across a viewport's HEIGHT at the disc plane (z 0). */
export const SHELL_VIEW_WORLD_H = 2 * SHELL_EYE[2] * Math.tan(SHELL_FOV / 2);

/** Max blur arc (radians) the face print is smeared over at full spin (≈ one 60 Hz frame at 4 rev/s). */
export const LAUNCH_BLUR_ARC = 0.42;

/** A device-px viewport for the launching disc + how to keep the disc on its tile inside it. */
export interface LaunchRegion {
  x: number; y: number; w: number; h: number;
  /** Tile height / region height: a pose's scale × k draws at the tile's size. */
  k: number;
  /** World offset (region units) of the tile centre from the region centre (non-zero only when clamped). */
  offX: number; offY: number;
}

/**
 * The grown viewport around a tile rect (device px), clamped to the canvas (a WebGPU viewport must stay inside the
 * render target). Integer px. Returns null for an empty tile / canvas.
 */
export function launchRegion(
  tile: readonly [number, number, number, number], canvasW: number, canvasH: number,
  grow = LAUNCH_VIEWPORT_GROW, out?: LaunchRegion,
): LaunchRegion | null {
  const [tx, ty, tw, th] = tile;
  if (!(tw > 0) || !(th > 0) || !(canvasW > 0) || !(canvasH > 0)) return null;
  const cx = tx + tw / 2, cy = ty + th / 2;
  const gw = tw * grow, gh = th * grow;
  const x0 = Math.max(0, Math.floor(cx - gw / 2)), y0 = Math.max(0, Math.floor(cy - gh / 2));
  const x1 = Math.min(canvasW, Math.ceil(cx + gw / 2)), y1 = Math.min(canvasH, Math.ceil(cy + gh / 2));
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const r = out ?? { x: 0, y: 0, w: 0, h: 0, k: 1, offX: 0, offY: 0 };
  r.x = x0; r.y = y0; r.w = w; r.h = h;
  r.k = th / h;
  const perPx = SHELL_VIEW_WORLD_H / h;
  r.offX = (cx - (x0 + w / 2)) * perPx;
  r.offY = -(cy - (y0 + h / 2)) * perPx;
  return r;
}

/** Which way the launch spin turns: a real CD spins CLOCKWISE seen from its printed (label) side, the side facing the
 *  user in the launch. +rotateZ is counter-clockwise seen from the camera, so the timeline's spin angle is negated.
 *  (The flick to the front keeps the idle whirl's direction — reversing it at the tap would jerk.) */
export const CD_SPIN_DIR = -1;

/** The launch frame's CDPose inside `region`. `y0` = the tile disc's idle bob at the tap (eased out with the flick). */
export function launchCDPose(lp: LaunchPose, tMs: number, y0: number, region: Pick<LaunchRegion, 'k' | 'offX' | 'offY'>, out: CDPose, sizeScale = 1, baseScale: number = CD_TILE_SCALE): CDPose {
  const flick = easeOutCubic(tMs / LAUNCH.flickMs);
  out.x = region.offX;
  out.y = region.offY + y0 * (1 - flick) * region.k;
  out.tilt = lp.tilt;
  out.spin = lp.yaw;
  out.roll = CD_SPIN_DIR * lp.spin;
  out.scale = baseScale * (1 + (lp.scale - 1) * sizeScale) * region.k;
  return out;
}

/** The nearest angle to `a` that equals `target` modulo 2π. */
export function nearestTurn(a: number, target: number): number {
  return target + TAU * Math.round((a - target) / TAU);
}

/**
 * A spin-down frame, handed back to the idle motion: the timeline's spinDownPose (the spin decays, size / tilt / dim
 * settle) with the yaw and the bob blended onto the idle pose at that moment, and the roll steered to land on a whole
 * turn — so when the idle draw takes over (roll 0, the whirl at its own angle) nothing jumps.
 * `idle` is the tile's idle pose NOW (tile units); returns the pose (region units) and the timeline pose.
 */
export function settleCDPose(
  tMs: number, from: LaunchPose, idle: CDPose, region: Pick<LaunchRegion, 'k' | 'offX' | 'offY'>,
  reducedMotion: boolean, out: CDPose, sizeScale = 1, baseScale: number = CD_TILE_SCALE,
): { pose: LaunchPose; done: boolean } {
  const T = spinDownDurationMs(reducedMotion);
  const sd = spinDownPose(tMs, from, { tilt0: idle.tilt, reducedMotion });
  const e = easeOutCubic(clamp01(tMs / T));
  // where the decaying spin would stop, and the whole turn nearest it
  const natEnd = from.spin + ((from.spinRate * T) / 3 / 1000) * TAU;
  const rollFix = TAU * Math.round(natEnd / TAU) - natEnd;
  const yawIdle = nearestTurn(from.yaw, idle.spin);
  out.x = region.offX;
  out.y = region.offY + idle.y * e * region.k;
  out.tilt = sd.pose.tilt;
  out.spin = from.yaw + (yawIdle - from.yaw) * e;
  out.roll = CD_SPIN_DIR * (sd.pose.spin + rollFix * e);
  out.scale = baseScale * (1 + (sd.pose.scale - 1) * sizeScale) * region.k;
  return sd;
}

/** The export preview's launch: the flick + spin-up for this long, then the spin-down back to idle. */
export const LAUNCH_PREVIEW_SPIN_MS = 1700;
/** The preview canvas is just the disc: its growth is damped to this share of ×1.35 (it would clip otherwise). */
export const LAUNCH_PREVIEW_SIZE_SCALE = 0.25;

/** Preview state (from beginLaunchPreview). */
export interface LaunchPreviewState { startMs: number; yaw0: number; y0: number; tilt0: number; reducedMotion: boolean; from: LaunchPose | null }

const UNIT_REGION = { k: 1, offX: 0, offY: 0 } as const;

/**
 * One frame of the export preview's launch at `nowMs` (no dim, no fade — just the disc): writes `out` and returns the
 * timeline pose (its blur drives the print smear), or null once it is back at idle (the caller drops the override).
 * `idle` = the idle pose now.
 */
export function launchPreviewPose(s: LaunchPreviewState, nowMs: number, idle: CDPose, out: CDPose): LaunchPose | null {
  const t = nowMs - s.startMs;
  if (t < 0) return null;
  const spinMs = s.reducedMotion ? 0 : LAUNCH_PREVIEW_SPIN_MS;
  if (t < spinMs) {
    const lp = launchPose(t, { yaw0: s.yaw0, tilt0: s.tilt0, readyAtMs: null });
    launchCDPose(lp, t, s.y0, UNIT_REGION, out, LAUNCH_PREVIEW_SIZE_SCALE);
    return lp;
  }
  s.from ??= launchPose(spinMs, { yaw0: s.yaw0, tilt0: s.tilt0, readyAtMs: null, reducedMotion: s.reducedMotion });
  const sd = settleCDPose(t - spinMs, s.from, idle, UNIT_REGION, s.reducedMotion, out, LAUNCH_PREVIEW_SIZE_SCALE);
  return sd.done ? null : sd.pose;
}

// ── The split launch (2026-10-09): the tray tile only presses, the top hero viewer's CD does the rest ──

/** The hero viewer's CD grows only this much (×1.15, not the in-tile ×1.35): it already fills much of the viewer. */
export const VIEWER_LAUNCH_GROW = 1.15;
/** …as a share of the timeline's growth (launchCDPose / settleCDPose sizeScale). */
export const VIEWER_LAUNCH_SIZE_SCALE = (VIEWER_LAUNCH_GROW - 1) / (LAUNCH.growScale - 1);

/** The hero viewer region must be at least this many device px tall (and as tall as the tapped tile) to take the
 *  launch over; smaller / hidden (phone layout, the project grid) → the in-tile launch. */
export const VIEWER_LAUNCH_MIN_PX = 96;

/** Which disc plays the launch: the hero viewer's (the tile only presses), or the tile itself (the viewer is hidden or
 *  too small). */
export type LaunchStage = 'viewer' | 'tile';

/** The hero viewer can take the launch over. `viewerShowsCart` = it is showing the tapped cart's CD. */
export function chooseLaunchStage(o: {
  viewerShowsCart: boolean; viewerVisible: boolean; viewerW: number; viewerH: number; tileH: number;
}): LaunchStage {
  const big = o.viewerH >= Math.max(VIEWER_LAUNCH_MIN_PX, o.tileH) && o.viewerW >= VIEWER_LAUNCH_MIN_PX;
  return o.viewerShowsCart && o.viewerVisible && big ? 'viewer' : 'tile';
}

/**
 * The tray tile's pose while the viewer plays the launch: its idle pose at the tap (`idle0`), frozen — no whirl, no
 * bob — with only the press dip (×0.94 and back over the first 90 ms) on its scale.
 */
export function tilePressPose(tMs: number, idle0: CDPose, out: CDPose): CDPose {
  out.x = idle0.x; out.y = idle0.y; out.tilt = idle0.tilt; out.spin = idle0.spin; out.roll = idle0.roll;
  out.scale = idle0.scale * launchPressScale(tMs);
  return out;
}

/** The viewer CD's launch frame (viewer units): the flick from the viewer's own idle yaw / tilt at the tap, the gentle
 *  growth on top of its CURRENT idle scale (`idleScale` — it still carries the viewer's pop-in when the cart only just
 *  appeared), the spin-up as roll. */
export function viewerLaunchCDPose(lp: LaunchPose, tMs: number, y0: number, idleScale: number, out: CDPose): CDPose {
  return launchCDPose(lp, tMs, y0, UNIT_REGION, out, VIEWER_LAUNCH_SIZE_SCALE, idleScale);
}

/** The viewer CD's spin-down, handed back to the viewer's idle pose now (`idle`, viewer units). */
export function viewerSettleCDPose(tMs: number, from: LaunchPose, idle: CDPose, reducedMotion: boolean, out: CDPose): { pose: LaunchPose; done: boolean } {
  return settleCDPose(tMs, from, idle, UNIT_REGION, reducedMotion, out, VIEWER_LAUNCH_SIZE_SCALE, idle.scale);
}
