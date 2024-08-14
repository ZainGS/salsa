import { SceneGraph } from './scene-graph/scene-graph';
import { Rectangle } from './scene-graph/shapes/rectangle';
import { Circle } from './scene-graph/shapes/circle';
import { WebGPURenderer } from './renderer/webgpu-renderer';
import { WebGPURenderStrategy } from './renderer/render-strategies/webgpu-render-strategy';
import { CanvasRenderer } from './renderer/canvas-renderer';
import { CanvasRenderStrategy } from './renderer/render-strategies/canvas-render-strategy';
import { Diamond } from './scene-graph/shapes/diamond';
import { Triangle } from './scene-graph/shapes/triangle';
import { InvertedTriangle } from './scene-graph/shapes/inverted-triangle';

async function webGPURendering() {
    // Set up the canvas
    const canvas = document.getElementById('myCanvas') as HTMLCanvasElement;

    function resizeCanvasToFullScreen() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }

    // Initial resize to full screen
    resizeCanvasToFullScreen();

    // Create the WebGPU renderer
    const webgpuRenderer = new WebGPURenderer(canvas);

    // Initialize the WebGPU context and pipeline
    await webgpuRenderer.initialize();

    // Get the device and pipeline from the WebGPU renderer
    const device = webgpuRenderer.getDevice();
    const shapePipeline = webgpuRenderer.getShapePipeline();

    // Create the WebGPU render strategy
    const webgpuRenderStrategy = new WebGPURenderStrategy(device, shapePipeline, canvas);

    // Create the scene graph
    const sceneGraph = new SceneGraph(webgpuRenderStrategy);

    // Pass the sceneGraph to the WebGPURenderer
    webgpuRenderer.setSceneGraph(sceneGraph);   

    // Create a dynamic diamond
    const diamond = new Diamond(webgpuRenderStrategy, 200, 150, { r: 0, g: 0, b: 1, a: 1 }, { r: 0, g: 0, b: 0, a: 1 }, 2);
    diamond.x = 650;
    diamond.y = 280;

    // Create a dynamic red diamond
    const red_diamond = new Diamond(webgpuRenderStrategy, 200, 110, { r: 1, g: 0.1, b: 0.1, a: 1 }, { r: 0, g: 0, b: 0, a: 1 }, 2);
    red_diamond.x = 750;
    red_diamond.y = 480;

    // Create a dynamic rectangle
    const rect = new Rectangle(webgpuRenderStrategy, 220, 120, { r: 0, g: 1, b: 0, a: 1 }, { r: 0, g: 0, b: 0, a: 1 }, 2);
    rect.x = 150;
    rect.y = 500;

    // Create a dynamic triangle
    const tri = new Triangle(webgpuRenderStrategy, 220, 120, { r: 0, g: 1, b: 0, a: 1 }, { r: 0, g: 0, b: 0, a: 1 }, 2);
    tri.x = 750;
    tri.y = 700;

    // Create a dynamic inverted triangle
    const inverted_tri = new InvertedTriangle(webgpuRenderStrategy, 220, 120, { r: 1, g: .7, b: 0, a: 1 }, { r: 0, g: 0, b: 0, a: 1 }, 2);
    inverted_tri.x = 850;
    inverted_tri.y = 200;

    // Create a dynamic square
    const square = new Rectangle(webgpuRenderStrategy, 120, 120, { r: 2, g: 0, b: 1, a: 1 }, { r: 0, g: 0, b: 0, a: 1 }, 2);
    square.x = 460;
    square.y = 420;

    // Create a dynamic circle
    const circle = new Circle(webgpuRenderStrategy, 50, { r: 1, g: 0, b: 0, a: 1 }, { r: 0, g: 0, b: 0, a: 1 }, 2);
    circle.x = 400;
    circle.y = 300;

    // Add the shapes to the scene graph
    sceneGraph.root.addChild(rect); 
    sceneGraph.root.addChild(circle);
    sceneGraph.root.addChild(diamond);
    sceneGraph.root.addChild(tri);
    sceneGraph.root.addChild(inverted_tri);
    sceneGraph.root.addChild(red_diamond);
    sceneGraph.root.addChild(square);

    function renderLoop() {
        webgpuRenderer.render();
        requestAnimationFrame(renderLoop);
    }

    renderLoop();
}

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
    const rect = new Rectangle(canvasRenderStrategy, 100, 50, red, black, 2);
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

//canvasRendering();
webGPURendering();
