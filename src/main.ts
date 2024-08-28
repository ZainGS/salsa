import { SceneGraph } from './scene-graph/scene-graph';
import { WebGPURenderer } from './renderer/webgpu-renderer';
import { WebGPURenderStrategy } from './renderer/render-strategies/webgpu-render-strategy';
import { InteractionService } from './services/interaction-service';
import { ShapeFactory } from './scene-graph/shape-factory';

async function webGPURendering() {
    // Set up the canvas
    const canvas = document.getElementById('myCanvas') as HTMLCanvasElement;

    function setCanvasSize() {
        // Get the maximum screen resolution
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    
    // Initial set on load
    setCanvasSize();
    
    // Update canvas size when the window is resized
    window.addEventListener('resize', setCanvasSize);

    // Initialize Services
    const interactionService = new InteractionService(canvas);
    
    // Create the WebGPU renderer
    const webgpuRenderer = new WebGPURenderer(canvas, interactionService);

    // Initialize the WebGPU context and pipeline
    await webgpuRenderer.initialize();

    // Get the device and pipeline from the WebGPU renderer
    const device = webgpuRenderer.getDevice();
    const shapePipeline = webgpuRenderer.getShapePipeline();
    const boundingBoxPipeline = webgpuRenderer.getBoundingBoxPipeline();
    // Create the WebGPU render strategy for your shapes
    const webgpuRenderStrategy = new WebGPURenderStrategy(device, shapePipeline, boundingBoxPipeline, canvas, interactionService);

    // Create the ShapeFactory
    const shapeFactory = new ShapeFactory(interactionService, webgpuRenderStrategy);

    // Create the scene graph
    const sceneGraph = new SceneGraph(webgpuRenderStrategy);

    // Pass the sceneGraph to the WebGPURenderer
    webgpuRenderer.setSceneGraph(sceneGraph);   

    // Default color
    var froggyGreen = {r: 175/255, g: 244/255, b: 198/255, a: 1};

    // Create shapes using the ShapeFactory with normalized dimensions and positions
    const diamond = shapeFactory.createDiamond(0,0,
        .6, 
        .6, 
        froggyGreen, 
        { r: 0, g: 0, b: 0, a: 1 }, 
        2
    );
    diamond.x = 1;
    diamond.y = 0;

    const redDiamond = shapeFactory.createDiamond(0,0,
        1, 
        1, 
        froggyGreen, 
        { r: 0, g: 0, b: 0, a: 1 }, 
        2
    );
    redDiamond.x = -1;
    redDiamond.y = 1.2;

    /*
    const rect = shapeFactory.createRectangle(
        .6, 
        .4, 
        { r: 0, g: 1, b: 0, a: 1 }, 
        { r: 0, g: 0, b: 0, a: 1 }, 
        2
    );
    rect.x = 1.5;
    rect.y = 1;
    */

    const tri = shapeFactory.createTriangle(0,0,
        .5, 
        .5, 
        froggyGreen, 
        { r: 0, g: 0, b: 0, a: 1 }, 
        2
    );
    tri.x = -.2;
    tri.y = 1.2;

    const invertedTri = shapeFactory.createInvertedTriangle(0,0,
        .5, 
        .5, 
        froggyGreen, 
        { r: 0, g: 0, b: 0, a: 1 }, 
        2
    );
    invertedTri.x = 1.35;
    invertedTri.y = -1.4;

    const square = shapeFactory.createRectangle(0,0,
        .5, 
        .5, 
        froggyGreen, 
        { r: 0, g: 0, b: 0, a: 1 }, 
        0
    );
    square.x = 0;
    square.y = 0;

    const circle = shapeFactory.createCircle(0,0,
        .5, 
        froggyGreen, 
        { r: 0, g: 0, b: 0, a: 1 }, 
        0
    );
    circle.x = 0.5;
    circle.y = 0.5;


    // Add the shapes to the scene graph
    // sceneGraph.root.addChild(rect); 
    sceneGraph.root.addChild(circle);
    sceneGraph.root.addChild(diamond);
    sceneGraph.root.addChild(tri);
    sceneGraph.root.addChild(invertedTri);
    sceneGraph.root.addChild(redDiamond);
    sceneGraph.root.addChild(square);
    

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
