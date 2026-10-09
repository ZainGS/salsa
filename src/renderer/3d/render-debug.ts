/**
 * RENDER DEBUG switches (docs/ui/gpu-diagnostics.md "Render debug"; docs/specs/mobile-parity.md 7.1 RENDER-1).
 *
 * A per-machine set of bisect switches: each one skips ONE pass or feature of the 3D frame (or forces a diagnostic
 * mode), so a tester on a device whose GPU shows a glitch the desktop cannot reproduce can switch passes off one at a
 * time and see when the glitch stops. Every flag defaults OFF, and while all are off `RD.on` is false: every check in
 * the renderer is `RD.on && RD.f.x`, a single property read, so the frame is exactly the normal one.
 *
 * The set is kept in localStorage (`salsa.renderDebug`) so it survives the reloads a tablet test needs, and is
 * removed when everything is switched off again (setRenderDebug({ reset: true })). A stored set logs a warning at
 * start-up so it is never left on by accident.
 */

/** The switches. A type alias (not an interface) so hosts can treat it as a plain string-to-boolean record. */
export type RenderDebugFlags = {
  /** Skip the stencil-ring mesh highlights: hover / source-link select highlight, per-object outlines incl. the
   *  merged (union) outline, skinned character outlines. */
  noHighlight: boolean;
  /** Skip the screen-space silhouette (hover) outline (mask pass + composite) and the sprite alpha outlines. */
  noSilhouetteOutline: boolean;
  /** Skip the screen-space (Sobel) outline COMPOSITE; its depth + normal prepass still runs. */
  noOutlinePass: boolean;
  /** Skip the outline depth + normal camera prepass and the Sobel + composite that read it. */
  noDepthPrepass: boolean;
  /** Skip the mesh-edit / UV-paint / surface-paint overlays (wireframe, handles, face highlight, the 'dim' layer). */
  noMeshEditOverlays: boolean;
  /** Skip the selection box + transform gizmo, bone overlay, snap viz, emitter icons, camera frustum, artboard frame,
   *  Array-tool face handles. */
  noGizmo: boolean;
  /** Hide the view (navigation) gizmo: a separate 2D canvas over the WebGPU canvas. */
  noViewGizmo: boolean;
  /** Skip the 3D ground grid and the 2D canvas grid overlay. */
  noGrid: boolean;
  /** Skip the 3D focus background (armature / mesh-edit "wavy" bg, scene bg) and its after-post restore. */
  noBackground3D: boolean;
  /** Skip the scene post-processing (bloom / grade / vignette / film). */
  noPost: boolean;
  /** Skip FXAA. */
  noFxaa: boolean;
  /** Skip the scene-colour grab copy (refraction / SSR / modal-blur source); meshes sample a 1x1 dummy instead. (With no
   *  reader on, the grab is already skipped automatically — perf audit B2.) */
  noSceneGrab: boolean;
  /** Draw the frame straight into the canvas (swap-chain) texture: no lastFrameTex, no copy. Implies no post, no FXAA,
   *  no grab; thumbnails taken from live frames go stale while it is on. */
  directToSwapchain: boolean;
  /** Turn OFF the automatic direct present (perf audit C1 + C2, WebGPURenderer.directPresent): every frame renders into
   *  lastFrameTex and is copied (or post-processed into its own texture and copied) to the canvas — the old path. */
  noDirectPresent: boolean;
  /** Force the resolution scale to 1 and TAA off: 3D renders at native resolution, so no lo-res target, upscale blit or
   *  depth upsample (resolution scaling incl. its auto mode, TAA and the PS1 lo-res look are bypassed). */
  forceFullRes: boolean;
  /** Skip the PostBgKeep pass (the depth-equal restore of the unprocessed focus background after post). */
  noPostBgKeep: boolean;
  /** Configure the canvas with alphaMode 'opaque' (the compositor ignores the alpha the frame stores). */
  forceOpaqueAlpha: boolean;
  /** Skip the mesh-edit rear-edge stipple (the depth 'greater' hidden-edge lines), separate from the other overlays. */
  noRearEdges: boolean;
  /** Mesh fragment shader: clamp the texture-array layer indices (diffuse, normal map, GARP) to the bound layer count. */
  clampTexLayers: boolean;
  /** Draw the overlay set (gizmos, grid, handles, 2D selection UI) inside the main pass, so no second pass loads the
   *  colour / depth / stencil attachments. Automatic whenever no grab reader (SSR / glass / modal blur) is on (perf
   *  audit B1); this flag forces it even with one on (the overlays then show in reflections / refraction). */
  inlineOverlays: boolean;
  /** Mesh fragment shader: no lighting (base colour x texture only; no shadows, IBL, SSAO, fog). */
  noLighting: boolean;
  /** Mesh fragment shader: no texture fetches at all; output the constant material colour. */
  noTextures: boolean;
  /** Mesh fragment shader: solid magenta. Garbage that remains is geometry / depth / raster, not shading. */
  solidMesh: boolean;
  /** Mesh fragment shader: solid mid grey (0.5, 0.5, 0.5). With solidWhite: does the remaining garbage depend on the
   *  colour value (rainbow on grey but not on magenta = per-channel noise that clips away at 0 / 1)? */
  solidGrey: boolean;
  /** Mesh fragment shader: solid white (1, 1, 1). */
  solidWhite: boolean;
  /** Mesh fragment shader: the flat per-object (instance) index as a colour; one solid colour per object when healthy,
   *  red where the index is past the end of the instance buffer. */
  dbgInstanceIndex: boolean;
  /** Mesh fragment shader: the FIRST object's colour, read with a constant index (tests the storage read itself). */
  dbgInstanceZero: boolean;
  /** Mesh fragment shader: the colour computed in the vertex stage (no fragment-side instance read). */
  dbgVertexColour: boolean;
  /** Mesh fragment shader: the interpolated world normal varying as a colour (n * 0.5 + 0.5, not renormalised). One
   *  flat colour per cube face when healthy; noise = the normal varying itself is bad (the lit path is the only reader
   *  of it, so noLighting cannot tell bad maths from a bad varying). */
  dbgNormal: boolean;
  /** Mesh fragment shader, lit path: paint NaN / Inf pixels bright GREEN and out-of-range ones (> 4 or < -0.01) bright
   *  CYAN. Tests the unclamped lit colour and the final colour; combines with every other switch. */
  dbgNanCheck: boolean;
  /** Mesh fragment shader, lit path: guard the operations whose result is undefined for some inputs (normalize of a
   *  zero vector, pow of a negative base, unit-vector dots past 1, a zero-width smoothstep) with defined
   *  equivalents. A fix CANDIDATE: off = today's maths exactly. */
  safeLightingMath: boolean;
  /** Mesh fragment shader (shadow-receiving pipelines): skip the sun-shadow receive (shadow multiplier 1). */
  noShadowReceive: boolean;
  /** Mesh fragment shader (shadow-receiving pipelines): output the raw shadow factor as grey; red = above 1,
   *  blue = below 0, green = NaN / Inf. */
  dbgShadowFactor: boolean;
  /** Mesh fragment shader: the material flag bits as a colour (green = rim, on dark blue). */
  dbgFlagBits: boolean;
  /** EVERY mesh / skinned-mesh fragment pipeline uses a ~15-line test shader (colour x simple lighting, same inputs)
   *  instead of its generated fragment shader. Read when a pipeline's module is created: RELOAD for the full effect.
   *  RENDER-1 test. (The phase-3 rollback switch noShaderSplit and the P21 forceShaderVariants test were removed with
   *  the uber shader in shader-split phase 4; a stored set naming them is ignored: unknown keys.) */
  tinyMeshFS: boolean;
  /** Every 3D pass that LOADS depth / stencil clears it instead (overlays lose depth occlusion). */
  clearDepthStencilLoads: boolean;
  /** Every 3D pass that LOADS colour clears it instead. Breaks the picture (an overlay pass wipes the scene); the point
   *  is only to see whether the garbage goes away. */
  clearColorLoads: boolean;
  /** 2D raster layers: composite every layer from scratch every frame (BRUSH-5 incremental compositing OFF — the
   *  pre-2026-10-09 default). The kill switch for a stale-layer / stale-cel symptom on a device. */
  noRasterDirtyCompositing: boolean;
};

export type RenderDebugKey = keyof RenderDebugFlags;

/** Display order + short labels (hosts may use these for their UI; the suggested bisect order, top to bottom). */
export const RENDER_DEBUG_FLAGS: ReadonlyArray<{ key: RenderDebugKey; label: string }> = [
  { key: 'forceFullRes', label: 'Force full resolution (no lo-res / TAA)' },
  { key: 'forceOpaqueAlpha', label: 'Opaque canvas alpha' },
  { key: 'solidMesh', label: 'Solid magenta meshes' },
  { key: 'solidGrey', label: 'Solid grey meshes' },
  { key: 'solidWhite', label: 'Solid white meshes' },
  { key: 'noTextures', label: 'No mesh textures (constant colour)' },
  { key: 'dbgInstanceIndex', label: 'Mesh colour = object index' },
  { key: 'dbgInstanceZero', label: 'Mesh colour = first object (fixed read)' },
  { key: 'dbgVertexColour', label: 'Mesh colour = vertex stage' },
  { key: 'dbgNormal', label: 'Mesh colour = world normal' },
  { key: 'clampTexLayers', label: 'Clamp texture layer indices' },
  { key: 'noLighting', label: 'No mesh lighting (unlit)' },
  { key: 'dbgNanCheck', label: 'Highlight NaN / Inf pixels' },
  { key: 'safeLightingMath', label: 'Safe lighting math' },
  { key: 'noShadowReceive', label: 'No shadow receive' },
  { key: 'dbgShadowFactor', label: 'Mesh colour = shadow factor' },
  { key: 'dbgFlagBits', label: 'Mesh colour = material flags (green = rim)' },
  { key: 'tinyMeshFS', label: 'Tiny mesh shader (test; reload)' },
  { key: 'noMeshEditOverlays', label: 'No mesh-edit / UV-paint overlays' },
  { key: 'noRearEdges', label: 'No mesh-edit rear edges' },
  { key: 'noBackground3D', label: 'No 3D background (focus bg)' },
  { key: 'noPostBgKeep', label: 'No PostBgKeep restore' },
  { key: 'noPost', label: 'No post-processing' },
  { key: 'noFxaa', label: 'No FXAA' },
  { key: 'noSceneGrab', label: 'No scene-colour grab' },
  { key: 'noHighlight', label: 'No highlight / union outline (stencil)' },
  { key: 'noSilhouetteOutline', label: 'No silhouette / sprite outlines' },
  { key: 'noOutlinePass', label: 'No screen-space outline' },
  { key: 'noDepthPrepass', label: 'No depth prepass' },
  { key: 'noGizmo', label: 'No gizmo / selection box' },
  { key: 'noViewGizmo', label: 'No view gizmo' },
  { key: 'noGrid', label: 'No grid' },
  { key: 'inlineOverlays', label: 'Overlays in the main pass' },
  { key: 'directToSwapchain', label: 'Draw straight to the canvas' },
  { key: 'noDirectPresent', label: 'Present via offscreen copy (old path)' },
  { key: 'noRasterDirtyCompositing', label: '2D layers: full composite every frame' },
  { key: 'clearDepthStencilLoads', label: 'Clear depth/stencil loads' },
  { key: 'clearColorLoads', label: 'Clear colour loads (breaks picture)' },
];

export const RENDER_DEBUG_STORAGE_KEY = 'salsa.renderDebug';

function allOff(): RenderDebugFlags {
  const f = {} as RenderDebugFlags;
  for (const { key } of RENDER_DEBUG_FLAGS) f[key] = false;
  return f;
}

/** The live state. `on` = at least one flag is set; the renderer reads `RD.on && RD.f.<flag>`. */
export const RD: { on: boolean; f: RenderDebugFlags } = { on: false, f: allOff() };

function recompute(): void {
  let on = false;
  for (const { key } of RENDER_DEBUG_FLAGS) if (RD.f[key]) { on = true; break; }
  RD.on = on;
}

function save(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (!RD.on) { localStorage.removeItem(RENDER_DEBUG_STORAGE_KEY); return; }
    const set: Partial<RenderDebugFlags> = {};
    for (const { key } of RENDER_DEBUG_FLAGS) if (RD.f[key]) set[key] = true;
    localStorage.setItem(RENDER_DEBUG_STORAGE_KEY, JSON.stringify(set));
  } catch { /* storage blocked: this session only */ }
}

/** Read the stored set (start-up). Unknown keys and non-true values are ignored. */
export function loadRenderDebug(): void {
  RD.f = allOff();
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(RENDER_DEBUG_STORAGE_KEY);
      if (raw) {
        const o = JSON.parse(raw) as Record<string, unknown>;
        for (const { key } of RENDER_DEBUG_FLAGS) if (o && o[key] === true) RD.f[key] = true;
      }
    }
  } catch { /* corrupt or blocked: all off */ }
  recompute();
  if (RD.on) {
    const set = RENDER_DEBUG_FLAGS.filter(({ key }) => RD.f[key]).map(({ key }) => key).join(', ');
    console.warn(`[Salsa][render-debug] ACTIVE from localStorage (${RENDER_DEBUG_STORAGE_KEY}): ${set}. sm.setRenderDebug3D({ reset: true }) clears it.`);
  }
}

/** Merge `patch` (known boolean keys only); `reset: true` first switches everything off. Persists; returns a copy. */
export function setRenderDebug(patch: Partial<RenderDebugFlags> & { reset?: boolean } = {}): RenderDebugFlags {
  if (patch.reset) RD.f = allOff();
  for (const { key } of RENDER_DEBUG_FLAGS) {
    const v = (patch as Record<string, unknown>)[key];
    if (typeof v === 'boolean') RD.f[key] = v;
  }
  recompute();
  save();
  return getRenderDebug();
}

export function getRenderDebug(): RenderDebugFlags { return { ...RD.f }; }

/** The mesh fragment shader debug mode (IBLUniforms.dbgShade): 0 = off, 1 = unlit, 2 = constant colour, 3 = magenta,
 *  4 = instance index colour, 5 = instance 0's colour, 6 = vertex-stage colour, 7 = solid grey, 8 = solid white,
 *  9 = world normal colour, 10 = material flag bits (green = rim). One mode at a time: the solid colours win, then the read tests, then unlit. */
export function renderDebugShadeMode(): number {
  if (!RD.on) return 0;
  const f = RD.f;
  return f.solidMesh ? 3 : f.solidWhite ? 8 : f.solidGrey ? 7
    : f.dbgInstanceIndex ? 4 : f.dbgInstanceZero ? 5 : f.dbgVertexColour ? 6 : f.dbgFlagBits ? 10 : f.dbgNormal ? 9
    : f.noTextures ? 2 : f.noLighting ? 1 : 0;
}

/** The mesh fragment shader debug bits (IBLUniforms.dbgFlags): 1 = clamp the texture-array layer indices,
 *  2 = NaN / Inf highlight (dbgNanCheck), 4 = safe lighting maths (safeLightingMath), 8 = no shadow receive,
 *  16 = shadow factor as colour. 32 / 64 are free (they were the sparkle switches; sparkle removed 2026-10-07). */
export function renderDebugShaderBits(): number {
  if (!RD.on) return 0;
  const f = RD.f;
  return (f.clampTexLayers ? 1 : 0) | (f.dbgNanCheck ? 2 : 0) | (f.safeLightingMath ? 4 : 0)
    | (f.noShadowReceive ? 8 : 0) | (f.dbgShadowFactor ? 16 : 0);
}

/** The canvas context alpha mode: 'premultiplied' (the default), 'opaque' under forceOpaqueAlpha. */
/** tinyMeshFS: the fragment shader code to compile for a mesh pipeline (the tiny test shader, or `code` unchanged). */
export function rdMeshFragmentCode(code: string, tiny: string): string { return RD.on && RD.f.tinyMeshFS ? tiny : code; }

export function rdCanvasAlphaMode(): GPUCanvasAlphaMode { return RD.on && RD.f.forceOpaqueAlpha ? 'opaque' : 'premultiplied'; }

/** The colour loadOp for a pass that normally loads: 'clear' under clearColorLoads. */
export function rdColorLoad(): GPULoadOp { return RD.on && RD.f.clearColorLoads ? 'clear' : 'load'; }
/** The depth / stencil loadOp for a pass that normally loads: 'clear' under clearDepthStencilLoads. */
export function rdDepthLoad(): GPULoadOp { return RD.on && RD.f.clearDepthStencilLoads ? 'clear' : 'load'; }

/** The real-screenshot result (ShapeManager.captureCanvasPNG3D). */
export interface RealScreenshot {
  blob: Blob;
  /** data:image/png;base64,... (for hosts that open it in a new tab). */
  dataUrl: string;
  width: number;
  height: number;
  /** Where the pixels were read: 'swapchain' = the canvas texture itself at the end of the frame (what the browser
   *  is handed to present); 'lastFrameTex' / 'postProcessOutput' = the texture the frame copied to the canvas. */
  source: 'swapchain' | 'lastFrameTex' | 'postProcessOutput';
  format: string;
  /** Pixels whose stored alpha was below 255 (the canvas is premultiplied-alpha; see `opaque`). */
  translucentPixels: number;
  /** The render-debug flags in force for this frame. */
  flags: RenderDebugFlags;
}

/** Encode raw premultiplied RGBA as PNG. `opaque` (default true) writes alpha 255 so the RGB the GPU stored is shown
 *  as-is (alpha garbage cannot hide colour garbage); false un-premultiplies and keeps the alpha. */
export async function encodeRealFramePNG(
  r: { rgba: Uint8ClampedArray; width: number; height: number }, opaque = true,
): Promise<{ blob: Blob; dataUrl: string; translucentPixels: number }> {
  const px = new Uint8ClampedArray(r.rgba);
  let translucent = 0;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a < 255) {
      translucent++;
      if (opaque) px[i + 3] = 255;
      else if (a > 0) { const k = 255 / a; px[i] = px[i] * k; px[i + 1] = px[i + 1] * k; px[i + 2] = px[i + 2] * k; }
    }
  }
  const img = new ImageData(px, r.width, r.height);
  let blob: Blob;
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(r.width, r.height);
    c.getContext('2d')!.putImageData(img, 0, 0);
    blob = await c.convertToBlob({ type: 'image/png' });
  } else {
    const c = Object.assign(document.createElement('canvas'), { width: r.width, height: r.height });
    c.getContext('2d')!.putImageData(img, 0, 0);
    blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
  }
  const dataUrl = await new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(fr.error ?? new Error('FileReader failed'));
    fr.readAsDataURL(blob);
  });
  return { blob, dataUrl, translucentPixels: translucent };
}

loadRenderDebug();
