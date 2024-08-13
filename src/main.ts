import { SceneGraph } from './scene-graph/scene-graph';
import { Rectangle } from './scene-graph/rectangle';
import { Circle } from './scene-graph/circle';
import { WebGPURenderer } from './renderer/webgpu-renderer';
import { WebGPURenderStrategy } from './renderer/webgpu-render-strategy';
import { CanvasRenderer } from './renderer/canvas-renderer';
import { CanvasRenderStrategy } from './renderer/canvas-render-strategy';

async function webGPURendering() {
    // Set up the canvas
    const canvas = document.getElementById('myCanvas') as HTMLCanvasElement;
    canvas.width = 800;
    canvas.height = 600;

    // Create the WebGPU renderer
    const webgpuRenderer = new WebGPURenderer(canvas);

    // Initialize the WebGPU context and pipeline
    await webgpuRenderer.initialize();

    // Get the device and pipeline from the WebGPU renderer
    const device = webgpuRenderer.getDevice();
    const pipeline = webgpuRenderer.getPipeline();

    // Create the WebGPU render strategy
    const webgpuRenderStrategy = new WebGPURenderStrategy(device, pipeline, canvas);

    // Create the scene graph
    const sceneGraph = new SceneGraph(webgpuRenderStrategy);

    // Create a dynamic rectangle
    const rect = new Rectangle(webgpuRenderStrategy, 200, 100, { r: 0, g: 0, b: 1, a: 1 }, { r: 0, g: 0, b: 0, a: 1 }, 2);
    rect.x = 150;
    rect.y = 150;

    // Create a dynamic circle
    const circle = new Circle(webgpuRenderStrategy, 50, { r: 1, g: 0, b: 0, a: 1 }, { r: 0, g: 0, b: 0, a: 1 }, 2);
    circle.x = 400;
    circle.y = 300;

    // Add the shapes to the scene graph
    sceneGraph.root.addChild(rect); 
    sceneGraph.root.addChild(circle);

    function renderLoop() {
        webgpuRenderer.render(sceneGraph);
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
