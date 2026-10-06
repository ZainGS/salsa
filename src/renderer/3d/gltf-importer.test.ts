/**
 * glTF importer accessor decoding: every component type, interleaved buffers, the
 * `normalized` flag, sparse / bufferView-less accessors, extensionsRequired guard,
 * per-primitive morph target names, mesh.weights and 8 -> 4 skin influences.
 * All fixtures are synthetic GLBs built in memory.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { parseGLB, parseSkinnedGLB } from './gltf-importer';

// ── Tiny GLB builder ────────────────────────────────────────────────────────

const F32 = 5126, U32 = 5125, U16 = 5123, I16 = 5122, U8 = 5121, I8 = 5120;

class GlbBuilder {
  json: any = { asset: { version: '2.0' }, buffers: [{ byteLength: 0 }], bufferViews: [], accessors: [] };
  private bin: number[] = [];

  /** Append raw bytes as a bufferView (4-byte aligned); returns its index. */
  view(bytes: Uint8Array, byteStride?: number): number {
    while (this.bin.length % 4) this.bin.push(0);
    const byteOffset = this.bin.length;
    for (const b of bytes) this.bin.push(b);
    const bv: any = { buffer: 0, byteOffset, byteLength: bytes.length };
    if (byteStride) bv.byteStride = byteStride;
    this.json.bufferViews.push(bv);
    return this.json.bufferViews.length - 1;
  }

  accessor(a: Record<string, unknown>): number {
    this.json.accessors.push(a);
    return this.json.accessors.length - 1;
  }

  /** Typed data → bufferView + accessor in one go. */
  data(arr: ArrayBufferView, componentType: number, type: string, count: number, extra: Record<string, unknown> = {}): number {
    const bv = this.view(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
    return this.accessor({ bufferView: bv, componentType, type, count, ...extra });
  }

  build(): ArrayBuffer {
    while (this.bin.length % 4) this.bin.push(0);
    this.json.buffers[0].byteLength = this.bin.length;
    let jsonBytes = new TextEncoder().encode(JSON.stringify(this.json));
    const pad = (4 - (jsonBytes.length % 4)) % 4;
    if (pad) { const p = new Uint8Array(jsonBytes.length + pad).fill(0x20); p.set(jsonBytes); jsonBytes = p; }
    const total = 12 + 8 + jsonBytes.length + 8 + this.bin.length;
    const out = new ArrayBuffer(total);
    const dv = new DataView(out);
    const u8 = new Uint8Array(out);
    dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
    dv.setUint32(12, jsonBytes.length, true); dv.setUint32(16, 0x4E4F534A, true);
    u8.set(jsonBytes, 20);
    const binOff = 20 + jsonBytes.length;
    dv.setUint32(binOff, this.bin.length, true); dv.setUint32(binOff + 4, 0x004E4942, true);
    u8.set(this.bin, binOff + 8);
    return out;
  }
}

const TRI_POS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);

/** One-node, one-mesh scene around the given primitive. */
function scene(g: GlbBuilder, prim: any, meshExtra: Record<string, unknown> = {}, nodeExtra: Record<string, unknown> = {}) {
  g.json.meshes = [{ name: 'M', primitives: [prim], ...meshExtra }];
  g.json.nodes = [{ name: 'N', mesh: 0, ...nodeExtra }];
  g.json.scenes = [{ nodes: [0] }];
  g.json.scene = 0;
}

/** Add a 2-joint skin (nodes 1, 2) to the builder; mesh node is node 0. */
function addSkin(g: GlbBuilder, jointCount = 2) {
  const joints: number[] = [];
  for (let i = 0; i < jointCount; i++) {
    g.json.nodes.push({ name: `J${i}`, translation: [0, i, 0] });
    joints.push(g.json.nodes.length - 1);
  }
  g.json.scenes[0].nodes.push(joints[0]);
  for (let i = 0; i + 1 < joints.length; i++) g.json.nodes[joints[i]].children = [joints[i + 1]];
  g.json.skins = [{ name: 'S', joints }];
  g.json.nodes[0].skin = 0;
}

const V12 = 12;  // floats per vertex in the result geometry (pos nrm uv tan)

let logSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => { logSpy = vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterAll(() => { logSpy.mockRestore(); });

describe('gltf-importer accessors', () => {
  it('reads u32, u16 and u8 indices and normalised u8 texcoords', async () => {
    for (const [ct, Arr] of [[U32, Uint32Array], [U16, Uint16Array], [U8, Uint8Array]] as const) {
      const g = new GlbBuilder();
      const pos = g.data(TRI_POS, F32, 'VEC3', 3);
      const uv = g.data(new Uint8Array([0, 0, 255, 0, 0, 51]), U8, 'VEC2', 3, { normalized: true });
      const idx = g.data(new Arr([0, 1, 2]), ct, 'SCALAR', 3);
      scene(g, { attributes: { POSITION: pos, TEXCOORD_0: uv }, indices: idx });
      const [r] = await parseGLB(g.build());
      expect(Array.from(r.geometry.indices)).toEqual([0, 1, 2]);
      const v = r.geometry.vertices;
      expect(v[1 * V12 + 6]).toBeCloseTo(1);
      expect(v[2 * V12 + 7]).toBeCloseTo(0.2);
    }
  });

  it('does not normalise integer attributes without the normalized flag', async () => {
    const g = new GlbBuilder();
    // KHR_mesh_quantization-style i16 positions, not normalised.
    const pos = g.data(new Int16Array([0, 0, 0, 3, 0, 0, 0, -2, 0]), I16, 'VEC3', 3);
    scene(g, { attributes: { POSITION: pos } });
    g.json.extensionsRequired = ['KHR_mesh_quantization'];
    const [r] = await parseGLB(g.build());
    expect(r.geometry.vertices[1 * V12]).toBe(3);
    expect(r.geometry.vertices[2 * V12 + 1]).toBe(-2);
  });

  it('deinterleaves byteStride buffers incl. u8 components', async () => {
    const g = new GlbBuilder();
    // stride 16: pos f32x3 (12 B) + uv u8x2 normalised (2 B) + 2 B pad
    const stride = 16;
    const buf = new ArrayBuffer(stride * 3);
    const dv = new DataView(buf);
    const uvs = [[0, 0], [255, 0], [0, 255]];
    for (let i = 0; i < 3; i++) {
      for (let c = 0; c < 3; c++) dv.setFloat32(i * stride + c * 4, TRI_POS[i * 3 + c], true);
      dv.setUint8(i * stride + 12, uvs[i][0]);
      dv.setUint8(i * stride + 13, uvs[i][1]);
    }
    const bv = g.view(new Uint8Array(buf), stride);
    const pos = g.accessor({ bufferView: bv, byteOffset: 0, componentType: F32, type: 'VEC3', count: 3 });
    const uv = g.accessor({ bufferView: bv, byteOffset: 12, componentType: U8, type: 'VEC2', count: 3, normalized: true });
    scene(g, { attributes: { POSITION: pos, TEXCOORD_0: uv } });
    const [r] = await parseGLB(g.build());
    const v = r.geometry.vertices;
    expect(v[1 * V12]).toBeCloseTo(1);
    expect(v[2 * V12 + 1]).toBeCloseTo(1);
    expect(v[1 * V12 + 6]).toBeCloseTo(1);
    expect(v[2 * V12 + 7]).toBeCloseTo(1);
    expect(v[0 * V12 + 6]).toBe(0);
  });

  it('sparse morph target over zeros, zero target without bufferView, signed normalised normals', async () => {
    const g = new GlbBuilder();
    const pos = g.data(TRI_POS, F32, 'VEC3', 3);
    // Target 0: sparse over zeros — vertex 1 moves by (0, 0.5, 0)
    const sIdx = g.view(new Uint8Array(new Uint16Array([1, 0]).buffer));          // u16 index (padded)
    const sVal = g.view(new Uint8Array(new Float32Array([0, 0.5, 0]).buffer));
    const t0 = g.accessor({
      componentType: F32, type: 'VEC3', count: 3,
      sparse: { count: 1, indices: { bufferView: sIdx, componentType: U16 }, values: { bufferView: sVal } },
    });
    // Target 1: no bufferView, no sparse → all zeros
    const t1 = g.accessor({ componentType: F32, type: 'VEC3', count: 3 });
    // Target 1 normals: normalised i8, -128 clamps to -1, 127 → 1
    const t1n = g.data(new Int8Array([-128, 0, 0, 127, 0, 0, 0, 0, 0]), I8, 'VEC3', 3, { normalized: true });
    scene(g, { attributes: { POSITION: pos }, targets: [{ POSITION: t0 }, { POSITION: t1, NORMAL: t1n }] },
      { weights: [0.25, 0.75], extras: { targetNames: ['meshLevelA', 'meshLevelB'] } });
    const [r] = await parseGLB(g.build());
    expect(r.morphTargets.length).toBe(2);
    const d0 = r.morphTargets[0].deltaVertices;
    expect(Array.from(d0.slice(0, 6))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(d0[6 + 1]).toBeCloseTo(0.5);
    const d1 = r.morphTargets[1].deltaVertices;
    expect(Array.from(d1.filter((_, i) => i % 6 < 3))).toEqual(new Array(9).fill(0));
    expect(d1[3]).toBeCloseTo(-1);
    expect(d1[6 + 3]).toBeCloseTo(1);
    // mesh-level names used when the primitive has none; mesh.weights exposed
    expect(r.morphTargets.map(t => t.name)).toEqual(['meshLevelA', 'meshLevelB']);
    expect(r.morphWeights).toEqual([0.25, 0.75]);
  });

  it('sparse accessor over a base bufferView', async () => {
    const g = new GlbBuilder();
    const sIdx = g.view(new Uint8Array([2, 0, 0, 0]));                           // u8 index
    const sVal = g.view(new Uint8Array(new Float32Array([5, 5, 5]).buffer));
    const pos = g.data(TRI_POS, F32, 'VEC3', 3, {
      sparse: { count: 1, indices: { bufferView: sIdx, componentType: U8 }, values: { bufferView: sVal } },
    });
    scene(g, { attributes: { POSITION: pos } });
    const [r] = await parseGLB(g.build());
    const v = r.geometry.vertices;
    expect(v[1 * V12]).toBeCloseTo(1);
    expect([v[2 * V12], v[2 * V12 + 1], v[2 * V12 + 2]]).toEqual([5, 5, 5]);
  });

  it('prefers per-primitive extras.targetNames and defaults weights to 0', async () => {
    const g = new GlbBuilder();
    const pos = g.data(TRI_POS, F32, 'VEC3', 3);
    const t = g.accessor({ componentType: F32, type: 'VEC3', count: 3 });
    scene(g, { attributes: { POSITION: pos }, targets: [{ POSITION: t }], extras: { targetNames: ['Fcl_MTH_A'] } },
      { extras: { targetNames: ['wrong'] } });
    const [r] = await parseGLB(g.build());
    expect(r.morphTargets[0].name).toBe('Fcl_MTH_A');
    expect(r.morphWeights).toEqual([0]);
  });
});

describe('gltf-importer extensionsRequired', () => {
  it('rejects Draco with a clear error', async () => {
    const g = new GlbBuilder();
    const pos = g.data(TRI_POS, F32, 'VEC3', 3);
    scene(g, { attributes: { POSITION: pos } });
    g.json.extensionsUsed = ['KHR_draco_mesh_compression'];
    g.json.extensionsRequired = ['KHR_draco_mesh_compression'];
    const glb = g.build();
    await expect(parseGLB(glb)).rejects.toThrow(/unsupported extension.*KHR_draco_mesh_compression/);
    await expect(parseSkinnedGLB(glb)).rejects.toThrow(/KHR_draco_mesh_compression/);
  });

  it('ignores unknown extensions that are only used, not required', async () => {
    const g = new GlbBuilder();
    const pos = g.data(TRI_POS, F32, 'VEC3', 3);
    scene(g, { attributes: { POSITION: pos } });
    g.json.extensionsUsed = ['VRMC_vrm', 'KHR_materials_emissive_strength'];
    const res = await parseGLB(g.build());
    expect(res.length).toBe(1);
  });
});

describe('gltf-importer skinning', () => {
  it('u8 joints stay integer, normalised u8 weights decode', async () => {
    const g = new GlbBuilder();
    const pos = g.data(TRI_POS, F32, 'VEC3', 3);
    const j = g.data(new Uint8Array([0, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0]), U8, 'VEC4', 3);
    const w = g.data(new Uint8Array([255, 0, 0, 0, 153, 102, 0, 0, 255, 0, 0, 0]), U8, 'VEC4', 3, { normalized: true });
    const idx = g.data(new Uint16Array([0, 1, 2]), U16, 'SCALAR', 3);
    scene(g, { attributes: { POSITION: pos, JOINTS_0: j, WEIGHTS_0: w }, indices: idx });
    addSkin(g);
    const [r] = await parseSkinnedGLB(g.build());
    expect(Array.from(r.skinning.jointIndices)).toEqual([0, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0]);
    const wt = r.skinning.jointWeights;
    expect(wt[0]).toBeCloseTo(1);
    expect(wt[4]).toBeCloseTo(0.6);
    expect(wt[5]).toBeCloseTo(0.4);
    expect(r.skinning.jointNames).toEqual(['J0', 'J1']);
    expect(Array.from(r.skinning.jointParents)).toEqual([-1, 0]);
  });

  it('u16 joints and normalised u16 weights', async () => {
    const g = new GlbBuilder();
    const pos = g.data(TRI_POS, F32, 'VEC3', 3);
    const j = g.data(new Uint16Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), U16, 'VEC4', 3);
    const w = g.data(new Uint16Array([65535, 0, 0, 0, 65535, 0, 0, 0, 65535, 0, 0, 0]), U16, 'VEC4', 3, { normalized: true });
    scene(g, { attributes: { POSITION: pos, JOINTS_0: j, WEIGHTS_0: w } });
    addSkin(g);
    const [r] = await parseSkinnedGLB(g.build());
    expect(r.skinning.jointIndices[0]).toBe(1);
    expect(r.skinning.jointWeights[0]).toBeCloseTo(1);
  });

  it('reduces 8 influences (JOINTS_1/WEIGHTS_1) to the top 4, renormalised', async () => {
    const g = new GlbBuilder();
    const pos = g.data(TRI_POS, F32, 'VEC3', 3);
    // Vertex 0: 8 influences on joints 0..7; weights favour 7, 5, 3, 1.
    // Vertices 1, 2: single joint 2, weight 1 (set 1 empty).
    const j0 = g.data(new Uint16Array([0, 1, 2, 3, 2, 0, 0, 0, 2, 0, 0, 0]), U16, 'VEC4', 3);
    const w0 = g.data(new Float32Array([0.01, 0.2, 0.02, 0.15, 1, 0, 0, 0, 1, 0, 0, 0]), F32, 'VEC4', 3);
    const j1 = g.data(new Uint16Array([4, 5, 6, 7, 0, 0, 0, 0, 0, 0, 0, 0]), U16, 'VEC4', 3);
    const w1 = g.data(new Float32Array([0.03, 0.25, 0.04, 0.3, 0, 0, 0, 0, 0, 0, 0, 0]), F32, 'VEC4', 3);
    scene(g, { attributes: { POSITION: pos, JOINTS_0: j0, WEIGHTS_0: w0, JOINTS_1: j1, WEIGHTS_1: w1 } });
    addSkin(g, 8);
    const [r] = await parseSkinnedGLB(g.build());
    const ji = Array.from(r.skinning.jointIndices.slice(0, 4));
    const wi = Array.from(r.skinning.jointWeights.slice(0, 4));
    expect(ji).toEqual([7, 5, 1, 3]);
    const sum = 0.3 + 0.25 + 0.2 + 0.15;
    expect(wi[0]).toBeCloseTo(0.3 / sum);
    expect(wi[1]).toBeCloseTo(0.25 / sum);
    expect(wi[2]).toBeCloseTo(0.2 / sum);
    expect(wi[3]).toBeCloseTo(0.15 / sum);
    expect(wi.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(r.skinning.jointIndices[4]).toBe(2);
    expect(r.skinning.jointWeights[4]).toBeCloseTo(1);
    expect(r.skinning.jointWeights[5]).toBe(0);
  });
});
