import { describe, it, expect } from 'vitest';

// mobile-parity 7.3b P4: the mesh-edit wireframe line VB is rebuilt only when something it is made of changes
// (edit-mesh positions / topology / seams, the local matrix, edge-mode selection, the wireframe toggle) — never for a
// camera move — and the draw it issues is unchanged.
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

function camera(tx = 0): Camera3D {
  const vp = new Float32Array(16); vp[0] = vp[5] = vp[10] = vp[15] = 1; vp[12] = tx;
  const v = new Float32Array(16); v[0] = v[5] = v[10] = v[15] = 1; v[12] = tx;
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
    return { draws: p.draws.filter((x) => x.pipe.startsWith('MeshEditLine')), lineWrites: writes.filter((w) => w.floats.length > 32) };
  };
  return { r, t, data, frame };
}

describe('P4 MeshEditOverlayRenderer wireframe cache', () => {
  it('builds once; a camera move re-draws the SAME lines without a rebuild or an upload', () => {
    const { r, frame } = setup();
    const f1 = frame(camera(0));
    expect(r.wireframeBuilds).toBe(1);
    expect(f1.lineWrites).toHaveLength(1);
    expect(f1.draws).toEqual([{ pipe: 'MeshEditLine', count: 6 }, { pipe: 'MeshEditLineRear', count: 6 }]);
    const f2 = frame(camera(5));
    expect(r.wireframeBuilds).toBe(1);
    expect(f2.lineWrites).toHaveLength(0);
    expect(f2.draws).toEqual(f1.draws);
  });

  it('an in-place vertex move, a seam edit, a local-matrix change or a topology change each rebuild (exact compare)', () => {
    const { r, t, frame } = setup();
    const f0 = frame();
    t.editMesh.vertices[1].x = 2;                 // in place (no version bump anywhere)
    const f1 = frame();
    expect(r.wireframeBuilds).toBe(2);
    expect(f1.lineWrites[0].floats).not.toEqual(f0.lineWrites[0].floats);
    t.editMesh.halfEdges[0].isSeam = true;
    frame(); expect(r.wireframeBuilds).toBe(3);
    t.localMatrix[12] = 0.5;
    frame(); expect(r.wireframeBuilds).toBe(4);
    t.editMesh.vertices.push({ x: 3, y: 3, z: 3 });
    frame(); expect(r.wireframeBuilds).toBe(5);
    frame(); expect(r.wireframeBuilds).toBe(5);
  });

  it('the uploaded lines equal a fresh build of the same state (cache never changes the picture)', () => {
    const a = setup();
    a.frame();
    a.t.editMesh.vertices[2].y = 4; a.t.editMesh.halfEdges[1].isSeam = true;
    const cached = a.frame().lineWrites[0].floats;
    const b = setup();                             // a renderer that never saw the old state
    b.t.editMesh.vertices[2].y = 4; b.t.editMesh.halfEdges[1].isSeam = true;
    expect(cached).toEqual(b.frame().lineWrites[0].floats);
  });

  it('edge-mode selection changes rebuild; face-mode selection changes do not (they only touch the fills)', () => {
    const { r, data, frame } = setup();
    const sel = { vertices: new Set<number>(), faces: new Set<number>(), edges: new Set<number>() };
    const edge: MeshEditDrawData = { ...data, mode: 'edge', selection: sel as never };
    frame(camera(), edge);
    const b = r.wireframeBuilds;
    sel.edges.add(1);                              // mutated in place
    frame(camera(), edge);
    expect(r.wireframeBuilds).toBe(b + 1);
    frame(camera(), edge);
    expect(r.wireframeBuilds).toBe(b + 1);
    const face: MeshEditDrawData = { ...data, mode: 'face', selection: sel as never };
    frame(camera(), face);
    const b2 = r.wireframeBuilds;
    sel.faces.add(0);
    frame(camera(), face);
    expect(r.wireframeBuilds).toBe(b2);
  });

  it('turning the wireframe off draws no lines; back on rebuilds them', () => {
    const { r, data, frame } = setup();
    frame();
    const off = frame(camera(), { ...data, showWireframe: false });
    expect(off.draws).toHaveLength(0);
    const on = frame(camera(), data);
    expect(on.draws).toHaveLength(2);
    expect(r.wireframeBuilds).toBe(3);
  });
});
