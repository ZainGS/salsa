# Salsa Vector Renderer

**Salsa** is a high-performance vector rendering library designed to support both WebGPU and Canvas, with plans to implement WebGL2 as an upgraded fallback. It is built with flexibility in mind, allowing developers to seamlessly transition between different rendering technologies while maintaining consistent functionality.

**WebGPU**, as of 2024, is still relatively new but has been making significant progress toward stability. It is supported in most major browsers, including Chrome, Edge, and Firefox, with ongoing development to improve compatibility and performance. 
The API has reached a stage where it's considered stable enough for production use in many cases, **but since it’s a modern technology, there are still some areas where a developer might encounter limitations or the need for workarounds**, especially 
concerning cross-platform compatibility and hardware support.

![image](https://github.com/user-attachments/assets/c97425fe-dfe7-47f2-ac52-b9acc4b6ff8f)




WebGPU offers a lot of potential for high-performance graphics **and compute operations** directly in the browser, making it a strong candidate for future-proofing web applications, 
particularly in graphics-heavy scenarios like games, simulations, **and tools similar to my Frogmarks design application project**. 
However, while WebGPU offers significant improvements upon WebGL (which is based on OpenGL for Embedded Systems [ES]), implementations of the standard and API are quite young. 
**It’s advisable to thoroughly test across the platforms and devices we intend to support.**

As this library is integrating WebGPU capability, **fallback paths** should also be maintained, like WebGL2, to ensure broader compatibility as WebGPU continues to mature.
For the sake of streamlining the path to an MVP (minimum viable product), **Salsa will be developed to integrate WebGPU and the Canvas API in parallel, after which the Canvas fall-back
mechanism will be replaced with an upgraded WebGL2 implementation**.

## Features

* **WebGPU Rendering:** Salsa is optimized to leverage the power of WebGPU for high-performance vector rendering, taking advantage of modern GPU capabilities.

* **Canvas Fallback:** Initially supports Canvas rendering for broader compatibility. This fallback is set to be upgraded to WebGL2 for enhanced performance.

* **Modular Architecture:** Salsa is designed with a modular approach, enabling easy integration and customization within your applications.

* **Shape Management:** The library includes a shape.ts base class that handles shared properties, triggering re-renders from a centralized location.
**The render implementation that is used is dependent on the RenderStrategy passed into the shape;** e.g. WebGPURenderStrategy, CanvasRenderStrategy, etc.

* **Custom Renderer:** Unlike other vector rendering libraries, Salsa is built to provide a fully custom rendering experience tailored to your application's needs.

## Installation

To include Salsa in your project, you can install it via npm **(once published)**:

```bash
npm install @frogmarks/salsa
```

Alternatively, if you would like the feature-branch instead of main (for development/testing, **once published**):

```bash
npm install @zain/salsa
```

## Usage

Here's a basic example of how to use Salsa to render a simple shape:

```typescript

import { Salsa } from '@frogmarks/salsa';
// Initialize the renderer
const salsa = new Salsa({
  target: document.getElementById('canvas'),
  mode: 'webgpu', // or 'canvas', 'webgl2'
});

// Create a shape
const shape = salsa.createShape('rectangle', {
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  fillColor: '#3498db',
});

// Render the shape
salsa.render(shape);
```

## API Documentation

**Salsa**

* **constructor(options: SalsaOptions):** Initializes the Salsa renderer with the provided options.

* **createShape(type: string, props: ShapeProps):** Creates a new shape of the specified type with the given properties.

* **render(shape: Shape):** Renders the specified shape using the active rendering mode.

**ShapeProps**

* **x: number:** The x-coordinate of the shape.
* **y: number:** The y-coordinate of the shape.
* **width: number:** The width of the shape.
* **height: number:** The height of the shape.
* **fillColor: string:** The fill color of the shape.

**Supported Shapes**
* **line:** A basic line.
* **rectangle:** A basic rectangle shape.
* **circle:** A circle shape (to be implemented).
* **polygon:** A polygon shape (to be implemented).
* **text rendering:** Basic text rendering/kerning/etc. (to be implemented).

## Roadmap

**WebGL2 Fallback:** Upgrade the Canvas fallback to WebGL2 for better performance and broader compatibility.

**Expanded Shape Support:** Add support for more shapes like circles, polygons, and custom paths.

**Advanced Rendering Techniques:** Implement features like anti-aliasing, gradients, and shadow effects.

**Performance Optimization:** Continually optimize the rendering pipeline to reduce overhead and improve rendering speed.

## Contributing

Contributions are welcome, please feel free to submit issues and pull requests on the GitHub repository.

## License

Salsa is licensed under the MIT License. See the LICENSE file for more details.

## Acknowledgments

This project is inspired by the need for a flexible and modern vector rendering solution that can adapt to the latest web technologies.

<p align="center">
  <img src="https://github.com/user-attachments/assets/b67d9d61-8254-4a51-aeee-157c7f14190c" />
</p>
