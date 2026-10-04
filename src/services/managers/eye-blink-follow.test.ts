import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;

import { blinkParamsFor, defaultEyeParams } from './eye-generator';
import { Scene3DCharacter, type Scene3DCharacterHost } from './scene3d-character';
import type { ManagerContext } from './manager-context';

// Bug 2026-09-29: the auto-blink frame was a one-time COPY of the open eyes, so turning the under-eye deco dots off
// in Neutral (or any later eye edit) flashed the old settings back in during every blink.

describe('blinkParamsFor', () => {
  it('is the open eyes, closed — deep-copied', () => {
    const open = { ...defaultEyeParams(), underDecoCount: 0 };
    const b = blinkParamsFor(open)!;
    expect(b.closed).toBe(true);
    expect(b.underDecoCount).toBe(0);
    b.highlights[0].radius = 99;
    expect(open.highlights[0].radius).not.toBe(99);
  });
  it('returns null when the blink already matches (ignoring gaze, which a closed eye does not draw)', () => {
    const open = defaultEyeParams();
    const b = blinkParamsFor(open)!;
    expect(blinkParamsFor({ ...open, gazeX: 0.8 }, b)).toBeNull();
    expect(blinkParamsFor({ ...open, underDecoCount: 0 }, b)).not.toBeNull();
  });
});

function makeChar() {
  const ctx = {
    webgpuRenderer: { addPreRenderCallback: () => {}, removePreRenderCallback: () => {}, getDevice: () => null },
    scheduleRender: () => {}, emitSceneGraphChanged: () => {},
  } as unknown as ManagerContext;
  const host = { getMesh: () => null, getAllMeshes: () => [] } as unknown as Scene3DCharacterHost;
  const ch = new Scene3DCharacter(ctx, host);
  const neutral = { ...defaultEyeParams(), underDecoCount: 3 };
  const happy = { ...defaultEyeParams(), underDecoCount: 0, upperLashColor: '#ff0000' };
  const rig = {
    bodyMeshId: 'b', skeletonId: 's', headJointIdx: 0, decalMeshId: 'd', textures: new Map(), faceAspect: 1,
    expressions: [
      { id: 'n', name: 'Neutral', isBlink: false, eyeParams: neutral },
      { id: 'h', name: 'Happy', isBlink: false, eyeParams: happy },
      { id: 'k', name: 'Blink', isBlink: true, eyeParams: blinkParamsFor(neutral)! },   // the stale auto copy
    ],
    activeId: 'n', blinkId: 'k', blink: { mode: 'random', minSec: 2, maxSec: 6, holdMs: 110, enabled: false },
    _blinkTimer: null, _holdTimer: null,
  };
  (ch as unknown as { _faceRigs: Map<string, unknown> })._faceRigs.set('b', rig);
  const blink = () => rig.expressions[2].eyeParams;
  return { ch, rig, blink, neutral };
}

describe('the auto-blink frame follows the open eyes', () => {
  it('switching state → the blink is that state closed (deco off, its lash colour)', () => {
    const { ch, blink } = makeChar();
    expect(blink().underDecoCount).toBe(3);
    ch.setActiveFaceExpression('b', 'h');
    expect(blink().closed).toBe(true);
    expect(blink().underDecoCount).toBe(0);
    expect(blink().upperLashColor).toBe('#ff0000');
  });
  it('a stale saved blink is repaired by any sync point (blink config change)', () => {
    const { ch, rig, blink } = makeChar();
    rig.expressions[0].eyeParams.underDecoCount = 0;   // Neutral edited after the blink copy was taken
    ch.setFaceBlinkConfig('b', { holdMs: 120 });
    expect(blink().underDecoCount).toBe(0);
  });
  it('followOpenEyes:false keeps the blink frame as authored; a hand-drawn blink is never touched', () => {
    const { ch, rig, blink } = makeChar();
    ch.setFaceBlinkConfig('b', { followOpenEyes: false });
    ch.setActiveFaceExpression('b', 'h');
    expect(blink().underDecoCount).toBe(3);
    const drawn = makeChar();
    delete (drawn.rig.expressions[2] as { eyeParams?: unknown }).eyeParams;
    drawn.ch.setActiveFaceExpression('b', 'h');
    expect(drawn.rig.expressions[2]).not.toHaveProperty('eyeParams');
    void rig;
  });
});
