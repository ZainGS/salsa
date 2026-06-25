// pipeline-manager.ts
export class PipelineManager {
    private device: GPUDevice;
    private swapChainFormat: GPUTextureFormat = 'bgra8unorm';
    private sampleCount: number = 1; // 4x MSAA

    private shapePipeline!: GPURenderPipeline;
    private linePipeline!: GPURenderPipeline;
    private scribblePipeline!: GPURenderPipeline;
    private stagingLinePipeline!: GPURenderPipeline;
    private stagingHighlightPipeline!: GPURenderPipeline;
    private texturedPipeline!: GPURenderPipeline;
    private rasterPipeline!: GPURenderPipeline;
    private highlightPipeline!: GPURenderPipeline;
    private textPipeline!: GPURenderPipeline;
    private caretPipeline!: GPURenderPipeline;
    private selectionHighlightPipeline!: GPURenderPipeline;
    private overlayDotPipeline!: GPURenderPipeline;
    private backgroundPipeline!: GPURenderPipeline;
    private gridOverlayPipeline!: GPURenderPipeline;
    private boundingBoxPipeline!: GPURenderPipeline;
    private sdfTextPipeline!: GPURenderPipeline;

    private texturedBGL!: GPUBindGroupLayout;
    private texturedSampler!: GPUSampler;
  
    constructor(device: GPUDevice) {
        this.device = device;

        this.createBackgroundRenderPipeline();
        this.createGridOverlayRenderPipeline();
        this.createShapeRenderPipeline();
        this.createBoundingBoxPipeline();
        this.createLineRenderPipeline();
        this.createScribbleRenderPipeline();
        this.createStagingLinePipeline();
        this.createTextRenderPipeline();
        this.createCaretRenderPipeline();
        this.createSelectionHighlightPipeline();
        this.createOverlayDotPipeline();
        this.createHighlightRenderPipeline();
        this.createStagingHighlightPipeline();
        this.createPatternRenderPipeline();
        this.createSdfTextRenderPipeline();
        this.createRasterRenderPipeline();

        this.texturedSampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "repeat",
        addressModeV: "repeat",
        });
    }

    public getTexturedSampler() { return this.texturedSampler; }

    public getShapePipeline(): GPURenderPipeline {
        return this.shapePipeline;
    }

    public getLinePipeline(): GPURenderPipeline {
        return this.linePipeline;
    }

    public getScribblePipeline(): GPURenderPipeline {
        return this.scribblePipeline;
    }

    public getStagingLinePipeline(): GPURenderPipeline {
        return this.stagingLinePipeline;
    }

    public getHighlightPipeline(): GPURenderPipeline {
        return this.highlightPipeline;
    }

    public getStagingHighlightPipeline(): GPURenderPipeline {
        return this.stagingHighlightPipeline;
    }

    public getTexturedPipeline(): GPURenderPipeline {
        return this.texturedPipeline;
    }

    public getRasterPipeline(): GPURenderPipeline {
        return this.rasterPipeline;
    }

    public getBoundingBoxPipeline(): GPURenderPipeline {
        return this.boundingBoxPipeline;
    }

    public getTextPipeline(): GPURenderPipeline {
        return this.textPipeline;
    }

    public getCaretPipeline(): GPURenderPipeline {
        return this.caretPipeline;
    }

    public getSelectionHighlightPipeline(): GPURenderPipeline {
        return this.selectionHighlightPipeline;
    }

    public getOverlayDotPipeline(): GPURenderPipeline {
        return this.overlayDotPipeline;
    }

    public getBackgroundPipeline(): GPURenderPipeline {
        return this.backgroundPipeline;
    }

    public getGridOverlayPipeline(): GPURenderPipeline {
        return this.gridOverlayPipeline;
    }
  
    public getSdfTextPipeline(): GPURenderPipeline {
        return this.sdfTextPipeline;
    }

    private createSdfTextRenderPipeline() {
        
        // VERTEX SHADER CODE
        const vertexShaderCode = `
            struct Uniforms {
                resolution: vec4<f32>,
                worldMatrix: mat4x4<f32>,
                localMatrix: mat4x4<f32>,
                shapeColor: vec4<f32>,
                fontSize: f32,
                sdfThreshold: f32,
                smoothing: f32,
                outlineWidth: f32,
                outlineColor: vec4<f32>,
                // padding to reach 64 floats (256 bytes)
                padding1: vec4<f32>, // 16 bytes
                padding2: vec4<f32>, // 16 bytes
                padding3: vec4<f32>, // 16 bytes
                padding4: vec4<f32>, // 16 bytes
            };

            @group(0) @binding(0)
            var<storage, read> u_sdfTextShapes : array<Uniforms>;

            struct VertexInput {
                @location(0) position: vec2<f32>,
                @location(1) uv: vec2<f32>
            };

            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) uv: vec2<f32>,
                @location(1) @interpolate(flat) instanceIndex: u32
            };

            @vertex
            fn vs_main(
                in : VertexInput,
                @builtin(instance_index) instanceIndex : u32
            ) -> VertexOutput {
                let uni = u_sdfTextShapes[instanceIndex];
                
                // (x,-y)  ⇢  screen’s Y-down convention for the atlas quad
                var p = vec4<f32>(in.position.x, -in.position.y, 0.0, 1.0);

                let localPos = uni.localMatrix * p;
                let transformed = uni.worldMatrix * localPos;

                var out : VertexOutput;
                out.position = transformed;
                out.uv = in.uv;
                out.instanceIndex = instanceIndex;
                return out;
            }
        `;

        // FRAGMENT SHADER CODE
const fragmentShaderCode = `
  struct Uniforms {
    resolution: vec4<f32>,
    worldMatrix: mat4x4<f32>,
    localMatrix: mat4x4<f32>,
    shapeColor: vec4<f32>,
    fontSize: f32,
    sdfThreshold: f32,   // edge in [0..1], usually 0.5
    smoothing: f32,      // unused now; left in struct for layout
    outlineWidth: f32,   // in pixels-ish for the outline band
    outlineColor: vec4<f32>,
    padding1: vec4<f32>,
    padding2: vec4<f32>,
    padding3: vec4<f32>,
    padding4: vec4<f32>,
  };

  @group(0) @binding(0) var<storage, read> u_sdfTextShapes : array<Uniforms>;
  @group(0) @binding(1) var sdfAtlas: texture_2d<f32>;
  @group(0) @binding(2) var atlasSampler: sampler;

  @fragment
  fn fs_main(
    @location(0) uv: vec2<f32>,
    @location(1) @interpolate(flat) instanceIndex: u32
  ) -> @location(0) vec4<f32> {
    let uni = u_sdfTextShapes[instanceIndex];

    // Sample SDF (0..1, ~0.5 at the edge)
    let sdfValue = textureSample(sdfAtlas, atlasSampler, uv).r;

    // --- Antialiasing band around the edge ---
    let edge = uni.sdfThreshold;          // usually 0.5
    // If you know atlas size, set oneTexel = 1.0 / atlasSize; 1/1024 is a good default.
    let oneTexel = 1.0 / 1024.0;
    // Use derivatives when available; fall back to oneTexel
    let w = max(fwidth(sdfValue), oneTexel);

    // INVERTED fill: background transparent, glyph opaque
    // (If you prefer the opposite, remove the 1.0 -)
    let fill = 1.0 - smoothstep(edge - w, edge + w, sdfValue);

    var finalColor = uni.shapeColor.rgb;
    var finalAlpha = fill * uni.shapeColor.a;

    // Optional outline: draw a ring OUTSIDE the fill edge
    if (uni.outlineWidth > 0.0) {
      // Convert a pixel-ish width to SDF space roughly
      let ow = uni.outlineWidth * oneTexel * 64.0; // tweak 64.0 to taste
      // Because we inverted fill, the outside ring is at edge + ow
      let outline = 1.0 - smoothstep((edge + ow) - w, (edge + ow) + w, sdfValue);

      finalColor = mix(uni.outlineColor.rgb, finalColor, fill);
      finalAlpha = max(finalAlpha, outline * uni.outlineColor.a);
    }

    return vec4<f32>(finalColor, finalAlpha);
  }
`;


        this.sdfTextPipeline = this.device.createRenderPipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.device.createBindGroupLayout({
                    entries: [
                        {
                            binding: 0,
                            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                            buffer: { type: "read-only-storage" },
                        },
                        {
                            binding: 1,
                            visibility: GPUShaderStage.FRAGMENT,
                            texture: { sampleType: "float" },
                        },
                        {
                            binding: 2,
                            visibility: GPUShaderStage.FRAGMENT,
                            sampler: {},
                        },
                    ],
                })]
            }),
            vertex: {
                module: this.device.createShaderModule({ code: vertexShaderCode }),
                entryPoint: "vs_main",
                buffers: [{
                    arrayStride: 4 * 4, // (x, y, u, v)
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: "float32x2" },
                        { shaderLocation: 1, offset: 2 * 4, format: "float32x2" },
                    ],
                }],
            },
            fragment: {
                module: this.device.createShaderModule({ code: fragmentShaderCode }),
                entryPoint: "fs_main",
                targets: [{
                    format: this.swapChainFormat,
                    blend: {
                        color: {
                            srcFactor: "src-alpha",
                            dstFactor: "one-minus-src-alpha",
                            operation: "add"
                        },
                        alpha: {
                            srcFactor: "one", 
                            dstFactor: "one-minus-src-alpha",
                            operation: "add"
                        }
                    }
                }],
            },
            primitive: { topology: "triangle-list" }, // Use triangle-list for indexed drawing
            depthStencil: {
                format: "depth24plus-stencil8",
                depthWriteEnabled: false,
                depthCompare: "always",
            },
        });
    }

    private createTextRenderPipeline() {
        const vertexShaderCode = `
            struct Uniforms {
                resolution: vec4<f32>,
                worldMatrix: mat4x4<f32>,
                localMatrix: mat4x4<f32>,
                shapeColor: vec4<f32>
            };

            // @group(0) @binding(0)
            // var<storage, read> u_textShapes: array<Uniforms>;

            @group(0) @binding(0)
            var<uniform> u_textShapes: Uniforms;

            struct VertexInput {
                @location(0) position: vec2<f32>,
                @location(1) uv: vec2<f32>
            };

            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) uv: vec2<f32>
            };

            
            // fn vs_main(in: VertexInput, @builtin(instance_index) i: u32) -> VertexOutput {
            //     let uniform = u_textShapes[i];
            @vertex
            fn vs_main(in: VertexInput) -> VertexOutput {
                let uniform = u_textShapes; // ← use directly

                var output: VertexOutput;
                let localPos = uniform.localMatrix * vec4<f32>(in.position, 0.0, 1.0);
                let transformedPos = uniform.worldMatrix * localPos;
                output.position = transformedPos;
                output.uv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);
                return output;
            }
        `

        const fragmentShaderCode = `
            @group(0) @binding(1) var myTexture: texture_2d<f32>;
            @group(0) @binding(2) var mySampler: sampler;

            @fragment
            fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
                // let flippedUV = vec2<f32>(uv.x, 1.0 - uv.y);  // Flip UV coordinates
                let texColor = textureSample(myTexture, mySampler, uv);
                
                // Improve clarity by boosting contrast (optional)
                let alpha = step(0.5, texColor.a); 
                
                return vec4<f32>(texColor.rgb, alpha);
            }
        `;
    
        this.textPipeline = this.device.createRenderPipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.device.createBindGroupLayout({
                    entries: [
                      {
                        binding: 0,
                        visibility: GPUShaderStage.VERTEX,
                        // buffer: { type: "read-only-storage" },
                        buffer: { type: "uniform" },
                      },
                      {
                        binding: 1,
                        visibility: GPUShaderStage.FRAGMENT,
                        texture: { sampleType: "float" },
                      },
                      {
                        binding: 2,
                        visibility: GPUShaderStage.FRAGMENT,
                        sampler: {},
                      },
                    ],
                  })]
            }),
            vertex: {
                module: this.device.createShaderModule({ code: vertexShaderCode }),
                entryPoint: "vs_main",
                buffers: [{
                    arrayStride: 4 * 4, // (x, y, u, v)
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: "float32x2" },
                        { shaderLocation: 1, offset: 2 * 4, format: "float32x2" },
                    ],
                }],
            },
            fragment: {
                module: this.device.createShaderModule({ code: fragmentShaderCode }),
                entryPoint: "fs_main",
                targets: [
                    {
                        format: this.swapChainFormat,
                        blend: {
                            color: {
                                srcFactor: "one",  // Keep full color intensity
                                dstFactor: "one",  // Add brightness on overlap
                                operation: "add"
                            },
                            alpha: {
                                srcFactor: "one", 
                                dstFactor: "one",
                                operation: "add"
                            }
                        }
                    },
                ],
            },
            primitive: { topology: "triangle-strip" },
            depthStencil: {  // Ensure it matches the render pass
                format: "depth24plus-stencil8",
                depthWriteEnabled: false, // Only needed for actual depth testing
                depthCompare: "always",
            },
        });
    }

    private createCaretRenderPipeline() {
        const vertexShaderCode = `
            struct CaretUniform {
                position: vec2<f32>,
                height: f32,
                thickness: f32,
                color: vec4<f32>,
            };

            @group(0) @binding(0) var<storage, read> u_carets: array<CaretUniform>;
            @group(0) @binding(1) var<uniform> u_worldMatrix: mat4x4<f32>;

            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) color: vec4<f32>,
            };

                @vertex
            fn main_vertex(
                @location(0) quadVertex: vec2<f32>,
                @builtin(instance_index) i: u32
            ) -> VertexOutput {
                let caret = u_carets[i];

                // Extract scale from world matrix
                let zoom = length(vec2<f32>(u_worldMatrix[0].x, u_worldMatrix[1].x));

                let scaledHeight = caret.height * zoom;
                let scaledThickness = caret.thickness * zoom;

                let offset = quadVertex * vec2<f32>(scaledThickness, scaledHeight);
                let pos = caret.position + offset;

                var out: VertexOutput;
                out.position = vec4<f32>(pos, 0.0, 1.0);
                out.color = caret.color;
                return out;
            }
        `;
    
        const fragmentShaderCode = `
            @fragment
            fn main_fragment(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
                return color;
            }
        `;
    
        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: 2 * 4, // x, y
            attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x2' },
            ],
        };
    
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: "read-only-storage" }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: "uniform" }
                }
            ]
        });
    
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout]
        });
    
        this.caretPipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: this.device.createShaderModule({ code: vertexShaderCode }),
                entryPoint: "main_vertex",
                buffers: [vertexBufferLayout]
            },
            fragment: {
                module: this.device.createShaderModule({ code: fragmentShaderCode }),
                entryPoint: "main_fragment",
                targets: [{ format: this.swapChainFormat }]
            },
            primitive: { topology: "triangle-strip" },
            depthStencil: {
                format: "depth24plus-stencil8",
                depthWriteEnabled: false,
                depthCompare: "always"
            }
        });
    }

    /**
     * Selection-highlight pipeline — same vertex layout as caret, but with alpha-blended output.
     * Draws translucent rectangles behind selected SDF-text.
     */
    private createSelectionHighlightPipeline() {
        // Re-use the exact same vertex shader as carets
        const vertexShaderCode = `
            struct Rect {
                position: vec2<f32>,
                height: f32,
                width: f32,
                color: vec4<f32>,
            };

            @group(0) @binding(0) var<storage, read> u_rects: array<Rect>;
            @group(0) @binding(1) var<uniform> u_worldMatrix: mat4x4<f32>;

            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) color: vec4<f32>,
            };

            @vertex
            fn main_vertex(
                @location(0) quadVertex: vec2<f32>,
                @builtin(instance_index) i: u32
            ) -> VertexOutput {
                let r = u_rects[i];
                let zoom = length(vec2<f32>(u_worldMatrix[0].x, u_worldMatrix[1].x));
                let offset = quadVertex * vec2<f32>(r.width * zoom, r.height * zoom);
                let pos = r.position + offset;
                var out: VertexOutput;
                out.position = vec4<f32>(pos, 0.0, 1.0);
                out.color = r.color;
                return out;
            }
        `;

        const fragmentShaderCode = `
            @fragment
            fn main_fragment(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
                return color;
            }
        `;

        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: 2 * 4,
            attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat },
            ],
        };

        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
            ],
        });

        const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

        this.selectionHighlightPipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: this.device.createShaderModule({ code: vertexShaderCode }),
                entryPoint: 'main_vertex',
                buffers: [vertexBufferLayout],
            },
            fragment: {
                module: this.device.createShaderModule({ code: fragmentShaderCode }),
                entryPoint: 'main_fragment',
                targets: [{
                    format: this.swapChainFormat,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    },
                }],
            },
            primitive: { topology: 'triangle-strip' },
            depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'always' },
        });
    }

    /**
     * Overlay-dot pipeline — instanced circles for connection-port indicators.
     * Uses a unit-quad + SDF circle in fragment shader.
     * Same bind-group layout as carets (storage + world matrix uniform).
     */
    private createOverlayDotPipeline() {
        const vertexShaderCode = `
            struct Dot {
                position: vec2<f32>,
                radius: f32,
                _pad: f32,
                color: vec4<f32>,
            };

            @group(0) @binding(0) var<storage, read> u_dots: array<Dot>;
            @group(0) @binding(1) var<uniform> u_worldMatrix: mat4x4<f32>;

            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) color: vec4<f32>,
                @location(1) uv: vec2<f32>,
            };

            @vertex
            fn main_vertex(
                @location(0) quadVertex: vec2<f32>,
                @builtin(instance_index) i: u32
            ) -> VertexOutput {
                let dot = u_dots[i];
                // Extract per-axis zoom to keep circles round (not stretched by aspect ratio)
                let zoomX = length(vec2<f32>(u_worldMatrix[0].x, u_worldMatrix[0].y));
                let zoomY = length(vec2<f32>(u_worldMatrix[1].x, u_worldMatrix[1].y));
                let rx = dot.radius * zoomX;
                let ry = dot.radius * zoomY;
                // quadVertex in [0,1]^2, remap to [-1,+1]^2 for circle SDF
                let centered = (quadVertex * 2.0 - 1.0) * vec2<f32>(rx, ry);
                let pos = dot.position + centered;
                var out: VertexOutput;
                out.position = vec4<f32>(pos, 0.0, 1.0);
                out.color = dot.color;
                out.uv = quadVertex * 2.0 - 1.0; // [-1,+1]^2
                return out;
            }
        `;

        const fragmentShaderCode = `
            @fragment
            fn main_fragment(
                @location(0) color: vec4<f32>,
                @location(1) uv: vec2<f32>,
            ) -> @location(0) vec4<f32> {
                let d = length(uv);
                // Tight 1px anti-aliased edge for a solid circle
                let edge = fwidth(d);
                let alpha = 1.0 - smoothstep(1.0 - edge, 1.0, d);
                return vec4<f32>(color.rgb, color.a * alpha);
            }
        `;

        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: 2 * 4,
            attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat },
            ],
        };

        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
            ],
        });

        const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

        this.overlayDotPipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: this.device.createShaderModule({ code: vertexShaderCode }),
                entryPoint: 'main_vertex',
                buffers: [vertexBufferLayout],
            },
            fragment: {
                module: this.device.createShaderModule({ code: fragmentShaderCode }),
                entryPoint: 'main_fragment',
                targets: [{
                    format: this.swapChainFormat,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    },
                }],
            },
            primitive: { topology: 'triangle-strip' },
            depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'always' },
        });
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
            struct Uniform {
                resolution: vec4<f32>,      // 16
                worldMatrix: mat4x4<f32>,   // 64
                localMatrix: mat4x4<f32>,   // 64
                color: vec4<f32>,           // 16
                _padding: vec4<f32>,        // 16
                _padding2: vec4<f32>,       // 16
                _padding3: vec4<f32>,       // 16
                _padding4: vec4<f32>,       // 16
                _padding5: vec4<f32>,       // 16
                _padding6: vec4<f32>,       // 16
            };           

            @group(0) @binding(0) 
            var<storage, read> u_shapes: array<Uniform>;

            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) @interpolate(flat) shapeIndex: u32,
            };

            @vertex
            fn main_vertex(
                @location(0) position: vec2<f32>,
                @builtin(instance_index) shapeIndex: u32
            ) -> VertexOutput {

                let uniform = u_shapes[shapeIndex];

                let pos = uniform.localMatrix * vec4<f32>(position, 0.0, 1.0);
                let transformedPosition = uniform.worldMatrix * pos;

                var output: VertexOutput;
                output.position = transformedPosition;
                output.shapeIndex = shapeIndex;
                return output;
            }
        `;
    
        // WebGPU Shading Language [WGSL] Fragment Shader for shapes 
        const shapeFragmentShaderCode = `
        struct Uniform {
            resolution: vec4<f32>,      // 16
            worldMatrix: mat4x4<f32>,   // 64
            localMatrix: mat4x4<f32>,   // 64
            color: vec4<f32>,           // 16
            _padding: vec4<f32>,        // 16
            _padding2: vec4<f32>,       // 16
            _padding3: vec4<f32>,       // 16
            _padding4: vec4<f32>,       // 16
            _padding5: vec4<f32>,       // 16
            _padding6: vec4<f32>,       // 16
            };                            // Total: 256 bytes

            @group(0) @binding(0)
            var<storage, read> u_shapes: array<Uniform>;

            @fragment
            fn main_fragment(
                @location(0) @interpolate(flat) shapeIndex: u32
            ) -> @location(0) vec4<f32> {
                let uniform = u_shapes[shapeIndex];
                return uniform.color;
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
                    buffer: { 
                        type: 'read-only-storage'
                    }
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
                    blend: { // Enable blending for transparency
                        color: {
                            srcFactor: 'src-alpha',   // Use source alpha
                            dstFactor: 'one-minus-src-alpha', // Blend with background
                            operation: 'add',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                    },
                 }],
            },
            primitive: { topology: 'triangle-list' },
            multisample: {
                count: this.sampleCount, // Ensure the sample count matches MSAA settings
            },
            depthStencil: {  // Ensure it matches the render pass
                format: "depth24plus-stencil8",
                depthWriteEnabled: false, // Only needed for actual depth testing
                depthCompare: "always",
            },
        });
    }

    private createLineRenderPipeline() {
        // WGSL Vertex Shader for Lines
        const vertexShaderCode = `
            struct Uniforms {
                resolution: vec4<f32>,          // 16 bytes
                worldMatrix: mat4x4<f32>,       // 64 bytes
                localMatrix: mat4x4<f32>,       // 64 bytes
                color: vec4<f32>,               // 16 bytes
                thickness: f32,                 // 4 bytes
                _pad1: vec3<f32>,               // 12 bytes
                _pad2: vec4<f32>,               // 16
                _pad3: vec4<f32>,               // 16
                _pad4: vec4<f32>,               // 16
                _pad5: vec4<f32>,               // 16
            } 

            @group(0) @binding(0)
            var<storage, read> u_lines: array<Uniforms>;

            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) @interpolate(flat) shapeIndex: u32,
            };

            @vertex
            fn main_vertex(
                @location(0) position: vec2<f32>,
                @builtin(instance_index) shapeIndex: u32
            ) -> VertexOutput {
                let uniforms = u_lines[shapeIndex];

                let localPos = uniforms.localMatrix * vec4<f32>(position, 0.0, 1.0);
                let worldPos = uniforms.worldMatrix * localPos;

                var output: VertexOutput;
                output.position = worldPos;
                output.shapeIndex = shapeIndex;
                return output;
            }
        `;
    
        // WGSL Fragment Shader for Lines
        const fragmentShaderCode = `
            struct Uniforms {
                resolution: vec4<f32>,          // 16 bytes
                worldMatrix: mat4x4<f32>,       // 64 bytes
                localMatrix: mat4x4<f32>,       // 64 bytes
                color: vec4<f32>,               // 16 bytes
                thickness: f32,                 // 4 bytes
                _pad1: vec3<f32>,               // 12 bytes
                _pad2: vec4<f32>,               // 16
                _pad3: vec4<f32>,               // 16
                _pad4: vec4<f32>,               // 16
                _pad5: vec4<f32>,               // 16
            } 
            
            @group(0) @binding(0)
            var<storage, read> u_lines: array<Uniforms>;

            @fragment
            fn main_fragment(
                @location(0) @interpolate(flat) shapeIndex: u32
            ) -> @location(0) vec4<f32> {
                let uniform = u_lines[shapeIndex];
                return uniform.color;
            }
        `;
    
        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: 2 * 4, // 2 floats (x, y), 4 bytes each
            attributes: [
                {
                    shaderLocation: 0, // Must match `@location(0)` in shader
                    offset: 0,
                    format: 'float32x2', // Two floats per vertex
                },
            ],
        };

        // Create Shader Modules
        const vertexShaderModule = this.device.createShaderModule({ code: vertexShaderCode });
        const fragmentShaderModule = this.device.createShaderModule({ code: fragmentShaderCode });
    
        // Define Bind Group Layout
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { 
                        type: "read-only-storage",
                        hasDynamicOffset: false
                    }
                }
            ]
        });
    
        // Create Pipeline Layout
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout]
        });
    
        // Create the Render Pipeline
        this.linePipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: vertexShaderModule,
                entryPoint: "main_vertex",
                buffers: [vertexBufferLayout]
            },
            fragment: {
                module: fragmentShaderModule,
                entryPoint: "main_fragment",
                targets: [{
                    format: this.swapChainFormat,
                }],
            },
            primitive: { topology: "triangle-list" },
            depthStencil: {  // Ensure it matches the render pass
                format: "depth24plus-stencil8",
                depthWriteEnabled: false, // Only needed for actual depth testing
                depthCompare: "always",
            },
        });
    }

    private createScribbleRenderPipeline() {
        // WGSL Vertex Shader for Scribbles
        const vertexShaderCode = `
            struct Uniforms {
                resolution: vec4<f32>,          // 16 bytes
                worldMatrix: mat4x4<f32>,       // 64 bytes
                localMatrix: mat4x4<f32>,       // 64 bytes
                color: vec4<f32>,               // 16 bytes
                thickness: f32,                 // 4 bytes
                _pad1: vec3<f32>,               // 12 bytes
                _pad2: vec4<f32>,               // 16
                _pad3: vec4<f32>,               // 16
                _pad4: vec4<f32>,               // 16
                _pad5: vec4<f32>,               // 16
            } 

            @group(0) @binding(0)
            var<storage, read> u_lines: array<Uniforms>;

            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) @interpolate(flat) shapeIndex: u32,
            };

            @vertex
            fn main_vertex(
                @location(0) position: vec2<f32>,
                @builtin(instance_index) shapeIndex: u32
            ) -> VertexOutput {
                let uniforms = u_lines[shapeIndex];

                let localPos = uniforms.localMatrix * vec4<f32>(position, 0.0, 1.0);
                let worldPos = uniforms.worldMatrix * localPos;

                var output: VertexOutput;
                output.position = worldPos;
                output.shapeIndex = shapeIndex;
                return output;
            }
        `;
    
        // WGSL Fragment Shader for Scribbles
        const fragmentShaderCode = `
            struct Uniforms {
                resolution: vec4<f32>,          // 16 bytes
                worldMatrix: mat4x4<f32>,       // 64 bytes
                localMatrix: mat4x4<f32>,       // 64 bytes
                color: vec4<f32>,               // 16 bytes
                thickness: f32,                 // 4 bytes
                _pad1: vec3<f32>,               // 12 bytes
                _pad2: vec4<f32>,               // 16
                _pad3: vec4<f32>,               // 16
                _pad4: vec4<f32>,               // 16
                _pad5: vec4<f32>,               // 16
            } 
            
            @group(0) @binding(0)
            var<storage, read> u_lines: array<Uniforms>;

            @fragment
            fn main_fragment(
                @location(0) @interpolate(flat) shapeIndex: u32
            ) -> @location(0) vec4<f32> {
                let uniform = u_lines[shapeIndex];
                return uniform.color;
            }
        `;
    
        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: 2 * 4, // 2 floats (x, y), 4 bytes each
            attributes: [
                {
                    shaderLocation: 0, // Must match `@location(0)` in shader
                    offset: 0,
                    format: 'float32x2', // Two floats per vertex
                },
            ],
        };

        // Create Shader Modules
        const vertexShaderModule = this.device.createShaderModule({ code: vertexShaderCode });
        const fragmentShaderModule = this.device.createShaderModule({ code: fragmentShaderCode });
    
        // Define Bind Group Layout
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { 
                        type: "read-only-storage",
                        hasDynamicOffset: false
                    }
                }
            ]
        });
    
        // Create Pipeline Layout
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout]
        });
    
        // Create the Render Pipeline
        this.scribblePipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: vertexShaderModule,
                entryPoint: "main_vertex",
                buffers: [vertexBufferLayout]
            },
            fragment: {
                module: fragmentShaderModule,
                entryPoint: "main_fragment",
                targets: [{
                    format: this.swapChainFormat,
                }],
            },
            primitive: { topology: "triangle-list" },
            depthStencil: {  // Ensure it matches the render pass
                format: "depth24plus-stencil8",
                depthWriteEnabled: false, // Only needed for actual depth testing
                depthCompare: "always",
            },
        });
    }

    private createStagingLinePipeline() {
        const vertexShaderCode = `
            struct Uniforms {
                resolution: vec4<f32>,      // 16
                worldMatrix: mat4x4<f32>,   // 64
                localMatrix: mat4x4<f32>,   // 64
                color: vec4<f32>,           // 16
                thickness: f32,             // 4
                _pad1: vec3<f32>,           // 12
                _pad2: vec4<f32>,           // 16
                _pad3: vec4<f32>,           // 16
                _pad4: vec4<f32>,           // 16
                _pad5: vec4<f32>,           // 16
                _pad6: vec4<f32>,           // 16
            }
    
            @group(0) @binding(0)
            var<storage, read> u_line: Uniforms;
    
            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) @interpolate(flat) shapeIndex: u32,
            };
    
            @vertex
            fn main_vertex(@location(0) position: vec2<f32>) -> VertexOutput {
                let localPos = u_line.localMatrix * vec4<f32>(position, 0.0, 1.0);
                let worldPos = u_line.worldMatrix * localPos;
    
                var output: VertexOutput;
                output.position = worldPos;
                output.shapeIndex = 0u;
                return output;
            }
        `;
    
        const fragmentShaderCode = `
            struct Uniforms {
                resolution: vec4<f32>,      // 16
                worldMatrix: mat4x4<f32>,   // 64
                localMatrix: mat4x4<f32>,   // 64
                color: vec4<f32>,           // 16
                thickness: f32,             // 4
                _pad1: vec3<f32>,           // 12
                _pad2: vec4<f32>,           // 16
                _pad3: vec4<f32>,           // 16
                _pad4: vec4<f32>,           // 16
                _pad5: vec4<f32>,           // 16
                _pad6: vec4<f32>,           // 16
            }
    
            @group(0) @binding(0)
            var<storage, read> u_line: Uniforms;
    
            @fragment
            fn main_fragment(@location(0) @interpolate(flat) shapeIndex: u32) -> @location(0) vec4<f32> {
                return u_line.color;
            }
        `;
    
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
    
        const vertexShaderModule = this.device.createShaderModule({ code: vertexShaderCode });
        const fragmentShaderModule = this.device.createShaderModule({ code: fragmentShaderCode });
    
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: {
                        type: "read-only-storage",
                        hasDynamicOffset: true
                    }
                }
            ]
        });
    
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout]
        });
    
        this.stagingLinePipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: vertexShaderModule,
                entryPoint: "main_vertex",
                buffers: [vertexBufferLayout]
            },
            fragment: {
                module: fragmentShaderModule,
                entryPoint: "main_fragment",
                targets: [{
                    format: this.swapChainFormat
                }]
            },
            primitive: { topology: "triangle-list" },
            depthStencil: {
                format: "depth24plus-stencil8",
                depthWriteEnabled: false,
                depthCompare: "always"
            }
        });
    }

    private createStagingHighlightPipeline() {
        const vertexShaderCode = `
            struct Uniforms {
                resolution: vec4<f32>,      // 16
                worldMatrix: mat4x4<f32>,   // 64
                localMatrix: mat4x4<f32>,   // 64
                color: vec4<f32>,           // 16
                thickness: f32,             // 4
                _pad1: vec3<f32>,           // 12
                _pad2: vec4<f32>,           // 16
                _pad3: vec4<f32>,           // 16
                _pad4: vec4<f32>,           // 16
                _pad5: vec4<f32>,           // 16
                _pad6: vec4<f32>,           // 16
            };
    
            @group(0) @binding(0)
            var<storage, read> u_highlight: Uniforms;
    
            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) @interpolate(flat) shapeIndex: u32,
            };
    
            @vertex
            fn main_vertex(@location(0) position: vec2<f32>) -> VertexOutput {
                let localPos = u_highlight.localMatrix * vec4<f32>(position, 0.0, 1.0);
                let worldPos = u_highlight.worldMatrix * localPos;
    
                var output: VertexOutput;
                output.position = worldPos;
                output.shapeIndex = 0u;
                return output;
            }
        `;
    
        const fragmentShaderCode = `
            struct Uniforms {
                resolution: vec4<f32>,
                worldMatrix: mat4x4<f32>,
                localMatrix: mat4x4<f32>,
                color: vec4<f32>,
                thickness: f32,
                padding: vec3<f32>,
                _pad2: vec4<f32>,
                _pad3: vec4<f32>,
                _pad4: vec4<f32>,
                _pad5: vec4<f32>,
                _pad6: vec4<f32>,
            };
    
            @group(0) @binding(0)
            var<storage, read> u_highlight: Uniforms;
    
            fn applyGamma(color: vec3<f32>, gamma: f32) -> vec3<f32> {
                return pow(color, vec3<f32>(gamma));
            }
    
            @fragment
            fn main_fragment(@location(0) @interpolate(flat) shapeIndex: u32) -> @location(0) vec4<f32> {
                let baseColor = u_highlight.color;
    
                let correctedColor = applyGamma(baseColor.rgb, 2.2);
                let overlapFactor = 0.7;
                let premultipliedColor = vec4<f32>(
                    correctedColor.rgb * mix(1.0, sqrt(baseColor.a), overlapFactor),
                    baseColor.a
                );
    
                let saturationFactor = 1.15;
                let finalColor = mix(
                    vec3<f32>(dot(premultipliedColor.rgb, vec3<f32>(0.3, 0.59, 0.11))),
                    premultipliedColor.rgb,
                    saturationFactor
                );
    
                let displayColor = applyGamma(finalColor, 1.0 / 2.2);
                let clampedColor = min(displayColor, vec3<f32>(0.9));
                return vec4<f32>(clampedColor, premultipliedColor.a);
            }
        `;
    
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
    
        const vertexModule = this.device.createShaderModule({ code: vertexShaderCode });
        const fragmentModule = this.device.createShaderModule({ code: fragmentShaderCode });
    
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: {
                        type: "read-only-storage",
                        hasDynamicOffset: true
                    }
                }
            ]
        });
    
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout]
        });
    
        this.stagingHighlightPipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: vertexModule,
                entryPoint: "main_vertex",
                buffers: [vertexBufferLayout]
            },
            fragment: {
                module: fragmentModule,
                entryPoint: "main_fragment",
                targets: [{
                    format: this.swapChainFormat,
                    blend: {
                        color: {
                            srcFactor: "src-alpha",
                            dstFactor: "one-minus-src-alpha",
                            operation: "add"
                        },
                        alpha: {
                            srcFactor: "one",
                            dstFactor: "one-minus-src-alpha",
                            operation: "add"
                        }
                    }
                }]
            },
            primitive: { topology: "triangle-list" },
            depthStencil: {
                format: "depth24plus-stencil8",
                depthWriteEnabled: false,
                depthCompare: "always",
                stencilFront: {
                    compare: "not-equal",
                    failOp: "keep",
                    depthFailOp: "keep",
                    passOp: "replace"
                },
                stencilBack: {
                    compare: "not-equal",
                    failOp: "keep",
                    depthFailOp: "keep",
                    passOp: "replace"
                }
            }
        });
    }

    // We can't do this until bindless textures are added to WebGPU...
    // private createPatternRenderPipeline() {
    //     // WGSL Vertex Shader for Patterns
    //     const vertexShaderCode = `
    //         struct Uniforms {
    //             resolution: vec4<f32>,
    //             worldMatrix: mat4x4<f32>,
    //             localMatrix: mat4x4<f32>,
    //             patternIndex: u32,
    //             _pad0: vec3<f32>,                // 12 bytes
    //             _pad1: vec4<f32>,                // 16 bytes
    //             _pad2: vec4<f32>,                // 16 bytes
    //             _pad3: vec4<f32>,                // 16 bytes
    //         };

    //         @group(0) @binding(0)
    //         var<storage, read> u_patterns: array<Uniforms>;

    //         struct VertexOutput {
    //             @builtin(position) position: vec4<f32>,
    //             @location(0) uv: vec2<f32>,
    //             @location(1) @interpolate(flat) patternIndex: u32,
    //         };  

    //         @vertex
    //         fn main_vertex(
    //             @location(0) position: vec2<f32>,
    //             @location(1) uv: vec2<f32>,
    //             @builtin(instance_index) i: u32
    //         ) -> VertexOutput {
    //             let uniform = u_patterns[i];

    //             let localPos = uniform.localMatrix * vec4<f32>(position, 0.0, 1.0);
    //             let worldPos = uniform.worldMatrix * localPos;

    //             var output: VertexOutput;
    //             output.position = vec4<f32>(worldPos.xy, 0.0, 1.0);
    //             output.uv = uv;
    //             output.patternIndex = uniform.patternIndex;
    //             return output;
    //         }
    //     `;
    
    //     // WGSL Fragment Shader for Patterns
    //     const fragmentShaderCode = `
    //         @group(1) @binding(0) var patternTextures: array<texture_2d<f32>>;
    //         @group(1) @binding(1) var patternSampler: sampler;

    //         @fragment
    //         fn main_fragment(
    //             @location(0) uv: vec2<f32>,
    //             @location(1) @interpolate(flat) patternIndex: u32
    //         ) -> @location(0) vec4<f32> {
    //             let wrappedUV = fract(uv); // Ensure UVs wrap instead of clamping
    //             return textureSample(patternTextures[patternIndex], patternSampler, wrappedUV);
    //         }
    //     `;
    
    //     const vertexBufferLayout: GPUVertexBufferLayout = {
    //         arrayStride: 4 * 4, // 2 floats (x, y) + 2 floats (uv), each 4 bytes
    //         attributes: [
    //             {
    //                 shaderLocation: 0, // Position
    //                 offset: 0,
    //                 format: 'float32x2',
    //             },
    //             {
    //                 shaderLocation: 1, // UV coordinates
    //                 offset: 2 * 4,
    //                 format: 'float32x2',
    //             },
    //         ],
    //     };

    //     // Create Shader Modules
    //     const vertexShaderModule = this.device.createShaderModule({ code: vertexShaderCode });
    //     const fragmentShaderModule = this.device.createShaderModule({ code: fragmentShaderCode });
    
    //     // Define Bind Group Layout
    //     const bindGroupLayout = this.device.createBindGroupLayout({
    //         entries: [
    //             {
    //                 binding: 0, // Uniform buffer
    //                 visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
    //                 buffer: { type: "read-only-storage" }
    //             },
    //             {
    //                 binding: 1, // Texture
    //                 visibility: GPUShaderStage.FRAGMENT,
    //                 texture: { sampleType: "float" }
    //             },
    //             {
    //                 binding: 2, // Sampler
    //                 visibility: GPUShaderStage.FRAGMENT,
    //                 sampler: { type: "filtering" }
    //             }
    //         ]
    //     });
    
    //     // Create Pipeline Layout
    //     const pipelineLayout = this.device.createPipelineLayout({
    //         bindGroupLayouts: [bindGroupLayout]
    //     }); 
    
    //     // Create the Render Pipeline
    //     this.patternPipeline = this.device.createRenderPipeline({
    //         layout: pipelineLayout,
    //         vertex: {
    //             module: vertexShaderModule,
    //             entryPoint: "main_vertex",
    //             buffers: [vertexBufferLayout]
    //         },
    //         fragment: {
    //             module: fragmentShaderModule,
    //             entryPoint: "main_fragment",
    //             targets: [{
    //                 format: this.swapChainFormat,
    //             }],
    //         },
    //         primitive: { topology: "triangle-list" },
    //         depthStencil: {  // Ensure it matches the render pass
    //             format: "depth24plus-stencil8",
    //             depthWriteEnabled: false, // Only needed for actual depth testing
    //             depthCompare: "always",
    //         },
    //     });
    // }

    private createPatternRenderPipeline() {
  const vs = /* wgsl */`
struct Inst {
  worldMatrix : mat4x4<f32>,
  localMatrix : mat4x4<f32>,
  uvScale     : vec2<f32>,
  uvOffset    : vec2<f32>,
  layerIndex  : u32,
  flags       : u32,
  _pad0       : vec2<f32>,
  tint        : vec4<f32>,
  _padTail    : array<vec4<f32>, 5>
};

@group(0) @binding(0) var<storage, read> u_inst : array<Inst>;
@group(0) @binding(1) var texArr : texture_2d_array<f32>;
@group(0) @binding(2) var samp   : sampler;

struct VSIn { @location(0) pos: vec2<f32>, @location(1) uv: vec2<f32> };
struct VSOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) @interpolate(flat) idx: u32
};

@vertex
fn main_vertex(in:VSIn, @builtin(instance_index) i:u32) -> VSOut {
  let inst = u_inst[i];
  let p = vec4<f32>(in.pos,0.0,1.0);
  let lp = inst.localMatrix * p;
  let wp = inst.worldMatrix * lp;

  var o:VSOut;
  o.clip = wp;
  o.uv   = in.uv;
  o.idx  = i;
  return o;
}
`;

  const fs = /* wgsl */`
struct Inst {
  worldMatrix : mat4x4<f32>,
  localMatrix : mat4x4<f32>,
  uvScale     : vec2<f32>,
  uvOffset    : vec2<f32>,
  layerIndex  : u32,
  flags       : u32,
  _pad0    : vec2<f32>,    // 152
  tint     : vec4<f32>,    // 160
  _padTail    : array<vec4<f32>, 5>
};
@group(0) @binding(0) var<storage, read> u_inst : array<Inst>;
@group(0) @binding(1) var texArr : texture_2d_array<f32>;
@group(0) @binding(2) var samp   : sampler;

@fragment
fn main_fragment(@location(0) uv: vec2<f32>, @location(1) @interpolate(flat) i:u32)
  -> @location(0) vec4<f32> {
  let inst = u_inst[i];
  let tiled = fract(uv * inst.uvScale + inst.uvOffset);
  let col = textureSample(texArr, samp, tiled, i32(inst.layerIndex));
  return col * inst.tint;
}
`;

  const bindGroupLayout = this.device.createBindGroupLayout({
    entries: [
      { binding:0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      { binding:1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType:"float", viewDimension:"2d-array" } },
      { binding:2, visibility: GPUShaderStage.FRAGMENT, sampler: { type:"filtering" } },
    ]
  });

  const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

  this.texturedPipeline = this.device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: {
      module: this.device.createShaderModule({ code: vs }),
      entryPoint: "main_vertex",
      buffers: [{
        arrayStride: 4 * 4, // pos.xy, uv.xy
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x2" },
          { shaderLocation: 1, offset: 8, format: "float32x2" },
        ]
      }]
    },
    fragment: {
      module: this.device.createShaderModule({ code: fs }),
      entryPoint: "main_fragment",
      targets: [{
        format: this.swapChainFormat,
        blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one",       dstFactor: "one-minus-src-alpha", operation: "add" },
        }
        }],
    },
    primitive: { topology: "triangle-list" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: false,
      depthCompare: "always",
    },
  });
}

    private createHighlightRenderPipeline() {
        // WGSL Vertex Shader for Lines
        const vertexShaderCode = `
            struct Uniforms {
            resolution: vec4<f32>,
            worldMatrix: mat4x4<f32>,
            localMatrix: mat4x4<f32>,
            color: vec4<f32>,
            thickness: f32,
            _pad1: vec3<f32>,               // 12 bytes
            _pad2: vec4<f32>,               // 16
            _pad3: vec4<f32>,               // 16
            _pad4: vec4<f32>,               // 16
            _pad5: vec4<f32>,               // 16
        };

        @group(0) @binding(0) var<storage, read> u_highlights: array<Uniforms>;

        struct VertexOutput {
            @builtin(position) position: vec4<f32>,
            @location(0) @interpolate(flat) shapeIndex: u32,
        };

        @vertex
        fn main_vertex(
            @location(0) position: vec2<f32>,
            @builtin(instance_index) i: u32
        ) -> VertexOutput {
            let uniforms = u_highlights[i];
            let localPos = uniforms.localMatrix * vec4<f32>(position, 0.0, 1.0);
            let worldPos = uniforms.worldMatrix * localPos;

            var output: VertexOutput;
            output.position = vec4<f32>(worldPos.xy, 0.0, 1.0);
            output.shapeIndex = i;
            return output;
        }
        `;
    
        // WGSL Fragment Shader for Lines
        const fragmentShaderCode = `
            struct Uniforms {
            resolution: vec4<f32>,
            worldMatrix: mat4x4<f32>,
            localMatrix: mat4x4<f32>,
            color: vec4<f32>,
            thickness: f32,
            _pad1: vec3<f32>,               // 12 bytes
            _pad2: vec4<f32>,               // 16
            _pad3: vec4<f32>,               // 16
            _pad4: vec4<f32>,               // 16
            _pad5: vec4<f32>,               // 16
        };

        @group(0) @binding(0) var<storage, read> u_highlights: array<Uniforms>;

        fn applyGamma(color: vec3<f32>, gamma: f32) -> vec3<f32> {
            return pow(color, vec3<f32>(gamma));
        }

        @fragment
        fn main_fragment(@location(0) @interpolate(flat) shapeIndex: u32) -> @location(0) vec4<f32> {
            let uniforms = u_highlights[shapeIndex];
            let baseColor = uniforms.color;

            let correctedColor = applyGamma(baseColor.rgb, 2.2);
            let overlapFactor = 0.7;
            let premultipliedColor = vec4<f32>(
                correctedColor.rgb * mix(1.0, sqrt(baseColor.a), overlapFactor),
                baseColor.a
            );

            let saturationFactor = 1.15;
            let finalColor = mix(
                vec3<f32>(dot(premultipliedColor.rgb, vec3<f32>(0.3, 0.59, 0.11))),
                premultipliedColor.rgb,
                saturationFactor
            );

            let displayColor = applyGamma(finalColor, 1.0 / 2.2);
            let clampedColor = min(displayColor, vec3<f32>(0.9));
            return vec4<f32>(clampedColor, premultipliedColor.a);
        }
        `;
    
        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: 2 * 4, // 2 floats (x, y), 4 bytes each
            attributes: [
                {
                    shaderLocation: 0, // Must match `@location(0)` in shader
                    offset: 0,
                    format: 'float32x2', // Two floats per vertex
                },
            ],
        };

        // Create Shader Modules
        const vertexShaderModule = this.device.createShaderModule({ code: vertexShaderCode });
        const fragmentShaderModule = this.device.createShaderModule({ code: fragmentShaderCode });
    
        // Define Bind Group Layout
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { 
                        type: "read-only-storage"
                    }
                }
            ]
        });
    
        // Create Pipeline Layout
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout]
        });
    
        // Create the Render Pipeline
        this.highlightPipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: vertexShaderModule,
                entryPoint: "main_vertex",
                buffers: [vertexBufferLayout]
            },
            fragment: {
                module: fragmentShaderModule,
                entryPoint: "main_fragment",
                targets: [{
                    format: this.swapChainFormat,
                    blend: {
                        color: {
                            srcFactor: "src-alpha",  // Allow same highlight to blend normally
                            dstFactor: "one-minus-src-alpha", // This keeps adding RGB values, which can exceed (1.0, 1.0, 1.0)
                            operation: "add"
                        },
                        alpha: {
                            srcFactor: "one",
                            dstFactor: "one-minus-src-alpha",
                            operation: "add"
                        }
                    }
                }],
            },
            primitive: { topology: "triangle-list" },
            depthStencil: {
                format: "depth24plus-stencil8",
                depthWriteEnabled: false, // Prevents depth blocking but still allows ordering (Ensures highlights don’t overwrite each other)
                depthCompare: "always",
                stencilFront: {
                    compare: "not-equal",  // Only render where stencil is not already written (Ensures highlights do not merge into one object)
                    failOp: "keep",
                    depthFailOp: "keep",
                    passOp: "replace"  // Replace stencil value so highlights don't stack (Marks stencil buffer for each unique highlight)
                },
                // stencilFront: {
                //     compare: "always",     // Always draw
                //     passOp: "replace",     // Overwrite with stencilRef
                //     failOp: "keep",
                //     depthFailOp: "keep"
                // },
                stencilBack: {
                    compare: "not-equal",
                    failOp: "keep",
                    depthFailOp: "keep",
                    passOp: "replace"
                }
            }
            
        });
    }

    private createRasterRenderPipeline() {
        const vertex = `
        struct VertexInput { @location(0) pos: vec2<f32>, @location(1) uv: vec2<f32> };
        struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
        // binding(2) is the world matrix uniform (mat4) supplied by the renderer
        @group(0) @binding(2) var<uniform> u_worldMatrix: mat4x4<f32>;

        @vertex
        fn main_vertex(in: VertexInput) -> VertexOutput {
            var out: VertexOutput;
            // Treat vertex positions as world-space positions and transform by the world matrix
            out.position = u_worldMatrix * vec4<f32>(in.pos, 0.0, 1.0);
            out.uv = in.uv;
            return out;
        }
        `;

        const fragment = `
        @group(0) @binding(0) var myTexture: texture_2d<f32>;
        @group(0) @binding(1) var mySampler: sampler;
        // binding(2) will be the shared world matrix (uniform) supplied by the renderer
        @group(0) @binding(2) var<uniform> u_worldMatrix: mat4x4<f32>;
        @fragment
        fn main_fragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
            let c = textureSample(myTexture, mySampler, uv);
            return c;
        }
        `;

        const bgl = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }
            ]
        });

        const layout = this.device.createPipelineLayout({ bindGroupLayouts: [bgl] });

        this.rasterPipeline = this.device.createRenderPipeline({
            layout,
            vertex: {
                module: this.device.createShaderModule({ code: vertex }),
                entryPoint: 'main_vertex',
                buffers: [{ arrayStride: 4 * 4, attributes: [ { shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x2' } ] }]
            },
            fragment: {
                module: this.device.createShaderModule({ code: fragment }),
                entryPoint: 'main_fragment',
                targets: [{
                    format: this.swapChainFormat,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    },
                }]
            },
            primitive: { topology: 'triangle-list' },
            depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'always' }
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
        @group(0) @binding(2) var<uniform> backgroundColor: vec4<f32>;
        @group(0) @binding(3) var<uniform> dotColor: vec4<f32>;

        @fragment
        fn main_fragment(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
            
            let aspectRatio = resolution.x / resolution.y;
            
            // Convert fragment coordinates to UV coordinates (0 to 1)
            var uv = fragCoord.xy / resolution.xy;

            // Flip the Y-axis by inverting the Y coordinate
            uv.y = 1.0 - uv.y;

            // Convert UV to NDC space (-1 to 1)
            let uvNDC = uv * 2.0 - vec2(1.0, 1.0);

            // Apply the world matrix transformation (includes panning and scaling)
            var transformedUV = (worldMatrix * vec4<f32>(uvNDC, 0.0, 1.0)).xy;

            // Adjust the UVs back to the 0 to 1 range
            var adjustedUv = (transformedUV + vec2(1.0, 1.0)) / 2.0;

            // Control the size and spacing of dots
            let dotSize = 0.0650; // dot sizing
            let spacing = 0.03125;  // dot spacing

            // Calculate the position of the dot
            let dot = fract(adjustedUv / spacing) - vec2(0.5);
            let dist = length(dot);

            // Use step function to make the dots visible
            let insideDot = step(dist, dotSize); // 1.0 inside the dot, 0.0 outside

            // Background color (no longer hardcoded)
            // let backgroundColor = vec4<f32>(1, 1, 1, 1.0);
            // let backgroundColor = vec4<f32>(.01, .01, .01, 1.0);

            // Dot color (no longer hardcoded)
            // let dotColor = vec4<f32>(0.90, 0.90, 0.90, 1);
            // let dotColor = vec4<f32>(0.15, 0.1, 0.15, 1.0);

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
                {
                    binding: 2, // Background color uniform
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' },
                },
                {
                    binding: 3, // Dot color uniform
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' },
                }
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
            depthStencil: {  // Ensure it matches the render pass
                format: "depth24plus-stencil8",
                depthWriteEnabled: false, // Only needed for actual depth testing
                depthCompare: "always",
            },
        });
    }

    /**
     * Grid overlay pipeline — a fullscreen quad that draws the 2D canvas grid as a TOP overlay
     * (drawn after raster/vector/3D, so it sits above everything), alpha-blended. Reuses the
     * artboard-space transform (inverse world matrix) so it pans/zooms with the canvas like the
     * background pattern. Bindings: 0 = resolution, 1 = inverse world matrix, 2 = grid params.
     */
    private createGridOverlayRenderPipeline() {
        const shaderCode = `
        @group(0) @binding(0) var<uniform> resolution: vec4<f32>;
        @group(0) @binding(1) var<uniform> invWorld: mat4x4<f32>;
        struct GridParams { color: vec4<f32>, config: vec4<f32>, };  // color=rgb+opacity; config=(visible,spacing,lineWidthPx,_)
        @group(0) @binding(2) var<uniform> grid: GridParams;

        @vertex
        fn vs_main(@location(0) position: vec2<f32>) -> @builtin(position) vec4<f32> {
            return vec4<f32>(position, 0.0, 1.0);
        }

        @fragment
        fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
            // Screen pixel -> artboard space (matches the background pattern's transform).
            var uv = fragCoord.xy / resolution.xy;
            uv.y = 1.0 - uv.y;
            let uvNDC = uv * 2.0 - vec2<f32>(1.0, 1.0);
            let transformedUV = (invWorld * vec4<f32>(uvNDC, 0.0, 1.0)).xy;
            let adjustedUv = (transformedUV + vec2<f32>(1.0, 1.0)) / 2.0;

            // Constant-pixel-width grid lines via fwidth (crisp at any zoom).
            let gspacing = max(grid.config.y, 0.0001);
            let coord = adjustedUv / gspacing;
            let deriv = max(fwidth(coord), vec2<f32>(1e-6, 1e-6));
            let lineDist = abs(fract(coord - vec2<f32>(0.5, 0.5)) - vec2<f32>(0.5, 0.5)) / deriv;
            let lw = max(grid.config.z, 0.5);
            let line = 1.0 - min(min(lineDist.x, lineDist.y) / lw, 1.0);
            return vec4<f32>(grid.color.rgb, line * grid.color.a);  // transparent except on lines
        }
        `;
        const module = this.device.createShaderModule({ code: shaderCode });
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ],
        });
        const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: 2 * 4,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
        };
        this.gridOverlayPipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: { module, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
            fragment: {
                module, entryPoint: 'fs_main',
                targets: [{
                    format: this.swapChainFormat,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    },
                }],
            },
            primitive: { topology: 'triangle-list' },
            multisample: { count: this.sampleCount },
            depthStencil: {  // match the render pass; always-pass so it draws on top
                format: 'depth24plus-stencil8',
                depthWriteEnabled: false,
                depthCompare: 'always',
            },
        });
    }

    private createBoundingBoxPipeline() {
        const vertexShaderCode = `
          struct LocalMatrix {
            matrix: mat4x4<f32>,
            _pad0: mat4x4<f32>,
            _pad1: mat4x4<f32>,
            _pad2: mat4x4<f32>,
          };
      
          @group(0) @binding(0)
          var<storage, read> u_localMatrices: array<LocalMatrix>;
      
          @group(0) @binding(1)
          var<uniform> u_worldMatrix: mat4x4<f32>;
      
          struct VertexOutput {
            @builtin(position) position: vec4<f32>,
            @location(0) @interpolate(flat) boxIndex: u32,
          };
      
          @vertex
          fn main_vertex(
            @location(0) position: vec2<f32>,
            @builtin(instance_index) boxIndex: u32
          ) -> VertexOutput {
            let local = u_localMatrices[boxIndex].matrix;
            let pos = u_worldMatrix * (local * vec4<f32>(position, 0.0, 1.0));
            // u_worldMatrix * 
            var output: VertexOutput;
            output.position = pos;
            output.boxIndex = boxIndex;
            return output;
          }
        `;
      
        const fragmentShaderCode = `
          @fragment
          fn main_fragment(@location(0) @interpolate(flat) boxIndex: u32) -> @location(0) vec4<f32> {
            return vec4<f32>(0.5, 0.1, 1.0, 1.0);
          }
        `;
      
        const vertexShaderModule = this.device.createShaderModule({ code: vertexShaderCode });
        const fragmentShaderModule = this.device.createShaderModule({ code: fragmentShaderCode });
        
        const bindGroupLayout = this.device.createBindGroupLayout({
          entries: [
            {
              binding: 0, // localMatrix array
              visibility: GPUShaderStage.VERTEX,
              buffer: { type: "read-only-storage" },
            },
            {
              binding: 1, // shared worldMatrix
              visibility: GPUShaderStage.VERTEX,
              buffer: { type: "uniform" },
            },
          ],
        });
      
        const pipelineLayout = this.device.createPipelineLayout({
          bindGroupLayouts: [bindGroupLayout],
        });
      
        this.boundingBoxPipeline = this.device.createRenderPipeline({
          layout: pipelineLayout,
          vertex: {
            module: vertexShaderModule,
            entryPoint: 'main_vertex',
            buffers: [{
              arrayStride: 2 * 4,
              attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
            }],
          },
          fragment: {
            module: fragmentShaderModule,
            entryPoint: 'main_fragment',
            targets: [{ format: this.swapChainFormat }],
          },
          primitive: { topology: 'triangle-list' },
          multisample: { count: this.sampleCount },
          depthStencil: {
            format: "depth24plus-stencil8",
            depthWriteEnabled: false,
            depthCompare: "always",
          }
        });
    }
}