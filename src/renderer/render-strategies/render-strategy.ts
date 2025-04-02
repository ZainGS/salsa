// src/rendering/render-strategy.ts
import { Node } from '../../scene-graph/shapes/base/node';

export interface RenderStrategy {
    render(node: Node, 
           ctxOrEncoder: GPURenderPassEncoder,
           sharedBindGroup: GPUBindGroup): void;
}

/**
--------------------------------------------------------------------------------------
What Could Custom Strategies Enable?
--------------------------------------------------------------------------------------
Let’s say down the line we want to support:

1. Performance Modes
A Standard WebGPURenderStrategy (our current one)

InstancedWebGPURenderStrategy for rendering 1000s of identical shapes with a single draw call

MinimalWebGPURenderStrategy for low-power devices with reduced effects

2. Custom Themes or Styles
SketchRenderStrategy for hand-drawn jittery lines (great for whiteboarding)

DarkModeRenderStrategy with default shadowing and different blending

3. Debug or Analysis Modes
BoundingBoxDebugRenderStrategy which overlays bounding boxes of all nodes

ZIndexDebugRenderStrategy with each shape color-coded by zIndex

4. Export / Screenshot Rendering
A HighResRenderStrategy that renders offscreen at 4x scale for print/export

5. WebGL or CPU Fallback (if you bring it back)
WebGLRenderStrategy or CanvasRenderStrategy, selected based on device

--------------------------------------------------------------------------------------
How You’d Use Them
--------------------------------------------------------------------------------------
You could inject one like:

const strategy = new InstancedWebGPURenderStrategy(...);
webgpuRenderer.setRenderStrategy(strategy);
Or swap strategies dynamically at runtime (e.g. performance mode toggle):

togglePerformanceMode(enabled: boolean) {
    const strategy = enabled 
        ? new InstancedWebGPURenderStrategy(...) 
        : new WebGPURenderStrategy(...);

    this.webgpuRenderer.setRenderStrategy(strategy);
}
* 
*/