import { SceneGraph } from './scene-graph/core/scene-graph';
import { WebGPURenderer } from './renderer/core/webgpu-renderer';
import { WebGPURenderStrategy } from './renderer/render-strategies/webgpu-render-strategy';
import { InteractionService } from './services/interaction-service';
import { ShapeFactory } from './scene-graph/core/shape-factory';
import ShapeManager from './services/shape-manager';
import { LineDrawingService } from './services/line-drawing-service';
import WorldManager from './services/world-manager';
import { ScribbleDrawingService } from './services/scribble-drawing-service';
import { TextDrawingService } from './services/text-drawing-service';
import { EraserService } from './services/eraser-service';

async function startWebGPURendering(canvasId: string) {
    // Set up the canvas
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    if (!canvas) {
        throw new Error(`Canvas element with ID '${canvasId}' not found.`);
    }
    
    // Initialize Services
    const interactionService = new InteractionService(canvas);

    function setCanvasSize() {
        // Get the maximum screen resolution
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        interactionService.updateWorldMatrix();
    }
    
    // Initial set on load
    setCanvasSize();
    
    // Update canvas size when the window is resized
    window.addEventListener('resize', setCanvasSize);
    
    // Create the WebGPU renderer
    const webgpuRenderer = new WebGPURenderer(canvas, interactionService);

    // Initialize the WebGPU context and pipeline
    await webgpuRenderer.initialize();
    
    // Get the device and pipeline from the WebGPU renderer
    const device = webgpuRenderer.getDevice();
    const shapePipeline = webgpuRenderer.getShapePipeline();
    const linePipeline = webgpuRenderer.getLinePipeline();
    const boundingBoxPipeline = webgpuRenderer.getBoundingBoxPipeline();
    const textPipeline = webgpuRenderer.getTextPipeline();
    // Create the WebGPU render strategy for your shapes
    //const webgpuRenderStrategy = new WebGPURenderStrategy(device, shapePipeline, boundingBoxPipeline, canvas, interactionService);
    const webgpuRenderStrategy = new WebGPURenderStrategy(device, shapePipeline, boundingBoxPipeline, linePipeline, textPipeline, interactionService);

    // Create the ShapeFactory
    const shapeFactory = new ShapeFactory(interactionService, webgpuRenderStrategy);

    // Create the scene graph
    const sceneGraph = new SceneGraph(webgpuRenderStrategy);

    // Pass the sceneGraph to the WebGPURenderer
    webgpuRenderer.setSceneGraph(sceneGraph);   

    // Create Line Drawing Service
    const lineDrawingService = new LineDrawingService(interactionService, sceneGraph, webgpuRenderer, shapeFactory);

    // Create Eraser Service
    const eraserService = new EraserService(interactionService, sceneGraph, webgpuRenderer, shapeFactory);

    // Create Scribble Drawing Service
    const scribbleDrawingService = new ScribbleDrawingService(interactionService, sceneGraph, webgpuRenderer, shapeFactory, eraserService);

    // Create Text Drawing Service
    const textDrawingService = new TextDrawingService(interactionService, sceneGraph, webgpuRenderer, shapeFactory);

    // ShapeManager Setup
    ShapeManager.getInstance(shapeFactory, sceneGraph, lineDrawingService, scribbleDrawingService, textDrawingService, eraserService);

    // World Manager Setup
    WorldManager.getInstance(interactionService);

    // Pass the lineDrawingService to the WebGPURenderer
    webgpuRenderer.setLineDrawingService(lineDrawingService);

    // Pass the lineDrawingService to the WebGPURenderer
    webgpuRenderer.setScribbleDrawingService(scribbleDrawingService);

    // Pass the eraserService to the WebGPURenderer
    webgpuRenderer.setEraserService(eraserService);

    // Default color
    var froggyGreen = {r: 175/255, g: 244/255, b: 198/255, a: 1};

    // Create shapes using the ShapeFactory with normalized dimensions and positions
    const square = shapeFactory.createRectangle(0,0,
        .5, 
        .5, 
        froggyGreen, 
        { r: 0, g: 0, b: 0, a: 1 }, 
        0
    );
    square.x = 0;
    square.y = 0;

    // const line = shapeFactory.createLine(0,0,
    //     1, 1,
    //     froggyGreen, 
    //     10
    // );

    // Add the shapes to the scene graph
    // sceneGraph.root.addChild(line);
    // sceneGraph.root.addChild(square);
    // ShapeManager.getInstance().createLine(0, 0, 1, 1, { r: 0, g: 1, b: 0, a: 1 }, 1);

    function renderLoop() {
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

    renderLoop();
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
export { startWebGPURendering };