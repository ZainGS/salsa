// src/rendering/webgpu-render-strategy.ts
import { RenderStrategy } from './render-strategy';
import { Node } from '../../scene-graph/shapes/base/node';
import { Rectangle } from '../../scene-graph/shapes/rectangle';
import { Circle } from '../../scene-graph/shapes/circle';
import { Diamond } from '../../scene-graph/shapes/diamond';
import { Triangle } from '../../scene-graph/shapes/triangle';
import { InvertedTriangle } from '../../scene-graph/shapes/inverted-triangle';
import { InteractionService } from '../../services/interaction-service';
import { Shape } from '../../scene-graph/shapes/base/shape';
import { Line } from '../../scene-graph/shapes/line';
import { Scribble } from '../../scene-graph/shapes/scribble';
import { Highlight } from '../../scene-graph/shapes/highlight';
import { Text } from '../../scene-graph/shapes/text';
import { Pattern } from '../../scene-graph/shapes/pattern';
import { CacheService } from '../../services/cache-service';
import { IndirectDrawCommandBuffer } from '../caches/buffers/indirect-draw-command-buffer';
import { PipelineManager } from '../core/managers/pipeline-manager';
import { StrokesStagingBuffer } from '../caches/buffers/strokes-staging-buffer';
import { StrokeGeometryGenerator } from '../caches/geometry-generators/stroke-geometry-generator';
import { RenderCache } from '../caches/cache-registry/legacy-render-cache';
import { CaretManager } from '../../services/drawing/caret-manager';
import { mat4, vec4 } from 'gl-matrix';
import { Section } from '../../scene-graph/shapes/section';
import { StagingContainer } from '../util/staging-container';
import { SDFText } from '../../scene-graph/shapes/sdf-text/sdf-text';

type DrawType = 'shape' | 'stroke' | 'highlight' | 'boundingBox' | 'pattern' | 'line' | 'sdfText';

export class WebGPURenderStrategy implements RenderStrategy {
    
  private device: GPUDevice;
  private pipelineManager: PipelineManager;
  private interactionService: InteractionService;
  private cacheService: CacheService;
  private textSampler!: GPUSampler;
  private patternSampler!: GPUSampler;
  private caretManager: CaretManager;

  public shapeDrawCommands: IndirectDrawCommandBuffer;
  public strokeDrawCommands: IndirectDrawCommandBuffer;
  public lineDrawCommands: IndirectDrawCommandBuffer;
  public boundingBoxDrawCommands: IndirectDrawCommandBuffer;
  public highlightDrawCommands: IndirectDrawCommandBuffer;
  public patternDrawCommands: IndirectDrawCommandBuffer;
  public sdfTextDrawCommands: IndirectDrawCommandBuffer;

  public strokeGeometryGenerator!: StrokeGeometryGenerator;

  private renderCache: RenderCache;

  // The spacing of 4 bytes between entries in your drawCountBuffer is because 
  // each count is a single u32 (32-bit unsigned integer), which takes up exactly 4 bytes in memory.
  private drawCountBuffer!: GPUBuffer;
  private drawCountBufferOffsets: Record<DrawType, number> = {
      shape: 0,
      stroke: 4,
      highlight: 8,
      boundingBox: 12,
      pattern: 16,
      line: 20,
      sdfText: 24
  };

  constructor(device: GPUDevice, 
              pipelineManager: PipelineManager,
              interactionService: InteractionService,
              cacheService: CacheService
              ) {
    this.device = device;
    this.renderCache = new RenderCache(160000, this.device, interactionService);
    this.pipelineManager = pipelineManager;
    this.interactionService = interactionService;
    this.cacheService = cacheService;
    this.strokeGeometryGenerator = new StrokeGeometryGenerator();

    this.caretManager = new CaretManager(
      device,
      cacheService.caretUniformBuffer
    );

    // Create a sampler for v1 text
    this.textSampler = this.device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
    });

    // Initialize SDF Text components
    this.sdfTextDrawCommands = new IndirectDrawCommandBuffer(device, cacheService.sdfTextRegistry, 'sdfText');

    // Create a sampler for pattern textures
    this.patternSampler = this.device.createSampler({
        magFilter: "linear", // How to upscale
        minFilter: "linear", // How to downscale
        addressModeU: "repeat", // Repeat pattern horizontally
        addressModeV: "repeat"  // Repeat pattern vertically
    });

    this.shapeDrawCommands = new IndirectDrawCommandBuffer(device, cacheService.shapeRegistry, 'shape');
    this.strokeDrawCommands = new IndirectDrawCommandBuffer(device, cacheService.strokeRegistry, 'stroke');
    this.lineDrawCommands = new IndirectDrawCommandBuffer(device, cacheService.lineRegistry, 'line');
    this.boundingBoxDrawCommands = new IndirectDrawCommandBuffer(device, cacheService.boundingBoxRegistry, 'shape');
    this.highlightDrawCommands = new IndirectDrawCommandBuffer(device, cacheService.highlightRegistry, 'highlight');
    this.patternDrawCommands = new IndirectDrawCommandBuffer(device, cacheService.patternRegistry, 'pattern')

    this.initializeDrawCountBuffers(this.device);
  }

  currentStagingStroke?: Shape = undefined;
  lastVersion: number = 0;
  public async beginFrame(nodes: Node[], passEncoder: GPURenderPassEncoder, stagingBuffer: StrokesStagingBuffer, stagingContainer: StagingContainer): Promise<void> {
    
    // Do these need to be cleared?
    this.shapeDrawCommands.clear();
    this.strokeDrawCommands.clear();
    this.lineDrawCommands.clear();
    this.boundingBoxDrawCommands.clear();
    this.highlightDrawCommands.clear();
    this.sdfTextDrawCommands.clear();
    // this.patternDrawCommands.clear();
    
    // Triple Buffering: Safely reset this frame’s staging data before drawing into it
    if (this.currentStagingStroke?.isStaging) {
      stagingBuffer.beginFrame();
    }

    this.cacheService.boundingBoxUniformCache.updateWorldMatrix();
    for (const node of nodes) {
      if (!(node instanceof Shape)) continue;

      if (node.isSelected()) {
        const thickness = 0.015;
        this.cacheService.boundingBoxGeometryCache.allocate(node, thickness);
        this.cacheService.boundingBoxUniformCache.allocate(node);
        if (node.isDirty || this.lastVersion !== this.interactionService.worldMatrixVersion) {
          this.cacheService.boundingBoxGeometryCache.update(node);
          this.cacheService.boundingBoxUniformCache.update(node);
        }
        this.boundingBoxDrawCommands.updateOrAdd(node);
      }

      // General Shape Rendering
      if (node instanceof Rectangle        ||
          node instanceof Circle           ||
          node instanceof Triangle         ||
          node instanceof InvertedTriangle ||
          node instanceof Diamond          ||
          node instanceof Section) 
      {
        node.fillColor.a = node.isPreview ? 0.4 : 1; 
        this.cacheService.shapeGeometryCache.allocate(node);
        this.cacheService.shapeUniformCache.allocate(node);
        if (node.isDirty) {
          this.cacheService.shapeGeometryCache.update(node);
          this.cacheService.shapeUniformCache.update(node);

          node.isDirty = false;
        }

        this.shapeDrawCommands.updateOrAdd(node);
      }
      else if (node instanceof Pattern) {
        // We can do this when bindless textures are added to WebGPU
        // if(node.patternIndex === undefined) {
        //   await this.cacheService.patternTextureCache.registerPattern(node);
        // }

        // this.cacheService.patternGeometryCache.allocate(node);
        // this.cacheService.patternUniformCache.allocate(node);
        // if (node.isDirty) {
        //   this.cacheService.patternGeometryCache.update(node);
        //   this.cacheService.patternUniformCache.update(node);
        //   node.isDirty = false;
        // }

        // this.patternDrawCommands.updateOrAdd(node);

        // We'll have to keep it old school until then (sadly, not very scalable...)
        this.drawPattern(passEncoder, node as Pattern);
      }
      else if (node instanceof Scribble) {
        if (node.isStaging) {
            // const layout = this.pipelineManager.getStagingLinePipeline().getBindGroupLayout(0);
            // const uniformData = this.getStrokeUniformData(node);
            // this.stagingBuffer.writeUniforms(uniformData);
            // const bindGroup = this.stagingBuffer.createStagingBindGroup(layout);
            // passEncoder.setPipeline(this.pipelineManager.getStagingLinePipeline());
            // node._stagingInfo = this.stagingBuffer.writeStroke(node);
            // this.stagingBuffer.renderStagingStroke(passEncoder, bindGroup);

            // Defer staged rendering to the end of the frame in render()
            stagingContainer.scribbles.push(node);
            continue;
        } 
        else {
          if (!node.wasCommitted) {
            let info = node._stagingInfo;
            if (info) {
              // Fresh stroke just drawn via staging to finalize for bindless rendering path
              this.cacheService.strokeGeometryCache.allocate(node, info.vertexCount, info.indexCount);
              this.cacheService.strokeUniformCache.allocate(node);
              stagingBuffer.copyToSharedBuffer(node, this.cacheService.strokeGeometryCache);
            } 
            else {
              // Loaded stroke from disk — no staging info, generate geometry manually
              info = this.strokeGeometryGenerator.generate(node);
              node._stagingInfo = info;
          
              this.cacheService.strokeGeometryCache.allocate(node, info.vertexCount, info.indexCount);
              this.cacheService.strokeUniformCache.allocate(node);

              const offset = this.cacheService.strokeGeometryCache.getOffset(node)!;
          
              this.device.queue.writeBuffer(
                this.cacheService.strokeGeometryCache.getVertexBuffer(),
                offset.vertexOffset * 4,
                info.vertexData.buffer,
                info.vertexData.byteOffset,
                info.vertexCount * 4
              );
          
              this.device.queue.writeBuffer(
                this.cacheService.strokeGeometryCache.getIndexBuffer(),
                offset.indexOffset * 2,
                info.indexData.buffer,
                info.indexData.byteOffset,
                info.indexCount * 2
              );
            }
          
            node.wasCommitted = true;
            this.currentStagingStroke = undefined;
          }
          
          if (node.isDirty || this.lastVersion !== this.interactionService.worldMatrixVersion) {
            this.cacheService.strokeUniformCache.update(node);
            node.isDirty = false;
          }
          this.strokeDrawCommands.updateOrAdd(node);
        }
      }
      //
      else if (node instanceof Line) {
        if (node.isStaging) {
          // const layout = this.pipelineManager.getStagingLinePipeline().getBindGroupLayout(0);
          // const uniformData = this.getStrokeUniformData(node); // Same as scribble/highlight
          // this.stagingBuffer.writeUniforms(uniformData);
          // const bindGroup = this.stagingBuffer.createStagingBindGroup(layout);
      
          // passEncoder.setPipeline(this.pipelineManager.getStagingLinePipeline());
          // node._stagingInfo = this.stagingBuffer.writeLine(node);
          // this.stagingBuffer.renderStagingStroke(passEncoder, bindGroup);

          // Defer staged rendering to the end of the frame in render()
          stagingContainer.lines.push(node);
          continue;
        } 
        else {
          if (!node.wasCommitted) {
            let info = node._stagingInfo;
            if (info) {
              this.cacheService.lineGeometryCache.allocateLine(node);
              this.cacheService.lineUniformCache.allocate(node);
              stagingBuffer.copyToSharedBuffer(node, this.cacheService.strokeGeometryCache);
            } else {
              info = this.strokeGeometryGenerator.generateLine(node);
              node._stagingInfo = info;
      
              this.cacheService.lineGeometryCache.allocateLine(node);
              this.cacheService.lineUniformCache.allocate(node);
      
              const offset = this.cacheService.strokeGeometryCache.getOffset(node)!;
              this.device.queue.writeBuffer(
                this.cacheService.lineGeometryCache.getVertexBuffer(),
                offset.vertexOffset * 4,
                info.vertexData.buffer,
                info.vertexData.byteOffset,
                info.vertexCount * 4
              );
              this.device.queue.writeBuffer(
                this.cacheService.lineGeometryCache.getIndexBuffer(),
                offset.indexOffset * 2,
                info.indexData.buffer,
                info.indexData.byteOffset,
                info.indexCount * 2
              );
            }
      
            node.wasCommitted = true;
            this.currentStagingStroke = undefined;
          }
      
          if (node.isDirty || this.lastVersion !== this.interactionService.worldMatrixVersion) {
            this.cacheService.lineUniformCache.update(node);
            node.isDirty = false;
          }
      
          this.lineDrawCommands.updateOrAdd(node);
        }
      }
      //
      else if (node instanceof Highlight) {
        if (node.isStaging) {
            // const layout = this.pipelineManager.getStagingHighlightPipeline().getBindGroupLayout(0);
            // const uniformData = this.getStrokeUniformData(node); // You can reuse this
            // this.stagingBuffer.writeUniforms(uniformData);
            // const bindGroup = this.stagingBuffer.createStagingBindGroup(layout);
            // passEncoder.setPipeline(this.pipelineManager.getStagingHighlightPipeline());
            // node._stagingInfo = this.stagingBuffer.writeStroke(node);
            // this.stagingBuffer.renderStagingStroke(passEncoder, bindGroup);

            // Defer staged rendering to the end of the frame in render()
            stagingContainer.highlights.push(node);
            continue;

        } 
        else {
          if (!node.wasCommitted) {
            let info = node._stagingInfo;
            if (info) {
              this.cacheService.highlightGeometryCache.allocate(node, info.vertexCount, info.indexCount);
              this.cacheService.highlightUniformCache.allocate(node);
              stagingBuffer.copyToSharedBuffer(node, this.cacheService.highlightGeometryCache);
            } 
            else {
              info = this.strokeGeometryGenerator.generate(node);
              node._stagingInfo = info;
      
              this.cacheService.highlightGeometryCache.allocate(node, info.vertexCount, info.indexCount);
              this.cacheService.highlightUniformCache.allocate(node);
      
              const offset = this.cacheService.highlightGeometryCache.getOffset(node)!;
      
              this.device.queue.writeBuffer(
                this.cacheService.highlightGeometryCache.getVertexBuffer(),
                offset.vertexOffset * 4,
                info.vertexData.buffer,
                info.vertexData.byteOffset,
                info.vertexCount * 4
              );
      
              this.device.queue.writeBuffer(
                this.cacheService.highlightGeometryCache.getIndexBuffer(),
                offset.indexOffset * 2,
                info.indexData.buffer,
                info.indexData.byteOffset,
                info.indexCount * 2
              );
            }
      
            node.wasCommitted = true;
            this.currentStagingStroke = undefined;
          }
      
          if (node.isDirty || this.lastVersion !== this.interactionService.worldMatrixVersion) {
            this.cacheService.highlightUniformCache.update(node);
            node.isDirty = false;
          }
          
          this.highlightDrawCommands.updateOrAdd(node);
        }
        
      }
      else if (node instanceof Text) {
        // We can keep this existing bitmap text rendering as a fallback
        this.drawText(passEncoder, node);
        this.caretManager.update(
          this.collectActiveCarets(nodes)
        );
      }
      else if (node instanceof SDFText) {
          // Handle SDF text rendering
          this.cacheService.sdfTextGeometryCache.allocate(node);
          this.cacheService.sdfTextUniformCache.allocate(node);
          
          if (node.isDirty || this.lastVersion !== this.interactionService.worldMatrixVersion) {
              this.cacheService.sdfTextGeometryCache.update(node);
              this.cacheService.sdfTextUniformCache.update(node);
              node.isDirty = false;
          }

          this.sdfTextDrawCommands.updateOrAdd(node);
        }
    }
    this.lastVersion = this.interactionService.worldMatrixVersion;
  }

  private collectActiveCarets(nodes: Node[]) {
    const carets: {
      x: number;
      y: number;
      height: number;
      thickness: number;
      color: { r: number; g: number; b: number; a: number };
      localMatrix: mat4;
      worldMatrix: mat4;
    }[] = [];
  
    const worldMatrix = this.interactionService.getWorldMatrix();
  
    for (const node of nodes) {
      if (node instanceof Text && node.caretVisible) {
        const localX = node.getCaretPosition();
        const localY = 0;
  
        carets.push({
          x: localX,
          y: localY,
          height: Math.max(node.boundingBox.height * (1 / 64), 0.05),
          thickness: 0.0075,
          color: { r: 1, g: 1, b: 1, a: 1 },
          localMatrix: node.localMatrix,
          worldMatrix: worldMatrix
        });
      }
    }
  
    return carets;
  }

  public uploadDrawCommands(): void {
    this.shapeDrawCommands.upload();
    this.strokeDrawCommands.upload();
    this.boundingBoxDrawCommands.upload();
    this.highlightDrawCommands.upload();
    this.lineDrawCommands.upload();
    this.sdfTextDrawCommands.upload();
    // this.patternDrawCommands.upload();
  }

  public getDrawBuffers(): {
  shape: GPUBuffer,
  stroke: GPUBuffer,
  boundingBox: GPUBuffer,
  highlight: GPUBuffer,
  pattern: GPUBuffer,
  line: GPUBuffer,
  sdfText: GPUBuffer
  } {
    return {
        shape: this.shapeDrawCommands.getBuffer(),
        stroke: this.strokeDrawCommands.getBuffer(),
        boundingBox: this.boundingBoxDrawCommands.getBuffer(),
        highlight: this.highlightDrawCommands.getBuffer(),
        pattern: this.patternDrawCommands.getBuffer(),
        line: this.lineDrawCommands.getBuffer(),
        sdfText: this.sdfTextDrawCommands.getBuffer()
    };
  }
    
  public getDrawCounts(): {
    shape: number,
    stroke: number,
    boundingBox: number,
    highlight: number,
    pattern: number,
    line: number,
    sdfText: number
  } {
    return {
      shape: this.shapeDrawCommands.drawCount,
      stroke: this.strokeDrawCommands.drawCount,
      boundingBox: this.boundingBoxDrawCommands.drawCount,
      highlight: this.highlightDrawCommands.drawCount,
      pattern: this.patternDrawCommands.drawCount,
      line: this.lineDrawCommands.drawCount,
      sdfText: this.sdfTextDrawCommands.drawCount
    };
  }

  initializeDrawCountBuffers(device: GPUDevice) {
    const usage = GPUBufferUsage.COPY_DST | GPUBufferUsage.INDIRECT;

    // Create a single buffer with space for 7 u32 values (4 bytes each = 28 bytes total)
    const drawTypeCount = Object.keys(this.drawCountBufferOffsets).length;
    const buffer = device.createBuffer({
        size: drawTypeCount * 4, // 24 bytes
        usage,
        mappedAtCreation: true
    });

    // Initialize all counts to 0
    const array = new Uint32Array(buffer.getMappedRange());
    array.fill(0);
    buffer.unmap();

    // Store buffer reference once
    this.drawCountBuffer = buffer;

    // Store byte offsets per type
    const types = ['shape', 'stroke', 'highlight', 'boundingBox', 'pattern', 'line', 'sdfText'] as const;
    types.forEach((type, index) => {
        this.drawCountBufferOffsets[type] = index * 4; // 4 bytes per entry
    });
  }

  uploadDrawCounts(device: GPUDevice) {
    const types: DrawType[] = ['shape', 'stroke', 'highlight', 'boundingBox', 'line', 'sdfText'];
    for (const type of types) {
        const count = this.getDrawCounts()[type];
        const offset = this.drawCountBufferOffsets[type];
        device.queue.writeBuffer(this.drawCountBuffer, offset, new Uint32Array([count]));
    }
  }

  getDrawCountBuffer(): GPUBuffer {
    return this.drawCountBuffer;
  }

  private drawPattern(passEncoder: GPURenderPassEncoder, pattern: Pattern) {

    if (!pattern.texture) {
        console.warn(`Pattern texture not loaded for: ${pattern.texture}`);
        return; // Exit early to avoid errors
    }

    // Allocate space in dynamic uniform buffer
    const offset = this.renderCache.allocateShape(pattern);
    const bindGroup = this.device.createBindGroup({
        layout: this.pipelineManager.getPatternPipeline().getBindGroupLayout(0),
        entries: [
            {
                binding: 0, 
                resource: { 
                    buffer: this.renderCache.dynamicUniformBuffer,
                    offset: offset,
                    size: 192
                }
            },
            {
                binding: 1, // Bind the pattern texture
                resource: pattern.texture.createView(),
            },
            {
                binding: 2, // Bind the sampler
                resource: this.patternSampler,
            }
        ],
    });

    // Compute proper UV scaling based on pattern size
    const patternWidth = pattern.texture.width;  // Get actual texture size
    // const patternHeight = pattern.texture.height;

    // Compute length of the dragged shape
    const shapeLength = Math.sqrt((pattern.x2 - pattern.x1) ** 2 + (pattern.y2 - pattern.y1) ** 2);
    const shapeThickness = pattern.strokeWidth;  // Keep thickness consistent

    // Set uScale based on shape length so it tiles only in the dragged direction
    const uScale = 1600 * shapeLength / patternWidth;

    // Keep vScale fixed so that it doesn’t stretch in the perpendicular direction
    const vScale = 2;  // Ensures no tiling along the thickness axis

    // Compute perpendicular thickness
    const halfThickness = shapeThickness * 0.005;

    const startX = pattern.x1;
    const startY = pattern.y1;
    const endX = pattern.x2;
    const endY = pattern.y2;

    // Compute direction vector
    const dirX = (endX - startX) / shapeLength;
    const dirY = (endY - startY) / shapeLength;

    // Compute perpendicular vector for thickness
    const normalX = -dirY * halfThickness;
    const normalY = dirX * halfThickness;

    // UVs should align exactly along the dragged direction, with v fixed
    const vertices = new Float32Array([
        startX - normalX, startY - normalY, 0, 0,  // Bottom-left (UV 0,0)
        endX - normalX, endY - normalY, uScale, 0,  // Bottom-right (UV uScale,0)
        startX + normalX, startY + normalY, 0, vScale,  // Top-left (UV 0,1)
        startX + normalX, startY + normalY, 0, vScale,  // Top-left (Duplicate)
        endX - normalX, endY - normalY, uScale, 0,  // Bottom-right (Duplicate)
        endX + normalX, endY + normalY, uScale, vScale  // Top-right (UV uScale,1)
    ]);

    const vertexBuffer = this.device.createBuffer({
        size: vertices.byteLength, 
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true
    });

    new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
    vertexBuffer.unmap();

    // Bind pipeline and resources
    passEncoder.setPipeline(this.pipelineManager.getPatternPipeline());
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.setVertexBuffer(0, vertexBuffer);

    // Use correct draw command (2 vertices for 1 line)
    passEncoder.draw(6, 1, 0, 0);
  }

  private drawText(passEncoder: GPURenderPassEncoder, text: Text) {
    if (!text.textureView || text.width === 0 || text.height === 0) return;

    // Step 1: Allocate uniforms (position, size, etc.)
    const offset = this.renderCache.allocateShape(text);

    // Step 2: Create bind group (same layout as pattern)
    const bindGroup = this.device.createBindGroup({
        layout: this.pipelineManager.getTextPipeline().getBindGroupLayout(0),
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: this.renderCache.dynamicUniformBuffer,
                    offset,
                    size: 192
                }
            },
            {
                binding: 1,
                resource: text.textureView
            },
            {
                binding: 2,
                resource: this.textSampler
            }
        ]
    });

    // Step 3: Create quad with UVs
    const scale = 1 / 64;
    const w = text.width * scale;
    const h = text.height * scale;

    const vertices = new Float32Array([
        0, 0, 0, 0,
        w, 0, 1, 0,
        0, h, 0, 1,
        0, h, 0, 1,
        w, 0, 1, 0,
        w, h, 1, 1
    ]);

    const vertexBuffer = this.device.createBuffer({
        size: vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true
    });

    new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
    vertexBuffer.unmap();

    // Step 4: Draw text quad
    passEncoder.setPipeline(this.pipelineManager.getTextPipeline());
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.setVertexBuffer(0, vertexBuffer);
    passEncoder.draw(6, 1, 0, 0);

    // Optional: draw caret
    this.drawCaretInstances(passEncoder);
  }

  private drawCaretInstances(passEncoder: GPURenderPassEncoder) {
    const vertexBuffer = this.getSharedCaretQuad(); // Reuse a 4-vertex thin quad
    passEncoder.setPipeline(this.pipelineManager.getCaretPipeline());
    passEncoder.setBindGroup(0, this.cacheService.bindGroupManager.sharedCaretBindGroup);
    passEncoder.setVertexBuffer(0, vertexBuffer);
    passEncoder.draw(4, this.caretManager.getCount(), 0, 0); // 4 vertices per caret
  }

  private caretQuadBuffer!: GPUBuffer;
  private getSharedCaretQuad(): GPUBuffer {
    if (!this.caretQuadBuffer) {
      const verts = new Float32Array([
        0, 0,
        0, 1,
        1, 0,
        1, 1
      ]);

      this.caretQuadBuffer = this.device.createBuffer({
        size: verts.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true
      });

      new Float32Array(this.caretQuadBuffer.getMappedRange()).set(verts);
      this.caretQuadBuffer.unmap();
    }
    return this.caretQuadBuffer;
  }

  // private drawCaret(passEncoder: GPURenderPassEncoder, text: Text, bindGroup: GPUBindGroup, uniformOffset: number) {
  //   if (!text.caretVisible) return;

  //   const scale = 1 / 64;
  //   const caretX = text.getCaretPosition();
  //   const caretHeight = Math.max(text.boundingBox.height * scale, 0.05);
  //   const thickness = Math.max(0.005, 0.01);

  //   const vertices = new Float32Array([
  //       caretX, 0,
  //       caretX, caretHeight,
  //       caretX + thickness, 0,
  //       caretX + thickness, caretHeight
  //   ]);

  //   const vertexBuffer = this.device.createBuffer({
  //       size: vertices.byteLength,
  //       usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  //       mappedAtCreation: true
  //   });
  //   new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
  //   vertexBuffer.unmap();

  //   const indices = new Uint16Array([0, 1, 2, 1, 2, 3]);
  //   const indexBuffer = this.device.createBuffer({
  //       size: indices.byteLength,
  //       usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  //       mappedAtCreation: true
  //   });
  //   new Uint16Array(indexBuffer.getMappedRange()).set(indices);
  //   indexBuffer.unmap();

  //   passEncoder.setPipeline(this.pipelineManager.getLinePipeline());
  //   passEncoder.setBindGroup(0, bindGroup, [uniformOffset]);
  //   passEncoder.setVertexBuffer(0, vertexBuffer);
  //   passEncoder.setIndexBuffer(indexBuffer, 'uint16');
  //   passEncoder.drawIndexed(6, 1, 0, 0);
  // }
}