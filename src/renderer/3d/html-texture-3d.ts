/**
 * HtmlTexture3D — renders arbitrary HTML content to a GPUTexture.
 *
 * Uses the same three-tier capture strategy as TextEffectEngine:
 *
 *   Tier 1 — WebGPU native (Chrome Canary, flag: canvas-draw-element)
 *     GPUQueue.copyElementImageToTexture(element, { texture })
 *     Zero copies. The GPU reads the browser's rendered pixels directly.
 *
 *   Tier 2 — WebGL bridge (same flag, older build)
 *     texElementImage2D → WebGL canvas → copyExternalImageToTexture
 *     One extra blit, but the WebGL canvas is origin-clean so WebGPU accepts it.
 *
 *   Tier 3 — Canvas 2D fallback (always available)
 *     DOMParser + Canvas 2D drawing primitives (fillRect, fillText).
 *     No foreignObject, no canvas taint, no SecurityError.
 *     Supports a practical CSS subset: background, color, font, padding,
 *     text-align, text-shadow, letter-spacing, line-height, linear-gradient.
 *
 * Tiers 1 and 2 require the element to be a child of a <canvas layoutsubtree>
 * and require the onpaint event to have fired at least once before capture.
 * HtmlTexture3D manages a single hidden capture canvas for the document lifetime.
 *
 * USAGE:
 *   const ht = new HtmlTexture3D(device, 512, 128);
 *   await ht.update('<div style="color:white;font-size:48px">Hello 3D!</div>');
 *   mesh.diffuseTexture = ht.texture;
 *   mesh.material.hasTexture = true;
 */

export interface HtmlTexture3DOptions {
  /** CSS background of the generated canvas / container. Default: 'transparent'. */
  backgroundColor?: string;
  /** Additional CSS injected into the container div (Tier 3 no-op, Tier 1/2 applied). */
  containerStyle?: string;
  /**
   * Scale text horizontally so it fills the full texture width regardless of content length.
   * Supported in Canvas 2D mode (the default). In HTML-in-Canvas mode, use SVG textLength instead.
   */
  stretchToFit?: boolean;
}

interface _Padding { top: number; right: number; bottom: number; left: number; }
interface _Shadow  { x: number; y: number; blur: number; color: string; }

type _CaptureMode = 'webgpu-native' | 'webgl-bridge' | 'canvas2d';

export class HtmlTexture3D {
  private _device: GPUDevice;
  private _canvas2d: HTMLCanvasElement;   // Tier 3 fallback canvas
  private _ctx: CanvasRenderingContext2D;
  private _texture: GPUTexture | null = null;
  private _width: number;
  private _height: number;

  // ── Main WebGPU canvas (set once by scene3d-manager) ─────────────
  // Elements are temporarily appended here for capture, matching the same
  // pattern used by LiveTextNode.  The canvas already has a WebGPU context
  // and layoutsubtree set up by the app, so all three capture tiers work.
  private static _mainCanvas: HTMLCanvasElement | null = null;
  private static _pendingCaptures = new Map<HTMLElement, () => void>();
  private static _captureMode: _CaptureMode | null = null;

  constructor(device: GPUDevice, width: number, height: number) {
    this._device = device;
    this._width  = Math.max(1, Math.round(width)  || 1);
    this._height = Math.max(1, Math.round(height) || 1);

    this._canvas2d        = document.createElement('canvas');
    this._canvas2d.width  = this._width;
    this._canvas2d.height = this._height;
    const ctx = this._canvas2d.getContext('2d');
    if (!ctx) throw new Error('HtmlTexture3D: failed to get 2D canvas context');
    this._ctx = ctx;
  }

  get texture(): GPUTexture | null { return this._texture; }
  get width():   number             { return this._width;   }
  get height():  number             { return this._height;  }

  /**
   * Register the app's main WebGPU canvas so HTML-in-Canvas capture works.
   * Call this once before the first update() (scene3d-manager does this).
   *
   * The canvas must already have a WebGPU context — the app's primary rendering
   * canvas satisfies this requirement.  Elements are appended off-screen during
   * capture then immediately removed, matching how LiveTextNode works.
   */
  public static setMainCanvas(canvas: HTMLCanvasElement): void {
    if (HtmlTexture3D._mainCanvas === canvas) return;
    HtmlTexture3D._mainCanvas = canvas;

    if (!canvas.hasAttribute('layoutsubtree')) {
      canvas.setAttribute('layoutsubtree', '');
    }

    // Chain onto any existing onpaint (e.g. from TextEffectEngine.setupCanvasForHtmlCapture).
    const prev = (canvas as any).onpaint as ((e: any) => void) | null;
    (canvas as any).onpaint = (e: any) => {
      prev?.(e);
      const changed = new Set<Element>(e.changedElements ?? []);
      for (const [el, resolve] of HtmlTexture3D._pendingCaptures) {
        if (changed.has(el)) {
          HtmlTexture3D._pendingCaptures.delete(el);
          resolve();
        }
      }
    };
  }

  /**
   * Render `html` into the GPU texture.
   * Automatically picks the best available capture tier.
   */
  async update(html: string, options: HtmlTexture3DOptions = {}): Promise<GPUTexture | null> {
    const mode = HtmlTexture3D._detectMode();
    if (mode !== 'canvas2d' && HtmlTexture3D._mainCanvas) {
      const result = await this._updateViaHtmlInCanvas(html, options, mode);
      if (result) return result;
      // Fall through to Canvas 2D on failure
    }
    return this._updateViaCanvas2D(html, options);
  }

  /**
   * Render directly with the Canvas 2D API into the GPU texture.
   *
   * This bypasses the HTML/CSS tiers entirely — use it when you need full control over the pixels
   * (rounded rects, shadows, rotated elements, gradients) that the Tier-3 CSS subset can't express,
   * and you don't want to depend on the experimental HTML-in-Canvas browser flag being enabled.
   * The callback receives a cleared 2D context sized to the texture (top-left origin); whatever it
   * paints is uploaded as-is. Sprite geometry already flips V, so draw upright (no manual flip).
   */
  async updateWithDraw(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): Promise<GPUTexture | null> {
    this._ctx.clearRect(0, 0, this._width, this._height);
    this._ctx.save();
    try { draw(this._ctx, this._width, this._height); } finally { this._ctx.restore(); }
    const bitmap = await createImageBitmap(this._canvas2d);
    return this._uploadBitmap(bitmap);
  }

  /**
   * Resize the texture. Destroys the current GPU texture; call update() again
   * after resizing to re-render at the new size.
   */
  resize(width: number, height: number): void {
    this._width  = Math.max(1, Math.round(width)  || 1);
    this._height = Math.max(1, Math.round(height) || 1);
    this._canvas2d.width  = this._width;
    this._canvas2d.height = this._height;
    if (this._texture) {
      this._texture.destroy();
      this._texture = null;
    }
  }

  /** Release the GPU texture. Safe to call multiple times. */
  destroy(): void {
    if (this._texture) {
      this._texture.destroy();
      this._texture = null;
    }
  }

  // ── Tiers 1 + 2: HTML-in-Canvas ─────────────────────────────────

  private async _updateViaHtmlInCanvas(
    html: string,
    options: HtmlTexture3DOptions,
    mode: 'webgpu-native' | 'webgl-bridge',
  ): Promise<GPUTexture | null> {
    const { backgroundColor = 'transparent', containerStyle = '', stretchToFit = false } = options;
    const mainCanvas = HtmlTexture3D._mainCanvas!;

    const isTrans = backgroundColor === 'transparent' || backgroundColor === 'rgba(0,0,0,0)';
    const bgStyle = isTrans ? 'rgba(0,0,0,0.02)' : backgroundColor;

    const el = document.createElement('div');

    // When stretching, wrap content in an inner div so we can measure and scale it.
    // overflow:hidden on the outer clips in post-transform visual space, so the
    // scaled content fills exactly this._width regardless of ratio direction.
    if (stretchToFit) {
      el.innerHTML =
        `<div data-ht3d-inner style="display:inline-block;white-space:nowrap;` +
        `transform-origin:left top">${html}</div>`;
    } else {
      el.innerHTML = html;
    }

    el.style.cssText =
      `position:fixed;left:-10000px;top:0;` +
      `width:${this._width}px;height:${this._height}px;` +
      `overflow:hidden;box-sizing:border-box;` +
      `background:${bgStyle};` +
      containerStyle;

    // Wait for initial onpaint so layout is available and the capture API is ready.
    await new Promise<void>((resolve) => {
      let done = false;
      const settle = () => { if (!done) { done = true; resolve(); } };
      const timer = setTimeout(settle, 1000);
      HtmlTexture3D._pendingCaptures.set(el, () => { clearTimeout(timer); settle(); });
      mainCanvas.appendChild(el);
    });

    // Measure natural content dimensions and scale to fill the full texture.
    if (stretchToFit) {
      const innerEl = el.querySelector('[data-ht3d-inner]') as HTMLElement | null;
      if (innerEl) {
        const naturalW = innerEl.offsetWidth;
        const naturalH = innerEl.offsetHeight;
        const scaleX   = naturalW > 0 ? this._width  / naturalW : 1;
        const scaleY   = naturalH > 0 ? this._height / naturalH : 1;
        if (scaleX !== 1 || scaleY !== 1) {
          innerEl.style.transformOrigin = 'left top';
          innerEl.style.transform = `scaleX(${scaleX}) scaleY(${scaleY})`;
          // Two rAF frames: first lets the style engine apply the transform,
          // second ensures the compositor has painted the updated layer.
          await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        }
      }
    }

    let newTex: GPUTexture | null = null;
    try {
      newTex = mode === 'webgpu-native'
        ? this._captureWebGPUNative(el)
        : this._captureWebGLBridge(el);
    } catch (e) {
      console.warn('HtmlTexture3D: HTML-in-Canvas capture failed, falling back to Canvas 2D.', e);
    } finally {
      mainCanvas.removeChild(el);
      HtmlTexture3D._pendingCaptures.delete(el);
    }

    return newTex;
  }

  private _captureWebGPUNative(el: HTMLElement): GPUTexture {
    if (this._texture) this._texture.destroy();
    this._texture = this._device.createTexture({
      size:   [this._width, this._height, 1],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST        |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    (this._device.queue as any).copyElementImageToTexture(
      el,
      { texture: this._texture },
    );
    return this._texture;
  }

  private _captureWebGLBridge(el: HTMLElement): GPUTexture | null {
    const w = this._width, h = this._height;

    // Temporary WebGL canvas — same pattern as TextEffectEngine.captureElementViaWebGLBridge.
    const glCanvas = document.createElement('canvas');
    glCanvas.width  = w;
    glCanvas.height = h;
    const gl = glCanvas.getContext('webgl2', {
      premultipliedAlpha:    true,
      preserveDrawingBuffer: true,
    });
    if (!gl || !('texElementImage2D' in gl)) return null;

    const glTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, glTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    (gl as any).texElementImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);

    // Blit to the GL canvas via a fullscreen quad (flips Y for WebGPU top-left origin).
    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, `#version 300 es
      in vec2 a_pos; out vec2 v_uv;
      void main() {
        v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }`);
    gl.compileShader(vs);

    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, `#version 300 es
      precision highp float;
      in vec2 v_uv; uniform sampler2D u_tex; out vec4 outColor;
      void main() { outColor = texture(u_tex, v_uv); }`);
    gl.compileShader(fs);

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.linkProgram(prog); gl.useProgram(prog);

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D, glTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.flush();

    // glCanvas is origin-clean (WebGL-rendered) — copyExternalImageToTexture succeeds.
    if (this._texture) this._texture.destroy();
    this._texture = this._device.createTexture({
      size:   [w, h, 1],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST        |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this._device.queue.copyExternalImageToTexture(
      { source: glCanvas },
      { texture: this._texture },
      [w, h],
    );

    gl.deleteVertexArray(vao); gl.deleteBuffer(vbo);
    gl.deleteTexture(glTex);
    gl.deleteShader(vs); gl.deleteShader(fs); gl.deleteProgram(prog);

    return this._texture;
  }

  // ── Mode detection ────────────────────────────────────────────────

  private static _detectMode(): _CaptureMode {
    if (HtmlTexture3D._captureMode) return HtmlTexture3D._captureMode;
    try {
      if (typeof GPUQueue !== 'undefined' && 'copyElementImageToTexture' in GPUQueue.prototype) {
        HtmlTexture3D._captureMode = 'webgpu-native';
        return 'webgpu-native';
      }
      const probe = document.createElement('canvas');
      const gl = probe.getContext('webgl2');
      if (gl && 'texElementImage2D' in gl) {
        HtmlTexture3D._captureMode = 'webgl-bridge';
        return 'webgl-bridge';
      }
    } catch { /* ignore */ }
    HtmlTexture3D._captureMode = 'canvas2d';
    return 'canvas2d';
  }

  // ── Tier 3: Canvas 2D fallback ────────────────────────────────────

  private async _updateViaCanvas2D(
    html: string,
    options: HtmlTexture3DOptions,
  ): Promise<GPUTexture | null> {
    const { backgroundColor = 'transparent', stretchToFit = false } = options;

    this._ctx.clearRect(0, 0, this._width, this._height);

    const isTrans = backgroundColor === 'transparent' || backgroundColor === 'rgba(0,0,0,0)';
    if (!isTrans) {
      HtmlTexture3D._drawBg(this._ctx, backgroundColor, 0, 0, this._width, this._height);
    } else {
      // Near-zero alpha keeps the mesh visible (WGSL shader discards alpha < 0.01).
      this._ctx.fillStyle = 'rgba(0,0,0,0.02)';
      this._ctx.fillRect(0, 0, this._width, this._height);
    }

    const doc = new DOMParser().parseFromString(
      `<!DOCTYPE html><html><body>${html}</body></html>`,
      'text/html',
    );
    for (const child of Array.from(doc.body.children)) {
      this._renderEl(child as HTMLElement, 0, 0, this._width, this._height, stretchToFit);
    }

    const bitmap = await createImageBitmap(this._canvas2d);
    return this._uploadBitmap(bitmap);
  }

  private _renderEl(
    el: HTMLElement,
    x: number, y: number, w: number, h: number,
    stretchToFit = false,
  ): void {
    const s = HtmlTexture3D._parseStyle(el);

    const bg = s['background'] || s['background-color'] || '';
    if (bg && bg !== 'transparent' && bg !== 'none') {
      HtmlTexture3D._drawBg(this._ctx, bg, x, y, w, h);
    }

    const pad = HtmlTexture3D._parsePadding(s['padding'] || '0');
    const cx = x + pad.left;
    const cy = y + pad.top;
    const cw = Math.max(0, w - pad.left - pad.right);
    const ch = Math.max(0, h - pad.top - pad.bottom);

    if (el.children.length > 0) {
      for (const child of Array.from(el.children)) {
        this._renderEl(child as HTMLElement, cx, cy, cw, ch, stretchToFit);
      }
    } else {
      const text = el.textContent ?? '';
      if (text.length > 0) this._renderText(text, s, cx, cy, cw, ch, stretchToFit);
    }
  }

  private _renderText(
    text: string,
    s: Record<string, string>,
    x: number, y: number, w: number, h: number,
    stretchToFit = false,
  ): void {
    const ctx = this._ctx;
    ctx.save();

    ctx.font = s['font'] || HtmlTexture3D._buildFont(s);
    ctx.fillStyle = s['color'] || '#000000';
    ctx.textBaseline = 'middle';

    if (s['letter-spacing'] && s['letter-spacing'] !== 'normal') {
      (ctx as any).letterSpacing = s['letter-spacing'];
    }

    const shadow = s['text-shadow']
      ? HtmlTexture3D._parseTextShadow(s['text-shadow'])
      : null;
    if (shadow) {
      ctx.shadowOffsetX = shadow.x;
      ctx.shadowOffsetY = shadow.y;
      ctx.shadowBlur    = shadow.blur;
      ctx.shadowColor   = shadow.color;
    }

    const lhStr = s['line-height'];
    const ty = (lhStr && lhStr !== 'normal' && lhStr.endsWith('px'))
      ? y + parseFloat(lhStr) / 2
      : y + h / 2;

    if (stretchToFit && w > 0) {
      // Set font-size = h before measuring so glyphs start at the right scale.
      // Measuring at a small default font (e.g. 16px) would give scaleY ≈ 10,
      // making strokes appear as hairlines. At h px, scaleY stays near 1.
      const baseFont = s['font'] || HtmlTexture3D._buildFont(s);
      const hasSizeToken = /\b[\d.]+(?:px|em|rem|pt|%)\b/.test(baseFont);
      ctx.font = hasSizeToken
        ? baseFont.replace(/\b[\d.]+(?:px|em|rem|pt|%)\b/, `${h}px`)
        : `${h}px ${baseFont}`;

      const m       = ctx.measureText(text);
      const textW   = m.width;
      const ascent  = m.actualBoundingBoxAscent  ?? 0;
      const descent = m.actualBoundingBoxDescent ?? 0;
      const textH   = ascent + descent;
      if (textW > 0) {
        const scaleX = w / textW;
        const scaleY = textH > 0 ? h / textH : 1;
        ctx.translate(x, y);
        ctx.scale(scaleX, scaleY);
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(text, 0, ascent);
        ctx.restore();
        return;
      }
    }

    const align = (s['text-align'] || 'left') as CanvasTextAlign;
    ctx.textAlign = align;
    const tx = align === 'center' ? x + w / 2 : align === 'right' ? x + w : x;
    ctx.fillText(text, tx, ty);
    ctx.restore();
  }

  private _uploadBitmap(bitmap: ImageBitmap): GPUTexture {
    if (this._texture) this._texture.destroy();
    this._texture = this._device.createTexture({
      size:   [this._width, this._height, 1],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST        |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this._device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture: this._texture },
      [this._width, this._height],
    );
    bitmap.close();
    return this._texture;
  }

  // ── Static CSS helpers (Tier 3) ───────────────────────────────────

  private static _parseStyle(el: Element): Record<string, string> {
    const map: Record<string, string> = {};
    for (const decl of (el.getAttribute('style') ?? '').split(';')) {
      const sep = decl.indexOf(':');
      if (sep === -1) continue;
      const prop = decl.slice(0, sep).trim().toLowerCase();
      const val  = decl.slice(sep + 1).trim();
      if (prop) map[prop] = val;
    }
    return map;
  }

  private static _parsePadding(value: string): _Padding {
    const p = value.trim().split(/\s+/).map(v => parseFloat(v) || 0);
    if (p.length === 1) return { top: p[0], right: p[0], bottom: p[0], left: p[0] };
    if (p.length === 2) return { top: p[0], right: p[1], bottom: p[0], left: p[1] };
    if (p.length === 3) return { top: p[0], right: p[1], bottom: p[2], left: p[1] };
    return { top: p[0], right: p[1], bottom: p[2], left: p[3] };
  }

  private static _drawBg(
    ctx: CanvasRenderingContext2D,
    bg: string,
    x: number, y: number, w: number, h: number,
  ): void {
    const m = bg.match(/linear-gradient\((.+)\)/s);
    if (m) {
      const grad = HtmlTexture3D._linearGradient(ctx, m[1].trim(), x, y, w, h);
      if (grad) { ctx.fillStyle = grad; ctx.fillRect(x, y, w, h); }
    } else {
      ctx.fillStyle = bg;
      ctx.fillRect(x, y, w, h);
    }
  }

  private static _linearGradient(
    ctx: CanvasRenderingContext2D,
    args: string,
    x: number, y: number, w: number, h: number,
  ): CanvasGradient | null {
    const parts = HtmlTexture3D._splitArgs(args);
    if (parts.length < 2) return null;

    let x0 = x, y0 = y, x1 = x, y1 = y + h;
    let si = 0;

    const dir = parts[0].trim().toLowerCase();
    if (/^-?[\d.]+deg$/.test(dir)) {
      const rad = ((parseFloat(dir) - 90) * Math.PI) / 180;
      const r   = Math.hypot(w, h) / 2;
      const mx  = x + w / 2, my = y + h / 2;
      x0 = mx - Math.cos(rad) * r;  y0 = my - Math.sin(rad) * r;
      x1 = mx + Math.cos(rad) * r;  y1 = my + Math.sin(rad) * r;
      si = 1;
    } else if (dir.startsWith('to ')) {
      if      (dir === 'to right')  { x0 = x;     y0 = y;     x1 = x + w; y1 = y;     }
      else if (dir === 'to left')   { x0 = x + w; y0 = y;     x1 = x;     y1 = y;     }
      else if (dir === 'to bottom') { x0 = x;     y0 = y;     x1 = x;     y1 = y + h; }
      else if (dir === 'to top')    { x0 = x;     y0 = y + h; x1 = x;     y1 = y;     }
      si = 1;
    }

    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    parts.slice(si).forEach((stop, i, arr) => {
      const t = stop.trim();
      const m = t.match(/^(.*?)\s+([\d.]+%?)$/);
      const pos = m
        ? (m[2].endsWith('%') ? parseFloat(m[2]) / 100 : parseFloat(m[2]))
        : (arr.length === 1 ? 0 : i / (arr.length - 1));
      const col = m ? m[1].trim() : t;
      try { g.addColorStop(Math.min(1, Math.max(0, pos)), col); } catch { /* skip */ }
    });

    return g;
  }

  private static _splitArgs(s: string): string[] {
    const out: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
      if      (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      else if (s[i] === ',' && depth === 0) {
        out.push(s.slice(start, i).trim());
        start = i + 1;
      }
    }
    out.push(s.slice(start).trim());
    return out;
  }

  private static _buildFont(s: Record<string, string>): string {
    const parts: string[] = [];
    if (s['font-style']  && s['font-style']  !== 'normal') parts.push(s['font-style']);
    if (s['font-weight'] && s['font-weight'] !== 'normal') parts.push(s['font-weight']);
    parts.push(s['font-size']   || '16px');
    parts.push(s['font-family'] || 'sans-serif');
    return parts.join(' ');
  }

  private static _parseTextShadow(value: string): _Shadow | null {
    const single  = value.split(',')[0].trim();
    const colorM  = single.match(/(rgba?\([^)]*\)|hsla?\([^)]*\)|#[0-9a-fA-F]{3,8})/);
    const color   = colorM ? colorM[0] : 'rgba(0,0,0,0.5)';
    const noColor = colorM ? single.replace(colorM[0], '') : single;
    const nums    = noColor.trim().split(/\s+/).flatMap(tok => {
      const n = parseFloat(tok);
      return isNaN(n) ? [] : [n];
    });
    if (nums.length < 2) return null;
    return { x: nums[0], y: nums[1], blur: nums[2] ?? 0, color };
  }
}
