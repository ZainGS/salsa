# Salsa Viewer — Embeddable Web Component
**Last Updated:** 2026-05-10  

**Date:** 2026-05-07  
**Status:** ✅ Complete (all phases shipped 2026-05-10)  
**Goal:** A self-contained `<salsa-viewer url="...">` custom element that loads and renders a `.frogmarks` scene with no Angular dependency, embeddable in any HTML page like Spline's `<spline-viewer>`.

---

## What exists today (the foundation)

Before touching anything, be aware of what already works:

| Piece | File | Status |
|-------|------|--------|
| `.frogmarks` ZIP format | `src/services/persistence/project-package.ts` | ✅ done |
| `unpackProject(blob)` | same file | ✅ done |
| `Renderer3D` — 3D mesh/particle draw | `src/renderer/3d/renderer-3d.ts` | ✅ standalone |
| `WebGPURenderer` — canvas, device, render loop | `src/renderer/core/webgpu-renderer.ts` | ✅ but coupled to editing |
| Scene node types (Mesh3D, Particle, etc.) | `src/scene-graph/shapes/` | ✅ done |
| `recreateNode()` | `src/services/shape-manager.ts` line ~4721 | ✅ but inside ShapeManager |
| `setSceneGraphJSON()` | `src/services/shape-manager.ts` line ~4469 | ✅ but inside ShapeManager |

**The gap:** `WebGPURenderer` constructor requires `InteractionService` and registers pointer/keyboard listeners. `ShapeManager` (which owns the load path) imports ~30 editing services. Neither can be instantiated in a self-contained viewer bundle without dragging in the entire editing stack.

---

## Architecture overview

```
<salsa-viewer url="...">
      │
      ▼
SalsaViewerElement  (src/viewer/salsa-viewer-element.ts)
  Custom Element — owns the shadow DOM canvas, ResizeObserver,
  URL attribute watching, load lifecycle.
      │
      ▼
SalsaViewerCore  (src/viewer/salsa-viewer-core.ts)
  Framework-free class. Owns:
    - WebGPU device init
    - ViewerWebGPURenderer (viewer-mode subset of WebGPURenderer)
    - SceneGraph
    - Renderer3D (already standalone)
    - RasterCompositor (for raster layers)
    - TextureLibrary (for mesh textures)
    - ViewerSceneDeserializer (load path without editing services)
    - rAF render loop
      │
      ▼
ViewerSceneDeserializer  (src/viewer/scene-deserializer.ts)
  Standalone recreateNode() that handles viewer-relevant node types.
  No ShapeManager, no drawing services, no InteractionService.
```

**Build output:** `viewer.js` — single ES module bundle, built via a separate Vite config.

---

## New files to create

### 1. `src/viewer/scene-deserializer.ts`

A self-contained version of `recreateNode()` + `updateSceneGraph()` that only handles nodes needed for rendering (not editing). This is the most important piece — it breaks the dependency on ShapeManager.

```typescript
import { Node } from '../scene-graph/shapes/base/node';
import { Shape } from '../scene-graph/shapes/base/shape';
import { Mesh3D } from '../scene-graph/shapes/mesh-3d';
import { MeshGroup3D } from '../scene-graph/shapes/mesh-group-3d';
import { ParticleEmitter3D } from '../scene-graph/shapes/particle-emitter-3d';
import { ClothMesh3D } from '../scene-graph/shapes/cloth-mesh-3d';
// ... other renderable nodes as needed

export class ViewerSceneDeserializer {
  // Minimal stub InteractionService (no-op implementations)
  // needed because node constructors accept it, but viewer never calls
  // any interaction methods.
  private readonly _stubInteraction = createStubInteractionService();

  recreateNode(data: any): Node {
    let node: Node;
    switch (data.type) {
      case '3DMesh': {
        // Same logic as ShapeManager.recreateNode case '3DMesh'
        // Lines 4948–4975 of shape-manager.ts
        break;
      }
      case '3DMeshGroup': {
        // Same logic as ShapeManager.recreateNode case '3DMeshGroup'
        // Lines 4977–4985 of shape-manager.ts
        break;
      }
      case 'ParticleEmitter3D': {
        // Same logic as ShapeManager.recreateNode case 'ParticleEmitter3D'
        // Lines 5012–5022 of shape-manager.ts
        break;
      }
      // Add Rectangle, Line, Text, etc. if the viewer needs to show vector shapes.
      // For a 3D-only viewer, the above three are sufficient.
      default:
        node = new Node();
        break;
    }
    // Apply common props (name, x, y, scaleX, scaleY, rotation, visible, zIndex)
    // Same lines 5024–5044 of shape-manager.ts
    return node;
  }

  buildSceneGraph(root: Node, data: any): void {
    // Same logic as ShapeManager.updateSceneGraph()
    // Lines 4696–4720 of shape-manager.ts
    // Walk data.children recursively, call recreateNode(), addChild()
  }
}

// No-op InteractionService stub — satisfies the constructor contract
// but fires no events and holds no state.
function createStubInteractionService(): InteractionService {
  // Return an object with all required properties set to no-ops or
  // empty EventEmitter instances. Do NOT import the full InteractionService
  // class — that pulls in too much. Build a plain object that satisfies
  // the interface/structural type.
  return {
    selectedNodes: new Set(),
    onSceneGraphChanged: { subscribe: () => {} },
    onRequestRender: { subscribe: () => {} },
    onBeginInteractive: { subscribe: () => {} },
    onEndInteractive: { subscribe: () => {} },
    onRequestBackgroundRender: { subscribe: () => {} },
    // ... all other required properties as stubs
  } as unknown as InteractionService;
}
```

**Implementation note on the stub:** Check `src/services/interaction-service.ts` for all required fields. The stub only needs to satisfy the TypeScript structural type — no methods will ever be called in viewer mode.

---

### 2. `src/viewer/salsa-viewer-core.ts`

The main viewer class. Does NOT extend `WebGPURenderer` — it instantiates a minimal renderer inline. This avoids the editing pointer-event handlers.

```typescript
import { SceneGraph } from '../scene-graph/core/scene-graph';
import { Renderer3D } from '../renderer/3d/renderer-3d';
import { Camera3D } from '../renderer/3d/camera-3d';
import { TextureLibrary } from '../services/texture-library';
import { RasterCompositor } from '../renderer/raster/core/raster-compositor';
import { unpackProject } from '../services/persistence/project-package';
import { ViewerSceneDeserializer } from './scene-deserializer';
import { ParticleEmitter3D } from '../scene-graph/shapes/particle-emitter-3d';
import { Mesh3D } from '../scene-graph/shapes/mesh-3d';

export class SalsaViewerCore {
  private canvas: HTMLCanvasElement;
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private renderer3D!: Renderer3D;
  private rasterCompositor!: RasterCompositor;
  private sceneGraph = new SceneGraph();
  private textureLib = new TextureLibrary();
  private deserializer = new ViewerSceneDeserializer();
  private _rafId: number | null = null;
  private _preRenderCallbacks: Array<() => boolean> = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  async init(): Promise<boolean> {
    // 1. Request WebGPU adapter + device
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return false;
    this.device = await adapter.requestDevice();

    // 2. Configure swap chain
    this.context = this.canvas.getContext('webgpu') as GPUCanvasContext;
    const format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format, alphaMode: 'premultiplied' });

    // 3. Create Renderer3D with a default camera
    const cam = new Camera3D();
    cam.lookAt(0, 0, 5, 0, 0, 0);
    this.renderer3D = new Renderer3D(this.device, cam, format);

    // 4. Create RasterCompositor
    this.rasterCompositor = new RasterCompositor(this.device);

    return true;
  }

  async loadUrl(url: string): Promise<void> {
    const blob = await fetch(url).then(r => {
      if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
      return r.blob();
    });
    await this.loadBlob(blob);
  }

  async loadBlob(blob: Blob): Promise<void> {
    const data = await unpackProject(blob);

    // 1. Clear existing scene
    this.sceneGraph.root.children.forEach(c => this.sceneGraph.root.removeChild(c));

    // 2. Restore texture library (uploads GPU textures)
    if (data.textureLibrary) {
      await this.textureLib.restoreFromJSON(data.textureLibrary, this.device);
    }

    // 3. Rebuild scene graph from JSON
    if (data.docPayload.sceneGraphJSON) {
      const parsed = JSON.parse(data.docPayload.sceneGraphJSON);
      this.deserializer.buildSceneGraph(this.sceneGraph.root, parsed.root);
    }

    // 4. Restore particle emitter tick callbacks
    // (same post-pass as setSceneGraphJSON in shape-manager.ts lines 4498–4502)
    for (const child of this.sceneGraph.root.children) {
      if (child instanceof ParticleEmitter3D) {
        this._registerParticleTick(child);
      }
    }

    // 5. Load raster layer pixel data from docPayload.layers
    // (restore GPU textures from bin data via rasterCompositor)
    await this._restoreRasterLayers(data);

    // 6. Restore GLTF meshes from models3d buffers
    await this._restoreGltfMeshes(data);

    // 7. Apply TextureLibrary textures to meshes
    // (same as scene3d.restoreTextureLibraryData in scene3d-manager.ts)
    this._applyTextureLibraryToMeshes();

    this.scheduleRender();
  }

  resize(): void {
    const dpr = window.devicePixelRatio ?? 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width  = Math.round(rect.width  * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.scheduleRender();
  }

  scheduleRender(): void {
    if (this._rafId != null) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._render();
    });
  }

  addPreRenderCallback(cb: () => boolean): void {
    this._preRenderCallbacks.push(cb);
  }

  removePreRenderCallback(cb: () => boolean): void {
    const i = this._preRenderCallbacks.indexOf(cb);
    if (i >= 0) this._preRenderCallbacks.splice(i, 1);
  }

  destroy(): void {
    if (this._rafId != null) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    this.renderer3D.destroy();
    this.textureLib.destroy();
    this.device.destroy();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _render(): void {
    // Run pre-render callbacks (particle tick, orbit damping, etc.)
    this._preRenderCallbacks = this._preRenderCallbacks.filter(cb => cb());

    const w = this.canvas.width;
    const h = this.canvas.height;
    const swapChainTex = this.context.getCurrentTexture();
    const view = swapChainTex.createView();

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: /* create/cache depth texture */ undefined,
    });

    // Draw 3D meshes
    const meshes = this._collectMeshes();
    const particles = this._collectParticles();
    if (meshes.length > 0 || particles.length > 0) {
      this.renderer3D.drawMeshes(pass, meshes, w, h);
      this.renderer3D.drawParticles(pass, particles, w, h);
    }

    // Composite raster layers
    // (call rasterCompositor.composite() if layers are loaded)
    this._compositeRasterLayers(pass, encoder, w, h);

    pass.end();
    this.device.queue.submit([encoder.finish()]);

    // Schedule next frame if pre-render callbacks are still running
    if (this._preRenderCallbacks.length > 0) {
      this.scheduleRender();
    }
  }

  private _collectMeshes(): Mesh3D[] {
    const out: Mesh3D[] = [];
    for (const node of this.sceneGraph.root.children) {
      if (node instanceof Mesh3D) out.push(node);
    }
    return out;
  }

  private _collectParticles(): ParticleEmitter3D[] {
    const out: ParticleEmitter3D[] = [];
    for (const node of this.sceneGraph.root.children) {
      if (node instanceof ParticleEmitter3D) out.push(node);
    }
    return out;
  }

  private _particleTickCb: (() => boolean) | null = null;

  private _registerParticleTick(emitter: ParticleEmitter3D): void {
    // Same pattern as Scene3DManager._ensureParticleTick()
    if (this._particleTickCb) return;
    let lastTime = performance.now();
    this._particleTickCb = () => {
      const now = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      for (const node of this.sceneGraph.root.children) {
        if (node instanceof ParticleEmitter3D) node.tick(dt);
      }
      return true; // keep ticking as long as viewer is alive
    };
    this.addPreRenderCallback(this._particleTickCb);
    this.scheduleRender();
  }

  private async _restoreRasterLayers(_data: any): Promise<void> {
    // TODO: upload layer bin data to GPU textures via rasterCompositor
    // Reference: DocumentPersistence.restoreDocumentState() in document-persistence.ts
    // and ShapeManager lines ~6258–6293
  }

  private async _restoreGltfMeshes(_data: any): Promise<void> {
    // TODO: re-import GLB buffers from data.models3d using parseGLB() from gltf-importer.ts
    // and set geometry on the matching Mesh3D nodes
    // Reference: Scene3DManager.restoreMeshState() and importGltfBuffer()
  }

  private _applyTextureLibraryToMeshes(): void {
    // TODO: iterate mesh nodes, look up textureLibraryId in textureLib,
    // assign mesh.diffuseTexture
    // Reference: Scene3DManager.restoreTextureLibraryData()
  }

  private _compositeRasterLayers(
    _pass: GPURenderPassEncoder,
    _encoder: GPUCommandEncoder,
    _w: number,
    _h: number,
  ): void {
    // TODO: composite raster layers into the swap chain using rasterCompositor
    // Reference: WebGPURenderer draw3DRasterBG / draw3DRasterFG around line 2742
  }
}
```

**Important:** The `// TODO` blocks are the implementation work. The skeleton above shows the structure; the actual code in those blocks should be copied/adapted from the corresponding sections of `shape-manager.ts`, `scene3d-manager.ts`, and `webgpu-renderer.ts`.

---

### 3. `src/viewer/salsa-viewer-element.ts`

The Custom Element wrapper. Minimal — delegates everything to `SalsaViewerCore`.

```typescript
import { SalsaViewerCore } from './salsa-viewer-core';

const TEMPLATE = `
<style>
  :host {
    display: block;
    position: relative;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  .fallback {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: sans-serif;
    font-size: 14px;
    color: #999;
    background: #111;
  }
</style>
<canvas></canvas>
`;

export class SalsaViewerElement extends HTMLElement {
  static observedAttributes = ['url'];

  private _core: SalsaViewerCore | null = null;
  private _canvas!: HTMLCanvasElement;
  private _resizeObserver!: ResizeObserver;
  private _pendingUrl: string | null = null;

  connectedCallback(): void {
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = TEMPLATE;
    this._canvas = shadow.querySelector('canvas')!;

    if (!navigator.gpu) {
      this._showFallback(shadow, 'WebGPU required (Chrome 113+ or Edge 113+)');
      return;
    }

    this._core = new SalsaViewerCore(this._canvas);
    this._core.init().then(ok => {
      if (!ok) {
        this._showFallback(shadow, 'WebGPU initialization failed');
        return;
      }
      this._resizeObserver = new ResizeObserver(() => this._core!.resize());
      this._resizeObserver.observe(this);
      this._core.resize();

      const url = this._pendingUrl ?? this.getAttribute('url');
      if (url) this._load(url);
    });
  }

  disconnectedCallback(): void {
    this._resizeObserver?.disconnect();
    this._core?.destroy();
    this._core = null;
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === 'url' && value) {
      if (this._core) {
        this._load(value);
      } else {
        this._pendingUrl = value;  // init not done yet — load after init
      }
    }
  }

  /** Programmatic load — alternative to setting the `url` attribute. */
  async load(urlOrBlob: string | Blob): Promise<void> {
    if (!this._core) throw new Error('SalsaViewer not initialized');
    if (typeof urlOrBlob === 'string') {
      await this._core.loadUrl(urlOrBlob);
    } else {
      await this._core.loadBlob(urlOrBlob);
    }
  }

  private async _load(url: string): Promise<void> {
    try {
      await this._core!.loadUrl(url);
    } catch (e) {
      console.error('[salsa-viewer] load failed:', e);
    }
  }

  private _showFallback(shadow: ShadowRoot, msg: string): void {
    const div = document.createElement('div');
    div.className = 'fallback';
    div.textContent = msg;
    shadow.appendChild(div);
  }
}

customElements.define('salsa-viewer', SalsaViewerElement);
```

---

### 4. `src/viewer/index.ts`

Entry point for the build.

```typescript
export { SalsaViewerElement } from './salsa-viewer-element';
export { SalsaViewerCore } from './salsa-viewer-core';
// Side-effect import registers the custom element:
import './salsa-viewer-element';
```

---

### 5. `vite.viewer.config.ts` (project root)

Separate Vite config — produces a standalone bundle with no Angular dependency.

```typescript
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/viewer/index.ts',
      formats: ['es'],
      fileName: 'viewer',
    },
    outDir: 'dist-viewer',
    rollupOptions: {
      // Bundle everything — no external deps.
      // fflate (ZIP), gl-matrix, and the Salsa renderer all bundle in.
      external: [],
    },
    // Target modern browsers with WebGPU support
    target: 'chrome113',
  },
  // Use the same tsconfig as the main app — no separate tsconfig needed
});
```

Build command (add to `package.json`):
```json
"build:viewer": "vite build --config vite.viewer.config.ts"
```

---

## Implementation order

Work through the TODO blocks in this order. Each one has a clear reference to existing code:

### ✅ Phase 1 — Core rendering (no raster, no textures)

**Goal:** `<salsa-viewer>` renders a `.frogmarks` file that contains only 3D meshes and particles. Raster layers show as empty; GLTF meshes show as white boxes; no textures.

1. **Create `src/viewer/scene-deserializer.ts`**  
   Copy the `case '3DMesh'` (lines 4948–4975), `case '3DMeshGroup'` (lines 4977–4985), and `case 'ParticleEmitter3D'` (lines 5012–5022) blocks from `shape-manager.ts`.  
   Copy the common props block (lines 5024–5044).  
   Write a stub `InteractionService` by checking all required fields in `src/services/interaction-service.ts`.

2. **Create `src/viewer/salsa-viewer-core.ts`** with `init()`, `loadBlob()`, `scheduleRender()`, and `_render()`. Skip all the `// TODO` stubs for now — raster, GLTF, and textures come later.

3. **Create `src/viewer/salsa-viewer-element.ts`** with the Custom Element shell.

4. **Create `vite.viewer.config.ts`** and confirm `npm run build:viewer` produces a `dist-viewer/viewer.js` without tree-shaking errors.

5. **Test:** Create a local HTML file that imports `viewer.js` and loads a `.frogmarks` containing only primitives + particles. Meshes should appear; particles should tick.

### ✅ Phase 2 — TextureLibrary textures on meshes

**Goal:** Meshes with `textureLibraryId` show their assigned diffuse textures.

6. **Implement `_applyTextureLibraryToMeshes()`**  
   Reference: `Scene3DManager.restoreTextureLibraryData()` in `scene3d-manager.ts`.  
   The atlas rebuild in `Renderer3D._buildTextureAtlas()` is automatic on next `drawMeshes()` if `_atlasDirty = true` — you just need to populate `mesh.diffuseTexture` and `mesh.textureLibraryId`.

### ✅ Phase 3 — GLTF mesh geometry

**Goal:** Meshes imported from GLB render with correct geometry (not just the fallback primitive).

7. **Implement `_restoreGltfMeshes()`**  
   Reference: `Scene3DManager.restoreDocumentState()` logic and `parseGLB()` from `src/renderer/3d/gltf-importer.ts`.  
   For each mesh in `data.models3d` that has a matching `Mesh3D` node (identified by `glbMeshId`), call `parseGLB(buffer)` and `mesh.setGeometry(result[0].geometry)`.

### ✅ Phase 4 — Raster layers

**Goal:** Documents with raster layers (the pixel painting canvas) composite correctly.

8. **Implement `_restoreRasterLayers()` and `_compositeRasterLayers()`**  
   This is the most complex part. Reference:  
   - `DocumentPersistence.restoreDocumentState()` for reading the bin data  
   - `WebGPURenderer` around lines 2742–2800 for the raster compositor calls  
   - `RasterLayerManager` for the layer list model  
   A viewer-mode `RasterLayerManager` can be a simple wrapper that just holds `GPUTexture` per layer ID without any brush/tool logic.

### ✅ Phase 5 — Polish + CDN publish flow

9. **Static thumbnail fallback** ✅ — `packProject()` auto-captures a 512px JPEG thumbnail and embeds it as `manifest.thumbnail`. Viewer peeks it with `SalsaViewerCore.peekThumbnailFromBlob()` and shows it while the scene loads or if WebGPU is unavailable.

10. **Loading state** ✅ — CSS spinner overlay shown during `loadUrl()` via `_setSpinner()`. Fades out when scene is ready.

11. **CDN publish flow** — Frogmarks-side only (not in the engine). Add a "Publish" button that calls `packProject()` → uploads blob to object storage (S3/R2/GCS) → returns public URL → share dialog shows `<salsa-viewer url="...">` embed code.

---

## Key reference locations in existing code

When implementing the TODOs, these are the exact sections to port from:

| What | File | Lines |
|------|------|-------|
| `recreateNode` case 3DMesh | `src/services/shape-manager.ts` | ~4948–4975 |
| `recreateNode` case 3DMeshGroup | `src/services/shape-manager.ts` | ~4977–4985 |
| `recreateNode` case ParticleEmitter3D | `src/services/shape-manager.ts` | ~5012–5022 |
| Common props assignment after switch | `src/services/shape-manager.ts` | ~5024–5044 |
| `updateSceneGraph` recursion | `src/services/shape-manager.ts` | ~4696–4720 |
| `registerRestoredParticleEmitter` | `src/services/managers/scene3d-manager.ts` | ~3783 |
| `_ensureParticleTick` callback | `src/services/managers/scene3d-manager.ts` | ~3795–3812 |
| `restoreTextureLibraryData` + mesh re-bind | `src/services/managers/scene3d-manager.ts` | search for `restoreTextureLibraryData` |
| GLTF restore from models3d | `src/services/managers/scene3d-manager.ts` | search for `restoreDocumentState` and `_modelStore` |
| Raster layer restore from bin | `src/services/persistence/document-persistence.ts` | search for `restoreDocumentState` |
| Raster BG/FG draw calls | `src/renderer/core/webgpu-renderer.ts` | ~2742–2800 |
| Depth texture creation | `src/renderer/core/webgpu-renderer.ts` | search for `depth24plus-stencil8` |

---

## Scope boundaries — what the viewer does NOT need

Do not implement these — they only exist in the editing path:

- `InteractionService` event subscriptions (pointer events, selection, box select)
- `ShapeFactory` — shapes are deserialized directly, not created through the factory
- All `DrawingService` classes (`LineDrawingService`, `ScribbleDrawingService`, etc.)
- `EraserService`, `ConnectorService`, `RasterMoveService`, `RasterTextService`
- `UndoManager3D`, `TransformController3D`, `MeshPicker` (no picking in viewer)
- `AnimationManager` — keyframe playback can be added later as an enhancement
- `PatternDrawingService` — patterns need the texture atlas, but a viewer can skip Pattern nodes entirely (they're uncommon in 3D-centric documents)

---

## Bundle size expectations

After tree-shaking with Rollup:

| Component | Estimated contribution |
|-----------|------------------------|
| WGSL shader strings (all 3D + raster) | ~120 KB raw, ~40 KB gzip |
| gl-matrix | ~50 KB raw, ~18 KB gzip |
| fflate (ZIP) | ~40 KB raw, ~15 KB gzip |
| Renderer3D + Pipeline3D + all 3D passes | ~100 KB raw, ~35 KB gzip |
| RasterCompositor | ~30 KB raw, ~10 KB gzip |
| Scene graph nodes | ~40 KB raw, ~12 KB gzip |
| **Total estimate** | **~380 KB raw, ~130 KB gzip** |

This is comparable to `@splinetool/viewer` (their runtime is ~180 KB gzip, but uses WebGL which has lower-level overhead than WebGPU's explicit API). Acceptable for an embed script.
