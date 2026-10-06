/**
 * shell-gpu-cache.ts — Shell pipelines / layouts / samplers kept across Shell mounts.
 *
 * The Shell scene is torn down every time the user opens an editor and rebuilt when they come back; its ~20 render
 * pipelines used to be recompiled on each mount (shader translation + driver pipeline creation, on the main thread,
 * right when the Shell's first frames should be smooth). They only depend on the device and the swap-chain format,
 * so they are created once per REAL device and reused. Per-mount objects (buffers, textures, bind groups) are not
 * cached here: they are cheap and owned (and destroyed) by the renderer that made them.
 *
 * Keyed by the unwrapped device: the engine's device HANDLE keeps its identity across a device loss, the real device
 * does not, so a recovered device starts with an empty cache (and the dead device's entry is garbage-collected).
 */
import { unwrapDevice } from '../core/gpu-device-handle';

const _caches = new WeakMap<object, Map<string, unknown>>();

/** The cached object for `key` on this device, created with `make` on first use. */
export function shellGpuCached<T>(device: GPUDevice, key: string, make: () => T): T {
  const real = unwrapDevice(device) as unknown as object;
  let m = _caches.get(real);
  if (!m) { m = new Map(); _caches.set(real, m); }
  if (m.has(key)) return m.get(key) as T;
  const v = make();
  m.set(key, v);
  return v;
}

/** How many objects are cached for this device (diagnostics / tests). */
export function shellGpuCacheSize(device: GPUDevice): number {
  return _caches.get(unwrapDevice(device) as unknown as object)?.size ?? 0;
}
