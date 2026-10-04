// ── P22 tile landing: the PACKED vertex format of the geometry pool (performance-plan §P22) ─────────────────────────
// The pool's one vertex layout is 48 bytes: position (3 floats), normal (3), uv (2) and a tangent (4). Every city /
// world mesh carries the CONSTANT tangent (1, 0, 0, 1) (no normal maps), so a third of every streamed tile's vertex
// bytes is the same 16 bytes repeated. A packable geometry (`MeshGeometry.packable`, set by the world builds; ≤ 65,536
// vertices; tangent exactly (1, 0, 0, 1) on every vertex) is stored as:
//   · 32-byte vertices: position, normal, uv — the same f32 values, so the vertex shader reads the same floats;
//   · 16-bit indices (each geometry is drawn with its own baseVertex, so 16 bits cover it).
// The pipelines that draw pooled geometry get a TWIN (packedTwin) whose vertex state reads slot 0 with a 32-byte
// stride and the tangent from slot 1, a 16-byte buffer of (1, 0, 0, 1) with arrayStride 0 (every vertex reads the
// same element). The shader modules are unchanged, so the output is the same, bit for bit. Characters (the skinned
// path, its own buffers) and everything not marked packable keep the 48-byte format.
//
// Allocation: both strides share one pool buffer, so every vertex span is a multiple of POOL_VTX_ALIGN (96 = lcm of
// 32 and 48) bytes; then any allocation's offset divides by either stride (baseVertex = offset / stride).

import type { MeshGeometry } from './mesh-generators';

/** Packed vertex stride (bytes): position, normal, uv. */
export const PACKED_STRIDE = 32;
/** The 48-byte stride of the pool's full layout. */
export const FULL_STRIDE = 48;
/** Vertex spans in the pool are multiples of this (lcm of the two strides). */
export const POOL_VTX_ALIGN = 96;
/** The most vertices a 16-bit-indexed geometry may have. */
export const MAX_PACKED_VERTS = 65536;

/** Round a vertex span up to the pool alignment. */
export const alignVtx = (bytes: number): number => Math.ceil(bytes / POOL_VTX_ALIGN) * POOL_VTX_ALIGN;
/** Round an index span up to 4 bytes (writeBuffer sizes and offsets are multiples of 4). */
export const alignIdx = (bytes: number): number => Math.ceil(bytes / 4) * 4;

/** A geometry as the pool stores it: the bytes to write and their spans (padded), and the format. */
export interface PoolView {
    /** Packed (32-byte vertices, 16-bit indices). */
    pk: boolean;
    vb: Uint8Array;
    ib: Uint8Array;
    /** Padded spans in the pool (≥ vb / ib byte lengths). */
    vtxBytes: number;
    idxBytes: number;
}

type Packable = MeshGeometry & { packable?: boolean };

/** Pack 12-float vertices into 8-float ones (null when a tangent is not exactly (1, 0, 0, 1): stays unpacked). */
export function packVertices(src: Float32Array): Float32Array | null {
    const n = (src.length / 12) | 0, out = new Float32Array(n * 8);
    for (let i = 0, a = 0, b = 0; i < n; i++, a += 12, b += 8) {
        if (src[a + 8] !== 1 || src[a + 9] !== 0 || src[a + 10] !== 0 || src[a + 11] !== 1) return null;
        out[b] = src[a]; out[b + 1] = src[a + 1]; out[b + 2] = src[a + 2];
        out[b + 3] = src[a + 3]; out[b + 4] = src[a + 4]; out[b + 5] = src[a + 5];
        out[b + 6] = src[a + 6]; out[b + 7] = src[a + 7];
    }
    return out;
}
/** Unpack 8-float vertices back to 12 floats with the constant tangent (tests: the round trip is exact). */
export function unpackVertices(src: Float32Array): Float32Array {
    const n = (src.length / 8) | 0, out = new Float32Array(n * 12);
    for (let i = 0, a = 0, b = 0; i < n; i++, a += 8, b += 12) {
        for (let k = 0; k < 8; k++) out[b + k] = src[a + k];
        out[b + 8] = 1; out[b + 9] = 0; out[b + 10] = 0; out[b + 11] = 1;
    }
    return out;
}
/** 32-bit indices → 16-bit (an even count: a trailing 0 pads an odd one; null when an index is ≥ 65,536). */
export function packIndices(src: Uint32Array): Uint16Array | null {
    const out = new Uint16Array(src.length + (src.length & 1));
    for (let i = 0; i < src.length; i++) { const v = src[i]; if (v > 0xffff) return null; out[i] = v; }
    return out;
}

/** Can `g` be stored packed (cheap checks; the tangent is checked while packing)? */
export function canPack(g: MeshGeometry): boolean {
    const p = g as Packable;
    return p.packable === true && !!g.indices && g.indices.length > 0 && g.vertices.length / 12 <= MAX_PACKED_VERTS && g.vertices.length % 12 === 0;
}

const _views = new WeakMap<object, PoolView>();
/** The pool view of `g` in packing mode `mode` (P22_RENDER.packedVertices at the pool's last rebuild): packed when the
 *  mode is on, `pack` (the renderer's twin pipelines are ready) and `g` can be; with the mode on every span is padded to
 *  POOL_VTX_ALIGN (so both strides share the pool), with it off the view is `g` itself, unpadded (the old pool, byte
 *  for byte). A packed view (a copy of the bytes) is cached until `dropPoolView` — a sliced upload reads it over
 *  several frames. */
export function poolViewOf(g: MeshGeometry, mode: boolean, pack = mode): PoolView {
    if (mode && pack) { const c = _views.get(g); if (c) return c; }
    if (mode && pack && canPack(g)) {
        const pv = packVertices(g.vertices as Float32Array), pi = pv ? packIndices(g.indices as Uint32Array) : null;
        if (pv && pi) {
            const v: PoolView = { pk: true, vb: new Uint8Array(pv.buffer), ib: new Uint8Array(pi.buffer), vtxBytes: alignVtx(pv.byteLength), idxBytes: alignIdx(pi.byteLength) };
            _views.set(g, v);
            return v;
        }
        (g as Packable).packable = false;   // a non-constant tangent / an out-of-range index: never try again
    }
    const vs = g.vertices, is = g.indices;
    return { pk: false, vb: new Uint8Array(vs.buffer, vs.byteOffset, vs.byteLength), ib: new Uint8Array(is.buffer, is.byteOffset, is.byteLength),
        vtxBytes: mode ? alignVtx(vs.byteLength) : vs.byteLength, idxBytes: is.byteLength };
}
/** Forget `g`'s cached packed bytes (its upload finished). */
export function dropPoolView(g: MeshGeometry): void { _views.delete(g); }

/** Vertex stride / index size of an allocation's format. */
export const strideOf = (pk: boolean | undefined): number => (pk ? PACKED_STRIDE : FULL_STRIDE);
export const indexSizeOf = (pk: boolean | undefined): number => (pk ? 2 : 4);
export const indexFormatOf = (pk: boolean | undefined): GPUIndexFormat => (pk ? 'uint16' : 'uint32');

// ── pipeline twins ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The twin's vertex buffers for a full-format descriptor: slot 0 = the 48-byte layout's attributes below offset 32
 *  at a 32-byte stride, slot 1 = its tangent attribute (offset 32) at arrayStride 0. Null when the descriptor does not
 *  read the 48-byte pool layout (a second vertex buffer, another stride, an attribute in the tangent's bytes). */
export function packedVertexBuffers(buffers: readonly (GPUVertexBufferLayout | null | undefined)[] | undefined): GPUVertexBufferLayout[] | null {
    if (!buffers || buffers.length !== 1 || !buffers[0]) return null;
    const b = buffers[0];
    if (b.arrayStride !== FULL_STRIDE || (b.stepMode ?? 'vertex') !== 'vertex') return null;
    const lo: GPUVertexAttribute[] = [];
    let tan: GPUVertexAttribute | null = null;
    for (const a of b.attributes) {
        if (a.offset === 32 && a.format === 'float32x4') { tan = a; continue; }
        if (a.offset + attrBytes(a.format) > PACKED_STRIDE) return null;
        lo.push(a);
    }
    const out: GPUVertexBufferLayout[] = [{ arrayStride: PACKED_STRIDE, attributes: lo }];
    if (tan) out.push({ arrayStride: 0, attributes: [{ shaderLocation: tan.shaderLocation, offset: 0, format: 'float32x4' }] });
    return out;
}
function attrBytes(f: GPUVertexFormat): number {
    switch (f) {
        case 'float32': return 4; case 'float32x2': return 8; case 'float32x3': return 12; case 'float32x4': return 16;
        case 'uint8x4': case 'unorm8x4': case 'snorm8x4': case 'sint8x4': return 4;
        case 'uint32': case 'sint32': return 4; case 'uint32x2': case 'sint32x2': return 8; case 'uint32x3': case 'sint32x3': return 12; case 'uint32x4': case 'sint32x4': return 16;
        default: return 16;
    }
}

interface TwinEntry { desc: GPURenderPipelineDescriptor; twin: GPURenderPipeline | null; state: 0 | 1 | 2 | 3 }   // 0 none, 1 compiling, 2 ready, 3 failed
const _twins = new WeakMap<GPURenderPipeline, TwinEntry>();
let _onTwinReady: (() => void) | null = null;
let _twinsPending = 0;
let _twinEpoch = 0;
/** Bumped whenever a twin finishes compiling (a cached render bundle that left packed records out re-records). */
export const twinEpoch = (): number => _twinEpoch;

/** Record the descriptor `p` was made from, so packedTwin can build its twin (call where the pipeline is created). */
export function noteTwinSource(p: GPURenderPipeline | null | undefined, desc: GPURenderPipelineDescriptor): void {
    if (p && !_twins.has(p)) _twins.set(p, { desc, twin: null, state: 0 });
}
/** Called (once per landed twin) when a twin finishes compiling: the renderer requests a frame. */
export function setTwinReadyCallback(cb: (() => void) | null): void { _onTwinReady = cb; }
/** Twins still compiling. */
export const twinsPending = (): number => _twinsPending;

/** The packed twin of `p`, or null while it compiles (it starts compiling on the first ask) / when `p` has none. */
export function packedTwin(device: GPUDevice, p: GPURenderPipeline | null | undefined): GPURenderPipeline | null {
    if (!p) return null;
    const e = _twins.get(p);
    if (!e) return null;
    if (e.state === 2) return e.twin;
    if (e.state === 0) {
        const bufs = packedVertexBuffers(e.desc.vertex.buffers);
        if (!bufs) { e.state = 3; return null; }
        e.state = 1; _twinsPending++;
        const d: GPURenderPipelineDescriptor = { ...e.desc, label: (e.desc.label ?? 'pipeline') + ' #packed', vertex: { ...e.desc.vertex, buffers: bufs } };
        device.createRenderPipelineAsync(d)
            .then((tw) => { e.twin = tw; e.state = 2; })
            .catch((err) => { e.state = 3; console.warn('[vertex-pack] packed twin failed', d.label, err); })
            .finally(() => { _twinsPending--; _twinEpoch++; _onTwinReady?.(); });
    }
    return null;
}
/** Is `p`'s twin compiled (true), compiling / not started (false)? Null = it has no twin (never packable). */
export function twinReady(p: GPURenderPipeline | null | undefined): boolean | null {
    if (!p) return false;
    const e = _twins.get(p);
    if (!e) return null;
    return e.state === 2 ? true : e.state === 3 ? null : false;
}

const _tangentBufs = new WeakMap<GPUDevice, GPUBuffer>();
/** The 16-byte (1, 0, 0, 1) vertex buffer the twins read their tangent from (slot 1, arrayStride 0). */
export function constTangentBuffer(device: GPUDevice): GPUBuffer {
    let b = _tangentBufs.get(device);
    if (!b) {
        b = device.createBuffer({ size: 16, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, label: 'Pool constant tangent' });
        device.queue.writeBuffer(b, 0, Float32Array.of(1, 0, 0, 1));
        _tangentBufs.set(device, b);
    }
    return b;
}
