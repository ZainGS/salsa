/**
 * TextEffectEngine — GPU compute shaders that apply visual effects to text textures.
 *
 * Workflow:
 *  1. Capture styled text to a GPU texture (via OffscreenCanvas or HTML-in-Canvas API)
 *  2. Apply one or more shader effects (chromatic aberration, glow, wave, glitch, outline)
 *  3. Output the processed texture for compositing into the scene
 *
 * The engine is designed to work with any texture source — it's not limited to text,
 * but text is the primary use case for manga/comic effects.
 *
 * HTML-in-Canvas support:
 *  When the experimental `texElementImage2D` API is available (Chrome Canary with
 *  chrome://flags/#canvas-draw-element), the engine can capture live DOM elements
 *  as textures. Otherwise, it falls back to OffscreenCanvas 2D rendering.
 */

// ─── Types ──────────────────────────────────────────────────────

export type TextEffectType =
  | 'chromatic-aberration'
  | 'glow'
  | 'wave'
  | 'glitch'
  | 'outline'
  | 'feather'
  | 'custom';

export interface TextEffectConfig {
  /** Effect type. */
  type: TextEffectType;
  /** Effect-specific parameters. */
  params: TextEffectParams;
}

/** Union of all effect parameter types. */
export type TextEffectParams =
  | ChromaticAberrationParams
  | GlowParams
  | WaveParams
  | GlitchParams
  | OutlineParams
  | FeatherParams
  | CustomShaderParams;

export interface ChromaticAberrationParams {
  /** RGB channel separation strength (0–0.05 typical). Default: 0.005. */
  strength: number;
  /** Angle of separation in radians. Default: 0 (horizontal). */
  angle: number;
  /** Cursor UV position [0–1, 0–1] for reactive effects. Optional. */
  cursorUV?: [number, number];
  /** Whether mouse is pressed (0 or 1). Inverts repel → attract. Optional. */
  mouseDown?: number;
  /** Radius of cursor influence in UV space (0–1). Default: 0.3. */
  cursorRadius?: number;
}

export interface GlowParams {
  /** Glow radius in texels. Default: 4. */
  radius: number;
  /** Glow intensity multiplier. Default: 1.5. */
  intensity: number;
  /** Glow color [r, g, b] in 0–1. Default: same as text color. */
  color?: [number, number, number];
}

export interface WaveParams {
  /** Wave amplitude in texels. Default: 3. */
  amplitude: number;
  /** Wave frequency. Default: 10. */
  frequency: number;
  /** Animation speed (0 = static). Default: 1. */
  speed: number;
  /** Current time (set per frame for animation). Default: 0. */
  time: number;
}

export interface GlitchParams {
  /** Glitch intensity (0–1). Default: 0.3. */
  intensity: number;
  /** Block size in texels. Default: 8. */
  blockSize: number;
  /** Current time (set per frame). Default: 0. */
  time: number;
}

export interface OutlineParams {
  /** Outline thickness (band width) in texels. Default: 2. */
  thickness: number;
  /** Outline color [r, g, b, a] in 0–1. Default: [0,0,0,1]. */
  color: [number, number, number, number];
  /** Directional offset [dx, dy] in texels — shifts the outline like a drop shadow. Default: [0,0]. */
  offset?: [number, number];
  /** Transparent gap between the glyph and the outline band, in texels. Default: 0. */
  gap?: number;
}

export interface FeatherParams {
  /** 'linear' fades alpha along an axis; 'radial' fades from center outward. Default: 'linear'. */
  mode: 'linear' | 'radial';
  /** Linear-mode fade direction in degrees (0 = →, 90 = ↓). Ignored for radial. Default: 90. */
  angle?: number;
  /** 0–1 of the texture where alpha is still full. Default: 0.6. */
  start: number;
  /** 0–1 of the texture where alpha reaches 0 (may be < start to reverse). Default: 1.0. */
  end: number;
}

/**
 * Custom WGSL compute shader effect.
 *
 * The user writes a WGSL compute shader body. The engine wraps it
 * in a standard harness that provides:
 *
 * Bindings (provided automatically):
 *   @group(0) @binding(0) var src : texture_2d<f32>;           // input texture
 *   @group(0) @binding(1) var dst : texture_storage_2d<rgba8unorm, write>; // output
 *   @group(0) @binding(2) var<uniform> u : CustomUniforms;     // uniforms
 *
 * The CustomUniforms struct:
 *   struct CustomUniforms {
 *     resolution : vec2<f32>,   // texture width, height in texels
 *     time       : f32,        // animation time in seconds
 *     mouseDown  : f32,        // 1.0 if pressed, 0.0 otherwise
 *     cursor     : vec2<f32>,  // cursor position in UV space [0–1]
 *     params     : vec4<f32>,  // user-defined float params [a, b, c, d]
 *   };
 *
 * The user writes ONLY the body of `fn effect(...)` — see `code` field below.
 *
 * Alternatively, set `rawCode` to provide the COMPLETE shader module
 * (must define @compute @workgroup_size(8,8) fn main(...) yourself).
 */
export interface CustomShaderParams {
  /**
   * Effect function body (simplified mode).
   * Write WGSL code that reads from `src` and writes to `dst`.
   *
   * Available variables:
   *   gid   : vec3<u32>  — global invocation ID
   *   uv    : vec2<f32>  — normalized coordinates [0–1]
   *   dim   : vec2<u32>  — texture dimensions
   *   u     : CustomUniforms — time, cursor, resolution, params
   *
   * Example (invert colors):
   * ```wgsl
   * let c = textureLoad(src, vec2<i32>(gid.xy), 0);
   * textureStore(dst, gid.xy, vec4<f32>(1.0 - c.rgb, c.a));
   * ```
   */
  code?: string;

  /**
   * Raw WGSL shader module (advanced mode).
   * Must declare all bindings and the @compute entry point.
   * When set, `code` is ignored.
   */
  rawCode?: string;

  /** Up to 4 user-defined float params. Accessible as `u.params` in the shader. */
  params?: [number, number, number, number];

  /** Current time in seconds (for animation). Set per frame by LiveTextNode. */
  time?: number;
  /** Cursor UV [0–1, 0–1]. Set per frame by LiveTextNode. */
  cursorUV?: [number, number];
  /** Whether mouse is pressed (0 or 1). */
  mouseDown?: number;
}

/** Result of compiling a custom shader. */
export interface CustomShaderCompileResult {
  success: boolean;
  /** Human-readable error messages from GPU validation, if any. */
  errors?: string[];
}

/** Text capture configuration. */
export interface TextCaptureConfig {
  text: string;
  font: string;
  fontSize: number;
  color: [number, number, number, number];
  bold?: boolean;
  italic?: boolean;
  maxWidth?: number;
  lineHeight?: number;
  writingMode?: 'horizontal-tb' | 'vertical-rl';
  /** Padding around text for effects that bleed outside (glow, outline). */
  padding?: number;
}

// ─── Default params ─────────────────────────────────────────────

export function defaultChromaticAberration(): ChromaticAberrationParams {
  return { strength: 0.005, angle: 0 };
}

export function defaultGlow(): GlowParams {
  return { radius: 4, intensity: 1.5 };
}

export function defaultWave(): WaveParams {
  return { amplitude: 3, frequency: 10, speed: 1, time: 0 };
}

export function defaultGlitch(): GlitchParams {
  return { intensity: 0.3, blockSize: 8, time: 0 };
}

export function defaultOutline(): OutlineParams {
  return { thickness: 2, color: [0, 0, 0, 1], offset: [0, 0], gap: 0 };
}

export function defaultFeather(): FeatherParams {
  return { mode: 'linear', angle: 90, start: 0.6, end: 1.0 };
}

export function defaultCustomShader(): CustomShaderParams {
  return {
    code: `let c = textureLoad(src, vec2<i32>(gid.xy), 0);
textureStore(dst, gid.xy, c);`,
    params: [0, 0, 0, 0],
    time: 0,
    cursorUV: [0.5, 0.5],
    mouseDown: 0,
  };
}

// ─── Engine ─────────────────────────────────────────────────────

export class TextEffectEngine {
  private device: GPUDevice;

  // Pipeline cache (lazily created)
  private chromaticPipeline: GPUComputePipeline | null = null;
  private chromaticBGL: GPUBindGroupLayout | null = null;
  private glowPipelineH: GPUComputePipeline | null = null;
  private glowPipelineV: GPUComputePipeline | null = null;
  private glowBGL: GPUBindGroupLayout | null = null;
  private wavePipeline: GPUComputePipeline | null = null;
  private waveBGL: GPUBindGroupLayout | null = null;
  private glitchPipeline: GPUComputePipeline | null = null;
  private glitchBGL: GPUBindGroupLayout | null = null;
  private outlinePipeline: GPUComputePipeline | null = null;
  private outlineBGL: GPUBindGroupLayout | null = null;
  private featherPipeline: GPUComputePipeline | null = null;
  private featherBGL: GPUBindGroupLayout | null = null;

  // Custom shader pipeline cache (keyed by code hash)
  private customPipelineCache = new Map<string, GPUComputePipeline>();
  private customBGL: GPUBindGroupLayout | null = null;
  /** Larger param buffer for custom shaders (48 bytes = 12 floats). */
  private customParamBuf: GPUBuffer;

  // Reusable param buffer (64 bytes — enough for all effects)
  private paramBuf: GPUBuffer;

  constructor(device: GPUDevice) {
    this.device = device;
    this.paramBuf = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.customParamBuf = device.createBuffer({
      size: 48, // vec2 resolution + f32 time + f32 mouseDown + vec2 cursor + vec4 params
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  Text Capture
  // ═══════════════════════════════════════════════════════════════

  /**
   * Capture styled text to a GPU texture.
   *
   * Uses OffscreenCanvas 2D as the universal fallback.
   * When the HTML-in-Canvas API is available, can capture live DOM elements.
   */
  public captureText(config: TextCaptureConfig): { texture: GPUTexture; width: number; height: number } {
    const padding = config.padding ?? 16;
    const lh = config.lineHeight ?? 1.2;
    const lineHeightPx = Math.ceil(config.fontSize * lh);

    // Build font string
    const fontStyle = `${config.italic ? 'italic ' : ''}${config.bold ? 'bold ' : ''}${config.fontSize}px ${config.font}`;

    // Wrap text into lines
    const lines = this.wrapText(config.text, fontStyle, config.maxWidth);

    // Measure
    const measureCanvas = new OffscreenCanvas(1, 1);
    const measureCtx = measureCanvas.getContext('2d')!;
    measureCtx.font = fontStyle;

    let maxLineWidth = 0;
    for (const line of lines) {
      maxLineWidth = Math.max(maxLineWidth, measureCtx.measureText(line).width);
    }

    const textW = Math.ceil(maxLineWidth);
    const textH = lines.length * lineHeightPx;
    const canvasW = Math.max(1, textW + padding * 2);
    const canvasH = Math.max(1, textH + padding * 2);

    // Render to OffscreenCanvas
    const canvas = new OffscreenCanvas(canvasW, canvasH);
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvasW, canvasH);
    ctx.font = fontStyle;
    ctx.textBaseline = 'top';
    const [r, g, b, a] = config.color;
    ctx.fillStyle = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;

    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], padding, padding + i * lineHeightPx);
    }

    // Upload to GPU
    const texture = this.device.createTexture({
      size: [canvasW, canvasH],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.device.queue.copyExternalImageToTexture(
      { source: canvas },
      { texture },
      [canvasW, canvasH],
    );

    return { texture, width: canvasW, height: canvasH };
  }

  /**
   * The device-pixel ratio `copyElementImageToTexture` will rasterize a layoutsubtree
   * element at — the HOST canvas's backing-store DPR (`canvas.width / cssWidth`), NOT
   * `window.devicePixelRatio`. Used to size the destination texture so the copy fits.
   * Falls back to the nearest `<canvas>` ancestor, then window DPR.
   */
  public static elementCaptureDpr(element: HTMLElement, hostCanvas?: HTMLCanvasElement): number {
    const canvas = hostCanvas ?? (element.closest('canvas') as HTMLCanvasElement | null);
    if (canvas) {
      const r = canvas.getBoundingClientRect();
      if (r.width > 0 && canvas.width > 0) return canvas.width / r.width;
    }
    return window.devicePixelRatio || 1;
  }

  /**
   * Capture a live DOM element to a GPU texture via the HTML-in-Canvas API.
   * Requires Chrome Canary with chrome://flags/#canvas-draw-element enabled.
   * Returns null if the API is not available in the current browser.
   *
   * Two paths:
   *  1. Native WebGPU: GPUQueue.copyElementImageToTexture() — zero-copy, ideal.
   *  2. WebGL bridge:  texElementImage2D → draw to canvas → copyExternalImageToTexture.
   *
   * IMPORTANT: The element must be a direct child of a <canvas layoutsubtree>.
   * The canvas's onpaint event must have fired at least once before calling this.
   * See setupCanvasForHtmlCapture() to prepare the canvas.
   */
  public captureElement(
    element: HTMLElement,
    hostCanvas?: HTMLCanvasElement,
  ): { texture: GPUTexture; width: number; height: number } | null {
    const mode = TextEffectEngine.htmlInCanvasMode();
    if (mode === 'none') return null;
    const usage =
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT;

    if (mode === 'webgpu-native') {
      // ── Path 1: WebGPU native — the two-step "draw element" API ──
      // VERIFIED in Chrome 150 (docs/spikes/html-in-canvas-spike.html). This is an
      // ORIGIN-TRIAL signature that has shifted across builds — RE-VERIFY on Chrome bumps:
      //   1. const img = canvas.captureElementImage(el)   — a transferable snapshot
      //   2. queue.copyElementImageToTexture({ source: img }, { destination: { texture } })
      // ⚠ The snapshot is only current if captured INSIDE the canvas's `onpaint` handler;
      //   calling this outside captures the previous frame (see the LiveText wiring).
      const canvas = hostCanvas ?? (element.closest('canvas') as HTMLCanvasElement | null);
      const captureFn = canvas ? (canvas as any).captureElementImage : null;
      if (!canvas || typeof captureFn !== 'function') return null;
      const img: any = captureFn.call(canvas, element);
      if (!img) return null;
      // The copy rasterizes the element at the canvas BACKING resolution, so the copy extent
      // is ceil(snapshotCSS × backingDPR) PER AXIS. img.width/height report the CSS size
      // (NOT the device extent), and the backing can be ANISOTROPIC (backing aspect ≠ CSS
      // aspect → dprX ≠ dprY — Salsa's canvas is fixed-res at an arbitrary CSS size), so
      // size each axis independently. Too small on either axis → the copy overflows it and
      // crashes; too large → the glyphs draw short of the element's hit-box.
      // (Spike-verified Chrome 150: a single dpr sized W right but H short → H overflow.)
      // img.width/height are the (rounded) CSS size, but the browser rasterizes from the
      // element's EXACT fractional size, so the true copy extent rounds up ~1px more than
      // ceil(roundedCSS × dpr) — undershooting drops the copy every frame (empty texture).
      // Add a per-axis guard (ceil(dpr)+1) so the copy always fits; the ≤2px transparent
      // margin is visually negligible (and dwarfed by the alternative of no text at all).
      const cr = canvas.getBoundingClientRect();
      const dprX = canvas.width / Math.max(1, cr.width);
      const dprY = canvas.height / Math.max(1, cr.height);
      const w = Math.max(1, Math.ceil((img.width || img.codedWidth || 1) * dprX) + Math.ceil(dprX) + 1);
      const h = Math.max(1, Math.ceil((img.height || img.codedHeight || 1) * dprY) + Math.ceil(dprY) + 1);
      const gpuTex = this.device.createTexture({ size: [w, h], format: 'rgba8unorm', usage });
      // Guard the copy: a mid-resize transient (cr changed between sizing and the copy) can
      // overflow the texture — swallow that one frame rather than surface an uncaptured error.
      this.device.pushErrorScope('validation');
      (this.device.queue as any).copyElementImageToTexture(
        { source: img },
        { destination: { texture: gpuTex } },
      );
      this.device.popErrorScope().then((err) => {
        if (err) console.warn('[captureElement] element copy skipped (resize transient?):', err.message);
      });
      return { texture: gpuTex, width: w, height: h };
    }

    // ── Path 2: WebGL bridge — texElementImage2D takes the raw element, so size the
    //    texture from the element's box × host-canvas backing DPR. ──
    const rect = element.getBoundingClientRect();
    const dpr = TextEffectEngine.elementCaptureDpr(element, hostCanvas);
    const w = Math.ceil(rect.width * dpr) || 1;
    const h = Math.ceil(rect.height * dpr) || 1;
    const gpuTex = this.device.createTexture({ size: [w, h], format: 'rgba8unorm', usage });
    return this.captureElementViaWebGLBridge(element, gpuTex, w, h);
  }

  /**
   * WebGL bridge fallback for captureElement.
   * Used when copyElementImageToTexture isn't available but texElementImage2D is.
   */
  private captureElementViaWebGLBridge(
    element: HTMLElement,
    gpuTex: GPUTexture,
    w: number,
    h: number,
  ): { texture: GPUTexture; width: number; height: number } {
    const glCanvas = document.createElement('canvas');
    glCanvas.width = w;
    glCanvas.height = h;
    const gl = glCanvas.getContext('webgl2', {
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    })!;

    // Upload element rendering as a WebGL texture
    const glTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, glTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    (gl as any).texElementImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA,
      gl.RGBA, gl.UNSIGNED_BYTE, element,
    );

    // Draw to the WebGL canvas via fullscreen quad
    const vsSource = `#version 300 es
      in vec2 a_pos;
      out vec2 v_uv;
      void main() {
        v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;
    const fsSource = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      uniform sampler2D u_tex;
      out vec4 outColor;
      void main() { outColor = texture(u_tex, v_uv); }
    `;

    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, vsSource);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, fsSource);
    gl.compileShader(fs);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const verts = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, glTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.flush();

    // Transfer WebGL canvas → WebGPU texture
    this.device.queue.copyExternalImageToTexture(
      { source: glCanvas },
      { texture: gpuTex },
      [w, h],
    );

    // Cleanup
    gl.deleteTexture(glTex);
    gl.deleteBuffer(vbo);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.deleteProgram(prog);

    return { texture: gpuTex, width: w, height: h };
  }

  /**
   * Set up a canvas element for HTML-in-Canvas capture.
   * Call this once on your main rendering canvas.
   *
   * This adds the `layoutsubtree` attribute and sets up the `onpaint` event
   * so that child elements can be captured as textures.
   *
   * @param canvas The canvas element (should be Salsa's main WebGPU canvas)
   * @param onPaint Optional callback invoked on each paint event with the changed elements
   * @returns A cleanup function that removes the attribute and handler
   *
   * Usage in Frogmarks:
   * ```ts
   * const cleanup = TextEffectEngine.setupCanvasForHtmlCapture(canvas, (changed) => {
   *   // Re-capture any elements that changed
   *   for (const el of changed) {
   *     const tex = textEffectEngine.captureElement(el);
   *     // ... update your texture cache
   *   }
   * });
   * ```
   */
  public static setupCanvasForHtmlCapture(
    canvas: HTMLCanvasElement,
    onPaint?: (changedElements: Element[]) => void,
  ): () => void {
    // Add the layoutsubtree attribute — opts children into layout + hit testing
    canvas.setAttribute('layoutsubtree', '');

    // The paint event fires when any canvas child's rendering changes
    const handler = (event: any) => {
      onPaint?.(event.changedElements ?? []);
    };
    (canvas as any).onpaint = handler;

    // Return cleanup
    return () => {
      canvas.removeAttribute('layoutsubtree');
      (canvas as any).onpaint = null;
    };
  }

  /**
   * Request a paint event on the next frame (even if no children changed).
   * Useful when you need to re-capture after programmatic changes.
   */
  public static requestPaint(canvas: HTMLCanvasElement): void {
    if ('requestPaint' in canvas) {
      (canvas as any).requestPaint();
    }
  }

  /**
   * Detect which HTML-in-Canvas capture mode is available.
   *
   *  'webgpu-native' — GPUQueue.copyElementImageToTexture() is available (best path)
   *  'webgl-bridge'  — texElementImage2D is available (WebGL→WebGPU bridge)
   *  'none'          — API not available
   *
   * Results are cached per session.
   */
  private static _htmlInCanvasMode: 'webgpu-native' | 'webgl-bridge' | 'none' | null = null;
  public static htmlInCanvasMode(): 'webgpu-native' | 'webgl-bridge' | 'none' {
    if (TextEffectEngine._htmlInCanvasMode !== null) {
      return TextEffectEngine._htmlInCanvasMode;
    }
    try {
      // Native WebGPU path needs BOTH halves of the two-step API: the canvas snapshot
      // (captureElementImage) and the queue copy (copyElementImageToTexture).
      if (typeof GPUQueue !== 'undefined' && 'copyElementImageToTexture' in GPUQueue.prototype
          && typeof HTMLCanvasElement !== 'undefined' && 'captureElementImage' in HTMLCanvasElement.prototype) {
        TextEffectEngine._htmlInCanvasMode = 'webgpu-native';
        return 'webgpu-native';
      }
      // Fall back to WebGL bridge check
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (gl && 'texElementImage2D' in gl) {
        TextEffectEngine._htmlInCanvasMode = 'webgl-bridge';
        return 'webgl-bridge';
      }
    } catch { /* ignore */ }
    TextEffectEngine._htmlInCanvasMode = 'none';
    return 'none';
  }

  /**
   * Check whether any HTML-in-Canvas path is available (either native or bridge).
   */
  public static htmlInCanvasAvailable(): boolean {
    return TextEffectEngine.htmlInCanvasMode() !== 'none';
  }

  // ═══════════════════════════════════════════════════════════════
  //  Effect Application
  // ═══════════════════════════════════════════════════════════════

  /**
   * Apply a text effect to a source texture, writing the result to an output texture.
   * The output texture is created by the engine and returned; the caller owns it.
   */
  public apply(
    src: GPUTexture,
    effect: TextEffectType,
    params: TextEffectParams,
  ): GPUTexture {
    const w = src.width;
    const h = src.height;
    const out = this.createOutputTexture(w, h);

    switch (effect) {
      case 'chromatic-aberration':
        this.applyChromaticAberration(src, out, params as ChromaticAberrationParams);
        break;
      case 'glow':
        this.applyGlow(src, out, params as GlowParams);
        break;
      case 'wave':
        this.applyWave(src, out, params as WaveParams);
        break;
      case 'glitch':
        this.applyGlitch(src, out, params as GlitchParams);
        break;
      case 'outline':
        this.applyOutline(src, out, params as OutlineParams);
        break;
      case 'feather':
        this.applyFeather(src, out, params as FeatherParams);
        break;
      case 'custom':
        this.applyCustom(src, out, params as CustomShaderParams);
        break;
    }

    return out;
  }

  /**
   * Apply a chain of effects sequentially.
   * Returns the final output texture; intermediate textures are destroyed.
   */
  public applyChain(
    src: GPUTexture,
    effects: TextEffectConfig[],
  ): GPUTexture {
    let current = src;
    let ownsTexture = false;

    for (const fx of effects) {
      const next = this.apply(current, fx.type, fx.params);
      if (ownsTexture) current.destroy();
      current = next;
      ownsTexture = true;
    }

    return current;
  }

  // ═══════════════════════════════════════════════════════════════
  //  Chromatic Aberration
  // ═══════════════════════════════════════════════════════════════

  private applyChromaticAberration(src: GPUTexture, dst: GPUTexture, p: ChromaticAberrationParams): void {
    this.ensureChromaticPipeline();
    const dx = Math.cos(p.angle) * p.strength;
    const dy = Math.sin(p.angle) * p.strength;
    const cursorX = p.cursorUV?.[0] ?? -1; // <0 means no cursor
    const cursorY = p.cursorUV?.[1] ?? -1;
    const mouseDown = p.mouseDown ?? 0;
    const cursorRadius = p.cursorRadius ?? 0.3;
    const params = new Float32Array([dx, dy, p.strength, 0, cursorX, cursorY, mouseDown, cursorRadius]);
    this.device.queue.writeBuffer(this.paramBuf, 0, params);

    const bg = this.device.createBindGroup({
      layout: this.chromaticBGL!,
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: dst.createView() },
        { binding: 2, resource: { buffer: this.paramBuf } },
      ],
    });

    this.dispatch(this.chromaticPipeline!, bg, src.width, src.height);
  }

  private ensureChromaticPipeline(): void {
    if (this.chromaticPipeline) return;

    const code = /* wgsl */ `
      struct Params {
        offset: vec2<f32>,
        strength: f32,
        _pad0: f32,
        cursor: vec2<f32>,
        mouseDown: f32,
        cursorRadius: f32,
      };
      @group(0) @binding(0) var src: texture_2d<f32>;
      @group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(2) var<uniform> p: Params;

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(src);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }

        let uv = vec2<f32>(f32(gid.x) / f32(dim.x), f32(gid.y) / f32(dim.y));
        var off = p.offset;

        // Cursor-reactive: modulate offset based on distance to cursor
        if (p.cursor.x >= 0.0) {
          let toCursor = uv - p.cursor;
          let dist = length(toCursor);
          let influence = smoothstep(p.cursorRadius, 0.0, dist);
          // Repel on hover, attract on mouseDown
          let direction = select(1.0, -1.0, p.mouseDown > 0.5);
          let cursorOff = normalize(toCursor) * influence * p.strength * direction;
          off = off + cursorOff;
        }

        // Sample R, G, B at offset positions
        let dimF = vec2<f32>(f32(dim.x), f32(dim.y));
        let maxC = vec2<i32>(i32(dim.x)-1, i32(dim.y)-1);
        let coordR = vec2<i32>(clamp(vec2<i32>(dimF * (uv + off)),   vec2<i32>(0), maxC));
        let coordG = vec2<i32>(i32(gid.x), i32(gid.y));
        let coordB = vec2<i32>(clamp(vec2<i32>(dimF * (uv - off)),   vec2<i32>(0), maxC));

        let r = textureLoad(src, coordR, 0).r;
        let g = textureLoad(src, coordG, 0).g;
        let b = textureLoad(src, coordB, 0).b;

        // Use max alpha from all three samples to avoid clipping
        let aR = textureLoad(src, coordR, 0).a;
        let aG = textureLoad(src, coordG, 0).a;
        let aB = textureLoad(src, coordB, 0).a;
        let a = max(max(aR, aG), aB);

        textureStore(dst, vec2<u32>(gid.x, gid.y), vec4<f32>(r, g, b, a));
      }
    `;

    this.chromaticBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.chromaticPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.chromaticBGL] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  Glow / Bloom
  // ═══════════════════════════════════════════════════════════════

  private applyGlow(src: GPUTexture, dst: GPUTexture, p: GlowParams): void {
    this.ensureGlowPipeline();
    const w = src.width;
    const h = src.height;

    // Two-pass separable Gaussian blur + additive composite
    const temp = this.createOutputTexture(w, h);

    // Horizontal pass: src → temp
    const paramsH = new Float32Array([p.radius, p.intensity, 0, 0,
      p.color?.[0] ?? -1, p.color?.[1] ?? -1, p.color?.[2] ?? -1, 0]);
    this.device.queue.writeBuffer(this.paramBuf, 0, paramsH);

    const bgH = this.device.createBindGroup({
      layout: this.glowBGL!,
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: temp.createView() },
        { binding: 2, resource: { buffer: this.paramBuf } },
      ],
    });
    this.dispatch(this.glowPipelineH!, bgH, w, h);

    // Vertical pass: temp → dst (also composites original on top)
    const paramsV = new Float32Array([p.radius, p.intensity, 1, 0,
      p.color?.[0] ?? -1, p.color?.[1] ?? -1, p.color?.[2] ?? -1, 0]);
    this.device.queue.writeBuffer(this.paramBuf, 0, paramsV);

    const bgV = this.device.createBindGroup({
      layout: this.glowBGL!,
      entries: [
        { binding: 0, resource: temp.createView() },
        { binding: 1, resource: dst.createView() },
        { binding: 2, resource: { buffer: this.paramBuf } },
      ],
    });
    this.dispatch(this.glowPipelineV!, bgV, w, h);

    temp.destroy();

    // Composite: draw original src on top of the glow into dst
    // We do this with a final pass that alpha-blends src over dst
    this.compositeOver(src, dst, w, h);
  }

  private ensureGlowPipeline(): void {
    if (this.glowPipelineH) return;

    // Horizontal blur
    const codeH = /* wgsl */ `
      @group(0) @binding(0) var src: texture_2d<f32>;
      @group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(2) var<uniform> params: array<vec4<f32>, 2>;
      // params[0]: radius, intensity, isVertical, _
      // params[1]: glowColor.rgb (if < 0, use source color)

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(src);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }

        let radius = i32(params[0].x);
        let intensity = params[0].y;
        let coord = vec2<i32>(i32(gid.x), i32(gid.y));

        var accum = vec4<f32>(0.0);
        var weightSum = 0.0;

        for (var dx = -radius; dx <= radius; dx++) {
          let sc = vec2<i32>(clamp(coord.x + dx, 0, i32(dim.x) - 1), coord.y);
          let w = exp(-f32(dx * dx) / (2.0 * f32(radius * radius) / 9.0));
          accum += textureLoad(src, sc, 0) * w;
          weightSum += w;
        }

        var blurred = accum / weightSum;
        blurred = vec4<f32>(blurred.rgb * intensity, blurred.a);

        // Apply glow color tint if specified
        if (params[1].x >= 0.0) {
          blurred = vec4<f32>(params[1].xyz * blurred.a * intensity, blurred.a);
        }

        textureStore(dst, vec2<u32>(gid.x, gid.y), blurred);
      }
    `;

    // Vertical blur
    const codeV = /* wgsl */ `
      @group(0) @binding(0) var src: texture_2d<f32>;
      @group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(2) var<uniform> params: array<vec4<f32>, 2>;

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(src);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }

        let radius = i32(params[0].x);
        let intensity = params[0].y;
        let coord = vec2<i32>(i32(gid.x), i32(gid.y));

        var accum = vec4<f32>(0.0);
        var weightSum = 0.0;

        for (var dy = -radius; dy <= radius; dy++) {
          let sc = vec2<i32>(coord.x, clamp(coord.y + dy, 0, i32(dim.y) - 1));
          let w = exp(-f32(dy * dy) / (2.0 * f32(radius * radius) / 9.0));
          accum += textureLoad(src, sc, 0) * w;
          weightSum += w;
        }

        var blurred = accum / weightSum;

        if (params[1].x >= 0.0) {
          blurred = vec4<f32>(params[1].xyz * blurred.a * intensity, blurred.a);
        } else {
          blurred = vec4<f32>(blurred.rgb * intensity, blurred.a);
        }

        textureStore(dst, vec2<u32>(gid.x, gid.y), blurred);
      }
    `;

    this.glowBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.glowBGL] });
    this.glowPipelineH = this.device.createComputePipeline({
      layout,
      compute: { module: this.device.createShaderModule({ code: codeH }), entryPoint: 'main' },
    });
    this.glowPipelineV = this.device.createComputePipeline({
      layout,
      compute: { module: this.device.createShaderModule({ code: codeV }), entryPoint: 'main' },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  Wave Distortion
  // ═══════════════════════════════════════════════════════════════

  private applyWave(src: GPUTexture, dst: GPUTexture, p: WaveParams): void {
    this.ensureWavePipeline();
    const params = new Float32Array([p.amplitude, p.frequency, p.speed, p.time, 0, 0, 0, 0]);
    this.device.queue.writeBuffer(this.paramBuf, 0, params);

    const bg = this.device.createBindGroup({
      layout: this.waveBGL!,
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: dst.createView() },
        { binding: 2, resource: { buffer: this.paramBuf } },
      ],
    });

    this.dispatch(this.wavePipeline!, bg, src.width, src.height);
  }

  private ensureWavePipeline(): void {
    if (this.wavePipeline) return;

    const code = /* wgsl */ `
      @group(0) @binding(0) var src: texture_2d<f32>;
      @group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(2) var<uniform> params: vec4<f32>;
      // params: amplitude, frequency, speed, time

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(src);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }

        let amp = params.x;
        let freq = params.y;
        let spd = params.z;
        let t = params.w;

        let uv = vec2<f32>(f32(gid.x) / f32(dim.x), f32(gid.y) / f32(dim.y));

        // Sine wave displacement
        let offsetX = amp * sin(uv.y * freq + t * spd) / f32(dim.x);
        let offsetY = amp * cos(uv.x * freq * 0.7 + t * spd * 0.8) / f32(dim.y);

        let srcUV = uv + vec2<f32>(offsetX, offsetY);
        let srcCoord = vec2<i32>(clamp(
          vec2<i32>(vec2<f32>(f32(dim.x), f32(dim.y)) * srcUV),
          vec2<i32>(0),
          vec2<i32>(i32(dim.x) - 1, i32(dim.y) - 1)
        ));

        let px = textureLoad(src, srcCoord, 0);
        textureStore(dst, vec2<u32>(gid.x, gid.y), px);
      }
    `;

    this.waveBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.wavePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.waveBGL] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  Glitch
  // ═══════════════════════════════════════════════════════════════

  private applyGlitch(src: GPUTexture, dst: GPUTexture, p: GlitchParams): void {
    this.ensureGlitchPipeline();
    const params = new Float32Array([p.intensity, p.blockSize, p.time, 0, 0, 0, 0, 0]);
    this.device.queue.writeBuffer(this.paramBuf, 0, params);

    const bg = this.device.createBindGroup({
      layout: this.glitchBGL!,
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: dst.createView() },
        { binding: 2, resource: { buffer: this.paramBuf } },
      ],
    });

    this.dispatch(this.glitchPipeline!, bg, src.width, src.height);
  }

  private ensureGlitchPipeline(): void {
    if (this.glitchPipeline) return;

    const code = /* wgsl */ `
      @group(0) @binding(0) var src: texture_2d<f32>;
      @group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(2) var<uniform> params: vec4<f32>;
      // params: intensity, blockSize, time, _

      // Simple hash for deterministic pseudo-random
      fn hash(n: f32) -> f32 {
        return fract(sin(n) * 43758.5453123);
      }

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(src);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }

        let intensity = params.x;
        let blockSize = params.y;
        let t = params.z;

        let coord = vec2<i32>(i32(gid.x), i32(gid.y));

        // Block-based row displacement
        let blockY = floor(f32(gid.y) / blockSize);
        let rowHash = hash(blockY * 7.0 + floor(t * 3.0));

        // Only displace some rows (based on intensity threshold)
        var displaced = coord;
        if (rowHash < intensity) {
          let shift = i32((hash(blockY * 13.0 + floor(t * 5.0)) - 0.5) * 2.0 * intensity * f32(dim.x) * 0.1);
          displaced.x = clamp(coord.x + shift, 0, i32(dim.x) - 1);
        }

        // RGB split on displaced rows
        var px = textureLoad(src, displaced, 0);
        if (rowHash < intensity * 0.5) {
          let splitAmt = i32(intensity * 8.0);
          let rCoord = vec2<i32>(clamp(displaced.x + splitAmt, 0, i32(dim.x) - 1), displaced.y);
          let bCoord = vec2<i32>(clamp(displaced.x - splitAmt, 0, i32(dim.x) - 1), displaced.y);
          px = vec4<f32>(
            textureLoad(src, rCoord, 0).r,
            px.g,
            textureLoad(src, bCoord, 0).b,
            px.a
          );
        }

        textureStore(dst, vec2<u32>(gid.x, gid.y), px);
      }
    `;

    this.glitchBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.glitchPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.glitchBGL] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  Outline / Stroke
  // ═══════════════════════════════════════════════════════════════

  private applyOutline(src: GPUTexture, dst: GPUTexture, p: OutlineParams): void {
    this.ensureOutlinePipeline();
    const offX = p.offset?.[0] ?? 0, offY = p.offset?.[1] ?? 0;
    const gap = Math.max(0, p.gap ?? 0);
    const params = new Float32Array([
      p.thickness, 0, 0, 0,
      p.color[0], p.color[1], p.color[2], p.color[3],
      offX, offY, gap, 0,
    ]);
    this.device.queue.writeBuffer(this.paramBuf, 0, params);

    const bg = this.device.createBindGroup({
      layout: this.outlineBGL!,
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: dst.createView() },
        { binding: 2, resource: { buffer: this.paramBuf } },
      ],
    });

    this.dispatch(this.outlinePipeline!, bg, src.width, src.height);
  }

  private ensureOutlinePipeline(): void {
    if (this.outlinePipeline) return;

    const code = /* wgsl */ `
      @group(0) @binding(0) var src: texture_2d<f32>;
      @group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(2) var<uniform> params: array<vec4<f32>, 3>;
      // params[0].x = thickness
      // params[1]   = outline color RGBA
      // params[2]   = offsetX, offsetY, gap, _

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(src);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }

        let thickness = i32(params[0].x);
        let outlineColor = params[1];
        let offset = vec2<i32>(i32(params[2].x), i32(params[2].y));
        let gap = max(0, i32(params[2].z));
        // Outline band spans the ring [gap, gap+thickness] around the (offset) glyph edge.
        let outer = min(gap + thickness, 64); // bound the loop
        let coord = vec2<i32>(i32(gid.x), i32(gid.y));

        let srcPx = textureLoad(src, coord, 0);
        let centerAlpha = srcPx.a;

        // Coverage of the offset glyph within the inner (gap) and outer (gap+thickness) radii.
        var innerCov = 0.0;
        var outerCov = 0.0;
        let gap2 = f32(gap * gap);
        let outer2 = f32(outer * outer);
        for (var dy = -outer; dy <= outer; dy++) {
          for (var dx = -outer; dx <= outer; dx++) {
            let d2 = f32(dx * dx + dy * dy);
            if (d2 > outer2) { continue; }
            let sc = vec2<i32>(
              clamp(coord.x + dx - offset.x, 0, i32(dim.x) - 1),
              clamp(coord.y + dy - offset.y, 0, i32(dim.y) - 1)
            );
            let a = textureLoad(src, sc, 0).a;
            outerCov = max(outerCov, a);
            if (d2 <= gap2) { innerCov = max(innerCov, a); }
          }
        }

        if (centerAlpha > 0.5) {
          // Original text pixel — draw as-is on top of the outline.
          textureStore(dst, vec2<u32>(gid.x, gid.y), srcPx);
        } else if (outerCov > 0.5 && innerCov <= 0.5) {
          // Outline band (gapped + offset). innerCov<=0.5 carves the transparent gap.
          textureStore(dst, vec2<u32>(gid.x, gid.y), outlineColor);
        } else {
          textureStore(dst, vec2<u32>(gid.x, gid.y), vec4<f32>(0.0));
        }
      }
    `;

    this.outlineBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.outlinePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.outlineBGL] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  Feather (directional / radial alpha fade-out)
  // ═══════════════════════════════════════════════════════════════

  private applyFeather(src: GPUTexture, dst: GPUTexture, p: FeatherParams): void {
    this.ensureFeatherPipeline();
    const mode = p.mode === 'radial' ? 1 : 0;
    const angleRad = ((p.angle ?? 90) * Math.PI) / 180;
    // params = [mode, angle(rad), start, end]
    const params = new Float32Array([mode, angleRad, p.start, p.end]);
    this.device.queue.writeBuffer(this.paramBuf, 0, params);

    const bg = this.device.createBindGroup({
      layout: this.featherBGL!,
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: dst.createView() },
        { binding: 2, resource: { buffer: this.paramBuf } },
      ],
    });

    this.dispatch(this.featherPipeline!, bg, src.width, src.height);
  }

  private ensureFeatherPipeline(): void {
    if (this.featherPipeline) return;

    const code = /* wgsl */ `
      @group(0) @binding(0) var src: texture_2d<f32>;
      @group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(2) var<uniform> params: vec4<f32>;
      // params = mode (0 linear / 1 radial), angle(rad), start, end (0-1)

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(src);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let coord = vec2<i32>(i32(gid.x), i32(gid.y));
        var srcPx = textureLoad(src, coord, 0);

        let uv = vec2<f32>((f32(gid.x) + 0.5) / f32(dim.x), (f32(gid.y) + 0.5) / f32(dim.y));
        let start = params.z;
        let end = params.w;

        var t: f32;
        if (params.x > 0.5) {
          // radial: 0 at center, 1 at the corners
          t = length(uv - vec2<f32>(0.5, 0.5)) / 0.7071068;
        } else {
          // linear: project onto the fade direction, remapped to 0-1 across the texture
          let dir = vec2<f32>(cos(params.y), sin(params.y));
          t = dot(uv - vec2<f32>(0.5, 0.5), dir) + 0.5;
        }

        let lo = min(start, end);
        let hi = max(start, end);
        let s = smoothstep(lo, hi, t);
        var aMul: f32;
        if (end >= start) { aMul = 1.0 - s; } else { aMul = s; }

        srcPx.a = srcPx.a * clamp(aMul, 0.0, 1.0);
        textureStore(dst, vec2<u32>(gid.x, gid.y), srcPx);
      }
    `;

    this.featherBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.featherPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.featherBGL] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  Custom WGSL Shader
  // ═══════════════════════════════════════════════════════════════

  private applyCustom(src: GPUTexture, dst: GPUTexture, p: CustomShaderParams): void {
    const wgsl = p.rawCode ?? this.wrapCustomCode(p.code ?? '');
    const cacheKey = this.hashCode(wgsl);

    let pipeline = this.customPipelineCache.get(cacheKey);
    if (!pipeline) {
      const result = this.compileCustomPipelineSync(wgsl);
      if (!result) return; // compilation failed — output stays blank
      pipeline = result;
      this.customPipelineCache.set(cacheKey, pipeline);
    }

    this.ensureCustomBGL();

    // Upload uniforms: resolution(2) + time(1) + mouseDown(1) + cursor(2) + params(4) = 10 floats = 40 bytes
    // Padded to 48 for alignment (12 floats)
    const params = p.params ?? [0, 0, 0, 0];
    const uniforms = new Float32Array([
      src.width, src.height,           // resolution
      p.time ?? 0,                     // time
      p.mouseDown ?? 0,                // mouseDown
      p.cursorUV?.[0] ?? 0.5,          // cursor.x
      p.cursorUV?.[1] ?? 0.5,          // cursor.y
      params[0], params[1],            // user params a, b
      params[2], params[3],            // user params c, d
      0, 0,                            // padding
    ]);
    this.device.queue.writeBuffer(this.customParamBuf, 0, uniforms);

    const bg = this.device.createBindGroup({
      layout: this.customBGL!,
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: dst.createView() },
        { binding: 2, resource: { buffer: this.customParamBuf } },
      ],
    });

    this.dispatch(pipeline, bg, src.width, src.height);
  }

  /**
   * Wrap user-provided effect body in the standard harness.
   * The user writes just the part that reads from `src` and writes to `dst`.
   */
  private wrapCustomCode(body: string): string {
    return /* wgsl */ `
      struct CustomUniforms {
        resolution : vec2<f32>,
        time       : f32,
        mouseDown  : f32,
        cursor     : vec2<f32>,
        params     : vec4<f32>,
      };

      @group(0) @binding(0) var src : texture_2d<f32>;
      @group(0) @binding(1) var dst : texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(2) var<uniform> u : CustomUniforms;

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
        let dim = textureDimensions(src);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let uv = vec2<f32>(f32(gid.x) / f32(dim.x), f32(gid.y) / f32(dim.y));

        // ── User code begins ──
        ${body}
        // ── User code ends ──
      }
    `;
  }

  private ensureCustomBGL(): void {
    if (this.customBGL) return;
    this.customBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
  }

  /**
   * Compile a custom WGSL shader synchronously.
   * Returns the pipeline on success, null on failure.
   */
  private compileCustomPipelineSync(wgsl: string): GPUComputePipeline | null {
    this.ensureCustomBGL();
    try {
      const module = this.device.createShaderModule({ code: wgsl });
      return this.device.createComputePipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.customBGL!] }),
        compute: { module, entryPoint: 'main' },
      });
    } catch {
      return null;
    }
  }

  /**
   * Validate and compile a custom shader, returning detailed error info.
   * Call this from the UI to give the user feedback before applying.
   *
   * @param code User-written WGSL (just the effect body, or raw module with rawCode=true)
   * @param rawCode If true, `code` is a complete WGSL module. Otherwise it's the effect body.
   * @returns Compilation result with success flag and any error messages.
   */
  public async validateCustomShader(code: string, rawCode = false): Promise<CustomShaderCompileResult> {
    const wgsl = rawCode ? code : this.wrapCustomCode(code);
    this.ensureCustomBGL();

    try {
      const module = this.device.createShaderModule({ code: wgsl });

      // Use compilationInfo() to get detailed errors
      if (module.getCompilationInfo) {
        const info = await module.getCompilationInfo();
        const errors = info.messages
          .filter(m => m.type === 'error')
          .map(m => `Line ${m.lineNum}:${m.linePos} — ${m.message}`);

        if (errors.length > 0) {
          return { success: false, errors };
        }
      }

      // If no errors, try creating the pipeline to catch link errors
      this.device.createComputePipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.customBGL!] }),
        compute: { module, entryPoint: 'main' },
      });

      return { success: true };
    } catch (e: any) {
      return { success: false, errors: [e.message ?? String(e)] };
    }
  }

  /**
   * Simple string hash for pipeline cache keys.
   */
  private hashCode(s: string): string {
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  }

  /**
   * Evict a cached custom pipeline (e.g., when user edits the shader code).
   * The old pipeline is GC'd by the browser.
   */
  public evictCustomShader(code: string, rawCode = false): void {
    const wgsl = rawCode ? code : this.wrapCustomCode(code);
    this.customPipelineCache.delete(this.hashCode(wgsl));
  }

  /**
   * Clear all cached custom shader pipelines.
   */
  public clearCustomShaderCache(): void {
    this.customPipelineCache.clear();
  }

  // ═══════════════════════════════════════════════════════════════
  //  Composite helper (alpha-over src onto dst)
  // ═══════════════════════════════════════════════════════════════

  private compositePipeline: GPUComputePipeline | null = null;
  private compositeBGL: GPUBindGroupLayout | null = null;

  private compositeOver(src: GPUTexture, dst: GPUTexture, w: number, h: number): void {
    this.ensureCompositePipeline();

    // We need a temp copy of dst to read from (can't read+write same storage texture)
    const temp = this.createOutputTexture(w, h);
    const enc0 = this.device.createCommandEncoder();
    enc0.copyTextureToTexture({ texture: dst }, { texture: temp }, { width: w, height: h });
    this.device.queue.submit([enc0.finish()]);

    const bg = this.device.createBindGroup({
      layout: this.compositeBGL!,
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: temp.createView() },
        { binding: 2, resource: dst.createView() },
      ],
    });

    this.dispatch(this.compositePipeline!, bg, w, h);
    temp.destroy();
  }

  private ensureCompositePipeline(): void {
    if (this.compositePipeline) return;

    const code = /* wgsl */ `
      @group(0) @binding(0) var srcTex: texture_2d<f32>;
      @group(0) @binding(1) var dstRead: texture_2d<f32>;
      @group(0) @binding(2) var dstWrite: texture_storage_2d<rgba8unorm, write>;

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(srcTex);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let coord = vec2<i32>(i32(gid.x), i32(gid.y));

        let s = textureLoad(srcTex, coord, 0);
        let d = textureLoad(dstRead, coord, 0);

        // Standard alpha-over: src over dst
        let outA = s.a + d.a * (1.0 - s.a);
        var outRGB = vec3<f32>(0.0);
        if (outA > 0.001) {
          outRGB = (s.rgb * s.a + d.rgb * d.a * (1.0 - s.a)) / outA;
        }

        textureStore(dstWrite, vec2<u32>(gid.x, gid.y), vec4<f32>(outRGB, outA));
      }
    `;

    this.compositeBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
      ],
    });

    this.compositePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.compositeBGL] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  Utilities
  // ═══════════════════════════════════════════════════════════════

  private createOutputTexture(w: number, h: number): GPUTexture {
    return this.device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
  }

  private dispatch(pipeline: GPUComputePipeline, bindGroup: GPUBindGroup, w: number, h: number): void {
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  private wrapText(text: string, font: string, maxWidth?: number): string[] {
    if (!maxWidth || maxWidth <= 0) return text.split('\n');

    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d')!;
    ctx.font = font;

    const lines: string[] = [];
    for (const paragraph of text.split('\n')) {
      const words = paragraph.split(' ');
      let line = '';
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth && line) {
          lines.push(line);
          line = word;
        } else {
          line = test;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  public destroy(): void {
    this.paramBuf.destroy();
    this.customParamBuf.destroy();
  }
}
