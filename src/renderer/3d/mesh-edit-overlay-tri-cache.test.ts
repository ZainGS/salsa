import { describe, it, expect } from 'vitest';

// TOUCH-9/10 perf pass: the mesh-edit TRI VB (vertex dots + face fills + UV hover tint) is rebuilt only when
// something it is made of changes (camera right / up, selection, hover tint, edit-mesh positions / topology, the local
// matrix) — a redraw with nothing changed neither rebuilds nor uploads, and the picture equals a fresh build.
const g = globalThis as Record<string, unknown>;
g.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128, VERTEX: 32, INDEX: 16 };
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

import { MeshEditOverlayRenderer, type MeshEditDrawData } from './mesh-edit-overlay-renderer';
import type { Camera3D } from './camera-3d';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';

function fakeDevice() {
  const writes: Array<{ buf: object; floats: Float32Array }> = [];
  let n = 0;
  const device = {
    createBuffer: (d: { size: number }) => ({ id: ++n, size: d.size, destroy() { /* noop */ } }),
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createBindGroup: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: (d: { label?: string }) => ({ label: d.label }),
    queue: {
      writeBuffer: (buf: object, _off: number, data: Float32Array, dataOff = 0, size?: number) => {
        writes.push({ buf, floats: data.slice(dataOff, size !== undefined ? dataOff + size : undefined) });
      },
    },
  };
  return { device: device as unknown as GPUDevice, writes };
}

function fakePass() {
  const draws: Array<{ pipe: string; count: number }> = [];
  let pipe = '';
  const pass = {
    setPipeline: (p: { label?: string }) => { pipe = p.label ?? ''; },
    setBindGroup: () => {},
    setVertexBuffer: () => {},
    draw: (count: number) => { draws.push({ pipe, count }); },
  };
  return { pass: pass as unknown as GPURenderPassEncoder, draws };
}

/** One triangle (3 half-edges, no twins). */
function triMesh() {
  const vertices = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }];
  const halfEdges = [
    { vertex: 1, next: 1, prev: 2, twin: -1, face: 0, isSeam: false },
    { vertex: 2, next: 2, prev: 0, twin: -1, face: 0, isSeam: false },
    { vertex: 0, next: 0, prev: 1, twin: -1, face: 0, isSeam: false },
  ];
  const editMesh = { vertices, halfEdges, faces: [{ halfEdge: 0 }] };
  const localMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return { mesh: { id: 'm', editMesh, localMatrix } as unknown as Mesh3D, editMesh, localMatrix };
}

function camera(tx = 0, rightX = 1): Camera3D {
  const vp = new Float32Array(16); vp[0] = vp[5] = vp[10] = vp[15] = 1; vp[12] = tx;
  const v = new Float32Array(16); v[0] = rightX; v[5] = v[10] = v[15] = 1; v[12] = tx;
  return { getViewProjectionMatrix: () => vp, getViewMatrix: () => v } as unknown as Camera3D;
}

function setup() {
  const { device, writes } = fakeDevice();
  const r = new MeshEditOverlayRenderer(device, 'bgra8unorm');
  const t = triMesh();
  const data: MeshEditDrawData = { mesh: t.mesh, selection: null, mode: 'face', showWireframe: true };
  const frame = (cam = camera(), d: MeshEditDrawData = data) => {
    const p = fakePass();
    writes.length = 0;
    r.draw(p.pass, d, cam);
    return { tri: p.draws.filter((x) => x.pipe === 'MeshEditTri'), triWrites: writes.filter((w) => w.floats.length >= 126) };   // 3 dots = 126 floats; the wireframe upload is 42
  };
  return { r, t, data, frame };
}

describe('MeshEditOverlayRenderer tri (vertex dots / fills) cache', () => {
  const sel = () => ({ meshId: 'm', vertices: new Set<number>(), faces: new Set<number>(), edges: new Set<number>() });

  it('builds once; a redraw with nothing changed (and a camera PAN) draws the same dots without a rebuild or upload', () => {
    const { r, data, frame } = setup();
    const d: MeshEditDrawData = { ...data, mode: 'vertex', selection: sel() as never };
    const f1 = frame(camera(0), d);
    expect(r.triBuilds).toBe(1);
    expect(f1.triWrites).toHaveLength(1);
    expect(f1.tri).toEqual([{ pipe: 'MeshEditTri', count: 36 }]);   // 3 vertices × (rim + core) × 2 triangles; no fills
    const f2 = frame(camera(3), d);                                  // a pan: same right / up axes
    expect(r.triBuilds).toBe(1);
    expect(f2.triWrites).toHaveLength(0);
    expect(f2.tri).toEqual(f1.tri);
  });

  it('a camera rotation, a selection change, a vertex move or a mode change rebuild', () => {
    const { r, t, data, frame } = setup();
    const s = sel();
    const d: MeshEditDrawData = { ...data, mode: 'vertex', selection: s as never };
    frame(camera(0), d);
    frame(camera(0, 0.5), d); expect(r.triBuilds).toBe(2);         // the billboard axes changed
    s.vertices.add(1);                                               // mutated in place
    frame(camera(0, 0.5), d); expect(r.triBuilds).toBe(3);
    frame(camera(0, 0.5), d); expect(r.triBuilds).toBe(3);
    t.editMesh.vertices[2].y = 3;
    frame(camera(0, 0.5), d); expect(r.triBuilds).toBe(4);
    frame(camera(0, 0.5), { ...d, mode: 'face' }); expect(r.triBuilds).toBe(5);
    s.faces.add(0);
    frame(camera(0, 0.5), { ...d, mode: 'face' }); expect(r.triBuilds).toBe(6);
  });

  it('the uploaded dots equal a fresh build of the same state (the cache never changes the picture)', () => {
    const a = setup();
    const s = sel(); s.vertices.add(2);
    const d: MeshEditDrawData = { ...a.data, mode: 'vertex', selection: s as never };
    a.frame(camera(0), d);
    a.t.editMesh.vertices[0].x = -1;
    const cached = a.frame(camera(0), d).triWrites[0].floats;
    const b = setup();
    b.t.editMesh.vertices[0].x = -1;
    const s2 = sel(); s2.vertices.add(2);
    expect(cached).toEqual(b.frame(camera(0), { ...b.data, mode: 'vertex', selection: s2 as never }).triWrites[0].floats);
  });

  it('with the wireframe off (UV paint) it rebuilds every frame, as before', () => {
    const { r, data, frame } = setup();
    const d: MeshEditDrawData = { ...data, mode: 'vertex', selection: sel() as never, showWireframe: false };
    frame(camera(), d); frame(camera(), d);
    expect(r.triBuilds).toBe(2);
  });
});

describe('MeshEditOverlayRenderer selection readability (UI review 2026-10-07 §3 #19)', () => {
  const sel = () => ({ meshId: 'm', vertices: new Set<number>(), faces: new Set<number>(), edges: new Set<number>() });
  /** An ortho camera looking down −Z: right = +X, up = +Y. */
  function ortho(orthoSize: number): Camera3D {
    const vp = new Float32Array(16); vp[0] = vp[5] = vp[10] = vp[15] = 1;
    const v = new Float32Array(16); v[0] = v[5] = v[10] = v[15] = 1;
    return { getViewProjectionMatrix: () => vp, getViewMatrix: () => v, mode: 'orthographic', orthoSize, fov: 1, position: [0, 0, 5] } as unknown as Camera3D;
  }
  function run(d: Partial<MeshEditDrawData>, H?: number, cam = ortho(2)) {
    const { device, writes } = fakeDevice();
    const r = new MeshEditOverlayRenderer(device, 'bgra8unorm');
    const t = triMesh();
    const p = fakePass();
    r.draw(p.pass, { mesh: t.mesh, selection: sel() as never, mode: 'vertex', showWireframe: true, ...d } as MeshEditDrawData, cam, H);
    return { tri: p.draws.filter(x => x.pipe === 'MeshEditTri').map(x => x.count), lines: p.draws.filter(x => x.pipe === 'MeshEditLine'), writes };
  }

  it('vertex dots are a fixed SCREEN size (black core on a light rim): 4.5 / 3 px at 0.01 world units per pixel', () => {
    const { writes } = run({ mode: 'vertex' }, 400);           // orthoSize 2 → 4 world units over 400 px
    const tri = writes.find(w => w.floats.length === 3 * 2 * 6 * 7)!.floats;
    expect(tri[0]).toBeCloseTo(-0.045, 6);                    // vertex 0's rim: −(right + up) × 4.5 px
    expect(tri[6 * 7]).toBeCloseTo(-0.03, 6);                 // its core: 3 px
    expect([tri[6 * 7 + 3], tri[6 * 7 + 4], tri[6 * 7 + 5]]).toEqual([expect.closeTo(0.04), expect.closeTo(0.04), expect.closeTo(0.04)]);   // black
  });

  it('a selected vertex is orange; no vertex dots outside Vertex mode', () => {
    const s = sel(); s.vertices.add(1);
    const v = run({ mode: 'vertex', selection: s as never }, 400);
    const tri = v.writes.find(w => w.floats.length === 3 * 2 * 6 * 7)!.floats;
    const core1 = (1 * 2 + 1) * 6 * 7;                        // vertex 1: rim quad, then core quad
    expect([tri[core1 + 3], tri[core1 + 4], tri[core1 + 5]]).toEqual([1, expect.closeTo(0.55), 0]);
    expect(run({ mode: 'edge' }, 400).tri).toEqual([]);        // nothing selected, no dots
  });

  it('Face mode: a face dot per face; a selected face = fill (under the wireframe) + a 3 px outline (over it)', () => {
    expect(run({ mode: 'face' }, 400).tri).toEqual([2 * 6]);  // one face dot (rim + core)
    const s = sel(); s.faces.add(0);
    const f = run({ mode: 'face', selection: s as never }, 400);
    expect(f.tri).toEqual([3, 3 * 6 + 2 * 6]);                // the fill; then 3 outline bands + the dot
  });

  it('Edge mode: a selected edge is a 3 px band (2 triangles) drawn after the wireframe', () => {
    const s = sel(); s.edges.add(0);
    const { device } = fakeDevice();
    const r = new MeshEditOverlayRenderer(device, 'bgra8unorm');
    const t = triMesh();
    const order: string[] = [];
    const pass = {
      setPipeline: (p: { label?: string }) => { order.push(p.label ?? ''); },
      setBindGroup: () => {}, setVertexBuffer: () => {}, draw: () => {},
    } as unknown as GPURenderPassEncoder;
    r.draw(pass, { mesh: t.mesh, selection: s as never, mode: 'edge', showWireframe: true }, ortho(2), 400);
    expect(order).toEqual(['MeshEditLine', 'MeshEditLineRear', 'MeshEditTri']);
  });

  it('the handles resize when the zoom (pixel scale) changes, not on an ortho pan', () => {
    const { device } = fakeDevice();
    const r = new MeshEditOverlayRenderer(device, 'bgra8unorm');
    const t = triMesh();
    const d: MeshEditDrawData = { mesh: t.mesh, selection: sel() as never, mode: 'vertex', showWireframe: true };
    const p = fakePass();
    r.draw(p.pass, d, ortho(2), 400);
    r.draw(p.pass, d, { ...ortho(2), position: [3, 0, 5] } as unknown as Camera3D, 400);   // a pan: same scale
    expect(r.triBuilds).toBe(1);
    r.draw(p.pass, d, ortho(1), 400);                                                       // zoomed in
    expect(r.triBuilds).toBe(2);
  });
});
