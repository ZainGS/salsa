import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Scene3DHtmlTextures, type Scene3DHtmlTextureHost } from './scene3d-html-textures';
import type { ManagerContext } from './manager-context';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { RibbonData } from '../../types/ribbon-3d';

// §5.1 extraction: Scene3DHtmlTextures is the first subsystem to take a NARROW HOST interface (getMesh +
// getRibbonData) alongside ManagerContext. The GPU upload path (HtmlTexture3D) needs a real device, so these
// tests pin the parts that DON'T touch the GPU — the host-wiring and the guard logic (missing mesh, no device,
// bad dimensions, update/remove-before-set). That's enough to prove the host boundary is exercised correctly and
// the manager's public methods still short-circuit exactly as before the extraction.

function makeEnv(opts: { device?: unknown; mesh?: Partial<Mesh3D> | null; ribbon?: RibbonData | null } = {}) {
  const scheduleRender = vi.fn();
  const getMesh = vi.fn((_id: string) => (opts.mesh === undefined ? null : (opts.mesh as Mesh3D | null)));
  const getRibbonData = vi.fn((_id: string) => opts.ribbon ?? null);
  const host: Scene3DHtmlTextureHost = { getMesh, getRibbonData };
  const ctx = {
    webgpuRenderer: {
      getDevice: () => (opts.device ?? null),
      getCanvas: () => ({}),
    },
    scheduleRender,
  } as unknown as ManagerContext;
  return { ctx, host, scheduleRender, getMesh, getRibbonData };
}

describe('§5.1 Scene3DHtmlTextures (extracted subsystem)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('set() returns false and does nothing when the mesh is missing (host wiring)', async () => {
    const env = makeEnv({ device: {}, mesh: null });
    const sub = new Scene3DHtmlTextures(env.ctx, env.host);
    expect(await sub.set('missing', '<b>hi</b>')).toBe(false);
    expect(env.getMesh).toHaveBeenCalledWith('missing');
    expect(env.scheduleRender).not.toHaveBeenCalled();
  });

  it('set() returns false when no GPU device is available', async () => {
    const env = makeEnv({ device: null, mesh: { diffuseTexture: null, material: { hasTexture: false } as Mesh3D['material'] } });
    const sub = new Scene3DHtmlTextures(env.ctx, env.host);
    expect(await sub.set('m', '<b>hi</b>')).toBe(false);
    expect(env.scheduleRender).not.toHaveBeenCalled();
  });

  it('set() rejects invalid dimensions before creating any GPU resource', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = makeEnv({ device: {}, mesh: { diffuseTexture: null, material: { hasTexture: false } as Mesh3D['material'] } });
    const sub = new Scene3DHtmlTextures(env.ctx, env.host);
    expect(await sub.set('m', '<b>hi</b>', 0, 128)).toBe(false);
    expect(await sub.set('m', '<b>hi</b>', 512, -1)).toBe(false);
    expect(env.scheduleRender).not.toHaveBeenCalled();
  });

  it('update() returns false when no HTML texture was ever set for the mesh', async () => {
    const env = makeEnv({ device: {}, mesh: { diffuseTexture: null, material: { hasTexture: false } as Mesh3D['material'] } });
    const sub = new Scene3DHtmlTextures(env.ctx, env.host);
    expect(await sub.update('m', '<b>changed</b>')).toBe(false);
  });

  it('remove() returns false when the mesh has no HTML texture, and has() reflects the empty map', () => {
    const env = makeEnv({ device: {}, mesh: { diffuseTexture: null, material: { hasTexture: false } as Mesh3D['material'] } });
    const sub = new Scene3DHtmlTextures(env.ctx, env.host);
    expect(sub.has('m')).toBe(false);
    expect(sub.remove('m')).toBe(false);
  });

  it('dispose() is safe to call on an empty subsystem', () => {
    const env = makeEnv();
    const sub = new Scene3DHtmlTextures(env.ctx, env.host);
    expect(() => sub.dispose()).not.toThrow();
    expect(() => sub.dispose()).not.toThrow();
  });
});
