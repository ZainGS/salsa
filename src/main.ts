import { SceneGraph } from './scene-graph/scene-graph';
import { WebGPURenderer } from './renderer/webgpu-renderer';
import { WebGPURenderStrategy } from './renderer/render-strategies/webgpu-render-strategy';
import { InteractionService } from './services/interaction-service';
import { ShapeFactory } from './scene-graph/shape-factory';

async function webGPURendering() {
    // Set up the canvas
    const canvas = document.getElementById('myCanvas') as HTMLCanvasElement;

    function resizeCanvasToFullScreen() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }

    // Initial resize to full screen
    await resizeCanvasToFullScreen();

    // Initialize Services
    const interactionService = new InteractionService(canvas);
    
    // Create the WebGPU renderer
    const webgpuRenderer = new WebGPURenderer(canvas, interactionService);

    // Initialize the WebGPU context and pipeline
    await webgpuRenderer.initialize();

    // Get the device and pipeline from the WebGPU renderer
    const device = webgpuRenderer.getDevice();
    const shapePipeline = webgpuRenderer.getShapePipeline();

    // Create the WebGPU render strategy for your shapes
    const webgpuRenderStrategy = new WebGPURenderStrategy(device, shapePipeline, canvas, interactionService);

    // Create the ShapeFactory
    const shapeFactory = new ShapeFactory(interactionService, webgpuRenderStrategy);

    // Create the scene graph
    const sceneGraph = new SceneGraph(webgpuRenderStrategy);

    // Pass the sceneGraph to the WebGPURenderer
    webgpuRenderer.setSceneGraph(sceneGraph);   

    // Canvas width and height for normalization
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;

    // Normalize width and height by canvas dimensions and aspect ratio correction
    const normalizeWidth = (width: number) => (width / canvasWidth) * 2;
    const normalizeHeight = (height: number) => (height / canvasHeight) * 2;

    // Create shapes using the ShapeFactory with normalized dimensions and positions
    const diamond = shapeFactory.createDiamond(
        normalizeWidth(200), 
        normalizeHeight(150), 
        { r: 0, g: 0, b: 1, a: 1 }, 
        { r: 0, g: 0, b: 0, a: 1 }, 
        2
    );
    diamond.x = (650 / canvasWidth) * 2 - 1;
    diamond.y = (280 / canvasHeight) * 2 - 1;

    const redDiamond = shapeFactory.createDiamond(
        normalizeWidth(200), 
        normalizeHeight(110), 
        { r: 1, g: 0.1, b: 0.1, a: 1 }, 
        { r: 0, g: 0, b: 0, a: 1 }, 
        2
    );
    redDiamond.x = (750 / canvasWidth) * 2 - 1;
    redDiamond.y = (480 / canvasHeight) * 2 - 1;

    const rect = shapeFactory.createRectangle(
        normalizeWidth(220), 
        normalizeHeight(120), 
        { r: 0, g: 1, b: 0, a: 1 }, 
        { r: 0, g: 0, b: 0, a: 1 }, 
        2
    );
    rect.x = (150 / canvasWidth) * 2 - 1;
    rect.y = (500 / canvasHeight) * 2 - 1;

    const tri = shapeFactory.createTriangle(
        normalizeWidth(220), 
        normalizeHeight(120), 
        { r: 0, g: 1, b: 0, a: 1 }, 
        { r: 0, g: 0, b: 0, a: 1 }, 
        2
    );
    tri.x = (750 / canvasWidth) * 2 - 1;
    tri.y = (700 / canvasHeight) * 2 - 1;

    const invertedTri = shapeFactory.createInvertedTriangle(
        normalizeWidth(220), 
        normalizeHeight(120), 
        { r: 1, g: 0.7, b: 0, a: 1 }, 
        { r: 0, g: 0, b: 0, a: 1 }, 
        2
    );
    invertedTri.x = (850 / canvasWidth) * 2 - 1;
    invertedTri.y = (200 / canvasHeight) * 2 - 1;

    const square = shapeFactory.createRectangle(
        normalizeWidth(120), 
        normalizeHeight(120), 
        { r: 2, g: 0, b: 1, a: 1 }, 
        { r: 0, g: 0, b: 0, a: 1 }, 
        2
    );
    square.x = (460 / canvasWidth) * 2 - 1;
    square.y = (420 / canvasHeight) * 2 - 1;

    const circle = shapeFactory.createCircle(
        normalizeWidth(100), 
        { r: 1, g: 0, b: 0, a: 1 }, 
        { r: 0, g: 0, b: 0, a: 1 }, 
        2
    );
    circle.x = (300 / canvasWidth) * 2 - 1;
    circle.y = (300 / canvasHeight) * 2 - 1;

    // Add the shapes to the scene graph
    sceneGraph.root.addChild(rect); 
    //sceneGraph.root.addChild(circle);
    //sceneGraph.root.addChild(diamond);
    //sceneGraph.root.addChild(tri);
    //sceneGraph.root.addChild(invertedTri);
    //sceneGraph.root.addChild(redDiamond);
    //sceneGraph.root.addChild(square);

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
webGPURendering();
