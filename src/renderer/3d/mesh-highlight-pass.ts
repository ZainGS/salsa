// Draws the hover/selection outline around individual 3D meshes (stencil mask + expanded shell).
/**
 * MeshHighlightPass — per-mesh silhouette outline for hover and selection.
 *
 * Uses a two-pipeline stencil technique:
 *
 *   Step 1 — Stencil write (setStencilReference(1), _stencilPipeline):
 *     Renders the original mesh silhouette into the stencil buffer using
 *     (compare='always', passOp='replace').  No color or depth writes.
 *     After this step, stencil=1 at every visible pixel of the mesh.
 *
 *   Step 2 — Outline draw (_outlinePipeline):
 *     Renders the same mesh with vertices expanded along their model-space
 *     normals.  Stencil compare='not-equal' (ref=1) masks out the interior,
 *     so only the ring outside the original silhouette is coloured.
 *     cullMode='back' draws the expanded shell's front faces.
 *
 *   Step 3 — Stencil clear (setStencilReference(0), _stencilPipeline):
 *     Re-draws the original mesh with (compare='always', passOp='replace',
 *     ref=0) to reset stencil back to 0, keeping the buffer clean for
 *     subsequent draw calls (hover and select are drawn independently).
 *
 * Two independent param buffers (hover / select) avoid writeBuffer ordering
 * issues when both are drawn in the same render pass.
 */

import { PipelineSet, PIPELINE_PRIORITY, type PipelineHandle } from '../core/gpu-pipeline-cache';
import { HIGHLIGHT_SHADER, STENCIL_WRITE_SHADER, SKINNED_HIGHLIGHT_SHADER, SKINNED_STENCIL_WRITE_SHADER } from './shaders/highlight-shaders';
import { MESH3D_VERTEX_STRIDE, SKINNED_MESH3D_VERTEX_STRIDE } from './pipeline-3d';
import { packedVertexBuffers } from './vertex-pack';

const PARAMS_SIZE = 80; // color vec4 + patternColor vec4 + params vec4 + screen vec4 + boil vec4

/** Look of one outline slot. `patternMode` 0 = flat (no pattern, the classic hover/select ring). 1 = scrolling
 *  stripes, 2 = dots, 3 = checker. `glow` >1 brightens the band (catches bloom). `width` is model-space. */
export interface HighlightStyle {
  color:        [number, number, number, number];
  width:        number;   // model-space expand (legacy stencil ring — used by the 'select' slot)
  thicknessPx:  number;   // SCREEN-space band thickness in px (the silhouette-outline hover pass)
  patternMode:  number;
  patternColor: [number, number, number];
  freq:         number;
  speed:        number;
  glow:         number;
  /** Persistent per-object outlines only: when true, the outline (and its silhouette mask) IGNORE depth — drawn on
   *  top — so overlapping objects' outlines visually MERGE instead of the nearer one occluding the farther. Default
   *  false = depth-sorted (an object behind another is behind its outline; in front is in front). */
  merge?: boolean;
  /** LINE BOIL (film-look-and-toon-shadows.md §D) — hand-drawn outlines: the band's thickness varies along the line
   *  by up to ±`wobble` (0..1, 0 = off = today's even line) and the pattern REDRAWS `boilFps` times a second (8–12 =
   *  classic animation "boil"; 0 = uneven but still). `wobbleFreq` = how many wobbles per model unit (default 10). */
  wobble?: number;
  wobbleFreq?: number;
  boilFps?: number;
  /** SPRITES only (docs/specs/sprite-alpha-outlines.md) — the outline's shape for a textured sprite:
   *  'image' (default) = around the picture's shape (when the image has transparency) · 'square' = the classic outline
   *  around the quad (see-through parts stay see-through) · 'card' = a SOLID card: the quad's see-through parts are
   *  filled with this outline's look and the rings go around the square. Ignored by every other mesh. */
  spriteShape?: SpriteOutlineShape;
  /** @deprecated Use `spriteShape` — `alphaShape: false` still means 'square' (it shipped briefly on 2026-09-29). */
  alphaShape?: boolean;
}
/** A sprite outline's shape (HighlightStyle.spriteShape). */
export type SpriteOutlineShape = 'image' | 'square' | 'card';
/** Whether a style's outline changes over time (scrolling pattern or boiling line) — keep frames flowing. */
export function outlineAnimates(s: HighlightStyle): boolean {
  return s.speed !== 0 || ((s.wobble ?? 0) > 0 && (s.boilFps ?? 10) > 0);
}

/** The layers of a STACKED outline (Mesh3D.outline + outlineRings), inner → outer, each with its CUMULATIVE shell
 *  width: a ring's own `width` is its band thickness, so its shell = everything inside it + that. Drawn inner-first
 *  with the draw-once stencil, each ring fills only the band beyond the rings inside it. Pure. */
export function outlineLayers(main: HighlightStyle, rings: readonly HighlightStyle[] | null | undefined): HighlightStyle[] {
  const out: HighlightStyle[] = [main];
  let w = main.width;
  for (const r of rings ?? []) { w += Math.max(0, r.width); out.push({ ...r, width: w }); }
  return out;
}

export interface HighlightMeshEntry {
  vertex:      GPUBuffer;
  index:       GPUBuffer;
  indexCount:  number;
  firstIndex:  number;
  baseVertex:  number;
  instanceIdx: number;
  /** P22: a packed pool allocation (32-byte vertices, 16-bit indices: vertex-pack.ts) — drawn with the stride-32 twins. */
  pk?:         boolean;
}

export class MeshHighlightPass {
  private device: GPUDevice;
  // P2: every pipeline is a non-blocking cache handle; ready() gates each draw method (all-or-nothing).
  private readonly _pipes: PipelineSet;
  private _outlinePipeline: PipelineHandle<GPURenderPipeline>;
  private _stencilPipeline: PipelineHandle<GPURenderPipeline>;
  // "Merge" (on-top) variants: depthCompare 'always' so the outline + its silhouette mask ignore depth. Built
  // alongside the depth-tested ones from the same shader modules/layouts (see _buildDepthVariants).
  private _stencilPipelineOnTop: PipelineHandle<GPURenderPipeline> | null = null;
  private _outlinePipelineOnTop: PipelineHandle<GPURenderPipeline> | null = null;
  // PERSISTENT-outline variants that draw each band pixel ONCE (stencil passOp 'replace' — see _mkOutline) + the
  // matching SHELL-CLEAR pipelines that reset those band pixels after (so later outlines / highlights aren't blocked).
  private _customOutlinePipeline: PipelineHandle<GPURenderPipeline> | null = null;
  private _shellClearPipeline: PipelineHandle<GPURenderPipeline> | null = null;
  /** P22: regular pipeline → its stride-32 twin (packed pool allocations). */
  private readonly _pkOf = new Map<PipelineHandle<GPURenderPipeline>, PipelineHandle<GPURenderPipeline>>();
  /** `h`'s pipeline for entry `e` — its packed twin for a packed entry; null while compiling. */
  private _pipeFor(h: PipelineHandle<GPURenderPipeline>, e: HighlightMeshEntry): GPURenderPipeline | null {
    return (e.pk ? (this._pkOf.get(h) ?? null) : h)?.get() ?? null;
  }
  private _skinnedShellClearPipeline: PipelineHandle<GPURenderPipeline> | null = null;
  private _skinnedStencilPipelineOnTop: PipelineHandle<GPURenderPipeline> | null = null;
  private _skinnedOutlinePipelineOnTop: PipelineHandle<GPURenderPipeline> | null = null;
  private _paramsBGL: GPUBindGroupLayout;

  // Two separate buffers so both can be enqueued before the pass begins
  private _hoverBuf:  GPUBuffer;
  private _selectBuf: GPUBuffer;
  private _hoverBG:   GPUBindGroup;
  private _selectBG:  GPUBindGroup;

  // A GROWING POOL for persistent PER-OBJECT outlines: each outlined mesh needs its OWN param buffer, because
  // within one submit a uniform buffer written N times is read by ALL draws as the LAST write — so distinct
  // per-object styles can't share the two hover/select slots. One buffer per outline, written once, drawn once.
  private _customBufs: GPUBuffer[] = [];
  private _customBGs:  GPUBindGroup[] = [];

  // SKINNED (armature-rigged) outline pipelines + a SEPARATE param pool. Built only when a skin bind-group layout
  // is supplied. The pool must be separate from the regular one: drawMeshes and drawSkinnedMeshes both write the
  // pool starting at index 0 in the SAME submit, so a shared pool would collide (last write wins for both).
  private _skinnedStencilPipeline: PipelineHandle<GPURenderPipeline> | null = null;
  private _skinnedOutlinePipeline: PipelineHandle<GPURenderPipeline> | null = null;
  private _customBufsSk: GPUBuffer[] = [];
  private _customBGsSk:  GPUBindGroup[] = [];

  constructor(
    device: GPUDevice,
    meshBGL: GPUBindGroupLayout,
    swapChainFormat: GPUTextureFormat,
    skinBGL?: GPUBindGroupLayout,
    textureBGL?: GPUBindGroupLayout,
  ) {
    this.device = device;
    this._pipes = new PipelineSet(device, PIPELINE_PRIORITY.COMMON);   // P2: hover/select outlines are used by every 3D scene

    // ── Params bind group layout (hover/select color + width) ──────
    this._paramsBGL = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      }],
    });

    const makeParamsBuf = () => device.createBuffer({
      size: PARAMS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const makeBG = (buf: GPUBuffer) => device.createBindGroup({
      layout: this._paramsBGL,
      entries: [{ binding: 0, resource: { buffer: buf } }],
    });

    this._hoverBuf  = makeParamsBuf();
    this._selectBuf = makeParamsBuf();
    this._hoverBG   = makeBG(this._hoverBuf);
    this._selectBG  = makeBG(this._selectBuf);

    // ── Stencil-write pipeline ─────────────────────────────────────
    // Renders original mesh (no expansion) with:
    //   - no color writes (writeMask=0)
    //   - no depth writes (depthWriteEnabled=false)
    //   - stencil replace with reference value (set dynamically)
    // Used for both writing stencil=1 and clearing back to stencil=0.
    const stencilMod = device.createShaderModule({ code: STENCIL_WRITE_SHADER });
    const stencilLayout = device.createPipelineLayout({
      bindGroupLayouts: [meshBGL],
    });

    this._stencilPipeline = this._pipes.render({
      label: 'HighlightStencil',
      layout: stencilLayout,
      vertex: {
        module: stencilMod,
        entryPoint: 'vs_stencil',
        buffers: [{
          arrayStride: MESH3D_VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position only
          ],
        }],
      },
      fragment: {
        module: stencilMod,
        entryPoint: 'fs_stencil',
        targets: [{
          format: swapChainFormat,
          writeMask: 0, // write nothing to color buffer
        }],
      },
      // 'none': write stencil for both faces so back-viewed planes/ribbons
      // get a complete stencil footprint and therefore a complete outline ring.
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: 'depth24plus-stencil8',
        depthWriteEnabled: false,
        depthCompare: 'less-equal', // pass for already-drawn mesh surface
        stencilFront: {
          compare:      'always',
          failOp:       'keep',
          depthFailOp:  'keep',
          passOp:       'replace', // write reference value (1 or 0) to stencil
        },
        stencilBack: {
          compare:      'always',
          failOp:       'keep',
          depthFailOp:  'keep',
          passOp:       'replace',
        },
      },
    });

    // ── Outline draw pipeline ──────────────────────────────────────
    // Renders expanded mesh (vertices pushed along normals) with:
    //   - alpha blending for the outline colour
    //   - stencil not-equal (ref=1): only draws outside the mesh footprint
    //   - cullMode='back': front faces of expanded shell face the camera
    const outlineMod = device.createShaderModule({ code: HIGHLIGHT_SHADER });
    const outlineLayout = device.createPipelineLayout({
      bindGroupLayouts: [meshBGL, this._paramsBGL],
    });

    this._outlinePipeline = this._pipes.render({
      label: 'HighlightOutline',
      layout: outlineLayout,
      vertex: {
        module: outlineMod,
        entryPoint: 'vs',
        buffers: [{
          arrayStride: MESH3D_VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0,  format: 'float32x3' }, // position
            { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
          ],
        }],
      },
      fragment: {
        module: outlineMod,
        entryPoint: 'fs',
        targets: [{
          format: swapChainFormat,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: {
        format: 'depth24plus-stencil8',
        // WRITE depth so a later pass (skinned characters draw after regular meshes) is occluded by an outline in
        // front of it, instead of painting over the outline's band (which happened when this left no depth behind).
        depthWriteEnabled: true,
        depthCompare: 'less-equal',
        stencilFront: {
          compare:     'not-equal', // draw only OUTSIDE the mesh silhouette (stencil=0)
          failOp:      'keep',
          depthFailOp: 'keep',
          passOp:      'keep',
        },
        stencilBack: {
          compare:     'not-equal',
          failOp:      'keep',
          depthFailOp: 'keep',
          passOp:      'keep',
        },
      },
    });

    // MERGE (on-top) variants of the regular pipelines — depthCompare 'always' (both stencil-mask and outline), so
    // the outline draws around the object's FULL projected silhouette regardless of what's in front, letting two
    // objects' outlines overlap/merge. Same modules + layouts as above.
    this._stencilPipelineOnTop = this._mkStencil(stencilLayout, stencilMod, 'vs_stencil',
      [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] as GPUVertexAttribute[], MESH3D_VERTEX_STRIDE, swapChainFormat, 'always');
    this._outlinePipelineOnTop = this._mkOutline(outlineLayout, outlineMod, 'vs',
      [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] as GPUVertexAttribute[],
      MESH3D_VERTEX_STRIDE, swapChainFormat, 'always');
    {
      const posNrm = [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] as GPUVertexAttribute[];
      // Depth-sorted persistent outline: like _outlinePipeline (writes depth so the later skinned pass is occluded)
      // but draw-once. _outlinePipeline itself stays as-is for the hover/select slots.
      this._customOutlinePipeline = this._mkOutline(outlineLayout, outlineMod, 'vs', posNrm, MESH3D_VERTEX_STRIDE, swapChainFormat, 'less-equal', true);
      this._shellClearPipeline = this._mkShellClear(outlineLayout, outlineMod, 'vs', posNrm, MESH3D_VERTEX_STRIDE, swapChainFormat);
    }
    // P22: the stride-32 twins of the regular (pool) pipelines, for packed allocations (they read position / normal only)
    for (const h of [this._stencilPipeline, this._outlinePipeline, this._stencilPipelineOnTop, this._outlinePipelineOnTop, this._customOutlinePipeline, this._shellClearPipeline]) {
      if (!h) continue;
      const d = h.descriptor(), bufs = packedVertexBuffers(d.vertex.buffers);
      if (bufs) this._pkOf.set(h, this._pipes.render({ ...d, label: (d.label ?? 'Highlight') + ' #packed', vertex: { ...d.vertex, buffers: bufs } }));
    }

    // ── SKINNED outline pipelines (armature-rigged meshes) ─────────────
    // Same two-pipeline stencil technique, but the vertex shaders skin the position/normal first (group 1 = the
    // per-skeleton skinMatrices buffer) and the vertex buffer is the 72-byte skinned layout. Built only when a
    // skin bind-group layout is available.
    if (skinBGL && textureBGL) {
      // The 72-byte skinned vertex: pos @0, normal @12, uv @24, joints (uint8x4) @48, weights (float32x4) @52.
      const skUv = { shaderLocation: 2, offset: 24, format: 'float32x2' as const };
      const skJoints = { shaderLocation: 4, offset: 48, format: 'uint8x4' as const };
      const skWeights = { shaderLocation: 5, offset: 52, format: 'float32x4' as const };
      // The stencil pipeline takes the texture BGL (group 2) so it can alpha-test alpha-cutout hair; the outline
      // pipeline takes the params BGL (group 2). The stencil VS also needs UV for that alpha test.
      const skStencilLayout = device.createPipelineLayout({ bindGroupLayouts: [meshBGL, skinBGL, textureBGL] });
      const skOutlineLayout = device.createPipelineLayout({ bindGroupLayouts: [meshBGL, skinBGL, this._paramsBGL] });
      const skStencilAttrs = [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, skUv, skJoints, skWeights] as GPUVertexAttribute[];
      const skOutlineAttrs = [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, skJoints, skWeights] as GPUVertexAttribute[];
      const skStencilMod = device.createShaderModule({ code: SKINNED_STENCIL_WRITE_SHADER });
      const skOutlineMod = device.createShaderModule({ code: SKINNED_HIGHLIGHT_SHADER });

      this._skinnedStencilPipeline      = this._mkStencil(skStencilLayout, skStencilMod, 'vs_stencil', skStencilAttrs, SKINNED_MESH3D_VERTEX_STRIDE, swapChainFormat, 'less-equal');
      this._skinnedOutlinePipeline      = this._mkOutline(skOutlineLayout, skOutlineMod, 'vs',        skOutlineAttrs, SKINNED_MESH3D_VERTEX_STRIDE, swapChainFormat, 'less-equal');
      this._skinnedStencilPipelineOnTop = this._mkStencil(skStencilLayout, skStencilMod, 'vs_stencil', skStencilAttrs, SKINNED_MESH3D_VERTEX_STRIDE, swapChainFormat, 'always');
      this._skinnedOutlinePipelineOnTop = this._mkOutline(skOutlineLayout, skOutlineMod, 'vs',        skOutlineAttrs, SKINNED_MESH3D_VERTEX_STRIDE, swapChainFormat, 'always');
      this._skinnedShellClearPipeline   = this._mkShellClear(skOutlineLayout, skOutlineMod, 'vs',     skOutlineAttrs, SKINNED_MESH3D_VERTEX_STRIDE, swapChainFormat);
    }
  }

  /** Build a stencil-write pipeline (marks a mesh footprint into the stencil buffer, no colour). `depthCompare`
   *  'less-equal' marks only VISIBLE parts (depth-sorted outline); 'always' marks the full projected silhouette
   *  (on-top / "merge" outline). */
  private _mkStencil(layout: GPUPipelineLayout, module: GPUShaderModule, vsEntry: string, attrs: GPUVertexAttribute[], stride: number, format: GPUTextureFormat, depthCompare: GPUCompareFunction): PipelineHandle<GPURenderPipeline> {
    return this._pipes.render({
      layout,
      vertex: { module, entryPoint: vsEntry, buffers: [{ arrayStride: stride, attributes: attrs }] },
      fragment: { module, entryPoint: 'fs_stencil', targets: [{ format, writeMask: 0 }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare,
        stencilFront: { compare: 'always', failOp: 'keep', depthFailOp: 'keep', passOp: 'replace' },
        stencilBack:  { compare: 'always', failOp: 'keep', depthFailOp: 'keep', passOp: 'replace' },
      },
    });
  }

  /** Build an outline-draw pipeline (expanded shell, drawn where stencil != 1 → the rim). `depthCompare` matches
   *  the paired stencil pipeline: 'less-equal' = depth-sorted, 'always' = on-top ("merge"). */
  private _mkOutline(layout: GPUPipelineLayout, module: GPUShaderModule, vsEntry: string, attrs: GPUVertexAttribute[], stride: number, format: GPUTextureFormat, depthCompare: GPUCompareFunction, depthWrite = false): PipelineHandle<GPURenderPipeline> {
    return this._pipes.render({
      layout,
      vertex: { module, entryPoint: vsEntry, buffers: [{ arrayStride: stride, attributes: attrs }] },
      fragment: { module, entryPoint: 'fs', targets: [{
        format,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: {
        format: 'depth24plus-stencil8',
        // NO depth write here. This helper builds the SKINNED outlines (drawn LAST in the frame, so they don't need
        // to leave depth for a later pass) and the on-top/merge variants (pure overlays). Writing depth here caused
        // a character's UNION outline — the overlapping expanded shells of body + dress + many hair cards — to
        // z-fight, showing as translucent/ghosted streaks. With write off, overlapping opaque shells resolve to the
        // topmost cleanly. (Only the depth-SORTED REGULAR outline writes depth — inline above — because it's drawn
        // BEFORE the skinned pass and must occlude it.)
        depthWriteEnabled: depthWrite,
        depthCompare,
        // DRAW-ONCE: a band pixel that passes writes the reference (1), so every later shell over the same pixel fails
        // `not-equal 1`. Without it, a character's overlapping part shells (sleeve over torso, both trouser legs, hair
        // over shoulders) each blended the band again — with a translucent colour that stacked into uneven grey/white
        // layers instead of one solid band (2026-09-28). The shell-clear pass resets these pixels afterwards.
        stencilFront: { compare: 'not-equal', failOp: 'keep', depthFailOp: 'keep', passOp: 'replace' },
        stencilBack:  { compare: 'not-equal', failOp: 'keep', depthFailOp: 'keep', passOp: 'replace' },
      },
    });
  }

  /** The SHELL-CLEAR pipeline: the outline's expanded shell again, no colour, stencil ALWAYS → reference (0), depth
   *  ignored — resets every stencil pixel a draw-once outline wrote. Same VS/FS as the outline, so it covers exactly
   *  the fragments the outline could have written. */
  private _mkShellClear(layout: GPUPipelineLayout, module: GPUShaderModule, vsEntry: string, attrs: GPUVertexAttribute[], stride: number, format: GPUTextureFormat): PipelineHandle<GPURenderPipeline> {
    return this._pipes.render({
      layout,
      vertex: { module, entryPoint: vsEntry, buffers: [{ arrayStride: stride, attributes: attrs }] },
      fragment: { module, entryPoint: 'fs', targets: [{ format, writeMask: 0 }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: {
        format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'always',
        stencilFront: { compare: 'always', failOp: 'keep', depthFailOp: 'keep', passOp: 'replace' },
        stencilBack:  { compare: 'always', failOp: 'keep', depthFailOp: 'keep', passOp: 'replace' },
      },
    });
  }

  /**
   * Write the full style + per-frame screen data for hover (slot 0) or selection (slot 1). Call BEFORE the render
   * pass begins so both writes are enqueued before submit. `resX/resY` = render-target px, `time` = seconds (for the
   * pattern scroll — pass 0 for a static/flat slot).
   */
  writeParams(slot: 'hover' | 'select', style: HighlightStyle, resX: number, resY: number, time: number): void {
    const buf = slot === 'hover' ? this._hoverBuf : this._selectBuf;
    const c = style.color, pc = style.patternColor;
    const data = new Float32Array([
      c[0], c[1], c[2], c[3],                                   // color
      pc[0], pc[1], pc[2], style.glow,                          // patternColor + glow
      style.width, style.patternMode, style.freq, style.speed, // params
      resX, resY, time, 0,                                     // screen
      style.wobble ?? 0, style.wobbleFreq ?? 10, style.boilFps ?? 10, 0,   // boil (0 wobble = even line)
    ]);
    this.device.queue.writeBuffer(buf, 0, data);
  }

  /** Grow a per-object param pool (buffers + bind groups) to at least `n` entries. */
  private _ensurePool(bufs: GPUBuffer[], bgs: GPUBindGroup[], n: number): void {
    while (bufs.length < n) {
      const buf = this.device.createBuffer({ size: PARAMS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      bufs.push(buf);
      bgs.push(this.device.createBindGroup({ layout: this._paramsBGL, entries: [{ binding: 0, resource: { buffer: buf } }] }));
    }
  }

  /** Pack one HighlightStyle into the 20-float HighlightParams layout (same as writeParams). */
  private _packStyle(style: HighlightStyle, resX: number, resY: number, time: number): Float32Array {
    const c = style.color, pc = style.patternColor;
    return new Float32Array([
      c[0], c[1], c[2], c[3],
      pc[0], pc[1], pc[2], style.glow,
      style.width, style.patternMode, style.freq, style.speed,
      resX, resY, time, 0,
      style.wobble ?? 0, style.wobbleFreq ?? 10, style.boilFps ?? 10, 0,   // boil (0 wobble = even line)
    ]);
  }

  /** Write one CUSTOM outline slot (persistent per-object outlines, regular meshes). Grows the pool as needed.
   *  Pair with drawCustom using the same `index`; call while recording, once per index per submit. */
  writeCustomParams(index: number, style: HighlightStyle, resX: number, resY: number, time: number): void {
    this._ensurePool(this._customBufs, this._customBGs, index + 1);
    this.device.queue.writeBuffer(this._customBufs[index], 0, this._packStyle(style, resX, resY, time));
  }

  /** Write one SKINNED custom outline slot (separate pool from writeCustomParams — see the pool comment). */
  writeCustomParamsSkinned(index: number, style: HighlightStyle, resX: number, resY: number, time: number): void {
    this._ensurePool(this._customBufsSk, this._customBGsSk, index + 1);
    this.device.queue.writeBuffer(this._customBufsSk[index], 0, this._packStyle(style, resX, resY, time));
  }

  /** Draw persistent per-object outlines. Each entry carries its own `paramIndex` (written via writeCustomParams),
   *  so every mesh gets its own style. The 3 stencil steps are INTERLEAVED per mesh (write→outline→clear) so each
   *  mesh's stencil footprint is isolated and its own params apply. */
  drawCustom(
    pass:          GPURenderPassEncoder,
    meshBindGroup: GPUBindGroup,
    entries:       { entry: HighlightMeshEntry; paramIndices: number[]; onTop?: boolean }[],
  ): void {
    // Per-DRAW readiness (bug-hunt 2026-10-01 D-R4): only the pipelines THIS method draws with — one failed variant
    // (e.g. skinned) used to disable every hover/select outline for the session via the all-or-nothing ready().
    if (entries.length === 0 || !MeshHighlightPass._readyAll(this._stencilPipelineOnTop, this._outlinePipelineOnTop,
      this._customOutlinePipeline ?? this._outlinePipeline, this._shellClearPipeline)) return;   // stencil steps must pair up
    for (const { entry: e, paramIndices, onTop } of entries) {
      // One param slot per LAYER (the outline + any stacked rings, inner → outer, cumulative shell widths).
      const bgs = paramIndices.map((i) => this._customBGs[i]).filter((b): b is GPUBindGroup => !!b);
      if (bgs.length === 0) continue;
      // Mask ALWAYS uses the depth-independent stencil so the full silhouette is marked (a partially-occluded mesh
      // then gets a clean rim, not a filled shell). Only the OUTLINE draw's depth mode follows the merge flag.
      const stencilPipe = this._pipeFor(this._stencilPipelineOnTop!, e);
      const outlinePipe = this._pipeFor(onTop ? this._outlinePipelineOnTop! : (this._customOutlinePipeline ?? this._outlinePipeline), e);
      const clearPipe = this._shellClearPipeline ? this._pipeFor(this._shellClearPipeline, e) : null;
      if (!stencilPipe || !outlinePipe || (this._shellClearPipeline && !clearPipe)) continue;   // (P22: a packed twin still compiling)
      const ixf: GPUIndexFormat = e.pk ? 'uint16' : 'uint32';
      // 1. stencil write (ref=1) — mark this mesh's footprint
      pass.setPipeline(stencilPipe);
      pass.setBindGroup(0, meshBindGroup);
      pass.setStencilReference(1);
      pass.setVertexBuffer(0, e.vertex);
      pass.setIndexBuffer(e.index, ixf);
      pass.drawIndexed(e.indexCount, 1, e.firstIndex, e.baseVertex, e.instanceIdx);
      // 2. outline draw (ref=1), one pass per layer INNER → OUTER. Draw-once stencil: each layer's (wider) shell only
      //    fills pixels no inner layer took → stacked rings (a red outline, then a white ring around it).
      pass.setPipeline(outlinePipe);
      pass.setBindGroup(0, meshBindGroup);
      pass.setStencilReference(1);
      pass.setVertexBuffer(0, e.vertex);
      pass.setIndexBuffer(e.index, ixf);
      for (const bg of bgs) {
        pass.setBindGroup(1, bg);
        pass.drawIndexed(e.indexCount, 1, e.firstIndex, e.baseVertex, e.instanceIdx);
      }
      // 3a. shell clear (ref=0) — reset the band pixels every layer marked
      if (clearPipe) {
        pass.setPipeline(clearPipe);
        pass.setBindGroup(0, meshBindGroup);
        pass.setStencilReference(0);
        pass.setVertexBuffer(0, e.vertex);
        pass.setIndexBuffer(e.index, ixf);
        for (const bg of bgs) {
          pass.setBindGroup(1, bg);
          pass.drawIndexed(e.indexCount, 1, e.firstIndex, e.baseVertex, e.instanceIdx);
        }
      }
      // 3. stencil clear (ref=0) — reset for the next mesh
      pass.setPipeline(stencilPipe);
      pass.setBindGroup(0, meshBindGroup);
      pass.setStencilReference(0);
      pass.setVertexBuffer(0, e.vertex);
      pass.setIndexBuffer(e.index, ixf);
      pass.drawIndexed(e.indexCount, 1, e.firstIndex, e.baseVertex, e.instanceIdx);
    }
  }

  /** True when the skinned outline pipelines are available (a skin BGL was supplied at construction). */
  /** P2: true once every highlight pipeline compiled (requests pending ones). Draws are skipped until then. */
  ready(): boolean { return this._pipes.ready(); }

  /** True when every given (non-null) pipeline is compiled — requests any that aren't. Null = not used. */
  private static _readyAll(...hs: (PipelineHandle<GPURenderPipeline> | null)[]): boolean {
    let ok = true;
    for (const h of hs) if (h && !h.get()) ok = false;
    return ok;
  }

  get supportsSkinned(): boolean { return this._skinnedOutlinePipeline !== null; }

  /** Draw ONE outline around a GROUP of skinned parts (a character = body + hair + clothes, all sharing a skeleton)
   *  as a single UNION silhouette. Three batched steps: (1) stencil-write EVERY part with the depth-INDEPENDENT
   *  ('always') stencil so the union covers parts occluded by sibling parts (else the body under the clothes isn't
   *  masked and its shell fills instead of rimming); (2) draw the outline shell of every part where stencil != 1 —
   *  a single rim around the whole character (depthCompare 'less-equal' so it still depth-sorts vs OTHER objects, or
   *  'always' when `onTop`/merge); (3) clear the stencil for every part. `paramIndex` selects the style buffer. A
   *  group of one behaves like a normal single-mesh outline (and the 'always' stencil also fixes a lone partially-
   *  occluded skinned mesh's fill). */
  drawSkinnedGroupOutline(
    pass:          GPURenderPassEncoder,
    skinnedMeshBG: GPUBindGroup,
    parts:         { vb: GPUBuffer; ib: GPUBuffer; indexCount: number; instanceSlot: number; skinBG: GPUBindGroup; texBG: GPUBindGroup }[],
    paramIndices:  number[],
    onTop:         boolean,
  ): void {
    if (parts.length === 0 || !this._skinnedStencilPipelineOnTop || !this._skinnedOutlinePipeline) return;
    if (!MeshHighlightPass._readyAll(this._skinnedStencilPipelineOnTop, onTop ? this._skinnedOutlinePipelineOnTop : this._skinnedOutlinePipeline,
      this._skinnedShellClearPipeline)) return;   // per-draw readiness (D-R4)
    const bgs = paramIndices.map((i) => this._customBGsSk[i]).filter((b): b is GPUBindGroup => !!b);   // layers inner → outer
    if (bgs.length === 0) return;
    const outlinePipe = (onTop ? this._skinnedOutlinePipelineOnTop! : this._skinnedOutlinePipeline).get()!;
    const drawPart = (p: { vb: GPUBuffer; ib: GPUBuffer; indexCount: number; instanceSlot: number; skinBG: GPUBindGroup; texBG: GPUBindGroup }) => {
      pass.setBindGroup(1, p.skinBG);
      pass.setVertexBuffer(0, p.vb);
      pass.setIndexBuffer(p.ib, 'uint32');
      pass.drawIndexed(p.indexCount, 1, 0, 0, p.instanceSlot);
    };
    // 1. stencil-write ALL parts (depth-independent → union silhouette). The stencil pipeline alpha-tests via the
    //    part's diffuse texture (group 2), so alpha-cutout hair marks its VISIBLE shape, not the full card quad.
    pass.setPipeline(this._skinnedStencilPipelineOnTop.get()!);
    pass.setBindGroup(0, skinnedMeshBG);
    pass.setStencilReference(1);
    for (const p of parts) { pass.setBindGroup(2, p.texBG); drawPart(p); }
    // 2. outline-draw ALL parts, one pass per LAYER inner → outer (draw-once: overlapping part shells don't stack, and
    //    each outer ring only fills beyond the rings inside it)
    pass.setPipeline(outlinePipe);
    pass.setBindGroup(0, skinnedMeshBG);
    pass.setStencilReference(1);
    for (const bg of bgs) { pass.setBindGroup(2, bg); for (const p of parts) drawPart(p); }
    // 2b. shell clear — reset the band pixels every layer marked
    if (this._skinnedShellClearPipeline) {
      pass.setPipeline(this._skinnedShellClearPipeline.get()!);
      pass.setBindGroup(0, skinnedMeshBG);
      pass.setStencilReference(0);
      for (const bg of bgs) { pass.setBindGroup(2, bg); for (const p of parts) drawPart(p); }
    }
    // 3. clear the stencil for ALL parts (same alpha-tested stencil pipeline → group 2 = texture again)
    pass.setPipeline(this._skinnedStencilPipelineOnTop.get()!);
    pass.setBindGroup(0, skinnedMeshBG);
    pass.setStencilReference(0);
    for (const p of parts) { pass.setBindGroup(2, p.texBG); drawPart(p); }
  }

  /**
   * Record highlight draw calls into the given render pass.
   *
   * Three steps per slot:
   *  1. Stencil write (ref=1)  — mark mesh footprint
   *  2. Outline draw (ref=1)   — draw ring where stencil=0
   *  3. Stencil clear (ref=0)  — reset stencil for subsequent slots
   */
  draw(
    pass:          GPURenderPassEncoder,
    meshBindGroup: GPUBindGroup,
    slot:          'hover' | 'select',
    entries:       HighlightMeshEntry[],
  ): void {
    if (entries.length === 0 || !MeshHighlightPass._readyAll(this._stencilPipeline, this._outlinePipeline)) return;   // P2 + D-R4: per-draw readiness

    const paramsBG = slot === 'hover' ? this._hoverBG : this._selectBG;

    // (P22: a packed entry draws with the stride-32 twin + 16-bit indices; one whose twins are still compiling is left out)
    const drawAll = (h: PipelineHandle<GPURenderPipeline>): void => {
      let cur: GPURenderPipeline | null = null;
      for (const e of entries) {
        if (e.pk && (!this._pipeFor(this._stencilPipeline, e) || !this._pipeFor(this._outlinePipeline, e))) continue;
        const p = this._pipeFor(h, e);
        if (!p) continue;
        if (p !== cur) { pass.setPipeline(p); cur = p; }
        pass.setVertexBuffer(0, e.vertex);
        pass.setIndexBuffer(e.index, e.pk ? 'uint16' : 'uint32');
        pass.drawIndexed(e.indexCount, 1, e.firstIndex, e.baseVertex, e.instanceIdx);
      }
    };

    // Step 1: write stencil=1 for the mesh footprint
    pass.setBindGroup(0, meshBindGroup);
    pass.setStencilReference(1);
    drawAll(this._stencilPipeline);

    // Step 2: draw expanded outline where stencil!=1 (outside silhouette)
    pass.setBindGroup(0, meshBindGroup);
    pass.setBindGroup(1, paramsBG);
    pass.setStencilReference(1);
    drawAll(this._outlinePipeline);

    // Step 3: clear stencil back to 0 so the next slot starts clean
    pass.setBindGroup(0, meshBindGroup);
    pass.setStencilReference(0);
    drawAll(this._stencilPipeline);
  }

  destroy(): void {
    this._hoverBuf.destroy();
    this._selectBuf.destroy();
    for (const b of this._customBufs) b.destroy();
    for (const b of this._customBufsSk) b.destroy();
    this._customBufs.length = 0; this._customBGs.length = 0;
    this._customBufsSk.length = 0; this._customBGsSk.length = 0;
  }
}

// TODO: collision test marker (Planetarium) — safe to remove.
