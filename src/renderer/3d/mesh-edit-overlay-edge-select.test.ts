import { describe, it, expect } from 'vitest';

// Edge-mode selection highlight (notes 2026-10-08 #5, Blender's edge mode): in Edge mode the overlay highlights ONLY
// the edges in the edge selection (either half-edge of a pair counts) — never an edge whose two ends merely belong to
// selected edges (the Vertex-mode rule). Face mode: only the selected faces' fills / outlines.
const g = globalThis as Record<string, unknown>;
g.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128, VERTEX: 32, INDEX: 16 };
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

import { MeshEditOverlayRenderer, type MeshEditDrawData } from './mesh-edit-overlay-renderer';
import { EditMesh, MirrorModifier } from '../../scene-graph/shapes/edit-mesh';
import type { Camera3D } from './camera-3d';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';

const ORANGE = [1, 0.55, 0];

function fakeDevice() {
  const writes: Array<{ buf: { id: number }; floats: Float32Array }> = [];
  let n = 0;
  const device = {
    createBuffer: (d: { size: number }) => ({ id: ++n, size: d.size, destroy() { /* noop */ } }),
    createShaderModule: () => ({}), createBindGroupLayout: () => ({}), createBindGroup: () => ({}),
    createPipelineLayout: () => ({}), createRenderPipeline: (d: { label?: string }) => ({ label: d.label }),
    queue: {
      writeBuffer: (buf: { id: number }, _off: number, data: Float32Array, dataOff = 0, size?: number) => {
        writes.push({ buf, floats: data.slice(dataOff, size !== undefined ? dataOff + size : undefined) });
      },
    },
  };
  return { device: device as unknown as GPUDevice, writes };
}

/** An ortho camera looking down −Z. */
function ortho(): Camera3D {
  const vp = new Float32Array(16); vp[0] = vp[5] = vp[10] = vp[15] = 1;
  const v = new Float32Array(16); v[0] = v[5] = v[10] = v[15] = 1;
  return { getViewProjectionMatrix: () => vp, getViewMatrix: () => v, mode: 'orthographic', orthoSize: 2, fov: 1, position: [0, 0, 5] } as unknown as Camera3D;
}

const isOrange = (f: Float32Array, o: number) => Math.abs(f[o + 3] - ORANGE[0]) < 1e-6 && Math.abs(f[o + 4] - ORANGE[1]) < 1e-6 && Math.abs(f[o + 5] - ORANGE[2]) < 1e-6;

function draw(em: EditMesh, mode: 'edge' | 'face' | 'vertex', sel: { vertices?: number[]; edges?: number[]; faces?: number[] }) {
  const { device, writes } = fakeDevice();
  const r = new MeshEditOverlayRenderer(device, 'bgra8unorm');
  const localMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const mesh = { id: 'm', editMesh: em, localMatrix } as unknown as Mesh3D;
  const selection = { meshId: 'm', vertices: new Set(sel.vertices ?? []), edges: new Set(sel.edges ?? []), faces: new Set(sel.faces ?? []) };
  const pass = { setPipeline: () => {}, setBindGroup: () => {}, setVertexBuffer: () => {}, draw: () => {} } as unknown as GPURenderPassEncoder;
  r.draw(pass, { mesh, selection: selection as never, mode, showWireframe: true } as MeshEditDrawData, ortho(), 400);
  // the wireframe (line list: 2 vertices × 7 floats per segment) — the last write whose length is a multiple of 14
  // and holds every edge once; the tri VB (bands / dots / fills) — 6 vertices per quad
  const nEdges = em.halfEdges.filter((h, i) => h.twin < 0 || h.twin > i).length;
  const line = writes.find(w => w.floats.length === nEdges * 14)!.floats;
  const orangeLines: string[] = [];
  for (let o = 0; o < line.length; o += 14) {
    if (isOrange(line, o)) orangeLines.push(segKey(line[o], line[o + 1], line[o + 2], line[o + 7], line[o + 8], line[o + 9]));
  }
  const tri = writes.filter(w => w.floats.length % 42 === 0 && w.floats !== line && w.floats.length > 32).map(w => w.floats);
  let orangeTriVerts = 0;
  for (const f of tri) for (let o = 0; o < f.length; o += 7) if (isOrange(f, o)) orangeTriVerts++;
  return { orangeLines: orangeLines.sort(), bands: orangeTriVerts / 6 };
}

function segKey(ax: number, ay: number, az: number, bx: number, by: number, bz: number): string {
  const a = [ax, ay, az].map(v => v.toFixed(4)).join(','), b = [bx, by, bz].map(v => v.toFixed(4)).join(',');
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
function edgeKey(em: EditMesh, hi: number): string {
  const he = em.halfEdges[hi], a = em.vertices[em.halfEdges[he.prev].vertex], b = em.vertices[he.vertex];
  return segKey(a.x, a.y, a.z, b.x, b.y, b.z);
}

/** Three consecutive edges A–B, B–C, C–D around one face of a box: h0, h1 (the connecting one), h2. */
function chain() {
  const em = EditMesh.fromBox(1, 1, 1);
  const h0 = em.faces[0].halfEdge, h1 = em.halfEdges[h0].next, h2 = em.halfEdges[h1].next;
  return { em, h0, h1, h2 };
}

describe('Mesh Edit overlay — Edge mode highlights only the selected edges', () => {
  it('two selected edges A–B and C–D: the connecting edge B–C is NOT drawn selected', () => {
    const { em, h0, h1, h2 } = chain();
    const d = draw(em, 'edge', { edges: [h0, h2] });
    expect(d.orangeLines).toEqual([edgeKey(em, h0), edgeKey(em, h2)].sort());
    expect(d.orangeLines).not.toContain(edgeKey(em, h1));
    expect(d.bands).toBe(2);
  });

  it('either half-edge of a pair counts as the edge selected (the wireframe colour too)', () => {
    const { em, h0, h2 } = chain();
    const t0 = em.halfEdges[h0].twin, t2 = em.halfEdges[h2].twin;
    expect(t0).toBeGreaterThanOrEqual(0);
    const d = draw(em, 'edge', { edges: [t0, t2] });
    expect(d.orangeLines).toEqual([edgeKey(em, h0), edgeKey(em, h2)].sort());
    expect(d.bands).toBe(2);
  });

  it('stale vertices in the selection (left from Vertex mode) never light edges in Edge mode', () => {
    const { em, h0, h1, h2 } = chain();
    const ends = [h0, h1, h2].flatMap(h => [em.halfEdges[em.halfEdges[h].prev].vertex, em.halfEdges[h].vertex]);
    const d = draw(em, 'edge', { edges: [h0, h2], vertices: ends });
    expect(d.orangeLines).not.toContain(edgeKey(em, h1));
    expect(d.bands).toBe(2);
  });

  it('with a mirror the copy follows the same rule (only the selected edges and their images)', () => {
    const { em, h0, h1, h2 } = chain();
    em.modifiers.push(new MirrorModifier('x'));
    const d = draw(em, 'edge', { edges: [h0, h2] });
    expect(d.orangeLines).not.toContain(edgeKey(em, h1));
  });

  it('Vertex mode keeps deriving: an edge whose two ends are selected is drawn selected', () => {
    const { em, h1 } = chain();
    const he = em.halfEdges[h1];
    const d = draw(em, 'vertex', { vertices: [em.halfEdges[he.prev].vertex, he.vertex] });
    expect(d.bands).toBeGreaterThanOrEqual(1);
  });

  it('Face mode: only a selected face is filled / outlined', () => {
    const { em } = chain();
    const none = draw(em, 'face', { edges: [0, 1, 2], vertices: [0, 1, 2, 3] });
    expect(none.bands).toBe(0);
    expect(none.orangeLines).toEqual([]);
  });
});
