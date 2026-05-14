// src/rendering/webgpu-render-strategy.ts
import { RenderStrategy } from './render-strategy';
import { Node } from '../../scene-graph/shapes/base/node';
import { Rectangle } from '../../scene-graph/shapes/rectangle';
import { Circle } from '../../scene-graph/shapes/circle';
import { Diamond } from '../../scene-graph/shapes/diamond';
import { Triangle } from '../../scene-graph/shapes/triangle';
import { InvertedTriangle } from '../../scene-graph/shapes/inverted-triangle';
import { Polygon } from '../../scene-graph/shapes/polygon';
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
import { TextureArrayAtlas } from '../caches/texture-cache/texture-array-atlas';
import { TexturedInstanceBuffer } from '../caches/texture-cache/textured-instance-buffer';
import { TextureCache } from '../caches/texture-cache/texture-cache';
import { Stamp } from '../../scene-graph/shapes/stamp';
import { LiveTextNode } from '../../scene-graph/shapes/live-text';

type DrawType = 'shape' | 'stroke' | 'highlight' | 'boundingBox' | 'line' | 'sdfText';

export class WebGPURenderStrategy implements RenderStrategy {
    
  private device: GPUDevice;
  private pipelineManager: PipelineManager;
  private interactionService: InteractionService;
  private cacheService: CacheService;
  private textSampler!: GPUSampler;

  // textures
  private texturedInstBuf!: TexturedInstanceBuffer;
  private atlas!: TextureArrayAtlas;
  private texturedCount = 0;

  // LiveTextNode instances collected during beginFrame for rendering
  private _liveTextNodes: LiveTextNode[] = [];

  public shapeDrawCommands: IndirectDrawCommandBuffer;
  public strokeDrawCommands: IndirectDrawCommandBuffer;
  public lineDrawCommands: IndirectDrawCommandBuffer;
  public boundingBoxDrawCommands: IndirectDrawCommandBuffer;
  public highlightDrawCommands: IndirectDrawCommandBuffer;
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
      line: 16,
      sdfText: 20,
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
    this.texturedInstBuf = new TexturedInstanceBuffer(device, 256);
    this.atlas = cacheService.textureArrayAtlas;

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
    
    this.initializeDrawCountBuffers(this.device);
  }

  currentStagingStroke?: Shape = undefined;
  lastVersion: number = 0;
  public async beginFrame(
    nodes: Node[], 
    stagingBuffer: StrokesStagingBuffer, 
    stagingContainer: StagingContainer
  ): Promise<void> {
    
    // Do these need to be cleared?
    this.shapeDrawCommands.clear();
    this.strokeDrawCommands.clear();
    this.lineDrawCommands.clear();
    this.boundingBoxDrawCommands.clear();
    this.highlightDrawCommands.clear();
    this.sdfTextDrawCommands.clear();
    this.texturedInstBuf.beginFrame();
    this.texturedCount = 0;
    this._liveTextNodes = [];
    
    // Triple Buffering: Safely reset this frame’s staging data before drawing into it
    if (this.currentStagingStroke?.isStaging) stagingBuffer.beginFrame();

    this.cacheService.boundingBoxUniformCache.updateWorldMatrix();
    for (const node of nodes) {
      if (!(node instanceof Shape)) continue;

      // Skip 2D selection outline for 3D scene nodes — they have their own gizmo/highlight system.
      const nodeType = (node as Shape).getType();
      const is3DNode = nodeType === '3DMesh' || nodeType === '3DMeshGroup' ||
                       nodeType === '3DClothMesh' || nodeType === 'GpObject3D' ||
                       nodeType === 'ParticleEmitter3D';

      if (!is3DNode && node.isSelected()) {
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
          node instanceof Polygon          ||
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
          const key = node.textureKey;
          
          // Check if THIS PATTERN needs updating, not just if texture exists
          const atlasLayer = this.atlas.getLayer(key);
          
          if (atlasLayer < 0) {
              // Texture not in atlas - load it
              this.atlas.ensure(key).then((resolvedLayer) => {
                  node.layerIndex = resolvedLayer;
                  node.atlasWidth = this.atlas.getWidth();
                  node.markDirty();
                  this.interactionService.requestRender();
              }).catch(console.error);
              
              // Skip rendering this frame - texture not ready
              continue;
          } else if (node.layerIndex !== atlasLayer) {
              // Texture exists but this pattern hasn't been updated yet
              node.layerIndex = atlasLayer;
              node.atlasWidth = this.atlas.getWidth();
              node.markDirty();
          }
          
          // Use the pattern's assigned layer (should be valid now)
          const layer = node.layerIndex;
          
          const x1 = node.relativeX1;
          const y1 = node.relativeY1;
          const x2 = node.relativeX2;
          const y2 = node.relativeY2;
          
          const dx = x2 - x1, dy = y2 - y1;
          const len = Math.hypot(dx, dy) || 1;
          const angle = Math.atan2(dy, dx);
          const midx = (x1 + x2) * 0.5, midy = (y1 + y2) * 0.5;

          const local = mat4.create();
          mat4.translate(local, local, [midx, midy, 0]);
          mat4.rotateZ(local, local, angle);
          const thickness = node.strokeWidth * 0.03;
          mat4.scale(local, local, [len, thickness, 1]);

          const world = this.interactionService.getWorldMatrix() as Float32Array;
          const shapeWorld = mat4.mul(mat4.create(), node.parentChainMatrix, node.localMatrix);
          const finalTransform = mat4.mul(mat4.create(), shapeWorld, local);

          const uScale = 3.5*(len / this.atlas.getWidth()) * 1600;
          const vScale = 2;

          this.texturedInstBuf.ensure(this.texturedCount + 1);
          this.texturedInstBuf.write(this.texturedCount, {
              world,
              local: finalTransform as unknown as Float32Array,
              uvScale: [uScale, vScale],
              uvOffset: [0, 0],
              layerIndex: layer >>> 0,
              flags: 1,
              tint: [1, 1, 1, 1],
          });
          this.texturedCount++;
          continue;
      }
      else if (node instanceof Stamp) {
    const key = node.textureKey;
    
    // Check if texture exists in atlas
    const atlasLayer = this.atlas.getLayer(key);
    
    if (atlasLayer < 0) {
        // Texture not in atlas - load it
        this.atlas.ensure(key).then((resolvedLayer) => {
            node.layerIndex = resolvedLayer;
            node.atlasWidth = this.atlas.getWidth();
            node.atlasHeight = this.atlas.getHeight();
            node.markDirty();
            this.interactionService.requestRender();
        }).catch(console.error);
        
        // Skip rendering this frame - texture not ready
        continue;
    } else if (node.layerIndex !== atlasLayer) {
        // Texture exists but this stamp hasn't been updated yet
        node.layerIndex = atlasLayer;
        node.atlasWidth = this.atlas.getWidth();
        node.atlasHeight = this.atlas.getHeight();
        node.markDirty();
    }
    
    // Use the stamp's assigned layer (should be valid now)
    const layer = node.layerIndex;
    
    // Create transformation matrix for the stamp
    const local = mat4.create();
    mat4.scale(local, local, [node.width, node.height, 1]);

    const world = this.interactionService.getWorldMatrix() as Float32Array;
    const shapeWorld = mat4.mul(mat4.create(), node.parentChainMatrix, node.localMatrix);
    const finalTransform = mat4.mul(mat4.create(), shapeWorld, local);

    // Add to textured instance buffer with different flag for stamps
    this.texturedInstBuf.ensure(this.texturedCount + 1);
    this.texturedInstBuf.write(this.texturedCount, {
        world,
        local: finalTransform as unknown as Float32Array,
        uvScale: [1, 1], // No tiling for stamps - just map full texture
        uvOffset: [0, 0],
        layerIndex: layer >>> 0,
        flags: 2, // Different flag to distinguish stamps from patterns
        tint: [node.fillColor.r, node.fillColor.g, node.fillColor.b, node.fillColor.a],
    });
    this.texturedCount++;
    continue;
}
      else if (node instanceof LiveTextNode) {
        // LiveTextNode renders via a dedicated draw path in the renderer.
        // Feed time so built-in effects (wave, glitch) and custom shaders animate.
        node.dynamicUniforms.time = performance.now() / 1000;
        // Feed cursor UV and mouseDown for cursor-reactive effects
        node.dynamicUniforms.cursorUV = this.interactionService.lastPointerUV;
        node.dynamicUniforms.mouseDown = this.interactionService.pointerDown ? 1 : 0;
        // Update its texture and collect it for later drawing.
        node.updateTexture();
        if (node.getCurrentTexture()) {
          this._liveTextNodes.push(node);
        }
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
          
              // Widen Uint16 indices to Uint32 for the shared index buffer
              const strokeIdx32 = new Uint32Array(info.indexCount);
              for (let j = 0; j < info.indexCount; j++) strokeIdx32[j] = info.indexData[j];
              this.device.queue.writeBuffer(
                this.cacheService.strokeGeometryCache.getIndexBuffer(),
                offset.indexOffset * 4,
                strokeIdx32.buffer,
                strokeIdx32.byteOffset,
                info.indexCount * 4
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
              // Widen Uint16 indices to Uint32 for the shared index buffer
              const lineIdx32 = new Uint32Array(info.indexCount);
              for (let j = 0; j < info.indexCount; j++) lineIdx32[j] = info.indexData[j];
              this.device.queue.writeBuffer(
                this.cacheService.lineGeometryCache.getIndexBuffer(),
                offset.indexOffset * 4,
                lineIdx32.buffer,
                lineIdx32.byteOffset,
                info.indexCount * 4
              );
            }
      
            node.wasCommitted = true;
            this.currentStagingStroke = undefined;
          }
      
          // If endpoints moved (bound connector dragged a shape), regenerate geometry
          if (node.isPointsDirty) {
            node.clearGeometryCache(); // force vertex recalc
            this.cacheService.lineGeometryCache.reuploadLineGeometry(node);
            node.isPointsDirty = false;
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
      
              // Widen Uint16 indices to Uint32 for the shared index buffer
              const hlIdx32 = new Uint32Array(info.indexCount);
              for (let j = 0; j < info.indexCount; j++) hlIdx32[j] = info.indexData[j];
              this.device.queue.writeBuffer(
                this.cacheService.highlightGeometryCache.getIndexBuffer(),
                offset.indexOffset * 4,
                hlIdx32.buffer,
                hlIdx32.byteOffset,
                info.indexCount * 4
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

  public getTexturedInstanceBuffer() { return this.texturedInstBuf; }
  public getTexturedCount() { return this.texturedCount; }
  public getLiveTextNodes(): readonly LiveTextNode[] { return this._liveTextNodes; }

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

  /** Collect SDF-text selection highlight rectangles for the overlay pass. */
  public collectSelectionHighlights(nodes: Node[]) {
    const rects = [] as {
      x: number; y: number; width: number; height: number;
      color: { r: number; g: number; b: number; a: number };
      localMatrix: mat4; worldMatrix: mat4;
    }[];

    const worldMatrix = this.interactionService.getWorldMatrix();

    for (const node of nodes) {
      if (node instanceof SDFText && node.hasSelection()) {
        const selRects = node.getSelectionRects();
        const localMat = node.getRenderLocalMatrix();
        for (const sr of selRects) {
          rects.push({
            x: sr.x,
            y: sr.y,
            width: sr.width,
            height: sr.height,
            color: { r: 0.3, g: 0.5, b: 1.0, a: 0.35 },
            localMatrix: localMat,
            worldMatrix,
          });
        }
      }
    }
    return rects;
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
  line: GPUBuffer,
  sdfText: GPUBuffer,
  } {
    return {
        shape: this.shapeDrawCommands.getBuffer(),
        stroke: this.strokeDrawCommands.getBuffer(),
        boundingBox: this.boundingBoxDrawCommands.getBuffer(),
        highlight: this.highlightDrawCommands.getBuffer(),
        line: this.lineDrawCommands.getBuffer(),
        sdfText: this.sdfTextDrawCommands.getBuffer(),
    };
  }
    
  public getDrawCounts(): {
    shape: number,
    stroke: number,
    boundingBox: number,
    highlight: number,
    line: number,
    sdfText: number,
  } {
    return {
      shape: this.shapeDrawCommands.drawCount,
      stroke: this.strokeDrawCommands.drawCount,
      boundingBox: this.boundingBoxDrawCommands.drawCount,
      highlight: this.highlightDrawCommands.drawCount,
      line: this.lineDrawCommands.drawCount,
      sdfText: this.sdfTextDrawCommands.drawCount,
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
    const types = ['shape', 'stroke', 'highlight', 'boundingBox', 'line', 'sdfText'] as const;
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