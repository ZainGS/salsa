/**
Uses triple buffering (frameCount = 3) to prevent GPU-CPU sync issues across frames.
Allocates per-frame vertex and index buffers that act as in-flight, temporary geometry caches.
Uploads geometry for actively drawn scribbles (or highlights) each frame.
Allows us to render live drawing previews without affecting the shared cache or final buffers.
Lets us "flush" committed strokes into our main StrokesRenderGeometryCache once drawing is finalized.
 */

import { Scribble } from "../../../scene-graph/shapes/scribble";
import { StrokesRenderGeometryCache } from "../geometry-cache/strokes-render-gcache";
import { Highlight } from "../../../scene-graph/shapes/highlight";
import { Line } from "../../../scene-graph/shapes/line";

export class StrokesStagingBuffer {
    private device: GPUDevice;
    private vertexBuffers: GPUBuffer[] = [];
    private indexBuffers: GPUBuffer[] = [];
    private vertexData: Float32Array[] = [];
    private indexData: Uint16Array[] = [];

    private maxVertices = 4096; // Enough for a medium stroke
    private maxIndices = 8192;

    public currentFrameIndex: number = 0;
    private frameCount = 3;

    private readonly BYTES_PER_VERTEX = 4; // Float32
    private readonly BYTES_PER_INDEX = 2;  // Uint16

    private uniformBuffer: GPUBuffer;
    private readonly UNIFORM_SIZE = 272;   // bytes of actual uniform data per draw
    /** Per-slot stride: must be a multiple of minStorageBufferOffsetAlignment (256) for BAKED bind-group offsets.
     *  The old layout used a 272 stride — only ever valid because currentFrameIndex was stuck at 0 (beginFrame was
     *  never called), which also silently limited staging to ONE shape per frame (every write clobbered slot 0, so
     *  the polygon tool's multi-line construction overlay drew N copies of the LAST line). */
    private readonly SLOT_STRIDE = 512;
    /** Max staged shapes per frame. The pen tool previews each CURVED edge as 16 short lines (+4 marker lines
     *  per vertex + rubber band + handle bar), so a large all-curves outline needs hundreds of slots — 1024
     *  covers ~60 curved vertices (uniform buffer 512 B × 3 frames × 1024 = 1.5 MB). Extra shapes are skipped
     *  with a warning, not corrupted. */
    public static readonly SLOTS = 1024;
    /** Slots handed out since beginStagingPass() — also the count of appended shapes this pass. */
    private _passSlot = 0;
    /** Appended geometry cursors (floats / uint16s) since beginStagingPass(). */
    private _passVertexFloats = 0;
    private _passIndices = 0;

    constructor(device: GPUDevice) {
        this.device = device;
        // Layout: [frame][slot] — offset (frame*SLOTS + slot) * SLOT_STRIDE, each slot holding one draw's uniforms.
        this.uniformBuffer = this.device.createBuffer({
            size: this.SLOT_STRIDE * this.frameCount * StrokesStagingBuffer.SLOTS,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        for (let i = 0; i < this.frameCount; i++) {
            this.vertexData[i] = new Float32Array(this.maxVertices);
            this.indexData[i] = new Uint16Array(this.maxIndices);

            this.vertexBuffers[i] = this.device.createBuffer({
                size: this.maxVertices * this.BYTES_PER_VERTEX,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });

            this.indexBuffers[i] = this.device.createBuffer({
                size: this.maxIndices * this.BYTES_PER_INDEX,
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            });
        }
    }

    private lastFrameIndex = -1;
    public beginFrame() {
        const index = (this.currentFrameIndex + 1) % this.frameCount;
        if (index !== this.lastFrameIndex) {
            this.currentFrameIndex = index;
            this.vertexData[this.currentFrameIndex].fill(0);
            this.indexData[this.currentFrameIndex].fill(0);
            this.lastFrameIndex = index;
        }
    }

    // ── Multi-shape staging (one PASS = many staged shapes appended into the frame's buffers) ────────────────
    // The removed single-slot write* methods clobbered offset 0 per call, so N staged shapes all drew the LAST
    // one's geometry (queue writes execute before any pass draw). The append API gives each shape its own uniform
    // slot + geometry range so the whole construction overlay (polygon edges/markers) renders correctly in one pass.

    /** Reset the per-pass cursors. Call ONCE per frame before the staged-shape draw calls (all categories —
     *  scribbles/lines/highlights share these buffers, so do NOT reset between categories). */
    public beginStagingPass(): void {
        this._passSlot = 0;
        this._passVertexFloats = 0;
        this._passIndices = 0;
    }

    /** Claim the next uniform slot and write `data` into it. Returns the slot, or -1 when the pass is full. */
    public appendUniforms(data: Float32Array): number {
        if (this._passSlot >= StrokesStagingBuffer.SLOTS) return -1;
        const slot = this._passSlot++;
        this.device.queue.writeBuffer(
            this.uniformBuffer,
            (this.currentFrameIndex * StrokesStagingBuffer.SLOTS + slot) * this.SLOT_STRIDE,
            data.buffer, data.byteOffset, data.byteLength,
        );
        return slot;
    }

    /** Bind group for one claimed slot (baked 256-aligned offset; pass [0] as the dynamic offset). */
    public createStagingBindGroupAt(layout: GPUBindGroupLayout, slot: number): GPUBindGroup {
        return this.device.createBindGroup({
            layout,
            entries: [{
                binding: 0,
                resource: {
                    buffer: this.uniformBuffer,
                    offset: (this.currentFrameIndex * StrokesStagingBuffer.SLOTS + slot) * this.SLOT_STRIDE,
                    size: this.UNIFORM_SIZE,
                },
            }],
        });
    }

    /** Grow the current frame's arrays/buffers PRESERVING already-appended data (the single-shape grow paths
     *  drop content — fine there, fatal mid-append). */
    private _growForAppend(neededFloats: number, neededIndices: number): void {
        const frame = this.currentFrameIndex;
        if (neededFloats > this.maxVertices) {
            this.maxVertices = neededFloats * 2;
            const next = new Float32Array(this.maxVertices);
            next.set(this.vertexData[frame]);
            this.vertexData[frame] = next;
            this.vertexBuffers[frame] = this.device.createBuffer({
                size: this.maxVertices * this.BYTES_PER_VERTEX,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            // New GPU buffer starts empty — re-upload everything appended so far.
            this.device.queue.writeBuffer(this.vertexBuffers[frame], 0, next.buffer, next.byteOffset, this._passVertexFloats * this.BYTES_PER_VERTEX);
        }
        if (neededIndices > this.maxIndices) {
            this.maxIndices = neededIndices * 2;
            const next = new Uint16Array(this.maxIndices);
            next.set(this.indexData[frame]);
            this.indexData[frame] = next;
            this.indexBuffers[frame] = this.device.createBuffer({
                size: this.maxIndices * this.BYTES_PER_INDEX,
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            });
            this.device.queue.writeBuffer(this.indexBuffers[frame], 0, next.buffer, next.byteOffset, Math.ceil(this._passIndices * this.BYTES_PER_INDEX / 4) * 4);
        }
    }

    /** Append one Line's geometry at the pass cursor. Indices stay RELATIVE (0..n-1) — the draw supplies
     *  baseVertex — so the commit path's shared-cache copy (which widens relative indices) stays correct. */
    public appendLine(line: Line): { firstIndex: number; indexCount: number; baseVertex: number;
        info: { vertexCount: number; indexCount: number; vertexStart: number; indexStart: number; frameIndex: number } } {
        const frame = this.currentFrameIndex;
        const vertices = line.getGeometryVertices();
        const drawVertexCount = vertices.length / 2;
        this._growForAppend(this._passVertexFloats + vertices.length, this._passIndices + drawVertexCount + 1);

        const vertexStart = this._passVertexFloats;
        const firstIndex = this._passIndices;
        this.vertexData[frame].set(vertices, vertexStart);
        for (let i = 0; i < drawVertexCount; i++) this.indexData[frame][firstIndex + i] = i;

        this.device.queue.writeBuffer(
            this.vertexBuffers[frame], vertexStart * this.BYTES_PER_VERTEX,
            this.vertexData[frame].buffer, this.vertexData[frame].byteOffset + vertexStart * this.BYTES_PER_VERTEX,
            vertices.length * this.BYTES_PER_VERTEX,
        );
        this.device.queue.writeBuffer(
            this.indexBuffers[frame], firstIndex * this.BYTES_PER_INDEX,
            this.indexData[frame].buffer, this.indexData[frame].byteOffset + firstIndex * this.BYTES_PER_INDEX,
            Math.ceil(drawVertexCount * this.BYTES_PER_INDEX / 4) * 4,
        );

        this._passVertexFloats += vertices.length;
        this._passIndices += drawVertexCount;
        if (this._passIndices % 2 === 1) this._passIndices++;   // keep index BYTE offsets 4-aligned for writeBuffer

        return {
            firstIndex, indexCount: drawVertexCount, baseVertex: vertexStart / 2,
            info: { vertexCount: drawVertexCount, indexCount: drawVertexCount, vertexStart, indexStart: firstIndex, frameIndex: frame },
        };
    }

    /** Append one Scribble/Highlight's quad-strip geometry at the pass cursor (same smoothed-normal expansion
     *  as writeStroke; indices RELATIVE for baseVertex draws + the shared-cache commit copy). */
    public appendStroke(s: Scribble | Highlight): { firstIndex: number; indexCount: number; baseVertex: number;
        info: { vertexCount: number; indexCount: number; vertexStart: number; indexStart: number; frameIndex: number } } {
        const frame = this.currentFrameIndex;
        const points = s.points;
        const segs = Math.max(0, points.length - 1);
        const neededFloats = segs * 8, neededIndices = segs * 6;
        this._growForAppend(this._passVertexFloats + neededFloats, this._passIndices + neededIndices + 1);

        const vertexStart = this._passVertexFloats;
        const firstIndex = this._passIndices;
        const vertexArray = this.vertexData[frame];
        const indexArray = this.indexData[frame];
        const halfThickness = s.strokeWidth / 2;

        const normals: { x: number; y: number }[] = [];
        for (let p = 0; p < points.length; p++) {
            const prev = points[p - 1] ?? points[p];
            const next = points[p + 1] ?? points[p];
            const dx = next.x - prev.x, dy = next.y - prev.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            normals.push({ x: -(dy / len), y: dx / len });
        }
        let v = vertexStart, i = firstIndex;
        for (let p = 1; p < points.length; p++) {
            const prev = points[p - 1], curr = points[p];
            const nA = normals[p - 1], nB = normals[p];
            vertexArray[v++] = prev.x - nA.x * halfThickness; vertexArray[v++] = prev.y - nA.y * halfThickness;
            vertexArray[v++] = prev.x + nA.x * halfThickness; vertexArray[v++] = prev.y + nA.y * halfThickness;
            vertexArray[v++] = curr.x - nB.x * halfThickness; vertexArray[v++] = curr.y - nB.y * halfThickness;
            vertexArray[v++] = curr.x + nB.x * halfThickness; vertexArray[v++] = curr.y + nB.y * halfThickness;
            const vi = (v - vertexStart - 8) / 2;   // RELATIVE to this stroke's base
            indexArray[i++] = vi; indexArray[i++] = vi + 1; indexArray[i++] = vi + 2;
            indexArray[i++] = vi + 1; indexArray[i++] = vi + 2; indexArray[i++] = vi + 3;
        }

        this.device.queue.writeBuffer(
            this.vertexBuffers[frame], vertexStart * this.BYTES_PER_VERTEX,
            vertexArray.buffer, vertexArray.byteOffset + vertexStart * this.BYTES_PER_VERTEX,
            neededFloats * this.BYTES_PER_VERTEX,
        );
        this.device.queue.writeBuffer(
            this.indexBuffers[frame], firstIndex * this.BYTES_PER_INDEX,
            indexArray.buffer, indexArray.byteOffset + firstIndex * this.BYTES_PER_INDEX,
            Math.ceil(neededIndices * this.BYTES_PER_INDEX / 4) * 4,
        );

        this._passVertexFloats += neededFloats;
        this._passIndices += neededIndices;   // 6/seg — already even

        return {
            firstIndex, indexCount: neededIndices, baseVertex: vertexStart / 2,
            info: { vertexCount: neededFloats, indexCount: neededIndices, vertexStart, indexStart: firstIndex, frameIndex: frame },
        };
    }

    /** Draw one appended shape (its own uniform slot + geometry range). */
    public drawAppended(pass: GPURenderPassEncoder, bindGroup: GPUBindGroup, d: { firstIndex: number; indexCount: number; baseVertex: number }): void {
        if (d.indexCount === 0) return;
        pass.setBindGroup(0, bindGroup, [0]);
        pass.setVertexBuffer(0, this.vertexBuffers[this.currentFrameIndex]);
        pass.setIndexBuffer(this.indexBuffers[this.currentFrameIndex], 'uint16');
        pass.setStencilReference(9999999);   // for highlights
        pass.drawIndexed(d.indexCount, 1, d.firstIndex, d.baseVertex, 0);
    }
  
    // (The legacy single-slot write/draw API — writeStroke/writeLine/renderStagingStroke/writeUniforms — was
    // removed 2026-09-10: superseded by the append API above, which gives every staged shape its own uniform
    // slot + geometry range. copyToSharedBuffer below is the surviving commit-path consumer of _stagingInfo.)

    public copyToSharedBuffer(obj: Scribble | Highlight | Line, shared: StrokesRenderGeometryCache) {
        const frameIndex = obj._stagingInfo.frameIndex;
        // Appended shapes carry their range start; the legacy single-slot path always wrote at 0.
        const vertexStart = obj._stagingInfo.vertexStart ?? 0;
        const indexStart = obj._stagingInfo.indexStart ?? 0;
        const offset = shared.getOffset(obj);

        if (!offset) {
            // Should never happen: the object was flushed without a reserved slot in
            // the shared cache. Skip it — drawing without an offset would write geometry
            // to the wrong region of the shared buffer (garbage on screen).
            console.warn("StrokesStagingBuffer.copyToSharedBuffer: missing shared-cache offset for", obj.id, "— skipping");
            return;
        }

        this.device.queue.writeBuffer(
            shared.getVertexBuffer(),
            offset.vertexOffset * 4,
            this.vertexData[frameIndex].buffer,
            this.vertexData[frameIndex].byteOffset + vertexStart * 4,
            offset.vertexCount * 4
        );

        // Staging uses Uint16 indices internally, but the shared buffer uses Uint32.
        // Widen the index data before uploading (indices are RELATIVE to the shape's base in both layouts).
        const src16 = this.indexData[frameIndex];
        const indexCount = offset.indexCount;
        const wide = new Uint32Array(indexCount);
        for (let j = 0; j < indexCount; j++) wide[j] = src16[indexStart + j];

        this.device.queue.writeBuffer(
            shared.getIndexBuffer(),
            offset.indexOffset * 4,
            wide.buffer,
            wide.byteOffset,
            indexCount * 4
        );

    }
}