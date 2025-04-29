import { SceneGraph } from './scene-graph/core/scene-graph';
import { WebGPURenderer } from './renderer/core/webgpu-renderer';
import { WebGPURenderStrategy } from './renderer/render-strategies/webgpu-render-strategy';
import { InteractionService } from './services/interaction-service';
import { ShapeFactory } from './scene-graph/core/shape-factory';
import ShapeManager from './services/shape-manager';
import { LineDrawingService } from './services/drawing/line-drawing-service';
import WorldManager from './services/world-manager';
import { ScribbleDrawingService } from './services/drawing/scribble-drawing-service';
import { TextDrawingService } from './services/drawing/text-drawing-service';
import { EraserService } from './services/drawing/eraser-service';
import { HighlightDrawingService } from './services/drawing/highlight-drawing-service';
import { PatternDrawingService } from './services/drawing/pattern-drawing-service';
import { CacheService } from './services/cache-service';
import { BindGroupManager } from './renderer/core/managers/bindgroup-manager';
import { PipelineManager } from './renderer/core/managers/pipeline-manager';
import { StrokesStagingBuffer } from './renderer/caches/buffers/strokes-staging-buffer';
import { AnimationService } from './services/animation/animation-service';
import { TestAnimations } from './services/animation/test-animations';
import { SectionDrawingService } from './services/drawing/section-drawing-service';

let existingRenderer: WebGPURenderer | null = null;
let isRendererLive: boolean = false;
async function startWebGPURendering(canvasId: string) {
    // Stop render loop until all services initialized
    isRendererLive = false;
    // Set up the canvas
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    if (!canvas) {
        throw new Error(`Canvas element with ID '${canvasId}' not found.`);
    }

    // Initialize Services
    var interactionService = new InteractionService(canvas);

    // Create the WebGPU renderer
    var webgpuRenderer = new WebGPURenderer(canvas, interactionService);
    
    // Gives reinitialize method access to the existing renderer
    existingRenderer = webgpuRenderer;

    // Initialize the WebGPU context and pipeline
    await webgpuRenderer.initialize();

    // Get the device and pipelines from the WebGPU renderer
    var pipelineManager = new PipelineManager(webgpuRenderer.getDevice());

    // Initialize caches and create the WebGPU render strategy for your shapes
    //const webgpuRenderStrategy = new WebGPURenderStrategy(device, shapePipeline, boundingBoxPipeline, canvas, interactionService);
    // Swap to dependency injection in the future if multiple renderers are
    // needed (like per-tab or per-session rendering).
    var bindGroupManager: BindGroupManager = new BindGroupManager(webgpuRenderer.getDevice(), pipelineManager);
    var cacheService = new CacheService(webgpuRenderer.getDevice(), 
                                        interactionService, 
                                        bindGroupManager,
                                        pipelineManager);
    bindGroupManager.setCacheService(cacheService);
    bindGroupManager.initBindGroups();
    // bindGroupManager.initPatternBindGroups();
    webgpuRenderer.setPipelineManager(pipelineManager, bindGroupManager, cacheService);
    
    var stagingBuffer = new StrokesStagingBuffer(webgpuRenderer.getDevice());

    var webgpuRenderStrategy = new WebGPURenderStrategy(
        webgpuRenderer.getDevice(), pipelineManager, interactionService,
        cacheService, stagingBuffer);

    webgpuRenderer.setWebGPURenderStrategy(webgpuRenderStrategy);
    
    // Create the ShapeFactory
    const shapeFactory = new ShapeFactory(interactionService);

    // Create the scene graph
    var sceneGraph = new SceneGraph();

    // Pass the sceneGraph to the WebGPURenderer
    webgpuRenderer.setSceneGraph(sceneGraph);   

    // Create Line Drawing Service
    const lineDrawingService = new LineDrawingService(interactionService, sceneGraph, webgpuRenderer, shapeFactory);

    // Create Pattern Drawing Service
    const patternDrawingService = new PatternDrawingService(interactionService, sceneGraph, webgpuRenderer, shapeFactory, webgpuRenderer.getDevice());

    // Create Eraser Service
    const eraserService = new EraserService(interactionService, sceneGraph, webgpuRenderer, shapeFactory);

    // Create Scribble Drawing Service
    const scribbleDrawingService = new ScribbleDrawingService(interactionService, sceneGraph, webgpuRenderer, shapeFactory, eraserService, stagingBuffer);

    // Create Highlight Drawing Service
    const highlightDrawingService = new HighlightDrawingService(interactionService, sceneGraph, webgpuRenderer, shapeFactory, eraserService);

    // Create Text Drawing Service
    const textDrawingService = new TextDrawingService(interactionService, sceneGraph, webgpuRenderer, shapeFactory, webgpuRenderer.getDevice());

    // Create Section Drawing Service
    const sectionDrawingService = new SectionDrawingService(interactionService, sceneGraph, webgpuRenderer, shapeFactory);

    // ShapeManager Setup
    ShapeManager.getInstance(shapeFactory, 
                                sceneGraph, 
                                lineDrawingService, 
                                scribbleDrawingService, 
                                textDrawingService, 
                                eraserService, 
                                highlightDrawingService, 
                                patternDrawingService,
                                sectionDrawingService,
                                interactionService);

    // World Manager Setup
    WorldManager.getInstance(interactionService);

    // Pass services to renderer
    webgpuRenderer.setLineDrawingService(lineDrawingService);
    webgpuRenderer.setPatternDrawingService(patternDrawingService);
    webgpuRenderer.setScribbleDrawingService(scribbleDrawingService);
    webgpuRenderer.setSectionDrawingService(sectionDrawingService);
    webgpuRenderer.setHighlightDrawingService(highlightDrawingService);
    webgpuRenderer.setTextDrawingService(textDrawingService);
    webgpuRenderer.setEraserService(eraserService);

    // Default color
    // var froggyGreen = {r: 175/255, g: 244/255, b: 198/255, a: 1};

    // Animation Test:
    // const sceneGraphFrameJsons: string[] = TestAnimations.getTestSceneGraphFrames(); // your JSON animation frames
    // const animationService = new AnimationService(sceneGraph, ShapeManager.getInstance());
    // animationService.start(sceneGraphFrameJsons, 50); // just pass raw JSON array


    function renderLoop() {
        if(!isRendererLive) return;
        webgpuRenderer.render();
        /* About requestAnimationFrame():
           Schedule the renderLoop function to be called again, creating a loop. The browser controls the 
           timing, typically aiming for 60 frames per second (FPS), though this can vary depending on the 
           device's capabilities and performance. 

           It syncs with the display's refresh rate, ensuring smooth animations and preventing unnecessary 
           rendering when the page isn't visible (e.g., when the user switches tabs).
           Also allows the browser to adjust framerate based on system load, helping maintain performance.
        --------------------------------------------------------------------------------------------------*/
        requestAnimationFrame(renderLoop);
    }
    isRendererLive = true;
    renderLoop();
}

async function reinitializeWebGPURendering(newCanvasId: string) {
    const newCanvas = document.getElementById(newCanvasId) as HTMLCanvasElement;
    if (!newCanvas) throw new Error(`Canvas element with ID '${newCanvasId}' not found.`);
    isRendererLive = false;
    await existingRenderer?.reinitialize(newCanvas);
    isRendererLive = true;
    //requestAnimationFrame(() => existingRenderer?.render());
}

async function stopWebGPURendering() {
    isRendererLive = false;
}

// function getTestSceneGraphFrames(): string[] {
//     return [
//       `{"root": {"x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotation": 0, "zIndex": 0, "visible": true, "children": [{"type": "Scribble", "id": "frog_0", "x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotation": 0, "zIndex": 0, "visible": true, "strokeColor": {"r": 0.2, "g": 0.8, "b": 0.4, "a": 1}, "strokeWidth": 0.01, "points": [{"x": -0.05, "y": 0.0}, {"x": -0.04, "y": 0.03}, {"x": -0.02, "y": 0.04}, {"x": 0.0, "y": 0.045}, {"x": 0.02, "y": 0.04}, {"x": 0.04, "y": 0.03}, {"x": 0.05, "y": 0.0}, {"x": 0.04, "y": -0.03}, {"x": 0.02, "y": -0.04}, {"x": 0.0, "y": -0.045}, {"x": -0.02, "y": -0.04}, {"x": -0.04, "y": -0.03}, {"x": -0.05, "y": 0.0}]}]}}`,
//       `{"root": {"x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotation": 0, "zIndex": 0, "visible": true, "children": [{"type": "Scribble", "id": "frog_1", "x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotation": 0, "zIndex": 0, "visible": true, "strokeColor": {"r": 0.2, "g": 0.8, "b": 0.4, "a": 1}, "strokeWidth": 0.01, "points": [{"x": -0.030000000000000002, "y": 0.05}, {"x": -0.02, "y": 0.08}, {"x": 0.0, "y": 0.09}, {"x": 0.02, "y": 0.095}, {"x": 0.04, "y": 0.09}, {"x": 0.06, "y": 0.08}, {"x": 0.07, "y": 0.05}, {"x": 0.06, "y": 0.020000000000000004}, {"x": 0.04, "y": 0.010000000000000002}, {"x": 0.02, "y": 0.0050000000000000044}, {"x": 0.0, "y": 0.010000000000000002}, {"x": -0.02, "y": 0.020000000000000004}, {"x": -0.030000000000000002, "y": 0.05}]}]}}`,
//       `{"root": {"x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotation": 0, "zIndex": 0, "visible": true, "children": [{"type": "Scribble", "id": "frog_2", "x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotation": 0, "zIndex": 0, "visible": true, "strokeColor": {"r": 0.2, "g": 0.8, "b": 0.4, "a": 1}, "strokeWidth": 0.01, "points": [{"x": -0.05, "y": 0.1}, {"x": -0.04, "y": 0.13}, {"x": -0.02, "y": 0.14}, {"x": 0.0, "y": 0.14500000000000002}, {"x": 0.02, "y": 0.14}, {"x": 0.04, "y": 0.13}, {"x": 0.05, "y": 0.1}, {"x": 0.04, "y": 0.07}, {"x": 0.02, "y": 0.060000000000000005}, {"x": 0.0, "y": 0.05500000000000001}, {"x": -0.02, "y": 0.060000000000000005}, {"x": -0.04, "y": 0.07}, {"x": -0.05, "y": 0.1}]}]}}`,
//       `{"root": {"x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotation": 0, "zIndex": 0, "visible": true, "children": [{"type": "Scribble", "id": "frog_3", "x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotation": 0, "zIndex": 0, "visible": true, "strokeColor": {"r": 0.2, "g": 0.8, "b": 0.4, "a": 1}, "strokeWidth": 0.01, "points": [{"x": -0.030000000000000002, "y": 0.15000000000000002}, {"x": -0.02, "y": 0.18000000000000002}, {"x": 0.0, "y": 0.19000000000000003}, {"x": 0.02, "y": 0.195}, {"x": 0.04, "y": 0.19000000000000003}, {"x": 0.06, "y": 0.18000000000000002}, {"x": 0.07, "y": 0.15000000000000002}, {"x": 0.06, "y": 0.12000000000000002}, {"x": 0.04, "y": 0.11000000000000001}, {"x": 0.02, "y": 0.10500000000000002}, {"x": 0.0, "y": 0.11000000000000001}, {"x": -0.02, "y": 0.12000000000000002}, {"x": -0.030000000000000002, "y": 0.15000000000000002}]}]}}`,
//       `{"root": {"x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotation": 0, "zIndex": 0, "visible": true, "children": [{"type": "Scribble", "id": "frog_4", "x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotation": 0, "zIndex": 0, "visible": true, "strokeColor": {"r": 0.2, "g": 0.8, "b": 0.4, "a": 1}, "strokeWidth": 0.01, "points": [{"x": -0.05, "y": 0.2}, {"x": -0.04, "y": 0.23}, {"x": -0.02, "y": 0.24000000000000002}, {"x": 0.0, "y": 0.245}, {"x": 0.02, "y": 0.24000000000000002}, {"x": 0.04, "y": 0.23}, {"x": 0.05, "y": 0.2}, {"x": 0.04, "y": 0.17}, {"x": 0.02, "y": 0.16}, {"x": 0.0, "y": 0.15500000000000003}, {"x": -0.02, "y": 0.16}, {"x": -0.04, "y": 0.17}, {"x": -0.05, "y": 0.2}]}]}}`
//     ];
//   }

export { startWebGPURendering, reinitializeWebGPURendering, stopWebGPURendering, isRendererLive };

