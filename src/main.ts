// src/main.ts
import { Renderer } from './renderer/renderer';
import { SceneGraph } from './scene-graph/scene-graph';
import { Rectangle } from './scene-graph/rectangle';

// Set up the canvas
const canvas = document.getElementById('myCanvas') as HTMLCanvasElement;
canvas.width = 800;
canvas.height = 600;

// Create the scene graph
const sceneGraph = new SceneGraph();

// Create a rectangle
const rect = new Rectangle(100, 50, 'red', 'black', 2);
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
const renderer = new Renderer(canvas, sceneGraph);

// Start the rendering loop manually
renderer.start();