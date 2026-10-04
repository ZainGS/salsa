/**
 * A STABLE GPUDevice handle that can be re-pointed at a new device after a device loss (docs/ui/device-recovery.md).
 *
 * Why a handle: about a hundred engine objects capture the device once (`this.device = device` in a constructor, or a
 * closure over a local `device`). After a loss every one of them would keep creating resources on the dead device.
 * Re-pointing one handle covers them all, including closures and module-level captures, without touching each owner.
 * Owners still have to drop the GPU OBJECTS they made on the old device (buffers, textures, bind groups, pipelines);
 * the recovery orchestrator does that through per-owner rebuild hooks.
 *
 * How it forwards:
 *  - property reads go to the CURRENT device (`queue`, `limits`, `features`, `lost`, `label`);
 *  - methods are bound to the current device (WebGPU methods brand-check `this`), cached per device;
 *  - `addEventListener` / `onuncapturederror` are recorded and re-applied to the next device;
 *  - native APIs that take a device ARGUMENT (`GPUCanvasContext.configure`) need the real object: `unwrapDevice()`.
 *
 * `instanceof GPUDevice` still holds (the proxy reports the device prototype).
 */

const REAL = Symbol.for('salsa.gpuDevice.real');
const HANDLE = Symbol.for('salsa.gpuDevice.handle');

export interface GpuDeviceHandle {
  /** The proxy every owner holds. */
  readonly device: GPUDevice;
  /** The device the proxy forwards to right now. */
  readonly current: GPUDevice;
  /** Bumped on every retarget (0 = the first device). */
  readonly generation: number;
  /** Point the handle at a new device. Recorded event listeners move with it. */
  retarget(next: GPUDevice): void;
}

type Listener = { type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions };

export function createGpuDeviceHandle(initial: GPUDevice): GpuDeviceHandle {
  let target: GPUDevice = initial;
  let generation = 0;
  let bound = new Map<PropertyKey, unknown>();
  const listeners: Listener[] = [];
  const assigned = new Map<PropertyKey, unknown>();   // onuncapturederror / label written through the handle

  const addListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (!listeners.some((l) => l.type === type && l.listener === listener)) listeners.push({ type, listener, options });
    target.addEventListener(type, listener, options);
  };
  const removeListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    const i = listeners.findIndex((l) => l.type === type && l.listener === listener);
    if (i >= 0) listeners.splice(i, 1);
    target.removeEventListener(type, listener, options);
  };

  // The proxy TARGET is a placeholder, never the device: a Proxy keeps its target alive for its whole life, so targeting
  // `initial` pinned the first (lost) device — and every object made on it — forever (repeated-loss drive 2026-10-03).
  const placeholder = Object.create(Object.getPrototypeOf(initial) as object) as object;
  const proxy = new Proxy(placeholder, {
    get(_t, p) {
      if (p === REAL) return target;
      if (p === HANDLE) return handle;
      if (p === 'addEventListener') return addListener;
      if (p === 'removeEventListener') return removeListener;
      const v = Reflect.get(target as unknown as object, p, target);
      if (typeof v !== 'function') return v;
      let b = bound.get(p);
      if (!b) { b = (v as (...a: unknown[]) => unknown).bind(target); bound.set(p, b); }
      return b;
    },
    set(_t, p, v) {
      assigned.set(p, v);
      return Reflect.set(target as unknown as object, p, v, target);
    },
    has(_t, p) { return p === REAL || p === HANDLE || p in (target as unknown as object); },
    getPrototypeOf() { return Object.getPrototypeOf(target); },
  }) as unknown as GPUDevice;

  const handle: GpuDeviceHandle = {
    device: proxy,
    get current() { return target; },
    get generation() { return generation; },
    retarget(next: GPUDevice) {
      if (next === target) return;
      for (const l of listeners) { try { target.removeEventListener(l.type, l.listener, l.options); } catch { /* lost */ } }
      target = next;
      generation++;
      bound = new Map();
      for (const [p, v] of assigned) { try { Reflect.set(next as unknown as object, p, v, next); } catch { /* read-only */ } }
      for (const l of listeners) next.addEventListener(l.type, l.listener, l.options);
    },
  };
  return handle;
}

/** The real GPUDevice behind a handle (or the argument itself when it is not a handle). Use it for native APIs that
 *  take a device as an ARGUMENT — `GPUCanvasContext.configure({ device })` brand-checks it and rejects a proxy. */
export function unwrapDevice<T extends GPUDevice | null | undefined>(d: T): T {
  if (!d) return d;
  const real = (d as unknown as Record<PropertyKey, unknown>)[REAL];
  return (real ?? d) as T;
}

/** The handle behind a device proxy, or null for a plain device. */
export function getDeviceHandle(d: GPUDevice | null | undefined): GpuDeviceHandle | null {
  if (!d) return null;
  return ((d as unknown as Record<PropertyKey, unknown>)[HANDLE] as GpuDeviceHandle | undefined) ?? null;
}
