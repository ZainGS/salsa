import { SceneGraph } from "../scene-graph/scene-graph";
import { WebGPURenderStrategy } from "./render-strategies/webgpu-render-strategy";
import { Node } from "../scene-graph/node";
import { InteractionService } from '../services/interaction-service';
import { mat4, vec3 } from "gl-matrix";
import { Shape } from "../scene-graph/shapes/shape";

// src/renderer/webgpu-renderer.ts
export class WebGPURenderer {

    // Core Setup
    private canvas: HTMLCanvasElement;
    private device!: GPUDevice;
    private context!: GPUCanvasContext;
    private shapePipeline!: GPURenderPipeline;
    private backgroundPipeline!: GPURenderPipeline;
    private boundingBoxPipeline!: GPURenderPipeline;
    private swapChainFormat: GPUTextureFormat = 'bgra8unorm';

    // User-Application State
    private interactionService: InteractionService;
    private isPanning: boolean = false;
    private isDragging: boolean = false;
    private isRotating: boolean = false;
    
    private initialMouseAngle: number = 0;
    private initialShapeRotation: number = 0;
    private lastMousePosition: { x: number, y: number } | null = null;
    private lastRenderTime: number = 0;
    private renderThrottleTime: number = 8; // 16 ms for ~60 FPS

    // Shape & World 
    private sceneGraph!: SceneGraph;
    private selectedNode: Node | null = null;
    private dragOffsetX: number = 0;
    private dragOffsetY: number = 0;

    // Multisample Anti-Aliasing
    private msaaTexture!: GPUTexture;
    private msaaTextureView!: GPUTextureView;
    private sampleCount: number = 1; // 4x MSAA

    constructor(canvas: HTMLCanvasElement, interactionService: InteractionService) {
         
        // Core Setup
        this.canvas = canvas;
        this.interactionService = interactionService;

        // Mouse Event Listeners
        this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
        this.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
        this.canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));
        this.canvas.addEventListener('wheel', this.handleWheel.bind(this));
    }

    // Method to get the GPUDevice
    public getDevice(): GPUDevice {
        return this.device;
    }

    // Method to get the Shape GPURenderPipeline
    public getShapePipeline(): GPURenderPipeline {
        return this.shapePipeline;
    }

    // Method to get the Bounding Box GPURenderPipeline
    public getBoundingBoxPipeline(): GPURenderPipeline {
        return this.boundingBoxPipeline;
    }
    
    public setSceneGraph(sceneGraph: SceneGraph) {
        this.sceneGraph = sceneGraph;
    }

    private handleWheel(event: WheelEvent) {
        if (event.ctrlKey) {

            // Prevent the default zoom behavior in the browser
            event.preventDefault(); 

            // Invert to zoom in on scroll up
            const zoomDelta = event.deltaY * -0.001; 
    
            // Get mouse position relative to the canvas center (screen-space origin)
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = event.clientX - rect.right/2;
            const mouseY = event.clientY - rect.bottom/2;
    
            // Adjust the zoom factor and pan offset
            this.interactionService.adjustZoom(zoomDelta, mouseX, mouseY);
            
            if(this.selectedNode) {
                (this.selectedNode as Shape).triggerRerender();
            }

            // Re-render the scene
            this.render();
        }
    }

    private isMouseNearCorner(mouseX: number, mouseY: number, boundingBox: { x: number; y: number; width: number; height: number }): boolean {
        const corners = [
            { x: boundingBox.x, y: boundingBox.y }, // Top-left
            { x: boundingBox.x + boundingBox.width, y: boundingBox.y }, // Top-right
            { x: boundingBox.x, y: boundingBox.y + boundingBox.height }, // Bottom-left
            { x: boundingBox.x + boundingBox.width, y: boundingBox.y + boundingBox.height }, // Bottom-right
        ];
        
        const threshold = 5; // Adjust this value as needed
    
        return corners.some(corner => {
            const distance = Math.sqrt(Math.pow(mouseX - corner.x, 2) + Math.pow(mouseY - corner.y, 2));
            return distance <= threshold;
        });
    }

    private calculateMouseAngle(mouseX: number, mouseY: number, shape: Shape): number {
        const centerX = shape.x;
        const centerY = shape.y;
    
        return Math.atan2(mouseY - centerY, mouseX - centerX);
    }

    private handleMouseDown(event: MouseEvent) {
        
        switch(event.button) {
            
            // LEFT MOUSE BUTTON
            case 0: 
                // ROTATING SHAPE
                if (this.selectedNode && this.isMouseNearCorner(event.offsetX, event.offsetY, (this.selectedNode as Shape).boundingBox)) {
                    
                    this.isRotating = true;

                    // SET STARTING ROTATION STATE
                    this.initialMouseAngle = this.calculateMouseAngle(event.offsetX, event.offsetY, (this.selectedNode as Shape));
                    this.initialShapeRotation = this.selectedNode.rotation;
                }
                // DRAGGING SHAPE
                else {

                    this.isDragging = true;
    
                    // (CANVAS SPACE)
                    // Get Mouse Coordinates from MouseEvent 
                    const x = event.offsetX;
                    const y = event.offsetY;
            
                    // (MODEL SPACE CLICK)
                    // Transform the mouse coordinates back to model space.
                    const [transformedX, transformedY] = this.transformMouseCoordinates(x, y);
                    
                    // Find the shape under the mouse
                    var newSelectedNode = this.findNodeUnderMouse(transformedX, transformedY);
                    if(newSelectedNode != this.selectedNode){
                        if(this.selectedNode) {
                            (this.selectedNode as Shape).deselect();
                        }
                        this.selectedNode = newSelectedNode;
                    }
    
                    // Calculate the offset between the mouse position and the shape's position
                    if (this.selectedNode) {
                        (this.selectedNode as Shape).select();
                        this.dragOffsetX = transformedX - this.selectedNode.x;
                        this.dragOffsetY = transformedY - this.selectedNode.y;
                    }
                }
                return
            
            // MIDDLE MOUSE BUTTON
            case 1:
                // PANNING WORLD
                this.isPanning = true;
                
                // Set initial mouse state + Prevent default middle-click behavior (auto-scroll)
                this.lastMousePosition = { x: event.clientX, y: event.clientY };
                event.preventDefault(); 
                return
        }
    }

    /* About Transformed Mouse Coordinates:
    The transformMouseCoordinates method takes the mouse coordinates and transforms them from 
    screen space into the shape's coordinate space using the inverse of the worldMatrix. This allows the 
    click detection to occur in the correct space relative to the transformed shapes.

    By inverting the worldMatrix, you effectively reverse the scaling, translation, and any other 
    transformations applied to the shapes, mapping the mouse position back to the original coordinate space of the shapes.

    The transformed coordinates are then used to detect which shape is being clicked and to calculate the offset for dragging.
    -------------------------------------------------------------------------------------------------------------------------*/
    private transformMouseCoordinates(x: number, y: number): [number, number] {
        
        // (MODEL SPACE MATRIX) [Pre-Transformations "Model" Space]
        // Get the inverse of the world matrix
        const inverseWorldMatrix = mat4.create();
        mat4.invert(inverseWorldMatrix, this.interactionService.getWorldMatrix());
    
        // (NDC SPACE CLICK)
        // Convert screen space (x, y) to NDC (-1 to 1)
        const ndcX = (x / this.canvas.width) * 2 - 1;
        const ndcY = (y / this.canvas.height) * -2 + 1;
    
        // (MODEL SPACE CLICK) [Pre-Transformation "Model" Space]
        // Apply the inverse transformation
        const transformed = vec3.fromValues(ndcX, ndcY, 0);
        vec3.transformMat4(transformed, transformed, inverseWorldMatrix);
    
        // Return the transformed coordinates (in original, untransformed world space)
        // You could say this is the same as "pre-transformed world space", because
        // the point we output has not been affected by world transformations due to the inverse
        // matrix. It's like we went back in time and clicked the OG spot. This "space" lets us more 
        // efficiently handle hit detection. 
        return [transformed[0], transformed[1]];
    }
    
    // For panning
    private handleMouseMove(event: MouseEvent) {
        const mouseX = event.offsetX;
        const mouseY = event.offsetY;

        // Skip this frame if rendering is throttled
        const currentTime = Date.now();
        if (currentTime - this.lastRenderTime < this.renderThrottleTime) {
            return; 
        }
    
        // Handle based on state from Mouse Down
        // PANNING WORLD
        if (this.isPanning && this.lastMousePosition) {
            
            // Panning logic
            const dx = event.clientX - this.lastMousePosition.x;
            const dy = event.clientY - this.lastMousePosition.y;
    
            this.interactionService.adjustPan(dx, dy);
    
            this.lastMousePosition = { x: event.clientX, y: event.clientY };
            // Re-render the scene with the updated panOffset
            this.render();
        } 
        // DRAGGING SHAPE
        else if (this.isDragging && this.selectedNode) {

            // Node movement logic
            const rect = this.canvas.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
    
            // Invert the world matrix to map the mouse position back to the original coordinate space
            const inverseWorldMatrix = mat4.create();
            mat4.invert(inverseWorldMatrix, this.interactionService.getWorldMatrix());
    
            // Create a vector for the mouse position and transform it using the inverse world matrix
            const point = vec3.fromValues((x / this.canvas.width) * 2 - 1, (y / this.canvas.height) * -2 + 1, 0);
            vec3.transformMat4(point, point, inverseWorldMatrix);
            
            // Update the position of the selected shape based on the transformed mouse position
            this.selectedNode.x = point[0] - this.dragOffsetX;
            this.selectedNode.y = point[1] - this.dragOffsetY;
            
            // Re-render the scene with the updated node position
            this.render();
        }
        // ROTATING SHAPE
        else if(this.isRotating) {
            const currentMouseAngle = this.calculateMouseAngle(event.offsetX, event.offsetY, (this.selectedNode as Shape));
            const angleDifference = currentMouseAngle - this.initialMouseAngle;
            (this.selectedNode as Shape).rotation = this.initialShapeRotation + angleDifference;

            (this.selectedNode as Shape).updateLocalMatrix(); // Update the transformation matrix
            (this.selectedNode as Shape).markDirty(); // Trigger a re-render
        }
        else {
            if((this.selectedNode as Shape)?.boundingBox) {
                if (this.isMouseNearCorner(mouseX, mouseY, (this.selectedNode as Shape).boundingBox)) {
                    this.canvas.style.cursor = 'grab'; // Use your custom rotate cursor
                } else {
                    this.canvas.style.cursor = 'default';
                }
            }
        }
        
        if(this.selectedNode) {
            (this.selectedNode as Shape).triggerRerender();
        }
        
        this.lastRenderTime = currentTime;
    }

    private handleMouseUp(event: MouseEvent) {
        
        // Middle mouse button
        if (event.button === 1) { 
            this.isPanning = false;
            this.lastMousePosition = null;
        }
        else if (event.button === 0) {
            this.isDragging = false;
            this.isRotating = false;
        }
    }

    // Non-normalized, pixel-space coordinates for hit detection.
    private findNodeUnderMouse(x: number, y: number): Node | null {
        
        // Iterate through your scene graph and check if the x, y is within the bounds of any node.
        for (const node of this.sceneGraph.root.children) {
            if (node.containsPoint(x, y)) {
                return node;
            }
        }
        return null;
    }

    // Starting point of WebGPU Setup & Rendering Loop
    public async initialize() {
        await this.initWebGPU();
        this.createBackgroundRenderPipeline();
        this.createShapeRenderPipeline();
        this.createBoundingBoxPipeline();
    }

    private async initWebGPU() {
        
        /* About WebGPU and the navigator.gpu check:
        'navigator' is a property of the global 'window' object of the web browser that provides 
        information about the state of the browser. It includes various properties and methods, like 
        navigator.userAgent or navigator.gpu. When you write navigator.gpu, you're implicitly accessing 
        window.navigator.gpu. The browser's access to the GPU object is facilitated by the WebGPU API, 
        a modern graphics API that allows web applications to directly interact with the GPU for 
        high-performance graphics and compute tasks. The navigator.gpu property is the entry point for the 
        WebGPU API. It provides a GPU object, which you can use to access the GPU capabilities of the user's device.
        This object allows you to create GPU devices, command queues, buffers, textures, shaders, and other resources 
        necessary for rendering graphics or performing compute operations. The browser implements the WebGPU API, including 
        the navigator.gpu interface. This implementation interacts with the underlying operating system's graphics drivers to 
        communicate with the GPU.

        Remember that the browser acts as an abstraction layer between the web application and the underlying graphics hardware. 
        When you call functions on the GPU object, the browser translates these into lower-level graphics API calls 
        (like Vulkan, Direct3D, or Metal) that are executed by the GPU.
        --------------------------------------------------------------------------------------------------------------------------*/
        if (!navigator.gpu) { throw new Error("WebGPU is not supported on this browser."); }

        /* About the GPUAdapter:
           The GPUAdapter is an interface that provides information about the GPU hardware and 
           allows us to request a GPUDevice to perform rendering or compute operations.
           Not all devices or browsers support WebGPU. By checking for the availability of a GPUAdapter, 
           the application can handle cases where WebGPU isn't supported and potentially provide fallbacks 
           (a different rendering strategy) or inform the user.
        ---------------------------------------------------------------------------------------------------------------------------*/
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) { throw new Error("Failed to request WebGPU adapter."); }
        this.device = await adapter.requestDevice();

        /* About GPUCanvasContext:
        Retrieves the WebGPU rendering context for the canvas. This context is specifically designed to allow 
        WebGPU commands to render content onto a <canvas> element.  The context returned is cast to GPUCanvasContext, 
        which is a special type of context for managing the WebGPU rendering pipeline.

        The canvas context is the bridge between the WebGPU rendering pipeline and the HTML canvas. 
        It’s where the WebGPU commands will output the rendered content.

        Note: The swap chain format we use is bgra8unorm ("blue-green-red-alpha with 8 bits per channel and normalized values"). 
        The swap chain format determines how the image data is represented in memory before being displayed on the screen.
        Also, alphaMode: 'premultiplied' is used. This setting indicates how the alpha channel (transparency) is handled. 
        'premultiplied' means that the color values have already been multiplied by the alpha value, which is a common way of 
        handling transparency in rendering.
        --------------------------------------------------------------------------------------------------------------------------*/
        this.context = this.canvas.getContext('webgpu') as GPUCanvasContext;
        this.context.configure({
            device: this.device,
            format: this.swapChainFormat,
            alphaMode: 'premultiplied',
        });

        /* About GPUTextureView and MSAA: 
           Below we set up a texture on the GPU that will be used specifically for MSAA rendering. 
           This texture will hold multiple samples per pixel, according to the sampleCount, to smooth out the final rendered image.
           After creating the texture, the createView call sets up a GPUTextureView. This view is what we'll actually bind to our 
           render pipeline when we want to render content using MSAA. The view acts as a handle to the texture, allowing us to specify 
           how it will be used in rendering operations.

           When you render to the msaaTexture, each pixel in the texture is actually composed of multiple samples. 
           The GPU will calculate the final color of each pixel by averaging these samples.
           Once rendering is complete, the final image with reduced aliasing is typically resolved into a non-MSAA texture 
           (such as the swap chain texture) that can be displayed on the screen.
        ----------------------------------------------------------------------------------------------------------------------------*/
        /*
        this.msaaTexture = this.device.createTexture({
            size: [this.canvas.width, this.canvas.height],
            sampleCount: this.sampleCount,
            format: this.swapChainFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.msaaTextureView = this.msaaTexture.createView();
        */
    }

    public render() {
        // Scale MSAA texture to current canvas if resized
        // this.ensureCanvasSizeAndTextures();
    
        /* About the GPUCommandEncoder:
           Throughout our rendering code, we will be recording commands (like setting pipelines, 
           drawing objects) into a GPUCommandEncoder; These commands are stored in a command buffer.
           After all commands are recorded, this.device.queue.submit([commandEncoder.finish()]); 
           will submit this GPUCommandBuffer to the GPU's command queue for execution. 
           That is the point where the GPU actually starts processing the commands and performing the rendering.
        -------------------------------------------------------------------------------------------/-----------*/
        const commandEncoder = this.device.createCommandEncoder();    
        const textureView = this.context.getCurrentTexture().createView();
        const renderPassDescriptor: GPURenderPassDescriptor = {
            colorAttachments: [{
                view: textureView,
                // view: this.msaaTextureView, // Use MSAA texture view
                // resolveTarget: textureView, // Resolve to the default swap chain texture
                loadOp: 'clear',
                clearValue: { r: 1, g: 1, b: 1, a: 1 },
                storeOp: 'store',
            }],
        };

        /* About the GPURenderPassEncoder (for batching draw calls):
           The GPURenderPassEncoder represents a single render pass, which is a period 
           where you're issuing draw commands to the GPU to render to a particular framebuffer (like the canvas).
           During a single render pass, you can issue multiple draw commands (like drawing different shapes) 
           using the same passEncoder. This is efficient because it avoids the overhead of 
           starting and ending multiple render passes for each shape.
        
           Within a single render pass, you can switch pipelines and bind groups as needed. For example, 
           if different shapes require different shaders or uniform data, you can switch the pipeline or 
           bind group before each draw call.

           The commands I issue in the GPURenderStrategy (setPipeline, setBindGroup, setVertexBuffer, 
           and setIndexBuffer) are essentially configuring the GPU state before drawing each shape.

           The passEncoder accumulates the drawing commands, and they are only executed once the render pass 
           ends below. This allows us to efficiently batch multiple draw calls into a single render pass.

           Basically, by using the same passEncoder, we minimize the overhead associated with starting and 
           ending multiple render passes. Thus, we keep all related draw calls within a single render pass.
        --------------------------------------------------------------------------------------------------*/
        const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);

        // Render the background with a dot pattern (uses the background pipeline).
        this.renderBackground(passEncoder);
    
        // Render shapes (uses the shape pipeline).
        this.renderShapes(passEncoder);
    
        // End the current render pass and submit all the recorded GPU commands (for   
        // rendering to our specific framebuffer: the canvas) to the GPU for execution.
        passEncoder.end();
        this.device.queue.submit([commandEncoder.finish()]);
    }

    private ensureCanvasSizeAndTextures() {
        const currentTexture = this.context.getCurrentTexture();
        const canvasWidth = currentTexture.width;
        const canvasHeight = currentTexture.height;
    
        if (!this.msaaTexture || this.msaaTexture.width !== canvasWidth || this.msaaTexture.height !== canvasHeight) {
            this.msaaTexture = this.device.createTexture({
                size: [canvasWidth, canvasHeight],
                format: 'bgra8unorm',
                sampleCount: this.sampleCount,
                usage: GPUTextureUsage.RENDER_ATTACHMENT,
            });
            this.msaaTextureView = this.msaaTexture.createView();
        }
    }

    private renderShapes(passEncoder: GPURenderPassEncoder) {
        
        // Traverse scene graph and accumulate each shape's draw commands for  
        // the GPURenderPassEncoder (scoped to the Shape Pipeline) throughout 
        // the WebGPURenderStrategy.
        passEncoder.setPipeline(this.shapePipeline);
        this.sceneGraph.root.children.forEach(node => {
            const strategy = node.renderStrategy as WebGPURenderStrategy;
            strategy.render(node, passEncoder);
        });
    }

    private renderBackground(passEncoder: GPURenderPassEncoder) {
        
        passEncoder.setPipeline(this.backgroundPipeline); // Use background pipeline

        // Set up resolution uniform buffer (Pad to 16 bytes for alignment requirements [8 bytes of data, 16-byte alignment])
        const resolutionUniformData = new Float32Array([this.canvas.width, this.canvas.height, 0.0, 0.0]);
        const resolutionUniformBuffer = this.device.createBuffer({
            size: resolutionUniformData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(resolutionUniformBuffer, 0, resolutionUniformData.buffer);

        // World Matrix inversion to Local-Shape coordinate system
        let worldMatrix = this.interactionService.getWorldMatrix();
        let invertedWorldMatrix = mat4.create();
        const worldMatrixUniformData = mat4.invert(invertedWorldMatrix, worldMatrix) as Float32Array;
        const worldMatrixUniformBuffer = this.device.createBuffer({
            size: worldMatrixUniformData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(worldMatrixUniformBuffer, 0, worldMatrixUniformData.buffer);

        // Create a bind group with the uniform buffers
        const bindGroup = this.device.createBindGroup({
            layout: this.backgroundPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: resolutionUniformBuffer } },
                { binding: 1, resource: { buffer: worldMatrixUniformBuffer } }, 
            ],
        });
    
        // Use the full-screen quad vertex buffer
        const quadVertexBuffer = this.setupFullScreenQuad();
        passEncoder.setVertexBuffer(0, quadVertexBuffer);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.draw(6, 1, 0, 0); // Draw the full-screen quad
    }

    private setupFullScreenQuad() {
        const vertices = new Float32Array([
            -1.0, -1.0,  // First triangle
             1.0, -1.0,
            -1.0,  1.0,
             1.0, -1.0,  // Second triangle
             1.0,  1.0,
            -1.0,  1.0,
        ]);
    
        const vertexBuffer = this.device.createBuffer({
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX,
            mappedAtCreation: true,
        });
    
        new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
        vertexBuffer.unmap();
    
        return vertexBuffer;
    }

    private createShapeRenderPipeline() {

        /* About Shaders:
        Shaders are small programs that run on the GPU. They are used to process 
        vertices and pixels (fragments) to produce the final image you see on the screen.

        Vertex Shader: Processes each vertex of your geometry, transforming it from its original position to its final position on the screen.
        Fragment Shader: Processes each pixel that makes up the geometry, determining its color, transparency, and other properties.
        -------------------------------------------------------------------------------------------------------------------------------*/
        // WebGPU Shading Language [WGSL] Vertex Shader for shapes 
        const vertexShaderCode = `
    struct Uniforms {
        resolution: vec4<f32>,
        worldMatrix: mat4x4<f32>,
        localMatrix: mat4x4<f32>,
        shapeColor: vec4<f32>
    };

    @group(0) @binding(0) var<uniform> uniforms: Uniforms;

    @vertex
        fn main_vertex(@location(0) position: vec2<f32>) -> @builtin(position) vec4<f32> {
            // Calculate aspect ratio from the resolution
            let aspectRatio = uniforms.resolution.x / uniforms.resolution.y;

            // Apply aspect ratio correction
            let correctedPosition = vec2<f32>(position.x / aspectRatio, position.y);

            // Apply transformations using the local and world matrices
            let pos = uniforms.localMatrix * vec4<f32>(correctedPosition, 0.0, 1.0);
            let transformedPosition = uniforms.worldMatrix * pos;

            return transformedPosition;
        }
        `;
    
        // WebGPU Shading Language [WGSL] Fragment Shader for shapes 
        const shapeFragmentShaderCode = `
        struct Uniforms {
            resolution: vec4<f32>,
            worldMatrix: mat4x4<f32>,
            localMatrix: mat4x4<f32>,
            shapeColor: vec4<f32>
        };

        @group(0) @binding(0) var<uniform> uniforms: Uniforms;
    
        @fragment
        fn main_fragment() -> @location(0) vec4<f32> {
            return uniforms.shapeColor; // Simply output the shape's color
        }
        `;
    
        /* About Shader Modules:
           In WebGPU, shaders are compiled and managed through GPUShaderModule objects. 
           These shader modules are then used in a respective rendering pipeline to control how the GPU processes vertices and fragments. 
        --------------------------------------------------------------------------------------------------------------------------------*/
        const vertexShaderModule = this.device.createShaderModule({
            code: vertexShaderCode,
        });
    
        const fragmentShaderModule = this.device.createShaderModule({
            code: shapeFragmentShaderCode,
        });
    
        /* About GPUVertexBufferLayout 
           Our layout below describes a vertex buffer where each vertex consists of 2 floats (x and y coordinates), each 4 bytes. 
           These floats are packed together with no padding, so the total size of each vertex is 8 bytes.
           The data for each vertex starts immediately after the previous vertex's data ends, which is determined by the arrayStride.

           The vertex attribute (in this case, the position) is passed to the vertex shader at @location(0).
           The GPU will read the vertex data from the buffer, interpret each as two float32 values (based on the format), 
           and pass it to the shader for processing.

           This 'location' input in the vertex shader refers to the vertices' coordinates in the shape's local space.
           So for a rectangle, each position value passed to the shader is one of four local coordinates ([0,0], [1,0],
           [0,1], [1,1]]). The shader uses these positions to determine where each vertex of the rectangle should be placed in 
           world space after applying transformations (like translation, rotation, or scaling) via a "Local Matrix" and "World Matrix".
        ------------------------------------------------------------------------------------------------------------------------------*/
        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: 2 * 4,
            attributes: [
                {
                    shaderLocation: 0,
                    offset: 0,
                    format: 'float32x2',
                },
            ],
        };
    
        /* About BindGroupLayout and BindGroups
           A GPUBindGroupLayout describes the structure of a GPUBindGroup. 
           A GPUBindGroup is a collection of resources (such as buffers or textures) that are bound together and 
           made accessible to shaders during rendering. Each entry in the layout corresponds to a specific resource that 
           the shaders will use. The layout specifies how these resources are mapped to bindings within the shaders.
           By defining this layout, WebGPU can optimize the way resources are bound and accessed during rendering.

           Each binding corresponds to a specific @binding(n) in your shader code, where n is the binding number (0, 1, 2, or 3). 
           The layout ensures that the data is correctly mapped to the corresponding bindings in the shaders.

           The resources specified are uniform buffers, which means they hold data that doesn't change frequently during rendering 
           (like transformation matrices or constants). These buffers are typically small and can be accessed very efficiently by the GPU.
        ------------------------------------------------------------------------------------------------------------------*/
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0, // All uniform data packed into one buffer
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' }
                }
            ]
        });
    
        /* About GPUPipelineLayout:         
           The GPUPipelineLayout defines the overall structure of how resources are organized in 
           the GPU pipeline. It links the shaders with the resources they need to execute.
           The pipeline layout doesn't hold the actual data or resources; instead, it describes 
           how the data will be organized and bound during rendering. 
        --------------------------------------------------------------------------------------------*/
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout]
        });
    
        /* About GPURenderPipeline:
           This GPURenderPipeline defines how vertices are processed, how fragments (pixels)  
           are shaded, and how the final image is rendered to the screen.

           Note: The primitive object specifies how the vertices are assembled into geometric primitives.
           topology: 'triangle-list' indicates that the vertices will be grouped into triangles. Each set of 
           three vertices defines one triangle. This is the most common primitive topology used in rendering, 
           as complex shapes can be represented as a collection of triangles.
         ----------------------------------------------------------------------------------------------------*/
        this.shapePipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: vertexShaderModule,
                entryPoint: 'main_vertex',
                buffers: [vertexBufferLayout],
            },
            fragment: {
                module: fragmentShaderModule,
                entryPoint: 'main_fragment',
                targets: [{ 
                    format: this.swapChainFormat,
                 }],
            },
            primitive: { topology: 'triangle-list' },
            multisample: {
                count: this.sampleCount, // Ensure the sample count matches MSAA settings
            },
        });
    }

    private createBackgroundRenderPipeline() {
        
        // Vertex Shader (for full-screen quad)
        const vertexShaderCode = `
        @vertex
        fn main_vertex(@location(0) position: vec2<f32>) -> @builtin(position) vec4<f32> {
            return vec4<f32>(position, 0.0, 1.0);  // Create the final position vector
        }
        `;
    
        // Fragment Shader (for dot pattern)
        const fragmentShaderCode = `
        @group(0) @binding(0) var<uniform> resolution: vec4<f32>;
        @group(0) @binding(1) var<uniform> worldMatrix: mat4x4<f32>;

        @fragment
        fn main_fragment(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
            // Convert fragment coordinates to UV coordinates (0 to 1)
            var uv = fragCoord.xy / resolution.xy;

            // Flip the Y-axis by inverting the Y coordinate
            uv.y = 1.0 - uv.y;

            // Apply panning by adjusting the UV coordinates with the pan offset (handled in worldMatrix)
            // No inverse scaling is applied, allowing the worldMatrix to affect UVs directly
            var transformedUV = (worldMatrix * vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0)).xy * 0.5 + 0.5;

            // Adjust the spacing in the x direction by the aspect ratio
            let aspectRatio = resolution.x / resolution.y;
            let adjustedUv = vec2<f32>(transformedUV.x * aspectRatio, transformedUV.y);

            // Control the size and spacing of dots
            let dotSize = 0.0650; // Adjust dot size if needed
            let spacing = 0.03125;  // Adjust spacing if needed

            // Calculate the position of the dot
            let dot = fract(adjustedUv / spacing) - vec2(0.5);
            let dist = length(dot);

            // Use step function to make the dots visible
            let insideDot = step(dist, dotSize); // 1.0 inside the dot, 0.0 outside

            // Background color
            let backgroundColor = vec4<f32>(1, 1, 1, 1.0);

            // Dot color
            let dotColor = vec4<f32>(0.90, 0.90, 0.90, 1);

            // Choose between dot color and background color based on insideDot
            let color = mix(backgroundColor, dotColor, insideDot);

            // Output the final color
            return color;
        }
        `;
    
        // Create the shader modules
        const vertexShaderModule = this.device.createShaderModule({
            code: vertexShaderCode,
        });
    
        const fragmentShaderModule = this.device.createShaderModule({
            code: fragmentShaderCode,
        });
    
        // Define the vertex buffer layout for full-screen quad (no attributes needed)
        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: 2 * 4, // 2 floats per vertex, 4 bytes per float
            attributes: [
                {
                    shaderLocation: 0,
                    offset: 0,
                    format: 'float32x2',
                },
            ],
        };
    
        // Define the bind group layout
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0, // Matches resolution uniform in the shader
                    visibility: GPUShaderStage.FRAGMENT, // Both stages need access
                    buffer: { type: 'uniform' }
                },
                {
                    binding: 1, // Matches worldMatrix uniform in the shader
                    visibility: GPUShaderStage.FRAGMENT, // Ensure panOffset is visible to the vertex shader
                    buffer: { type: 'uniform' },
                },
            ]
        });
    
        // Create the pipeline layout using the bind group layout
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout]
        });
    
        // Create the pipeline for the background
        this.backgroundPipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: vertexShaderModule,
                entryPoint: 'main_vertex',
                buffers: [vertexBufferLayout],
            },
            fragment: {
                module: fragmentShaderModule,
                entryPoint: 'main_fragment',
                targets: [{ 
                    format: this.swapChainFormat,
                 }],
            },
            primitive: { topology: 'triangle-list' },
            multisample: {
                count: this.sampleCount, // Ensure the sample count matches MSAA settings
            },
        });
    }

    private createBoundingBoxPipeline() {
        const vertexShaderCode = `
            @vertex
            fn main_vertex(@location(0) position: vec2<f32>) -> @builtin(position) vec4<f32> {
                return vec4<f32>(position, 0.0, 1.0);
            }
        `;
    
        const fragmentShaderCode = `
            @fragment
            fn main_fragment() -> @location(0) vec4<f32> {
                return vec4<f32>(0.55, 0.55, 1.0, 1.0); // Blue color
            }
        `;
    
        const vertexShaderModule = this.device.createShaderModule({ code: vertexShaderCode });
        const fragmentShaderModule = this.device.createShaderModule({ code: fragmentShaderCode });
    
        this.boundingBoxPipeline = this.device.createRenderPipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [] }),
            vertex: {
                module: vertexShaderModule,
                entryPoint: 'main_vertex',
                buffers: [{
                    arrayStride: 2 * 4,
                    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }]
                }]
            },
            fragment: {
                module: fragmentShaderModule,
                entryPoint: 'main_fragment',
                targets: [{ format: this.swapChainFormat }]
            },
            primitive: { 
                topology: 'line-strip',
                stripIndexFormat: 'uint16', // Ensure you define the strip index format
            },
            multisample: {
                count: this.sampleCount, // Set this to 4 to match your render pass
            },
        });
    }

}