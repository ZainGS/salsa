/**
 * shell-html-layer.ts — HTML-in-Canvas integration for the Shell UI.
 *
 * Renders a *live* DOM element INTO the shell's WebGPU scene using the
 * experimental HTML-in-Canvas API (`GPUQueue.copyElementImageToTexture`), so the
 * element picks up the riso grain / scene treatment while staying fully
 * interactive, accessible, selectable and find-in-page-able.
 *
 * Flow (per the Chrome origin-trial docs):
 *   1. The <canvas> carries `layoutsubtree` and the element is nested inside it.
 *   2. Each frame we `copyElementImageToTexture(el, { texture })` → a GPUTexture.
 *   3. The renderer draws that texture as a screen-space quad (in-scene).
 *   4. We set the element's CSS transform so its event zone aligns with where we
 *      drew it (clicks/selection/focus land on the real element).
 *
 * Requirements: Chrome 148+ with chrome://flags/#canvas-draw-element enabled, or
 * the registered Origin Trial token in the host page.
 *
 * Fallback: when the API isn't available we mount the element as a plain
 * positioned overlay (`position: fixed` over the canvas) — fully interactive,
 * just without the in-scene compositing. So the feature works *today* and
 * upgrades automatically when the API is enabled.
 *
 * Screen-aligned (2D) placement only — the shell chrome is 2D, so we skip the
 * MVP/`getElementTransform` math the 3D-mesh case needs.
 */

type HtmlRect = [number, number, number, number]; // x, y, w, h in device px

interface ExperimentalQueue extends GPUQueue {
  copyElementImageToTexture?(element: Element, dest: { texture: GPUTexture }): void;
}

export class ShellHtmlLayer {
  private device: GPUDevice;
  private canvas: HTMLCanvasElement;
  private el: HTMLElement | null = null;
  private texture: GPUTexture | null = null;
  private texW = 0;
  private texH = 0;
  private rect: HtmlRect = [0, 0, 0, 0];
  /** Anchor mode: draw at the element's natural size pinned to a corner
   *  (ax/ay in [0,1]: 0 = left/top, 1 = right/bottom; mx/my margins device px). */
  private anchor: { ax: number; ay: number; mx: number; my: number } | null = null;

  /** True when the experimental HTML-in-Canvas API is available. */
  readonly supported: boolean;

  constructor(device: GPUDevice, canvas: HTMLCanvasElement) {
    this.device = device;
    this.canvas = canvas;
    this.supported = typeof (device.queue as ExperimentalQueue).copyElementImageToTexture === 'function';
    if (this.supported) {
      // Make the browser aware of (and lay out) content nested in the canvas.
      try { canvas.setAttribute('layoutsubtree', ''); } catch { /* ignore */ }
    }
  }

  /** Mount a DOM element. In supported mode it's nested in the <canvas>
   *  (layoutsubtree); otherwise it becomes a positioned overlay. */
  mount(el: HTMLElement): void {
    this.unmount();
    this.el = el;
    if (this.supported) {
      el.style.position = 'absolute';
      el.style.left = '0px';
      el.style.top = '0px';
      el.style.transformOrigin = 'top left';
      if (el.parentElement !== this.canvas) this.canvas.appendChild(el);
    } else {
      // Plain overlay fallback — visible and interactive on top of the canvas.
      el.style.position = 'fixed';
      el.style.zIndex = '40';
      el.style.transformOrigin = 'top left';
      if (!el.parentElement) document.body.appendChild(el);
    }
  }

  /** Place the element at a fixed device-pixel rect (the element is sized to fit). */
  setRect(x: number, y: number, w: number, h: number): void {
    this.anchor = null;
    this.rect = [x, y, w, h];
    if (!this.el) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.el.style.width = `${w / dpr}px`;
    this.el.style.height = `${h / dpr}px`;
    this.positionEl();
  }

  /** Draw the element at its NATURAL size, pinned to a corner. Re-evaluated each
   *  frame via layout(), so the element can grow/shrink (e.g. panels expanding). */
  setAnchor(ax: number, ay: number, marginXDev: number, marginYDev: number): void {
    this.anchor = { ax, ay, mx: marginXDev, my: marginYDev };
  }

  /** Recompute the anchored rect from the element's current size + canvas size. */
  layout(canvasW: number, canvasH: number): void {
    if (!this.el || !this.anchor) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(1, (this.el.offsetWidth || 1) * dpr);
    const h = Math.max(1, (this.el.offsetHeight || 1) * dpr);
    const { ax, ay, mx, my } = this.anchor;
    const x = mx + ax * Math.max(0, canvasW - w - 2 * mx);
    const y = my + ay * Math.max(0, canvasH - h - 2 * my);
    this.rect = [x, y, w, h];
    this.positionEl();
  }

  private positionEl(): void {
    if (!this.el) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const [x, y] = this.rect;
    if (this.supported) {
      this.el.style.transform = `translate(${x / dpr}px, ${y / dpr}px)`;
    } else {
      const r = this.canvas.getBoundingClientRect();
      this.el.style.left = `${r.left + x / dpr}px`;
      this.el.style.top = `${r.top + y / dpr}px`;
      this.el.style.transform = '';
    }
  }

  /** Copy the element's current pixels into the layer texture. Returns true when
   *  a texture is ready to draw (supported mode only). */
  paint(): boolean {
    if (!this.supported || !this.el) return false;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round((this.el.offsetWidth || 1) * dpr));
    const h = Math.max(1, Math.round((this.el.offsetHeight || 1) * dpr));
    if (!this.texture || this.texW !== w || this.texH !== h) {
      this.texture?.destroy();
      this.texture = this.device.createTexture({
        label: 'ShellHtmlLayer',
        size: { width: w, height: h },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.texW = w; this.texH = h;
    }
    try {
      (this.device.queue as ExperimentalQueue).copyElementImageToTexture!(this.el, { texture: this.texture });
      return true;
    } catch {
      return false; // element not yet laid out / paint not ready
    }
  }

  getTexture(): GPUTexture | null { return this.texture; }
  getRect(): HtmlRect { return this.rect; }
  hasElement(): boolean { return !!this.el; }

  unmount(): void {
    if (this.el?.parentElement) this.el.parentElement.removeChild(this.el);
    this.el = null;
  }

  destroy(): void {
    this.unmount();
    this.texture?.destroy();
    this.texture = null;
  }
}
