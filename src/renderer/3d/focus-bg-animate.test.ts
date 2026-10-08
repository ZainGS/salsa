/**
 * ONE switch for the edit-mode focus backgrounds' 'wavy' animation (Renderer3D.setFocusBgAnimate, the host's View ›
 * Toggle Animations): armature and mesh edit / UV draw with the SAME animate flag and hold the live loop by the same
 * rule. (Before: the armature bg always animated while mesh edit followed the machine caps — mobile: frozen.)
 * No GPU: the methods run on Object.create(Renderer3D.prototype) with the few fields they read.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Renderer3D } from './renderer-3d';
import type { ArmatureBgOptions } from '../../types/armature-3d';

type Fake = Renderer3D & Record<string, unknown>;

function fake(opts: { armature?: ArmatureBgOptions | null; meshEdit?: ArmatureBgOptions | null }): { r: Fake; draw: ReturnType<typeof vi.fn> } {
  const draw = vi.fn();
  const r = Object.create(Renderer3D.prototype) as Fake;
  Object.assign(r, {
    _armatureBgPass: { draw },
    _armatureModeActive: !!opts.armature, _armatureBgOpts: opts.armature ?? { mode: 'gradient' },
    _meshEditBgActive: !!opts.meshEdit, _meshEditBgOpts: opts.meshEdit ?? { mode: 'gradient' },
    _sceneBgOpts: { mode: 'none' }, _sceneBgPass: null,
    camera: { position: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], mode: 'perspective', fov: 1 },
  });
  return { r, draw };
}
const animateArg = (draw: ReturnType<typeof vi.fn>): unknown => draw.mock.calls[0]?.[5];
const fakePass = {} as GPURenderPassEncoder;

describe('focus background animate switch', () => {
  afterEach(() => { Renderer3D.caps.animatedFocusBg = true; Renderer3D.setFocusBgAnimate(null); });

  it('unset: both modes follow the machine caps (mobile caps freeze BOTH, not only mesh edit)', () => {
    Renderer3D.caps.animatedFocusBg = false;
    const a = fake({ armature: { mode: 'wavy' } });
    a.r.drawArmatureBg(fakePass, 100, 100);
    expect(animateArg(a.draw)).toBe(false);
    expect(a.r.focusBgAnimating).toBe(false);
    const m = fake({ meshEdit: { mode: 'wavy' } });
    m.r.drawArmatureBg(fakePass, 100, 100);
    expect(animateArg(m.draw)).toBe(false);
    expect(m.r.meshEditBgAnimating).toBe(false);
    Renderer3D.caps.animatedFocusBg = true;
    expect(a.r.focusBgAnimating).toBe(true);
    expect(m.r.focusBgAnimating).toBe(true);
  });

  it('off: armature and mesh edit draw frozen and never ask for frames', () => {
    for (const o of [{ armature: { mode: 'wavy' } as ArmatureBgOptions }, { meshEdit: { mode: 'wavy' } as ArmatureBgOptions }]) {
      const { r, draw } = fake(o);
      Renderer3D.setFocusBgAnimate(false);
      r.drawArmatureBg(fakePass, 100, 100);
      expect(animateArg(draw)).toBe(false);
      expect(r.focusBgAnimate).toBe(false);
      expect(r.focusBgAnimating).toBe(false);
      expect(r.meshEditBgAnimating).toBe(false);
    }
  });

  it('on: both animate (an explicit choice wins over mobile caps); only a wavy bg holds the loop', () => {
    Renderer3D.caps.animatedFocusBg = false;
    const a = fake({ armature: { mode: 'wavy' } });
    Renderer3D.setFocusBgAnimate(true);
    a.r.drawArmatureBg(fakePass, 100, 100);
    expect(animateArg(a.draw)).toBe(true);
    expect(a.r.focusBgAnimating).toBe(true);
    const m = fake({ meshEdit: { mode: 'wavy' } });
    Renderer3D.setFocusBgAnimate(true);
    m.r.drawArmatureBg(fakePass, 100, 100);
    expect(animateArg(m.draw)).toBe(true);
    expect(m.r.meshEditBgAnimating).toBe(true);
    const g = fake({ meshEdit: { mode: 'gradient' } });
    Renderer3D.setFocusBgAnimate(true);
    expect(g.r.focusBgAnimating).toBe(false);
    const none = fake({});
    Renderer3D.setFocusBgAnimate(true);
    expect(none.r.focusBgAnimating).toBe(false);
  });

  it('armature wins when both are up (its bg is the one drawn); null goes back to the caps', () => {
    const { r } = fake({ armature: { mode: 'gradient' }, meshEdit: { mode: 'wavy' } });
    Renderer3D.setFocusBgAnimate(true);
    expect(r.focusBgAnimating).toBe(false);
    Renderer3D.setFocusBgAnimate(null);
    Renderer3D.caps.animatedFocusBg = false;
    expect(r.focusBgAnimate).toBe(false);
  });
});

describe('focus background animate switch: a per-device static', () => {
  afterEach(() => { Renderer3D.setFocusBgAnimate(null); });
  it('holds for every renderer, old and new (set before one exists; survives a device-recovery rebuild)', () => {
    expect(Renderer3D.focusBgAnimateSwitch).toBeNull();
    Renderer3D.setFocusBgAnimate(false);
    expect(Renderer3D.focusBgAnimateSwitch).toBe(false);
    expect(fake({}).r.focusBgAnimate).toBe(false);
    expect(fake({}).r.focusBgAnimate).toBe(false);
    Renderer3D.setFocusBgAnimate(undefined as unknown as null);   // a bad value: back to unset
    expect(Renderer3D.focusBgAnimateSwitch).toBeNull();
  });
});

describe('Scene3DManager.setFocusBgAnimate3D', () => {
  afterEach(() => { Renderer3D.setFocusBgAnimate(null); });
  it('sets the switch before the renderer exists (no lazy renderer); once it does, syncs the loop + one frame', async () => {
    const { Scene3DManager } = await import('../../services/managers/scene3d-manager');
    const s = Object.create(Scene3DManager.prototype) as InstanceType<typeof Scene3DManager> & Record<string, unknown>;
    const sync = vi.fn(), schedule = vi.fn(), getRenderer3D = vi.fn();
    let peek: unknown = null;
    Object.assign(s, { _syncFocusBgLiveLoop: sync, ctx: { scheduleRender: schedule, webgpuRenderer: { peekRenderer3D: () => peek, getRenderer3D } } });
    s.setFocusBgAnimate3D(true);
    expect(Renderer3D.focusBgAnimateSwitch).toBe(true);
    expect(s.getFocusBgAnimate3D()).toBe(true);
    expect(sync).not.toHaveBeenCalled();
    expect(getRenderer3D).not.toHaveBeenCalled();
    peek = {};
    s.setFocusBgAnimate3D(false);
    expect(s.getFocusBgAnimate3D()).toBe(false);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
  });
});
