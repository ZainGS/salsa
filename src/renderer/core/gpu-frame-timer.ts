/**
 * GPU FRAME TIMER: how long the GPU spent on a frame, for the automatic resolution scaler and the perf readouts
 * (docs/ui/performance.md §Resolution scaling).
 *
 * With the `timestamp-query` feature (requested at device creation when the adapter has it), every queue submission
 * is bracketed by two tiny marker command buffers: an empty compute pass that writes a timestamp at its start, the
 * real command buffers, and another empty pass that writes one at its end. A frame's GPU time is the SUM of those
 * spans, so the idle gaps while the CPU is still encoding are not counted: a CPU-bound frame does not look GPU-bound.
 * `endFrame()` resolves the frame's pairs into a small ring of read-back buffers; the result arrives a frame or two
 * later through `onResult`.
 *
 * Without the feature the timer falls back to an ESTIMATE: from the frame's CPU start to the moment the GPU reports
 * the frame's work done (`onSubmittedWorkDone`). That includes CPU encode time, so it is only a rough guide.
 *
 * The submit wrapper is installed only while the timer is enabled (auto resolution scaling on, or a perf readout
 * holding a lease) and removed when it is disabled, so a default session pays nothing.
 */

/** Query pairs one frame can record (2 timestamps each). Submissions past it go untimed for that frame. */
const MAX_PAIRS = 256;
/** Read-back buffers in flight. A frame whose results would need a 4th is skipped (no stall, no unbounded queue). */
const RING = 3;

export type GpuTimingSource = 'timestamp' | 'estimate';

export class GpuFrameTimer {
  /** True when the device was created with `timestamp-query`. */
  readonly supported: boolean;
  /** Called with each measured frame's GPU milliseconds (asynchronously, a frame or two after the frame). */
  onResult: ((gpuMs: number, source: GpuTimingSource) => void) | null = null;

  private readonly _device: GPUDevice;
  private _enabled = false;
  private _querySet: GPUQuerySet | null = null;
  private _resolveBuf: GPUBuffer | null = null;
  private readonly _ring: { buf: GPUBuffer; busy: boolean }[] = [];
  private _used = 0;   // timestamps written this frame (2 per timed submission)
  private _origSubmit: GPUQueue['submit'] | null = null;
  private _frameStart = 0;
  private _estimateBusy = false;

  constructor(device: GPUDevice) {
    this._device = device;
    this.supported = !!device.features?.has?.('timestamp-query');
  }

  get enabled(): boolean { return this._enabled; }
  /** Where the numbers come from while enabled. */
  get source(): GpuTimingSource { return this.supported ? 'timestamp' : 'estimate'; }

  /** Start / stop timing. Cheap to call every frame (no-op without a change). */
  setEnabled(on: boolean): void {
    if (on === this._enabled) return;
    this._enabled = on;
    if (!this.supported) return;
    if (on) this._install(); else this._uninstall();
  }

  /** Mark the CPU start of a frame (used by the estimate fallback). */
  beginFrame(): void { this._frameStart = performance.now(); }

  /** The frame's last submission is in: resolve its timestamps (or start the estimate). */
  endFrame(): void {
    if (!this._enabled) return;
    if (!this.supported) { this._estimate(); return; }
    const n = this._used;
    if (n === 0 || !this._querySet || !this._resolveBuf || !this._origSubmit) return;
    this._used = 0;
    const slot = this._ring.find(r => !r.busy);
    if (!slot) return;   // results still in flight: skip this frame's sample
    slot.busy = true;
    const enc = this._device.createCommandEncoder({ label: 'GpuFrameTimer.resolve' });
    enc.resolveQuerySet(this._querySet, 0, n, this._resolveBuf, 0);
    enc.copyBufferToBuffer(this._resolveBuf, 0, slot.buf, 0, n * 8);
    this._origSubmit.call(this._device.queue, [enc.finish()]);
    slot.buf.mapAsync(GPUMapMode.READ, 0, n * 8).then(() => {
      const t = new BigInt64Array(slot.buf.getMappedRange(0, n * 8));
      let ns = 0;
      for (let i = 0; i + 1 < n; i += 2) { const d = t[i + 1] - t[i]; if (d > 0n) ns += Number(d); }
      slot.buf.unmap();
      slot.busy = false;
      const ms = ns / 1e6;
      if (this._enabled && ms > 0 && ms < 1000) this.onResult?.(ms, 'timestamp');
    }, () => { slot.busy = false; });
  }

  destroy(): void {
    this._uninstall();
    this._querySet?.destroy(); this._querySet = null;
    this._resolveBuf?.destroy(); this._resolveBuf = null;
    for (const r of this._ring) r.buf.destroy();
    this._ring.length = 0;
  }

  private _estimate(): void {
    if (this._estimateBusy || !this._frameStart) return;
    this._estimateBusy = true;
    const t0 = this._frameStart;
    this._device.queue.onSubmittedWorkDone().then(() => {
      this._estimateBusy = false;
      const ms = performance.now() - t0;
      if (this._enabled && ms > 0 && ms < 1000) this.onResult?.(ms, 'estimate');
    }, () => { this._estimateBusy = false; });
  }

  private _install(): void {
    const dev = this._device;
    if (!this._querySet) {
      this._querySet = dev.createQuerySet({ type: 'timestamp', count: MAX_PAIRS * 2, label: 'GpuFrameTimer' });
      this._resolveBuf = dev.createBuffer({ size: MAX_PAIRS * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC, label: 'GpuFrameTimer.resolve' });
      for (let i = 0; i < RING; i++) this._ring.push({ buf: dev.createBuffer({ size: MAX_PAIRS * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: 'GpuFrameTimer.readback' }), busy: false });
    }
    if (this._origSubmit) return;
    const q = dev.queue;
    const orig = q.submit;   // the prototype method (or whatever wrapper is already on it)
    this._origSubmit = orig;
    this._used = 0;
    const qs = this._querySet;
    (q as { submit: GPUQueue['submit'] }).submit = (cbs: Iterable<GPUCommandBuffer>): undefined => {
      if (!this._enabled || this._used + 2 > MAX_PAIRS * 2) return orig.call(q, cbs);
      const i = this._used;
      this._used += 2;
      const b = dev.createCommandEncoder({ label: 'GpuFrameTimer.begin' });
      b.beginComputePass({ timestampWrites: { querySet: qs!, beginningOfPassWriteIndex: i } }).end();
      const e = dev.createCommandEncoder({ label: 'GpuFrameTimer.end' });
      e.beginComputePass({ timestampWrites: { querySet: qs!, endOfPassWriteIndex: i + 1 } }).end();
      return orig.call(q, [b.finish(), ...cbs, e.finish()]);
    };
  }

  private _uninstall(): void {
    if (!this._origSubmit) return;
    // Our wrapper is an OWN property of the queue object; deleting it restores the prototype's submit.
    delete (this._device.queue as { submit?: unknown }).submit;
    this._origSubmit = null;
    this._used = 0;
  }
}
