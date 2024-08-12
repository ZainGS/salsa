// src/main.ts

// src/main.ts
import { SceneGraph } from './scene-graph/scene-graph';
import { Rectangle } from './scene-graph/rectangle';
import { WebGPURenderer } from './renderer/webgpu-renderer';
import { WebGPURenderStrategy } from './renderer/webgpu-render-strategy';

async function main() {
    // Set up the canvas and WebGPURenderer
    const canvas = document.getElementById('myCanvas') as HTMLCanvasElement;
    const webgpuRenderer = new WebGPURenderer(canvas);
    await webgpuRenderer.initialize();

    const device = webgpuRenderer.getDevice();
    const pipeline = webgpuRenderer.getPipeline();

    // Create the WebGPU render strategy
    const webGPURenderStrategy = new WebGPURenderStrategy(device, pipeline);

    // Create the scene graph
    const sceneGraph = new SceneGraph(webGPURenderStrategy);

    // Create a rectangle with the WebGPU render strategy

    const rect = new Rectangle(webGPURenderStrategy, 100, 50, 'red', 'black', 2);
    rect.x = 150;
    rect.y = 100;

    // Add the rectangle to the scene graph
    sceneGraph.root.addChild(rect);

    // Start the rendering loop
    function renderLoop() {
        webgpuRenderer.render(sceneGraph);
        requestAnimationFrame(renderLoop);
    }
    renderLoop();
}

main();

/*

///////////////////////////////////////////////////////////////////////////
CANVAS
///////////////////////////////////////////////////////////////////////////

import { SceneGraph } from './scene-graph/scene-graph';
import { Rectangle } from './scene-graph/rectangle';
import { CanvasRenderer } from './renderer/canvas-renderer';
import { CanvasRenderStrategy } from './renderer/canvas-render-strategy';

// Set up the canvas
const canvas = document.getElementById('myCanvas') as HTMLCanvasElement;
canvas.width = 800;
canvas.height = 600;

// Create the scene graph
const sceneGraph = new SceneGraph();

// Create the canvas render strategy
const canvasRenderStrategy = new CanvasRenderStrategy();

// Create a rectangle
const rect = new Rectangle(canvasRenderStrategy, 100, 50, 'red', 'black', 2);
rect.x = 150;
rect.y = 100;

// Add a click event to change the color of the rectangle
rect.onClick = () => {
    rect.fillColor = rect.fillColor === 'red' ? 'green' : 'red';
    console.log("Rectangle clicked! Color changed.");
};

// Add the rectangle to the scene graph
sceneGraph.root.addChild(rect);

// Create the renderer
const renderer = new CanvasRenderer(canvas, sceneGraph);

// Start the rendering loop manually
renderer.start();

/////////////////////////////////////////////////////////////////////////////
WEBGPU
/////////////////////////////////////////////////////////////////////////////

// src/main.ts
import { SceneGraph } from './scene-graph/scene-graph';
import { Rectangle } from './scene-graph/rectangle';
import { WebGPURenderer } from './renderer/webgpu-renderer';
import { WebGPURenderStrategy } from './rendering/webgpu-render-strategy';

async function main() {
    // Set up the canvas and WebGPURenderer
    const canvas = document.getElementById('myCanvas') as HTMLCanvasElement;
    const webgpuRenderer = new WebGPURenderer(canvas);
    await webgpuRenderer.initialize();

    const device = webgpuRenderer.getDevice();
    const pipeline = webgpuRenderer.getPipeline();

    // Create the scene graph
    const sceneGraph = new SceneGraph();

    // Create the WebGPU render strategy
    const webGPURenderStrategy = new WebGPURenderStrategy(device, pipeline);

    // Create a rectangle with the WebGPU render strategy
    const rect = new Rectangle(webGPURenderStrategy, 100, 50, 'red', 'black', 2);
    rect.x = 150;
    rect.y = 100;

    // Add the rectangle to the scene graph
    sceneGraph.root.addChild(rect);

    // Start the rendering loop
    function renderLoop() {
        webgpuRenderer.render(sceneGraph);
        requestAnimationFrame(renderLoop);
    }
    renderLoop();
}

main();

*/