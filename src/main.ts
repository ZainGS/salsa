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
    const interactionService = new InteractionService(canvas);
    
    // Create the WebGPU renderer
    var webgpuRenderer = new WebGPURenderer(canvas, interactionService);
    
    // Gives reinitialize method access to the existing renderer
    existingRenderer = webgpuRenderer;

    // Initialize the WebGPU context and pipeline
    await webgpuRenderer.initialize();

    // Get the device and pipelines from the WebGPU renderer
    const shapePipeline = webgpuRenderer.getShapePipeline();
    const linePipeline = webgpuRenderer.getLinePipeline();
    const boundingBoxPipeline = webgpuRenderer.getBoundingBoxPipeline();
    const textPipeline = webgpuRenderer.getTextPipeline();
    const highlightPipeline = webgpuRenderer.getHighlightPipeline();
    const patternPipeline = webgpuRenderer.getPatternPipeline();

    // Initialize caches and create the WebGPU render strategy for your shapes
    //const webgpuRenderStrategy = new WebGPURenderStrategy(device, shapePipeline, boundingBoxPipeline, canvas, interactionService);
    // Swap to dependency injection in the future if multiple renderers are
    // needed (like per-tab or per-session rendering).
    const cacheService = CacheService.getInstance(interactionService);
    cacheService.initialize(webgpuRenderer.getDevice()); // this creates fresh buffers
    const webgpuRenderStrategy = new WebGPURenderStrategy(
        webgpuRenderer.getDevice(), shapePipeline, 
        boundingBoxPipeline, linePipeline, 
        textPipeline, highlightPipeline, 
        patternPipeline, interactionService,
        cacheService);

    // Create the ShapeFactory
    const shapeFactory = new ShapeFactory(interactionService, webgpuRenderStrategy);

    // Create the scene graph
    var sceneGraph = new SceneGraph(webgpuRenderStrategy);

    // Pass the sceneGraph to the WebGPURenderer
    webgpuRenderer.setSceneGraph(sceneGraph);   

    // Create Line Drawing Service
    const lineDrawingService = new LineDrawingService(interactionService, sceneGraph, webgpuRenderer, shapeFactory);

    // Create Pattern Drawing Service
    const patternDrawingService = new PatternDrawingService(interactionService, sceneGraph, webgpuRenderer, shapeFactory, webgpuRenderer.getDevice());

    // Create Eraser Service
    const eraserService = new EraserService(interactionService, sceneGraph, webgpuRenderer, shapeFactory);

    // Create Scribble Drawing Service
    const scribbleDrawingService = new ScribbleDrawingService(interactionService, sceneGraph, webgpuRenderer, shapeFactory, eraserService);

    // Create Highlight Drawing Service
    const highlightDrawingService = new HighlightDrawingService(interactionService, sceneGraph, webgpuRenderer, shapeFactory, eraserService);

    // Create Text Drawing Service
    const textDrawingService = new TextDrawingService(interactionService, sceneGraph, webgpuRenderer, shapeFactory);

    // ShapeManager Setup
    ShapeManager.getInstance(shapeFactory, 
                                sceneGraph, 
                                lineDrawingService, 
                                scribbleDrawingService, 
                                textDrawingService, 
                                eraserService, 
                                highlightDrawingService, 
                                patternDrawingService,
                                interactionService);

    // World Manager Setup
    WorldManager.getInstance(interactionService);

    // Pass services to renderer
    webgpuRenderer.setLineDrawingService(lineDrawingService);
    webgpuRenderer.setPatternDrawingService(patternDrawingService);
    webgpuRenderer.setScribbleDrawingService(scribbleDrawingService);
    webgpuRenderer.setHighlightDrawingService(highlightDrawingService);
    webgpuRenderer.setTextDrawingService(textDrawingService);
    webgpuRenderer.setEraserService(eraserService);

    // Default color
    // var froggyGreen = {r: 175/255, g: 244/255, b: 198/255, a: 1};

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

/*
async function canvasRendering() {
    // Set up the canvas
    const canvas = document.getElementById('myCanvas') as HTMLCanvasElement;
    canvas.width = 800;
    canvas.height = 600;

    // Create the canvas render strategy
    const canvasRenderStrategy = new CanvasRenderStrategy();

    // Create the scene graph
    const sceneGraph = new SceneGraph(canvasRenderStrategy);

    var red = {r:1,g:0,b:0,a:1};
    var black = {r:0,g:0,b:0,a:1};

    // Create a rectangle
    const rect = new Rectangle(canvasRenderStrategy, 100, 50, red, black, 2, nteractionService);
    rect.x = 150;
    rect.y = 100;

    // Add a click event to change the color of the rectangle
    rect.onClick = () => {
        rect.fillColor = rect.fillColor === red ? black : red;
        console.log("Rectangle clicked! Color changed.");
    };

    // Add the rectangle to the scene graph
    sceneGraph.root.addChild(rect);

    // Create the renderer
    const renderer = new CanvasRenderer(canvas, sceneGraph);

    // Start the rendering loop manually
    renderer.start();
}
*/
//canvasRendering();
//startWebGPURendering("myCanvas");
export { startWebGPURendering, reinitializeWebGPURendering, stopWebGPURendering, isRendererLive };

