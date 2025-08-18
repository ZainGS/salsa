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

  public shapeDrawCommands: IndirectDrawCommandBuffer;
  public strokeDrawCommands: IndirectDrawCommandBuffer;
  public lineDrawCommands: IndirectDrawCommandBuffer;
  public boundingBoxDrawCommands: IndirectDrawCommandBuffer;
  public highlightDrawCommands: IndirectDrawCommandBuffer;
  public patternDrawCommands: IndirectDrawCommandBuffer;
  public sdfTextDrawCommands: IndirectDrawCommandBuffer;

  public strokeGeometryGenerator!: StrokeGeometryGenerator;

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
    this.pipelineManager = pipelineManager;
    this.interactionService = interactionService;
    this.cacheService = cacheService;
    this.strokeGeometryGenerator = new StrokeGeometryGenerator();

    // Create a sampler for v1 text
    this.textSampler = this.device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
    });

    this.sdfTextDrawCommands = new IndirectDrawCommandBuffer(device, cacheService.sdfTextRegistry, 'sdfText');
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
  public beginFrame(
    nodes: Node[], 
    stagingBuffer: StrokesStagingBuffer, 
    stagingContainer: StagingContainer
  ): void {
    
    // Do these need to be cleared?
    this.shapeDrawCommands.clear();
    this.strokeDrawCommands.clear();
    this.lineDrawCommands.clear();
    this.boundingBoxDrawCommands.clear();
    this.highlightDrawCommands.clear();
    this.sdfTextDrawCommands.clear();
    // this.patternDrawCommands.clear();
    
    // Triple Buffering: Safely reset this frame’s staging data before drawing into it
    if (this.currentStagingStroke?.isStaging) stagingBuffer.beginFrame();

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
        // I've now deferred this to render() to keep all draws together
        stagingContainer.patterns.push(node);
        continue;
      }
      else if (node instanceof Scribble) {
        if (node.isStaging) {
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
              stagingBuffer.copyToSharedBuffer(node, this.cacheService.lineGeometryCache);
            } else {
              info = this.strokeGeometryGenerator.generateLine(node);
              node._stagingInfo = info;
      
              this.cacheService.lineGeometryCache.allocateLine(node);
              this.cacheService.lineUniformCache.allocate(node);
      
              const offset = this.cacheService.lineGeometryCache.getOffset(node)!;
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

  public collectActiveCarets(nodes: Node[]) {
  const carets = [] as {
    x:number; y:number; height:number; thickness:number;
    color:{r:number;g:number;b:number;a:number};
    localMatrix: mat4; worldMatrix: mat4;
  }[];

  const worldMatrix = this.interactionService.getWorldMatrix();

  for (const node of nodes) {
    if (node instanceof Text && node.caretVisible) {
      carets.push({
        x: node.getCaretPosition(),
        y: 0,
        height: Math.max(node.boundingBox.height * (1/64), 0.05),
        thickness: 0.0075,
        color: { r:1, g:1, b:1, a:1 },
        localMatrix: node.localMatrix,
        worldMatrix
      });
    }

    if (node instanceof SDFText && node.caretVisible) {
      const { x, y, height, thickness } = node.getCaretRect();
      carets.push({
        x, y, height, thickness,
        color: { r:1, g:1, b:1, a:1 },
        // use scale-stripped local so caret width/height are pixel-consistent
        localMatrix: node.getRenderLocalMatrix(),
        worldMatrix
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
}